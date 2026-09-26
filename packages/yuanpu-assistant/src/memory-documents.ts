import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parse, stringify } from 'yaml';
import type { AssistantAudience, AssistantEvidenceRef } from '@yuanpu-agent/protocol';
import { assertSafeDirectory, resolveAssistantHome } from './home.js';
import { AssistantSourceStore, searchTerms, type AssistantSourceHost,
  type QueuedSource, type SourceSearchHit } from './memory-sources.js';

export type AssistantDocumentSection = 'memories' | 'work' | 'reviews' | 'suggestions';
export type AssistantKnowledgeKind = 'explicit' | 'observed' | 'inferred';

export interface AssistantMemoryDocument {
  id: string;
  version: number;
  section: AssistantDocumentSection;
  kind: AssistantKnowledgeKind;
  audience: AssistantAudience;
  context: string;
  verifiedAt: string;
  text: string;
  evidence: AssistantEvidenceRef[];
  dependsOn: string[];
  status: 'active' | 'withdrawn';
  manualAuthority: boolean;
}

export interface AssistantMemoryDraft extends Omit<AssistantMemoryDocument, 'version' | 'status'> {
  expectedVersion: number;
  revisionId: string;
  reason: string;
  status?: AssistantMemoryDocument['status'];
}

export interface AssistantMemorySearchHit {
  document: AssistantMemoryDocument;
  evidenceStatus: Array<{ ref: AssistantEvidenceRef;
    availability: SourceSearchHit['availability'] | 'unknown' }>;
}

interface PendingWrite {
  revision_id: string;
  memory_id: string;
  path: string;
  expected_hash: string | null;
  new_hash: string;
  new_content: string;
  document_json: string;
  reason: string;
}

const documentSchema = `
  CREATE TABLE IF NOT EXISTS memory_documents (
    id TEXT PRIMARY KEY, section TEXT NOT NULL, kind TEXT NOT NULL,
    audience_kind TEXT NOT NULL, audience_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    file_hash TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','withdrawn')),
    manual_authority INTEGER NOT NULL CHECK (manual_authority IN (0,1))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS memory_evidence (
    memory_id TEXT NOT NULL REFERENCES memory_documents(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL, source_version TEXT NOT NULL,
    locator TEXT, observed_at TEXT NOT NULL,
    PRIMARY KEY (memory_id,source_id,source_version)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS memory_dependencies (
    parent_id TEXT NOT NULL, child_id TEXT NOT NULL REFERENCES memory_documents(id) ON DELETE CASCADE,
    PRIMARY KEY (parent_id,child_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS memory_revisions (
    revision_id TEXT PRIMARY KEY, memory_id TEXT NOT NULL,
    version INTEGER NOT NULL, operation TEXT NOT NULL,
    reason TEXT NOT NULL, content TEXT, committed_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS memory_pending_writes (
    revision_id TEXT PRIMARY KEY, memory_id TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL, expected_hash TEXT, new_hash TEXT NOT NULL,
    new_content TEXT NOT NULL, document_json TEXT NOT NULL, reason TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS forgotten_memories (
    memory_id TEXT PRIMARY KEY, forgotten_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS memory_forget_jobs (
    memory_id TEXT PRIMARY KEY, section TEXT NOT NULL,
    source_ids_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS memory_search_terms (
    term TEXT NOT NULL, memory_id TEXT NOT NULL REFERENCES memory_documents(id) ON DELETE CASCADE,
    PRIMARY KEY (term,memory_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS memory_import_conflicts (
    memory_id TEXT NOT NULL, source_id TEXT NOT NULL, source_version TEXT NOT NULL,
    detected_at TEXT NOT NULL, reason TEXT NOT NULL,
    PRIMARY KEY (memory_id,source_id,source_version)
  ) STRICT;
`;

function digest(content: string): string { return createHash('sha256').update(content).digest('hex'); }
function validId(id: string): boolean { return /^[a-z][a-z0-9_-]{0,127}$/.test(id); }
function sameAudience(left: AssistantAudience, right: AssistantAudience): boolean {
  return left.kind === right.kind && left.id === right.id;
}
function normalize(text: string): string { return text.normalize('NFKC').toLocaleLowerCase('und'); }

