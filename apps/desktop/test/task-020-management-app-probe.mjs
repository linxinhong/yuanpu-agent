import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const rendererUrl = process.env.TASK_020_RENDERER_URL;
if (!rendererUrl || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(rendererUrl)) {
  throw new Error('Set TASK_020_RENDERER_URL to the isolated worktree Vite URL.');
}
const require = createRequire(import.meta.url);
const electron = require('electron');
const desktopRoot = resolve(import.meta.dirname, '..');
const runtimeDist = resolve(desktopRoot, '../runtime/dist');
const desktopMain = join(desktopRoot, 'dist/main.cjs');

async function eventually(check, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  }
  throw new Error(message);
}

async function listen(server) {
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return server.address().port;
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function connectRenderer(port) {
  const target = await eventually(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      return (await response.json()).find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    } catch { return undefined; }
  }, 'Electron renderer debugger did not become ready.');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', rejectOpen, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolveReply, rejectReply } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) rejectReply(new Error(message.error.message));
    else resolveReply(message.result);
  });
  const command = (method, params = {}) => new Promise((resolveReply, rejectReply) => {
    const id = ++nextId;
    pending.set(id, { resolveReply, rejectReply });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await command('Runtime.enable');
  return {
    async evaluate(expression, awaitPromise = true) {
      const reply = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
      if (reply.exceptionDetails) throw new Error(`Renderer evaluation failed: ${reply.exceptionDetails.text}`);
      return reply.result.value;
    },
    close: () => socket.close(),
  };
}

function childRuntimePid(electronPid) {
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match && Number(match[2]) === electronPid && match[3].includes('index.cjs --serve --port 0')) {
      return Number(match[1]);
    }
  }
  return undefined;
}

