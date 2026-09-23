import { randomUUID } from 'node:crypto';

import {
  AGENT_CONTRACT_VERSION,
  SCHEDULE_CONTRACT_VERSION,
  type AgentDeliveryTarget,
  type AgentRunOutput,
  type AgentRunRecord,
  type AgentRunRequest,
  type ScheduleHistoryRecord,
  type ScheduleInput,
  type ScheduleRecord,
  type ScheduleTiming,
} from '@yuanpu-agent/protocol';

import type { AgentService, AuthenticatedAgentCaller } from '../agent/contracts.js';
import type { PersistedScheduleTrigger, SchedulerStore } from './store.js';
import { firstOccurrence, followingOccurrence, nextCronOccurrence } from './time.js';

export interface ScheduledDeliveryAdapter {
  supports(target: AgentDeliveryTarget): boolean;
  supportsIdempotency(target: AgentDeliveryTarget): boolean;
  deliver(input: {
    deliveryId: string;
    idempotencyKey: string;
    target: AgentDeliveryTarget;
    output: AgentRunOutput;
    signal: AbortSignal;
  }): Promise<void | { status: 'accepted' | 'failed' | 'unknown' | 'deferred'; code?: string }>;
}

export interface PersistentSchedulerOptions {
  store: SchedulerStore;
  agent: AgentService;
  caller: AuthenticatedAgentCaller;
  delivery?: ScheduledDeliveryAdapter;
  authorizeWorkspace(workspaceId: string): boolean;
  authorizeDelivery(target: AgentDeliveryTarget): boolean;
  now?: () => Date;
  createId?: () => string;
  scanIntervalMs?: number;
  maximumDeliveryAttempts?: number;
  deferInitialTick?: boolean;
}

const DEFAULT_MAXIMUM_LATENESS_MS = 24 * 60 * 60_000;
const MAXIMUM_LATENESS_MS = 7 * 24 * 60 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximumLength) {
    throw new Error(`${field} must be a non-empty string of at most ${maximumLength} characters.`);
  }
  return value.trim();
}

function readDelivery(value: unknown): AgentDeliveryTarget {
  if (!isRecord(value)) throw new Error('delivery is required.');
  if (value.kind !== 'desktop' && value.kind !== 'channel' && value.kind !== 'none') {
    throw new Error('delivery.kind is invalid.');
  }
  const routeId = value.routeId === undefined
    ? undefined
    : requiredString(value.routeId, 'delivery.routeId', 512);
  if (value.kind === 'channel' && !routeId) throw new Error('Channel delivery requires routeId.');
  return { kind: value.kind, ...(routeId ? { routeId } : {}) };
}

function readTiming(value: unknown): ScheduleTiming {
  if (!isRecord(value)) throw new Error('timing is required.');
  if (value.kind === 'once') {
    return { kind: 'once', at: requiredString(value.at, 'timing.at', 128) };
  }
  if (value.kind === 'cron') {
    return { kind: 'cron', expression: requiredString(value.expression, 'timing.expression', 128) };
  }
  throw new Error('timing.kind must be once or cron.');
}

