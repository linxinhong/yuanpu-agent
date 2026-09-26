import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AssistantAudience } from '@yuanpu-agent/protocol';
import type { QueuedSource } from './memory-sources.js';

export type AutomationKind = 'review-work' | 'understand-user' | 'maintain-memory'
  | 'verify-delegation' | 'daily-check' | 'weekly-check' | 'correction' | 'forget';
export type AutomationStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface AutomationJob {
  jobId: string;
  kind: AutomationKind;
  dedupeKey: string;
  sourceId?: string;
  sourceVersion?: string;
  delegationId?: string;
  audience: AssistantAudience;
  status: AutomationStatus;
  priority: number;
  createdAt: string;
  dueAt: string;
  deadlineAt: string;
  maxDurationMs: number;
  maxCostUsd: number;
  attempts: number;
  retryAt?: string;
  failure?: string;
  effectId: string;
}

export interface AutomationProposal { costUsd: number; value?: unknown; }
export type AutomationOutcome = 'applied' | 'unknown' | 'absent' | 'deferred';
export interface AutomationHandler {
  /** Check an earlier attempt before any possible external side effect. */
  lookup(job: AutomationJob): Promise<AutomationOutcome>;
  /** Produce a proposal only. Model output must not write durable state here. */
  prepare(job: AutomationJob, signal: AbortSignal): Promise<AutomationProposal>;
  /** Apply with job.effectId as an idempotency key (e.g. a memory revision ID). */
  apply(job: AutomationJob, proposal: AutomationProposal): Promise<void>;
}

const schema = `
  CREATE TABLE IF NOT EXISTS automation_jobs (
    job_id TEXT PRIMARY KEY, kind TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
    source_id TEXT, source_version TEXT, delegation_id TEXT,
    audience_kind TEXT NOT NULL, audience_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','waiting','completed','failed','cancelled')),
    priority INTEGER NOT NULL, created_at TEXT NOT NULL, due_at TEXT NOT NULL,
    deadline_at TEXT NOT NULL, max_duration_ms INTEGER NOT NULL, max_cost_usd REAL NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, retry_at TEXT, failure TEXT, effect_id TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS automation_ready ON automation_jobs(status,due_at,priority);
  CREATE INDEX IF NOT EXISTS automation_source ON automation_jobs(kind,source_id,source_version);
  CREATE TABLE IF NOT EXISTS automation_checks (
    kind TEXT NOT NULL CHECK(kind IN ('daily-check','weekly-check')),
    period_key TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES automation_jobs(job_id),
    PRIMARY KEY(kind,period_key)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS automation_source_links (
    feed_id TEXT NOT NULL, event_id TEXT NOT NULL,
    job_id TEXT, PRIMARY KEY(feed_id,event_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS automation_checkpoints (
    effect_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES automation_jobs(job_id),
    snapshot_json TEXT NOT NULL, checked_at TEXT NOT NULL
  ) STRICT;
`;

const priorities: Record<AutomationKind, number> = {
  forget: 100, correction: 95, 'verify-delegation': 70,
  'review-work': 50, 'understand-user': 45, 'maintain-memory': 40,
  'daily-check': 20, 'weekly-check': 10,
};

function rowJob(row: Record<string, unknown>): AutomationJob {
  return { jobId: String(row.job_id), kind: row.kind as AutomationKind,
    dedupeKey: String(row.dedupe_key),
    ...(row.source_id === null ? {} : { sourceId: String(row.source_id) }),
    ...(row.source_version === null ? {} : { sourceVersion: String(row.source_version) }),
    ...(row.delegation_id === null ? {} : { delegationId: String(row.delegation_id) }),
    audience: { kind: row.audience_kind as AssistantAudience['kind'], id: String(row.audience_id) },
    status: row.status as AutomationStatus, priority: Number(row.priority),
    createdAt: String(row.created_at), dueAt: String(row.due_at),
    deadlineAt: String(row.deadline_at), maxDurationMs: Number(row.max_duration_ms),
    maxCostUsd: Number(row.max_cost_usd),
    attempts: Number(row.attempts),
    ...(row.retry_at === null ? {} : { retryAt: String(row.retry_at) }),
    ...(row.failure === null ? {} : { failure: String(row.failure) }),
    effectId: String(row.effect_id) };
}

function safeKey(value: string, label: string): void {
  if (!value || value.length > 256 || /[\x00-\x1f]/u.test(value)) throw new Error(`Invalid ${label}.`);
}