function exists(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const root = await mkdtemp(join(tmpdir(), 'yuanpu-task-020-electron-'));
const appRoot = join(root, 'apps', 'desktop');
const home = join(root, 'home');
const workspace = join(root, 'workspace');
const userData = join(root, 'desktop-user-data');
let providerRequests = 0;
const provider = createServer(async (request) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return;
  for await (const _chunk of request) { /* consume synthetic request */ }
  providerRequests += 1;
  // Deliberately leave the fixture model call pending until cancellation.
});
let child;
let renderer;
let runtimePid;
try {
  await mkdir(appRoot, { recursive: true });
  await mkdir(join(home, 'app'), { recursive: true });
  await mkdir(userData, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(dirname(join(root, 'apps', 'runtime', 'dist')), { recursive: true });
  await symlink(runtimeDist, join(root, 'apps', 'runtime', 'dist'), 'dir');
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({
    name: 'yuanpu-task-020-isolated-app', version: '0.1.0', main: 'entry.cjs',
  }));
  await writeFile(join(appRoot, 'entry.cjs'), `
    const { app } = require('electron');
    app.setPath('userData', ${JSON.stringify(userData)});
    process.on('SIGUSR2', () => app.quit());
    require(${JSON.stringify(desktopMain)});
  `);
  const providerPort = await listen(provider);
  await writeFile(join(home, 'app', 'config.json'), JSON.stringify({
    schemaVersion: 1,
    provider: 'task-020-fixture',
    model: 'fixture-model',
    apiKeyEnv: 'TASK_020_PROVIDER_KEY',
    workingDirectory: workspace,
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    api: 'openai-completions',
  }));
  const debuggerPort = await freePort();
  child = spawn(electron, [`--remote-debugging-port=${debuggerPort}`, appRoot], {
    env: {
      ...process.env,
      YUANPU_HOME: home,
      YUANPU_RENDERER_URL: rendererUrl,
      YUANPU_NODE_BINARY: process.execPath,
      YUANPU_NOTIFICATIONS_ENABLED: '0',
      TASK_020_PROVIDER_KEY: 'fixture-only',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { if (diagnostics.length < 8_192) diagnostics += chunk.toString(); });
  }
  try {
    renderer = await connectRenderer(debuggerPort);
    await eventually(async () => {
      try { return (await renderer.evaluate('window.yuanpu.runtimeInfo()')).workingDirectory === workspace; }
      catch { return false; }
    }, 'Isolated Electron bridge did not become ready.');
  } catch (error) {
    throw new Error(`${error.message}; diagnostics=${diagnostics.slice(-700)}`);
  }
  runtimePid = await eventually(() => childRuntimePid(child.pid), 'Runtime child missing.');
  const connectionId = `imc_${randomUUID()}`;
  const connection = await renderer.evaluate(`window.yuanpu.saveWecomConnection(${JSON.stringify({
    connectionId, botId: 'fixture-bot', enabled: false,
  })})`);
  assert.equal(connection.status, 'disabled');
  assert.equal((await renderer.evaluate('window.yuanpu.listWecomConnections()')).connections.length, 1);
  const input = {
    contractVersion: 1,
    name: 'Fixture scheduled note',
    prompt: 'Summarize the synthetic workspace.',
    workspaceId: workspace,
    timing: { kind: 'once', at: '2099-01-01T00:00:00.000Z' },
    timeZone: 'Asia/Shanghai',
    delivery: { kind: 'desktop' },
  };
  const preview = await renderer.evaluate(`window.yuanpu.previewSchedule(${JSON.stringify(input)})`);
  assert.equal(preview.nextTriggerAt, '2099-01-01T00:00:00.000Z');
  const created = await renderer.evaluate(`window.yuanpu.createSchedule(${JSON.stringify(input)})`);
  assert.equal(created.nextTriggerAt, preview.nextTriggerAt);
  await renderer.evaluate(`window.yuanpu.setScheduleEnabled(${JSON.stringify(created.scheduleId)}, false)`);
  assert.equal((await renderer.evaluate('window.yuanpu.listSchedules()'))[0].enabled, false);
  await renderer.evaluate(`Array.from(document.querySelectorAll('.nav-item')).find((button) => button.textContent.includes('定时任务')).click()`);
  await eventually(async () => (await renderer.evaluate('document.body.innerText')).includes('Fixture scheduled note'), 'Real schedule did not appear in the Electron UI.');
  await renderer.evaluate(`Array.from(document.querySelectorAll('.nav-item')).find((button) => button.textContent.includes('连接')).click()`);
  await eventually(async () => (await renderer.evaluate('document.body.innerText')).includes(connectionId), 'Real connection did not appear in the Electron UI.');
  assert.equal((await renderer.evaluate('document.body.innerText')).includes('fixture-bot'), false);
  await renderer.evaluate(`Array.from(document.querySelectorAll('.nav-item')).find((button) => button.textContent.includes('新对话')).click()`);
  await renderer.evaluate(`(() => {
    const field = document.querySelector('textarea[aria-label="消息"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(field, 'hold fixture model response');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await renderer.evaluate(`Array.from(document.querySelectorAll('.composer button')).find((button) => button.textContent.includes('发送')).click()`);
  await eventually(() => providerRequests === 1, 'Chat UI did not submit one model request.');
  const runId = await eventually(() => {
    try {
      const database = new DatabaseSync(join(home, 'workflows', 'automation.sqlite'), { readOnly: true });
      const row = database.prepare("SELECT run_id, status FROM yp_agent_runs WHERE entry_point = 'desktop' ORDER BY created_at DESC LIMIT 1").get();
      database.close();
      return row?.status === 'running' ? row.run_id : undefined;
    } catch { return undefined; }
  }, 'Desktop run was not active.');
  await eventually(async () => (await renderer.evaluate('document.body.innerText')).includes('取消任务'), 'Chat UI did not expose cancellation.');
  await renderer.evaluate(`window.confirm = () => true; Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '取消任务').click()`);
  const terminal = await eventually(async () => {
    const run = await renderer.evaluate(`window.yuanpu.getAgentRun(${JSON.stringify(runId)})`);
    return ['cancelled', 'interrupted', 'result_unknown'].includes(run.status) ? run.status : undefined;
  }, 'Cancelled run did not reach a terminal state.');
  assert.equal(terminal, 'cancelled');
  await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => rejectExit(new Error('Electron quit timed out.')), 15_000);
    child.once('exit', (code) => { clearTimeout(timeout); code === 0 ? resolveExit() : rejectExit(new Error(`Electron exited ${code}`)); });
    child.kill('SIGUSR2');
  });
  await eventually(() => !exists(runtimePid), 'Runtime child survived App quit.');
  console.log(JSON.stringify({
    status: 'passed',
    schedulePersisted: true,
    connectionStatus: connection.status,
    chatCancellationTerminal: terminal,
    providerRequests,
    runtimeChildrenStopped: true,
  }));
} finally {
  renderer?.close();
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  provider.closeAllConnections();
  await new Promise((resolveClose) => provider.close(resolveClose));
  if (runtimePid && exists(runtimePid)) {
    const command = execFileSync('ps', ['-p', String(runtimePid), '-o', 'command='], { encoding: 'utf8' });
    if (command.includes(join(root, 'apps', 'runtime', 'dist', 'index.cjs'))) process.kill(runtimePid, 'SIGKILL');
  }
  await rm(root, { recursive: true, force: true });
}
