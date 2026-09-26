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
      INSERT INTO yp_work_conversations(
        conversation_id, pi_session_id, workspace_id, created_at, updated_at
      ) VALUES (
        'work:fixture', 'old-work-session', '/synthetic/workspace',
        '2026-09-26T00:00:00.000Z', '2026-09-26T00:00:00.000Z'
      );
      ALTER TABLE yp_work_conversations ADD COLUMN working_directory TEXT NOT NULL DEFAULT '';
      UPDATE yp_work_conversations SET working_directory = workspace_id;
    `);
    assert.equal(seed.prepare('SELECT MAX(version) AS version FROM yp_schema_migrations').get().version, 8);
    assert.ok(seed.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table'
      AND name = 'yp_assistant_mirror'`).get());
    const columns = seed.prepare('PRAGMA table_info(yp_work_conversations)').all().map((row) => row.name);
    assert.equal(columns.includes('workspace_id') && columns.includes('working_directory'), true);
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
    assert.deepEqual(inspection.prepare(`SELECT pi_session_id, workspace_id, working_directory
      FROM yp_work_conversations WHERE conversation_id = 'work:fixture'`).get(), {
      pi_session_id: 'old-work-session', workspace_id: '/synthetic/workspace',
      working_directory: '/synthetic/workspace',
    });
    assert.ok(inspection.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table'
      AND name = 'yp_assistant_mirror'`).get());
    assert.equal(metadata.assistantHost.desktop().channel, 'desktop');
  });
