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
    'yp_agent_runs',
    'yp_conversation_bindings',
    'yp_delivery_attempts',
    'yp_inbound_deduplication',
    'yp_runtime_metadata',
    'yp_schema_migrations',
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

test('schema isolates subjects and requires durable approval/effect checkpoints', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-metadata-constraints-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'automation.sqlite');
  openYuanpuMetadataDatabase(path).close();
  const database = new DatabaseSync(path);
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
    /schema 99 is newer than supported 1/,
  );
});
