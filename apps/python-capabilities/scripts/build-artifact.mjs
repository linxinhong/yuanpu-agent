import { execFileSync } from 'node:child_process';
import {
  createHash,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

import { resolveArtifactSigningKeyId } from './signing-key-id.mjs';

const root = resolve(import.meta.dirname, '..');
const output = join(root, 'dist-artifact');
const work = join(root, '.pyinstaller');
const target = `${process.platform}-${process.arch}`;
const executableName = process.platform === 'win32' ? 'YuanpuEchoMcp.exe' : 'YuanpuEchoMcp';
const bundleRoot = join(output, 'bundle');
const frozenRoot = join(bundleRoot, 'YuanpuEchoMcp');
const archiveName = `YuanpuEchoMcp-${target}.tar.gz`;
const archivePath = join(output, archiveName);
const pyproject = await readFile(join(root, 'pyproject.toml'), 'utf8');
const projectVersion = /^version = "(\d+\.\d+\.\d+)"$/m.exec(pyproject)?.[1];
const requestedVersion = process.env.YUANPU_CAPABILITY_VERSION
  ?? (/^v?\d+\.\d+\.\d+$/.test(process.env.GITHUB_REF_NAME ?? '') ? process.env.GITHUB_REF_NAME : undefined);
const capabilityVersion = requestedVersion?.replace(/^v/, '') ?? projectVersion;
if (!capabilityVersion) throw new Error('Unable to determine the Python capability version.');

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

await rm(output, { recursive: true, force: true });
await rm(work, { recursive: true, force: true });
await mkdir(bundleRoot, { recursive: true });
const frozenEntry = join(work, 'frozen-entry.py');
await mkdir(work, { recursive: true });
await writeFile(
  frozenEntry,
  (await readFile(join(root, 'scripts', 'frozen-entry.py'), 'utf8'))
    .replace('__YUANPU_CAPABILITY_VERSION__', capabilityVersion),
);

execFileSync('uv', [
  'run', '--project', root, '--frozen', 'pyinstaller',
  '--noconfirm', '--clean', '--onedir',
  '--name', 'YuanpuEchoMcp',
  '--distpath', bundleRoot,
  '--workpath', join(work, 'work'),
  '--specpath', join(work, 'spec'),
  '--collect-all', 'pydantic',
  frozenEntry,
], { stdio: 'inherit' });

// Build machines have Python; target machines consume only the resulting archive.
execFileSync('uv', [
  'run', '--project', root, '--frozen', 'python',
  join(root, 'scripts', 'archive_bundle.py'),
  frozenRoot,
  archivePath,
], { stdio: 'inherit' });

const archive = await readFile(archivePath);
const privateKeyFile = process.env.YUANPU_ARTIFACT_SIGNING_KEY_FILE;
const privateKeyBase64 = process.env.YUANPU_ARTIFACT_SIGNING_KEY_BASE64;
const publicKeyBase64 = process.env.YUANPU_ARTIFACT_TRUST_ROOT_PUBLIC_KEY_BASE64;
if (privateKeyFile && privateKeyBase64) throw new Error('Configure only one artifact signing key source.');
const hasProductionKey = Boolean(privateKeyFile || privateKeyBase64);
const hasProductionTrustRoot = Boolean(hasProductionKey || publicKeyBase64);
const keyId = resolveArtifactSigningKeyId(process.env.YUANPU_ARTIFACT_SIGNING_KEY_ID, hasProductionTrustRoot);

let privateKey;
let publicKey;
let development = false;
if (hasProductionKey) {
  const pem = privateKeyFile
    ? await readFile(resolve(privateKeyFile), 'utf8')
    : Buffer.from(privateKeyBase64, 'base64').toString('utf8');
  privateKey = createPrivateKey(pem);
  publicKey = createPublicKey(privateKey);
} else if (publicKeyBase64) {
  publicKey = createPublicKey(Buffer.from(publicKeyBase64, 'base64').toString('utf8'));
} else {
  ({ privateKey, publicKey } = generateKeyPairSync('ed25519'));
  development = true;
}

const manifest = {
  manifestVersion: 1,
  kind: 'python-mcp',
  id: 'builtin.python.echo',
  version: capabilityVersion,
  capabilityContractVersion: 1,
  runtimeCompatibility: { minimum: '0.1.0', maximumExclusive: '1.0.0' },
  artifacts: [{
    platform: process.platform,
    arch: process.arch,
    format: 'tar.gz',
    url: process.env.YUANPU_ARTIFACT_BASE_URL
      ? new URL(archiveName, `${process.env.YUANPU_ARTIFACT_BASE_URL.replace(/\/$/, '')}/`).toString()
      : `artifacts/${archiveName}`,
    size: archive.length,
    sha256: createHash('sha256').update(archive).digest('hex'),
    entrypoint: relative(bundleRoot, join(frozenRoot, executableName)).replaceAll('\\', '/'),
  }],
  configSchema: {
    type: 'object',
    properties: {
      responsePrefix: {
        type: 'string',
        maxLength: 40,
        description: 'Prefix added to echo responses.',
        default: '',
      },
    },
    additionalProperties: false,
    default: { responsePrefix: '' },
  },
  permissions: ['notifications', 'background'],
  connections: ['yuanpu_echo_mcp'],
  issuedAt: process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : new Date().toISOString(),
  signature: { algorithm: 'ed25519', keyId, value: '' },
};
const { signature: _signature, ...unsigned } = manifest;
if (privateKey) {
  manifest.signature.value = sign(null, Buffer.from(canonicalize(unsigned)), privateKey).toString('base64');
}

await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(bundleRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(bundleRoot, 'trust-root.json'), `${JSON.stringify({
  schemaVersion: 1,
  keyId,
  publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  development,
  embeddedManifestSigned: Boolean(privateKey),
}, null, 2)}\n`);
await writeFile(join(output, `${archiveName}.sha256`), `${manifest.artifacts[0].sha256}  ${basename(archivePath)}\n`);
console.log(`Built self-contained Python artifact ${archivePath}`);
if (development) console.warn('Built with an ephemeral development trust root; production publishing is not authorized.');
if (publicKeyBase64 && !privateKey) console.log('Embedded production trust root without exposing its private signing key.');
