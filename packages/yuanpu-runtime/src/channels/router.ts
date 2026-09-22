import { randomUUID } from 'node:crypto';

import {
  AGENT_CONTRACT_VERSION,
  type AgentRunRecord,
  type AgentRunSubmissionResult,
} from '@yuanpu-agent/protocol';

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

const unsupportedMessageContent = '暂不支持这种消息类型，请发送文字消息。';

export class ChannelRouter {
  readonly #config: ChannelConnectionConfig;
  readonly #store: ChannelStore;
  readonly #agent: AgentService;
  readonly #transport: ChannelTransport;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #watching = new Set<string>();
  readonly #watchingPromises = new Set<Promise<void>>();
  readonly #inboundPromises = new Set<Promise<void>>();
  readonly #watchAbort = new AbortController();
  #recoveryPromise: Promise<void> = Promise.resolve();
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
    this.#store.bindConnection({
      provider: 'wecom',
      connectionId: this.#config.connectionId,
      providerAccountDigest: digestChannelValue(
        this.#config.connectionId,
        'account',
        this.#config.providerAccountRef,
      ),
      credentialBindingDigest: this.#config.credentialBindingDigest,
      now: this.#now().toISOString(),
    });
    for (const digest of this.#config.pairedSenderDigests) {
      this.#store.pair('wecom', this.#config.connectionId, digest, this.#now().toISOString());
    }
    this.#store.markDeliveringUnknown('wecom', this.#config.connectionId, this.#now().toISOString());
    this.#transport.connect(async (message) => {
      await this.handleInbound(message);
    });
    this.#recoveryPromise = this.#transport.ready().then(() => this.#recoverAfterReady());
    this.#trackInbound(this.#recoveryPromise);
  }

  async handleInbound(message: NormalizedChannelMessage): Promise<ChannelInboundReceipt> {
    if (this.#closed || message.connectionId !== this.#config.connectionId || message.provider !== 'wecom') {
      return { accepted: false, code: 'wrong_connection' };
    }
    await this.#recoveryPromise;
    if (this.#closed) return { accepted: false, code: 'wrong_connection' };
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
    const providerMessageDigest = digestChannelValue(
      this.#config.connectionId,
      'message',
      message.providerMessageId,
    );
    if (message.messageType !== 'text') {
      await this.#handleUnsupported(message, providerMessageDigest, senderDigest, conversationDigest);
      return { accepted: false, code: 'unsupported_message' };
    }
    if (typeof message.text !== 'string' || !message.text.trim()) {
      return { accepted: false, code: 'invalid_message' };
    }
    const normalizedText = message.text.trim();
    const isCancel = normalizedText.startsWith('/cancel');
    const cancelTargetRunId = /^\/cancel\s+([^\s]+)$/.exec(normalizedText)?.[1];
    if (isCancel && !cancelTargetRunId) return { accepted: false, code: 'invalid_message' };

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
      pendingInput: message.text,
      action: cancelTargetRunId ? 'cancel' : 'run',
      ...(cancelTargetRunId ? { cancelTargetRunId } : {}),
      receivedAt: this.#now().toISOString(),
    });
    if (
      accepted.record.providerRequestId !== message.providerRequestId
      || accepted.record.senderDigest !== senderDigest
      || accepted.record.conversationType !== message.conversationType
      || accepted.record.conversationDigest !== conversationDigest
      || accepted.record.messageType !== message.messageType
      || accepted.record.contentDigest !== contentDigest(message.text)
      || accepted.record.action !== (cancelTargetRunId ? 'cancel' : 'run')
      || accepted.record.cancelTargetRunId !== cancelTargetRunId
    ) {
      return { accepted: false, code: 'invalid_message' };
    }
    const caller = this.#caller(accepted.record.conversationDigest);
    if (accepted.record.action === 'cancel') {
      const requestedRunId = await this.#cancelPersistedInbound(accepted.record, caller);
      if (!requestedRunId) return { accepted: false, code: 'invalid_message' };
      return { accepted: true, duplicate: !accepted.inserted, runId: requestedRunId };
    }

    if (accepted.record.runId) {
      this.#watch(accepted.record, caller);
      return { accepted: true, duplicate: true, runId: accepted.record.runId };
    }
    if (!accepted.record.pendingInput) return { accepted: false, code: 'invalid_message' };
    const submission = await this.#submitPersistedInbound(accepted.record, accepted.record.pendingInput, caller);
    if (!submission.accepted) return { accepted: false, code: 'submission_rejected' };
    return { accepted: true, duplicate: !accepted.inserted || submission.duplicate, runId: submission.runId };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#watchAbort.abort();
    await this.#transport.close();
    await Promise.allSettled([...this.#inboundPromises]);
    this.#store.markDeliveringUnknown('wecom', this.#config.connectionId, this.#now().toISOString());
    await Promise.allSettled([...this.#watchingPromises]);
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
    const delivery = this.#deliverWhenTerminal(inbound, caller).catch(() => undefined).finally(() => {
      this.#watching.delete(inbound.runId!);
      this.#watchingPromises.delete(delivery);
    });
    this.#watchingPromises.add(delivery);
  }

  #trackInbound(task: Promise<void>): void {
    const tracked = task.catch(() => undefined).finally(() => this.#inboundPromises.delete(tracked));
    this.#inboundPromises.add(tracked);
  }

  async #resumePendingInbound(inbound: ChannelInboundRoute): Promise<void> {
    if (!inbound.pendingInput || this.#closed) return;
    const caller = this.#caller(inbound.conversationDigest);
    if (inbound.action === 'cancel') {
      await this.#cancelPersistedInbound(inbound, caller);
    } else {
      await this.#submitPersistedInbound(inbound, inbound.pendingInput, caller);
    }
  }

  async #recoverAfterReady(): Promise<void> {
    if (this.#closed) return;
    for (const inbound of this.#store.recoverableUnsupported('wecom', this.#config.connectionId)) {
      await this.#deliverUnsupported(inbound);
    }
    for (const inbound of this.#store.recoverableInbound('wecom', this.#config.connectionId)) {
      if (inbound.runId) this.#watch(inbound, this.#caller(inbound.conversationDigest));
    }
    for (const inbound of this.#store.pendingInbound('wecom', this.#config.connectionId)) {
      if (inbound.pendingInput) await this.#resumePendingInbound(inbound);
    }
  }

  async #cancelPersistedInbound(
    inbound: ChannelInboundRoute,
    caller: AuthenticatedAgentCaller,
  ): Promise<string | undefined> {
    if (!inbound.cancelTargetRunId) return undefined;
    await this.#agent.cancel(caller, inbound.cancelTargetRunId);
    this.#store.clearPendingInput(inbound.inboundId);
    return inbound.cancelTargetRunId;
  }

  async #submitPersistedInbound(
    inbound: ChannelInboundRoute,
    input: string,
    caller: AuthenticatedAgentCaller,
  ): Promise<AgentRunSubmissionResult> {
    const submission = await this.#agent.submit(caller, {
      contractVersion: AGENT_CONTRACT_VERSION,
      entryPoint: 'im',
      identity: caller.identity,
      workspaceId: this.#config.workspaceId,
      conversation: {
        namespace: `im:wecom:${digestChannelValue(this.#config.connectionId, 'account', this.#config.providerAccountRef)}`,
        conversationId: `${inbound.conversationType}:${inbound.conversationDigest}`,
      },
      input: { type: 'text', text: input },
      idempotencyKey: inbound.providerMessageId,
      delivery: { kind: 'channel', routeId: inbound.inboundId },
    });
    if (submission.accepted) {
      const attached = this.#store.attachRun(inbound.inboundId, submission.runId);
      this.#watch(attached, caller);
    }
    return submission;
  }

  async #handleUnsupported(
    message: NormalizedChannelMessage,
    providerMessageId: string,
    senderDigest: string,
    conversationDigest: string,
  ): Promise<void> {
    const unsupportedDigest = contentDigest(`unsupported:${message.messageType}`);
    const accepted = this.#store.acceptInbound({
      inboundId: this.#createId(),
      provider: 'wecom',
      connectionId: this.#config.connectionId,
      providerMessageId,
      providerRequestId: message.providerRequestId,
      senderDigest,
      conversationType: message.conversationType,
      conversationDigest,
      messageType: message.messageType,
      contentDigest: unsupportedDigest,
      action: 'unsupported',
      receivedAt: this.#now().toISOString(),
    });
    if (
      accepted.record.providerRequestId !== message.providerRequestId
      || accepted.record.senderDigest !== senderDigest
      || accepted.record.conversationType !== message.conversationType
      || accepted.record.conversationDigest !== conversationDigest
      || accepted.record.messageType !== message.messageType
      || accepted.record.contentDigest !== unsupportedDigest
      || accepted.record.action !== 'unsupported'
    ) {
      return;
    }
    await this.#deliverUnsupported(accepted.record);
  }

  async #deliverUnsupported(inbound: ChannelInboundRoute): Promise<void> {
    const now = this.#now().toISOString();
    const outbound = this.#store.createOutbound({
      outboundId: this.#createId(),
      inboundId: inbound.inboundId,
      contentDigest: contentDigest(unsupportedMessageContent),
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
    }, outbound.outboundId, unsupportedMessageContent).catch(() => ({
      status: 'unknown' as const,
      code: 'transport_uncertain',
    }));
    this.#store.finishOutbound(
      outbound.outboundId,
      result.status,
      this.#now().toISOString(),
      result.status === 'accepted' ? undefined : result.code,
    );
  }

  async #deliverWhenTerminal(inbound: ChannelInboundRoute, caller: AuthenticatedAgentCaller): Promise<void> {
    if (!inbound.runId) return;
    for await (const run of this.#agent.subscribe(caller, inbound.runId, {
      signal: this.#watchAbort.signal,
    })) {
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
      }, outbound.outboundId, content).catch(() => ({
        status: 'unknown' as const,
        code: 'transport_uncertain',
      }));
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
