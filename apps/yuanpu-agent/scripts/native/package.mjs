import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { executableSuffix, sha256File, targetTriple } from './lib.mjs';

const appRoot = resolve(import.meta.dirname, '../..');
const target = targetTriple();
const filename = `yuanpu-agent-${target}${executableSuffix(target)}`;
const source = resolve(appRoot, 'dist-native/bin', filename);
const artifactDir = resolve(appRoot, 'dist-native/artifacts');
const artifact = resolve(artifactDir, filename);

await mkdir(artifactDir, { recursive: true });
await copyFile(source, artifact);
const checksum = await sha256File(artifact);
await writeFile(`${artifact}.sha256`, `${checksum}  ${basename(artifact)}\n`);
console.log(`Packaged ${artifact}`);
