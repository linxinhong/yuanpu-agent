import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

test('aggregates target archives and signs the production capability manifest', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-release-manifest-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'YuanpuEchoMcp-linux-x64.tar.gz'), 'linux');
  await writeFile(join(root, 'YuanpuEchoMcp-win32-x64.tar.gz'), 'windows');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyBase64 = Buffer.from(privateKey.export({ format: 'pem', type: 'pkcs8' })).toString('base64');
  const publicBase64 = Buffer.from(publicKey.export({ format: 'pem', type: 'spki' })).toString('base64');
  const signingEnvironment = {
    ...process.env,
    YUANPU_ARTIFACT_SIGNING_KEY_BASE64: keyBase64,
    YUANPU_ARTIFACT_TRUST_ROOT_PUBLIC_KEY_BASE64: publicBase64,
    YUANPU_ARTIFACT_SIGNING_KEY_ID: 'production-test',
    YUANPU_ARTIFACT_BASE_URL: 'https://downloads.example.test/',
  };

  assert.doesNotThrow(() => execFileSync(process.execPath, [
    new URL('./verify-release-signing-env.mjs', import.meta.url).pathname,
  ], { env: signingEnvironment }));

  execFileSync(process.execPath, [
    new URL('./produce-release-manifest.mjs', import.meta.url).pathname,
    root,
    'v0.2.0',
  ], {
    env: signingEnvironment,
  });
  const manifest = JSON.parse(await readFile(join(root, 'YuanpuEchoMcp-manifest.json'), 'utf8'));
  assert.equal(manifest.version, '0.2.0');
  assert.deepEqual(manifest.artifacts.map((artifact) => `${artifact.platform}-${artifact.arch}`), [
    'linux-x64',
    'win32-x64',
  ]);
  assert.equal(
    manifest.artifacts[0].url,
    'https://downloads.example.test/v0.2.0/YuanpuEchoMcp-linux-x64.tar.gz',
  );
  const { signature, ...unsigned } = manifest;
  assert.equal(verify(
    null,
    Buffer.from(canonicalize(unsigned)),
    publicKey,
    Buffer.from(signature.value, 'base64'),
  ), true);
});
