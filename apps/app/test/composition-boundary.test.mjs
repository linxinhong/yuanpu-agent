import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const src = new URL('../src/', import.meta.url);

test('page modules cannot own the renderer shell or load UI from a runtime path', () => {
  const modules = new URL('modules/', src);
  for (const name of readdirSync(modules)) {
    if (!name.endsWith('.tsx') && !name.endsWith('.ts')) continue;
    const source = readFileSync(new URL(name, modules), 'utf8');
    assert.doesNotMatch(source, /from ['"][^'"]*(?:\/shell\/|\/composition\/)/, name);
    assert.doesNotMatch(source, /\b(?:HashRouter|BrowserRouter|RouterProvider|QueryClientProvider)\b/, name);
    assert.doesNotMatch(source, /\bimport\s*\(/, name);
  }
  const catalog = readFileSync(new URL('composition/catalog.tsx', src), 'utf8');
  assert.doesNotMatch(catalog, /\bimport\s*\(/);
  assert.match(catalog, /register\(\{ id: 'skills'/);
});
