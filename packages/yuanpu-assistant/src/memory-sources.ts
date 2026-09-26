import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AssistantAudience, AssistantSourceChange } from '@yuanpu-agent/protocol';
import { assertSafeDirectory, resolveAssistantHome } from './home.js';

export interface AssistantSourceEvent {
  /** Stable within one feed. The host may use a database row ID or another opaque event key. */
  eventId: string;
  change: AssistantSourceChange;
}

export interface AssistantSourcePage {
  events: AssistantSourceEvent[];
  /** An opaque, durable acknowledgement boundary chosen by the host. */
  nextCursor: string;
}

export type AssistantSourceState =
  | { status: 'available'; sourceVersion: string }
  | { status: 'temporarily_unavailable'; sourceVersion?: string }
  | { status: 'deleted'; sourceVersion: string };

export type AssistantSourceRead =
  | { status: 'available'; sourceVersion: string; text: string;
    artifacts?: Array<{ contentRef: string; summary?: string; mediaType?: string }> }
  | { status: 'temporarily_unavailable' }
  | { status: 'deleted' };

/** The host owns authorization and contentRef resolution; the Worker never opens source paths. */
export interface AssistantSourceHost {
  listChanges(feedId: string, afterCursor: string, limit: number): Promise<AssistantSourcePage>;
  currentSource(sourceId: string, audience: AssistantAudience): Promise<AssistantSourceState>;
  readSource(contentRef: string, sourceId: string, sourceVersion: string,
    audience: AssistantAudience, maxCharacters: number): Promise<AssistantSourceRead>;
}

export interface QueuedSource {
  feedId: string;
  eventId: string;
  change: AssistantSourceChange;
  status: 'pending' | 'processed' | 'unavailable' | 'obsolete' | 'forgotten';
}

export interface SourceSearchHit {
  sourceId: string;
  sourceVersion: string;
  audience: AssistantAudience;
  excerpt: string;
  contentRef: string;
  availability: 'available' | 'temporarily_unavailable' | 'deleted';
}

const sourceSchema = `
  CREATE TABLE IF NOT EXISTS source_feeds (
    feed_id TEXT PRIMARY KEY, cursor TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS source_events (
    feed_id TEXT NOT NULL, event_id TEXT NOT NULL,
    source_id TEXT NOT NULL, source_version TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('created','updated','deleted')),
    audience_kind TEXT NOT NULL, audience_id TEXT NOT NULL,
    content_ref TEXT, work_id TEXT, occurred_at TEXT NOT NULL,
    attempted_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
      ('pending','processed','unavailable','obsolete','forgotten')),
    PRIMARY KEY (feed_id,event_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS source_events_pending ON source_events(status,feed_id,event_id);
  CREATE TABLE IF NOT EXISTS source_current (
    source_id TEXT PRIMARY KEY, feed_id TEXT NOT NULL,
    source_version TEXT NOT NULL, content_ref TEXT,
    audience_kind TEXT NOT NULL, audience_id TEXT NOT NULL,
    availability TEXT NOT NULL CHECK (availability IN
      ('available','temporarily_unavailable','deleted')),
    occurred_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS source_text (
    source_id TEXT PRIMARY KEY REFERENCES source_current(source_id),
    source_version TEXT NOT NULL, text TEXT NOT NULL, excerpt TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS source_artifacts (
    source_id TEXT NOT NULL REFERENCES source_current(source_id),
    content_ref TEXT NOT NULL, summary TEXT, media_type TEXT,
    PRIMARY KEY (source_id,content_ref)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS forgotten_sources (
    source_id TEXT PRIMARY KEY, forgotten_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS source_search_terms (
    term TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES source_current(source_id),
    PRIMARY KEY (term,source_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS source_search_by_id ON source_search_terms(source_id);
`;

function validIdentity(value: string, label: string): void {
  if (!value || value.length > 256 || /[\x00-\x1f]/u.test(value)) throw new Error(`Invalid ${label}.`);
}

function validAudience(audience: AssistantAudience): void {
  if (!['personal', 'conversation', 'organization'].includes(audience.kind)) {
    throw new Error('Invalid source audience.');
  }
  validIdentity(audience.id, 'source audience ID');
}

