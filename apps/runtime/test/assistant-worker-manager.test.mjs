import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AssistantWorkerManager } = require('../dist/index.cjs');
const entry = resolve(import.meta.dirname, '../dist/index.cjs');

test('Worker host routes a four-field stable delegation follow-up request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-delegation-ipc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = join(root, 'request-worker.cjs');
  await writeFile(worker, `process.on('message', (message) => {
    if (message.kind === 'bootstrap') {
      process.send({ kind: 'ready' });
      process.send({ kind: 'delegation-request', id: 'follow-one', method: 'followUp',
        args: ['task-one', 'session-one', 'check again', 'stable-request'] });
    }
    if (message.kind === 'shutdown') process.exit(0);
  });`);
  let resolveCall;
  const called = new Promise((resolveCallPromise) => { resolveCall = resolveCallPromise; });
  const manager = new AssistantWorkerManager({ home: join(root, 'assistant'),
    model: { appPath: root, agentPath: root, provider: 'fixture', model: 'fixture' },
    delegations: { followUp(...args) { resolveCall(args); return Promise.resolve({ taskId: 'task-one' }); } },
    command: { executable: process.execPath, args: [worker] } });
  t.after(() => manager.stop());
  await manager.start();
  assert.deepEqual(await Promise.race([called, new Promise((_, reject) => setTimeout(() =>
    reject(new Error('Follow-up IPC was not routed.')), 2_000))]),
  ['task-one', 'session-one', 'check again', 'stable-request']);
});

test('headless Runtime host resolves a model and runs, queries, and stops its Worker', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-assistant-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appPath = join(root, 'app');
  const agentPath = join(root, 'agent');
  await mkdir(appPath);
  await mkdir(agentPath);
  let calls = 0;
  let beganCancel;
  const cancelStarted = new Promise((resolveStart) => { beganCancel = resolveStart; });
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    calls += 1;
    if (calls === 2) { beganCancel(); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'loopback', object: 'chat.completion.chunk', created: 0,
      model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Host reply.' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'loopback', object: 'chat.completion.chunk', created: 0,
      model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => { server.closeAllConnections(); server.close(resolveClose); }));
  await writeFile(join(appPath, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions',
    models: [{ id: 'fixture-model', name: 'Fixture model', reasoning: false, input: ['text'],
      contextWindow: 128000, maxTokens: 1024 }],
  } } }));
  await writeFile(join(appPath, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'fixture-only' } }));
  const manager = new AssistantWorkerManager({
    home: join(root, 'assistant'), model: { appPath, agentPath, provider: 'fixture', model: 'fixture-model' },
    command: { executable: process.execPath, args: [entry, '--assistant-worker'] },
  });
  t.after(() => manager.stop());
  await manager.start();
  assert.ok(manager.workerPid);
  const task = await manager.prompt('host-task', 'Hello from host', Date.now() + 8_000);
  assert.equal(task.status, 'completed');
  assert.equal(task.message, 'Host reply.');
  assert.equal((await manager.task('host-task')).message, 'Host reply.');
  assert.equal(calls, 1);
  const cancelling = manager.prompt('cancelled-task', 'Please wait', Date.now() + 8_000);
  await cancelStarted;
  manager.cancel('cancelled-task');
  assert.equal((await cancelling).status, 'cancelled');
  assert.equal((await manager.task('cancelled-task')).status, 'cancelled');
  const previousPid = manager.workerPid;
  process.kill(previousPid, 'SIGKILL');
  const deadline = Date.now() + 5_000;
  while ((!manager.workerPid || manager.workerPid === previousPid) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  assert.ok(manager.workerPid && manager.workerPid !== previousPid, 'Worker should restart after a crash');
  assert.equal((await manager.task('host-task')).status, 'completed');
  await manager.stop();
  assert.equal(manager.workerPid, undefined);
});

test('Runtime does not announce ready when another writer holds Assistant Home', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-assistant-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const writer = spawn(process.execPath, [entry, '--assistant-worker'], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => { if (writer.exitCode === null && writer.signalCode === null) writer.kill('SIGKILL'); });
  const ready = new Promise((resolveReady, rejectReady) => {
    writer.on('message', (message) => { if (message.kind === 'ready') resolveReady(); });
    writer.once('exit', (code) => rejectReady(new Error(`writer exited: ${code}`)));
  });
  writer.send({ kind: 'bootstrap', home: join(root, 'assistant'), parentPid: process.pid });
  await ready;
  const keyPair = generateKeyPairSync('ed25519');
  const runtime = spawn(process.execPath, [entry, '--serve', '--port', '0'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, YUANPU_HOME: root,
      YUANPU_PYTHON_MCP_EXECUTABLE: '', YUANPU_PYTHON_MCP_ROOT: '' },
  });
  t.after(() => { if (runtime.exitCode === null && runtime.signalCode === null) runtime.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  runtime.stdout.on('data', (chunk) => { stdout += chunk; });
  runtime.stderr.on('data', (chunk) => { stderr += chunk; });
  runtime.stdin.end(`${JSON.stringify({ token: randomBytes(32).toString('hex'),
    approvalPublicKey: keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    parentPid: process.pid })}\n`);
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => rejectExit(new Error('Runtime startup did not fail within 10 seconds')), 10_000);
    runtime.once('exit', (code) => { clearTimeout(timeout); resolveExit(code); });
  });
  assert.equal(exitCode, 1);
  assert.doesNotMatch(stdout, /"event":"ready"/);
  assert.match(stderr, /already has a writer/);
  writer.send({ kind: 'shutdown' });
  await new Promise((resolveExit) => writer.once('exit', resolveExit));
});
