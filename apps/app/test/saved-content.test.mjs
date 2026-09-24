import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'tsx/esm/api';

register();
const { isSavedContent, readSavedContent, removeSavedContent, saveContent } = await import('../src/shared/saved-content.ts');

test('saved replies persist locally without duplicate entries and can be removed', () => {
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    dispatchEvent: () => undefined,
  };

  saveContent('memory', 'work', '一条回复');
  saveContent('memory', 'work', '一条回复');
  saveContent('knowledge', 'work', '一条回复');
  assert.equal(readSavedContent().length, 2);
  assert.equal(isSavedContent('memory', 'work', '一条回复'), true);
  assert.equal(isSavedContent('memory', 'assistant', '一条回复'), false);

  removeSavedContent(readSavedContent()[0].id);
  assert.equal(readSavedContent().length, 1);
  delete globalThis.window;
});

test('previously saved records appear as memories', () => {
  const legacy = [{ id: 'old', kind: 'record', surface: 'work', text: '旧内容', savedAt: '2026-09-24T00:00:00.000Z' }];
  globalThis.window = { localStorage: { getItem: () => JSON.stringify(legacy) } };
  assert.equal(readSavedContent()[0]?.kind, 'memory');
  delete globalThis.window;
});