function readInput(value: unknown): ScheduleInput {
  if (!isRecord(value)) throw new Error('Schedule input must be an object.');
  if (value.contractVersion !== SCHEDULE_CONTRACT_VERSION) {
    throw new Error(`Unsupported schedule contract version ${String(value.contractVersion)}.`);
  }
  const maximumLatenessMs = value.maximumLatenessMs === undefined
    ? DEFAULT_MAXIMUM_LATENESS_MS
    : value.maximumLatenessMs;
  if (
    typeof maximumLatenessMs !== 'number'
    || !Number.isSafeInteger(maximumLatenessMs)
    || maximumLatenessMs < 0
    || maximumLatenessMs > MAXIMUM_LATENESS_MS
  ) {
    throw new Error(`maximumLatenessMs must be between 0 and ${MAXIMUM_LATENESS_MS}.`);
  }
  if (value.misfirePolicy !== undefined && value.misfirePolicy !== 'coalesce' && value.misfirePolicy !== 'skip') {
    throw new Error('misfirePolicy must be coalesce or skip.');
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error('enabled must be a boolean.');
  }
  if (value.allowOverlap !== undefined && typeof value.allowOverlap !== 'boolean') {
    throw new Error('allowOverlap must be a boolean.');
  }
  return {
    contractVersion: SCHEDULE_CONTRACT_VERSION,
    name: requiredString(value.name, 'name', 200),
    prompt: requiredString(value.prompt, 'prompt', 32 * 1024),
    workspaceId: requiredString(value.workspaceId, 'workspaceId', 2048),
    timing: readTiming(value.timing),
    timeZone: requiredString(value.timeZone, 'timeZone', 128),
    enabled: value.enabled === undefined ? true : value.enabled,
    misfirePolicy: value.misfirePolicy ?? 'coalesce',
    maximumLatenessMs,
    allowOverlap: value.allowOverlap === undefined ? false : value.allowOverlap,
    conversationId: value.conversationId === undefined
      ? undefined
      : requiredString(value.conversationId, 'conversationId', 512),
    delivery: readDelivery(value.delivery),
  };
}

function isTerminal(run: AgentRunRecord): boolean {
  return run.status === 'succeeded'
    || run.status === 'failed'
    || run.status === 'cancelled'
    || run.status === 'interrupted'
    || run.status === 'result_unknown';
}

export class PersistentScheduler {
  readonly #store: SchedulerStore;
  readonly #agent: AgentService;
  readonly #caller: AuthenticatedAgentCaller;
  readonly #delivery?: ScheduledDeliveryAdapter;
  readonly #authorizeWorkspace: (workspaceId: string) => boolean;
  readonly #authorizeDelivery: (target: AgentDeliveryTarget) => boolean;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #scanIntervalMs: number;
  readonly #maximumDeliveryAttempts: number;
  readonly #watchers = new Map<string, Promise<void>>();
  readonly #deliveryControllers = new Map<string, AbortController>();
  #timer?: NodeJS.Timeout;
  #tickPromise?: Promise<void>;
  #closed = false;

  private constructor(options: PersistentSchedulerOptions) {
    this.#store = options.store;
    this.#agent = options.agent;
    this.#caller = options.caller;
    this.#delivery = options.delivery;
    this.#authorizeWorkspace = options.authorizeWorkspace;
    this.#authorizeDelivery = options.authorizeDelivery;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#scanIntervalMs = options.scanIntervalMs ?? 30_000;
    this.#maximumDeliveryAttempts = options.maximumDeliveryAttempts ?? 3;
    if (!Number.isSafeInteger(this.#scanIntervalMs) || this.#scanIntervalMs < 1) {
      throw new Error('scanIntervalMs must be a positive integer.');
    }
    if (!Number.isSafeInteger(this.#maximumDeliveryAttempts) || this.#maximumDeliveryAttempts < 1) {
      throw new Error('maximumDeliveryAttempts must be a positive integer.');
    }
  }

  static async open(options: PersistentSchedulerOptions): Promise<PersistentScheduler> {
    const scheduler = new PersistentScheduler(options);
    scheduler.#store.recoverDeliveries(scheduler.#now().toISOString());
    scheduler.#store.recoverNotifications(scheduler.#now().toISOString());
    if (!options.deferInitialTick) await scheduler.tick();
    return scheduler;
  }

  list(): ScheduleRecord[] {
    return this.#store.list();
  }

  get(scheduleId: string): ScheduleRecord | undefined {
    return this.#store.get(scheduleId);
  }

  history(scheduleId: string, limit = 50): ScheduleHistoryRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error('History limit must be between 1 and 200.');
    }
    return this.#store.history(scheduleId, limit);
  }

