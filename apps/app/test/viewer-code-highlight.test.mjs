import assert from 'node:assert/strict';
import { test } from 'node:test';

import { register } from 'tsx/esm/api';

register();

const { highlightLines, shikiLanguageForFile } = await import('../src/viewer/preview/code-highlight.ts');

test('shikiLanguageForFile maps extensions and skips markdown/plain files', () => {
  assert.equal(shikiLanguageForFile('src/index.ts'), 'typescript');
  assert.equal(shikiLanguageForFile('a/b/App.tsx'), 'tsx');
  // Markdown renders through MessageContent, never through the code highlighter.
  assert.equal(shikiLanguageForFile('notes.md'), undefined);
  assert.equal(shikiLanguageForFile('archive.zip'), undefined);
  assert.equal(shikiLanguageForFile('Makefile'), undefined);
  assert.equal(shikiLanguageForFile('data.txt'), undefined);
});

test('highlightLines returns dual-theme tokens for supported languages', async () => {
  const lines = await highlightLines('const answer = 42;', 'typescript');
  assert.ok(lines);
  assert.equal(lines.length, 1);
  const first = lines[0]?.[0];
  assert.ok(first);
  assert.equal(first.text, 'const');
  assert.match(first.light, /^#/);
  assert.ok(first.dark);
});

test('highlightLines falls back to undefined for plain text and unknown languages', async () => {
  assert.equal(await highlightLines('just text', 'plaintext'), undefined);
  assert.equal(await highlightLines('just text', 'not-a-real-lang'), undefined);
});
