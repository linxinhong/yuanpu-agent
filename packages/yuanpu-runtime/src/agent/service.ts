import { createHash, randomUUID } from 'node:crypto';

import type {
  AgentApprovalBinding,
  AgentContractRejection,
  AgentRunCancellationReceipt,
  AgentRunOutput,
  AgentRunRecord,
  AgentRunSubmissionResult,
} from '@yuanpu-agent/protocol';

import type { AgentRunStore, PersistedQueuedAgentRun } from '../persistence/agent-run-store.js';
import {
  canCallerAccessAgentRun,
  fingerprintAgentRunRequest,
  type AgentService,
  type AuthenticatedAgentCaller,
  validateAgentRunRequest,
} from './contracts.js';

export type AgentRunExecutionResult =
  | { kind: 'completed'; output: AgentRunOutput }
  | { kind: 'waiting_approval'; approval: AgentApprovalBinding; output: AgentRunOutput };

export interface AgentRunExecutionInput {
  run: AgentRunRecord;
  input: string;
  piSessionId: string;
  signal: AbortSignal;
}

export interface AgentRunExecutor {
  execute(input: AgentRunExecutionInput): Promise<AgentRunExecutionResult>;
  close?(): Promise<void> | void;
}

export interface AgentRunApprovalStore {
  cancelRun(runId: string): Promise<void>;
}

export interface PersistentAgentServiceOptions {
  store: AgentRunStore;
  executor: AgentRunExecutor;
  approvals?: AgentRunApprovalStore;
  maximumConcurrentRuns?: number;
  maximumQueuedRuns?: number;
  now?: () => Date;
  createId?: () => string;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function rejection(
  code: AgentContractRejection['code'],
  message: string,
  field?: string,
): AgentContractRejection {
  return { accepted: false, code, message, ...(field ? { field } : {}) };
}

function isTerminal(run: AgentRunRecord): boolean {
  return run.status === 'succeeded'
    || run.status === 'failed'
    || run.status === 'cancelled'
    || run.status === 'interrupted'
    || run.status === 'result_unknown';
}

export class PersistentAgentService implements AgentService {
  readonly #store: AgentRunStore;
  readonly #executor: AgentRunExecutor;
  readonly #approvals?: AgentRunApprovalStore;
  readonly #maximumConcurrentRuns: number;
  readonly #maximumQueuedRuns: number;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #activeBindings = new Set<string>();
  readonly #waitingBindings = new Map<string, string>();
  readonly #abortControllers = new Map<string, AbortController>();
  readonly #approvalRuns = new Set<string>();
  readonly #approvalExecutions = new Set<string>();
  readonly #approvalSettlements = new Map<string, { promise: Promise<void>; resolve(): void }>();
  readonly #approvalExpiryTimers = new Map<string, NodeJS.Timeout>();
  readonly #slotWaiters = new Set<() => void>();
  readonly #subscriptionWaiters = new Set<() => void>();
  readonly #liveOutputs = new Map<string, AgentRunOutput>();
  readonly #subscribers = new Map<string, Set<(run: AgentRunRecord) => void>>();
  readonly #activeWorkers = new Set<Promise<void>>();
  #dispatchScheduled = false;
  #closed = false;

  private constructor(options: PersistentAgentServiceOptions) {
    this.#store = options.store;
    this.#executor = options.executor;
    this.#approvals = options.approvals;
    this.#maximumConcurrentRuns = options.maximumConcurrentRuns ?? 4;
    this.#maximumQueuedRuns = options.maximumQueuedRuns ?? 100;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    if (!Number.isSafeInteger(this.#maximumConcurrentRuns) || this.#maximumConcurrentRuns < 1) {
      throw new Error('maximumConcurrentRuns must be a positive integer.');
    }
    if (!Number.isSafeInteger(this.#maximumQueuedRuns) || this.#maximumQueuedRuns < 1) {
      throw new Error('maximumQueuedRuns must be a positive integer.');
    }
  }

