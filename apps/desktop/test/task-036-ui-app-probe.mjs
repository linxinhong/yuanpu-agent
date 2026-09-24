import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const rendererUrl = process.env.TASK_036_RENDERER_URL;
if (!rendererUrl || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(rendererUrl)) {
  throw new Error('Set TASK_036_RENDERER_URL to the isolated worktree Vite URL.');
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
      if (reply.exceptionDetails) throw new Error(`Renderer evaluation failed: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);
      return reply.result.value;
    },
    command,
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

const root = await mkdtemp(join(tmpdir(), 'yuanpu-task-036-electron-'));
const appRoot = join(root, 'apps', 'desktop');
const home = join(root, 'home');
const workspace = join(root, 'workspace');
const userData = join(root, 'desktop-user-data');
let providerRequests = 0;
const live = process.env.TASK_036_LIVE === '1';
const screenshots = resolve(desktopRoot, '../../docs/frontend/evidence/task-036');
let mode = 'success';
const provider = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end(); return;
  }
  for await (const _chunk of request) { /* Only synthetic prompts are used by this fixture. */ }
  providerRequests += 1;
  if (mode === 'hold') return;
  if (mode === 'failure') { response.writeHead(400).end(JSON.stringify({ error: { message: 'Controlled provider failure' } })); return; }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  response.write(chunk({ role: 'assistant', content: 'UI fixture reply completed.' }));
  response.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
});
let child;
let renderer;
let runtimePid;
try {
  await mkdir(appRoot, { recursive: true });
  await mkdir(screenshots, { recursive: true });
  await symlink(resolve(desktopRoot, '../python-capabilities'), join(root, 'apps/python-capabilities'), 'dir');
  await mkdir(join(home, 'app'), { recursive: true });
  await mkdir(userData, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(dirname(join(root, 'apps', 'runtime', 'dist')), { recursive: true });
  await symlink(runtimeDist, join(root, 'apps', 'runtime', 'dist'), 'dir');
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({
    name: 'yuanpu-task-036-isolated-app', version: '0.1.0', main: 'entry.cjs',
  }));
  await writeFile(join(appRoot, 'entry.cjs'), `
    const { app } = require('electron');
    app.setPath('userData', ${JSON.stringify(userData)});
    process.on('SIGUSR2', () => app.quit());
    require(${JSON.stringify(desktopMain)});
  `);
  const providerPort = await listen(provider);
  const config = live
    ? JSON.parse(await readFile(join(homedir(), '.yuanpu/app/config.json'), 'utf8'))
    : { schemaVersion: 1, provider: 'task-036-fixture', model: 'fixture-model',
      apiKeyEnv: 'TASK_036_PROVIDER_KEY', baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions' };
  if (live && !process.env[config.apiKeyEnv]) throw new Error('Configured live model credential is unavailable.');
  await writeFile(join(home, 'app', 'config.json'), JSON.stringify({ ...config, workingDirectory: workspace }));
  const debuggerPort = await freePort();
  child = spawn(electron, [`--remote-debugging-port=${debuggerPort}`, appRoot], {
    env: {
      ...process.env,
      YUANPU_HOME: home,
      YUANPU_RENDERER_URL: rendererUrl,
      YUANPU_NODE_BINARY: process.execPath,
      YUANPU_NOTIFICATIONS_ENABLED: '0',
      TASK_036_PROVIDER_KEY: 'fixture-only',
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
  await eventually(() => renderer.evaluate('document.querySelectorAll(".nav-item").length === 4'), 'Renderer UI did not mount.');
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
  await renderer.evaluate(`Array.from(document.querySelectorAll('.nav-item')).find((button) => button.textContent.trim() === '聊天').click()`);
  const body = () => renderer.evaluate('document.body.innerText');
  const click = (selector) => renderer.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = async (text) => {
    await renderer.evaluate(`(() => {
      const field = document.querySelector('textarea[aria-label="消息"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(text)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  };
  const latestRun = async () => {
    const database = new DatabaseSync(join(home, 'workflows/automation.sqlite'), { readOnly: true });
    const row = database.prepare("SELECT run_id FROM yp_agent_runs WHERE entry_point = 'desktop' ORDER BY created_at DESC LIMIT 1").get();
    database.close();
    return row ? renderer.evaluate(`window.yuanpu.getAgentRun(${JSON.stringify(row.run_id)})`) : undefined;
  };
  const runCount = async () => {
    const database = new DatabaseSync(join(home, 'workflows/automation.sqlite'), { readOnly: true });
    const row = database.prepare("SELECT count(*) AS n FROM yp_agent_runs WHERE entry_point = 'desktop'").get();
    database.close(); return row.n;
  };
  const send = async (text) => {
    const before = await runCount();
    await fill(text);
    await click('[aria-label="发送消息"]');
    await eventually(async () => (await runCount()) === before + 1, 'Message was not submitted exactly once.');
  };
  const waitTerminal = async () => {
    const run = await eventually(async () => {
      const current = await latestRun();
      return current && ['succeeded', 'failed', 'cancelled', 'interrupted', 'result_unknown'].includes(current.status) ? current : undefined;
    }, 'Run did not finish.', live ? 120_000 : 20_000);
    await eventually(async () => !(await renderer.evaluate('Boolean(document.querySelector(".thinking"))')), 'UI stayed busy after terminal state.');
    return run;
  };
  const shot = async (name) => {
    const image = await renderer.command('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(screenshots, name + '.png'), Buffer.from(image.data, 'base64'));
  };

  await send(live ? '请只回复 UI 验证通过。不要调用任何工具。' : 'Complete a synthetic UI message.');
  const first = await waitTerminal();
  assert.equal(first.status, 'succeeded');
  assert.ok(first.output?.message);
  await eventually(async () => (await body()).includes(first.output.message), 'Model response missing in UI.');

  // Native modal keyboard behavior and all supported viewport bounds.
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [390, 844]]) {
    await renderer.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await eventually(async () => await renderer.evaluate(`window.innerWidth === ${width}`), 'Viewport did not update.');
    if (width <= 1100) {
      await eventually(async () => !(await renderer.evaluate('Boolean(document.querySelector(".activity-panel"))')), 'Narrow panel did not collapse.');
      await click('[aria-label="打开会话动态"]');
      await eventually(async () => await renderer.evaluate('Boolean(document.querySelector("dialog:modal"))'), 'Drawer is not modal.');
      await renderer.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await renderer.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await eventually(async () => await renderer.evaluate('document.activeElement?.getAttribute("aria-label") === "打开会话动态"'), 'Escape did not restore trigger focus.');
    }
    assert.equal(await renderer.evaluate('document.documentElement.scrollWidth > innerWidth'), false);
    assert.equal(await renderer.evaluate('document.querySelector(".composer").getBoundingClientRect().bottom <= innerHeight'), true);
    await shot(`${live ? 'live' : 'fixture'}-chat-${width}`);
  }
  await renderer.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await click('[aria-label="打开会话动态"]');

  if (live) {
    for (const decision of ['approved', 'denied']) {
      await send('请查找并调用 yuanpu_approved_echo，参数 text 为 UI-036-' + decision + '。这是需要宿主一次授权的无副作用回显工具，请只调用一次，等待用户决定，不改用其他工具。');
      await eventually(async () => (await renderer.evaluate('window.yuanpu.listCapabilityApprovals()')).length > 0,
        'Live model did not request the controlled echo approval.', 120_000);
      await eventually(() => renderer.evaluate('Array.from(document.querySelectorAll(".approval-actions button")).some(button => button.textContent.trim() === "允许一次" && !button.disabled)'), 'Approval controls absent.', 120_000).catch(async (error) => {
        await shot('live-approval-failure');
        const run = await latestRun();
        console.log({ runStatus: run?.status, hasBinding: Boolean(run?.pendingApproval), pendingCount: (await renderer.evaluate('window.yuanpu.listCapabilityApprovals()')).length });
        throw error;
      });
      await renderer.evaluate(`Array.from(document.querySelectorAll('.approval-actions button')).find((button) => button.textContent.trim() === ${JSON.stringify(decision === 'approved' ? '允许一次' : '拒绝')}).click()`);
      await eventually(async () => (await renderer.evaluate('window.yuanpu.listCapabilityApprovals()')).length === 0, 'Host did not resolve approval.').catch(async (error) => {
        await shot('live-approval-failure');
        console.log(await renderer.evaluate('Array.from(document.querySelectorAll(".message.error p")).map(p => p.textContent)'));
        throw error;
      });
      const run = await waitTerminal();
      assert.equal(run.status, decision === 'approved' ? 'succeeded' : 'failed');
      if (decision === 'approved') {
        assert.ok(run.output?.message.includes('UI-036-approved'));
        assert.equal(await renderer.evaluate('Array.from(document.querySelectorAll(".message.assistant .message-body p")).filter(p => p.textContent.includes("UI-036-approved")).length'), 1);
      }
      assert.ok((await body()).includes(decision === 'approved' ? '已允许一次' : '已拒绝授权'));
      await shot('live-approval-' + decision);
    }
  } else {
    mode = 'failure';
    await send('Retain this failed prompt.');
    assert.equal((await waitTerminal()).status, 'failed');
    assert.equal(await renderer.evaluate('document.querySelector("textarea").value'), 'Retain this failed prompt.');
    mode = 'hold';
    const before = providerRequests;
    await send('Hold this controlled request until cancelled.');
    await eventually(() => providerRequests === before + 1, 'Provider did not receive the pending request.');
    await fill('A next draft must not be submitted while busy.');
    assert.equal(await renderer.evaluate('document.querySelector(".composer button").disabled'), true);
    const count = await runCount();
    await click('[aria-label="发送消息"]');
    assert.equal(await runCount(), count);
    await eventually(async () => (await body()).includes('取消任务'), 'Cancellation missing.');
    await renderer.evaluate(`window.confirm = () => true; Array.from(document.querySelectorAll('button')).find((button) => button.textContent === '取消任务').click()`);
    assert.equal((await waitTerminal()).status, 'cancelled');
    assert.equal(await renderer.evaluate('document.querySelector("textarea").value'), 'A next draft must not be submitted while busy.');
    await shot('fixture-cancelled');
  }
  if (process.env.TASK_036_INSPECT === '1') {
    await renderer.command('Emulation.clearDeviceMetricsOverride');
    console.log('Native inspection window ready (45 seconds).');
    await new Promise((resolvePause) => setTimeout(resolvePause, 45_000));
  }
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
    mode: live ? "live-provider" : "controlled-provider",
    viewportAndKeyboard: true,
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
