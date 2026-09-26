import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  openYuanpuMetadataDatabase,
  YUANPU_METADATA_SCHEMA_VERSION,
  YUANPU_SQLITE_DRIVER,
} from '../dist/index.mjs';

test('migrates a real SQLite file and preserves metadata across reopen', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-metadata-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'nested', 'automation.sqlite');

  const database = openYuanpuMetadataDatabase(path);
  assert.equal(database.driver, YUANPU_SQLITE_DRIVER);
  assert.equal(database.schemaVersion, YUANPU_METADATA_SCHEMA_VERSION);
  database.setMetadata('fixture', 'first');
  assert.equal(database.incrementMetadataCounter('open-count'), 1);
  database.close();

  const reopened = openYuanpuMetadataDatabase(path);
  assert.equal(reopened.getMetadata('fixture'), 'first');
  assert.equal(reopened.incrementMetadataCounter('open-count'), 2);
  reopened.close();
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(root, 'nested'))).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }

  const inspection = new DatabaseSync(path, { readOnly: true });
  const tables = inspection.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'yp_%'
    ORDER BY name
  `).all().map((row) => row.name);
  assert.deepEqual(tables, [
    'yp_agent_run_outputs',
    'yp_agent_run_queue_payloads',
    'yp_agent_runs',
    'yp_assistant_bindings',
    'yp_assistant_deliveries',
    'yp_assistant_legacy_memory_events',
    'yp_assistant_mirror',
    'yp_assistant_requests',
    'yp_assistant_source_deletions',
    'yp_assistant_sources',
    'yp_channel_connections',
    'yp_channel_inbound',
    'yp_channel_outbound',
    'yp_channel_pairings',
    'yp_channel_private_contacts',
    'yp_conversation_bindings',
    'yp_delivery_attempts',
    'yp_desktop_assistant_link',
    'yp_inbound_deduplication',
    'yp_runtime_metadata',
    'yp_schedule_notification_receipts',
    'yp_schedule_triggers',
    'yp_schedules',
    'yp_schema_migrations',
    'yp_work_conversations',
    'yp_work_evidence_sources',
    'yp_work_source_event_sequence',
    'yp_work_turn_sources',
  ]);
  assert.equal(
    inspection.prepare('SELECT MAX(version) AS version FROM yp_schema_migrations').get().version,
    YUANPU_METADATA_SCHEMA_VERSION,
  );
  const runColumns = inspection.prepare('PRAGMA table_info(yp_agent_runs)').all()
    .map((row) => row.name);
  assert.equal(runColumns.includes('request_json'), false);
  assert.equal(runColumns.includes('request_metadata_json'), true);
  assert.equal(runColumns.includes('input_digest'), true);
  assert.equal(runColumns.includes('subject_id'), true);
  assert.equal(runColumns.includes('external_effect_state'), true);
  assert.equal(runColumns.includes('approval_request_id'), true);
  inspection.close();
});

test('v11 metadata gains deletion and legacy source ledgers without rewriting saved Work turns', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-metadata-v11-sources-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'automation.sqlite');
  openYuanpuMetadataDatabase(path).close();
  const old = new DatabaseSync(path);
  old.exec(`DROP TABLE yp_work_evidence_sources;
    DELETE FROM yp_schema_migrations WHERE version=14;
    DROP TABLE yp_assistant_source_deletions;
    DROP TABLE yp_assistant_legacy_memory_events;
    DELETE FROM yp_schema_migrations WHERE version=12;
    PRAGMA user_version=11;`);
  old.prepare(`INSERT INTO yp_work_turn_sources(conversation_id,turn_id,run_id,content_ref,
    source_version,committed_at,user_text,assistant_text) VALUES (?,?,?,?,?,?,?,?)`)
    .run('work:test', 'turn-1', 'run-1', 'ref-1', 'hash-1', '2026-09-27T00:00:00Z', 'u', 'a');
  const eventId = old.prepare('SELECT event_id FROM yp_work_turn_sources').get().event_id;
  old.close();
  const upgraded = openYuanpuMetadataDatabase(path);
  assert.equal(upgraded.schemaVersion, YUANPU_METADATA_SCHEMA_VERSION);
  assert.equal(upgraded.workConversations.sourcePage(0, 1)[0].eventId, eventId);
  assert.deepEqual(upgraded.assistantSourceLifecycle.deletionPage('work', 0, 10), []);
  upgraded.close();
});

test('repairs both historical schema v8 shapes and a v9 Work database without losing records', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-metadata-v8-collision-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const now = '2026-09-26T00:00:00.000Z';
  for (const variant of ['work-v8', 'work-v9', 'assistant-v8']) {
    const path = join(root, `${variant}.sqlite`);
    const seeded = openYuanpuMetadataDatabase(path);
    seeded.assistantHost.desktop();
    seeded.close();
    const old = new DatabaseSync(path);
    old.exec('PRAGMA foreign_keys = OFF');
    old.exec('DELETE FROM yp_schema_migrations WHERE version >= 9; PRAGMA user_version = 8;');
    old.prepare(`INSERT INTO yp_work_conversations(conversation_id, pi_session_id, workspace_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run(`work-${variant}`, `pi-${variant}`, '/original-workspace', now, now);
    old.prepare(`INSERT INTO yp_channel_connections(provider, connection_id, provider_account_digest,
      credential_binding_digest, created_at) VALUES ('wecom', ?, ?, ?, ?)`).run(
      `connection-${variant}`, 'a'.repeat(64), 'b'.repeat(64), now);
    old.prepare(`INSERT INTO yp_channel_pairings(provider, connection_id, sender_digest, created_at)
      VALUES ('wecom', ?, ?, ?)`).run(`connection-${variant}`, 'c'.repeat(64), now);
    old.prepare(`INSERT INTO yp_desktop_assistant_link(id, contact_id, connection_id, target_id,
      previous_pi_session_id, linked_pi_session_id, updated_at)
      VALUES (1, 'old-contact', ?, 'old-target', 'old-desktop', 'old-wecom', ?)`)
      .run(`connection-${variant}`, now);
    old.prepare(`INSERT INTO yp_agent_runs(run_id, entry_point, authority_id, subject_id, idempotency_key,
      request_fingerprint, input_digest, request_metadata_json, status, external_effect_state,
      created_at, updated_at) VALUES (?, 'desktop', 'local-desktop', 'local-user', ?, ?, ?, '{}',
      'succeeded', 'none', ?, ?)`).run(`run-${variant}`, `key-${variant}`, 'd'.repeat(64),
      'e'.repeat(64), now, now);
    old.prepare(`INSERT INTO yp_assistant_mirror(mirror_id, run_id, part, target_id, content,
      content_digest, status, created_at, updated_at) VALUES (?, ?, 'assistant', 'old-target',
      'old archived reply', ?, 'accepted', ?, ?)`).run(`mirror-${variant}`, `run-${variant}`,
      'f'.repeat(64), now, now);
    if (variant.startsWith('work')) {
      old.exec(`DROP TABLE yp_assistant_sources; DROP TABLE yp_assistant_deliveries;
        DROP TABLE yp_assistant_requests; DROP TABLE yp_assistant_bindings;
        UPDATE yp_work_conversations SET working_directory = workspace_id;`);
      if (variant === 'work-v9') {
        old.prepare('INSERT INTO yp_schema_migrations(version, applied_at) VALUES (9, ?)').run(now);
        old.exec('PRAGMA user_version = 9');
      }
    } else {
      old.exec('ALTER TABLE yp_work_conversations DROP COLUMN working_directory;');
    }
    old.close();

    for (let open = 0; open < 2; open++) {
      const upgraded = openYuanpuMetadataDatabase(path);
      assert.equal(upgraded.schemaVersion, YUANPU_METADATA_SCHEMA_VERSION);
      assert.equal(upgraded.channels.isPaired('wecom', `connection-${variant}`, 'c'.repeat(64)), true);
      upgraded.close();
      const inspected = new DatabaseSync(path, { readOnly: true });
      const assistantTables = inspected.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
        AND name IN ('yp_assistant_bindings', 'yp_assistant_requests', 'yp_assistant_deliveries', 'yp_assistant_sources')`).all();
      assert.equal(assistantTables.length, 4, variant);
      assert.equal(inspected.prepare('SELECT COUNT(*) AS count FROM yp_assistant_bindings').get().count,
        variant === 'assistant-v8' ? 1 : 0);
      assert.equal(inspected.prepare('SELECT COUNT(*) AS count FROM yp_work_conversations').get().count, 1);
      assert.equal(inspected.prepare('SELECT working_directory FROM yp_work_conversations').get().working_directory,
        '/original-workspace');
      assert.equal(inspected.prepare('SELECT previous_pi_session_id FROM yp_desktop_assistant_link').get()
        .previous_pi_session_id, 'old-desktop');
      assert.equal(inspected.prepare('SELECT content FROM yp_assistant_mirror').get().content,
        'old archived reply');
      assert.equal(inspected.prepare('SELECT MAX(version) AS version FROM yp_schema_migrations').get().version,
        YUANPU_METADATA_SCHEMA_VERSION);
      inspected.close();
    }
  }
});

test('incompatible assistant table blocks repair atomically and leaves migration version unchanged', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-metadata-v8-conflict-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'automation.sqlite');
  openYuanpuMetadataDatabase(path).close();
  const old = new DatabaseSync(path);
  old.exec(`PRAGMA foreign_keys = OFF;
    DELETE FROM yp_schema_migrations WHERE version >= 9;
    PRAGMA user_version = 8;
    DROP TABLE yp_assistant_sources; DROP TABLE yp_assistant_deliveries;
    DROP TABLE yp_assistant_requests; DROP TABLE yp_assistant_bindings;
    CREATE TABLE yp_assistant_requests (wrong_column TEXT) STRICT;`);
  old.close();
  assert.throws(() => openYuanpuMetadataDatabase(path), /incompatible|repair/i);
  const inspected = new DatabaseSync(path, { readOnly: true });
  assert.equal(inspected.prepare('SELECT MAX(version) AS version FROM yp_schema_migrations').get().version, 8);
  assert.equal(inspected.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'
    AND name = 'yp_assistant_bindings'`).get().count, 0);
  inspected.close();
});

