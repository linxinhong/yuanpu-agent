import { randomUUID } from 'node:crypto';

import { AGENT_CONTRACT_VERSION, type AgentRunRecord } from '@yuanpu-agent/protocol';

import type { AgentService, AuthenticatedAgentCaller } from '../agent/contracts.js';
import type { ChannelStore, ChannelInboundRoute } from './store.js';
import {
  contentDigest,
  digestChannelValue,
  type ChannelConnectionConfig,
  type ChannelInboundReceipt,
  type ChannelTransport,
  type NormalizedChannelMessage,
} from './contracts.js';

export interface ChannelRouterOptions {
  config: ChannelConnectionConfig;
  store: ChannelStore;
  agent: AgentService;
  transport: ChannelTransport;
  now?: () => Date;
  createId?: () => string;
}

function terminalContent(run: AgentRunRecord): string | undefined {
  if (run.status === 'succeeded') return run.output?.message;
  if (run.status === 'failed') return '任务执行失败，请在桌面端查看详情。';
  if (run.status === 'cancelled') return '任务已取消。';
  if (run.status === 'interrupted') return '任务因应用退出而中断。';
  if (run.status === 'result_unknown') return '任务结果未知，请在桌面端核对后再决定是否重试。';
  return undefined;
}

export class ChannelRouter {
  readonly #config: ChannelConnectionConfig;
  readonly #store: ChannelStore;
  readonly #agent: AgentService;
  readonly #transport: ChannelTransport;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #watching = new Set<string>();
  #closed = false;

