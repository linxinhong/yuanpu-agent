import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PROTOCOL_VERSION } from '@yuanpu-agent/protocol';

import { sha256File } from './lib.mjs';

const appRoot = resolve(import.meta.dirname, '../..');
const invocationRoot = process.env.INIT_CWD ?? process.cwd();
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const inputDir = resolve(invocationRoot, args[0] ?? 'dist-release');
const tag = args[1] ?? process.env.RELEASE_TAG;

if (!tag) {
  console.error('Usage: pnpm release:manifest -- <input-dir> <release-tag>');
  process.exit(1);
}

const version = tag.replace(/^v/, '');
const packageJson = JSON.parse(await readFile(resolve(appRoot, 'package.json'), 'utf8'));
if (packageJson.version !== version) {
  throw new Error(`Tag ${tag} does not match runtime package version ${packageJson.version}`);
}

const files = (await readdir(inputDir)).filter(
  (file) => /^YuanpuAgentRuntime-(linux|darwin|win32)-(x64|arm64)(\.exe)?$/.test(file),
);
if (files.length === 0) throw new Error(`No native binaries found in ${inputDir}`);

const platforms = {};
for (const filename of files.sort()) {
  const target = filename.replace(/^YuanpuAgentRuntime-/, '').replace(/\.exe$/, '');
  const artifact = resolve(inputDir, filename);
  platforms[target] = {
    filename,
    url: `https://github.com/linxinhong/yuanpu-agent/releases/download/${tag}/${filename}`,
    size: (await stat(artifact)).size,
    sha256: await sha256File(artifact),
  };
}

const manifest = {
  schemaVersion: 1,
  protocolVersion: PROTOCOL_VERSION,
  minDesktopVersion: '0.1.0',
  version,
  tag,
  platforms,
};
await writeFile(resolve(inputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote manifest.json for ${Object.keys(platforms).length} platforms`);
