import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { executableSuffix, targetTriple } from './lib.mjs';

const appRoot = resolve(import.meta.dirname, '../..');
const target = targetTriple();
const binary = resolve(
  appRoot,
  `dist-native/bin/YuanpuAgentRuntime-${target}${executableSuffix(target)}`,
);
const { version } = JSON.parse(await readFile(resolve(appRoot, 'package.json'), 'utf8'));

const greeting = execFileSync(binary, [], { encoding: 'utf8' }).trim();
const reportedVersion = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();

assert.equal(greeting, 'Hello, world!');
assert.equal(reportedVersion, version);
console.log(`Smoke test passed for ${target}`);
