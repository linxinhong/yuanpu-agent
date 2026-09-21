import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

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
const pythonRoot = resolve(appRoot, '../python-capabilities');
const pythonExecutable = process.platform === 'win32'
  ? join(pythonRoot, '.venv', 'Scripts', 'python.exe')
  : join(pythonRoot, '.venv', 'bin', 'python');
const capabilitySmoke = JSON.parse(execFileSync(binary, ['--capability-smoke'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    YUANPU_PYTHON_MCP_EXECUTABLE: pythonExecutable,
    YUANPU_PYTHON_MCP_ROOT: pythonRoot,
    PATH: `${dirname(pythonExecutable)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
  },
}).trim());

assert.equal(greeting, 'Hello, world!');
assert.equal(reportedVersion, version);
assert.deepEqual(capabilitySmoke.tools, ['search_capabilities', 'execute_capability']);
assert.deepEqual(capabilitySmoke.result.structuredContent, {
  text: 'YuanpuAgent SEA',
  length: 15,
});
assert.equal(capabilitySmoke.errorResult.isError, true);
assert.match(capabilitySmoke.errorResult.content[0].text, /diagnostic error/i);
console.log(`Smoke test passed for ${target}`);
