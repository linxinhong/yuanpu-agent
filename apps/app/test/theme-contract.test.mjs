import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('renderer theme references are declared by the built-in theme tokens', async () => {
  const [tokens, stylesheet] = await Promise.all([
    readFile(new URL('../themes/tokens.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/muse-theme.css', import.meta.url), 'utf8'),
  ]);
  const declared = new Set([...tokens.matchAll(/(--yp-[a-z-]+)\s*:/g)].map((match) => match[1]));
  const referenced = new Set([...stylesheet.matchAll(/var\((--yp-[a-z-]+)\)/g)].map((match) => match[1]));

  assert.ok(referenced.size > 10);
  for (const name of referenced) assert.ok(declared.has(name), `${name} is missing from the built-in theme`);
});
