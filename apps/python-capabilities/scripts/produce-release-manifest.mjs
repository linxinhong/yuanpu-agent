import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const [directoryArgument, releaseTag] = process.argv.slice(2);
if (!directoryArgument || !releaseTag) {
  throw new Error('Usage: produce-release-manifest.mjs <artifact-directory> <release-tag>');
}
const keyBase64 = process.env.YUANPU_ARTIFACT_SIGNING_KEY_BASE64;
const keyId = process.env.YUANPU_ARTIFACT_SIGNING_KEY_ID;
const baseUrl = process.env.YUANPU_ARTIFACT_BASE_URL;
if (!keyBase64 || !keyId || !baseUrl) {
  throw new Error('Production capability signing key, key id, and artifact base URL are required.');
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

const directory = resolve(directoryArgument);
const names = (await readdir(directory))
  .filter((name) => /^YuanpuEchoMcp-(darwin|linux|win32)-(arm64|x64)\.tar\.gz$/.test(name))
  .sort();
if (names.length === 0) throw new Error('No Python capability archives were collected.');

const artifacts = await Promise.all(names.map(async (name) => {
  const match = /^YuanpuEchoMcp-(darwin|linux|win32)-(arm64|x64)\.tar\.gz$/.exec(name);
  const path = join(directory, name);
  const bytes = await readFile(path);
  const metadata = await stat(path);
  return {
    platform: match[1],
    arch: match[2],
    format: 'tar.gz',
    url: new URL(`${encodeURIComponent(releaseTag)}/${basename(path)}`, `${baseUrl.replace(/\/$/, '')}/`).toString(),
    size: metadata.size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    entrypoint: `YuanpuEchoMcp/${match[1] === 'win32' ? 'YuanpuEchoMcp.exe' : 'YuanpuEchoMcp'}`,
  };
}));

const manifest = {
  manifestVersion: 1,
  kind: 'python-mcp',
  id: 'builtin.python.echo',
  version: releaseTag.replace(/^v/, ''),
  capabilityContractVersion: 1,
  runtimeCompatibility: { minimum: '0.1.0', maximumExclusive: '1.0.0' },
  artifacts,
  permissions: [],
  issuedAt: new Date().toISOString(),
  signature: { algorithm: 'ed25519', keyId, value: '' },
};
const { signature: _signature, ...unsigned } = manifest;
manifest.signature.value = sign(
  null,
  Buffer.from(canonicalize(unsigned)),
  createPrivateKey(Buffer.from(keyBase64, 'base64').toString('utf8')),
).toString('base64');
await writeFile(
  join(directory, 'YuanpuEchoMcp-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(`Produced signed capability manifest for ${artifacts.length} targets.`);
