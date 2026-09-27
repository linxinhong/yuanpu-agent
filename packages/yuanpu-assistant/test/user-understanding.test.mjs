import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AssistantAutomationStore, AssistantMemoryRepository,
  AssistantUserUnderstanding, parseUnderstandingProposal } from '../dist/index.mjs';
import { isDirectUserStatement } from '../dist/index.mjs';

const audience = { kind: 'personal', id: 'local-user' };
const when = '2026-09-27T00:00:00.000Z';

test('source-verified observations promote repeated Work statements and delete with the source', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-understand-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'assistant');
  const memory = await AssistantMemoryRepository.open(home);
  t.after(() => memory.close());
  const automation = new AssistantAutomationStore(memory.sources.database);
  const understanding = new AssistantUserUnderstanding(memory, () => new Date(when));
  const records = new Map();
  const host = {
    async listChanges(feed, cursor) { return { events: (records.get(feed) ?? [])
      .filter((item) => Number(item.eventId) > Number(cursor)), nextCursor: '9' }; },
    async currentSource(id) { return { status: 'available', sourceVersion: 'v1' }; },
    async readSource(_ref, id) { return { status: 'available', sourceVersion: 'v1',
      text: id === 'assistant-turn:correction'
        ? 'User: 其实我不再喜欢安静地阅读，我喜欢户外徒步。\nAssistant: 好的。'
        : id === 'assistant-turn:reaffirm'
          ? 'User: 其实我喜欢安静地阅读。\nAssistant: 明白。'
          : id === 'assistant-turn:busy'
            ? 'User: 我现在很忙。\nAssistant: 好的。'
        : id === 'assistant-turn:other'
          ? 'User: 我喜欢滑雪。\nAssistant: 好的。'
        : id.startsWith('assistant-') ? 'User: 我喜欢安静地阅读。\nAssistant: 好的。'
        : 'User: 我喜欢安静地阅读。\nAssistant: 已记录。' }; },
  };
  const source = (id, workId) => ({ sourceId: id, sourceVersion: 'v1', kind: 'created',
    audience, occurredAt: when, contentRef: `opaque:${id}`, ...(workId ? { workId } : {}) });
  records.set('work', [
    { eventId: '1', change: source('work-turn:one', 'work:one') },
    { eventId: '2', change: source('work-turn:two', 'work:two') },
  ]);
  records.set('assistant', [
    { eventId: '1', change: source('assistant-turn:one') },
    { eventId: '2', change: source('assistant-turn:correction') },
    { eventId: '3', change: source('assistant-turn:reaffirm') },
    { eventId: '4', change: source('assistant-turn:busy') },
    { eventId: '5', change: source('assistant-turn:other') },
  ]);
  await memory.sources.sync(host, 'work');
  await memory.sources.sync(host, 'assistant');
  for (let n = 0; n < 7; n++) await memory.processNext(host);
  const record = (id) => {
    const job = automation.enqueue({ kind: 'understand-user', dedupeKey: `test:${id}`,
      sourceId: id, sourceVersion: 'v1', audience });
    automation.start(job.jobId);
    const snapshot = understanding.snapshot(job);
    assert.ok(snapshot);
    assert.equal(understanding.record(job, snapshot, parseUnderstandingProposal(JSON.stringify({
      observations: [{ topic: 'interests', quote: '我喜欢安静地阅读。' }],
    })), (write) => automation.commit(job.jobId, write),
    (value) => automation.recordCheckpoint(job, value)), true);
    return job;
  };
  record('work-turn:one');
  await understanding.reconcile();
  assert.equal(await memory.get('user-interests'), undefined,
    'a single Work conversation does not become a lasting user fact');
  record('work-turn:two');
  await understanding.reconcile();
  assert.match((await memory.get('user-interests')).text, /我喜欢安静地阅读/);
  const path = join(home, 'memories', 'user', 'interests.md');
  assert.match(await readFile(path, 'utf8'), /work-turn:one/);
  record('assistant-turn:one');
  await understanding.reconcile();
  assert.match((await memory.get('user-summary')).text, /interests/);
  const busyJob = automation.enqueue({ kind: 'understand-user', dedupeKey: 'test:busy',
    sourceId: 'assistant-turn:busy', sourceVersion: 'v1', audience });
  automation.start(busyJob.jobId);
  understanding.record(busyJob, understanding.snapshot(busyJob),
    parseUnderstandingProposal(JSON.stringify({ observations: [{ topic: 'context',
      quote: '我现在很忙。' }] })), (write) => automation.commit(busyJob.jobId, write),
    (value) => automation.recordCheckpoint(busyJob, value));
  await understanding.reconcile();
  assert.equal(await memory.get('work-context'), undefined,
    'short-lived user state cannot overwrite the Work project index');
  assert.match((await memory.get('work-user-context')).text, /我现在很忙/);
  const otherJob = automation.enqueue({ kind: 'understand-user', dedupeKey: 'test:other',
    sourceId: 'assistant-turn:other', sourceVersion: 'v1', audience });
  automation.start(otherJob.jobId);
  understanding.record(otherJob, understanding.snapshot(otherJob),
    parseUnderstandingProposal(JSON.stringify({ observations: [{ topic: 'interests',
      quote: '我喜欢滑雪。' }] })), (write) => automation.commit(otherJob.jobId, write),
    (value) => automation.recordCheckpoint(otherJob, value));
  await understanding.reconcile();
  memory.sources.database.prepare(`UPDATE source_current
    SET availability='temporarily_unavailable' WHERE source_id IN
      ('assistant-turn:one','assistant-turn:other')`).run();
  const correctionJob = automation.enqueue({ kind: 'understand-user',
    dedupeKey: 'test:correction', sourceId: 'assistant-turn:correction', sourceVersion: 'v1', audience });
  automation.start(correctionJob.jobId);
  const correction = understanding.snapshot(correctionJob);
  assert.ok(correction);
  understanding.record(correctionJob, correction, parseUnderstandingProposal(JSON.stringify({
    observations: [{ topic: 'interests', quote: '我喜欢户外徒步。',
      supersedes: ['我喜欢安静地阅读。'] }],
  })), (write) => automation.commit(correctionJob.jobId, write),
  (value) => automation.recordCheckpoint(correctionJob, value));
  await understanding.reconcile();
  assert.match((await memory.get('user-interests')).text, /户外徒步/);
  assert.doesNotMatch((await memory.get('user-interests')).text, /安静地阅读/);
  assert.match((await memory.get('user-interests')).text, /我喜欢滑雪/,
    'correcting one unavailable interest keeps an unrelated unavailable interest');
  memory.sources.database.prepare(`UPDATE source_current
    SET availability='available' WHERE source_id='assistant-turn:one'`).run();
  const reaffirmJob = automation.enqueue({ kind: 'understand-user', dedupeKey: 'test:reaffirm',
    sourceId: 'assistant-turn:reaffirm', sourceVersion: 'v1', audience });
  automation.start(reaffirmJob.jobId);
  const reaffirm = understanding.snapshot(reaffirmJob);
  understanding.record(reaffirmJob, reaffirm, parseUnderstandingProposal(JSON.stringify({
    observations: [{ topic: 'interests', quote: '我喜欢安静地阅读。',
      supersedes: ['我喜欢户外徒步。'] }],
  })), (write) => automation.commit(reaffirmJob.jobId, write),
  (value) => automation.recordCheckpoint(reaffirmJob, value));
  await understanding.reconcile();
  assert.match((await memory.get('user-interests')).text, /安静地阅读/);
  assert.doesNotMatch((await memory.get('user-interests')).text, /户外徒步/);
  memory.sources.forgetSource('assistant-turn:reaffirm');
  await understanding.reconcile();
  assert.match((await memory.get('user-interests')).text, /户外徒步/);
  memory.sources.forgetSource('assistant-turn:correction');
  await understanding.reconcile();
  assert.match((await memory.get('user-interests')).text, /安静地阅读/,
    'removing the correction restores older available evidence');
  memory.sources.forgetSource('work-turn:one');
  memory.sources.forgetSource('work-turn:two');
  memory.sources.forgetSource('assistant-turn:one');
  memory.sources.forgetSource('assistant-turn:busy');
  memory.sources.forgetSource('assistant-turn:other');
  await understanding.reconcile();
  assert.equal(memory.sources.database.prepare('SELECT COUNT(*) AS n FROM assistant_user_observations')
    .get().n, 0);
  assert.equal((await memory.get('user-interests')).status, 'withdrawn');
  assert.doesNotMatch(await readFile(path, 'utf8'), /我喜欢安静地阅读/);
});

