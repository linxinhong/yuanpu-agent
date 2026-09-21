import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const executable = join(
  root,
  'dist-artifact',
  'bundle',
  'YuanpuEchoMcp',
  process.platform === 'win32' ? 'YuanpuEchoMcp.exe' : 'YuanpuEchoMcp',
);
const isolatedPath = await mkdtemp(join(tmpdir(), 'yuanpu-no-python-'));
try {
  const result = execFileSync(executable, ['--version'], {
    encoding: 'utf8',
    env: {
      SYSTEMROOT: process.env.SYSTEMROOT,
      WINDIR: process.env.WINDIR,
      PATH: isolatedPath,
    },
  }).trim();
  assert.equal(result, '0.1.0');
  const trust = JSON.parse(await readFile(join(root, 'dist-artifact', 'bundle', 'trust-root.json'), 'utf8'));
  assert.equal(typeof trust.publicKeyPem, 'string');
  console.log(`Self-contained Python artifact smoke passed for ${process.platform}-${process.arch}`);
} finally {
  await rm(isolatedPath, { recursive: true, force: true });
}