function localPeriods(now: Date): { daily: string; weekly: string } {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const utc = new Date(Date.UTC(year, now.getMonth(), now.getDate()));
  utc.setUTCDate(utc.getUTCDate() + 4 - (utc.getUTCDay() || 7));
  const weekYear = utc.getUTCFullYear();
  const first = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil((((utc.getTime() - first.getTime()) / 86_400_000) + 1) / 7);
  return { daily: `${year}-${month}-${day}`, weekly: `${weekYear}-W${String(week).padStart(2, '0')}` };
}

/** Shares state.sqlite and its single Worker writer with the source and memory repositories. */
export class AssistantAutomationStore {
  constructor(readonly database: DatabaseSync, private readonly now: () => Date = () => new Date()) {
    database.exec(schema);
    this.recoverInterrupted();
  }

  private recoverInterrupted(): void {
    this.database.prepare(`UPDATE automation_jobs SET status='waiting',
      retry_at=?,failure='Worker stopped while this job was running'
      WHERE status='running'`).run(this.now().toISOString());
  }

  get(jobId: string): AutomationJob | undefined {
    const row = this.database.prepare('SELECT * FROM automation_jobs WHERE job_id=?')
      .get(jobId) as Record<string, unknown> | undefined;
    return row && rowJob(row);
  }

  byKey(dedupeKey: string): AutomationJob | undefined {
    const row = this.database.prepare('SELECT * FROM automation_jobs WHERE dedupe_key=?')
      .get(dedupeKey) as Record<string, unknown> | undefined;
    return row && rowJob(row);
  }