  static async open(options: PersistentAgentServiceOptions): Promise<PersistentAgentService> {
    const service = new PersistentAgentService(options);
    const recovered = service.#store.recoverAfterRestart(service.#now().toISOString());
    await Promise.all(recovered.map((run) => service.#approvals?.cancelRun(run.runId)));
    service.#scheduleDispatch();
    return service;
  }

  async submit(
    caller: AuthenticatedAgentCaller,
    input: unknown,
  ): Promise<AgentRunSubmissionResult> {
    if (this.#closed) return rejection('forbidden', 'Agent service is shutting down.');
    const validation = validateAgentRunRequest(caller, input);
    if (!validation.ok) return validation.error;
    const requestFingerprint = fingerprintAgentRunRequest(validation.value);
    const result = this.#store.submit({
      request: validation.value,
      requestFingerprint,
      inputDigest: digest(validation.value.input.text),
      runId: this.#createId(),
      bindingId: this.#createId(),
      piSessionId: this.#createId(),
      now: this.#now().toISOString(),
      maximumQueuedRuns: this.#maximumQueuedRuns,
    });
    if (result.kind === 'idempotency_conflict') {
      return rejection(
        'idempotency_conflict',
        'The idempotency key was already used for a different request.',
        'idempotencyKey',
      );
    }
    if (result.kind === 'queue_full') {
      return rejection('queue_full', 'The Agent run queue is full.');
    }
    if (result.kind === 'binding_not_found') {
      return rejection('forbidden', 'The requested session binding does not belong to this caller.');
    }
    if (result.kind === 'binding_context_conflict') {
      return rejection('forbidden', 'The requested session binding belongs to another conversation.');
    }
    if (result.kind === 'workspace_conflict') {
      return rejection('forbidden', 'The conversation is already bound to another workspace.');
    }
    if (result.kind === 'duplicate') {
      return {
        accepted: true,
        runId: result.run.runId,
        status: result.run.status,
        duplicate: true,
      };
    }
    this.#emit(result.run);
    this.#scheduleDispatch();
    return {
      accepted: true,
      runId: result.run.runId,
      status: result.run.status,
      duplicate: false,
    };
  }

  async get(
    caller: AuthenticatedAgentCaller,
    runId: string,
  ): Promise<AgentRunRecord | undefined> {
    const run = this.#store.get(runId);
    if (!run || !canCallerAccessAgentRun(caller, run)) return undefined;
    const output = this.#liveOutputs.get(runId);
    return output ? { ...run, output } : run;
  }

  async cancel(
    caller: AuthenticatedAgentCaller,
    runId: string,
  ): Promise<AgentRunCancellationReceipt> {
    const run = await this.get(caller, runId);
    if (!run) return { runId, result: 'not_found' };
    if (isTerminal(run)) return { runId, result: 'already_terminal', status: run.status };
    if (run.status === 'queued') {
      const cancelled = this.#store.cancelQueued(runId, this.#now().toISOString());
      if (!cancelled) return this.cancel(caller, runId);
      await this.#approvals?.cancelRun(runId);
      this.#emit(cancelled);
      return { runId, result: 'cancelled', status: 'cancelled' };
    }

    const controller = this.#abortControllers.get(runId);
    if (controller) {
      controller.abort(new Error('Agent run cancelled by its owner.'));
      await this.#approvals?.cancelRun(runId);
    } else if (run.status === 'waiting_approval') {
      const cancelled = this.#finishCancelled(
        runId,
        'Cancelled while waiting for approval; prior side effects were not reversed.',
      );
      this.#releaseApprovalRun(runId);
      this.#emit(cancelled);
      await this.#approvals?.cancelRun(runId);
    }
    return { runId, result: 'cancellation_requested', status: run.status };
  }

