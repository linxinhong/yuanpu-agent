import { createHash } from 'node:crypto';
import type { AssistantAudience, AssistantEvidenceRef, AssistantWorkReview } from '@yuanpu-agent/protocol';
import type { AssistantMemoryDocument, AssistantMemoryRepository,
  AssistantDocumentSection } from './memory-documents.js';
import type { AssistantWorkReviewStore } from './work-review.js';
import { redactReviewText } from './work-review.js';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24);
const audience = { kind: 'personal' as const, id: 'local-user' };

interface WorkRow { review_id: string; work_id: string; source_id: string;
  source_version: string; review_version: number }

async function write(memory: AssistantMemoryRepository, input: {
  id: string; section: AssistantDocumentSection; context: string; text: string;
  evidence: AssistantEvidenceRef[]; dependsOn?: string[]; status?: 'active' | 'withdrawn';
  verifiedAt: string; audience: AssistantAudience;
}): Promise<AssistantMemoryDocument | undefined> {
  const current = await memory.get(input.id);
  if (current?.manualAuthority) return current;
  if (!current && input.status === 'withdrawn') return undefined;
  const status = input.status ?? 'active';
  const dependsOn = input.dependsOn ?? [];
  if (current?.status === status && current.text === input.text
    && JSON.stringify(current.evidence) === JSON.stringify(input.evidence)
    && JSON.stringify(current.dependsOn) === JSON.stringify(dependsOn)) return current;
  return memory.commit({ ...input, dependsOn, kind: 'observed', manualAuthority: false,
    expectedVersion: current?.version ?? 0,
    revisionId: `work-organize-${digest(JSON.stringify([input.id, current?.version ?? 0,
      status, input.text,
      input.evidence, dependsOn]))}`, reason: 'Reconcile source-backed work organization', status });
}

function short(text: string, max = 500): string {
  return redactReviewText(text.replace(/\s+/gu, ' ').trim()).slice(0, max);
}

/** Deterministic assistant-owned Work index; review judgments never become completion proof. */
export class AssistantWorkOrganization {
  constructor(private readonly memory: AssistantMemoryRepository,
    private readonly reviews: AssistantWorkReviewStore) {}

  /** Minimal source scopes for an optional, read-only professional verification task. */
  verificationCandidates(): Array<{ candidateId: string; workId: string; reviewId: string;
    sourceId: string; sourceVersion: string; contextRefs: string[];
    completionCriterion: string;
    readOnly: true; authorizedCapabilities: [] }> {
    const rows = this.memory.sources.database.prepare(`SELECT review_id,work_id,source_id,
      source_version,review_version FROM work_reviews WHERE status='active'
      ORDER BY work_id,review_version DESC`).all() as unknown as WorkRow[];
    const seen = new Set<string>();
    const candidates = [];
    for (const row of rows) {
      if (seen.has(row.work_id)) continue;
      const review = this.reviews.get(row.review_id);
      if (!review || review.audience.kind !== 'personal' || review.audience.id !== 'local-user') continue;
      seen.add(row.work_id);
      if (review.judgment === 'supported') continue;
      const source = this.memory.sources.source(row.source_id);
      if (!source || source.sourceVersion !== row.source_version
        || source.availability !== 'available') continue;
      const goal = this.memory.sources.database.prepare(`SELECT e.source_id,c.source_version
        FROM source_events e JOIN source_current c ON c.source_id=e.source_id
          AND c.source_version=e.source_version
        WHERE e.work_id=? AND e.source_id LIKE 'work-turn:%' AND c.availability='available'
        ORDER BY e.rowid LIMIT 1`).get(row.work_id) as
        { source_id: string; source_version: string } | undefined;
      const contextRefs = [...new Set([goal?.source_id, row.source_id]
        .filter((item): item is string => Boolean(item)))];
      candidates.push({ candidateId: `follow-up-${digest(`work-project-${digest(row.work_id)}`)}`,
        workId: row.work_id, reviewId: row.review_id,
        sourceId: row.source_id, sourceVersion: row.source_version, contextRefs,
        completionCriterion: short(review.unresolved[0]
          ?? 'Verify the outstanding Work outcome from the authorized source.', 500),
        readOnly: true as const, authorizedCapabilities: [] as [] });
      if (candidates.length === 12) break;
    }
    return candidates;
  }