test('a database marked current fails closed if an Assistant Host table is missing', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-metadata-current-missing-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'automation.sqlite');
  openYuanpuMetadataDatabase(path).close();
  const damaged = new DatabaseSync(path);
  damaged.exec('PRAGMA foreign_keys = OFF; DROP TABLE yp_assistant_sources;');
  damaged.close();
  assert.throws(() => openYuanpuMetadataDatabase(path), /Missing Assistant Host schema object/);
});

test('a historical Work directory shape without workspace_id is rejected without version advancement', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-metadata-work-shape-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'automation.sqlite');
  openYuanpuMetadataDatabase(path).close();
  const malformed = new DatabaseSync(path);
  malformed.exec(`PRAGMA foreign_keys = OFF;
    DELETE FROM yp_schema_migrations WHERE version >= 9;
    PRAGMA user_version = 8;
    ALTER TABLE yp_work_conversations DROP COLUMN workspace_id;`);
  malformed.close();
  assert.throws(() => openYuanpuMetadataDatabase(path), /Incompatible Work workspace_id column/);
  const inspected = new DatabaseSync(path, { readOnly: true });
  assert.equal(inspected.prepare('SELECT MAX(version) AS version FROM yp_schema_migrations').get().version, 8);
  inspected.close();
});

test('schema isolates subjects and requires durable approval/effect checkpoints', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-metadata-constraints-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'automation.sqlite');
  openYuanpuMetadataDatabase(path).close();
  const database = new DatabaseSync(path);
  database.exec('PRAGMA foreign_keys = ON');
  const insert = database.prepare(`
    INSERT INTO yp_agent_runs(
      run_id, entry_point, authority_id, subject_id, idempotency_key,
      request_fingerprint, input_digest, request_metadata_json, status,
      external_effect_state, created_at, updated_at
    ) VALUES (?, 'im', 'shared-connection', ?, 'message-1', ?, ?, '{}', ?, ?, ?, ?)
  `);
  const now = '2026-09-22T00:00:00.000Z';
  insert.run('run-a', 'user-a', 'a'.repeat(64), 'b'.repeat(64), 'queued', 'none', now, now);
  insert.run('run-b', 'user-b', 'c'.repeat(64), 'd'.repeat(64), 'queued', 'none', now, now);
  database.prepare(`
    INSERT INTO yp_conversation_bindings(
      binding_id, entry_point, authority_id, subject_id, namespace,
      conversation_id, pi_session_id, workspace_id, created_at, updated_at
    ) VALUES ('binding-a', 'im', 'shared-connection', 'user-a', 'channel',
      'conversation', 'pi-session', '/workspace', ?, ?)
  `).run(now, now);
  assert.throws(() => database.prepare(`
    INSERT INTO yp_agent_runs(
      run_id, entry_point, authority_id, subject_id, idempotency_key,
      request_fingerprint, input_digest, request_metadata_json, binding_id,
      status, external_effect_state, created_at, updated_at
    ) VALUES ('run-cross-binding', 'im', 'shared-connection', 'user-b', 'message-2',
      ?, ?, '{}', 'binding-a', 'queued', 'none', ?, ?)
  `).run('3'.repeat(64), '4'.repeat(64), now, now), /FOREIGN KEY constraint failed/);
  assert.throws(() => database.prepare(`
    INSERT INTO yp_inbound_deduplication(
      entry_point, authority_id, subject_id, external_message_id, run_id, received_at
    ) VALUES ('im', 'shared-connection', 'user-b', 'external-message', 'run-a', ?)
  `).run(now), /FOREIGN KEY constraint failed/);
  assert.throws(
    () => insert.run('run-wait', 'user-c', 'e'.repeat(64), 'f'.repeat(64), 'waiting_approval', 'none', now, now),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insert.run('run-unknown', 'user-c', '1'.repeat(64), '2'.repeat(64), 'result_unknown', 'none', now, now),
    /CHECK constraint failed/,
  );
  database.close();
});