test('invalid model claims and credential-like quotations cannot enter user memory', () => {
  assert.equal(isDirectUserStatement('同事说“我喜欢滑雪”，但我不会。', '我喜欢滑雪', 'hobbies'), false);
  assert.equal(isDirectUserStatement('同事说我喜欢滑雪，但我不会。', '我喜欢滑雪', 'hobbies'), false);
  assert.equal(isDirectUserStatement('同事告诉我：我喜欢滑雪', '我喜欢滑雪', 'hobbies'), false);
  assert.equal(isDirectUserStatement('我摘录一句：我喜欢滑雪', '我喜欢滑雪', 'hobbies'), false);
  assert.equal(isDirectUserStatement('我听人说：我喜欢滑雪', '我喜欢滑雪', 'hobbies'), false);
  assert.equal(isDirectUserStatement('我复制一句，我喜欢滑雪', '我喜欢滑雪', 'hobbies'), false);
  assert.equal(isDirectUserStatement('我转发一句，我喜欢滑雪', '我喜欢滑雪', 'hobbies'), false);
  assert.equal(isDirectUserStatement('关于书里的句子，我喜欢滑雪', '我喜欢滑雪', 'hobbies'), false);
  assert.equal(isDirectUserStatement('我不是在说自己的爱好而是在复述书里的话，我喜欢滑雪',
    '我喜欢滑雪', 'hobbies'), false);
  assert.equal(isDirectUserStatement('以下是同事发来的消息：\n我喜欢滑雪。',
    '我喜欢滑雪。', 'hobbies'), false);
  assert.equal(isDirectUserStatement('以下是书里的句子：\n我喜欢滑雪。',
    '我喜欢滑雪。', 'hobbies'), false);
  assert.equal(isDirectUserStatement('关于爱好，我喜欢滑雪。', '我喜欢滑雪。', 'hobbies'), true);
  assert.equal(isDirectUserStatement('默认使用英文文件名。', '默认使用英文文件名。', 'preferences'), true);
  assert.equal(isDirectUserStatement('默认使用英文文件名。', '默认使用英文文件名。', 'knowledge'), false);
  assert.equal(isDirectUserStatement('同事说“默认使用英文文件名。”', '默认使用英文文件名。', 'preferences'), false);
  assert.equal(isDirectUserStatement('把这次文件名改成英文。', '把这次文件名改成英文。', 'preferences'), false);
  assert.deepEqual(parseUnderstandingProposal('```json\n{"observations":[]}\n```'), { observations: [] });
  assert.throws(() => parseUnderstandingProposal('Here is the result: ```json\n{"observations":[]}\n```'),
    /Unexpected token|is not valid JSON/);
  assert.throws(() => parseUnderstandingProposal(JSON.stringify({ observations: [
    { topic: 'knowledge', quote: 'token: sk-abcdefghijklmnopqrstuvwxyz' },
  ] })), /sensitive/);
  assert.throws(() => parseUnderstandingProposal(JSON.stringify({ observations: [
    { topic: 'expert-level', quote: '我知道这个项目。' },
  ] })), /Invalid/);
});
