import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const electron = require('electron');
const desktopRoot = resolve(import.meta.dirname, '..');
const desktopMain = join(desktopRoot, 'dist/main.cjs');
const rendererRoot = resolve(desktopRoot, '../app/dist');
const fixtureRuntime = join(import.meta.dirname, 'task-021-im-runtime-fixture.mjs');
const root = await mkdtemp(join(tmpdir(), 'yuanpu-task-021-im-app-'));
const home = join(root, 'home');
const appRoot = join(root, 'apps', 'desktop');
const workspace = join(home, 'workspace');
const userData = join(root, 'user-data');
const apps = [];

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
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === 'page' && item.webSocketDebuggerUrl); }
    catch { return undefined; }
  }, 'Renderer debugger did not become ready.');
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
  const command = (method, params = {}) => new Promise((done, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve: done, reject });
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
function runtimePid(electronPid) {
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match && Number(match[2]) === electronPid && match[3].includes('index.cjs --serve --port 0')) return Number(match[1]);
  }
  return undefined;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
const staticServer = createServer(async (request, response) => {
  const path = request.url === '/' ? 'index.html' : request.url.slice(1);
  if (!/^\/?(?:index\.html|assets\/[A-Za-z0-9._-]+)$/.test(path)) { response.writeHead(404).end(); return; }
  const content = await readFile(join(rendererRoot, path)).catch(() => undefined);
  if (!content) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'content-type': path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' }).end(content);
});
async function start(rendererPort) {
  const debugPort = await freePort();
  const child = spawn(electron, [`--remote-debugging-port=${debugPort}`, appRoot], {
    env: { ...process.env, YUANPU_HOME: home, YUANPU_RENDERER_URL: `http://127.0.0.1:${rendererPort}/`, YUANPU_NODE_BINARY: process.execPath, YUANPU_NOTIFICATIONS_ENABLED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const diagnostics = [];
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
    if (diagnostics.length < 20) diagnostics.push(chunk.toString().slice(0, 300));
  });
  const app = { child, renderer: undefined, runtimePid: undefined };
  apps.push(app);
  try {
    app.renderer = await bridge(debugPort);
    await eventually(async () => {
      try { return (await app.renderer.evaluate('window.yuanpu.runtimeInfo()'))?.protocolVersion; }
      catch { return false; }
    }, 'Isolated Runtime bridge did not become ready.');
    app.runtimePid = await eventually(() => runtimePid(child.pid), 'Runtime fixture child was not found.');
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
function databaseFacts() {
  const db = new DatabaseSync(join(home, 'workflows', 'automation.sqlite'), { readOnly: true });
  try {
    return db.prepare(`SELECT
      (SELECT COUNT(*) FROM yp_channel_inbound) AS inbounds,
      (SELECT COUNT(*) FROM yp_channel_outbound) AS outbounds,
      (SELECT COUNT(*) FROM yp_agent_runs WHERE entry_point='im') AS im_runs,
      (SELECT status FROM yp_channel_outbound LIMIT 1) AS delivery_status,
      (SELECT status FROM yp_agent_runs WHERE entry_point='im' LIMIT 1) AS run_status`).get();
  } finally { db.close(); }
}
try {
  await mkdir(join(home, 'workflows'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(appRoot, { recursive: true });
  await mkdir(userData, { recursive: true });
  await mkdir(dirname(join(root, 'apps', 'runtime', 'dist', 'index.cjs')), { recursive: true });
  await writeFile(join(root, 'apps', 'runtime', 'dist', 'index.cjs'), `import(${JSON.stringify(new URL(`file://${fixtureRuntime}`).href)});`);
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ name: 'task-021-im-app-fixture', version: '0.1.0', main: 'entry.cjs' }));
  await writeFile(join(appRoot, 'entry.cjs'), `
    const { app } = require('electron');
    app.setPath('userData', ${JSON.stringify(userData)});
    process.on('SIGUSR2', () => app.quit());
    require(${JSON.stringify(desktopMain)});
  `);
  const rendererPort = await listen(staticServer);
  const first = await start(rendererPort);
  const firstPort = (await eventually(async () => JSON.parse(await readFile(join(home, 'fixture-port.json'), 'utf8').catch(() => 'null'))?.port, 'Fixture port missing.'));
  const initial = await (await fetch(`http://127.0.0.1:${firstPort}/fixture/inbound`, { method: 'POST' })).json();
  assert.equal(initial.accepted, true);
  await eventually(() => databaseFacts().delivery_status === 'delivering', 'Outbound did not enter delivering.');
  assert.equal(databaseFacts().run_status, 'succeeded');
  assert.deepEqual(JSON.parse(await readFile(join(home, 'fixture-metrics.json'), 'utf8')), { executions: 1, sends: 1 });
  await stop(first);
  const second = await start(rendererPort);
  await eventually(() => databaseFacts().delivery_status === 'unknown', 'Restart did not mark uncertain outbound unknown.');
  const secondPort = JSON.parse(await readFile(join(home, 'fixture-port.json'), 'utf8')).port;
  const replay = await (await fetch(`http://127.0.0.1:${secondPort}/fixture/inbound`, { method: 'POST' })).json();
  assert.equal(replay.accepted, true);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.runId, initial.runId);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'fixture-metrics.json'), 'utf8')), { executions: 1, sends: 1 });
  assert.deepEqual({ ...databaseFacts() }, { inbounds: 1, outbounds: 1, im_runs: 1, delivery_status: 'unknown', run_status: 'succeeded' });
  const run = await second.renderer.evaluate(`window.yuanpu.getAgentRun(${JSON.stringify(initial.runId)})`);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.owner.entryPoint, 'im');
  assert.equal('deliveryStatus' in run || 'outboundStatus' in run, false);
  const uiFacts = await second.renderer.evaluate(`({
    mounted: Boolean(document.querySelector('.app-shell')),
    imDeliveryLabel: document.body.innerText.includes('投递结果未知'),
    outboundBridge: Object.keys(window.yuanpu).some((name) => /outbound|imDelivery/i.test(name)),
  })`);
  assert.equal(uiFacts.mounted, true);
  assert.equal(uiFacts.outboundBridge, false);
  await stop(second);
  console.log(JSON.stringify({ status: 'passed', appLaunches: 2, outbound: 'unknown', imRuns: 1, sends: 1, agentExecutions: 1, rendererMounted: uiFacts.mounted, imDeliveryVisible: uiFacts.imDeliveryLabel, outboundBridge: uiFacts.outboundBridge, runtimeChildrenStopped: true }));
} finally {
  for (const app of apps) {
    app.renderer?.close();
    if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill('SIGKILL');
    if (app.runtimePid && alive(app.runtimePid)) {
      const command = execFileSync('ps', ['-p', String(app.runtimePid), '-o', 'command='], { encoding: 'utf8' });
      if (command.includes(join(root, 'apps', 'runtime', 'dist', 'index.cjs'))) process.kill(app.runtimePid, 'SIGKILL');
    }
  }
  staticServer.closeAllConnections();
  await new Promise((done) => staticServer.close(done));
  await rm(root, { recursive: true, force: true });
}