test('an unresolved scheduled native receipt becomes unknown after restart', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-notification-recovery-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'automation.sqlite');
  const now = '2026-09-23T00:00:00.000Z';
  const first = openYuanpuMetadataDatabase(path);
  const inspection = new DatabaseSync(path);
  inspection.prepare(`
    INSERT INTO yp_agent_runs(
      run_id, entry_point, authority_id, subject_id, idempotency_key,
      request_fingerprint, input_digest, request_metadata_json, status,
      external_effect_state, created_at, updated_at
    ) VALUES ('scheduled-run', 'scheduler', 'local-runtime', 'local-scheduler',
      'scheduled-trigger', ?, ?, '{}', 'succeeded', 'none', ?, ?)
  `).run('a'.repeat(64), 'b'.repeat(64), now, now);
  inspection.close();
  first.schedules.beginNotification('scheduled-run', now);
  first.close();

  const reopened = openYuanpuMetadataDatabase(path);
  reopened.schedules.recoverNotifications('2026-09-23T00:01:00.000Z');
  reopened.schedules.finishNotification('scheduled-run', 'submitted', '2026-09-23T00:02:00.000Z');
  reopened.close();
  const recovered = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    recovered.prepare('SELECT status FROM yp_schedule_notification_receipts WHERE run_id = ?')
      .get('scheduled-run').status,
    'result_unknown',
  );
  recovered.close();
});

