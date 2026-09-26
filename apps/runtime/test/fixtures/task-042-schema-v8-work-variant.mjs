import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { openYuanpuMetadataDatabase } from '@yuanpu-agent/runtime-kit';

test('a historical schema-v8 Work database gains the dedicated assistant tables without losing Work',
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'yuanpu-task-042-v8-variant-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'automation.sqlite');
    // Start with every other synthetic migration table intact, then model the
    // already-v8 Work lineage that predates dedicated AssistantHost tables.
    const baseline = openYuanpuMetadataDatabase(path);
    baseline.close();
    const seed = new DatabaseSync(path);
    seed.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE yp_assistant_sources;
      DROP TABLE yp_assistant_deliveries;
      DROP TABLE yp_assistant_requests;
      DROP TABLE yp_assistant_bindings;
      ALTER TABLE yp_work_conversations RENAME COLUMN workspace_id TO working_directory;
      INSERT INTO yp_work_conversations(
        conversation_id, pi_session_id, working_directory, created_at, updated_at
      ) VALUES (
        'work:fixture', 'old-work-session', '/synthetic/workspace',
        '2026-09-26T00:00:00.000Z', '2026-09-26T00:00:00.000Z'
      );
    `);
    assert.equal(seed.prepare('SELECT MAX(version) AS version FROM yp_schema_migrations').get().version, 8);
    assert.ok(seed.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table'
      AND name = 'yp_assistant_mirror'`).get());
    seed.close();

    const metadata = openYuanpuMetadataDatabase(path);
    t.after(() => metadata.close());
    const inspection = new DatabaseSync(path, { readOnly: true });
    t.after(() => inspection.close());
    const assistantTables = inspection.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'yp_assistant_bindings', 'yp_assistant_requests',
        'yp_assistant_deliveries', 'yp_assistant_sources'
      ) ORDER BY name`).all().map((row) => row.name);
    assert.deepEqual(assistantTables, [
      'yp_assistant_bindings', 'yp_assistant_deliveries',
      'yp_assistant_requests', 'yp_assistant_sources',
    ], 'an already-v8 Work variant must receive all dedicated assistant tables');
    assert.equal(inspection.prepare(`SELECT pi_session_id FROM yp_work_conversations
      WHERE conversation_id = 'work:fixture'`).get().pi_session_id, 'old-work-session');
    assert.equal(metadata.assistantHost.desktop().channel, 'desktop');
  });
