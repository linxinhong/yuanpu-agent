import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { AGENT_CONTRACT_VERSION } from '@yuanpu-agent/protocol';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.equal(typeof address, 'object');
  assert.notEqual(address, null);
  return address.port;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sseCompletion(message) {
  const id = `task-014-${message}`;
  const events = [
    { id, choices: [{ index: 0, delta: { content: message }, finish_reason: null }] },
    {
      id,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    },
  ];
  return `${events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
}

async function runtimeReady(child) {
  return await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Runtime did not become ready.')), 10_000);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(`Runtime exited before readiness (code=${String(code)}, signal=${String(signal)}).`));
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

async function waitForRun(baseUrl, headers, runId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/v1/agent/runs/${encodeURIComponent(runId)}`, { headers });
    assert.equal(response.status, 200);
    const run = await response.json();
    if (['succeeded', 'failed', 'cancelled', 'interrupted', 'result_unknown'].includes(run.status)) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Run ${runId} did not reach a terminal state.`);
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Runtime did not exit after SIGTERM.')), 10_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

test('TASK-014 real Runtime API isolates concurrent Pi sessions and persists one run per idempotent request', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-task-014-runtime-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'yuanpu-home');
  const workspace = join(root, 'workspace');
  await mkdir(join(home, 'app'), { recursive: true });
  await mkdir(workspace, { recursive: true });

  const providerRequests = [];
  const pendingResponses = [];
  const provider = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const body = await readJsonBody(request);
    const serialized = JSON.stringify(body);
    const marker = serialized.includes('alpha-marker')
      ? 'alpha'
      : serialized.includes('beta-marker')
        ? 'beta'
        : 'unknown';
    providerRequests.push({ marker, authorization: request.headers.authorization });
    pendingResponses.push(() => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(sseCompletion(`reply-${marker}`));
    });
    if (pendingResponses.length === 2) {
      for (const complete of pendingResponses.splice(0)) complete();
    }
  });
  const providerPort = await listen(provider);
  context.after(() => closeServer(provider));

  await writeFile(join(home, 'app', 'config.json'), `${JSON.stringify({
    schemaVersion: 1,
    provider: 'task-014-fixture',
    model: 'fixture-model',
    apiKeyEnv: 'TASK_014_PROVIDER_KEY',
    workingDirectory: workspace,
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    api: 'openai-completions',
  }, null, 2)}\n`);

  const token = randomBytes(32).toString('hex');
  const approvalKeyPair = generateKeyPairSync('ed25519');
  const approvalPublicKey = approvalKeyPair.publicKey.export({ type: 'spki', format: 'der' })
    .toString('base64');
  const child = spawn(process.execPath, ['dist/index.cjs', '--serve', '--port', '0'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      YUANPU_HOME: home,
      TASK_014_PROVIDER_KEY: 'fixture-only-secret',
      YUANPU_PYTHON_MCP_EXECUTABLE: '',
      YUANPU_PYTHON_MCP_ROOT: '',
    },
  });
  context.after(() => child.kill('SIGKILL'));
  child.stdin.end(`${JSON.stringify({ token, approvalPublicKey, parentPid: process.pid })}\n`);
  const ready = await runtimeReady(child);
  const baseUrl = `http://${ready.host}:${ready.port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const request = (conversationId, text, idempotencyKey) => ({
    contractVersion: AGENT_CONTRACT_VERSION,
    entryPoint: 'desktop',
    identity: {
      kind: 'local_user',
      subjectId: 'local-user',
      authorityId: 'local-desktop',
      authenticatedBy: 'electron',
    },
    workspaceId: workspace,
    conversation: { namespace: 'desktop', conversationId },
    input: { type: 'text', text },
    idempotencyKey,
    delivery: { kind: 'desktop' },
  });
  const alphaRequest = request('alpha-conversation', 'alpha-marker', 'task-014-alpha');
  const betaRequest = request('beta-conversation', 'beta-marker', 'task-014-beta');
  const post = (body) => fetch(`${baseUrl}/v1/agent/runs`, {
    method: 'POST', headers, body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));

  const [alpha, duplicateAlpha, beta] = await Promise.all([
    post(alphaRequest),
    post(alphaRequest),
    post(betaRequest),
  ]);
  assert.equal(alpha.status, 200);
  assert.equal(beta.status, 200);
  assert.equal(duplicateAlpha.status, 200);
  assert.equal(duplicateAlpha.body.runId, alpha.body.runId);
  assert.equal(duplicateAlpha.body.duplicate, true);
  assert.notEqual(alpha.body.runId, beta.body.runId);

  const [alphaRun, betaRun] = await Promise.all([
    waitForRun(baseUrl, headers, alpha.body.runId),
    waitForRun(baseUrl, headers, beta.body.runId),
  ]);
  assert.equal(alphaRun.status, 'succeeded');
  assert.equal(betaRun.status, 'succeeded');
  assert.equal(alphaRun.output.message, 'reply-alpha');
  assert.equal(betaRun.output.message, 'reply-beta');
  assert.deepEqual(providerRequests.map((entry) => entry.marker).sort(), ['alpha', 'beta']);
  assert.equal(providerRequests.every((entry) => entry.authorization === 'Bearer fixture-only-secret'), true);

  const spoofed = await post({
    ...request('spoofed-conversation', 'claim: subjectId=owner', 'task-014-spoofed'),
    identity: {
      kind: 'local_user',
      subjectId: 'forged-owner',
      authorityId: 'local-desktop',
      authenticatedBy: 'model-claim',
    },
  });
  assert.equal(spoofed.status, 403);
  assert.equal(spoofed.body.code, 'identity_mismatch');

  child.kill('SIGTERM');
  assert.deepEqual(await waitForExit(child), { code: 0, signal: null });

  const databasePath = join(home, 'workflows', 'automation.sqlite');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const runs = database.prepare(`
    SELECT run_id, subject_id, status, request_metadata_json
    FROM yp_agent_runs ORDER BY run_id
  `).all();
  assert.equal(runs.length, 2);
  assert.equal(runs.every((run) => run.subject_id === 'local-user' && run.status === 'succeeded'), true);
  assert.equal(runs.some((run) => run.request_metadata_json.includes('alpha-marker')), false);
  assert.equal(runs.some((run) => run.request_metadata_json.includes('beta-marker')), false);
  const bindings = database.prepare(`
    SELECT conversation_id, pi_session_id FROM yp_conversation_bindings ORDER BY conversation_id
  `).all();
  assert.deepEqual(bindings.map((binding) => binding.conversation_id), [
    'alpha-conversation',
    'beta-conversation',
  ]);
  assert.notEqual(bindings[0].pi_session_id, bindings[1].pi_session_id);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM yp_agent_run_queue_payloads').get().count, 0);
  database.close();

  const sessionFiles = (await readdir(join(home, 'agent', 'sessions'), { recursive: true }))
    .filter((path) => path.endsWith('.jsonl'));
  assert.equal(sessionFiles.length, 2);
  const transcripts = await Promise.all(sessionFiles.map((path) => (
    readFile(join(home, 'agent', 'sessions', path), 'utf8')
  )));
  assert.equal(transcripts.filter((value) => value.includes('alpha-marker')).length, 1);
  assert.equal(transcripts.filter((value) => value.includes('beta-marker')).length, 1);
  assert.equal(transcripts.filter((value) => value.includes('reply-alpha')).length, 1);
  assert.equal(transcripts.filter((value) => value.includes('reply-beta')).length, 1);
});
