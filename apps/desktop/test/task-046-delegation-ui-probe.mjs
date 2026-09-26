import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const electron = require('electron');
const desktopRoot = resolve(import.meta.dirname, '..');
const runtimeDist = resolve(desktopRoot, '../runtime/dist');
const desktopMain = join(desktopRoot, 'dist/main.cjs');
const rendererUrl = process.env.TASK_046_RENDERER_URL;
if (!rendererUrl || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(rendererUrl)) {
  throw new Error('Set TASK_046_RENDERER_URL to this worktree Vite URL.');
}

async function eventually(check, label, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { const result = await check(); if (result) return result; }
    catch { /* A real process or renderer may still be starting. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out awaiting ${label}.`);
}

async function listen(server) {
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return server.address().port;
}

async function connectRenderer(port) {
  const target = await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    return (await response.json()).find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  }, 'renderer debugger');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', rejectOpen, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const reply = JSON.parse(event.data);
    if (!reply.id || !pending.has(reply.id)) return;
    const { resolveReply, rejectReply } = pending.get(reply.id);
    pending.delete(reply.id);
    if (reply.error) rejectReply(new Error(reply.error.message));
    else resolveReply(reply.result);
  });
  const command = (method, params = {}) => new Promise((resolveReply, rejectReply) => {
    const id = ++nextId;
    pending.set(id, { resolveReply, rejectReply });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await command('Runtime.enable');
  return {
    async evaluate(expression) {
      const reply = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
      return reply.result.value;
    },
    close: () => socket.close(),
  };
}

test('isolated Electron Assistant displays and signs a professional task grant', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-delegation-electron-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appRoot = join(root, 'apps', 'desktop');
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const userData = join(root, 'desktop-user-data');
  await Promise.all([mkdir(appRoot, { recursive: true }), mkdir(join(home, 'app'), { recursive: true }),
    mkdir(join(home, 'agent', 'skills', 'reviewer'), { recursive: true }), mkdir(workspace), mkdir(userData),
    mkdir(dirname(join(root, 'apps', 'runtime', 'dist')), { recursive: true })]);
  await symlink(runtimeDist, join(root, 'apps', 'runtime', 'dist'), 'dir');
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ name: 'task-046-isolated-app',
    version: '0.1.0', main: 'entry.cjs' }));
  await writeFile(join(appRoot, 'entry.cjs'), `
    const { app } = require('electron');
    app.setPath('userData', ${JSON.stringify(userData)});
    process.on('SIGUSR2', () => app.quit());
    require(${JSON.stringify(desktopMain)});
  `);
  await writeFile(join(home, 'agent', 'skills', 'reviewer', 'SKILL.md'),
    '---\nname: reviewer\ndescription: Fixture review.\n---\n\n# Review\nReturn a bounded result.\n');
  let professionalCalls = 0;
  const provider = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const tools = (input.tools ?? []).map((tool) => tool.function?.name);
    const returned = input.messages.some((message) => message.role === 'tool');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'fixture',
      object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
      choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    if (tools.includes('delegate_and_verify') && !returned) {
      response.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'delegate-once',
        type: 'function', function: { name: 'delegate_and_verify', arguments: JSON.stringify({
          action: 'start', skillName: 'reviewer', goal: 'Verify the isolated UI grant.',
          completionCriteria: ['Return the bounded fixture result'], contextRefs: [],
          authorizedCapabilities: [], readOnly: false,
        }) } }] }));
      response.write(chunk({}, 'tool_calls'));
    } else {
      if (tools.includes('read_task_source')) professionalCalls++;
      response.write(chunk({ role: 'assistant', content: 'Fixture task completed.' }));
      response.write(chunk({}, 'stop'));
    }
    response.end('data: [DONE]\n\n');
  });
  const providerPort = await listen(provider);
  t.after(() => new Promise((resolveClose) => { provider.closeAllConnections(); provider.close(resolveClose); }));
  await writeFile(join(home, 'app', 'config.json'), JSON.stringify({ schemaVersion: 1,
    provider: 'task-046-fixture', model: 'fixture-model', apiKeyEnv: 'TASK_046_PROVIDER_KEY',
    baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', workingDirectory: workspace }));
  const debugServer = createServer();
  const debugPort = await listen(debugServer);
  await new Promise((resolveClose) => debugServer.close(resolveClose));
  const child = spawn(electron, [`--remote-debugging-port=${debugPort}`, appRoot], {
    env: { ...process.env, YUANPU_HOME: home, YUANPU_RENDERER_URL: rendererUrl,
      YUANPU_NODE_BINARY: process.execPath, YUANPU_NOTIFICATIONS_ENABLED: '0',
      TASK_046_PROVIDER_KEY: 'fixture-only' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (data) => { diagnostics = (diagnostics + data.toString()).slice(-2_000); });
  }
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGUSR2');
      await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)),
        new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
  });
  const renderer = await connectRenderer(debugPort).catch((error) => {
    throw new Error(`${error.message}; ${diagnostics}`);
  });
  t.after(() => renderer.close());
  await eventually(() => renderer.evaluate('Boolean(document.querySelector(\'.nav-item[aria-label="助理"]\'))'), 'Assistant navigation');
  await renderer.evaluate('document.querySelector(\'.nav-item[aria-label="助理"]\').click()');
  await eventually(() => renderer.evaluate('Boolean(document.querySelector(\'.assistant-mode textarea[aria-label="消息"]\'))'), 'Assistant composer');
  await renderer.evaluate(`(() => { const field = document.querySelector('.assistant-mode textarea[aria-label="消息"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'Start the isolated professional task.');
    field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await renderer.evaluate('document.querySelector(\'.assistant-mode [aria-label="发送消息"]\').click()');
  await eventually(() => renderer.evaluate('document.querySelector(\'.assistant-mode .approval-card\')?.textContent.includes("专业任务授权")'), 'visible professional approval', 30_000);
  const card = await renderer.evaluate('document.querySelector(\'.assistant-mode .approval-card\').innerText');
  assert.match(card, /Verify the isolated UI grant/);
  assert.match(card, /reviewer/);
  assert.equal(professionalCalls, 0, 'professional model must wait for a user click');
  await eventually(() => renderer.evaluate('!document.querySelector(\'.assistant-mode .approval-card .primary\').disabled'), 'enabled signed approval');
  await renderer.evaluate('document.querySelector(\'.assistant-mode .approval-card .primary\').click()');
  await eventually(() => professionalCalls === 1, 'professional Pi request after UI click', 30_000);
  const ledgerRoot = join(home, 'workflows', 'delegation-ledger');
  await eventually(async () => {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(ledgerRoot);
    if (files.length !== 1) return false;
    const record = JSON.parse(await readFile(join(ledgerRoot, files[0]), 'utf8'));
    return record.status === 'completed';
  }, 'completed delegated task', 30_000);
});