  create(value: unknown): ScheduleRecord {
    this.#assertOpen();
    const input = this.#validateInput(value);
    const now = this.#now();
    const next = input.enabled ? firstOccurrence(input.timing, input.timeZone, now) : undefined;
    const timestamp = now.toISOString();
    const scheduleId = this.#createId();
    const schedule: ScheduleRecord = {
      scheduleId,
      revision: 1,
      name: input.name,
      prompt: input.prompt,
      workspaceId: input.workspaceId,
      timing: input.timing,
      timeZone: input.timeZone,
      enabled: input.enabled ?? true,
      misfirePolicy: input.misfirePolicy ?? 'coalesce',
      maximumLatenessMs: input.maximumLatenessMs ?? DEFAULT_MAXIMUM_LATENESS_MS,
      allowOverlap: input.allowOverlap ?? false,
      conversationId: input.conversationId ?? `schedule:${scheduleId}`,
      delivery: input.delivery,
      ...(next ? { nextTriggerAt: next.toISOString() } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const created = this.#store.create(schedule);
    this.#armTimer();
    return created;
  }

  update(scheduleId: string, value: unknown): ScheduleRecord {
    this.#assertOpen();
    const existing = this.#store.get(scheduleId);
    if (!existing) throw new Error('Schedule not found.');
    const input = this.#validateInput(value);
    const now = this.#now();
    const next = input.enabled ? firstOccurrence(input.timing, input.timeZone, now) : undefined;
    const updated = this.#store.update({
      ...existing,
      revision: existing.revision + 1,
      name: input.name,
      prompt: input.prompt,
      workspaceId: input.workspaceId,
      timing: input.timing,
      timeZone: input.timeZone,
      enabled: input.enabled ?? true,
      misfirePolicy: input.misfirePolicy ?? 'coalesce',
      maximumLatenessMs: input.maximumLatenessMs ?? DEFAULT_MAXIMUM_LATENESS_MS,
      allowOverlap: input.allowOverlap ?? false,
      conversationId: input.conversationId ?? existing.conversationId,
      delivery: input.delivery,
      ...(next ? { nextTriggerAt: next.toISOString() } : { nextTriggerAt: undefined }),
      updatedAt: now.toISOString(),
    }, existing.revision);
    this.#armTimer();
    return updated;
  }

