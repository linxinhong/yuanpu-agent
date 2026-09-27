import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(desktopRoot, '../..');
const electron = createRequire(import.meta.url)('electron');
const root = await mkdtemp(join(tmpdir(), 'yuanpu-browser-probe-'));
const appRoot = join(root, 'apps', 'desktop');
const home = join(root, 'home');
const workspace = join(home, 'workspace');
const userData = join(root, 'electron-user-data');
const browserPage = createServer((request, response) => {
  const second = request.url === '/second';
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<html><head><title>Browser fixture ${second ? 'second' : 'first'}</title></head><body><h1>${second ? 'Second' : 'First'} page</h1><a href="/second">Next page</a></body></html>`);
});
let browserPort = 0;
let providerRequests = 0;
const provider = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk.toString();
  const messages = JSON.parse(body).messages;
  providerRequests += 1;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finishReason = null) => `data: ${JSON.stringify({ id: `fixture-${providerRequests}`,
    object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  const latestTool = [...messages].reverse().find((message) => message.role === 'tool');
  const latestToolCall = [...messages].reverse().find((message) => message.role === 'assistant' && message.tool_calls?.length)?.tool_calls[0]?.function?.name;
  const toolText = latestTool ? JSON.stringify(latestTool.content) : '';
  const capabilityId = /ypcap:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+/.exec(toolText)?.[0];
  if (!latestTool) {
    response.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${providerRequests}`, type: 'function',
      function: { name: 'search_capabilities', arguments: JSON.stringify({ query: 'browser_navigate' }) } }] }));
    response.end(chunk({}, 'tool_calls') + 'data: [DONE]\n\n');
  } else if (latestToolCall === 'search_capabilities' && capabilityId) {
    response.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${providerRequests}`, type: 'function',
      function: { name: 'execute_capability', arguments: JSON.stringify({ name: capabilityId,
        arguments: { url: `http://127.0.0.1:${browserPort}/first` } }) } }] }));
    response.end(chunk({}, 'tool_calls') + 'data: [DONE]\n\n');
  } else {
    response.write(chunk({ role: 'assistant', content: `Browser capability finished: ${toolText.slice(0, 120)}` }));
    response.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
  }
});

async function freePort() {
  const server = createNetServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function listen(server) {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return server.address().port;
}

async function eventually(check, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; }
    catch { /* The app may still be starting. */ }
    await new Promise((done) => setTimeout(done, 80));
  }
  throw new Error(message);
}

