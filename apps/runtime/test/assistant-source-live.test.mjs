import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
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
    try { return assertion(); } catch { await new Promise((resolveWait) => setTimeout(resolveWait, 80)); }
  }
  return assertion();
}

test('real Runtime source adapter pages saved Work and Assistant turns into Worker durable queue', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-source-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = openYuanpuMetadataDatabase(join(root, 'automation.sqlite'));
  t.after(() => metadata.close());
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
  const sourceHost = new RuntimeAssistantSourceHost(metadata.workConversations, metadata.assistantHost);
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
  const first = new AssistantWorkerManager(options);
  t.after(() => first.stop());
  await first.start();
  const state = join(home, 'state.sqlite');
  await eventually(() => {
    const db = new DatabaseSync(state);
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_events WHERE status='processed'").get().n, 2);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM source_text').get().n, 2);
      assert.equal(db.prepare('SELECT cursor FROM source_feeds WHERE feed_id=?').get('work').cursor,
        workPage.nextCursor);
    } finally { db.close(); }
  });
  await first.stop();
  const second = new AssistantWorkerManager(options);
  t.after(() => second.stop());
  await second.start();
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  await second.stop();
  const db = new DatabaseSync(state);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM source_events').get().n, 2,
    'restarting Worker and polling the same host changes must not duplicate the queue');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM source_text').get().n, 2);
  db.close();
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
  const host = new RuntimeAssistantSourceHost(metadata.workConversations, metadata.assistantHost);
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
