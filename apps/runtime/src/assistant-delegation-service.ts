import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { AssistantDelegationBrief, AssistantDelegationRecord, AssistantDelegationResult } from '@yuanpu-agent/protocol';
import { assertNoSymlinkAncestors, canonicalRealDirectory } from './assistant-delegation-paths.js';

export type DelegationBrief = AssistantDelegationBrief;
export type DelegationResult = AssistantDelegationResult;
export type DelegationRecord = AssistantDelegationRecord;

export interface DelegationExecutionAdapter {
  run(brief: DelegationBrief, followUp: string | undefined, signal: AbortSignal,
    approvedGrantId?: string): Promise<DelegationResult>;
  query(taskId: string): Promise<DelegationResult | undefined>;
  cancel(taskId: string): Promise<void>;
  close(): Promise<void>;
}

const validId = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id);
const needsTaskGrant = (brief: DelegationBrief) => !brief.readOnly || brief.authorizedCapabilities.length > 0;

function validateBrief(brief: DelegationBrief): void {
  if (!validId(brief.taskId) || !validId(brief.assistantSessionId)
    || !/^[a-z][a-z0-9-]{0,63}$/.test(brief.skillName)
    || !brief.goal.trim() || brief.goal.length > 16_000
    || brief.completionCriteria.length < 1 || brief.completionCriteria.length > 12
    || brief.completionCriteria.some((item) => !item.trim() || item.length > 2_000)
    || brief.contextRefs.length > 20 || brief.contextRefs.some((item) => !item || item.length > 300)
    || brief.authorizedCapabilities.length > 10
    || !Number.isFinite(Date.parse(brief.deadlineAt)) || Date.parse(brief.deadlineAt) <= Date.now()
    || Date.parse(brief.deadlineAt) > Date.now() + 1_800_000) {
    throw new Error('Invalid bounded delegation brief.');
  }
}

/** Durable host ledger. Accepted task IDs are never submitted twice after a lost response or restart. */
export class AssistantDelegationService {
  private readonly root: string;
  private canonicalRoot?: string;
  private readonly adapter: DelegationExecutionAdapter;
  private readonly onTerminal?: (record: DelegationRecord) => void;
  private readonly resolveSourceVersions?: (refs: readonly string[]) => Promise<Record<string, string>>;
  private active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private operations = new Map<string, Promise<void>>();
  private closed = false;

  constructor(root: string, adapter: DelegationExecutionAdapter,
    onTerminal?: (record: DelegationRecord) => void,
    resolveSourceVersions?: (refs: readonly string[]) => Promise<Record<string, string>>) {
    if (!isAbsolute(root)) throw new Error('Delegation ledger root must be absolute.');
    this.root = resolve(root);
    this.adapter = adapter;
    this.onTerminal = onTerminal;
    this.resolveSourceVersions = resolveSourceVersions;
  }

