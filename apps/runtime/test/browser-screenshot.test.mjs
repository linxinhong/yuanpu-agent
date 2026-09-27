import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { register } from 'tsx/esm/api';

register();
const { saveBrowserScreenshot } = await import('../src/browser-screenshot.ts');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

test('browser screenshots are stored as unique files inside the conversation images directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-browser-images-'));
  try {
    const first = await saveBrowserScreenshot(root, png.toString('base64'));
    const second = await saveBrowserScreenshot(root, png.toString('base64'));
    assert.match(first.relativePath, /^images\/browser-.*\.png$/);
    assert.notEqual(first.path, second.path);
    assert.equal(first.path, join(await realpath(root), first.relativePath));
    assert.deepEqual(await readFile(first.path), png);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('browser screenshot rejects invalid data and an images symlink outside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-browser-images-'));
  const outside = await mkdtemp(join(tmpdir(), 'yuanpu-browser-outside-'));
  try {
    await assert.rejects(saveBrowserScreenshot(root, Buffer.from('not png').toString('base64')), /PNG/);
    await symlink(outside, join(root, 'images'));
    await assert.rejects(saveBrowserScreenshot(root, png.toString('base64')), /工作区/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