  async *subscribe(
    caller: AuthenticatedAgentCaller,
    runId: string,
  ): AsyncIterable<AgentRunRecord> {
    const values: AgentRunRecord[] = [];
    let wake: (() => void) | undefined;
    const listener = (run: AgentRunRecord) => {
      values.push(structuredClone(run));
      wake?.();
      wake = undefined;
    };
    const listeners = this.#subscribers.get(runId) ?? new Set();
    listeners.add(listener);
    this.#subscribers.set(runId, listeners);
    try {
      const initial = await this.get(caller, runId);
      if (!initial) return;
      values.unshift(initial);
      while (true) {
        while (values.length > 0) {
          const value = values.shift()!;
          yield value;
          if (isTerminal(value)) return;
        }
        if (this.#closed) return;
        await new Promise<void>((resolve) => {
          const waiter = () => {
            this.#subscriptionWaiters.delete(waiter);
            resolve();
          };
          wake = waiter;
          this.#subscriptionWaiters.add(waiter);
          if (this.#closed) waiter();
        });
      }
    } finally {
      if (wake) this.#subscriptionWaiters.delete(wake);
      listeners.delete(listener);
      if (listeners.size === 0) this.#subscribers.delete(runId);
    }
  }

  completeApproval(
    runId: string,
    approvalRequestId: string,
    approvalSignal: AbortSignal,
    output: AgentRunOutput,
  ): AgentRunRecord {
    this.#assertApprovalOwner(runId, approvalSignal);
    if (approvalSignal.aborted) {
      this.failApproval(
        runId,
        approvalRequestId,
        approvalSignal,
        'Approved capability execution was cancelled.',
      );
      throw new Error('Approved capability execution was cancelled.');
    }
    const run = this.#store.get(runId);
    if (
      !run
      || (run.status !== 'waiting_approval' && run.status !== 'running')
      || run.pendingApproval?.approvalRequestId !== approvalRequestId
    ) {
      throw new Error('Approval does not belong to a waiting Agent run.');
    }
    const completed = this.#store.finish({
      runId,
      status: 'succeeded',
      now: this.#now().toISOString(),
      outputDigest: digest(JSON.stringify(output)),
    });
    const live = { ...completed, output };
    this.#releaseApprovalRun(runId);
    this.#rememberOutput(runId, output);
    this.#emit(live);
    return live;
  }