  preview(value: unknown): { nextTriggerAt?: string } {
    this.#assertOpen();
    const input = this.#validateInput(value);
    const next = input.enabled ? firstOccurrence(input.timing, input.timeZone, this.#now()) : undefined;
    return next ? { nextTriggerAt: next.toISOString() } : {};
  }

  setEnabled(scheduleId: string, enabled: boolean): ScheduleRecord {
    const existing = this.#store.get(scheduleId);
    if (!existing) throw new Error('Schedule not found.');
    return this.update(scheduleId, {
      contractVersion: SCHEDULE_CONTRACT_VERSION,
      name: existing.name,
      prompt: existing.prompt,
      workspaceId: existing.workspaceId,
      timing: existing.timing,
      timeZone: existing.timeZone,
      enabled,
      misfirePolicy: existing.misfirePolicy,
      maximumLatenessMs: existing.maximumLatenessMs,
      allowOverlap: existing.allowOverlap,
      conversationId: existing.conversationId,
      delivery: existing.delivery,
    });
  }

  tick(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#tickPromise ??= this.#runTick().finally(() => {
      this.#tickPromise = undefined;
      this.#armTimer();
    });
    return this.#tickPromise;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const controller of this.#deliveryControllers.values()) {
      controller.abort(new Error('Scheduler is shutting down.'));
    }
    await this.#tickPromise;
  }

  #validateInput(value: unknown): ScheduleInput {
    const input = readInput(value);
    if (!this.#authorizeWorkspace(input.workspaceId)) throw new Error('Schedule workspace is not authorized.');
    if (!this.#authorizeDelivery(input.delivery)) throw new Error('Schedule delivery target is not authorized.');
    // These calls validate the time zone, timestamp and cron grammar before persistence.
    firstOccurrence(input.timing, input.timeZone, this.#now());
    return input;
  }

  async #runTick(): Promise<void> {
    const now = this.#now();
    for (const schedule of this.#store.listDue(now.toISOString())) {
      if (this.#closed) return;
      this.#reserveDue(schedule, now);
    }
    for (const trigger of this.#store.listPendingSubmissions()) {
      if (this.#closed) return;
      await this.#submitTrigger(trigger);
    }
    for (const trigger of this.#store.listSubmitted()) {
      if (this.#closed) return;
      await this.#reconcileTrigger(trigger);
    }
    if (this.#closed) return;
    await this.#retryDeliveries();
  }

  #reserveDue(schedule: ScheduleRecord, now: Date): void {
    if (!schedule.nextTriggerAt) return;
    let occurrence = new Date(schedule.nextTriggerAt);
    const originallyDue = occurrence;
    const oldestAllowed = new Date(now.getTime() - schedule.maximumLatenessMs);
    if (occurrence < oldestAllowed) {
      if (schedule.timing.kind === 'once' || schedule.misfirePolicy === 'skip') {
        const next = schedule.timing.kind === 'cron'
          ? nextCronOccurrence(schedule.timing.expression, schedule.timeZone, now)
          : undefined;
        this.#store.reserveTrigger({
          schedule,
          scheduledAt: occurrence.toISOString(),
          ...(next ? { nextTriggerAt: next.toISOString() } : {}),
          request: this.#requestFor(schedule, occurrence),
          now: now.toISOString(),
          skipMisfire: true,
        });
        return;
      }
      occurrence = nextCronOccurrence(
        schedule.timing.expression,
        schedule.timeZone,
        new Date(oldestAllowed.getTime() - 60_000),
      );
    }

    if (occurrence > now) {
      this.#store.reserveTrigger({
        schedule,
        scheduledAt: originallyDue.toISOString(),
        nextTriggerAt: occurrence.toISOString(),
        request: this.#requestFor(schedule, originallyDue),
        now: now.toISOString(),
        skipMisfire: true,
      });
      return;
    }
    let selected = occurrence;
    let next = followingOccurrence(schedule.timing, schedule.timeZone, selected);
    let iterations = 0;
    while (next && next <= now) {
      selected = next;
      next = followingOccurrence(schedule.timing, schedule.timeZone, selected);
      iterations += 1;
      if (iterations > 10_080) throw new Error('Schedule catch-up exceeded the seven-day bound.');
    }
    this.#store.reserveTrigger({
      schedule,
      scheduledAt: selected.toISOString(),
      ...(next ? { nextTriggerAt: next.toISOString() } : {}),
      request: this.#requestFor(schedule, selected),
      now: now.toISOString(),
    });
  }

  #requestFor(schedule: ScheduleRecord, occurrence: Date): AgentRunRequest {
    const triggerKey = [schedule.scheduleId, schedule.revision, occurrence.toISOString()].join(':');
    return {
      contractVersion: AGENT_CONTRACT_VERSION,
      entryPoint: 'scheduler' as const,
      identity: this.#caller.identity,
      workspaceId: schedule.workspaceId,
      conversation: {
        namespace: 'scheduler',
        conversationId: schedule.conversationId,
      },
      input: { type: 'text' as const, text: schedule.prompt },
      idempotencyKey: triggerKey,
      delivery: schedule.delivery,
    };
  }

  async #submitTrigger(trigger: PersistedScheduleTrigger): Promise<void> {
    if (this.#closed) return;
    const result = await this.#agent.submit(this.#caller, trigger.request);
    if (!result.accepted) {
      if (result.code !== 'queue_full') {
        this.#store.failSubmission(trigger.triggerKey, `${result.code}: ${result.message}`, this.#now().toISOString());
      }
      return;
    }
    this.#store.attachRun(trigger.triggerKey, result.runId, this.#now().toISOString());
    await this.#reconcileTrigger({ ...trigger, status: 'submitted', runId: result.runId });
  }

  async #reconcileTrigger(trigger: PersistedScheduleTrigger): Promise<void> {
    if (!trigger.runId) return;
    const run = await this.#agent.get(this.#caller, trigger.runId);
    if (this.#closed) return;
    if (!run) return;
    if (run.status === 'succeeded') {
      if (!run.output) {
        this.#store.markOutputUnknown(trigger.triggerKey, this.#now().toISOString());
        return;
      }
      this.#store.prepareDelivery({ trigger, now: this.#now().toISOString() });
      return;
    }
    if (isTerminal(run)) return;
    this.#watch(trigger);
  }

  #watch(trigger: PersistedScheduleTrigger): void {
    if (!trigger.runId || this.#watchers.has(trigger.runId) || this.#closed) return;
    const watcher = (async () => {
      for await (const run of this.#agent.subscribe(this.#caller, trigger.runId!)) {
        if (this.#closed) return;
        if (!isTerminal(run)) continue;
        await this.#reconcileTrigger(trigger);
        return;
      }
    })().finally(() => this.#watchers.delete(trigger.runId!));
    this.#watchers.set(trigger.runId, watcher);
  }

  async #retryDeliveries(): Promise<void> {
    for (const delivery of this.#store.listDeliveriesForRetry()) {
      if (this.#closed) return;
      const retry = delivery.status !== 'pending';
      if (delivery.attempts >= this.#maximumDeliveryAttempts) continue;
      if (retry && !this.#delivery?.supportsIdempotency(delivery.target)) continue;
      const trigger = this.#store.listSubmitted().find((item) => item.runId === delivery.runId);
      if (!trigger) continue;
      const run = await this.#agent.get(this.#caller, delivery.runId);
      if (this.#closed) return;
      if (!run?.output) continue;
      const claimed = this.#store.claimDelivery(delivery.deliveryId, this.#now().toISOString());
      if (!claimed) continue;
      const controller = new AbortController();
      this.#deliveryControllers.set(claimed.deliveryId, controller);
      try {
        if (!this.#delivery?.supports(claimed.target)) throw new Error('No delivery adapter accepts this target.');
        const result = await this.#delivery.deliver({
          deliveryId: claimed.deliveryId,
          idempotencyKey: claimed.idempotencyKey,
          target: claimed.target,
          output: run.output,
          signal: controller.signal,
        });
        if (result?.status === 'deferred') {
          this.#store.deferDelivery(claimed.deliveryId, this.#now().toISOString());
        } else if (result?.status === 'unknown') {
          this.#store.markDeliveryUnknown(claimed.deliveryId, this.#now().toISOString());
        } else if (result?.status === 'failed') {
          this.#store.finishDelivery(
            claimed.deliveryId, 'failed', this.#now().toISOString(), result.code ?? 'delivery_failed',
          );
        } else {
          this.#store.finishDelivery(claimed.deliveryId, 'delivered', this.#now().toISOString());
        }
      } catch (error) {
        if (controller.signal.aborted) {
          this.#store.markDeliveryUnknown(claimed.deliveryId, this.#now().toISOString());
        } else {
          this.#store.finishDelivery(
            claimed.deliveryId,
            'failed',
            this.#now().toISOString(),
            error instanceof Error ? error.message : String(error),
          );
        }
      } finally {
        this.#deliveryControllers.delete(claimed.deliveryId);
      }
    }
  }

  #armTimer(): void {
    if (this.#closed) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.tick(), this.#scanIntervalMs);
    this.#timer.unref();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Scheduler is closed.');
  }
}
