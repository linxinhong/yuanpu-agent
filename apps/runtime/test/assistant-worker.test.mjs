import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const entry = resolve(import.meta.dirname, '../dist/index.cjs');

async function home(t) {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-assistant-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'assistant');
}

function startWorker(homePath, parentPid = process.pid) {
  const child = spawn(process.execPath, [entry, '--assistant-worker'], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const errors = [];
  child.testErrors = errors;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => errors.push(chunk));
  child.send({ kind: 'bootstrap', home: homePath, parentPid });
  return { child, errors };
}

function nextMessage(child, predicate, timeoutMs = 8_000) {
  return new Promise((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => {
      child.off('message', onMessage);
      rejectMessage(new Error('Assistant Worker message timed out.'));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      clearTimeout(timeout);
      child.off('message', onMessage);
      resolveMessage(message);
    };
    child.on('message', onMessage);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      rejectMessage(new Error(`Assistant Worker exited early: ${code}: ${child.testErrors?.join('') ?? ''}`));
    });
  });
}

async function stopWorker(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.send({ kind: 'shutdown' });
  await new Promise((resolveExit) => child.once('exit', resolveExit));
}

test('one headless Worker owns Home and a second writer is rejected', async (t) => {
  const assistantHome = await home(t);
  const first = startWorker(assistantHome);
  t.after(() => stopWorker(first.child));
  const ready = await nextMessage(first.child, (message) => message.kind === 'ready');
  assert.equal(ready.pid, first.child.pid);
  const competing = startWorker(assistantHome);
  const exit = await new Promise((resolveExit) => competing.child.once('exit', resolveExit));
  assert.equal(exit, 1);
  assert.match(competing.errors.join(''), /already has a writer/);
  assert.equal(first.child.exitCode, null);
  const task = nextMessage(first.child, (message) => message.kind === 'task' && message.correlationId === 'missing-query');
  first.child.send({ kind: 'task', id: 'missing', correlationId: 'missing-query' });
  assert.equal((await task).record, undefined);
});