  async reconcile(): Promise<void> {
    const database = this.memory.sources.database;
    const rows = database.prepare(`SELECT review_id,work_id,source_id,source_version,review_version
      FROM work_reviews WHERE status='active' ORDER BY work_id,review_version DESC`)
      .all() as unknown as WorkRow[];
    const latest = new Map<string, { row: WorkRow; review: AssistantWorkReview }>();
    for (const row of rows) {
      if (latest.has(row.work_id)) continue;
      const review = this.reviews.get(row.review_id);
      if (review && review.audience.kind === audience.kind && review.audience.id === audience.id) {
        latest.set(row.work_id, { row, review });
      }
    }
    const projects: Array<{ id: string; review: AssistantWorkReview;
      ref: AssistantEvidenceRef }> = [];
    for (const [workId, { row, review }] of latest) {
      const source = this.memory.sources.source(row.source_id);
      if (!source || source.sourceVersion !== row.source_version
        || source.availability === 'deleted') continue;
      const event = database.prepare(`SELECT occurred_at FROM source_events WHERE source_id=?
        AND source_version=? ORDER BY rowid DESC LIMIT 1`)
        .get(row.source_id, row.source_version) as { occurred_at: string } | undefined;
      if (!event) continue;
      const ref = { sourceId: row.source_id, sourceVersion: row.source_version,
        observedAt: event.occurred_at };
      const id = `work-project-${digest(workId)}`;
      const lines = [`# Work ${workId}`, '', `Review: ${review.reviewId}`,
        `Assessment: ${review.judgment}`, `Goal as assessed: ${short(review.goal)}`,
        ...review.unresolved.slice(0, 8).map((item) => `Open: ${short(item)}`)];
      if (source.availability === 'temporarily_unavailable') {
        const current = await this.memory.get(id);
        if (current?.status !== 'active') continue;
      } else {
        await write(this.memory, { id, section: 'work', audience,
          context: `Current work state for ${workId}`, verifiedAt: ref.observedAt,
          text: lines.join('\n'), evidence: [ref] });
      }
      projects.push({ id, review, ref });
    }
    const known = database.prepare(`SELECT id FROM memory_documents
      WHERE id LIKE 'work-project-%' AND status='active'`).all() as Array<{ id: string }>;
    for (const { id } of known) if (!projects.some((item) => item.id === id)) {
      await write(this.memory, { id, section: 'work', audience,
        context: 'Work source no longer active', verifiedAt: new Date().toISOString(),
        text: '# Work withdrawn', evidence: [], status: 'withdrawn' });
    }
    projects.sort((left, right) => left.ref.observedAt.localeCompare(right.ref.observedAt)
      || left.id.localeCompare(right.id));
    const recent = projects.slice(-12);
    const verifiedAt = recent.at(-1)?.ref.observedAt ?? new Date().toISOString();
    const active = recent.length > 0 ? 'active' : 'withdrawn';
    await write(this.memory, { id: 'work-context', section: 'work', audience,
      context: 'Index of current Work projects', verifiedAt,
      text: ['# Work context', '', ...recent.map((item) =>
        `- ${item.id}: ${short(item.review.goal, 180)} [${item.review.judgment}]`)].join('\n'),
      evidence: [], dependsOn: recent.map((item) => item.id), status: active });
    const openProjects = projects.filter((item) => item.review.judgment !== 'supported');
    const focus = openProjects.slice(-12);
    await write(this.memory, { id: 'work-focus', section: 'work', audience,
      context: 'Open Work requiring attention', verifiedAt,
      text: ['# Work focus', '', ...focus.map((item) =>
        `- ${item.id}: ${short(item.review.goal, 180)} [${item.review.judgment}]`)].join('\n'),
      evidence: [], dependsOn: focus.map((item) => item.id),
      status: focus.length ? 'active' : 'withdrawn' });
    await this.commitments(projects);
    await this.followUps(openProjects);
  }

