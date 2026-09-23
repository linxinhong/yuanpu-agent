import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isFixtureRuntime(pid, root) {
  if (!processExists(pid)) return false;
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return command.includes(join(root, 'apps', 'runtime', 'dist', 'index.cjs'));
  } catch {
    return false;
  }
}

async function debuggerPort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function connectRenderer(port) {
  const target = await eventually(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      return targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    } catch {
      return undefined;
    }
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
      const reply = await command('Runtime.evaluate', {
        expression, awaitPromise, returnByValue: true,
      });
      if (reply.exceptionDetails) throw new Error('Renderer evaluation failed.');
      return reply.result.value;
    },
    close: () => socket.close(),
  };
}

async function startApp(appRoot, rendererPort, home) {
  const port = await debuggerPort();
  const child = spawn(electron, [`--remote-debugging-port=${port}`, appRoot], {
    env: {
      ...process.env,
      YUANPU_HOME: home,
      YUANPU_RENDERER_URL: `http://127.0.0.1:${rendererPort}/`,
      YUANPU_NODE_BINARY: process.execPath,
      YUANPU_NOTIFICATIONS_ENABLED: '0',
      TASK_019_PROVIDER_KEY: 'fixture-only',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      if (diagnostics.length < 16_384) diagnostics += chunk.toString();
    });
  }
  try {
    const renderer = await connectRenderer(port);
    await eventually(async () => {
      try {
        const info = await renderer.evaluate('window.yuanpu.runtimeInfo()');
        return info?.protocolVersion ? info : undefined;
      } catch {
        return undefined;
      }
    }, 'Electron IPC Runtime info was not ready.');
    return { child, renderer };
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`${error.message}; Electron exit=${String(child.exitCode)}; diagnostics=${diagnostics.slice(-1_000)}`);
  }
}

async function stopApp(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => rejectExit(new Error('Electron quit timed out.')), 15_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveExit();
      else rejectExit(new Error(`Electron exit was ${String(code)}/${String(signal)}.`));
    });
    child.kill('SIGUSR2');
  });
}

const root = await mkdtemp(join(tmpdir(), 'yuanpu-task-019-electron-'));
const appRoot = join(root, 'apps', 'desktop');
const home = join(root, 'home');
const workspace = join(root, 'workspace');
const provider = createServer(async (request) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return;
  for await (const _chunk of request) { /* consume the fixture request */ }
  providerRequests += 1;
  // Leave the model request in flight until App shutdown closes it.
});
const rendererServer = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<!doctype html><title>TASK-019 isolated renderer</title>');
});
let providerRequests = 0;
const apps = [];
const runtimePids = new Set();
try {
  await mkdir(appRoot, { recursive: true });
  await mkdir(join(home, 'app'), { recursive: true });
  await mkdir(join(root, 'desktop-user-data'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(dirname(join(root, 'apps', 'runtime', 'dist')), { recursive: true });
  await symlink(runtimeDist, join(root, 'apps', 'runtime', 'dist'), 'dir');
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({
    name: 'yuanpu-task-019-isolated-app', version: '0.1.0', main: 'entry.cjs',
  }));
  await writeFile(join(appRoot, 'entry.cjs'), `
    const { app } = require('electron');
    app.setPath('userData', ${JSON.stringify(join(root, 'desktop-user-data'))});
    process.on('SIGUSR2', () => app.quit());
    require(${JSON.stringify(desktopMain)});
  `);
  const providerPort = await listen(provider);
  const rendererPort = await listen(rendererServer);
  await writeFile(join(home, 'app', 'config.json'), JSON.stringify({
    schemaVersion: 1,
    provider: 'task-019-fixture',
    model: 'fixture-model',
    apiKeyEnv: 'TASK_019_PROVIDER_KEY',
    workingDirectory: workspace,
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    api: 'openai-completions',
  }));

  const first = await startApp(appRoot, rendererPort, home);
  apps.push(first);
  const firstRuntimePid = await eventually(() => childRuntimePid(first.child.pid), 'First App Runtime child missing.');
  runtimePids.add(firstRuntimePid);
  await first.renderer.evaluate("window.__task019Chat = window.yuanpu.chat('hold fixture model response').catch(() => undefined); 'submitted'", false);
  const databasePath = join(home, 'workflows', 'automation.sqlite');
  const runId = await eventually(() => {
    try {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      const row = database.prepare("SELECT run_id, status FROM yp_agent_runs WHERE entry_point = 'desktop' ORDER BY created_at DESC LIMIT 1").get();
      database.close();
      return row?.status === 'running' && providerRequests === 1 ? row.run_id : undefined;
    } catch {
      return undefined;
    }
  }, 'App did not create one running model request.');
  await stopApp(first.child);
  first.renderer.close();
  await eventually(() => !processExists(firstRuntimePid), 'Runtime child survived App quit.');

  const database = new DatabaseSync(databasePath, { readOnly: true });
  const stopped = database.prepare('SELECT status, external_effect_state FROM yp_agent_runs WHERE run_id = ?').get(runId);
  database.close();
  assert.equal(stopped.status, 'result_unknown');
  assert.equal(stopped.external_effect_state, 'possible');

  const second = await startApp(appRoot, rendererPort, home);
  apps.push(second);
  const secondRuntimePid = await eventually(() => childRuntimePid(second.child.pid), 'Reopened App Runtime child missing.');
  runtimePids.add(secondRuntimePid);
  const recovered = await second.renderer.evaluate(`window.yuanpu.getAgentRun(${JSON.stringify(runId)})`);
  assert.equal(recovered.runId, runId);
  assert.equal(recovered.status, 'result_unknown');
  assert.equal(providerRequests, 1);
  await stopApp(second.child);
  second.renderer.close();
  await eventually(() => !processExists(secondRuntimePid), 'Reopened App Runtime child survived quit.');
  console.log(JSON.stringify({
    status: 'passed',
    appLaunches: 2,
    modelRequests: providerRequests,
    recoveredStatus: recovered.status,
    externalEffectState: stopped.external_effect_state,
    runtimeChildrenStopped: true,
  }));
} finally {
  for (const { child, renderer } of apps) {
    renderer.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const pid of runtimePids) {
    if (isFixtureRuntime(pid, root)) process.kill(pid, 'SIGKILL');
  }
  provider.closeAllConnections();
  await Promise.all([
    new Promise((resolveClose) => provider.close(resolveClose)),
    new Promise((resolveClose) => rendererServer.close(resolveClose)),
  ]);
  await rm(root, { recursive: true, force: true });
}
