import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'tsx/esm/api';

register();
const { cacheReplyRun, findReplyRun } = await import('../src/shared/reply-run-cache.ts');

test('a completed reply keeps its own run details after transcript refresh', () => {
  const values = new Map();
  globalThis.window = { localStorage: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  } };
  const run = {
    runId: 'run-1', status: 'succeeded', createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:12.000Z', output: { message: '完成。', tools: [{ name: 'search', status: 'completed' }] },
  };
  cacheReplyRun('work', '完成。', run, [{ id: 1, title: '已完成', at: run.updatedAt }]);
  const matched = findReplyRun('work', 'transcript-1', '完成。', '2026-09-24T10:00:11.000Z');
  assert.equal(matched?.runId, 'run-1');
  assert.equal(matched?.events[0]?.title, '已完成');
  assert.equal(findReplyRun('work', 'transcript-1', '完成。', '2026-09-24T10:00:11.000Z')?.runId, 'run-1');
  assert.equal(findReplyRun('assistant', 'transcript-2', '完成。', '2026-09-24T10:00:11.000Z'), undefined);
  delete globalThis.window;
});