test('cancelling a queued turn does not abort the active turn in the same Session', async (t) => {
  const assistantHome = await home(t);
  let releaseFirst;
  const firstStarted = new Promise((resolveStart) => { releaseFirst = { resolveStart }; });
  let finishFirst;
  const holdFirst = new Promise((resolveFinish) => { finishFirst = resolveFinish; });
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    calls += 1;
    if (calls === 1) {
      releaseFirst.resolveStart();
      await holdFirst;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'loopback', object: 'chat.completion.chunk', created: 0,
      model: 'assistant-loopback', choices: [{ index: 0, delta: { role: 'assistant', content: 'First survived.' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'loopback', object: 'chat.completion.chunk', created: 0,
      model: 'assistant-loopback', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => { server.closeAllConnections(); server.close(resolveClose); }));
  const worker = startWorker(assistantHome);
  t.after(() => stopWorker(worker.child));
  worker.child.on('message', (message) => {
    if (message.kind !== 'model-request') return;
    worker.child.send({ kind: 'model', id: message.id, config: {
      model: { id: 'assistant-loopback', name: 'Assistant loopback', provider: 'assistant-loopback',
        api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000, maxTokens: 1024 },
      auth: { apiKey: 'loopback-test-key' },
    } });
  });
  await nextMessage(worker.child, (message) => message.kind === 'ready');
  const first = nextMessage(worker.child, (message) => message.kind === 'result' && message.correlationId === 'first');
  worker.child.send({ kind: 'prompt', id: 'active', correlationId: 'first', sessionId: 'shared',
    text: 'First', deadlineAt: Date.now() + 10_000 });
  await firstStarted;
  const second = nextMessage(worker.child, (message) => message.kind === 'result' && message.correlationId === 'second');
  worker.child.send({ kind: 'prompt', id: 'queued', correlationId: 'second', sessionId: 'shared',
    text: 'Second', deadlineAt: Date.now() + 10_000 });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  worker.child.send({ kind: 'cancel', id: 'queued' });
  finishFirst();
  assert.equal((await first).record.status, 'completed');
  assert.equal((await second).record.status, 'cancelled');
  assert.equal(calls, 1);
});

test('Worker runs a real assistant turn, persists result, and does not replay the same task ID', async (t) => {
  const assistantHome = await home(t);
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    calls += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'loopback', object: 'chat.completion.chunk', created: 0,
      model: 'assistant-loopback', choices: [{ index: 0, delta: { role: 'assistant', content: 'Worker reply.' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'loopback', object: 'chat.completion.chunk', created: 0,
      model: 'assistant-loopback', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => { server.closeAllConnections(); server.close(resolveClose); }));
  const worker = startWorker(assistantHome);
  t.after(() => stopWorker(worker.child));
  worker.child.on('message', (message) => {
    if (message.kind !== 'model-request') return;
    worker.child.send({ kind: 'model', id: message.id, config: {
      model: { id: 'assistant-loopback', name: 'Assistant loopback', provider: 'assistant-loopback',
        api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000, maxTokens: 1024 },
      auth: { apiKey: 'loopback-test-key' },
    } });
  });
  await nextMessage(worker.child, (message) => message.kind === 'ready');
  const request = { kind: 'prompt', id: 'test-task', text: 'Hello', deadlineAt: Date.now() + 8_000 };
  const result = nextMessage(worker.child, (message) => message.kind === 'result' && message.correlationId === 'first');
  const concurrent = nextMessage(worker.child, (message) => message.kind === 'result' && message.correlationId === 'second');
  worker.child.send({ ...request, correlationId: 'first' });
  worker.child.send({ ...request, correlationId: 'second' });
  assert.deepEqual((await result).record.status, 'completed');
  assert.equal((await concurrent).record.message, 'Worker reply.');
  assert.equal((await readFile(join(assistantHome, 'tasks', 'test-task.json'), 'utf8')).includes('Worker reply.'), true);
  const duplicate = nextMessage(worker.child, (message) => message.kind === 'result' && message.correlationId === 'third');
  worker.child.send({ ...request, correlationId: 'third' });
  assert.equal((await duplicate).record.message, 'Worker reply.');
  assert.equal(calls, 1);
});

test('a killed Worker leaves its accepted task identifiable as interrupted after restart', async (t) => {
  const assistantHome = await home(t);
  let began;
  const started = new Promise((resolveStart) => { began = resolveStart; });
  const server = createServer(async (request) => {
    for await (const _chunk of request) { /* consume request */ }
    began();
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => { server.closeAllConnections(); server.close(resolveClose); }));
  const first = startWorker(assistantHome);
  first.child.on('message', (message) => {
    if (message.kind !== 'model-request') return;
    first.child.send({ kind: 'model', id: message.id, config: {
      model: { id: 'assistant-loopback', name: 'Assistant loopback', provider: 'assistant-loopback',
        api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000, maxTokens: 1024 },
      auth: { apiKey: 'loopback-test-key' },
    } });
  });
  await nextMessage(first.child, (message) => message.kind === 'ready');
  first.child.send({ kind: 'prompt', id: 'unfinished', correlationId: 'unfinished',
    text: 'Wait', deadlineAt: Date.now() + 10_000 });
  await started;
  first.child.kill('SIGKILL');
  await new Promise((resolveExit) => first.child.once('exit', resolveExit));
  const second = startWorker(assistantHome);
  t.after(() => stopWorker(second.child));
  await nextMessage(second.child, (message) => message.kind === 'ready');
  const queried = nextMessage(second.child, (message) => message.kind === 'task' && message.correlationId === 'interrupted');
  second.child.send({ kind: 'task', id: 'unfinished', correlationId: 'interrupted' });
  assert.equal((await queried).record.status, 'interrupted');
});
