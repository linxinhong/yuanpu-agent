import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { executableSuffix, run, SEA_SENTINEL_FUSE, targetTriple } from './lib.mjs';

const appRoot = resolve(import.meta.dirname, '../..');
const target = targetTriple();
const workDir = resolve(appRoot, 'dist-native/work', target);
const outputDir = resolve(appRoot, 'dist-native/bin');
const seaConfig = resolve(workDir, 'sea-config.json');
const seaBlob = resolve(workDir, 'sea-prep.blob');
const output = resolve(outputDir, `yuanpu-agent-${target}${executableSuffix(target)}`);
const postject = resolve(appRoot, 'node_modules/postject/dist/cli.js');

await rm(workDir, { recursive: true, force: true });
await mkdir(workDir, { recursive: true });
await mkdir(outputDir, { recursive: true });

await writeFile(
  seaConfig,
  `${JSON.stringify(
    {
      main: resolve(appRoot, 'dist/index.cjs'),
      output: seaBlob,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
    },
    null,
    2,
  )}\n`,
);

await run(process.execPath, ['--experimental-sea-config', seaConfig]);
await copyFile(process.execPath, output);

if (process.platform === 'darwin') await run('codesign', ['--remove-signature', output]);

const injectArgs = [output, 'NODE_SEA_BLOB', seaBlob, '--sentinel-fuse', SEA_SENTINEL_FUSE];
if (process.platform === 'darwin') injectArgs.push('--macho-segment-name', 'NODE_SEA');
await run(process.execPath, [postject, ...injectArgs]);

if (process.platform === 'darwin') await run('codesign', ['--sign', '-', '--force', output]);

console.log(`Built ${output}`);