  async open(): Promise<void> {
    await assertNoSymlinkAncestors(this.root);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.canonicalRoot = await canonicalRealDirectory(this.root);
    for (const name of await readdir(this.root)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!validId(id)) throw new Error('Invalid delegation ledger entry.');
      const record = await this.read(id);
      if (record && ['accepted', 'running'].includes(record.status)) {
        await this.save({ ...record, status: 'unknown', updatedAt: new Date().toISOString() });
      }
    }
  }

  private file(taskId: string): string {
    if (!validId(taskId)) throw new Error('Invalid delegation task ID.');
    return join(this.root, `${taskId}.json`);
  }

  private async read(taskId: string): Promise<DelegationRecord | undefined> {
    await this.assertRoot();
    try {
      const file = this.file(taskId);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe delegation ledger entry.');
      const record = JSON.parse(await readFile(file, 'utf8')) as DelegationRecord;
      if (record.taskId !== taskId) throw new Error('Delegation ledger ID mismatch.');
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async save(record: DelegationRecord): Promise<void> {
    await this.assertRoot();
    const temporary = `${this.file(record.taskId)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.file(record.taskId));
    } finally { await rm(temporary, { force: true }); }
  }

  private async assertRoot(): Promise<void> {
    if (!this.canonicalRoot || await canonicalRealDirectory(this.root) !== this.canonicalRoot) {
      throw new Error('Delegation ledger root changed or was not opened.');
    }
  }

  private async exclusive<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.operations.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const queued = prior.then(() => gate);
    this.operations.set(taskId, queued);
    await prior;
    try { return await operation(); }
    finally {
      release();
      if (this.operations.get(taskId) === queued) this.operations.delete(taskId);
    }
  }

  async start(brief: DelegationBrief): Promise<DelegationRecord> {
    if (this.closed) throw new Error('Delegation service is closed.');
    return this.exclusive(brief.taskId, async () => {
      const existing = await this.read(brief.taskId);
      if (existing) {
        const original: DelegationBrief = {
          taskId: existing.taskId, assistantSessionId: existing.assistantSessionId,
          skillName: existing.skillName, goal: existing.goal,
          completionCriteria: existing.completionCriteria, contextRefs: existing.contextRefs,
          authorizedCapabilities: existing.authorizedCapabilities, readOnly: existing.readOnly,
          deadlineAt: existing.deadlineAt,
        };
        if (JSON.stringify(original) !== JSON.stringify(brief)) throw new Error('Delegation task ID scope conflict.');
        return existing;
      }
      validateBrief(brief);
      if (brief.sourceVersions) throw new Error('Delegation source versions are host-owned.');
      const sourceVersions = this.resolveSourceVersions
        ? await this.resolveSourceVersions(brief.contextRefs) : undefined;
      const now = new Date().toISOString();
      const approvalRequestId = needsTaskGrant(brief) ? randomUUID() : undefined;
      const record: DelegationRecord = { ...brief, ...(sourceVersions ? { sourceVersions } : {}),
        status: approvalRequestId ? 'waiting_approval' : 'accepted',
        ...(approvalRequestId ? { result: { status: 'waiting_approval', approvalRequestId } } : {}),
        followUps: [], createdAt: now, updatedAt: now };
      await this.save(record);
      if (!approvalRequestId) this.dispatch(record);
      return record;
    });
  }

  private dispatch(record: DelegationRecord, followUp?: string): void {
    const controller = new AbortController();
    const deadlineAt = followUp ? Date.now() + 300_000 : Date.parse(record.deadlineAt);
    const timeout = setTimeout(() => controller.abort(new Error('Delegation deadline exceeded.')),
      Math.max(1, deadlineAt - Date.now()));
    timeout.unref();
    let abortListener: (() => void) | undefined;
    const done = (async () => {
      try {
        await this.exclusive(record.taskId, async () => {
          record = { ...record, status: 'running', updatedAt: new Date().toISOString() };
          await this.save(record);
        });
        const result = await Promise.race([
          this.adapter.run(record, followUp, controller.signal, record.approvedGrantId),
          new Promise<DelegationResult>((resolveAbort) => {
            const interrupted = () => {
              void this.adapter.cancel(record.taskId).catch(() => undefined);
              resolveAbort({ status: 'unknown', errorCode: 'interrupted_or_timed_out' });
            };
            abortListener = interrupted;
            if (controller.signal.aborted) interrupted();
            else controller.signal.addEventListener('abort', interrupted, { once: true });
          }),
        ]);
        await this.exclusive(record.taskId, async () => {
          const latest = await this.read(record.taskId);
          if (!latest || latest.status !== 'running') return;
          record = { ...latest, status: result.status, result, updatedAt: new Date().toISOString() };
          await this.save(record);
          this.onTerminal?.(record);
        });
      } catch (error) {
        await this.exclusive(record.taskId, async () => {
          const latest = await this.read(record.taskId);
          if (!latest || latest.status !== 'running') return;
          record = { ...latest, status: controller.signal.aborted ? 'unknown' : 'failed',
            result: { status: controller.signal.aborted ? 'unknown' : 'failed',
              errorCode: controller.signal.aborted ? 'interrupted' : 'adapter_error' },
            updatedAt: new Date().toISOString() };
          await this.save(record);
          this.onTerminal?.(record);
        });
      } finally {
        clearTimeout(timeout);
        if (abortListener) controller.signal.removeEventListener('abort', abortListener);
        this.active.delete(record.taskId);
      }
    })();
    this.active.set(record.taskId, { controller, done });
  }

  async status(taskId: string): Promise<DelegationRecord | undefined> {
    return this.exclusive(taskId, async () => {
      const record = await this.read(taskId);
      if (!record || record.status !== 'unknown' || record.effectInFlightApprovalId) return record;
      const resolved = await this.adapter.query(taskId);
      if (!resolved || resolved.status === 'unknown') return record;
      const updated = { ...record, status: resolved.status, result: resolved, updatedAt: new Date().toISOString() };
      await this.save(updated);
      this.onTerminal?.(updated);
      return updated;
    });
  }

  async followUp(taskId: string, assistantSessionId: string, text: string): Promise<DelegationRecord> {
    if (this.closed || !text.trim() || text.length > 16_000) throw new Error('Invalid delegation follow-up.');
    return this.exclusive(taskId, async () => {
      const current = await this.read(taskId);
      if (!current || current.assistantSessionId !== assistantSessionId) throw new Error('Unknown delegation in this Assistant Session.');
      if (!['completed', 'failed'].includes(current.status)) throw new Error('Delegation is not ready for follow-up.');
      const approvalRequestId = needsTaskGrant(current) ? randomUUID() : undefined;
      const next: DelegationRecord = { ...current,
        status: approvalRequestId ? 'waiting_approval' : 'accepted',
        result: approvalRequestId ? { status: 'waiting_approval', approvalRequestId } : undefined,
        approvedGrantId: undefined,
        effectInFlightApprovalId: undefined,
        followUps: [...current.followUps, text], updatedAt: new Date().toISOString() };
      await this.save(next);
      if (!approvalRequestId) this.dispatch(next, text);
      return next;
    });
  }

  async pendingApprovals(): Promise<DelegationRecord[]> {
    await this.assertRoot();
    const pending: DelegationRecord[] = [];
    for (const name of await readdir(this.root)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!validId(id)) continue;
      const record = await this.read(id);
      if (record?.status === 'waiting_approval' && !record.effectInFlightApprovalId
        && record.result?.approvalRequestId
        && !record.approvedGrantId) {
        if (Date.parse(record.deadlineAt) <= Date.now()) {
          await this.settleApproval(id, record.result.approvalRequestId,
            { status: 'failed', errorCode: 'approval_expired' });
        } else pending.push(record);
      }
    }
    return pending;
  }

  /** A restart cannot replay an approved external effect whose outcome was not durably settled. */
  async reconcileEffectApprovals(statusOf: (requestId: string) => string | undefined): Promise<void> {
    await this.assertRoot();
    for (const name of await readdir(this.root)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!validId(id)) continue;
      const record = await this.read(id);
      const approvalRequestId = record?.result?.approvalRequestId;
      if (!record?.approvedGrantId || record.status !== 'waiting_approval' || !approvalRequestId) continue;
      if (!record.effectInFlightApprovalId && statusOf(approvalRequestId) === 'pending') continue;
      await this.settleApproval(id, approvalRequestId,
        { status: 'unknown', errorCode: 'external_effect_unresolved_after_restart' });
    }
  }

  async verifyApprovedGrant(brief: DelegationBrief, approvalRequestId: string): Promise<boolean> {
    const record = await this.read(brief.taskId);
    return Boolean(record && record.status === 'running'
      && record.approvedGrantId === approvalRequestId
      && record.assistantSessionId === brief.assistantSessionId
      && record.skillName === brief.skillName
      && JSON.stringify(record.contextRefs) === JSON.stringify(brief.contextRefs)
      && JSON.stringify(record.sourceVersions) === JSON.stringify(brief.sourceVersions)
      && JSON.stringify(record.authorizedCapabilities) === JSON.stringify(brief.authorizedCapabilities)
      && JSON.stringify(record.completionCriteria) === JSON.stringify(brief.completionCriteria)
      && record.readOnly === brief.readOnly && record.goal === brief.goal);
  }

  async decideApproval(taskId: string, approvalRequestId: string,
    decision: 'approved' | 'denied'): Promise<DelegationRecord> {
    return this.exclusive(taskId, async () => {
      const record = await this.read(taskId);
      if (!record || record.status !== 'waiting_approval'
        || record.result?.approvalRequestId !== approvalRequestId || record.approvedGrantId) {
        throw new Error('Approval does not match a waiting delegation.');
      }
      if (Date.parse(record.deadlineAt) <= Date.now()) {
        throw new Error('Delegation approval expired.');
      }
      const now = new Date().toISOString();
      if (decision === 'denied') {
        const denied: DelegationRecord = { ...record, status: 'failed',
          result: { status: 'failed', errorCode: 'user_denied' }, updatedAt: now };
        await this.save(denied);
        this.onTerminal?.(denied);
        return denied;
      }
      const approved: DelegationRecord = { ...record, status: 'accepted', result: undefined,
        approvedGrantId: approvalRequestId, updatedAt: now };
      await this.save(approved);
      this.dispatch(approved, record.followUps.at(-1));
      return approved;
    });
  }

  async cancel(taskId: string, assistantSessionId: string): Promise<DelegationRecord> {
    return this.exclusive(taskId, async () => {
      const record = await this.read(taskId);
      if (!record || record.assistantSessionId !== assistantSessionId) throw new Error('Unknown delegation in this Assistant Session.');
      if (['accepted', 'running', 'waiting_approval', 'unknown'].includes(record.status)) {
        if (record.effectInFlightApprovalId) {
          const unknown: DelegationRecord = { ...record, status: 'unknown',
            result: { status: 'unknown', errorCode: 'cancelled_during_external_effect' },
            updatedAt: new Date().toISOString() };
          await this.save(unknown);
          this.onTerminal?.(unknown);
          return unknown;
        }
        this.active.get(taskId)?.controller.abort();
        await this.adapter.cancel(taskId);
        const cancelled = { ...record, status: 'cancelled' as const, updatedAt: new Date().toISOString() };
        await this.save(cancelled);
        return cancelled;
      }
      return record;
    });
  }

  /** Called only by the trusted, signed host approval path after it executed or rejected the original request. */
  async beginEffectApproval(taskId: string, approvalRequestId: string): Promise<DelegationRecord> {
    return this.exclusive(taskId, async () => {
      const record = await this.read(taskId);
      if (!record || record.status !== 'waiting_approval' || !record.approvedGrantId
        || record.result?.approvalRequestId !== approvalRequestId || record.effectInFlightApprovalId
        || Date.parse(record.deadlineAt) <= Date.now()) {
        throw new Error('Delegated effect is no longer awaiting this approval.');
      }
      const started: DelegationRecord = { ...record, effectInFlightApprovalId: approvalRequestId,
        updatedAt: new Date().toISOString() };
      await this.save(started);
      return started;
    });
  }

  /** Called only by the trusted, signed host approval path after it executed or rejected the original request. */
  async settleApproval(taskId: string, approvalRequestId: string,
    outcome: DelegationResult): Promise<DelegationRecord> {
    return this.exclusive(taskId, async () => {
      const record = await this.read(taskId);
      if (record?.status === 'unknown' && record.effectInFlightApprovalId === approvalRequestId) return record;
      if (!record || record.status !== 'waiting_approval'
        || record.result?.approvalRequestId !== approvalRequestId) {
        throw new Error('Approval does not match a waiting delegation.');
      }
      if (!['completed', 'failed', 'unknown'].includes(outcome.status)
        || outcome.status === 'completed' && !outcome.resultRef) {
        throw new Error('Invalid settled delegation outcome.');
      }
      const next: DelegationRecord = { ...record, status: outcome.status, result: outcome,
        effectInFlightApprovalId: outcome.status === 'unknown' ? record.effectInFlightApprovalId : undefined,
        updatedAt: new Date().toISOString() };
      await this.save(next);
      this.onTerminal?.(next);
      return next;
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.active.values()) job.controller.abort();
    await Promise.allSettled([...this.active.values()].map((job) => job.done));
    await this.adapter.close();
  }
}