function validateDocument(document: AssistantMemoryDocument): void {
  if (!validId(document.id)) throw new Error('Invalid memory document ID.');
  if (!['memories', 'work', 'reviews', 'suggestions'].includes(document.section)) {
    throw new Error('Invalid memory document section.');
  }
  if (!['explicit', 'observed', 'inferred'].includes(document.kind)) {
    throw new Error('Invalid memory knowledge kind.');
  }
  if (!['personal', 'conversation', 'organization'].includes(document.audience.kind)
    || !document.audience.id || document.audience.id.length > 256) {
    throw new Error('Invalid memory audience.');
  }
  if (!Number.isSafeInteger(document.version) || document.version < 1
    || !document.context.trim() || document.context.length > 1000
    || !Number.isFinite(Date.parse(document.verifiedAt))
    || !document.text.trim() || document.text.length > 20_000
    || /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(document.text)) {
    throw new Error('Invalid memory document content.');
  }
  if (document.evidence.length > 100 || document.dependsOn.length > 100) {
    throw new Error('Memory document references exceed budget.');
  }
  for (const ref of document.evidence) {
    if (!ref.sourceId || !ref.sourceVersion || !Number.isFinite(Date.parse(ref.observedAt))) {
      throw new Error('Invalid memory evidence reference.');
    }
  }
  for (const id of document.dependsOn) if (!validId(id) || id === document.id) {
    throw new Error('Invalid memory dependency.');
  }
}

function render(document: AssistantMemoryDocument): string {
  const { text, ...metadata } = document;
  return `---\n${stringify(metadata).trimEnd()}\n---\n\n${text.trim()}\n`;
}

function parseDocument(content: string): AssistantMemoryDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n\r?\n([\s\S]*)$/u.exec(content);
  if (!match) throw new Error('Invalid memory Markdown frontmatter.');
  const metadata: unknown = parse(match[1] ?? '');
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Invalid memory Markdown metadata.');
  }
  const document = { ...metadata, text: (match[2] ?? '').trim() } as AssistantMemoryDocument;
  validateDocument(document);
  return document;
}