function canonicalFeed(feedId: string): string {
  if (feedId === 'work-evidence' || feedId === 'work-deletions') return 'work';
  return feedId.endsWith('-deletions') ? feedId.slice(0, -'-deletions'.length) : feedId;
}

function normalized(value: string): string { return value.normalize('NFKC').toLocaleLowerCase('und'); }

/** Unicode bigrams retain two-character Chinese searches; ASCII words remain whole tokens. */
export function searchTerms(value: string): string[] {
  const text = normalized(value);
  const terms = new Set<string>();
  for (const word of text.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (/^[\x00-\x7f]+$/u.test(word)) { terms.add(`w:${word}`); continue; }
    const characters = [...word];
    if (characters.length === 1) terms.add(`c:${characters[0]}`);
    for (let index = 0; index + 1 < characters.length; index++) {
      terms.add(`c:${characters[index]}${characters[index + 1]}`);
    }
  }
  return [...terms];
}

function eventRow(row: Record<string, unknown>): QueuedSource {
  return {
    feedId: String(row.feed_id), eventId: String(row.event_id),
    change: {
      sourceId: String(row.source_id), sourceVersion: String(row.source_version),
      kind: row.kind as AssistantSourceChange['kind'],
      audience: { kind: row.audience_kind as AssistantAudience['kind'], id: String(row.audience_id) },
      occurredAt: String(row.occurred_at),
      ...(row.content_ref === null ? {} : { contentRef: String(row.content_ref) }),
      ...(row.work_id === null ? {} : { workId: String(row.work_id) }),
    },
    status: row.status as QueuedSource['status'],
  };
}

export class AssistantSourceStore {
  readonly database: DatabaseSync;
  private closed = false;

  private constructor(database: DatabaseSync) {
    this.database = database;
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    database.exec(sourceSchema);
    const columns = database.prepare('PRAGMA table_info(source_events)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'attempted_at')) {
      database.exec('ALTER TABLE source_events ADD COLUMN attempted_at TEXT');
    }
  }

