import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const electron = require('electron');
const desktopRoot = resolve(import.meta.dirname, '..');
const desktopMain = join(desktopRoot, 'dist/main.cjs');
const runtimeDist = resolve(desktopRoot, '../runtime/dist');

async function eventually(check, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 40));
  }
  throw new Error(message);
}

async function listen(server) {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return server.address().port;
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((done) => server.close(done));
  return port;
}

async function bridge(port) {
  const target = await eventually(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      return (await response.json()).find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    } catch { return undefined; }
  }, 'Fixture renderer debugger did not become ready.');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const reply = JSON.parse(event.data);
    const handler = pending.get(reply.id);
    if (!handler) return;
    pending.delete(reply.id);
    if (reply.error) handler.reject(new Error(reply.error.message));
    else handler.resolve(reply.result);
  });
  const command = (method, params = {}) => new Promise((resolveReply, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve: resolveReply, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await command('Runtime.enable');
  return {
    async evaluate(expression) {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(`Renderer evaluation failed: ${result.exceptionDetails.text}`);
      return result.result.value;
    },
    close() { socket.close(); },
  };
}

function childRuntimePid(electronPid) {
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match && Number(match[2]) === electronPid && match[3].includes('index.cjs --serve --port 0')) return Number(match[1]);
  }
  return undefined;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const root = await mkdtemp(join(tmpdir(), 'yuanpu-task-021-waiting-'));
const home = join(root, 'home');
const appRoot = join(root, 'apps', 'desktop');
const workspace = join(root, 'workspace');
const userData = join(root, 'desktop-user-data');
const apps = [];
let modelRequests = 0;
const provider = createServer(async (request, response) => {
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  for await (const _chunk of request) { /* consume synthetic request */ }
  modelRequests += 1;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({
    id: 'task-021-scheduled', object: 'chat.completion.chunk', created: 0, model: 'fixture-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture result' }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: 'task-021-scheduled', object: 'chat.completion.chunk', created: 0, model: 'fixture-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  })}\n\n`);
  response.end('data: [DONE]\n\n');
});
const rendererServer = createServer((_request, response) => response.end('<!doctype html><title>isolated task-021</title>'));

async function start(rendererPort) {
  const debugPort = await freePort();
  const child = spawn(electron, [`--remote-debugging-port=${debugPort}`, appRoot], {
    env: {
      ...process.env, YUANPU_HOME: home, YUANPU_RENDERER_URL: `http://127.0.0.1:${rendererPort}/`,
      YUANPU_NODE_BINARY: process.execPath, YUANPU_NOTIFICATIONS_ENABLED: '0', TASK_021_PROVIDER_KEY: 'fixture-only',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const diagnostics = [];
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
    if (diagnostics.length < 20) diagnostics.push(chunk.toString().slice(0, 500));
  });
  const app = { child, renderer: undefined, runtimePid: undefined };
  apps.push(app);
  try {
    app.renderer = await bridge(debugPort);
    await eventually(async () => {
      try { return (await app.renderer.evaluate('window.yuanpu.runtimeInfo()'))?.protocolVersion; }
      catch { return false; }
    }, 'Isolated Runtime bridge did not become ready.');
    app.runtimePid = await eventually(() => childRuntimePid(child.pid), 'Runtime child was not found.');
    return app;
  } catch (error) { throw new Error(`${error.message}; diagnostics=${diagnostics.join('').slice(-800)}`); }
}

async function stop(app) {
  await new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('App quit timed out.')), 15_000);
    app.child.once('exit', (code) => {
      clearTimeout(timeout);
      code === 0 ? done() : reject(new Error(`App exited with ${code}.`));
    });
    app.child.kill('SIGUSR2');
  });
  app.renderer.close();
  await eventually(() => !alive(app.runtimePid), 'Runtime child survived App quit.');
}

try {
  await mkdir(join(home, 'app'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(userData, { recursive: true });
  await mkdir(appRoot, { recursive: true });
  await mkdir(dirname(join(root, 'apps', 'runtime', 'dist')), { recursive: true });
  await symlink(runtimeDist, join(root, 'apps', 'runtime', 'dist'), 'dir');
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ name: 'task-021-isolated-app', version: '0.1.0', main: 'entry.cjs' }));
  await writeFile(join(appRoot, 'entry.cjs'), `
    const { app } = require('electron');
    app.setPath('userData', ${JSON.stringify(userData)});
    process.on('SIGUSR2', () => app.quit());
    require(${JSON.stringify(desktopMain)});
  `);
  const providerPort = await listen(provider);
  const rendererPort = await listen(rendererServer);
  await writeFile(join(home, 'app', 'config.json'), JSON.stringify({
    schemaVersion: 1, provider: 'task-021-fixture', model: 'fixture-model', apiKeyEnv: 'TASK_021_PROVIDER_KEY',
    workingDirectory: workspace, baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions',
  }));
  const first = await start(rendererPort);
  const due = new Date(Date.now() + 5_000).toISOString();
  const input = {
    contractVersion: 1, name: 'Waiting restart fixture', prompt: 'Give a short synthetic result.',
    workspaceId: workspace, timing: { kind: 'once', at: due }, timeZone: 'UTC',
    maximumLatenessMs: 30_000, delivery: { kind: 'desktop' },
  };
  const created = await first.renderer.evaluate(`window.yuanpu.createSchedule(${JSON.stringify(input)})`);
  assert.equal(created.nextTriggerAt, due);
  await stop(first);
  assert.equal(modelRequests, 0, 'App quit before due time must not execute the schedule.');
  const waitMs = new Date(due).getTime() - Date.now() + 250;
  if (waitMs > 0) await new Promise((done) => setTimeout(done, waitMs));
  assert.equal(modelRequests, 0, 'No background execution is allowed after App quit.');

  const second = await start(rendererPort);
  const history = await eventually(async () => {
    const rows = await second.renderer.evaluate(`window.yuanpu.getScheduleHistory(${JSON.stringify(created.scheduleId)})`);
    return rows?.[0]?.runStatus === 'succeeded' ? rows : undefined;
  }, 'Missed due schedule did not complete after App restart.');
  assert.equal(history.length, 1);
  assert.equal(history[0].triggerStatus, 'submitted');
  assert.equal(modelRequests, 1);
  assert.equal((await second.renderer.evaluate('window.yuanpu.listSchedules()')).length, 1);
  const database = new DatabaseSync(join(home, 'workflows', 'automation.sqlite'), { readOnly: true });
  const facts = database.prepare('SELECT COUNT(*) AS triggers, COUNT(DISTINCT run_id) AS runs FROM yp_schedule_triggers WHERE schedule_id = ?').get(created.scheduleId);
  database.close();
  assert.equal(facts.triggers, 1);
  assert.equal(facts.runs, 1);
  await stop(second);
  console.log(JSON.stringify({ status: 'passed', appLaunches: 2, triggerCount: 1, runCount: 1, modelRequests, runtimeChildrenStopped: true }));
} finally {
  for (const app of apps) {
    app.renderer?.close();
    if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill('SIGKILL');
    if (app.runtimePid && alive(app.runtimePid)) {
      const command = execFileSync('ps', ['-p', String(app.runtimePid), '-o', 'command='], { encoding: 'utf8' });
      if (command.includes(join(root, 'apps', 'runtime', 'dist', 'index.cjs'))) process.kill(app.runtimePid, 'SIGKILL');
    }
  }
  provider.closeAllConnections();
  await Promise.all([
    new Promise((done) => provider.close(done)),
    new Promise((done) => rendererServer.close(done)),
  ]);
  await rm(root, { recursive: true, force: true });
}
