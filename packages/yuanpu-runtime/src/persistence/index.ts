import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AgentRunStore } from './agent-run-store.js';
import { ChannelStore } from '../channels/store.js';
import { SchedulerStore } from '../scheduler/store.js';

export * from './agent-run-store.js';

export const YUANPU_METADATA_SCHEMA_VERSION = 4;
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
      subject_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      thread_id TEXT NOT NULL DEFAULT '',
      pi_session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (entry_point, authority_id, subject_id, namespace, conversation_id, thread_id),
      UNIQUE (binding_id, entry_point, authority_id, subject_id)
    ) STRICT;

    CREATE TABLE yp_agent_runs (
      run_id TEXT PRIMARY KEY,
      entry_point TEXT NOT NULL CHECK (entry_point IN ('desktop', 'im', 'scheduler')),
      authority_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      request_metadata_json TEXT NOT NULL,
      binding_id TEXT,
      status TEXT NOT NULL CHECK (status IN (
        'queued', 'running', 'waiting_approval', 'succeeded', 'failed',
        'cancelled', 'interrupted', 'result_unknown'
      )),
      external_effect_state TEXT NOT NULL DEFAULT 'none'
        CHECK (external_effect_state IN ('none', 'possible')),
      approval_request_id TEXT,
      approval_session_id TEXT,
      approval_workspace_id TEXT,
      approval_expires_at TEXT,
      output_digest TEXT,
      failure_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (entry_point, authority_id, subject_id, idempotency_key),
      UNIQUE (run_id, entry_point, authority_id, subject_id),
      FOREIGN KEY (binding_id, entry_point, authority_id, subject_id)
        REFERENCES yp_conversation_bindings(binding_id, entry_point, authority_id, subject_id),
      CHECK (
        status <> 'waiting_approval'
        OR (
          approval_request_id IS NOT NULL
          AND approval_session_id IS NOT NULL
          AND approval_workspace_id IS NOT NULL
          AND approval_expires_at IS NOT NULL
        )
      ),
      CHECK (status <> 'result_unknown' OR external_effect_state = 'possible')
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
      subject_id TEXT NOT NULL,
      external_message_id TEXT NOT NULL,
      run_id TEXT REFERENCES yp_agent_runs(run_id),
      received_at TEXT NOT NULL,
      PRIMARY KEY (entry_point, authority_id, subject_id, external_message_id),
      FOREIGN KEY (run_id, entry_point, authority_id, subject_id)
        REFERENCES yp_agent_runs(run_id, entry_point, authority_id, subject_id)
    ) STRICT;
  `,
}, {
  version: 2,
  sql: `
    ALTER TABLE yp_agent_runs ADD COLUMN failure_message TEXT;
    ALTER TABLE yp_agent_runs ADD COLUMN failure_retryable INTEGER
      CHECK (failure_retryable IN (0, 1));

    CREATE TABLE yp_agent_run_queue_payloads (
      run_id TEXT PRIMARY KEY REFERENCES yp_agent_runs(run_id),
      input_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    UPDATE yp_agent_runs
    SET status = 'interrupted',
      failure_code = 'migration_payload_unavailable',
      failure_message = 'Queued input was not retained by metadata schema v1 and cannot be resumed.',
      failure_retryable = 1
    WHERE status = 'queued';
  `,
}, {
  version: 3,
  sql: `
    CREATE TABLE yp_agent_run_outputs (
      run_id TEXT PRIMARY KEY REFERENCES yp_agent_runs(run_id),
      output_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE yp_schedules (
      schedule_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision > 0),
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      timing_json TEXT NOT NULL,
      time_zone TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      misfire_policy TEXT NOT NULL CHECK (misfire_policy IN ('coalesce', 'skip')),
      maximum_lateness_ms INTEGER NOT NULL CHECK (maximum_lateness_ms >= 0),
      allow_overlap INTEGER NOT NULL CHECK (allow_overlap IN (0, 1)),
      conversation_id TEXT NOT NULL,
      delivery_json TEXT NOT NULL,
      next_trigger_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX yp_schedules_due
      ON yp_schedules(enabled, next_trigger_at);

    CREATE TABLE yp_schedule_triggers (
      trigger_key TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL REFERENCES yp_schedules(schedule_id),
      schedule_revision INTEGER NOT NULL,
      scheduled_at TEXT NOT NULL,
      request_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'pending_submission', 'submitted', 'submission_failed',
        'skipped_misfire', 'skipped_overlap', 'output_unknown'
      )),
      run_id TEXT REFERENCES yp_agent_runs(run_id),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (schedule_id, schedule_revision, scheduled_at)
    ) STRICT;

    CREATE INDEX yp_schedule_triggers_schedule_history
      ON yp_schedule_triggers(schedule_id, scheduled_at DESC);
    CREATE INDEX yp_schedule_triggers_submission
      ON yp_schedule_triggers(status, created_at);
  `,
}, {
  version: 4,
  sql: `
    CREATE TABLE yp_channel_pairings (
      provider TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      sender_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (provider, connection_id, sender_digest)
    ) STRICT;

    CREATE TABLE yp_channel_inbound (
      inbound_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      provider_message_id TEXT NOT NULL,
      provider_request_id TEXT NOT NULL,
      sender_digest TEXT NOT NULL,
      conversation_type TEXT NOT NULL CHECK (conversation_type IN ('single', 'group')),
      conversation_digest TEXT NOT NULL,
      message_type TEXT NOT NULL,
      content_digest TEXT,
      run_id TEXT REFERENCES yp_agent_runs(run_id),
      received_at TEXT NOT NULL,
      UNIQUE (provider, connection_id, provider_message_id)
    ) STRICT;

    CREATE INDEX yp_channel_inbound_conversation
      ON yp_channel_inbound(provider, connection_id, conversation_digest, received_at DESC);

    CREATE TABLE yp_channel_outbound (
      outbound_id TEXT PRIMARY KEY,
      inbound_id TEXT NOT NULL UNIQUE REFERENCES yp_channel_inbound(inbound_id),
      run_id TEXT NOT NULL UNIQUE REFERENCES yp_agent_runs(run_id),
      content_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'pending', 'delivering', 'accepted', 'failed', 'unknown'
      )),
      failure_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX yp_channel_outbound_status
      ON yp_channel_outbound(status, updated_at);
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
  readonly agentRuns: AgentRunStore;
  readonly channels: ChannelStore;
  readonly schedules: SchedulerStore;

  constructor(private readonly database: DatabaseSync) {
    this.schemaVersion = applyMigrations(database);
    this.agentRuns = new AgentRunStore(database);
    this.channels = new ChannelStore(database);
    this.schedules = new SchedulerStore(database);
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
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      if (lstatSync(path).isSymbolicLink()) {
        throw new Error('Refusing to open a symbolic link as the Yuanpu metadata database.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    closeSync(openSync(path, 'a', 0o600));
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  }
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