async function existingContent(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Memory path is not a real file.');
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function atomicReplace(path: string, expectedHash: string | null, content: string): Promise<void> {
  const current = await existingContent(path);
  if ((current === undefined ? null : digest(current)) !== expectedHash) {
    throw new Error('Memory file changed while a revision was pending.');
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally { await file.close(); }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

/** Uses the Assistant Home single writer; SQLite intent makes a file/DB crash replayable. */
export class AssistantMemoryRepository {
  private readonly database: DatabaseSync;
  private readonly root: string;
  private constructor(readonly sources: AssistantSourceStore, assistantHome: string) {
    this.database = sources.database;
    this.root = resolveAssistantHome(assistantHome).root;
    this.database.exec(documentSchema);
  }

  static async open(assistantHome: string): Promise<AssistantMemoryRepository> {
    const sources = await AssistantSourceStore.open(assistantHome);
    try {
      const repo = new AssistantMemoryRepository(sources, assistantHome);
      for (const section of ['memories', 'work', 'reviews', 'suggestions'] as const) {
        await assertSafeDirectory(join(repo.root, section));
        await assertSafeDirectory(join(repo.root, section, 'notes'));
      }
      await repo.recoverForgetJobs();
      await repo.recoverPending();
      await repo.reconcileDeletedSources();
      return repo;
    } catch (error) { sources.close(); throw error; }
  }

  private path(section: AssistantDocumentSection, id: string): string {
    if (!validId(id)) throw new Error('Invalid memory document ID.');
    if (section === 'memories' && id === 'user-summary') return join(this.root, 'memories', 'USER.md');
    if (section === 'memories' && id === 'core-memory') return join(this.root, 'memories', 'MEMORY.md');
    if (section === 'memories' && id === 'collaboration') {
      return join(this.root, 'memories', 'collaboration.md');
    }
    const userTopics = new Set(['background', 'interests', 'hobbies', 'values', 'goals',
      'working-style', 'thinking-style', 'preferences']);
    if (section === 'memories' && id.startsWith('user-')
      && userTopics.has(id.slice('user-'.length))) {
      return join(this.root, 'memories', 'user', `${id.slice('user-'.length)}.md`);
    }
    if (section === 'memories' && ['knowledge', 'experiences'].includes(id.slice('user-'.length))
      && id.startsWith('user-')) {
      return join(this.root, 'memories', 'knowledge', `${id.slice('user-'.length)}.md`);
    }
    const workFiles: Record<string, string> = { 'work-context': 'context.md',
      'work-focus': 'focus.md', 'work-commitments': 'commitments.md',
      'work-user-context': 'user-context.md' };
    if (section === 'work' && workFiles[id]) return join(this.root, 'work', workFiles[id]);
    if (section === 'work' && /^work-project-[a-z0-9][a-z0-9_-]*$/u.test(id)) {
      return join(this.root, 'work', 'projects', `${id.slice('work-project-'.length)}.md`);
    }
    if (section === 'work' && /^work-commitment-[a-f0-9]{24}$/u.test(id)) {
      return join(this.root, 'work', 'commitments', `${id.slice('work-commitment-'.length)}.md`);
    }
    if (section === 'suggestions' && /^follow-up-[a-f0-9]{24}$/u.test(id)) {
      return join(this.root, 'suggestions', 'follow-ups', `${id.slice('follow-up-'.length)}.md`);
    }
    return join(this.root, section, 'notes', `${id}.md`);
  }

  private row(id: string): Record<string, unknown> | undefined {
    return this.database.prepare('SELECT * FROM memory_documents WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
  }

  private indexDocument(document: AssistantMemoryDocument): void {
    this.database.prepare('DELETE FROM memory_search_terms WHERE memory_id = ?').run(document.id);
    if (document.status === 'active') for (const term of searchTerms(`${document.context} ${document.text}`)) {
      this.database.prepare('INSERT OR IGNORE INTO memory_search_terms(term,memory_id) VALUES (?,?)')
        .run(term, document.id);
    }
  }

  async processNext(host: AssistantSourceHost, retryUnavailable = false): Promise<QueuedSource | undefined> {
    const event = await this.sources.processNext(host, retryUnavailable);
    if (event?.status === 'processed') {
      const source = this.sources.source(event.change.sourceId);
      if (source && (source.availability === 'deleted' || this.database.prepare(`SELECT 1 FROM memory_evidence
        WHERE source_id=? AND source_version!=? LIMIT 1`).get(event.change.sourceId,
          source.sourceVersion))) {
        await this.withdrawSource(event.change.sourceId);
      }
    }
    return event;
  }

  async reconcileDeletedSources(): Promise<void> {
    const rows = this.database.prepare(`SELECT DISTINCT e.source_id FROM memory_evidence e
      JOIN source_current s ON s.source_id=e.source_id
      WHERE s.availability='deleted' OR (s.availability='available'
        AND e.source_version!=s.source_version)`)
      .all() as Array<{ source_id: string }>;
    for (const row of rows) await this.withdrawSource(row.source_id);
    await this.reconcileDependentWithdrawals();
  }

  private async reconcileDependentWithdrawals(): Promise<void> {
    const rows = this.database.prepare(`SELECT id FROM memory_documents WHERE status='active'`)
      .all() as Array<{ id: string }>;
    for (const row of rows) {
      const document = await this.get(row.id);
      if (!document || document.status !== 'active' || document.manualAuthority
        || document.evidence.length || !document.dependsOn.length) continue;
      const parents = await Promise.all(document.dependsOn.map((id) => this.get(id)));
      if (parents.some((parent) => parent?.status === 'active')) continue;
      await this.commitInternal({ ...document, expectedVersion: document.version,
        revisionId: randomUUID(), status: 'withdrawn',
        reason: 'All supporting memories were withdrawn' }, true);
    }
  }

  private finalize(pending: PendingWrite): AssistantMemoryDocument {
    const document = JSON.parse(pending.document_json) as AssistantMemoryDocument;
    const current = this.row(document.id);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`INSERT INTO memory_documents(id,section,kind,audience_kind,audience_id,
        version,file_hash,status,manual_authority) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET section=excluded.section,kind=excluded.kind,
        audience_kind=excluded.audience_kind,audience_id=excluded.audience_id,
        version=excluded.version,file_hash=excluded.file_hash,status=excluded.status,
        manual_authority=excluded.manual_authority`).run(document.id, document.section, document.kind,
          document.audience.kind, document.audience.id, document.version, pending.new_hash,
          document.status, document.manualAuthority ? 1 : 0);
      this.database.prepare('DELETE FROM memory_evidence WHERE memory_id = ?').run(document.id);
      for (const ref of document.evidence) this.database.prepare(`INSERT INTO memory_evidence
        (memory_id,source_id,source_version,locator,observed_at) VALUES (?,?,?,?,?)`)
        .run(document.id, ref.sourceId, ref.sourceVersion, ref.locator ?? null, ref.observedAt);
      this.database.prepare('DELETE FROM memory_dependencies WHERE child_id = ?').run(document.id);
      for (const id of document.dependsOn) this.database.prepare(`INSERT INTO memory_dependencies(parent_id,child_id)
        VALUES (?,?)`).run(id, document.id);
      this.database.prepare(`INSERT OR IGNORE INTO memory_revisions(revision_id,memory_id,version,
        operation,reason,content,committed_at) VALUES (?,?,?,?,?,?,?)`).run(pending.revision_id,
          document.id, document.version, current ? 'correct' : 'create', pending.reason,
          pending.new_content, new Date().toISOString());
      this.indexDocument(document);
      this.database.prepare('DELETE FROM memory_pending_writes WHERE revision_id = ?')
        .run(pending.revision_id);
      this.database.exec('COMMIT');
      return document;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  private async completePending(pending: PendingWrite): Promise<AssistantMemoryDocument> {
    const current = await existingContent(pending.path);
    const hash = current === undefined ? null : digest(current);
    if (hash !== pending.new_hash) {
      if (hash !== pending.expected_hash) {
        throw new Error(`Pending memory revision conflicts with manual edit: ${pending.memory_id}`);
      }
      await atomicReplace(pending.path, pending.expected_hash, pending.new_content);
    }
    return this.finalize(pending);
  }

  async recoverPending(): Promise<void> {
    const rows = this.database.prepare('SELECT * FROM memory_pending_writes ORDER BY rowid')
      .all() as unknown as PendingWrite[];
    for (const row of rows) await this.completePending(row);
  }

  /** A direct file edit becomes a higher-version human revision before any automatic CAS. */
  async get(id: string): Promise<AssistantMemoryDocument | undefined> {
    if (this.database.prepare('SELECT 1 FROM forgotten_memories WHERE memory_id = ?').get(id)) {
      return undefined;
    }
    const row = this.row(id);
    if (!row) return undefined;
    const path = this.path(row.section as AssistantDocumentSection, id);
    await assertSafeDirectory(dirname(path));
    const content = await existingContent(path);
    if (content === undefined) throw new Error(`Memory file is missing: ${id}`);
    const parsed = parseDocument(content);
    if (parsed.id !== id || parsed.section !== row.section
      || !sameAudience(parsed.audience, { kind: row.audience_kind as AssistantAudience['kind'],
        id: String(row.audience_id) })) {
      throw new Error(`Memory file identity changed: ${id}`);
    }
    if (digest(content) === row.file_hash) return parsed;
    const prior = this.database.prepare(`SELECT content FROM memory_revisions WHERE memory_id = ?
      ORDER BY version DESC LIMIT 1`).get(id) as { content: string | null } | undefined;
    if (prior?.content) {
      const recorded = parseDocument(prior.content);
      if (JSON.stringify(parsed.evidence) !== JSON.stringify(recorded.evidence)
        || JSON.stringify(parsed.dependsOn) !== JSON.stringify(recorded.dependsOn)
        || parsed.status !== recorded.status) {
        throw new Error(`Memory file references changed outside the revision API: ${id}`);
      }
    }
    parsed.version = Number(row.version) + 1;
    parsed.manualAuthority = true;
    const normalized = render(parsed);
    await atomicReplace(path, digest(content), normalized);
    const hash = digest(normalized);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('UPDATE memory_documents SET version=?,file_hash=?,manual_authority=1 WHERE id=?')
        .run(parsed.version, hash, id);
      this.database.prepare(`INSERT INTO memory_revisions(revision_id,memory_id,version,operation,
        reason,content,committed_at) VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), id, parsed.version,
          'manual', 'Direct Markdown edit', normalized, new Date().toISOString());
      this.indexDocument(parsed);
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    return parsed;
  }

  async commit(draft: AssistantMemoryDraft): Promise<AssistantMemoryDocument> {
    return this.commitInternal(draft, false);
  }

  private async commitInternal(draft: AssistantMemoryDraft,
    allowUnavailableEvidence: boolean): Promise<AssistantMemoryDocument> {
    const prior = this.database.prepare('SELECT memory_id FROM memory_revisions WHERE revision_id = ?')
      .get(draft.revisionId) as { memory_id: string } | undefined;
    if (prior) {
      if (prior.memory_id !== draft.id) throw new Error('Revision ID belongs to another memory.');
      return (await this.get(draft.id))!;
    }
    if (this.database.prepare('SELECT 1 FROM forgotten_memories WHERE memory_id = ?').get(draft.id)) {
      throw new Error('Forgotten memory ID cannot be reused.');
    }
    const pending = this.database.prepare('SELECT * FROM memory_pending_writes WHERE memory_id = ?')
      .get(draft.id) as unknown as PendingWrite | undefined;
    if (pending) await this.completePending(pending);
    const current = await this.get(draft.id);
    if ((current?.version ?? 0) !== draft.expectedVersion) throw new Error('Memory version conflict.');
    if (current && (!sameAudience(current.audience, draft.audience) || current.section !== draft.section)) {
      throw new Error('Memory audience or section cannot change.');
    }
    if (draft.status !== 'withdrawn' && !draft.manualAuthority
      && !draft.evidence.length && !draft.dependsOn.length) {
      throw new Error('Automatic memory needs evidence or a tracked dependency.');
    }
    for (const ref of draft.evidence) {
      const source = this.sources.source(ref.sourceId);
      if (!source || source.sourceVersion !== ref.sourceVersion
        || (source.availability !== 'available'
          && !(source.availability === 'temporarily_unavailable'
            && (allowUnavailableEvidence || (current?.status === 'active'
              && current.evidence.some((existing) => existing.sourceId === ref.sourceId
                && existing.sourceVersion === ref.sourceVersion)))))
        || !sameAudience(source.audience, draft.audience) || this.sources.isForgotten(ref.sourceId)) {
        throw new Error(`Memory evidence is not currently available: ${ref.sourceId}`);
      }
    }
    for (const id of draft.dependsOn) {
      const parent = await this.get(id);
      if (!parent || (parent.status !== 'active' && draft.status !== 'withdrawn')
        || !sameAudience(parent.audience, draft.audience)) {
        throw new Error(`Memory dependency is unavailable: ${id}`);
      }
    }
    const document: AssistantMemoryDocument = { ...draft, version: draft.expectedVersion + 1,
      status: draft.status ?? 'active' };
    validateDocument(document);
    const path = this.path(document.section, document.id);
    await assertSafeDirectory(dirname(path));
    const previous = await existingContent(path);
    if (!current && previous !== undefined && previous !== '# About the user\n\n'
      && previous !== '# Current memory\n\n') {
      throw new Error('Existing unmanaged memory file requires an explicit import.');
    }
    const content = render(document);
    const intent: PendingWrite = { revision_id: draft.revisionId, memory_id: draft.id,
      path, expected_hash: previous === undefined ? null : digest(previous),
      new_hash: digest(content), new_content: content, document_json: JSON.stringify(document),
      reason: draft.reason.slice(0, 1000) };
    this.database.prepare(`INSERT INTO memory_pending_writes(revision_id,memory_id,path,expected_hash,
      new_hash,new_content,document_json,reason) VALUES (?,?,?,?,?,?,?,?)`).run(intent.revision_id,
        intent.memory_id, intent.path, intent.expected_hash, intent.new_hash, intent.new_content,
        intent.document_json, intent.reason);
    return this.completePending(intent);
  }

  async withdrawSource(sourceId: string): Promise<void> {
    const rows = this.database.prepare('SELECT DISTINCT memory_id FROM memory_evidence WHERE source_id = ?')
      .all(sourceId) as Array<{ memory_id: string }>;
    for (const row of rows) {
      const current = await this.get(row.memory_id);
      if (!current) continue;
      const evidence = current.evidence.filter((ref) => {
        if (ref.sourceId === sourceId) return false;
        const source = this.sources.source(ref.sourceId);
        return source && source.sourceVersion === ref.sourceVersion
          && source.availability !== 'deleted';
      });
      const status = evidence.length || current.manualAuthority || current.dependsOn.length
        ? 'active' : 'withdrawn';
      const draft: AssistantMemoryDraft = { ...current, evidence,
        expectedVersion: current.version, revisionId: randomUUID(),
        status, reason: `Source ${sourceId} was deleted` };
      await this.commitInternal(draft, true);
    }
    await this.reconcileDependentWithdrawals();
  }

  private async recoverForgetJobs(): Promise<void> {
    const jobs = this.database.prepare('SELECT * FROM memory_forget_jobs ORDER BY rowid')
      .all() as Array<{ memory_id: string; section: AssistantDocumentSection; source_ids_json: string }>;
    for (const job of jobs) {
      const path = this.path(job.section, job.memory_id);
      const content = await existingContent(path);
      if (content !== undefined) {
        await unlink(path);
        const directory = await open(dirname(path), constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
      }
      for (const sourceId of JSON.parse(job.source_ids_json) as string[]) {
        this.sources.forgetSource(sourceId);
      }
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.database.prepare('DELETE FROM memory_search_terms WHERE memory_id = ?').run(job.memory_id);
        this.database.prepare('DELETE FROM memory_revisions WHERE memory_id = ?').run(job.memory_id);
        this.database.prepare('DELETE FROM memory_import_conflicts WHERE memory_id = ?').run(job.memory_id);
        this.database.prepare('DELETE FROM memory_pending_writes WHERE memory_id = ?').run(job.memory_id);
        this.database.prepare('DELETE FROM memory_dependencies WHERE parent_id = ? OR child_id = ?')
          .run(job.memory_id, job.memory_id);
        this.database.prepare('DELETE FROM memory_documents WHERE id = ?').run(job.memory_id);
        this.database.prepare('DELETE FROM memory_forget_jobs WHERE memory_id = ?').run(job.memory_id);
        this.database.exec('COMMIT');
      } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    }
  }

  async forget(id: string): Promise<string[]> {
    if (!validId(id)) throw new Error('Invalid memory document ID.');
    const ordered: string[] = [];
    const affectedSources = new Set((this.database.prepare(
      'SELECT source_id FROM memory_evidence WHERE memory_id = ?').all(id) as Array<{ source_id: string }>)
      .map((row) => row.source_id));
    const historical = this.database.prepare('SELECT content FROM memory_revisions WHERE memory_id = ?')
      .all(id) as Array<{ content: string | null }>;
    for (const revision of historical) {
      if (!revision.content) continue;
      for (const ref of parseDocument(revision.content).evidence) affectedSources.add(ref.sourceId);
    }
    const visited = new Set<string>();
    const visit = (currentId: string) => {
      if (visited.has(currentId)) return;
      visited.add(currentId);
      const children = this.database.prepare('SELECT child_id FROM memory_dependencies WHERE parent_id = ?')
        .all(currentId) as Array<{ child_id: string }>;
      for (const child of children) visit(child.child_id);
      if (this.row(currentId)) ordered.push(currentId);
    };
    visit(id);
    for (const sourceId of affectedSources) {
      const siblings = this.database.prepare('SELECT memory_id FROM memory_evidence WHERE source_id = ?')
        .all(sourceId) as Array<{ memory_id: string }>;
      for (const sibling of siblings) visit(sibling.memory_id);
    }
    const revisions = this.database.prepare('SELECT memory_id,content FROM memory_revisions WHERE content IS NOT NULL')
      .all() as Array<{ memory_id: string; content: string }>;
    for (const revision of revisions) {
      if (parseDocument(revision.content).evidence.some((ref) => affectedSources.has(ref.sourceId))) {
        visit(revision.memory_id);
      }
    }
    if (!ordered.length) return [];
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const memoryId of ordered) {
        const row = this.row(memoryId)!;
        this.database.prepare(`INSERT OR IGNORE INTO memory_forget_jobs(memory_id,section,source_ids_json)
          VALUES (?,?,?)`).run(memoryId, String(row.section), JSON.stringify([...affectedSources]));
        this.database.prepare('INSERT OR IGNORE INTO forgotten_memories(memory_id,forgotten_at) VALUES (?,?)')
          .run(memoryId, new Date().toISOString());
        this.database.prepare("UPDATE memory_documents SET status='withdrawn' WHERE id=?").run(memoryId);
        this.database.prepare('DELETE FROM memory_search_terms WHERE memory_id=?').run(memoryId);
      }
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    await this.recoverForgetJobs();
    return ordered;
  }

  async search(query: string, audience: AssistantAudience, limit = 20): Promise<AssistantMemorySearchHit[]> {
    // Manual Markdown edits can introduce previously unindexed terms.
    const known = this.database.prepare('SELECT id FROM memory_documents').all() as Array<{ id: string }>;
    for (const row of known) await this.get(row.id);
    const terms = searchTerms(query);
    if (!terms.length) return [];
    const placeholders = terms.map(() => '?').join(',');
    const rows = this.database.prepare(`SELECT m.id FROM memory_documents m
      JOIN memory_search_terms x ON x.memory_id=m.id
      WHERE m.status='active' AND m.audience_kind=? AND m.audience_id=?
      AND x.term IN (${placeholders}) GROUP BY m.id HAVING COUNT(DISTINCT x.term)=?`)
      .all(audience.kind, audience.id, ...terms, terms.length) as Array<{ id: string }>;
    const hits: AssistantMemorySearchHit[] = [];
    for (const row of rows) {
      const document = await this.get(row.id);
      if (!document || document.status !== 'active'
        || !normalize(`${document.context} ${document.text}`).includes(normalize(query))) continue;
      hits.push({ document, evidenceStatus: document.evidence.map((ref) => ({ ref,
        availability: this.sources.source(ref.sourceId)?.availability ?? 'unknown' })) });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  async rebuildIndex(): Promise<void> {
    this.sources.rebuildIndex();
    const rows = this.database.prepare('SELECT id FROM memory_documents').all() as Array<{ id: string }>;
    const documents: AssistantMemoryDocument[] = [];
    for (const row of rows) {
      const document = await this.get(row.id);
      if (document) documents.push(document);
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec('DELETE FROM memory_search_terms');
      for (const document of documents) this.indexDocument(document);
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  /** Host supplies legacy content through an authorized source reference, never a filesystem path. */
  async importLegacyMemory(input: { id: string; text: string; source: AssistantEvidenceRef;
    audience: AssistantAudience; context: string }): Promise<AssistantMemoryDocument> {
    const current = await this.get(input.id);
    if (current?.manualAuthority) {
      this.database.prepare(`INSERT OR IGNORE INTO memory_import_conflicts
        (memory_id,source_id,source_version,detected_at,reason) VALUES (?,?,?,?,?)`)
        .run(input.id, input.source.sourceId, input.source.sourceVersion,
          new Date().toISOString(), 'Manual memory takes precedence over changed legacy content');
      return current;
    }
    const text = input.text.slice(0, 20_000);
    if (current?.text === text && current.evidence.length === 1
      && current.evidence[0]?.sourceId === input.source.sourceId
      && current.evidence[0].sourceVersion === input.source.sourceVersion
      && current.status === 'active') return current;
    return this.commit({ id: input.id, expectedVersion: current?.version ?? 0,
      revisionId: `legacy-${digest(input.id + input.source.sourceId + input.source.sourceVersion
        + String(current?.version ?? 0))}`,
      section: 'memories', kind: 'observed', audience: input.audience,
      context: input.context, verifiedAt: input.source.observedAt,
      text, evidence: [input.source], dependsOn: [],
      manualAuthority: false, reason: 'Read-only legacy memory import' });
  }

  legacyImportConflicts(memoryId: string): Array<{ sourceId: string; sourceVersion: string;
    detectedAt: string; reason: string }> {
    const rows = this.database.prepare(`SELECT source_id,source_version,detected_at,reason
      FROM memory_import_conflicts WHERE memory_id=? ORDER BY detected_at`)
      .all(memoryId) as Array<{ source_id: string; source_version: string;
        detected_at: string; reason: string }>;
    return rows.map((row) => ({ sourceId: row.source_id, sourceVersion: row.source_version,
      detectedAt: row.detected_at, reason: row.reason }));
  }

  close(): void { this.sources.close(); }
}
