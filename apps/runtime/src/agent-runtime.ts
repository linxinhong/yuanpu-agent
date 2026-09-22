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

  async execute(input: AgentRunExecutionInput): Promise<AgentRunExecutionResult> {
    const bindingId = input.run.context.conversation.sessionBindingId;
    if (!bindingId) throw new Error('Agent run does not have a persisted Pi session binding.');
    let pooled = this.#sessions.get(bindingId);
    if (!pooled) {
      pooled = {
        active: 0,
        retired: false,
        promise: createYuanpuChatSession({
          ...this.#options.chat,
          capabilityClient: this.#options.getCapabilityClient(),
          capabilityContext: {
            sessionId: input.piSessionId,
            workspaceId: input.run.context.workspaceId,
            userId: input.run.owner.identity.subjectId,
          },
          piSession: { id: input.piSessionId, directory: this.#options.sessionsPath },
        }),
      };
      this.#sessions.set(bindingId, pooled);
    } else {
      this.#sessions.delete(bindingId);
      this.#sessions.set(bindingId, pooled);
    }
    pooled.active += 1;
    try {
      const result = await (await pooled.promise).prompt(input.input, {
        runId: input.run.runId,
        signal: input.signal,
      });
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
          output: { message: result.message, tools: result.tools },
        };
      }
      return { kind: 'completed', output: { message: result.message, tools: result.tools } };
    } finally {
      pooled.active -= 1;
      this.#disposeIfRetired(pooled);
      this.#retireOverflow();
    }
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
