import assert from 'node:assert/strict';
import { test } from 'node:test';

import { register } from 'tsx/esm/api';

register();

const { clearFileVersions, getKnownFileVersion, rememberFileVersion } = await import('../src/viewer/preview/file-version-cache.ts');

test('file version cache stores, detects and clears per conversation scope', () => {
  clearFileVersions('work:a');
  const first = { content: 'v1', truncated: false, size: 2, updatedAt: '2026-09-27T01:00:00.000Z' };
  const second = { content: 'v2', truncated: false, size: 2, updatedAt: '2026-09-27T02:00:00.000Z' };

  rememberFileVersion('work:a', 'src/index.ts', first);
  assert.equal(getKnownFileVersion('work:a', 'src/index.ts'), first);
  assert.equal(getKnownFileVersion('work:b', 'src/index.ts'), undefined);

  rememberFileVersion('work:a', 'src/index.ts', second);
  assert.equal(getKnownFileVersion('work:a', 'src/index.ts'), second);

  clearFileVersions('work:a');
  assert.equal(getKnownFileVersion('work:a', 'src/index.ts'), undefined);

  rememberFileVersion('work:c', 'keep.txt', first);
  clearFileVersions('work:other');
  assert.equal(getKnownFileVersion('work:c', 'keep.txt'), first);
});

test('file version cache evicts the oldest entries past the cap', () => {
  clearFileVersions('work:cap');
  for (let index = 0; index < 260; index += 1) {
    rememberFileVersion('work:cap', `file-${index}.txt`, { content: 'x', truncated: false, size: 1, updatedAt: '2026-09-27T00:00:00.000Z' });
  }
  assert.equal(getKnownFileVersion('work:cap', 'file-0.txt'), undefined);
  assert.ok(getKnownFileVersion('work:cap', 'file-259.txt'));
});
