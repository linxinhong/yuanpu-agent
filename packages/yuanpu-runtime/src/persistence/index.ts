import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const YUANPU_METADATA_SCHEMA_VERSION = 1;
export const YUANPU_SQLITE_DRIVER = 'node:sqlite';

interface Migration {
  version: number;
  sql: string;
}

const migrations: readonly Migration[] = [{
  version: 1,
  sql: `
    CREATE TABLE yp_runtime_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE yp_conversation_bindings (
      binding_id TEXT PRIMARY KEY,
      entry_point TEXT NOT NULL CHECK (entry_point IN ('desktop', 'im', 'scheduler')),
      authority_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      thread_id TEXT NOT NULL DEFAULT '',
      pi_session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (entry_point, authority_id, namespace, conversation_id, thread_id)
    ) STRICT;

    CREATE TABLE yp_agent_runs (
      run_id TEXT PRIMARY KEY,
      entry_point TEXT NOT NULL CHECK (entry_point IN ('desktop', 'im', 'scheduler')),
      authority_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      request_json TEXT NOT NULL,
      binding_id TEXT REFERENCES yp_conversation_bindings(binding_id),
      status TEXT NOT NULL CHECK (status IN (
        'queued', 'running', 'waiting_approval', 'succeeded', 'failed',
        'cancelled', 'interrupted', 'result_unknown'
      )),
      output_json TEXT,
      failure_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (entry_point, authority_id, idempotency_key)
    ) STRICT;

    CREATE INDEX yp_agent_runs_status_created
      ON yp_agent_runs(status, created_at);

    CREATE TABLE yp_delivery_attempts (
      delivery_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES yp_agent_runs(run_id),
      idempotency_key TEXT NOT NULL,
      target_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'pending', 'delivering', 'delivered', 'failed', 'result_unknown'
      )),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (run_id, idempotency_key)
    ) STRICT;

    CREATE TABLE yp_inbound_deduplication (
      entry_point TEXT NOT NULL,
      authority_id TEXT NOT NULL,
      external_message_id TEXT NOT NULL,
      run_id TEXT REFERENCES yp_agent_runs(run_id),
      received_at TEXT NOT NULL,
      PRIMARY KEY (entry_point, authority_id, external_message_id)
    ) STRICT;
  `,
}];

function applyMigrations(database: DatabaseSync): number {
  database.exec(`
    CREATE TABLE IF NOT EXISTS yp_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const row = database.prepare(
    'SELECT COALESCE(MAX(version), 0) AS version FROM yp_schema_migrations',
  ).get() as { version: number };
  if (row.version > YUANPU_METADATA_SCHEMA_VERSION) {
    throw new Error(
      `Yuanpu metadata schema ${row.version} is newer than supported ${YUANPU_METADATA_SCHEMA_VERSION}.`,
    );
  }
  for (const migration of migrations) {
    if (migration.version <= row.version) continue;
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
      database.prepare(
        'INSERT INTO yp_schema_migrations(version, applied_at) VALUES (?, ?)',
      ).run(migration.version, new Date().toISOString());
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  return YUANPU_METADATA_SCHEMA_VERSION;
}

export class YuanpuMetadataDatabase {
  readonly driver = YUANPU_SQLITE_DRIVER;
  readonly schemaVersion: number;

  constructor(private readonly database: DatabaseSync) {
    this.schemaVersion = applyMigrations(database);
  }

  getMetadata(key: string): string | undefined {
    const row = this.database.prepare(
      'SELECT value FROM yp_runtime_metadata WHERE key = ?',
    ).get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMetadata(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO yp_runtime_metadata(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString());
  }

  incrementMetadataCounter(key: string): number {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = Number.parseInt(this.getMetadata(key) ?? '0', 10);
      const next = Number.isSafeInteger(current) ? current + 1 : 1;
      this.setMetadata(key, String(next));
      this.database.exec('COMMIT');
      return next;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}

export function openYuanpuMetadataDatabase(path: string): YuanpuMetadataDatabase {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') database.exec('PRAGMA journal_mode = WAL');
    return new YuanpuMetadataDatabase(database);
  } catch (error) {
    database.close();
    throw error;
  }
}