  static async open(assistantHome: string): Promise<AssistantSourceStore> {
    const home = resolveAssistantHome(assistantHome);
    await assertSafeDirectory(home.root);
    const path = join(home.root, 'state.sqlite');
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Assistant state path is not a real file.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(home.root, { recursive: true });
    const database = new DatabaseSync(path);
    try {
      database.exec('PRAGMA journal_mode = WAL');
      return new AssistantSourceStore(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  cursor(feedId: string): string {
    validIdentity(feedId, 'source feed ID');
    const row = this.database.prepare('SELECT cursor FROM source_feeds WHERE feed_id = ?')
      .get(feedId) as { cursor: string } | undefined;
    return row?.cursor ?? '0';
  }

  /** The page and its cursor commit together; a crash cannot acknowledge an unqueued event. */
  enqueuePage(feedId: string, expectedCursor: string, page: AssistantSourcePage): number {
    validIdentity(feedId, 'source feed ID');
    validIdentity(page.nextCursor, 'source cursor');
    if (page.events.length > 500) throw new Error('Source page exceeds 500 events.');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (this.cursor(feedId) !== expectedCursor) throw new Error('Source cursor changed.');
      let inserted = 0;
      const originatingFeed = canonicalFeed(feedId);
      for (const event of page.events) {
        const change = event.change;
        validIdentity(event.eventId, 'source event ID');
        validIdentity(change.sourceId, 'source ID');
        validIdentity(change.sourceVersion, 'source version');
        validAudience(change.audience);
        if (change.kind !== 'deleted' && !change.contentRef) throw new Error('Source contentRef is required.');
        if (change.contentRef) validIdentity(change.contentRef, 'source contentRef');
        const owner = this.database.prepare(`SELECT feed_id FROM source_events WHERE source_id = ?
          UNION SELECT feed_id FROM source_current WHERE source_id = ? LIMIT 1`)
          .get(change.sourceId, change.sourceId) as { feed_id: string } | undefined;
        if (owner && canonicalFeed(owner.feed_id) !== originatingFeed) {
          throw new Error('Source ID belongs to another feed.');
        }
        const existing = this.database.prepare('SELECT * FROM source_events WHERE feed_id = ? AND event_id = ?')
          .get(feedId, event.eventId) as Record<string, unknown> | undefined;
        if (existing) {
          const prior = eventRow(existing).change;
          if (prior.sourceId !== change.sourceId || prior.sourceVersion !== change.sourceVersion
            || prior.kind !== change.kind || prior.audience.kind !== change.audience.kind
            || prior.audience.id !== change.audience.id || prior.contentRef !== change.contentRef
            || prior.workId !== change.workId || prior.occurredAt !== change.occurredAt) {
            throw new Error('Conflicting source event ID.');
          }
          continue;
        }
        this.database.prepare(`INSERT INTO source_events(feed_id,event_id,source_id,source_version,kind,
          audience_kind,audience_id,content_ref,work_id,occurred_at,status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(feedId, event.eventId, change.sourceId,
          change.sourceVersion, change.kind, change.audience.kind, change.audience.id,
          change.contentRef ?? null, change.workId ?? null, change.occurredAt,
          this.isForgotten(change.sourceId) ? 'forgotten' : 'pending');
        inserted++;
      }
      this.database.prepare(`INSERT INTO source_feeds(feed_id,cursor) VALUES (?,?)
        ON CONFLICT(feed_id) DO UPDATE SET cursor = excluded.cursor`).run(feedId, page.nextCursor);
      this.database.exec('COMMIT');
      return inserted;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async sync(host: AssistantSourceHost, feedId: string, limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid source page size.');
    const cursor = this.cursor(feedId);
    const page = await host.listChanges(feedId, cursor, limit);
    return this.enqueuePage(feedId, cursor, page);
  }

  nextEvent(retryUnavailable = false): QueuedSource | undefined {
    const row = this.database.prepare(`SELECT * FROM source_events
      WHERE status = 'pending' OR (status = 'unavailable' AND ? = 1)
      ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,
        CASE WHEN status = 'unavailable' THEN attempted_at END, rowid LIMIT 1`)
      .get(retryUnavailable ? 1 : 0) as Record<string, unknown> | undefined;
    return row ? eventRow(row) : undefined;
  }

  event(feedId: string, eventId: string): QueuedSource | undefined {
    const row = this.database.prepare('SELECT * FROM source_events WHERE feed_id = ? AND event_id = ?')
      .get(feedId, eventId) as Record<string, unknown> | undefined;
    return row ? eventRow(row) : undefined;
  }

  /** A version hash is only compared for equality against the host's current state. */
  async processNext(host: AssistantSourceHost, retryUnavailable = false): Promise<QueuedSource | undefined> {
    const event = this.nextEvent(retryUnavailable);
    if (!event) return undefined;
    const change = event.change;
    if (this.isForgotten(change.sourceId)) {
      this.markEvent(event, 'forgotten');
      return { ...event, status: 'forgotten' };
    }
    const current = await host.currentSource(change.sourceId, change.audience);
    if (current.status === 'temporarily_unavailable') {
      this.setCurrent(event, 'temporarily_unavailable');
      return { ...event, status: 'unavailable' };
    }
    if (current.sourceVersion !== change.sourceVersion) {
      this.markEvent(event, 'obsolete');
      return { ...event, status: 'obsolete' };
    }
    if (current.status === 'deleted') {
      this.setCurrent(event, 'deleted');
      return { ...event, status: 'processed' };
    }
    if (change.kind === 'deleted' || !change.contentRef) {
      throw new Error('Host reports a deleted source event as available.');
    }
    const content = await host.readSource(change.contentRef, change.sourceId, change.sourceVersion,
      change.audience, 32_000);
    if (content.status === 'temporarily_unavailable') {
      this.setCurrent(event, 'temporarily_unavailable');
      return { ...event, status: 'unavailable' };
    }
    if (content.status === 'deleted') {
      this.setCurrent(event, 'deleted');
      return { ...event, status: 'processed' };
    }
    if (content.sourceVersion !== change.sourceVersion) {
      this.markEvent(event, 'obsolete');
      return { ...event, status: 'obsolete' };
    }
    this.setCurrent(event, 'available', content.text, content.artifacts);
    return { ...event, status: 'processed' };
  }

  isForgotten(sourceId: string): boolean {
    return Boolean(this.database.prepare('SELECT 1 FROM forgotten_sources WHERE source_id = ?').get(sourceId));
  }

  forgetSource(sourceId: string): void {
    validIdentity(sourceId, 'source ID');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('INSERT OR IGNORE INTO forgotten_sources(source_id,forgotten_at) VALUES (?,?)')
        .run(sourceId, new Date().toISOString());
      this.database.prepare("UPDATE source_events SET status = 'forgotten' WHERE source_id = ?")
        .run(sourceId);
      this.database.prepare('UPDATE source_events SET content_ref = NULL, work_id = NULL WHERE source_id = ?')
        .run(sourceId);
      this.database.prepare('DELETE FROM source_search_terms WHERE source_id = ?').run(sourceId);
      this.database.prepare('DELETE FROM source_artifacts WHERE source_id = ?').run(sourceId);
      this.database.prepare('DELETE FROM source_text WHERE source_id = ?').run(sourceId);
      this.database.prepare(`UPDATE source_current SET content_ref = NULL,availability = 'deleted'
        WHERE source_id = ?`).run(sourceId);
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  markEvent(event: QueuedSource, status: QueuedSource['status']): void {
    this.database.prepare(`UPDATE source_events SET status = ?,
      attempted_at = CASE WHEN ? = 'unavailable' THEN ? ELSE attempted_at END
      WHERE feed_id = ? AND event_id = ?`)
      .run(status, status, new Date().toISOString(), event.feedId, event.eventId);
  }

  setCurrent(event: QueuedSource, availability: SourceSearchHit['availability'], text?: string,
    artifacts: Array<{ contentRef: string; summary?: string; mediaType?: string }> = []): void {
    const change = event.change;
    const previous = this.database.prepare('SELECT feed_id FROM source_current WHERE source_id = ?')
      .get(change.sourceId) as { feed_id: string } | undefined;
    const originatingFeed = canonicalFeed(event.feedId);
    if (previous && previous.feed_id !== originatingFeed) throw new Error('Source ID belongs to another feed.');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (availability === 'temporarily_unavailable' && previous) {
        this.database.prepare(`UPDATE source_current SET availability = 'temporarily_unavailable'
          WHERE source_id = ?`).run(change.sourceId);
        this.markEvent(event, 'unavailable');
        this.database.exec('COMMIT');
        return;
      }
      this.database.prepare(`INSERT INTO source_current(source_id,feed_id,source_version,content_ref,
        audience_kind,audience_id,availability,occurred_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(source_id) DO UPDATE SET source_version=excluded.source_version,
        content_ref=excluded.content_ref,audience_kind=excluded.audience_kind,
        audience_id=excluded.audience_id,availability=excluded.availability,
        occurred_at=excluded.occurred_at`).run(change.sourceId, originatingFeed, change.sourceVersion,
          change.contentRef ?? null, change.audience.kind, change.audience.id, availability, change.occurredAt);
      if (availability === 'available' && text !== undefined) {
        const bounded = text.slice(0, 32_000);
        this.database.prepare(`INSERT INTO source_text(source_id,source_version,text,excerpt) VALUES (?,?,?,?)
          ON CONFLICT(source_id) DO UPDATE SET source_version=excluded.source_version,
          text=excluded.text,excerpt=excluded.excerpt`).run(change.sourceId, change.sourceVersion,
            bounded, bounded.slice(0, 400));
        this.database.prepare('DELETE FROM source_search_terms WHERE source_id = ?').run(change.sourceId);
        for (const term of searchTerms(bounded)) {
          this.database.prepare('INSERT OR IGNORE INTO source_search_terms(term,source_id) VALUES (?,?)')
            .run(term, change.sourceId);
        }
        this.database.prepare('DELETE FROM source_artifacts WHERE source_id = ?').run(change.sourceId);
        for (const artifact of artifacts.slice(0, 100)) {
          validIdentity(artifact.contentRef, 'artifact contentRef');
          this.database.prepare(`INSERT INTO source_artifacts(source_id,content_ref,summary,media_type)
            VALUES (?,?,?,?)`).run(change.sourceId, artifact.contentRef,
              artifact.summary?.slice(0, 1000) ?? null, artifact.mediaType ?? null);
        }
      } else if (availability === 'deleted') {
        this.database.prepare('DELETE FROM source_search_terms WHERE source_id = ?').run(change.sourceId);
        this.database.prepare('DELETE FROM source_artifacts WHERE source_id = ?').run(change.sourceId);
        this.database.prepare('DELETE FROM source_text WHERE source_id = ?').run(change.sourceId);
      }
      this.markEvent(event, availability === 'temporarily_unavailable' ? 'unavailable' : 'processed');
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  source(sourceId: string): { sourceVersion: string; audience: AssistantAudience;
    availability: SourceSearchHit['availability']; contentRef?: string } | undefined {
    const row = this.database.prepare('SELECT * FROM source_current WHERE source_id = ?')
      .get(sourceId) as Record<string, unknown> | undefined;
    return row ? { sourceVersion: String(row.source_version),
      audience: { kind: row.audience_kind as AssistantAudience['kind'], id: String(row.audience_id) },
      availability: row.availability as SourceSearchHit['availability'],
      ...(row.content_ref === null ? {} : { contentRef: String(row.content_ref) }) } : undefined;
  }

  artifacts(sourceId: string, audience: AssistantAudience): Array<{
    contentRef: string; summary?: string; mediaType?: string }> {
    validAudience(audience);
    const source = this.source(sourceId);
    if (!source || source.availability === 'deleted'
      || source.audience.kind !== audience.kind || source.audience.id !== audience.id) return [];
    const rows = this.database.prepare(`SELECT content_ref,summary,media_type FROM source_artifacts
      WHERE source_id = ? ORDER BY content_ref`).all(sourceId) as Array<{
        content_ref: string; summary: string | null; media_type: string | null }>;
    return rows.map((row) => ({ contentRef: row.content_ref,
      ...(row.summary === null ? {} : { summary: row.summary }),
      ...(row.media_type === null ? {} : { mediaType: row.media_type }) }));
  }

  sourceText(sourceId: string, audience: AssistantAudience): string | undefined {
    validAudience(audience);
    const source = this.source(sourceId);
    if (!source || source.availability !== 'available'
      || source.audience.kind !== audience.kind || source.audience.id !== audience.id) return undefined;
    const row = this.database.prepare('SELECT text FROM source_text WHERE source_id = ?')
      .get(sourceId) as { text: string } | undefined;
    return row?.text;
  }

  search(query: string, audience: AssistantAudience, limit = 20): SourceSearchHit[] {
    validAudience(audience);
    const terms = searchTerms(query);
    if (!terms.length) return [];
    const placeholders = terms.map(() => '?').join(',');
    const candidates = this.database.prepare(`SELECT s.source_id,s.source_version,s.content_ref,
      s.audience_kind,s.audience_id,s.availability,t.text,t.excerpt
      FROM source_current s JOIN source_text t ON t.source_id=s.source_id
      JOIN source_search_terms x ON x.source_id=s.source_id
      WHERE s.audience_kind=? AND s.audience_id=? AND s.availability != 'deleted'
      AND x.term IN (${placeholders})
      GROUP BY s.source_id HAVING COUNT(DISTINCT x.term) = ?`)
      .all(audience.kind, audience.id, ...terms, terms.length) as Array<Record<string, unknown>>;
    const needle = normalized(query);
    return candidates.filter((row) => normalized(String(row.text)).includes(needle))
      .slice(0, limit).map((row) => ({ sourceId: String(row.source_id),
        sourceVersion: String(row.source_version),
        audience: { kind: row.audience_kind as AssistantAudience['kind'], id: String(row.audience_id) },
        excerpt: String(row.excerpt), contentRef: String(row.content_ref),
        availability: row.availability as SourceSearchHit['availability'] }));
  }

  rebuildIndex(): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec('DELETE FROM source_search_terms');
      const rows = this.database.prepare(`SELECT s.source_id,t.text FROM source_current s
        JOIN source_text t ON t.source_id=s.source_id WHERE s.availability != 'deleted'`)
        .all() as Array<{ source_id: string; text: string }>;
      for (const row of rows) for (const term of searchTerms(row.text)) {
        this.database.prepare('INSERT OR IGNORE INTO source_search_terms(term,source_id) VALUES (?,?)')
          .run(term, row.source_id);
      }
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  close(): void { if (!this.closed) { this.closed = true; this.database.close(); } }
}
