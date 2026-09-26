import assert from 'node:assert/strict';
import { test } from 'node:test';

import { register } from 'tsx/esm/api';

register();

const {
  extractFilePathCandidates,
  normalizeWorkspacePath,
  splitTextByFilePaths,
} = await import('../src/shared/work-file-links.ts');

test('extractFilePathCandidates finds separated paths and previewable bare names', () => {
  assert.deepEqual(
    extractFilePathCandidates('已修改 src/foo.ts，并生成 docs/report.pdf。'),
    ['src/foo.ts', 'docs/report.pdf'],
  );
  assert.deepEqual(extractFilePathCandidates('输出写入 out/result.json'), ['out/result.json']);
  assert.deepEqual(extractFilePathCandidates('见 README.md 和 logo.png'), ['README.md', 'logo.png']);
  assert.deepEqual(extractFilePathCandidates('嵌套 a.b.c.ts 的引用'), ['a.b.c.ts']);
});

test('extractFilePathCandidates ignores versions, URLs and unknown extensions', () => {
  assert.deepEqual(extractFilePathCandidates('版本 1.2.3 已发布'), []);
  assert.deepEqual(extractFilePathCandidates('例如 e.g. 这样'), []);
  assert.deepEqual(extractFilePathCandidates('详见 https://example.com/report.md 了解'), []);
  assert.deepEqual(extractFilePathCandidates('任意 foo.bar 词'), []);
  assert.deepEqual(extractFilePathCandidates('没有路径的普通消息'), []);
});

test('extractFilePathCandidates keeps order and removes duplicates', () => {
  assert.deepEqual(
    extractFilePathCandidates('src/a.ts 然后 src/b.ts 再 src/a.ts'),
    ['src/a.ts', 'src/b.ts'],
  );
});

test('normalizeWorkspacePath strips ./ and collapses separators, rejecting escape', () => {
  assert.equal(normalizeWorkspacePath('src/./a/../b.ts'), 'src/b.ts');
  assert.equal(normalizeWorkspacePath('./notes.md'), 'notes.md');
  assert.equal(normalizeWorkspacePath('docs\\report.pdf'), 'docs/report.pdf');
  assert.equal(normalizeWorkspacePath(''), null);
  assert.equal(normalizeWorkspacePath('..'), null);
  assert.equal(normalizeWorkspacePath('src/../../outside'), null);
  assert.equal(normalizeWorkspacePath('src/..b/c.ts'), 'src/..b/c.ts');
});

test('splitTextByFilePaths isolates path segments for interactive rendering', () => {
  const parts = splitTextByFilePaths('已生成 src/a.ts，共 3 行');
  assert.deepEqual(parts.map((part) => part.kind), ['text', 'path', 'text']);
  assert.equal(parts[1]?.value, 'src/a.ts');
  assert.deepEqual(splitTextByFilePaths('没有路径'), [{ kind: 'text', value: '没有路径' }]);
});