  constructor(options: ChannelRouterOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#agent = options.agent;
    this.#transport = options.transport;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  start(): void {
    if (this.#closed) throw new Error('Channel router is closed.');
    for (const digest of this.#config.pairedSenderDigests) {
      this.#store.pair('wecom', this.#config.connectionId, digest, this.#now().toISOString());
    }
    this.#store.markDeliveringUnknown('wecom', this.#config.connectionId, this.#now().toISOString());
    for (const inbound of this.#store.recoverableInbound('wecom', this.#config.connectionId)) {
      if (inbound.runId) this.#watch(inbound, this.#caller(inbound.conversationDigest));
    }
    this.#transport.connect((message) => {
      void this.handleInbound(message);
    });
  }

  async handleInbound(message: NormalizedChannelMessage): Promise<ChannelInboundReceipt> {
    if (this.#closed || message.connectionId !== this.#config.connectionId || message.provider !== 'wecom') {
      return { accepted: false, code: 'wrong_connection' };
    }
    if (message.providerBotId !== this.#config.providerAccountRef) {
      return { accepted: false, code: 'wrong_bot' };
    }
    if (!message.providerMessageId || !message.providerRequestId || !message.senderId || !message.conversationId) {
      return { accepted: false, code: 'invalid_message' };
    }
    const senderDigest = digestChannelValue(this.#config.connectionId, 'sender', message.senderId);
    if (!this.#store.isPaired('wecom', this.#config.connectionId, senderDigest)) {
      return { accepted: false, code: 'unpaired' };
    }
    const conversationDigest = digestChannelValue(
      this.#config.connectionId,
      `conversation:${message.conversationType}`,
      message.conversationId,
    );
    if (message.conversationType === 'group') {
      if (!this.#config.groupEnabled) return { accepted: false, code: 'group_disabled' };
      if (!this.#config.groupAllowlistDigests.includes(conversationDigest)) {
        return { accepted: false, code: 'group_not_allowed' };
      }
    }
    if (message.messageType !== 'text' || typeof message.text !== 'string' || !message.text.trim()) {
      return { accepted: false, code: 'unsupported_message' };
    }

    const providerMessageDigest = digestChannelValue(
      this.#config.connectionId,
      'message',
      message.providerMessageId,
    );
    const accepted = this.#store.acceptInbound({
      inboundId: this.#createId(),
      provider: 'wecom',
      connectionId: this.#config.connectionId,
      providerMessageId: providerMessageDigest,
      providerRequestId: message.providerRequestId,
      senderDigest,
      conversationType: message.conversationType,
      conversationDigest,
      messageType: message.messageType,
      contentDigest: contentDigest(message.text),
      receivedAt: this.#now().toISOString(),
    });
    if (accepted.record.senderDigest !== senderDigest) {
      return { accepted: false, code: 'invalid_message' };
    }
    const caller = this.#caller(conversationDigest);
    if (message.text.trim() === '/cancel' || message.text.startsWith('/cancel ')) {
      const requestedRunId = message.text.trim().slice('/cancel'.length).trim()
        || this.#store.latestRunId('wecom', this.#config.connectionId, conversationDigest);
      if (!requestedRunId) return { accepted: false, code: 'invalid_message' };
      await this.#agent.cancel(caller, requestedRunId);
      return { accepted: true, duplicate: !accepted.inserted, runId: requestedRunId };
    }

    if (accepted.record.runId) {
      this.#watch(accepted.record, caller);
      return { accepted: true, duplicate: true, runId: accepted.record.runId };
    }
    const submission = await this.#agent.submit(caller, {
      contractVersion: AGENT_CONTRACT_VERSION,
      entryPoint: 'im',
      identity: caller.identity,
      workspaceId: this.#config.workspaceId,
      conversation: {
        namespace: `im:wecom:${digestChannelValue(this.#config.connectionId, 'account', this.#config.providerAccountRef)}`,
        conversationId: `${message.conversationType}:${conversationDigest}`,
      },
      input: { type: 'text', text: message.text },
      idempotencyKey: providerMessageDigest,
      delivery: { kind: 'channel', routeId: accepted.record.inboundId },
    });
    if (!submission.accepted) return { accepted: false, code: 'submission_rejected' };
    const inbound = this.#store.attachRun(accepted.record.inboundId, submission.runId);
    this.#watch(inbound, caller);
    return { accepted: true, duplicate: !accepted.inserted || submission.duplicate, runId: submission.runId };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#transport.close();
    this.#store.markDeliveringUnknown('wecom', this.#config.connectionId, this.#now().toISOString());
  }

  #caller(conversationDigest: string): AuthenticatedAgentCaller {
    return {
      entryPoint: 'im',
      identity: {
        kind: 'channel_user',
        subjectId: conversationDigest,
        authorityId: this.#config.connectionId,
        authenticatedBy: 'channel_adapter',
      },
      authorizeWorkspace: (workspaceId) => workspaceId === this.#config.workspaceId,
      authorizeConversation: (conversation) => conversation.namespace.startsWith('im:wecom:'),
      authorizeDelivery: (delivery) => delivery.kind === 'channel' || delivery.kind === 'none',
    };
  }

  #watch(inbound: ChannelInboundRoute, caller: AuthenticatedAgentCaller): void {
    if (!inbound.runId || this.#watching.has(inbound.runId)) return;
    this.#watching.add(inbound.runId);
    void this.#deliverWhenTerminal(inbound, caller).finally(() => {
      this.#watching.delete(inbound.runId!);
    });
  }

  async #deliverWhenTerminal(inbound: ChannelInboundRoute, caller: AuthenticatedAgentCaller): Promise<void> {
    if (!inbound.runId) return;
    for await (const run of this.#agent.subscribe(caller, inbound.runId)) {
      const content = terminalContent(run);
      if (!content) continue;
      const now = this.#now().toISOString();
      const outbound = this.#store.createOutbound({
        outboundId: this.#createId(),
        inboundId: inbound.inboundId,
        runId: run.runId,
        contentDigest: contentDigest(content),
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      }).record;
      if (!this.#store.claimOutbound(outbound.outboundId, this.#now().toISOString())) return;
      if (this.#closed) {
        this.#store.finishOutbound(outbound.outboundId, 'unknown', this.#now().toISOString(), 'router_closed');
        return;
      }
      const result = await this.#transport.reply({
        providerRequestId: inbound.providerRequestId,
        providerMessageId: inbound.providerMessageId,
      }, outbound.outboundId, content);
      this.#store.finishOutbound(
        outbound.outboundId,
        result.status,
        this.#now().toISOString(),
        result.status === 'accepted' ? undefined : result.code,
      );
      return;
    }
  }
}
