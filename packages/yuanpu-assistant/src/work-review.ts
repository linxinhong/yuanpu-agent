import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { stringify } from 'yaml';
import type { AssistantEvidenceRef, AssistantReviewJudgment, AssistantWorkReview } from '@yuanpu-agent/protocol';
import { assertSafeDirectory } from './home.js';
import type { AutomationJob } from './automation.js';
import type { AssistantSourceStore } from './memory-sources.js';

export interface WorkReviewMaterial {
  sourceId: string;
  sourceVersion: string;
  observedAt: string;
  kind: 'turn' | 'tool' | 'artifact' | 'delegation';
  text: string;
}

export interface WorkReviewSnapshot {
  workId: string;
  sourceId: string;
  sourceVersion: string;
  materials: WorkReviewMaterial[];
  unavailable: string[];
  truncated: boolean;
}

export interface WorkReviewProposal {
  goal: string;
  constraints: string[];
  judgment: AssistantReviewJudgment;
  findings: Array<{ claim: string; judgment: AssistantReviewJudgment; evidenceRefs: string[] }>;
  unresolved: string[];
  followUp: string[];
  memoryCandidates: string[];
  ledgerCandidates: string[];
}

interface ReviewRow {
  review_id: string;
  job_id: string;
  work_id: string;
  source_id: string;
  source_version: string;
  material_versions_json: string;
  review_version: number;
  review_json: string;
  proposal_json: string;
  status: 'active' | 'withdrawn';
  file_hash: string | null;
}

interface PendingRow {
  review_id: string;
  work_id: string;
  content: string;
  expected_hash: string | null;
  new_hash: string;
  authoritative: number;
}

const schema = `
  CREATE TABLE IF NOT EXISTS work_reviews (
    review_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE,
    work_id TEXT NOT NULL, source_id TEXT NOT NULL, source_version TEXT NOT NULL,
    material_versions_json TEXT NOT NULL,
    review_version INTEGER NOT NULL CHECK(review_version>0),
    review_json TEXT NOT NULL, proposal_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','withdrawn')),
    file_hash TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS work_reviews_source ON work_reviews(source_id,source_version);
  CREATE TABLE IF NOT EXISTS work_review_pending (
    review_id TEXT PRIMARY KEY REFERENCES work_reviews(review_id),
    work_id TEXT NOT NULL, content TEXT NOT NULL,
    expected_hash TEXT, new_hash TEXT NOT NULL,
    authoritative INTEGER NOT NULL DEFAULT 0 CHECK(authoritative IN (0,1))
  ) STRICT;
`;

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function audienceMatches(job: AutomationJob, kind: string, id: string): boolean {
  return job.audience.kind === kind && job.audience.id === id;
}

function safeText(value: unknown, limit: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit
    || /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value)) throw new Error(`Invalid review ${label}.`);
  return value.trim().replace(/\s+/gu, ' ');
}

function strings(value: unknown, count: number, length: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > count) throw new Error(`Invalid review ${label}.`);
  return value.map((item) => safeText(item, length, label));
}

/** Parse model output as a proposal, never as an authority over sources or completion. */
export function parseWorkReviewProposal(message: string): WorkReviewProposal {
  if (message.length > 12_000) throw new Error('Work review proposal exceeds budget.');
  const raw = JSON.parse(message) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || !['supported', 'partial', 'failed', 'unverified'].includes(String(raw.judgment))
    || !Array.isArray(raw.findings) || raw.findings.length > 12) {
    throw new Error('Invalid work review proposal.');
  }
  const findings = raw.findings.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid work review finding.');
    }
    const item = value as Record<string, unknown>;
    if (!['supported', 'partial', 'failed', 'unverified'].includes(String(item.judgment))) {
      throw new Error('Invalid work review finding judgment.');
    }
    return { claim: redact(safeText(item.claim, 1000, 'claim')),
      judgment: item.judgment as AssistantReviewJudgment,
      evidenceRefs: strings(item.evidenceRefs, 12, 256, 'evidence references') };
  });
  return { goal: redact(safeText(raw.goal, 2000, 'goal')),
    constraints: strings(raw.constraints, 12, 500, 'constraints').map(redact),
    judgment: raw.judgment as AssistantReviewJudgment, findings,
    unresolved: strings(raw.unresolved, 12, 1000, 'unresolved items').map(redact),
    followUp: strings(raw.followUp, 12, 1000, 'follow-up actions').map(redact),
    memoryCandidates: strings(raw.memoryCandidates, 8, 500, 'memory candidates').map(redact),
    ledgerCandidates: strings(raw.ledgerCandidates, 8, 500, 'ledger candidates').map(redact) };
}

