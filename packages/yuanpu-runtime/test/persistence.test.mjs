import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
  inspection.close();
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

