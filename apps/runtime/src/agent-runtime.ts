import {
  createYuanpuChatSession,
  type AgentRunExecutionInput,
  type AgentRunExecutionResult,
  type AgentRunExecutor,
  type CapabilityApprovalRecord,
  type CapabilityToolClient,
  type CreateYuanpuChatOptions,
  type YuanpuChatSession,
} from '@yuanpu-agent/runtime-kit';
import { registerWorkWriteArtifact } from './work-artifact.js';

interface RuntimeAgentExecutorOptions {
  getCapabilityClient(): CapabilityToolClient;
  approvals: { get(requestId: string): CapabilityApprovalRecord | undefined };
  sessionsPath: string;
  maximumPooledSessions?: number;
  chat: Omit<CreateYuanpuChatOptions, 'capabilityClient' | 'capabilityContext' | 'piSession'>;
}

interface PooledSession {
  promise: Promise<YuanpuChatSession>;
  active: number;
  retired: boolean;
}

export class RuntimeAgentExecutor implements AgentRunExecutor {
  readonly #options: RuntimeAgentExecutorOptions;
  readonly #sessions = new Map<string, PooledSession>();
  readonly #retired = new Set<PooledSession>();
  readonly #disposals = new Set<Promise<void>>();
  readonly #maximumPooledSessions: number;

  constructor(options: RuntimeAgentExecutorOptions) {
    this.#options = options;
    this.#maximumPooledSessions = options.maximumPooledSessions ?? 16;
    if (!Number.isSafeInteger(this.#maximumPooledSessions) || this.#maximumPooledSessions < 1) {
      throw new Error('maximumPooledSessions must be a positive integer.');
    }
  }

  updateChat(chat: RuntimeAgentExecutorOptions['chat']): void {
    this.#options.chat = chat;
    this.reset();
  }

  async execute(input: AgentRunExecutionInput): Promise<AgentRunExecutionResult> {
    if (!input.run.context.conversation.sessionBindingId) throw new Error('Agent run does not have a persisted Pi session binding.');
    const sessionKey = input.piSessionId;
    let pooled = this.#sessions.get(sessionKey);
    if (!pooled) {
      pooled = {
        active: 0,
        retired: false,
        promise: createYuanpuChatSession({
          ...this.#options.chat,
          cwd: input.run.context.workspaceId,
          includeGlobalMemory: input.run.owner.entryPoint === 'desktop'
            && input.run.context.conversation.conversationId === 'assistant',
          capabilityClient: this.#options.getCapabilityClient(),
          capabilityContext: {
            sessionId: input.piSessionId,
            conversationId: input.run.context.conversation.conversationId,
            workspaceId: input.run.context.workspaceId,
            userId: input.run.owner.identity.subjectId,
          },
          piSession: { id: input.piSessionId, directory: this.#options.sessionsPath },
        }),
      };
      this.#sessions.set(sessionKey, pooled);
    } else {
      this.#sessions.delete(sessionKey);
      this.#sessions.set(sessionKey, pooled);
    }
    pooled.active += 1;
    try {
      const result = await (await pooled.promise).prompt(input.input, {
        runId: input.run.runId,
        signal: input.signal,
        context: {
          conversationId: input.run.context.conversation.conversationId,
          workspaceId: input.run.context.workspaceId,
          userId: input.run.owner.identity.subjectId,
        },
      });
      const artifacts = [];
      let artifactBytes = 0;
      if (input.run.owner.entryPoint === 'desktop'
        && input.run.context.conversation.conversationId.startsWith('work:')) {
        for (const candidate of result.artifactCandidates ?? []) {
          const toolResult = result.toolResults?.find((item) =>
            item.toolCallId === candidate.toolCallId && item.status === 'completed');
          if (!toolResult) continue;
          const artifact = registerWorkWriteArtifact(input.run.context.workspaceId,
            candidate.requestedPath, toolResult.entryId, candidate.content);
          if (!artifact || artifactBytes + artifact.size > 256 * 1024 || artifacts.length >= 16) continue;
          artifactBytes += artifact.size;
          artifacts.push({ ...artifact, toolCallId: candidate.toolCallId });
        }
      }
      const output = { message: result.message, tools: result.tools,
        ...(result.toolResults ? { toolResults: result.toolResults } : {}),
        ...(artifacts.length ? { artifacts } : {}) };
      if (result.pendingApprovalRequestId) {
        const approval = this.#options.approvals.get(result.pendingApprovalRequestId);
        if (
          !approval
          || approval.runId !== input.run.runId
          || approval.sessionId !== input.piSessionId
          || approval.workspaceId !== input.run.context.workspaceId
        ) {
          throw new Error('Pending capability approval is not bound to the active Agent run.');
        }
        return {
          kind: 'waiting_approval',
          approval: {
            runId: input.run.runId,
            approvalRequestId: approval.requestId,
            sessionId: approval.sessionId,
            workspaceId: approval.workspaceId,
            expiresAt: approval.expiresAt,
          },
          output,
        };
      }
      return { kind: 'completed', output };
    } finally {
      pooled.active -= 1;
      this.#disposeIfRetired(pooled);
      this.#retireOverflow();
    }
  }

  async drainSessions(sessionIds: string[]): Promise<void> {
    const selected = sessionIds.flatMap((id) => {
      const pooled = this.#sessions.get(id);
      return pooled ? [{ id, pooled }] : [];
    });
    for (const { pooled } of selected) {
      if (pooled.active) throw new Error('Work session is executing.');
      await (await pooled.promise).assertMovable();
    }
    for (const { id, pooled } of selected) {
      this.#sessions.delete(id);
      await (await pooled.promise).dispose();
    }
    await Promise.all([...this.#disposals]);
  }

  reset(): void {
    for (const pooled of this.#sessions.values()) {
      pooled.retired = true;
      this.#retired.add(pooled);
      this.#disposeIfRetired(pooled);
    }
    this.#sessions.clear();
  }

  async close(): Promise<void> {
    this.reset();
    await Promise.allSettled([...this.#disposals]);
  }

  #disposeIfRetired(pooled: PooledSession): void {
    if (!pooled.retired || pooled.active > 0 || !this.#retired.delete(pooled)) return;
    const disposal = pooled.promise.then((session) => session.dispose(), () => undefined);
    this.#disposals.add(disposal);
    void disposal.finally(() => this.#disposals.delete(disposal));
  }

  #retireOverflow(): void {
    while (this.#sessions.size > this.#maximumPooledSessions) {
      const idle = [...this.#sessions].find(([, pooled]) => pooled.active === 0);
      if (!idle) return;
      const [bindingId, pooled] = idle;
      this.#sessions.delete(bindingId);
      pooled.retired = true;
      this.#retired.add(pooled);
      this.#disposeIfRetired(pooled);
    }
  }
}
