import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openYuanpuMetadataDatabase } from '@yuanpu-agent/runtime-kit';

const require = createRequire(import.meta.url);
const { AssistantWorkerManager, RuntimeAssistantSourceHost } = require('../dist/index.cjs');
const entry = resolve(import.meta.dirname, '../dist/index.cjs');
const person = { kind: 'personal', id: 'local-user' };

async function eventually(assertion) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { return await assertion(); } catch { await new Promise((resolveWait) => setTimeout(resolveWait, 80)); }
  }
  return assertion();
}

test('real Runtime source adapter pages saved Work and Assistant turns into Worker durable queue', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-source-live-'));
  const metadata = openYuanpuMetadataDatabase(join(root, 'automation.sqlite'));
  let first;
  let second;
  t.after(async () => {
    await second?.stop();
    await first?.stop();
    metadata.close();
    await rm(root, { recursive: true, force: true });
  });
  const at = '2026-09-27T00:00:00.000Z';
  const workRef = `work-content:${createHash('sha256')
    .update('work-turn:work:fixture:turn-1').digest('hex')}`;
  metadata.database.prepare(`INSERT INTO yp_work_turn_sources(conversation_id,turn_id,run_id,
    content_ref,source_version,committed_at,user_text,assistant_text)
    VALUES (?,?,?,?,?,?,?,?)`).run('work:fixture', 'turn-1', 'run-1', workRef,
      'hash-one', at, '项目进展怎样', '项目进展已核实');
  metadata.assistantHost.recordLegacyArchive('assistant-session', [
    { id: 'user-1', role: 'user', text: '助理对话中文内容', at },
    { id: 'assistant-1', role: 'assistant', text: '已记录', at },
  ]);
  const sourceHost = new RuntimeAssistantSourceHost(metadata.workConversations, metadata.assistantHost,
    metadata.assistantSourceLifecycle);
  const workPage = await sourceHost.listChanges('work', '0', 1);
  assert.equal(workPage.events.length, 1);
  assert.deepEqual(await sourceHost.listChanges('work', workPage.nextCursor, 1),
    { events: [], nextCursor: workPage.nextCursor });
  assert.equal((await sourceHost.readSource(workRef, workPage.events[0].change.sourceId,
    'hash-one', person, 32_000)).status, 'available');
  await assert.rejects(sourceHost.readSource(workRef, workPage.events[0].change.sourceId,
    'hash-one', { kind: 'personal', id: 'stranger' }, 32_000), /not authorized/);
  assert.equal((await sourceHost.readSource('work-content:wrong', workPage.events[0].change.sourceId,
    'hash-one', person, 32_000)).status, 'temporarily_unavailable');
  const home = join(root, 'assistant');
  const options = { home, model: { appPath: root, agentPath: root, provider: 'fixture', model: 'fixture' },
    sources: sourceHost, command: { executable: process.execPath, args: [entry, '--assistant-worker'] } };
  first = new AssistantWorkerManager(options);
  await first.start();
  const state = join(home, 'state.sqlite');
  await eventually(() => {
    const db = new DatabaseSync(state);
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_events WHERE status='processed'").get().n, 2);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM source_text').get().n, 2);
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM automation_jobs
        WHERE kind IN ('review-work','understand-user')`).get().n, 2,
      'real saved turns must enter the durable assistant automation queue');
      assert.equal(db.prepare('SELECT cursor FROM source_feeds WHERE feed_id=?').get('work').cursor,
        workPage.nextCursor);
    } finally { db.close(); }
  });
  const deleted = sourceHost.markDeleted('work', workPage.events[0].change.sourceId);
  assert.equal(deleted.kind, 'deleted');
  assert.equal((await sourceHost.currentSource(deleted.sourceId, person)).status, 'deleted');
  assert.equal((await sourceHost.readSource(workRef, deleted.sourceId, 'hash-one', person,
    32_000)).status, 'deleted');
  await eventually(() => {
    const db = new DatabaseSync(state);
    try {
      assert.equal(db.prepare(`SELECT availability FROM source_current WHERE source_id=?`)
        .get(deleted.sourceId).availability, 'deleted');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM source_text WHERE source_id=?')
        .get(deleted.sourceId).n, 0);
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM automation_jobs
        WHERE kind='maintain-memory' AND source_id=?`).get(deleted.sourceId).n, 1);
    } finally { db.close(); }
  });
  await first.stop();
  second = new AssistantWorkerManager(options);
  await second.start();
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  await second.stop();
  const db = new DatabaseSync(state);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM source_events').get().n, 3,
    'restarting Worker and polling the same host changes must not duplicate the queue');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM source_text').get().n, 1);
  db.close();
});

