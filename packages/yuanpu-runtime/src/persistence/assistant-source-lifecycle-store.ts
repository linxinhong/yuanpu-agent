import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AssistantSourceChange } from '@yuanpu-agent/protocol';

type OriginFeed = 'work' | 'assistant';
interface DeletionRow {
  event_id: number;
  source_id: string;
  source_version: string;
  audience_id: string;
  occurred_at: string;
}

function deletionChange(row: DeletionRow): AssistantSourceChange {
  return { sourceId: row.source_id, sourceVersion: row.source_version,
    kind: 'deleted', audience: { kind: 'personal', id: row.audience_id },
    occurredAt: row.occurred_at };
}

/** One Runtime-owned ledger for authoritative deletion and legacy import notices. */
export class AssistantSourceLifecycleStore {
  constructor(private readonly database: DatabaseSync) {}

  markDeleted(feedId: OriginFeed, sourceId: string, audienceId: string,
    expectedVersion?: string): AssistantSourceChange {
    const sourceVersion = expectedVersion
      ? `deleted:${createHash('sha256').update(expectedVersion).digest('hex')}`
      : `deleted:${randomUUID()}`;
    this.database.prepare(`INSERT OR IGNORE INTO yp_assistant_source_deletions
      (feed_id,source_id,source_version,audience_id,occurred_at) VALUES (?,?,?,?,?)`)
      .run(feedId, sourceId, sourceVersion, audienceId, new Date().toISOString());
    return this.deletion(feedId, sourceId)!;
  }

  deletion(feedId: OriginFeed, sourceId: string): AssistantSourceChange | undefined {
    const row = this.database.prepare(`SELECT event_id,source_id,source_version,audience_id,occurred_at
      FROM yp_assistant_source_deletions WHERE feed_id=? AND source_id=?`)
      .get(feedId, sourceId) as DeletionRow | undefined;
    return row && deletionChange(row);
  }

  deletionPage(feedId: OriginFeed, after: number, limit: number): Array<{
    eventId: number; change: AssistantSourceChange }> {
    const rows = this.database.prepare(`SELECT event_id,source_id,source_version,audience_id,occurred_at
      FROM yp_assistant_source_deletions WHERE feed_id=? AND event_id > ? AND audience_id='local-user'
      ORDER BY event_id LIMIT ?`).all(feedId, after, limit) as unknown as DeletionRow[];
    return rows.map((row) => ({ eventId: row.event_id, change: deletionChange(row) }));
  }

  recordLegacyVersion(sourceVersion: string): void {
    const latest = this.database.prepare(`SELECT source_version FROM yp_assistant_legacy_memory_events
      ORDER BY event_id DESC LIMIT 1`).get() as { source_version: string } | undefined;
    if (latest?.source_version !== sourceVersion) {
      this.database.prepare(`INSERT INTO yp_assistant_legacy_memory_events(source_version,occurred_at)
        VALUES (?,?)`).run(sourceVersion, new Date().toISOString());
    }
  }

  legacyPage(after: number, limit: number): Array<{
    eventId: number; sourceVersion: string; occurredAt: string }> {
    const rows = this.database.prepare(`SELECT event_id,source_version,occurred_at
      FROM yp_assistant_legacy_memory_events WHERE event_id > ? ORDER BY event_id LIMIT ?`)
      .all(after, limit) as Array<{ event_id: number; source_version: string; occurred_at: string }>;
    return rows.map((row) => ({ eventId: row.event_id, sourceVersion: row.source_version,
      occurredAt: row.occurred_at }));
  }
}
