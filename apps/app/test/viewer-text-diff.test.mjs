import assert from 'node:assert/strict';
import { test } from 'node:test';

import { register } from 'tsx/esm/api';

register();

const { createUnifiedDiff } = await import('../src/viewer/preview/text-diff.ts');

test('createUnifiedDiff produces a valid hunk with real context lines', () => {
  const oldText = 'line1\nline2\nline3\nline4\nline5';
  const newText = 'line1\nline2 edited\nline3\nline4\nline5';
  const patch = createUnifiedDiff(oldText, newText, 'sample.txt');
  assert.ok(patch);
  const lines = patch.split('\n');
  assert.equal(lines[0], '--- a/sample.txt');
  assert.equal(lines[1], '+++ b/sample.txt');
  // Change on line 2 with three context lines covers the whole 5-line file.
  assert.equal(lines[2], '@@ -1,5 +1,5 @@');
  assert.deepEqual(lines.slice(3), [' line1', '-line2', '+line2 edited', ' line3', ' line4', ' line5']);
});

test('createUnifiedDiff restores trimmed prefix as context for an appended line', () => {
  const oldText = 'a\nb\nc';
  const newText = 'a\nb\nc\nd';
  const patch = createUnifiedDiff(oldText, newText, 'g.txt');
  assert.ok(patch);
  assert.equal(patch, ['--- a/g.txt', '+++ b/g.txt', '@@ -1,3 +1,4 @@', ' a', ' b', ' c', '+d'].join('\n'));
});

test('createUnifiedDiff merges nearby changes into one hunk', () => {
  const base = 'h1\nh2\nh3\nh4\nh5\nh6\nh7\nh8\nh9\nh10\nh11\nh12\nh13\nh14';
  const edited = base.replace('h2', 'H2').replace('h4', 'H4');
  const patch = createUnifiedDiff(base, edited, 'm.txt');
  assert.ok(patch);
  assert.equal((patch.match(/^@@ /gm) ?? []).length, 1, 'nearby changes share one hunk');
  assert.equal(createUnifiedDiff('same', 'same', 'x.txt'), undefined);
});

test('createUnifiedDiff refuses oversized changed regions but diffs small edits in big files', () => {
  const oldLines = Array.from({ length: 2000 }, (_, index) => `old-${index}`);
  const newLines = oldLines.map((line, index) => index % 2 === 0 ? `new-${index}` : line);
  assert.equal(createUnifiedDiff(oldLines.join('\n'), newLines.join('\n'), 'big.txt'), undefined);

  const big = Array.from({ length: 3000 }, (_, index) => `line-${index}`).join('\n');
  const changed = big.replace('line-0', 'changed');
  const patch = createUnifiedDiff(big, changed, 'ok.txt');
  assert.ok(patch);
  assert.ok(patch.includes('-line-0'));
  assert.ok(patch.includes('+changed'));
});
