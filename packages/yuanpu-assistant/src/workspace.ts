import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssistantDelegationRecord, AssistantEvidenceRef, AssistantMemoryView,
  AssistantSourceView, AssistantWorkspaceSnapshot, AssistantWorkReview } from '@yuanpu-agent/protocol';
import type { AssistantDelegationHost } from './delegations.js';
import type { AssistantMemoryDocument, AssistantMemoryRepository } from './memory-documents.js';
import type { AssistantWorkReviewStore } from './work-review.js';

const personal = { kind: 'personal', id: 'local-user' } as const;
const validId = (id: string) => /^[A-Za-z0-9_-]{1,128}$/u.test(id);

function view(document: AssistantMemoryDocument): AssistantMemoryView {
  return { id: document.id, version: document.version, section: document.section,
    kind: document.kind, context: document.context, text: document.text,
    status: document.status, verifiedAt: document.verifiedAt, evidence: document.evidence,
    manualAuthority: document.manualAuthority };
}

/** Personal Assistant panel read/write boundary. Its only writer is the Assistant Worker. */
export class AssistantWorkspaceService {
  constructor(private readonly home: string, private readonly memory: AssistantMemoryRepository,
    private readonly reviews: AssistantWorkReviewStore,
    private readonly delegations: AssistantDelegationHost) {
    this.memory.sources.database.exec(`CREATE TABLE IF NOT EXISTS assistant_workspace_settings (
      id INTEGER PRIMARY KEY CHECK(id=1), organizing_paused_until TEXT
    ) STRICT; INSERT OR IGNORE INTO assistant_workspace_settings(id) VALUES (1);`);
  }

  organizingPausedUntil(): string | undefined {
    const row = this.memory.sources.database.prepare(`SELECT organizing_paused_until
      FROM assistant_workspace_settings WHERE id=1`).get() as { organizing_paused_until: string | null };
    return row.organizing_paused_until ?? undefined;
  }

  isOrganizingPaused(): boolean {
    const until = this.organizingPausedUntil();
    return Boolean(until && Date.parse(until) > Date.now());
  }

  pauseOrganizing(until?: string): { organizingPausedUntil?: string } {
    if (until && (!Number.isFinite(Date.parse(until)) || Date.parse(until) <= Date.now())) {
      throw new Error('Invalid organizing pause deadline.');
    }
    this.memory.sources.database.prepare(`UPDATE assistant_workspace_settings
      SET organizing_paused_until=? WHERE id=1`).run(until ?? null);
    return { organizingPausedUntil: this.organizingPausedUntil() };
  }

  private async ownedMemory(id: string): Promise<AssistantMemoryDocument> {
    if (!validId(id)) throw new Error('Invalid memory ID.');
    const document = await this.memory.get(id);
    if (!document || document.section !== 'memories' || document.status !== 'active'
      || document.audience.kind !== personal.kind || document.audience.id !== personal.id) {
      throw new Error('Assistant memory is unavailable.');
    }
    return document;
  }