async function connectRenderer(port) {
  const target = await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    return (await response.json()).find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  }, 'Electron renderer debugger did not start');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    socket.addEventListener('open', done, { once: true });
    socket.addEventListener('error', fail, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { done, fail } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) fail(new Error(message.error.message));
    else done(message.result);
  });
  const command = (method, params = {}) => new Promise((done, fail) => {
    const id = ++nextId;
    pending.set(id, { done, fail });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await command('Runtime.enable');
  return {
    async evaluate(expression) {
      const reply = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
      return reply.result.value;
    },
    command,
    close: () => socket.close(),
  };
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGUSR2');
  await Promise.race([
    new Promise((done) => child.once('exit', done)),
    new Promise((done) => setTimeout(done, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill();
}

let vite;
let app;
let renderer;
let diagnostics = '';
try {
  await mkdir(appRoot, { recursive: true });
  await mkdir(join(root, 'apps', 'runtime'), { recursive: true });
  await mkdir(join(home, 'app'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(userData, { recursive: true });
  await symlink(resolve(desktopRoot, '../runtime/dist'), join(root, 'apps', 'runtime', 'dist'), 'dir');
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ name: 'yuanpu-browser-probe', version: '1.0.0', main: 'entry.cjs' }));
  await writeFile(join(appRoot, 'entry.cjs'), `
    const { app } = require('electron');
    app.setPath('userData', ${JSON.stringify(userData)});
    process.on('SIGUSR2', () => app.quit());
    require(${JSON.stringify(join(desktopRoot, 'dist/main.cjs'))});
  `);
  browserPort = await listen(browserPage);
  const providerPort = await listen(provider);
  await writeFile(join(home, 'app', 'config.json'), JSON.stringify({
    schemaVersion: 1, provider: 'browser-fixture', model: 'fixture-model', apiKeyEnv: 'TASK_063_PROVIDER_KEY',
    workingDirectory: workspace, baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions',
  }));
  const vitePort = await freePort();
  vite = spawn('pnpm', ['--filter', '@yuanpu-agent/app', 'run', 'dev', '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await eventually(async () => (await fetch(`http://127.0.0.1:${vitePort}/`)).ok, 'Vite did not start');
  const debuggerPort = await freePort();
  app = spawn(electron, [`--remote-debugging-port=${debuggerPort}`, appRoot], {
    env: { ...process.env, YUANPU_HOME: home, YUANPU_RENDERER_URL: `http://127.0.0.1:${vitePort}/`,
      YUANPU_NODE_BINARY: process.execPath, YUANPU_NOTIFICATIONS_ENABLED: '0', TASK_063_PROVIDER_KEY: 'fixture-only' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [app.stdout, app.stderr]) stream.on('data', (chunk) => {
    if (diagnostics.length < 16_384) diagnostics += chunk.toString();
  });
  renderer = await connectRenderer(debuggerPort);
  await eventually(() => renderer.evaluate('window.yuanpu?.runtimeInfo?.()'), 'Electron preload or Runtime did not start');
  await renderer.evaluate(`window.location.hash = '#/work'`);
  await eventually(() => renderer.evaluate(`Boolean(document.querySelector('button[aria-label="打开右侧面板"]'))`), 'Work panel did not mount');
  await renderer.evaluate(`document.querySelector('button[aria-label="打开右侧面板"]').click()`);
  await eventually(() => renderer.evaluate(`Boolean(document.querySelector('button[aria-label="添加面板标签"]'))`), 'Workspace tabs did not mount');
  await renderer.evaluate(`document.querySelector('button[aria-label="添加面板标签"]').click()`);
  await renderer.evaluate(`Array.from(document.querySelectorAll('.workspace-tab-menu button')).find((button) => button.textContent.includes('浏览器')).click()`);
  await eventually(() => renderer.evaluate('document.querySelector("webview")?.getWebContentsId?.()'), 'Browser webview did not attach');
  const guestId = await renderer.evaluate('document.querySelector("webview").getWebContentsId()');
  const firstUrl = `http://127.0.0.1:${browserPort}/first`;
  await renderer.evaluate(`(() => {
    const input = document.querySelector('.browser-address');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(firstUrl)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await renderer.evaluate(`document.querySelector('.browser-address').closest('form').requestSubmit()`);
  await eventually(() => renderer.evaluate(`document.querySelector('webview')?.getURL() === ${JSON.stringify(firstUrl)}`), 'Browser did not navigate to the local page');
  await eventually(() => renderer.evaluate('document.querySelector("webview")?.getTitle() === "Browser fixture first"'), 'Browser title did not update');
  await eventually(() => renderer.evaluate('!document.querySelector("webview")?.isLoading()'), 'First page did not finish loading');
  await renderer.evaluate(`document.querySelector('button[aria-label="添加面板标签"]').click()`);
  await renderer.evaluate(`Array.from(document.querySelectorAll('.workspace-tab-menu button')).find((button) => button.textContent.includes('文件列表')).click()`);
  assert.equal(await renderer.evaluate('document.querySelector("webview")?.getWebContentsId()'), guestId, 'Switching tabs destroyed the shared browser guest');
  await renderer.evaluate(`Array.from(document.querySelectorAll('.file-tab-title')).find((button) => button.textContent.includes('Browser fixture first')).click()`);
  await new Promise((done) => setTimeout(done, 300));
  await renderer.evaluate(`document.querySelector('webview').executeJavaScript('document.querySelector("a").click()', true)`);
  await eventually(() => renderer.evaluate('document.querySelector("webview")?.getURL().endsWith("/second")'), 'Browser link did not navigate');
  await eventually(() => renderer.evaluate('!document.querySelector("webview")?.isLoading()'), 'Second page did not finish loading');
  await eventually(() => renderer.evaluate('!document.querySelector(\'button[aria-label="后退"]\')?.disabled'), 'Back button stayed disabled', 2_000);
  await renderer.evaluate(`document.querySelector('button[aria-label="后退"]').click()`);
  await eventually(() => renderer.evaluate('document.querySelector("webview")?.getURL().endsWith("/first")'), 'Browser back button failed');
  await eventually(() => renderer.evaluate('!document.querySelector("webview")?.isLoading() && document.querySelector("webview")?.canGoForward()'), 'Back navigation did not finish');
  await renderer.evaluate(`document.querySelector('button[aria-label="前进"]').click()`);
  await eventually(() => renderer.evaluate('document.querySelector("webview")?.getURL().endsWith("/second")'), 'Browser forward button failed');
  assert.equal(await renderer.evaluate('document.querySelector("webview")?.getWebContentsId()'), guestId);
  await renderer.evaluate(`document.querySelector('button[aria-label="添加面板标签"]').click()`);
  await renderer.evaluate(`Array.from(document.querySelectorAll('.workspace-tab-menu button')).find((button) => button.textContent.includes('文件列表')).click()`);
  await renderer.evaluate(`(() => {
    const input = document.querySelector('textarea[aria-label="消息"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '请使用 browser_navigate 回到第一页');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await renderer.evaluate(`document.querySelector('button[aria-label="发送消息"]').click()`);
  await eventually(() => providerRequests >= 2, 'Agent did not discover the browser capability', 30_000);
  await eventually(() => renderer.evaluate('document.querySelector("webview")?.getURL().endsWith("/first")'),
    'Agent browser_navigate did not control the shared guest', 30_000);
  assert.equal(await renderer.evaluate('document.querySelector("webview")?.getWebContentsId()'), guestId);
  console.log(JSON.stringify({ status: 'passed', guestId, providerRequests,
    firstUrl, secondUrl: `http://127.0.0.1:${browserPort}/second` }));
} catch (error) {
  throw new Error(`${error.message}; diagnostics=${diagnostics.slice(-1800)}`);
} finally {
  renderer?.close();
  await stop(app);
  if (vite && vite.exitCode === null) vite.kill();
  browserPage.closeAllConnections();
  provider.closeAllConnections();
  await Promise.all([new Promise((done) => browserPage.close(done)), new Promise((done) => provider.close(done))]);
  await rm(root, { recursive: true, force: true });
}
