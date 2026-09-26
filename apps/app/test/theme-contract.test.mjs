import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('renderer theme references are declared by the built-in theme tokens', async () => {
  const [tokens, stylesheet, assistantStylesheet] = await Promise.all([
    readFile(new URL('../themes/tokens.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/muse-theme.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/modules/assistant-home.css', import.meta.url), 'utf8'),
  ]);
  const declared = new Set([...tokens.matchAll(/(--yp-[a-z-]+)\s*:/g)].map((match) => match[1]));
  const referenced = new Set([...(stylesheet + assistantStylesheet).matchAll(/var\((--yp-[a-z-]+)\)/g)].map((match) => match[1]));

  assert.ok(referenced.size > 10);
  for (const name of referenced) assert.ok(declared.has(name), `${name} is missing from the built-in theme`);
});

test('renderer stylesheets scale text through rem and declare the font tokens', async () => {
  const tokens = await readFile(new URL('../themes/tokens.css', import.meta.url), 'utf8');
  for (const token of ['--yp-font-family', '--yp-font-scale-ui', '--yp-font-size-content']) {
    assert.ok(tokens.includes(`${token}:`), `${token} is missing from the built-in theme tokens`);
  }

  const stylesheets = [
    '../src/muse-theme.css',
    '../src/styles.css',
    '../src/management.css',
    '../src/modules/assistant-home.css',
    '../src/shell/shell-layout.css',
    '../themes/mindlink.css',
    '../themes/dark.css',
  ];
  for (const relative of stylesheets) {
    const css = await readFile(new URL(relative, import.meta.url), 'utf8');
    const hardcoded = css.match(/(?:font-size|line-height):\s*\d+(?:\.\d+)?px/g) ?? [];
    assert.deepEqual(hardcoded, [], `${relative} keeps hardcoded px text sizes: ${hardcoded.join(', ')}`);
  }
});
