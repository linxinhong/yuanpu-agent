import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { register } from 'tsx/esm/api';

register();
const { inspectWorkArtifact } = await import('../src/work-artifact.ts');

test('only bounded regular UTF-8 files under the Work root can become artifacts', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-work-artifact-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside.txt');
  await mkdir(join(workspace, 'docs'), { recursive: true });
  await writeFile(join(workspace, 'docs', 'note.md'), '# note\n');
  await writeFile(outside, 'private');
  await symlink(outside, join(workspace, 'link.txt'));
  await symlink(root, join(workspace, 'linked-dir'));
  await writeFile(join(workspace, 'binary.bin'), Buffer.from([0, 1, 2]));
  await writeFile(join(workspace, 'large.txt'), 'a'.repeat(256 * 1024 + 1));

  const artifact = await inspectWorkArtifact(workspace, join('docs', 'note.md'), 'entry-1');
  assert.equal(artifact.relativePath, join('docs', 'note.md'));
  assert.equal(artifact.sha256, createHash('sha256').update('# note\n').digest('hex'));
  assert.equal(artifact.text, '# note\n');
  for (const path of ['../outside.txt', outside, 'link.txt', join('linked-dir', 'outside.txt'),
    'binary.bin', 'large.txt', 'missing.txt', 'docs/../docs/note.md', 'docs/./note.md',
    'docs/note.md\0outside']) {
    assert.equal(await inspectWorkArtifact(workspace, path, 'entry-1'), undefined, path);
  }
});