  enqueue(input: { kind: AutomationKind; dedupeKey: string; audience: AssistantAudience;
    sourceId?: string; sourceVersion?: string; delegationId?: string; dueAt?: Date;
    durationMs?: number; maxCostUsd?: number }): AutomationJob {
    safeKey(input.dedupeKey, 'automation dedupe key');
    safeKey(input.audience.id, 'automation audience');
    if (input.sourceId) safeKey(input.sourceId, 'automation source ID');
    if (input.sourceVersion) safeKey(input.sourceVersion, 'automation source version');
    if (input.delegationId) safeKey(input.delegationId, 'automation delegation ID');
    const durationMs = input.durationMs ?? 60_000;
    const maxCostUsd = input.maxCostUsd ?? 0.05;
    if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 3_600_000
      || !Number.isFinite(maxCostUsd) || maxCostUsd < 0 || maxCostUsd > 10) {
      throw new Error('Invalid automation budget.');
    }
    const existing = this.byKey(input.dedupeKey);
    if (existing) {
      if (existing.kind !== input.kind || existing.sourceId !== input.sourceId
        || existing.sourceVersion !== input.sourceVersion || existing.delegationId !== input.delegationId
        || existing.audience.kind !== input.audience.kind || existing.audience.id !== input.audience.id) {
        throw new Error('Conflicting automation dedupe key.');
      }
      return existing;
    }
    const now = this.now();
    const jobId = randomUUID();
    const dueAt = input.dueAt ?? now;
    if (!Number.isFinite(dueAt.getTime())) throw new Error('Invalid automation due time.');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (input.sourceId && input.sourceVersion) {
        this.database.prepare(`UPDATE automation_jobs SET status='cancelled',failure='Superseded by newer source',
          retry_at=NULL WHERE kind=? AND source_id=? AND source_version!=?
          AND status IN ('queued','waiting','running')`).run(input.kind, input.sourceId, input.sourceVersion);
      }
      this.database.prepare(`INSERT INTO automation_jobs(job_id,kind,dedupe_key,source_id,source_version,
        delegation_id,audience_kind,audience_id,status,priority,created_at,due_at,deadline_at,
        max_duration_ms,max_cost_usd,effect_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(jobId, input.kind,
          input.dedupeKey, input.sourceId ?? null, input.sourceVersion ?? null,
          input.delegationId ?? null, input.audience.kind, input.audience.id, 'queued',
          priorities[input.kind], now.toISOString(), dueAt.toISOString(),
          new Date(Math.max(now.getTime(), dueAt.getTime()) + durationMs).toISOString(),
          durationMs, maxCostUsd, `automation:${jobId}`);
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    return this.get(jobId)!;
  }

  enqueueSource(event: QueuedSource): AutomationJob | undefined {
    if (event.status !== 'processed' || event.feedId === 'legacy-memory') return undefined;
    const origin = event.feedId.replace(/-deletions$/u, '');
    if (origin !== 'work' && origin !== 'assistant') return undefined;
    const kind: AutomationKind = event.change.kind === 'deleted' ? 'maintain-memory'
      : origin === 'work' ? 'review-work' : 'understand-user';
    return this.enqueue({ kind, dedupeKey: `source:${kind}:${event.change.sourceId}:${event.change.sourceVersion}`,
      sourceId: event.change.sourceId, sourceVersion: event.change.sourceVersion,
      audience: event.change.audience });
  }

  /** Repairs a crash between processing a source and registering its automation job. */
  reconcileProcessedSources(limit = 100): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid scan limit.');
    const rows = this.database.prepare(`SELECT e.* FROM source_events e
      LEFT JOIN automation_source_links l ON l.feed_id=e.feed_id AND l.event_id=e.event_id
      WHERE e.status='processed' AND e.feed_id IN ('work','assistant','work-deletions','assistant-deletions')
        AND l.event_id IS NULL ORDER BY e.rowid LIMIT ?`).all(limit) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const event: QueuedSource = { feedId: String(row.feed_id), eventId: String(row.event_id),
        status: 'processed', change: { sourceId: String(row.source_id),
          sourceVersion: String(row.source_version), kind: row.kind as QueuedSource['change']['kind'],
          audience: { kind: row.audience_kind as AssistantAudience['kind'], id: String(row.audience_id) },
          occurredAt: String(row.occurred_at),
          ...(row.content_ref === null ? {} : { contentRef: String(row.content_ref) }),
          ...(row.work_id === null ? {} : { workId: String(row.work_id) }) } };
      const job = this.enqueueSource(event);
      this.database.prepare(`INSERT OR IGNORE INTO automation_source_links(feed_id,event_id,job_id)
        VALUES (?,?,?)`).run(event.feedId, event.eventId, job?.jobId ?? null);
    }
    return rows.length;
  }

  enqueueDelegation(delegationId: string, version: string, audience: AssistantAudience): AutomationJob {
    safeKey(delegationId, 'delegation ID');
    safeKey(version, 'delegation version');
    return this.enqueue({ kind: 'verify-delegation',
      dedupeKey: `delegation:${delegationId}:${version}`, delegationId, sourceVersion: version, audience });
  }

  /** Current local period only: downtime never creates a backlog of missed checks. */
  scheduleActivePeriods(): AutomationJob[] {
    const { daily, weekly } = localPeriods(this.now());
    const audience = { kind: 'personal' as const, id: 'local-user' };
    return ([['daily-check', daily], ['weekly-check', weekly]] as const).map(([kind, period]) => {
      const job = this.enqueue({ kind, dedupeKey: `period:${kind}:${period}`, audience,
        durationMs: 120_000, maxCostUsd: 0.1 });
      this.database.prepare(`INSERT OR IGNORE INTO automation_checks(kind,period_key,job_id)
        VALUES (?,?,?)`).run(kind, period, job.jobId);
      return job;
    });
  }

  next(): AutomationJob | undefined {
    const at = this.now().toISOString();
    const row = this.database.prepare(`SELECT * FROM automation_jobs
      WHERE ((status='queued' AND due_at<=?) OR (status='waiting' AND retry_at<=?))
      ORDER BY priority DESC,created_at,job_id LIMIT 1`).get(at, at) as Record<string, unknown> | undefined;
    return row && rowJob(row);
  }

  start(jobId: string): AutomationJob | undefined {
    const job = this.get(jobId);
    if (!job || !['queued', 'waiting'].includes(job.status)) return undefined;
    this.database.prepare(`UPDATE automation_jobs SET status='running',attempts=attempts+1,
      deadline_at=?,retry_at=NULL,failure=NULL WHERE job_id=? AND status IN ('queued','waiting')`)
      .run(new Date(this.now().getTime() + job.maxDurationMs).toISOString(), jobId);
    return this.get(jobId);
  }

  finish(jobId: string, status: Extract<AutomationStatus, 'completed' | 'failed' | 'waiting' | 'cancelled'>,
    reason?: string, retryAt?: Date): void {
    this.database.prepare(`UPDATE automation_jobs SET status=?,failure=?,retry_at=?
      WHERE job_id=? AND status='running'`).run(status, reason ?? null,
        retryAt?.toISOString() ?? null, jobId);
  }

  cancel(jobId: string): void {
    this.database.prepare(`UPDATE automation_jobs SET status='cancelled',failure='Cancelled',retry_at=NULL
      WHERE job_id=? AND status IN ('queued','waiting','running')`).run(jobId);
  }

  priority(kind: AutomationKind): number { return priorities[kind]; }

  hasCheckpoint(effectId: string): boolean {
    return Boolean(this.database.prepare('SELECT 1 FROM automation_checkpoints WHERE effect_id=?').get(effectId));
  }

  recordCheckpoint(job: AutomationJob, snapshot: unknown): void {
    const serialized = JSON.stringify(snapshot);
    if (serialized.length > 16_000) throw new Error('Automation checkpoint exceeds budget.');
    this.database.prepare(`INSERT OR IGNORE INTO automation_checkpoints(effect_id,job_id,snapshot_json,checked_at)
      VALUES (?,?,?,?)`).run(job.effectId, job.jobId, serialized, this.now().toISOString());
  }
}

/** Runs proposals outside SQLite; only a current, budget-compliant result may be applied. */
export class AssistantAutomationEngine {
  private foreground = false;
  private paused = false;
  private stopped = false;
  private active?: { jobId: string; controller: AbortController };

  constructor(readonly store: AssistantAutomationStore, private readonly handler: AutomationHandler,
    private readonly now: () => Date = () => new Date()) {}

  setForeground(active: boolean): void {
    this.foreground = active;
    if (active) this.active?.controller.abort();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.active?.controller.abort();
  }

  cancel(jobId: string): void {
    if (this.active?.jobId === jobId) this.active.controller.abort();
    this.store.cancel(jobId);
  }

  preemptFor(kind: AutomationKind): void {
    if (this.active && this.store.get(this.active.jobId)!.priority < this.store.priority(kind)) {
      this.active.controller.abort();
    }
  }

  stop(): void { this.stopped = true; this.active?.controller.abort(); }

  async tick(): Promise<AutomationJob | undefined> {
    if (this.stopped || this.paused || this.foreground || this.active) return undefined;
    const next = this.store.next();
    if (!next) return undefined;
    const job = this.store.start(next.jobId);
    if (!job) return undefined;
    const controller = new AbortController();
    this.active = { jobId: job.jobId, controller };
    const remaining = Math.max(0, Date.parse(job.deadlineAt) - this.now().getTime());
    const timeout = setTimeout(() => controller.abort(), remaining);
    try {
      const prior = await this.handler.lookup(job);
      if (prior === 'applied') { this.store.finish(job.jobId, 'completed'); return this.store.get(job.jobId); }
      if (prior === 'unknown') {
        this.store.finish(job.jobId, 'waiting', 'External result unknown; query status before retry',
          new Date(this.now().getTime() + 60_000));
        return this.store.get(job.jobId);
      }
      if (prior === 'deferred') {
        this.store.finish(job.jobId, 'waiting', 'Awaiting the owning assistant skill',
          new Date(this.now().getTime() + 3_600_000));
        return this.store.get(job.jobId);
      }
      if (controller.signal.aborted || this.foreground || this.paused || this.stopped) return undefined;
      const proposal = await this.handler.prepare(job, controller.signal);
      if (controller.signal.aborted || this.foreground || this.paused || this.stopped
        || this.store.get(job.jobId)?.status !== 'running') return undefined;
      if (!Number.isFinite(proposal.costUsd) || proposal.costUsd < 0
        || proposal.costUsd > job.maxCostUsd || this.now().getTime() > Date.parse(job.deadlineAt)) {
        this.store.finish(job.jobId, 'failed', 'Automation budget exceeded');
        return this.store.get(job.jobId);
      }
      await this.handler.apply(job, proposal);
      this.store.finish(job.jobId, 'completed');
      return this.store.get(job.jobId);
    } catch (error) {
      if (!controller.signal.aborted) this.store.finish(job.jobId, 'waiting', String(error),
        new Date(this.now().getTime() + 60_000));
      return this.store.get(job.jobId);
    } finally {
      clearTimeout(timeout);
      if (this.store.get(job.jobId)?.status === 'running') {
        this.store.finish(job.jobId, 'waiting', 'Interrupted before applying proposal', this.now());
      }
      this.active = undefined;
    }
  }
}