export function redactReviewText(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
      '[redacted credential]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, '[redacted credential]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|glpat-[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/giu,
      '[redacted credential]')
    .replace(/\b(?:AIza[A-Za-z0-9_-]{20,}|(?:pk|sk|rk)_live_[A-Za-z0-9]{12,}|whsec_[A-Za-z0-9]{12,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/gu,
      '[redacted credential]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, '[redacted credential]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/giu, '[redacted credential]')
    .replace(/\b(api[_-]?key|password|secret|token|credential)\s*[:=]\s*\S+/giu,
      '$1: [redacted credential]')
    .replace(/\b(?=[A-Za-z0-9_+/-]{24,}\b)(?=[A-Za-z0-9_+/-]*[A-Za-z])(?=[A-Za-z0-9_+/-]*\d)[A-Za-z0-9_+/-]{24,}={0,2}\b/gu,
      '[redacted opaque token]');
}
const redact = redactReviewText;

/** A complete claim needs a host-verified artifact satisfying a literal user request. */
function exactWriteProof(snapshot: WorkReviewSnapshot,
  evidence: AssistantEvidenceRef[]): AssistantEvidenceRef[] | undefined {
  const turns = snapshot.materials.filter((item) => item.kind === 'turn');
  if (turns.length !== 1 || !turns[0]!.text.startsWith('User:')) return undefined;
  const instruction = /^User:\s*Write exactly `([^`\n]{1,1000})` to `([^`\n]{1,256})`\.\s*(?:\nAssistant:[^\n]*)?$/u
    .exec(turns[0]!.text);
  if (!instruction) return undefined;
  for (const ref of evidence) {
    const artifact = snapshot.materials.find((item) => item.sourceId === ref.sourceId
      && item.kind === 'artifact');
    if (!artifact) continue;
    const payload = /^Successful write payload for requested Work path ([^\n]+), run [^\n]+:\n([\s\S]*)$/u
      .exec(artifact.text);
    const suffix = artifact.sourceId.slice('work-artifact:'.length);
    const toolId = `work-tool:${suffix}`;
    const toolRef = evidence.find((item) => item.sourceId === toolId);
    if (payload !== null && payload[1] === instruction[2] && payload[2] === instruction[1]
      && toolRef && snapshot.materials.some((item) => item.sourceId === toolId
        && item.kind === 'tool' && item.text.startsWith('Tool write (completed)'))) {
      return [toolRef, ref];
    }
  }
  return undefined;
}

function workDirectory(workId: string): string {
  const raw = workId.startsWith('work:') ? workId.slice('work:'.length) : workId;
  return /^[A-Za-z0-9_-]{1,100}$/u.test(raw) ? raw : `work-${hash(workId).slice(0, 24)}`;
}

function render(review: AssistantWorkReview, proposal: WorkReviewProposal,
  sourceVersion: string, materialVersions: Array<{ sourceId: string; sourceVersion: string }>,
  status: 'active' | 'withdrawn'): string {
  if (status === 'withdrawn') {
    return `---\n${stringify({ reviewId: review.reviewId, workId: review.workId,
      status, reviewVersion: review.reviewVersion }).trimEnd()}\n---\n\nSource withdrawn.\n`;
  }
  const metadata = { reviewId: review.reviewId, workId: review.workId,
    reviewVersion: review.reviewVersion, sourceVersion, materialVersions, status,
    judgment: review.judgment, evidence: review.findings.flatMap((finding) => finding.evidence),
    committedLedgerRevisionIds: review.committedLedgerRevisionIds,
    committedMemoryRevisionIds: review.committedMemoryRevisionIds, createdAt: review.createdAt };
  const lines = [`# Work review`, '', `Goal: ${redact(review.goal)}`, '',
    `Judgment: ${review.judgment}`, '', '## Constraints',
    ...review.constraints.map((item) => `- ${redact(item)}`), '', '## Findings'];
  for (const finding of review.findings) {
    lines.push(`- ${finding.judgment}: ${redact(finding.claim)}`);
    for (const ref of finding.evidence) lines.push(`  - Evidence: ${ref.sourceId} @ ${ref.sourceVersion}`);
  }
  lines.push('', '## Unresolved', ...review.unresolved.map((item) => `- ${redact(item)}`),
    '', '## Follow-up candidates', ...review.followUp.map((item) => `- ${redact(item)}`),
    '', '## Memory candidates', ...proposal.memoryCandidates.map((item) => `- ${redact(item)}`),
    '', '## Ledger candidates', ...proposal.ledgerCandidates.map((item) => `- ${redact(item)}`),
    '', 'No ledger or memory revision has been committed by this review.');
  return `---\n${stringify(metadata).trimEnd()}\n---\n\n${lines.join('\n')}\n`;
}

function withUnavailable(review: AssistantWorkReview, unavailable: Set<string>): AssistantWorkReview {
  return { ...review, judgment: 'unverified',
    findings: review.findings.map((finding) => finding.evidence.some((ref) =>
      unavailable.has(ref.sourceId)) ? { ...finding, judgment: 'unverified' } : finding),
    unresolved: [...review.unresolved, 'Some supporting material is temporarily unavailable.'] };
}

/** Single-Worker review ledger. The SQLite intent survives a crash before its Markdown materializes. */
export class AssistantWorkReviewStore {
  constructor(private readonly database: DatabaseSync, private readonly sources: AssistantSourceStore,
    private readonly assistantHome: string) { database.exec(schema); }

  snapshot(job: AutomationJob): WorkReviewSnapshot | undefined {
    if (job.kind !== 'review-work' || !job.sourceId || !job.sourceVersion) return undefined;
    const event = this.database.prepare(`SELECT work_id,audience_kind,audience_id FROM source_events
      WHERE source_id=? AND source_version=? AND work_id IS NOT NULL ORDER BY rowid DESC LIMIT 1`)
      .get(job.sourceId, job.sourceVersion) as
      { work_id: string; audience_kind: string; audience_id: string } | undefined;
    if (!event || !audienceMatches(job, event.audience_kind, event.audience_id)) return undefined;
    const current = this.sources.source(job.sourceId);
    if (!current || current.sourceVersion !== job.sourceVersion || current.availability !== 'available'
      || !audienceMatches(job, current.audience.kind, current.audience.id)) return undefined;
    const rows = this.database.prepare(`SELECT e.source_id,e.occurred_at,c.source_version,c.availability,
      c.audience_kind,c.audience_id,t.text FROM source_events e
      JOIN source_current c ON c.source_id=e.source_id
      LEFT JOIN source_text t ON t.source_id=e.source_id AND t.source_version=c.source_version
      WHERE e.work_id=? AND e.kind!='deleted' AND e.source_version=c.source_version
      GROUP BY e.source_id ORDER BY MAX(e.rowid) DESC LIMIT 25`)
      .all(event.work_id) as Array<{ source_id: string; occurred_at: string;
        source_version: string; availability: string; audience_kind: string;
        audience_id: string; text: string | null }>;
    const materials: WorkReviewMaterial[] = [];
    const unavailable: string[] = [];
    let characters = 0;
    let truncated = false;
    for (const row of rows.reverse()) {
      if (!audienceMatches(job, row.audience_kind, row.audience_id)) continue;
      if (row.availability !== 'available' || row.text === null) {
        unavailable.push(row.source_id);
        continue;
      }
      if (materials.length >= 16 || characters >= 24_000) { truncated = true; continue; }
      const text = row.text.slice(0, Math.min(4_000, 24_000 - characters));
      if (text.length < row.text.length) truncated = true;
      characters += text.length;
      const kind = row.source_id.startsWith('work-artifact:') ? 'artifact'
        : row.source_id.startsWith('work-tool:') ? 'tool'
          : row.source_id.startsWith('delegation:') ? 'delegation' : 'turn';
      materials.push({ sourceId: row.source_id, sourceVersion: row.source_version,
        observedAt: row.occurred_at, kind, text });
    }
    return { workId: event.work_id, sourceId: job.sourceId, sourceVersion: job.sourceVersion,
      materials, unavailable, truncated: truncated || rows.length === 25 };
  }

  record(job: AutomationJob, snapshot: WorkReviewSnapshot, proposal: WorkReviewProposal,
    commit: (write: () => void) => boolean, recordCheckpoint: (snapshot: unknown) => void): boolean {
    if (job.kind !== 'review-work' || job.sourceId !== snapshot.sourceId
      || job.sourceVersion !== snapshot.sourceVersion) throw new Error('Review source changed.');
    const current = this.sources.source(job.sourceId!);
    if (!current || current.sourceVersion !== job.sourceVersion || current.availability !== 'available'
      || !audienceMatches(job, current.audience.kind, current.audience.id)) {
      throw new Error('Review source is no longer available.');
    }
    const known = new Map(snapshot.materials.map((item) => [item.sourceId, item]));
    const findings = proposal.findings.map((item) => {
      const evidence: AssistantEvidenceRef[] = item.evidenceRefs.map((id) => {
        const material = known.get(id);
        if (!material) throw new Error('Review proposed an unknown evidence reference.');
        const source = this.sources.source(id);
        if (!source || source.sourceVersion !== material.sourceVersion
          || source.availability !== 'available'
          || !audienceMatches(job, source.audience.kind, source.audience.id)) {
          throw new Error('Review evidence changed before commit.');
        }
        return { sourceId: id, sourceVersion: material.sourceVersion,
          observedAt: material.observedAt };
      });
      const exactProof = exactWriteProof(snapshot, evidence);
      const failedTool = evidence.some((ref) => {
        const material = known.get(ref.sourceId);
        return material?.kind === 'tool' && /\(failed\)/u.test(material.text);
      });
      const successfulTool = evidence.some((ref) => {
        const material = known.get(ref.sourceId);
        return material?.kind === 'tool' && /\(completed\)/u.test(material.text);
      });
      let judgment = item.judgment;
      if (judgment === 'supported' && !exactProof) judgment = successfulTool ? 'partial' : 'unverified';
      if (judgment === 'partial' && !successfulTool) judgment = 'unverified';
      if (judgment === 'failed' && !failedTool) judgment = 'unverified';
      if (judgment === 'supported' && exactProof) {
        return { claim: 'The exact text requested by the user was written to the requested Work path.',
          judgment, evidence: exactProof };
      }
      return { claim: judgment === 'partial' ? 'A successful tool step was observed; the full goal is not verified.'
        : judgment === 'failed' ? 'A tool step failed; the full goal is not verified.'
          : redact(item.claim), judgment, evidence };
    });
    let judgment = proposal.judgment;
    const hasGoalSource = snapshot.materials.some((item) => item.kind === 'turn'
      && item.text.startsWith('User:'));
    if (!hasGoalSource) judgment = 'unverified';
    if (judgment === 'supported' && (!findings.length || snapshot.unavailable.length
      || snapshot.truncated || proposal.unresolved.length)) {
      judgment = 'unverified';
    }
    if (judgment === 'supported' && findings.some((finding) =>
      finding.judgment !== 'supported')) {
      judgment = findings.some((finding) => finding.judgment === 'partial')
        ? 'partial' : 'unverified';
    }
    if (judgment === 'supported' && proposal.constraints.length) judgment = 'unverified';
      if (judgment === 'partial' && !findings.some((finding) =>
      finding.judgment === 'supported' || finding.judgment === 'partial')) judgment = 'unverified';
    if (judgment === 'failed' && !findings.some((finding) => finding.judgment === 'failed')) {
      judgment = 'unverified';
    }
    if (judgment === 'failed' && snapshot.materials.some((item) => item.kind === 'tool'
      && /\(completed\)/u.test(item.text))) judgment = 'partial';
    const reviewId = `review-${hash(`${job.jobId}:${snapshot.workId}`).slice(0, 24)}`;
    const latest = this.database.prepare('SELECT MAX(review_version) AS version FROM work_reviews WHERE work_id=?')
      .get(snapshot.workId) as { version: number | null };
    const review: AssistantWorkReview = { reviewId, workId: snapshot.workId,
      reviewVersion: (latest.version ?? 0) + 1,
      audience: job.audience, goal: redact(judgment === 'supported'
        ? snapshot.materials.find((item) => item.kind === 'turn' && item.text.startsWith('User:'))!
          .text.split('\nAssistant:')[0]!.slice('User:'.length).trim()
        : proposal.goal),
      constraints: proposal.constraints.map(redact), judgment, findings,
      unresolved: [...proposal.unresolved.map(redact),
        ...(snapshot.unavailable.length ? ['Some source material is temporarily unavailable.'] : []),
        ...(snapshot.truncated ? ['The material snapshot was truncated.'] : [])],
      followUp: proposal.followUp.map(redact), committedLedgerRevisionIds: [],
      committedMemoryRevisionIds: [], createdAt: new Date().toISOString() };
    const materialVersions = snapshot.materials.map((item) => ({ sourceId: item.sourceId,
      sourceVersion: item.sourceVersion }));
    const content = render(review, proposal, snapshot.sourceVersion, materialVersions, 'active');
    const newHash = hash(content);
    return commit(() => {
      // Recheck inside the Engine's completion transaction, after foreground/version gates.
      const version = this.sources.source(job.sourceId!);
      if (!version || version.sourceVersion !== job.sourceVersion || version.availability !== 'available') {
        throw new Error('Review source changed during commit.');
      }
      this.database.prepare(`INSERT INTO work_reviews(review_id,job_id,work_id,source_id,
        source_version,material_versions_json,review_version,review_json,proposal_json,status,file_hash)
        VALUES (?,?,?,?,?,?,?,?,?,'active',NULL)
        ON CONFLICT(job_id) DO NOTHING`).run(reviewId, job.jobId, snapshot.workId,
          job.sourceId!, job.sourceVersion!, JSON.stringify(materialVersions),
          review.reviewVersion, JSON.stringify(review), JSON.stringify({
            memoryCandidates: proposal.memoryCandidates.map(redact),
            ledgerCandidates: proposal.ledgerCandidates.map(redact) }));
      this.database.prepare(`INSERT OR IGNORE INTO work_review_pending
        (review_id,work_id,content,expected_hash,new_hash) VALUES (?,?,?,?,?)`)
        .run(reviewId, snapshot.workId, content, null, newHash);
      recordCheckpoint({ reviewId, workId: snapshot.workId, sourceVersion: snapshot.sourceVersion });
    });
  }

  get(reviewId: string): AssistantWorkReview | undefined {
    const row = this.database.prepare('SELECT * FROM work_reviews WHERE review_id=?')
      .get(reviewId) as ReviewRow | undefined;
    if (row?.status !== 'active') return undefined;
    const review = JSON.parse(row.review_json) as AssistantWorkReview;
    const materials = JSON.parse(row.material_versions_json) as Array<{
      sourceId: string; sourceVersion: string }>;
    const refs = [{ sourceId: row.source_id, sourceVersion: row.source_version }, ...materials];
    if (refs.some((item) => {
      const source = this.sources.source(item.sourceId);
      return !source || source.sourceVersion !== item.sourceVersion
        || source.availability === 'deleted' || this.sources.isForgotten(item.sourceId);
    })) return undefined;
    const unavailable = new Set(refs.filter((item) =>
      this.sources.source(item.sourceId)?.availability === 'temporarily_unavailable')
      .map((item) => item.sourceId));
    if (unavailable.size) return withUnavailable(review, unavailable);
    return review;
  }

  private file(workId: string, reviewId: string): string {
    if (!/^review-[a-f0-9]{24}$/u.test(reviewId)) throw new Error('Invalid review ID.');
    return join(this.assistantHome, 'reviews', workDirectory(workId), `${reviewId}.md`);
  }

  async flushPending(): Promise<void> {
    const root = join(this.assistantHome, 'reviews');
    await assertSafeDirectory(root);
    const rows = this.database.prepare('SELECT * FROM work_review_pending ORDER BY rowid')
      .all() as unknown as PendingRow[];
    for (const row of rows) {
      const directory = join(root, workDirectory(row.work_id));
      await assertSafeDirectory(directory);
      const path = this.file(row.work_id, row.review_id);
      let existing: string | undefined;
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe review file.');
        existing = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const oldHash = existing === undefined ? null : hash(existing);
      if (oldHash !== row.new_hash) {
        if (oldHash !== row.expected_hash && row.authoritative !== 1) {
          throw new Error('Review file changed outside the ledger.');
        }
        const temporary = `${path}.${randomUUID()}.tmp`;
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try { await file.writeFile(row.content); await file.sync(); }
        finally { await file.close(); }
        try { await rename(temporary, path); }
        finally { await rm(temporary, { force: true }); }
        const dir = await open(directory, constants.O_RDONLY);
        try { await dir.sync(); } finally { await dir.close(); }
      }
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.database.prepare('UPDATE work_reviews SET file_hash=? WHERE review_id=?')
          .run(row.new_hash, row.review_id);
        this.database.prepare('DELETE FROM work_review_pending WHERE review_id=?').run(row.review_id);
        this.database.exec('COMMIT');
      } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    }
  }

  /** Remove conclusions and evidence if any supporting source was withdrawn or superseded. */
  async reconcileSources(): Promise<void> {
    await this.flushPending();
    const rows = this.database.prepare("SELECT * FROM work_reviews WHERE status='active'")
      .all() as unknown as ReviewRow[];
    for (const row of rows) {
      const review = JSON.parse(row.review_json) as AssistantWorkReview;
      const refs = [{ sourceId: row.source_id, sourceVersion: row.source_version },
        ...JSON.parse(row.material_versions_json) as Array<{ sourceId: string; sourceVersion: string }>];
      const stale = refs.some((ref) => {
        const source = this.sources.source(ref.sourceId);
        const expected = ref.sourceVersion;
        return !source || source.availability === 'deleted' || source.sourceVersion !== expected
          || this.sources.isForgotten(ref.sourceId);
      });
      if (!stale) {
        const unavailable = new Set(refs.filter((ref) =>
          this.sources.source(ref.sourceId)?.availability === 'temporarily_unavailable')
          .map((ref) => ref.sourceId));
        const visible = unavailable.size ? withUnavailable(review, unavailable) : review;
        const saved = JSON.parse(row.proposal_json) as { memoryCandidates: string[];
          ledgerCandidates: string[] };
        const proposal: WorkReviewProposal = { goal: visible.goal, constraints: visible.constraints,
          judgment: visible.judgment, findings: [], unresolved: visible.unresolved,
          followUp: visible.followUp, memoryCandidates: saved.memoryCandidates,
          ledgerCandidates: saved.ledgerCandidates };
        const content = render(visible, proposal, row.source_version,
          refs.slice(1), 'active');
        if (hash(content) !== row.file_hash) {
          this.database.prepare(`INSERT INTO work_review_pending
            (review_id,work_id,content,expected_hash,new_hash,authoritative) VALUES (?,?,?,?,?,1)
            ON CONFLICT(review_id) DO UPDATE SET content=excluded.content,
              expected_hash=excluded.expected_hash,new_hash=excluded.new_hash,authoritative=1`)
            .run(row.review_id, row.work_id, content, row.file_hash, hash(content));
        }
        continue;
      }
      const withdrawn: AssistantWorkReview = { ...review, reviewVersion: review.reviewVersion + 1,
        goal: '', constraints: [], judgment: 'unverified', findings: [], unresolved: [],
        followUp: [], committedLedgerRevisionIds: [], committedMemoryRevisionIds: [] };
      const content = render(withdrawn, { goal: 'withdrawn', constraints: [],
        judgment: 'unverified', findings: [], unresolved: [], followUp: [],
        memoryCandidates: [], ledgerCandidates: [] }, row.source_version, [], 'withdrawn');
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.database.prepare(`UPDATE work_reviews SET review_json=?,proposal_json='{}',review_version=?,
          status='withdrawn' WHERE review_id=?`)
          .run(JSON.stringify(withdrawn), withdrawn.reviewVersion, row.review_id);
        this.database.prepare(`INSERT INTO work_review_pending
          (review_id,work_id,content,expected_hash,new_hash,authoritative) VALUES (?,?,?,?,?,1)
          ON CONFLICT(review_id) DO UPDATE SET content=excluded.content,
            expected_hash=excluded.expected_hash,new_hash=excluded.new_hash,authoritative=1`)
          .run(row.review_id, row.work_id, content, row.file_hash, hash(content));
        this.database.exec('COMMIT');
      } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    }
    await this.flushPending();
  }
}
