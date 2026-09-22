import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AGENT_CONTRACT_VERSION, SCHEDULE_CONTRACT_VERSION } from '@yuanpu-agent/protocol';

async function ready(child) {
  return await new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    const timeout = setTimeout(() => reject(new Error('Runtime did not become ready.')), 10_000);
    child.once('error', reject);
    child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(
        `Runtime exited before readiness (code=${String(code)}, signal=${String(signal)}): ${errors.trim()}`,
      ));
    });
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      resolve(JSON.parse(output.slice(0, newline)));
    });
  });
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Runtime did not exit.')), 10_000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
}

async function readSseEvent(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let timer;
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out waiting for a host event.')),
          remaining,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (result.done) throw new Error('Host event stream closed before delivering an event.');
    buffer += decoder.decode(result.value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary).replace(/\r/gu, '');
      buffer = buffer.slice(boundary + 2);
      const data = block.split('\n').filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());
      if (data.length > 0) return JSON.parse(data.join('\n'));
      boundary = buffer.indexOf('\n\n');
    }
  }
  throw new Error('Timed out waiting for a host event.');
}

test('Runtime authenticates host events and canonicalizes notification navigation targets', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-notification-routing-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(join(home, 'app'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  const provider = createServer((request, response) => {
    request.resume();
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify({
      id: 'chatcmpl-notification',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'fixture-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: 'chatcmpl-notification',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'fixture-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => provider.close(resolve)));
  const providerAddress = provider.address();
  await writeFile(join(home, 'app', 'config.json'), `${JSON.stringify({
    schemaVersion: 1,
    provider: 'notification-fixture',
    model: 'fixture-model',
    apiKeyEnv: 'NOTIFICATION_FIXTURE_KEY',
    workingDirectory: workspace,
    baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
    api: 'openai-completions',
  }, null, 2)}\n`);

  const token = randomBytes(32).toString('hex');
  const keyPair = generateKeyPairSync('ed25519');
  const approvalPublicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const startRuntime = async () => {
    const childProcess = spawn(process.execPath, ['dist/index.cjs', '--serve', '--port', '0'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        YUANPU_HOME: home,
        NOTIFICATION_FIXTURE_KEY: 'fixture-only',
        YUANPU_PYTHON_MCP_EXECUTABLE: '',
        YUANPU_PYTHON_MCP_ROOT: '',
      },
    });
    childProcess.stdin.end(`${JSON.stringify({
      token,
      approvalPublicKey,
      parentPid: process.pid,
    })}\n`);
    return { process: childProcess, runtime: await ready(childProcess) };
  };
  let started = await startRuntime();
  let child = started.process;
  context.after(() => child.kill('SIGKILL'));
  let origin = `http://${started.runtime.host}:${started.runtime.port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  assert.equal((await fetch(`${origin}/v1/host/events`)).status, 401);
  const eventAbort = new AbortController();
  const eventResponse = await fetch(`${origin}/v1/host/events`, {
    headers,
    signal: eventAbort.signal,
  });
  assert.equal(eventResponse.status, 200);
  assert.match(eventResponse.headers.get('content-type'), /text\/event-stream/);

  const malformedReceipt = await fetch(`${origin}/v1/host/events/receipts`, {
    method: 'POST', headers, body: '{}',
  });
  assert.equal(malformedReceipt.status, 400);
  assert.equal((await fetch(`${origin}/v1/host/events/receipts`, {
    method: 'POST', headers, body: 'null',
  })).status, 400);
  assert.equal((await fetch(`${origin}/v1/notifications/targets/validate`, {
    method: 'POST', headers, body: 'null',
  })).status, 400);

  const submission = await fetch(`${origin}/v1/agent/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      contractVersion: AGENT_CONTRACT_VERSION,
      entryPoint: 'desktop',
      identity: {
        kind: 'local_user',
        subjectId: 'local-user',
        authorityId: 'local-desktop',
        authenticatedBy: 'electron',
      },
      workspaceId: workspace,
      conversation: { namespace: 'desktop', conversationId: 'default' },
      input: { type: 'text', text: 'fixture' },
      idempotencyKey: 'notification-target-fixture',
      delivery: { kind: 'desktop' },
    }),
  }).then((response) => response.json());
  assert.equal(submission.accepted, true);

  const systemEvent = await readSseEvent(eventResponse);
  assert.equal(systemEvent.type, 'notification_requested');
  assert.equal(systemEvent.payload.kind, 'run_succeeded');
  assert.equal(systemEvent.payload.runId, submission.runId);
  assert.equal(systemEvent.payload.conversationId, 'default');
  assert.equal(systemEvent.payload.body.includes('fixture'), false);
  const receiptResponse = await fetch(`${origin}/v1/host/events/receipts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      eventId: systemEvent.eventId,
      status: 'accepted',
      notification: {
        requestId: systemEvent.payload.requestId,
        status: 'submitted',
        userVisibility: 'unknown',
      },
    }),
  });
  assert.equal(receiptResponse.status, 200);
  eventAbort.abort();

  const validate = (target) => fetch(`${origin}/v1/notifications/targets/validate`, {
    method: 'POST', headers, body: JSON.stringify(target),
  }).then((response) => response.json());
  assert.deepEqual(await validate({ runId: submission.runId, conversationId: 'default' }), {
    valid: true,
    target: { conversationId: 'default', runId: submission.runId },
  });
  assert.equal((await validate({ runId: submission.runId, conversationId: 'forged' })).valid, false);
  assert.equal((await validate({ runId: 'forged-run' })).valid, false);
  assert.deepEqual(await validate({ conversationId: 'default' }), {
    valid: true,
    target: { conversationId: 'default' },
  });
  assert.equal((await validate({ conversationId: 'arbitrary-command' })).valid, false);

  const scheduledConversationId = 'scheduled-notification-target';
  const createScheduleResponse = await fetch(`${origin}/v1/schedules`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      contractVersion: SCHEDULE_CONTRACT_VERSION,
      name: 'Notification target fixture',
      prompt: 'scheduled fixture',
      workspaceId: workspace,
      timing: { kind: 'once', at: new Date(Date.now() - 1_000).toISOString() },
      timeZone: 'UTC',
      conversationId: scheduledConversationId,
      delivery: { kind: 'desktop' },
    }),
  });
  assert.equal(createScheduleResponse.status, 201);

  child.kill('SIGTERM');
  await waitForExit(child);

  started = await startRuntime();
  child = started.process;
  origin = `http://${started.runtime.host}:${started.runtime.port}`;
  const scheduledEventAbort = new AbortController();
  const scheduledEventResponse = await fetch(`${origin}/v1/host/events`, {
    headers,
    signal: scheduledEventAbort.signal,
  });
  assert.equal(scheduledEventResponse.status, 200);
  const scheduledEvent = await readSseEvent(scheduledEventResponse);
  assert.equal(scheduledEvent.type, 'notification_requested');
  assert.equal(scheduledEvent.payload.kind, 'run_succeeded');
  assert.equal(scheduledEvent.payload.conversationId, scheduledConversationId);

  assert.deepEqual(await validate({
    runId: scheduledEvent.payload.runId,
    conversationId: scheduledConversationId,
  }), {
    valid: true,
    target: {
      conversationId: scheduledConversationId,
      runId: scheduledEvent.payload.runId,
    },
  });
  const scheduledRunResponse = await fetch(
    `${origin}/v1/agent/runs/${scheduledEvent.payload.runId}`,
    { headers },
  );
  assert.equal(scheduledRunResponse.status, 200);
  const scheduledRun = await scheduledRunResponse.json();
  assert.equal(scheduledRun.owner.entryPoint, 'scheduler');
  assert.equal(scheduledRun.context.conversation.conversationId, scheduledConversationId);
  scheduledEventAbort.abort();

  child.kill('SIGTERM');
  await waitForExit(child);
});