test('legacy MEMORY is read through Host once and A→B→A receives unique durable event IDs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-legacy-memory-'));
  const legacyDir = join(root, 'agent', 'memory');
  await mkdir(legacyDir, { recursive: true });
  const legacyPath = join(legacyDir, 'MEMORY.md');
  await writeFile(legacyPath, '旧版偏好：每周查看项目。');
  const metadata = openYuanpuMetadataDatabase(join(root, 'automation.sqlite'));
  let manager;
  let restarted;
  t.after(async () => {
    await restarted?.stop();
    await manager?.stop();
    metadata.close();
    await rm(root, { recursive: true, force: true });
  });
  const host = new RuntimeAssistantSourceHost(metadata.workConversations, metadata.assistantHost,
    metadata.assistantSourceLifecycle, legacyPath);
  const firstPage = await host.listChanges('legacy-memory', '0', 1);
  await writeFile(legacyPath, '旧版偏好：每月查看项目。');
  const secondPage = await host.listChanges('legacy-memory', firstPage.nextCursor, 1);
  await writeFile(legacyPath, '旧版偏好：每周查看项目。');
  const thirdPage = await host.listChanges('legacy-memory', secondPage.nextCursor, 1);
  assert.deepEqual([firstPage, secondPage, thirdPage].map((page) => page.events[0].eventId),
    ['1', '2', '3']);
  assert.equal(firstPage.events[0].change.sourceVersion, thirdPage.events[0].change.sourceVersion);
  const home = join(root, 'assistant');
  manager = new AssistantWorkerManager({ home, model: { appPath: root, agentPath: root,
    provider: 'fixture', model: 'fixture' }, sources: host,
  command: { executable: process.execPath, args: [entry, '--assistant-worker'] } });
  await manager.start();
  const imported = join(home, 'memories', 'notes', 'legacy-memory.md');
  await eventually(async () => assert.match(await readFile(imported, 'utf8'), /每周查看项目/));
  await writeFile(legacyPath, '旧版偏好：每月查看项目。');
  await eventually(async () => assert.match(await readFile(imported, 'utf8'), /每月查看项目/));
  await manager.stop();
  const original = await readFile(imported, 'utf8');
  await writeFile(imported, original.replace('每月查看项目', '按需查看项目'));
  await writeFile(legacyPath, '旧版偏好：每季度查看项目。');
  restarted = new AssistantWorkerManager({ home, model: { appPath: root, agentPath: root,
    provider: 'fixture', model: 'fixture' }, sources: host,
  command: { executable: process.execPath, args: [entry, '--assistant-worker'] } });
  await restarted.start();
  await eventually(async () => {
    assert.match(await readFile(imported, 'utf8'), /按需查看项目/);
    const db = new DatabaseSync(join(home, 'state.sqlite'));
    try { assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM memory_import_conflicts
      WHERE memory_id='legacy-memory'`).get().n, 1); }
    finally { db.close(); }
  });
  await restarted.stop();
  if (process.platform !== 'win32') {
    const privateFile = join(root, 'not-a-source.txt');
    await writeFile(privateFile, 'PRIVATE FIXTURE');
    await rm(legacyPath);
    await symlink(privateFile, legacyPath);
    await assert.rejects(host.listChanges('legacy-memory', thirdPage.nextCursor, 1), /real file/);
  }
});

test('large Work history is read in bounded pages without skipping its durable cursor', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-source-page-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = openYuanpuMetadataDatabase(join(root, 'automation.sqlite'));
  t.after(() => metadata.close());
  const insert = metadata.database.prepare(`INSERT INTO yp_work_turn_sources(conversation_id,turn_id,
    run_id,content_ref,source_version,committed_at,user_text,assistant_text)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (let index = 0; index < 205; index++) {
    const sourceId = `work-turn:work:fixture:turn-${index}`;
    insert.run('work:fixture', `turn-${index}`, `run-${index}`,
      `work-content:${createHash('sha256').update(sourceId).digest('hex')}`,
      `hash-${index}`, '2026-09-27T00:00:00.000Z', `user ${index}`, `answer ${index}`);
  }
  const host = new RuntimeAssistantSourceHost(metadata.workConversations, metadata.assistantHost,
    metadata.assistantSourceLifecycle);
  let cursor = '0';
  const sizes = [];
  const IDs = [];
  for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
    const page = await host.listChanges('work', cursor, 100);
    sizes.push(page.events.length);
    IDs.push(...page.events.map((event) => event.eventId));
    cursor = page.nextCursor;
  }
  assert.deepEqual(sizes, [100, 100, 5]);
  assert.equal(new Set(IDs).size, 205);
  assert.deepEqual(await host.listChanges('work', cursor, 100), { events: [], nextCursor: cursor });
  assert.equal((await host.currentSource('work-turn:work:fixture:turn-204', person)).sourceVersion,
    'hash-204');
});