  failApproval(
    runId: string,
    approvalRequestId: string,
    approvalSignal: AbortSignal,
    message: string,
  ): AgentRunRecord {
    this.#assertApprovalOwner(runId, approvalSignal);
    const run = this.#store.get(runId);
    if (
      !run
      || (run.status !== 'waiting_approval' && run.status !== 'running')
      || run.pendingApproval?.approvalRequestId !== approvalRequestId
    ) {
      throw new Error('Approval does not belong to a waiting Agent run.');
    }
    const cancelled = approvalSignal.aborted;
    const failed = cancelled && this.#closed
      ? this.#store.interrupt(runId, this.#now().toISOString())
      : this.#store.finish({
          runId,
          status: cancelled ? 'cancelled' : 'failed',
          now: this.#now().toISOString(),
          failure: {
            code: cancelled ? 'cancelled' : 'approval_failed',
            message: cancelled
              ? 'Cancelled during approved capability execution; prior side effects were not reversed.'
              : message,
            retryable: false,
          },
        });
    this.#releaseApprovalRun(runId);
    this.#emit(failed);
    return failed;
  }

  async beginApproval(
    runId: string,
    approvalRequestId: string,
    options: { executeCapability?: boolean } = {},
  ): Promise<AbortSignal> {
    const pending = this.#store.get(runId);
    if (
      !pending
      || pending.status !== 'waiting_approval'
      || pending.pendingApproval?.approvalRequestId !== approvalRequestId
    ) {
      throw new Error('Approval does not belong to a waiting Agent run.');
    }
    const executeCapability = options.executeCapability ?? true;
    while (
      executeCapability
      && !this.#closed
      && this.#activeExecutionCount() >= this.#maximumConcurrentRuns
    ) {
      await new Promise<void>((resolve) => this.#slotWaiters.add(resolve));
    }
    if (this.#closed) throw new Error('Agent service is shutting down.');
    const run = this.#store.resumeAfterApproval(
      runId,
      approvalRequestId,
      this.#now().toISOString(),
    );
    const controller = new AbortController();
    this.#abortControllers.set(runId, controller);
    this.#approvalRuns.add(runId);
    if (executeCapability) this.#approvalExecutions.add(runId);
    let settle!: () => void;
    const promise = new Promise<void>((resolve) => { settle = resolve; });
    this.#approvalSettlements.set(runId, { promise, resolve: settle });
    this.#emit(run);
    return controller.signal;
  }

  async waitForIdle(): Promise<void> {
    while (this.#activeWorkers.size > 0 || this.#store.listQueued().length > 0) {
      if (this.#activeWorkers.size > 0) {
        await Promise.allSettled([...this.#activeWorkers]);
      } else {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const closeErrors: unknown[] = [];
    for (const wake of [...this.#subscriptionWaiters]) wake();
    for (const wake of [...this.#slotWaiters]) wake();
    this.#slotWaiters.clear();
    for (const runId of [...this.#waitingBindings.keys()]) {
      if (this.#approvalRuns.has(runId)) continue;
      let interrupted: AgentRunRecord | undefined;
      try {
        interrupted = this.#store.interrupt(runId, this.#now().toISOString());
      } catch (error) {
        closeErrors.push(error);
      }
      try {
        await this.#approvals?.cancelRun(runId);
      } catch (error) {
        closeErrors.push(error);
      } finally {
        this.#releaseApprovalRun(runId);
      }
      if (interrupted) this.#emit(interrupted);
    }
    for (const controller of this.#abortControllers.values()) {
      controller.abort(new Error('Agent service is shutting down.'));
    }
    const settlements = await Promise.allSettled([
      ...this.#activeWorkers,
      ...[...this.#approvalSettlements.values()].map((settlement) => settlement.promise),
    ]);
    for (const settlement of settlements) {
      if (settlement.status === 'rejected') closeErrors.push(settlement.reason);
    }
    try {
      await this.#executor.close?.();
    } catch (error) {
      closeErrors.push(error);
    }
    if (closeErrors.length > 0) {
      throw new AggregateError(closeErrors, 'Agent service shutdown did not complete cleanly.');
    }
  }

  #emit(run: AgentRunRecord): void {
    for (const subscriber of this.#subscribers.get(run.runId) ?? []) subscriber(run);
  }

  #scheduleDispatch(): void {
    if (this.#closed || this.#dispatchScheduled) return;
    this.#dispatchScheduled = true;
    queueMicrotask(() => {
      this.#dispatchScheduled = false;
      this.#dispatch();
    });
  }

  #dispatch(): void {
    while (!this.#closed && this.#activeExecutionCount() < this.#maximumConcurrentRuns) {
      const next = this.#store.listQueued().find((candidate) => {
        const bindingId = candidate.run.context.conversation.sessionBindingId;
        return bindingId && !this.#activeBindings.has(bindingId);
      });
      if (!next) return;
      const claimed = this.#store.claimQueued(next.run.runId, this.#now().toISOString());
      if (!claimed) continue;
      const bindingId = claimed.run.context.conversation.sessionBindingId!;
      this.#activeBindings.add(bindingId);
      this.#emit(claimed.run);
      const worker = this.#execute(claimed).finally(() => {
        if (!this.#waitingBindings.has(claimed.run.runId)) {
          this.#activeBindings.delete(bindingId);
        }
        this.#activeWorkers.delete(worker);
        this.#notifySlotWaiters();
        this.#scheduleDispatch();
      });
      this.#activeWorkers.add(worker);
    }
  }

  async #execute(claimed: PersistedQueuedAgentRun): Promise<void> {
    const controller = new AbortController();
    this.#abortControllers.set(claimed.run.runId, controller);
    try {
      const result = await this.#executor.execute({
        run: claimed.run,
        input: claimed.input,
        piSessionId: claimed.piSessionId,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        const cancelled = this.#closed
          ? this.#store.interrupt(claimed.run.runId, this.#now().toISOString())
          : this.#finishCancelled(
              claimed.run.runId,
              'Cancelled during execution; prior side effects were not reversed.',
            );
        await this.#approvals?.cancelRun(claimed.run.runId);
        this.#emit(cancelled);
        return;
      }
      if (result.kind === 'waiting_approval') {
        if (result.approval.runId !== claimed.run.runId) {
          throw new Error('Capability approval was bound to another Agent run.');
        }
        const waiting = this.#store.markWaitingApproval(result.approval, this.#now().toISOString());
        this.#waitingBindings.set(
          claimed.run.runId,
          claimed.run.context.conversation.sessionBindingId!,
        );
        this.#scheduleApprovalExpiry(result.approval);
        this.#rememberOutput(claimed.run.runId, result.output);
        this.#emit({ ...waiting, output: result.output });
        return;
      }
      const completed = this.#store.finish({
        runId: claimed.run.runId,
        status: 'succeeded',
        now: this.#now().toISOString(),
        outputDigest: digest(JSON.stringify(result.output)),
      });
      this.#rememberOutput(claimed.run.runId, result.output);
      this.#emit({ ...completed, output: result.output });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const failed = cancelled
        ? this.#closed
          ? this.#store.interrupt(claimed.run.runId, this.#now().toISOString())
          : this.#finishCancelled(
              claimed.run.runId,
              'Cancelled during execution; prior side effects were not reversed.',
            )
        : this.#store.finish({
            runId: claimed.run.runId,
            status: 'failed',
            now: this.#now().toISOString(),
            failure: {
              code: 'execution_failed',
              message: error instanceof Error ? error.message : String(error),
              retryable: true,
            },
          });
      await this.#approvals?.cancelRun(claimed.run.runId);
      this.#emit(failed);
    } finally {
      this.#abortControllers.delete(claimed.run.runId);
    }
  }

  #rememberOutput(runId: string, output: AgentRunOutput): void {
    this.#liveOutputs.delete(runId);
    this.#liveOutputs.set(runId, output);
    if (this.#liveOutputs.size > 100) {
      const oldest = this.#liveOutputs.keys().next().value as string | undefined;
      if (oldest) this.#liveOutputs.delete(oldest);
    }
  }

  #finishCancelled(runId: string, message: string): AgentRunRecord {
    return this.#store.finish({
      runId,
      status: 'cancelled',
      now: this.#now().toISOString(),
      failure: { code: 'cancelled', message, retryable: false },
    });
  }

  #activeExecutionCount(): number {
    return this.#activeWorkers.size + this.#approvalExecutions.size;
  }

  #notifySlotWaiters(): void {
    for (const wake of [...this.#slotWaiters]) wake();
    this.#slotWaiters.clear();
  }

  #assertApprovalOwner(runId: string, approvalSignal: AbortSignal): void {
    if (this.#abortControllers.get(runId)?.signal !== approvalSignal) {
      throw new Error('Approval execution is not owned by this request.');
    }
  }

  #releaseApprovalRun(runId: string): void {
    this.#abortControllers.delete(runId);
    this.#approvalRuns.delete(runId);
    this.#approvalExecutions.delete(runId);
    const expiryTimer = this.#approvalExpiryTimers.get(runId);
    if (expiryTimer) clearTimeout(expiryTimer);
    this.#approvalExpiryTimers.delete(runId);
    const settlement = this.#approvalSettlements.get(runId);
    this.#approvalSettlements.delete(runId);
    settlement?.resolve();
    const bindingId = this.#waitingBindings.get(runId);
    this.#waitingBindings.delete(runId);
    if (bindingId) this.#activeBindings.delete(bindingId);
    this.#notifySlotWaiters();
    this.#scheduleDispatch();
  }

  #scheduleApprovalExpiry(binding: AgentApprovalBinding): void {
    const existing = this.#approvalExpiryTimers.get(binding.runId);
    if (existing) clearTimeout(existing);
    const expiresAt = Date.parse(binding.expiresAt);
    const delay = Number.isFinite(expiresAt)
      ? Math.max(0, Math.min(2_147_483_647, expiresAt - this.#now().getTime()))
      : 0;
    const timer = setTimeout(() => {
      void this.#expireApproval(binding.runId, binding.approvalRequestId);
    }, delay);
    timer.unref();
    this.#approvalExpiryTimers.set(binding.runId, timer);
  }

  async #expireApproval(runId: string, approvalRequestId: string): Promise<void> {
    const run = this.#store.get(runId);
    if (
      this.#closed
      || !run
      || run.status !== 'waiting_approval'
      || run.pendingApproval?.approvalRequestId !== approvalRequestId
    ) {
      return;
    }
    const expired = this.#store.finish({
      runId,
      status: 'failed',
      now: this.#now().toISOString(),
      failure: {
        code: 'approval_expired',
        message: 'Capability approval expired before a decision was received.',
        retryable: true,
      },
    });
    this.#releaseApprovalRun(runId);
    this.#emit(expired);
    try {
      await this.#approvals?.cancelRun(runId);
    } catch {
      // The durable run is already terminal; a stale approval cannot resume it.
    }
  }
}