  private async delegationArchive(taskId: string): Promise<{ assistantSessionId: string;
    verification?: { checkedAt: string; evidenceByCriterion: Record<string, string[]> } }> {
    if (!validId(taskId)) throw new Error('Invalid delegation ID.');
    const directory = join(this.home, 'delegations');
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new Error('Unsafe delegation directory.');
    }
    const file = join(directory, `${taskId}.json`);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe delegation archive.');
    const archive = JSON.parse(await readFile(file, 'utf8')) as { taskId?: unknown;
      assistantSessionId?: unknown; verification?: { checkedAt: string;
        evidenceByCriterion: Record<string, string[]> } };
    if (archive.taskId !== taskId || typeof archive.assistantSessionId !== 'string'
      || !validId(archive.assistantSessionId)) throw new Error('Invalid delegation archive.');
    return { assistantSessionId: archive.assistantSessionId,
      ...(archive.verification ? { verification: archive.verification } : {}) };
  }

  private async delegationSession(taskId: string): Promise<string> {
    return (await this.delegationArchive(taskId)).assistantSessionId;
  }

  async snapshot(memoryLimit = 100): Promise<AssistantWorkspaceSnapshot> {
    if (!Number.isSafeInteger(memoryLimit) || memoryLimit < 1 || memoryLimit > 10_000) {
      throw new Error('Invalid memory page size.');
    }
    const memoryRows = this.memory.sources.database.prepare(`SELECT id FROM memory_documents
      WHERE section='memories' AND audience_kind='personal' AND audience_id='local-user'
        AND status='active' ORDER BY rowid DESC LIMIT ?`).all(memoryLimit + 1) as Array<{ id: string }>;
    const hasMoreMemories = memoryRows.length > memoryLimit;
    const memories: AssistantMemoryView[] = [];
    for (const row of memoryRows.slice(0, memoryLimit)) {
      const document = await this.memory.get(row.id);
      if (document?.status === 'active' && document.audience.kind === personal.kind
        && document.audience.id === personal.id) memories.push(view(document));
    }
    const reviewRows = this.memory.sources.database.prepare(`SELECT review_id,source_id,source_version
      FROM work_reviews WHERE status='active' ORDER BY rowid DESC`).all() as
      Array<{ review_id: string; source_id: string; source_version: string }>;
    const reviews: AssistantWorkReview[] = [];
    const reviewRefs: AssistantEvidenceRef[] = [];
    const seenWork = new Set<string>();
    let hasMoreReviews = false;
    for (const row of reviewRows) {
      const review = this.reviews.get(row.review_id);
      if (review && review.audience.kind === personal.kind && review.audience.id === personal.id
        && !seenWork.has(review.workId)) {
        if (reviews.length >= memoryLimit) { hasMoreReviews = true; break; }
        reviews.push(review);
        reviewRefs.push({ sourceId: row.source_id, sourceVersion: row.source_version,
          observedAt: review.createdAt });
        seenWork.add(review.workId);
      }
    }
    const delegations: AssistantDelegationRecord[] = [];
    const delegationVerifications: AssistantWorkspaceSnapshot['delegationVerifications'] = {};
    let delegationsUnavailable = false;
    let hasMoreDelegations = false;
    try {
      const directory = join(this.home, 'delegations');
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe delegation directory.');
      const names = (await readdir(directory)).filter((name) => /^[A-Za-z0-9_-]{1,128}\.json$/u.test(name)).sort();
      hasMoreDelegations = names.length > memoryLimit;
      const records = await Promise.allSettled(names.slice(-memoryLimit).map(async (name) => {
        const taskId = name.slice(0, -5);
        const archive = await this.delegationArchive(taskId);
        return { record: await this.delegations.status(taskId), verification: archive.verification };
      }));
      for (const result of records) {
        if (result.status === 'rejected') delegationsUnavailable = true;
        else if (result.value.record) {
          delegations.push(result.value.record);
          if (result.value.record.status === 'completed' && result.value.verification) {
            delegationVerifications[result.value.record.taskId] = result.value.verification;
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    delegations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const hasSuggestions = Boolean(this.memory.sources.database.prepare(`SELECT 1 FROM sqlite_master
      WHERE type='table' AND name='assistant_suggestions'`).get());
    const suggestionRows = hasSuggestions ? this.memory.sources.database.prepare(`SELECT evidence_json
      FROM assistant_suggestions ORDER BY generated_at DESC LIMIT 100`).all() as
      Array<{ evidence_json: string }> : [];
    const refs: AssistantEvidenceRef[] = [...memories.flatMap((item) => item.evidence),
      ...reviewRefs, ...reviews.flatMap((item) => item.findings.flatMap((finding) => finding.evidence)),
      ...suggestionRows.flatMap((row) => JSON.parse(row.evidence_json) as AssistantEvidenceRef[])];
    const sources: AssistantSourceView[] = [];
    const seenSource = new Set<string>();
    for (const ref of refs) {
      const key = `${ref.sourceId}:${ref.sourceVersion}`;
      if (seenSource.has(key)) continue;
      seenSource.add(key);
      const current = this.memory.sources.source(ref.sourceId);
      const event = this.memory.sources.database.prepare(`SELECT work_id FROM source_events
        WHERE source_id=? AND source_version=? AND work_id IS NOT NULL
          AND audience_kind='personal' AND audience_id='local-user'
        ORDER BY rowid DESC LIMIT 1`).get(ref.sourceId, ref.sourceVersion) as
        { work_id: string } | undefined;
      const workConversationId = event?.work_id?.startsWith('work:')
        && validId(event.work_id.slice(5)) ? event.work_id.slice(5) : undefined;
      sources.push({ sourceId: ref.sourceId, sourceVersion: ref.sourceVersion,
        availability: current?.sourceVersion === ref.sourceVersion
          ? current.availability : 'unknown', ...(workConversationId ? { workConversationId } : {}) });
    }
    const sync = this.memory.sources.database.prepare(`SELECT
      SUM(CASE WHEN status='processed' THEN 1 ELSE 0 END) AS processed,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='unavailable' THEN 1 ELSE 0 END) AS unavailable,
      MAX(CASE WHEN status='processed' THEN occurred_at END) AS last_observed_at
      FROM source_events WHERE audience_kind='personal' AND audience_id='local-user'`).get() as {
        processed: number | null; pending: number | null;
        unavailable: number | null; last_observed_at: string | null };
    return { memories, hasMoreMemories, reviews, hasMoreReviews, delegations,
      hasMoreDelegations, delegationVerifications, sources,
      ...(delegationsUnavailable ? { delegationsUnavailable: true } : {}),
      ...(this.organizingPausedUntil() ? { organizingPausedUntil: this.organizingPausedUntil() } : {}),
      sourceSync: { processed: sync.processed ?? 0, pending: sync.pending ?? 0,
        unavailable: sync.unavailable ?? 0,
        ...(sync.last_observed_at ? { lastObservedAt: sync.last_observed_at } : {}) } };
  }

  async correctMemory(id: string, expectedVersion: number, text: string,
    revisionId: string = randomUUID()): Promise<AssistantMemoryView> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1
      || typeof text !== 'string' || !text.trim() || text.length > 20_000
      || !validId(revisionId)) throw new Error('Invalid memory correction.');
    const prior = this.memory.sources.database.prepare(`SELECT memory_id,version FROM memory_revisions
      WHERE revision_id=?`).get(revisionId) as { memory_id: string; version: number } | undefined;
    if (prior) {
      if (prior.memory_id !== id || prior.version !== expectedVersion + 1) {
        throw new Error('Correction request ID belongs to another memory revision.');
      }
      const saved = await this.ownedMemory(id);
      if (saved.version !== prior.version || saved.text !== text.trim()) {
        throw new Error('Correction was applied; refresh to see the latest version.');
      }
      return view(saved);
    }
    const current = await this.ownedMemory(id);
    if (current.version !== expectedVersion) throw new Error('Memory version conflict. Refresh before editing.');
    const saved = await this.memory.commit({ id, section: 'memories', kind: 'explicit',
      audience: personal, context: current.context, verifiedAt: new Date().toISOString(),
      text: text.trim(), evidence: [], dependsOn: [], manualAuthority: true,
      expectedVersion, revisionId, reason: 'User correction in Assistant panel' });
    return view(saved);
  }

  async forgetMemory(id: string): Promise<{ forgottenIds: string[] }> {
    if (!validId(id)) throw new Error('Invalid memory ID.');
    if (this.memory.sources.database.prepare(`SELECT 1 FROM forgotten_memories
      WHERE memory_id=?`).get(id)) {
      const pending = await this.memory.forget(id);
      return { forgottenIds: pending.length ? pending : [id] };
    }
    await this.ownedMemory(id);
    return { forgottenIds: await this.memory.forget(id) };
  }

  async importLegacySaved(savedId: string, surface: 'work' | 'assistant', text: string,
    savedAt: string): Promise<AssistantMemoryView> {
    if (typeof savedId !== 'string' || !savedId || savedId.length > 200
      || !['work', 'assistant'].includes(surface) || typeof text !== 'string'
      || !text.trim() || text.length > 20_000 || savedAt.length > 50
      || !Number.isFinite(Date.parse(savedAt))) {
      throw new Error('Invalid old saved item.');
    }
    const digest = createHash('sha256').update(`${surface}:${savedId}`).digest('hex').slice(0, 24);
    const id = `legacy-saved-${digest}`;
    const previous = await this.memory.get(id);
    if (previous) {
      if (previous.status !== 'active' || previous.audience.kind !== personal.kind
        || previous.audience.id !== personal.id || previous.text !== text.trim()) {
        throw new Error('Saved item changed after import.');
      }
      return view(previous);
    }
    const saved = await this.memory.commit({ id, section: 'memories', kind: 'explicit',
      audience: personal, context: `旧本地${surface === 'work' ? '工作' : '助理'}收藏（手动导入）`,
      verifiedAt: new Date().toISOString(), text: text.trim(), evidence: [], dependsOn: [],
      manualAuthority: true, expectedVersion: 0, revisionId: `legacy-import-${digest}`,
      reason: `User explicitly imported old local saved content saved at ${savedAt}` });
    return view(saved);
  }

  async followUpDelegation(taskId: string, text: string): Promise<AssistantDelegationRecord> {
    if (typeof text !== 'string' || !text.trim() || text.length > 16_000) {
      throw new Error('Invalid delegation follow-up.');
    }
    // The same task and exact follow-up text represent one user submission across UI reconnects.
    const requestId = createHash('sha256').update(`${taskId}:${text}`).digest('hex');
    return this.delegations.followUp(taskId, await this.delegationSession(taskId), text, requestId);
  }

  async cancelDelegation(taskId: string): Promise<AssistantDelegationRecord> {
    return this.delegations.cancel(taskId, await this.delegationSession(taskId));
  }
}