  private async commitments(projects: Array<{ id: string; review: AssistantWorkReview;
    ref: AssistantEvidenceRef }>): Promise<void> {
    const grouped = new Map<string, { id: string; text: string; refs: AssistantEvidenceRef[];
      projectId: string }>();
    for (const project of projects) {
      const turns = this.memory.sources.database.prepare(`SELECT e.source_id,e.source_version,e.occurred_at
        FROM source_events e JOIN source_current s ON s.source_id=e.source_id
          AND s.source_version=e.source_version
        WHERE e.work_id=? AND e.source_id LIKE 'work-turn:%' AND s.availability='available'
        GROUP BY e.source_id ORDER BY MAX(e.rowid) DESC LIMIT 25`)
        .all(project.review.workId) as Array<{ source_id: string; source_version: string;
          occurred_at: string }>;
      for (const turn of turns) {
        const ref = { sourceId: turn.source_id, sourceVersion: turn.source_version,
          observedAt: turn.occurred_at };
        const raw = this.memory.sources.sourceText(ref.sourceId, audience);
        const utterance = /^User:\s*([\s\S]*?)(?:\n\s*Assistant:|$)/u.exec(raw ?? '')?.[1];
        if (!utterance) continue;
        for (const sentence of utterance.split(/[。！？.!?\n]/u).map((item) => item.trim())) {
          if (!/^(?:我(?:会|将|计划|答应|承诺)|I (?:will|plan to|promise to)\b)/iu.test(sentence)) continue;
          const text = short(sentence, 240);
          if (!text || text.includes('[redacted')) continue;
          const id = `work-commitment-${digest(text.normalize('NFKC').toLocaleLowerCase('und'))}`;
          const entry = grouped.get(id) ?? { id, text, refs: [], projectId: project.id };
          if (!entry.refs.some((item) => item.sourceId === ref.sourceId
            && item.sourceVersion === ref.sourceVersion) && entry.refs.length < 24) entry.refs.push(ref);
          grouped.set(id, entry);
        }
      }
    }
    const entries = [...grouped.values()];
    for (const entry of entries) {
      entry.refs.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
      await write(this.memory, { id: entry.id, section: 'work', audience,
        context: `User-stated commitment in ${entry.projectId}`,
        verifiedAt: entry.refs.at(-1)!.observedAt,
        text: `# Commitment\n\nOwner: user\nUser said: ${entry.text}\nStatus: unverified`,
        evidence: entry.refs });
    }
    const known = this.memory.sources.database.prepare(`SELECT id FROM memory_documents
      WHERE id LIKE 'work-commitment-%' AND status='active'`).all() as Array<{ id: string }>;
    for (const { id } of known) if (!entries.some((item) => item.id === id)) {
      const current = await this.memory.get(id);
      const unavailableRef = current?.evidence.find((ref) =>
        this.memory.sources.source(ref.sourceId)?.availability === 'temporarily_unavailable');
      if (unavailableRef && current?.status === 'active') {
        entries.push({ id, text: '', refs: [unavailableRef], projectId: '' });
        continue;
      }
      await write(this.memory, { id, section: 'work', audience,
        context: 'Commitment source no longer active', verifiedAt: new Date().toISOString(),
        text: '# Commitment withdrawn', evidence: [], status: 'withdrawn' });
    }
    const indexed = entries.slice(-50);
    await write(this.memory, { id: 'work-commitments', section: 'work', audience,
      context: 'Index of explicit user commitments',
      verifiedAt: entries.at(-1)?.refs.at(-1)?.observedAt ?? new Date().toISOString(),
      text: ['# Commitments', '', ...indexed.map((item) => `- ${item.id}`),
        ...(entries.length > indexed.length ? [`- ${entries.length - indexed.length} older commitments retained in individual records`] : [])].join('\n'), evidence: [],
      dependsOn: indexed.map((item) => item.id),
      status: entries.length ? 'active' : 'withdrawn' });
  }

  private async followUps(projects: Array<{ id: string; review: AssistantWorkReview;
    ref: AssistantEvidenceRef }>): Promise<void> {
    const active = new Set<string>();
    for (const project of projects) {
      const id = `follow-up-${digest(project.id)}`;
      if (this.memory.sources.source(project.ref.sourceId)?.availability
        === 'temporarily_unavailable') {
        if ((await this.memory.get(id))?.status === 'active') active.add(id);
        continue;
      }
      active.add(id);
      const unresolved = project.review.unresolved.length
        ? project.review.unresolved : ['The Work outcome has not been verified.'];
      await write(this.memory, { id, section: 'suggestions', audience,
        context: `Private follow-up candidate for ${project.id}`,
        verifiedAt: project.ref.observedAt,
        text: ['# Follow-up candidate', '', `Project: ${project.id}`,
          `Review: ${project.review.reviewId}`,
          `Source: ${project.ref.sourceId} @ ${project.ref.sourceVersion}`,
          'Verification: read-only, no capabilities',
          'Delivery: candidate only', ...unresolved.slice(0, 5)
            .map((item) => `- ${short(item)}`)].join('\n'),
        evidence: [project.ref], dependsOn: [project.id] });
    }
    const known = this.memory.sources.database.prepare(`SELECT id FROM memory_documents
      WHERE id LIKE 'follow-up-%' AND status='active'`).all() as Array<{ id: string }>;
    for (const { id } of known) if (!active.has(id)) {
      await write(this.memory, { id, section: 'suggestions', audience,
        context: 'Follow-up candidate no longer current', verifiedAt: new Date().toISOString(),
        text: '# Follow-up withdrawn', evidence: [], status: 'withdrawn' });
    }
  }
}