test('upgrades populated schema v4 metadata without losing pairings', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-metadata-v4-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'automation.sqlite');
  const now = '2026-09-23T00:00:00.000Z';
  openYuanpuMetadataDatabase(path).close();
  const v4 = new DatabaseSync(path);
  v4.exec(`
    DROP TABLE yp_assistant_sources;
    DROP TABLE yp_assistant_deliveries;
    DROP TABLE yp_assistant_requests;
    DROP TABLE yp_assistant_bindings;
    DROP TABLE yp_work_turn_sources;
    DROP TABLE yp_work_conversations;
    DROP TABLE yp_assistant_mirror;
    DROP TABLE yp_desktop_assistant_link;
    DROP TABLE yp_schedule_notification_receipts;
    DROP TABLE yp_channel_private_contacts;
    DELETE FROM yp_schema_migrations WHERE version >= 5;
    PRAGMA user_version = 4;
  `);
  v4.prepare(`
    INSERT INTO yp_channel_connections(
      provider, connection_id, provider_account_digest, credential_binding_digest, created_at
    ) VALUES ('wecom', 'legacy-connection', ?, ?, ?)
  `).run('a'.repeat(64), 'b'.repeat(64), now);
  v4.prepare(`
    INSERT INTO yp_channel_pairings(provider, connection_id, sender_digest, created_at)
    VALUES ('wecom', 'legacy-connection', ?, ?)
  `).run('c'.repeat(64), now);
  v4.close();

  const upgraded = openYuanpuMetadataDatabase(path);
  assert.equal(upgraded.schemaVersion, YUANPU_METADATA_SCHEMA_VERSION);
  assert.equal(upgraded.channels.isPaired('wecom', 'legacy-connection', 'c'.repeat(64)), true);
  upgraded.close();
  const inspection = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    inspection.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name IN ('yp_channel_private_contacts', 'yp_schedule_notification_receipts')
    `).get().count,
    2,
  );
  inspection.close();
});

test('refuses a symbolic-link database target', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-metadata-link-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'target.sqlite');
  new DatabaseSync(target).close();
  const link = join(root, 'automation.sqlite');
  await symlink(target, link);
  assert.throws(() => openYuanpuMetadataDatabase(link), /symbolic link/);
});

test('migration preserves a pre-existing real file fixture', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-metadata-legacy-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'automation.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec('CREATE TABLE legacy_fixture(value TEXT NOT NULL) STRICT');
  legacy.prepare('INSERT INTO legacy_fixture(value) VALUES (?)').run('preserve-me');
  legacy.close();

  openYuanpuMetadataDatabase(path).close();
  const inspection = new DatabaseSync(path, { readOnly: true });
  assert.equal(inspection.prepare('SELECT value FROM legacy_fixture').get().value, 'preserve-me');
  inspection.close();
});

test('migration upgrades a schema-v1 run database without losing records', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-metadata-v1-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'automation.sqlite');
  const v1 = new DatabaseSync(path);
  v1.exec(`
    CREATE TABLE yp_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO yp_schema_migrations(version, applied_at) VALUES (1, 'fixture');
    CREATE TABLE yp_agent_runs (
      run_id TEXT PRIMARY KEY,
      entry_point TEXT NOT NULL,
      authority_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      request_metadata_json TEXT NOT NULL,
      binding_id TEXT,
      status TEXT NOT NULL,
      external_effect_state TEXT NOT NULL,
      approval_request_id TEXT,
      approval_session_id TEXT,
      approval_workspace_id TEXT,
      approval_expires_at TEXT,
      output_digest TEXT,
      failure_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO yp_agent_runs(
      run_id, entry_point, authority_id, subject_id, idempotency_key,
      request_fingerprint, input_digest, request_metadata_json, status,
      external_effect_state, created_at, updated_at
    ) VALUES (
      'v1-run', 'desktop', 'desktop', 'user', 'request',
      '${'a'.repeat(64)}', '${'b'.repeat(64)}', '{}', 'succeeded',
      'possible', 'fixture', 'fixture'
    );
    INSERT INTO yp_agent_runs(
      run_id, entry_point, authority_id, subject_id, idempotency_key,
      request_fingerprint, input_digest, request_metadata_json, status,
      external_effect_state, created_at, updated_at
    ) VALUES (
      'v1-queued', 'desktop', 'desktop', 'user', 'queued-request',
      '${'c'.repeat(64)}', '${'d'.repeat(64)}', '{}', 'queued',
      'none', 'fixture', 'fixture'
    );
  `);
  v1.close();

  const migrated = openYuanpuMetadataDatabase(path);
  assert.equal(migrated.schemaVersion, YUANPU_METADATA_SCHEMA_VERSION);
  migrated.close();
  const inspection = new DatabaseSync(path, { readOnly: true });
  assert.equal(inspection.prepare(
    'SELECT status FROM yp_agent_runs WHERE run_id = ?',
  ).get('v1-run').status, 'succeeded');
  const migratedQueued = inspection.prepare(`
    SELECT status, failure_code, failure_message, failure_retryable
    FROM yp_agent_runs WHERE run_id = ?
  `).get('v1-queued');
  assert.equal(migratedQueued.status, 'interrupted');
  assert.equal(migratedQueued.failure_code, 'migration_payload_unavailable');
  assert.equal(
    migratedQueued.failure_message,
    'Queued input was not retained by metadata schema v1 and cannot be resumed.',
  );
  assert.equal(migratedQueued.failure_retryable, 1);
  const columns = inspection.prepare('PRAGMA table_info(yp_agent_runs)').all().map((row) => row.name);
  assert.equal(columns.includes('failure_message'), true);
  assert.equal(columns.includes('failure_retryable'), true);
  inspection.close();
});

test('refuses a database created by a newer Yuanpu schema', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-metadata-newer-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'automation.sqlite');
  const newer = new DatabaseSync(path);
  newer.exec(`
    CREATE TABLE yp_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO yp_schema_migrations(version, applied_at) VALUES (99, 'fixture');
  `);
  newer.close();

  assert.throws(
    () => openYuanpuMetadataDatabase(path),
    new RegExp(`schema 99 is newer than supported ${YUANPU_METADATA_SCHEMA_VERSION}`),
  );
});
