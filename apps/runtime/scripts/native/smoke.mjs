import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
const pythonRoot = resolve(appRoot, '../python-capabilities/dist-artifact/bundle/YuanpuEchoMcp');
const pythonExecutable = join(
  pythonRoot,
  process.platform === 'win32' ? 'YuanpuEchoMcp.exe' : 'YuanpuEchoMcp',
);
const capabilitySmoke = JSON.parse(execFileSync(binary, ['--capability-smoke'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    YUANPU_PYTHON_MCP_EXECUTABLE: pythonExecutable,
    YUANPU_PYTHON_MCP_ROOT: pythonRoot,
    YUANPU_PYTHON_MCP_ARGS: '[]',
    PATH: `${dirname(pythonExecutable)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
  },
}).trim());
const sqliteRoot = await mkdtemp(join(tmpdir(), 'yuanpu-sea-sqlite-'));
let firstSqliteSmoke;
let secondSqliteSmoke;
let schedulerSmoke;
try {
  const sqlitePath = join(sqliteRoot, 'automation.sqlite');
  firstSqliteSmoke = JSON.parse(execFileSync(binary, ['--sqlite-smoke', sqlitePath], {
    encoding: 'utf8',
  }).trim());
  secondSqliteSmoke = JSON.parse(execFileSync(binary, ['--sqlite-smoke', sqlitePath], {
    encoding: 'utf8',
  }).trim());
  schedulerSmoke = JSON.parse(execFileSync(
    binary,
    ['--scheduler-smoke', join(sqliteRoot, 'scheduler.sqlite')],
    { encoding: 'utf8' },
  ).trim());
} finally {
  await rm(sqliteRoot, { recursive: true, force: true });
}

assert.equal(greeting, 'Hello, world!');
assert.equal(reportedVersion, version);
assert.deepEqual(capabilitySmoke.tools, ['search_capabilities', 'execute_capability']);
assert.deepEqual(capabilitySmoke.result.structuredContent, {
  text: 'YuanpuAgent SEA',
  length: 15,
});
assert.equal(capabilitySmoke.errorResult.isError, true);
assert.match(capabilitySmoke.errorResult.content[0].text, /diagnostic error/i);
assert.deepEqual(firstSqliteSmoke, {
  driver: 'node:sqlite',
  schemaVersion: 5,
  persistedCount: 1,
});
assert.deepEqual(secondSqliteSmoke, {
  driver: 'node:sqlite',
  schemaVersion: 5,
  persistedCount: 2,
});
assert.deepEqual(schedulerSmoke, {
  schemaVersion: 5,
  historyCount: 1,
  runStatus: 'succeeded',
  output: 'SEA scheduler persisted output',
  deliveryStatus: 'delivered',
});
console.log(`Smoke test passed for ${target}`);
