import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { register } from 'tsx/esm/api';

register();
const { createManagedWorkspaceDirectory, removeUncommittedWorkspaceDirectory } =
  await import('../src/workspace-directory.ts');

test('managed workspace rejects a linked root and removes only an empty pending leaf', async (context) => {
  const base = await mkdtemp(join(tmpdir(), 'yuanpu-managed-directory-'));
  context.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'workspace');
  const linked = join(base, 'linked');
  await mkdir(root);
  await symlink(root, linked);
  const leaf = 'c-11111111-1111-4111-8111-111111111111';
  await assert.rejects(createManagedWorkspaceDirectory(linked, '', leaf), /symbolic link/);
  assert.deepEqual(await readdir(root), []);
  await createManagedWorkspaceDirectory(root, '', leaf);
  await removeUncommittedWorkspaceDirectory(root, leaf);
  assert.deepEqual(await readdir(root), []);
});
