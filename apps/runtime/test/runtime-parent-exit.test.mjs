import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const harness = resolve(import.meta.dirname, 'fixtures/parent-exit-harness.mjs');
const runtimeEntry = resolve(import.meta.dirname, '../dist/index.cjs');

async function waitForExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`process ${pid} survived its parent exit`);
}

test('Runtime exits after its Electron parent is force-killed', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'yuanpu-parent-exit-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const parent = spawn(process.execPath, [harness, runtimeEntry, home], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  context.after(() => parent.kill('SIGKILL'));
  const started = await new Promise((resolveStarted, rejectStarted) => {
    let output = '';
    const timeout = setTimeout(() => rejectStarted(new Error('Runtime harness did not start')), 5_000);
    parent.once('error', rejectStarted);
    parent.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const lineEnd = output.indexOf('\n');
      if (lineEnd < 0) return;
      clearTimeout(timeout);
      resolveStarted(JSON.parse(output.slice(0, lineEnd)));
    });
  });
  assert.equal(started.ready.event, 'ready');
  assert.equal(typeof started.runtimePid, 'number');

  parent.kill('SIGKILL');
  await new Promise((resolveExit) => parent.once('exit', resolveExit));
  await waitForExit(started.runtimePid);
});

test('Runtime cannot become orphaned when its parent exits before readiness', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'yuanpu-parent-exit-before-ready-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const parent = spawn(process.execPath, [harness, runtimeEntry, home, 'before-ready'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const started = await new Promise((resolveStarted, rejectStarted) => {
    let output = '';
    parent.once('error', rejectStarted);
    parent.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const lineEnd = output.indexOf('\n');
      if (lineEnd >= 0) resolveStarted(JSON.parse(output.slice(0, lineEnd)));
    });
  });
  await new Promise((resolveExit) => parent.once('exit', resolveExit));
  await waitForExit(started.runtimePid);
});

test('force-killing the Electron parent cleans Runtime, MCP root, and MCP descendant', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'yuanpu-parent-exit-mcp-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const fixtureRoot = resolve(import.meta.dirname, 'fixtures');
  const parent = spawn(process.execPath, [harness, runtimeEntry, home, 'mcp'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      ...process.env,
      YUANPU_PYTHON_MCP_EXECUTABLE: process.execPath,
      YUANPU_PYTHON_MCP_ROOT: fixtureRoot,
      YUANPU_PYTHON_MCP_ARGS: JSON.stringify([join(fixtureRoot, 'lifecycle-mcp.mjs')]),
    },
  });
  context.after(() => parent.kill('SIGKILL'));
  const started = await new Promise((resolveStarted, rejectStarted) => {
    let output = '';
    const timeout = setTimeout(() => rejectStarted(new Error('MCP lifecycle harness did not start')), 5_000);
    parent.once('error', rejectStarted);
    parent.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const lineEnd = output.indexOf('\n');
      if (lineEnd < 0) return;
      clearTimeout(timeout);
      resolveStarted(JSON.parse(output.slice(0, lineEnd)));
    });
  });
  assert.equal(started.ready.event, 'ready');
  for (const pid of [started.runtimePid, started.ready.mcpPid, started.ready.descendantPid]) {
    assert.equal(typeof pid, 'number');
    process.kill(pid, 0);
  }

  parent.kill('SIGKILL');
  await new Promise((resolveExit) => parent.once('exit', resolveExit));
  await Promise.all([
    waitForExit(started.runtimePid),
    waitForExit(started.ready.mcpPid),
    waitForExit(started.ready.descendantPid),
  ]);
});
