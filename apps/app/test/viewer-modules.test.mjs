import assert from 'node:assert/strict';
import { test } from 'node:test';

import { register } from 'tsx/esm/api';

register();

// preview/* is excluded here: pdf-view relies on Vite's `?url` worker import,
// which plain Node ESM cannot resolve. Its behavior is exercised through the
// renderer build and the desktop smoke test.
const { classifyWorkFile } = await import('../src/viewer/core/content-kind.ts');
const { formatFileTime, formatFileSize } = await import('../src/viewer/core/format.ts');
const { FileTree } = await import('../src/viewer/files/file-tree.tsx');

test('viewer modules export their components and helpers', () => {
  assert.equal(typeof classifyWorkFile, 'function');
  assert.equal(typeof formatFileSize, 'function');
  assert.equal(typeof formatFileTime, 'function');
  assert.equal(typeof FileTree, 'function');
});

test('classifyWorkFile routes by extension', () => {
  assert.equal(classifyWorkFile('README.md'), 'markdown');
  assert.equal(classifyWorkFile('notes.MARKDOWN'), 'markdown');
  assert.equal(classifyWorkFile('docs/report.pdf'), 'pdf');
  assert.equal(classifyWorkFile('logo.PNG'), 'image');
  assert.equal(classifyWorkFile('src/index.ts'), 'text');
  assert.equal(classifyWorkFile('data.csv'), 'text');
  assert.equal(classifyWorkFile('archive.zip'), 'other');
  assert.equal(classifyWorkFile('Makefile'), 'other');
});

test('formatFileSize and formatFileTime produce readable labels', () => {
  assert.equal(formatFileSize(undefined), '');
  assert.equal(formatFileSize(512), '512 B');
  assert.equal(formatFileSize(2048), '2.0 KB');
  assert.equal(formatFileSize(3 * 1024 * 1024), '3.0 MB');
  assert.equal(formatFileTime(undefined), '');
  assert.match(formatFileTime(new Date('2026-09-26T08:30:00Z').toISOString()), /\d{1,2}:\d{2}/);
});
