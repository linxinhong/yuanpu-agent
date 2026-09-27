import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AssistantAutomationStore, AssistantMemoryRepository,
  AssistantUserUnderstanding, parseUnderstandingProposal } from '../dist/index.mjs';

const audience = { kind: 'personal', id: 'local-user' };
const at = '2026-09-27T00:00:00.000Z';

test('TASK-047 persisted profile correction and forget survive replay and restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-stage-047-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'assistant');
  const changes = [
    { id: 'work-turn:first', workId: 'work:first', text: 'User: 我喜欢徒步。\nAssistant: 已记录。' },
    { id: 'work-turn:second', workId: 'work:second', text: 'User: 我喜欢徒步。\nAssistant: 已记录。' },
    { id: 'assistant-turn:correction', text: 'User: 我不再喜欢徒步，我喜欢绘画。\nAssistant: 明白。' },
  ];
  const host = {
    async listChanges(feed, cursor) {
      const events = changes.filter((item) => item.id.startsWith(`${feed}-`))
        .map((item, index) => ({ eventId: String(index + 1), change: {
          sourceId: item.id, sourceVersion: 'v1', kind: 'created', audience,
          occurredAt: at, contentRef: `opaque:${item.id}`,
          ...(item.workId ? { workId: item.workId } : {}),
        } })).filter((item) => Number(item.eventId) > Number(cursor));
      return { events, nextCursor: events.at(-1)?.eventId ?? cursor };
    },
    async currentSource() { return { status: 'available', sourceVersion: 'v1' }; },
    async readSource(ref, sourceId) {
      assert.equal(ref, `opaque:${sourceId}`);
      return { status: 'available', sourceVersion: 'v1',
        text: changes.find((item) => item.id === sourceId).text };
    },
  };
  let memory = await AssistantMemoryRepository.open(home);
  const automation = new AssistantAutomationStore(memory.sources.database);
  const understanding = new AssistantUserUnderstanding(memory, () => new Date(at));
  assert.equal(await memory.sources.sync(host, 'work'), 2);
  assert.equal(await memory.sources.sync(host, 'assistant'), 1);
  for (let index = 0; index < 3; index++) assert.equal((await memory.processNext(host)).status, 'processed');
  const record = (sourceId, quote, supersedes = []) => {
    const job = automation.enqueue({ kind: 'understand-user', dedupeKey: `stage:${sourceId}`,
      sourceId, sourceVersion: 'v1', audience });
    automation.start(job.jobId);
    const snapshot = understanding.snapshot(job);
    assert.ok(snapshot);
    understanding.record(job, snapshot, parseUnderstandingProposal(JSON.stringify({
      observations: [{ topic: 'interests', quote, supersedes }],
    })), (commit) => automation.commit(job.jobId, commit),
    (checkpoint) => automation.recordCheckpoint(job, checkpoint));
  };
  record('work-turn:first', '我喜欢徒步。');
  record('work-turn:second', '我喜欢徒步。');
  await understanding.reconcile();
  const profile = join(home, 'memories', 'user', 'interests.md');
  assert.match(await readFile(profile, 'utf8'), /我喜欢徒步/u);
  memory.sources.database.prepare(`UPDATE source_current SET availability='temporarily_unavailable'
    WHERE source_id='work-turn:first'`).run();
  await understanding.reconcile();
  assert.match(await readFile(profile, 'utf8'), /我喜欢徒步/u,
    'temporary source loss must preserve the remaining supported statement');
  memory.sources.database.prepare(`UPDATE source_current SET availability='available'
    WHERE source_id='work-turn:first'`).run();
  record('assistant-turn:correction', '我喜欢绘画。', ['我喜欢徒步。']);
  await understanding.reconcile();
  assert.match(await readFile(profile, 'utf8'), /我喜欢绘画/u);
  assert.doesNotMatch(await readFile(profile, 'utf8'), /我喜欢徒步/u);
  assert.equal((await memory.get('user-interests')).status, 'active');
  await memory.forget('user-interests');
  assert.equal(await memory.get('user-interests'), undefined);
  assert.equal(memory.sources.database.prepare(`SELECT COUNT(*) AS n FROM forgotten_sources`).get().n, 3);
  assert.equal((await memory.search('绘画', audience)).length, 0);
  memory.close();

  memory = await AssistantMemoryRepository.open(home);
  assert.equal(await memory.sources.sync(host, 'work'), 0);
  assert.equal(await memory.sources.sync(host, 'assistant'), 0);
  assert.equal(await memory.processNext(host), undefined);
  const restarted = new AssistantUserUnderstanding(memory, () => new Date(at));
  await restarted.reconcile();
  assert.equal(await memory.get('user-interests'), undefined);
  assert.equal((await memory.search('绘画', audience)).length, 0);
  assert.equal((await memory.search('徒步', audience)).length, 0);
  assert.equal(memory.sources.database.prepare(`SELECT COUNT(*) AS n FROM assistant_user_observations`).get().n,
    0);
  memory.close();
});
