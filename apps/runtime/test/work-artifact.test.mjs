import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { register } from 'tsx/esm/api';

register();
const { registerWorkWriteArtifact } = await import('../src/work-artifact.ts');

test('successful write payload is bounded and registered without reading Work or outside files', () => {
  const workspace = join(tmpdir(), 'yuanpu-work-artifact');
  const artifact = registerWorkWriteArtifact(workspace, join('docs', 'note.md'), 'entry-1', '# note\n');
  assert.equal(artifact.relativePath, join('docs', 'note.md'));
  assert.equal(artifact.sha256, createHash('sha256').update('# note\n').digest('hex'));
  assert.equal(artifact.size, 7);
  assert.equal(artifact.text, '# note\n');
  for (const path of ['../outside.txt', join(tmpdir(), 'outside.txt'), 'docs/../docs/note.md',
    'docs/./note.md', 'docs/note.md\0outside']) {
    assert.equal(registerWorkWriteArtifact(workspace, path, 'entry-1', 'secret'), undefined, path);
  }
  assert.equal(registerWorkWriteArtifact(workspace, 'note.md', 'entry-1', 'a'.repeat(256 * 1024 + 1)),
    undefined);
  assert.equal(registerWorkWriteArtifact(workspace, 'note.md', 'entry-1', 'inside\0unsafe'), undefined);
});
