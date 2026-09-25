import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Builds real frozen versions using a single disposable test signing key.
// Run through the repository's prepared Node/uv environment, on each target OS.
const repo = resolve(import.meta.dirname, '../../..');
const generated = join(repo, 'apps/python-capabilities/dist-artifact');
const fixtureRoot = process.argv[2]
  ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'yuanpu-task008-fixtures-'));
// Explicit destinations must be new; never overwrite an existing fixture/user directory.
if (process.argv[2]) await mkdir(fixtureRoot);
const backup = join(fixtureRoot, 'previous-generated-artifact');
const keyFile = join(fixtureRoot, 'temporary-signing-key.pem');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keyId = 'task-008-isolated-development';
const trustRoot = {
  schemaVersion: 1, keyId,
  publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  development: true, embeddedManifestSigned: true,
};
await writeFile(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
let hadPrevious = false;
let ownsGenerated = false;
try {
  try {
    await rename(generated, backup);
    hadPrevious = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  ownsGenerated = true;
  const env = { ...process.env };
  for (const name of [
    'YUANPU_ARTIFACT_SIGNING_KEY_BASE64', 'YUANPU_ARTIFACT_TRUST_ROOT_PUBLIC_KEY_BASE64',
    'YUANPU_ARTIFACT_BASE_URL',
  ]) delete env[name];
  Object.assign(env, {
    YUANPU_ARTIFACT_SIGNING_KEY_FILE: keyFile,
    YUANPU_ARTIFACT_SIGNING_KEY_ID: keyId,
  });
  const versions = [];
  for (const version of ['0.1.0', '0.2.0']) {
    execFileSync(process.execPath, ['apps/python-capabilities/scripts/build-artifact.mjs'], {
      cwd: repo, env: { ...env, YUANPU_CAPABILITY_VERSION: version },
      stdio: 'inherit', timeout: 300_000,
    });
    const directory = join(fixtureRoot, version);
    await cp(generated, directory, { recursive: true });
    // The build accepts a supplied key for production too; explicitly label this
    // freshly generated, disposable key as development in the test fixture.
    await writeFile(join(directory, 'bundle/trust-root.json'), JSON.stringify(trustRoot, null, 2) + '\n');
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, version);
    const executable = join(directory, 'bundle', manifest.artifacts[0].entrypoint);
    assert.equal(execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim(), version);
    versions.push({ version, artifact: manifest.artifacts[0].url, sha256: manifest.artifacts[0].sha256 });
  }
  await mkdir(join(fixtureRoot, 'metadata'), { recursive: true });
  await writeFile(join(fixtureRoot, 'metadata/trust-root.json'), JSON.stringify(trustRoot, null, 2) + '\n');
  const result = {
    scenario: 'TASK-008 isolated signed upgrade fixtures',
    development: true, target: `${process.platform}-${process.arch}`, versions,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    sourceHasLocalChanges: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim()),
  };
  await writeFile(join(fixtureRoot, 'metadata/fixture.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'prepared', fixtureRoot, ...result }));
} finally {
  // Remove the disposable private key; only public trust metadata leaves this builder.
  await rm(keyFile, { force: true });
  if (ownsGenerated) await rm(generated, { recursive: true, force: true });
  if (hadPrevious) await rename(backup, generated);
}
