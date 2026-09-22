import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AGENT_CONTRACT_VERSION } from '@yuanpu-agent/protocol';

async function ready(child) {
  return await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Runtime did not become ready.')), 10_000);
    child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error(
      `Runtime exited before readiness (code=${String(code)}, signal=${String(signal)}).`,
    )));
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

test('Runtime authenticates host events and canonicalizes notification navigation targets', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-notification-routing-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(join(home, 'app'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(home, 'app', 'config.json'), `${JSON.stringify({
    schemaVersion: 1,
    provider: 'notification-fixture',
    model: 'fixture-model',
    apiKeyEnv: 'NOTIFICATION_FIXTURE_KEY',
    workingDirectory: workspace,
    baseUrl: 'http://127.0.0.1:1/v1',
    api: 'openai-completions',
  }, null, 2)}\n`);

  const token = randomBytes(32).toString('hex');
  const keyPair = generateKeyPairSync('ed25519');
  const approvalPublicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const child = spawn(process.execPath, ['dist/index.cjs', '--serve', '--port', '0'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      YUANPU_HOME: home,
      NOTIFICATION_FIXTURE_KEY: 'fixture-only',
      YUANPU_PYTHON_MCP_EXECUTABLE: '',
      YUANPU_PYTHON_MCP_ROOT: '',
    },
  });
  context.after(() => child.kill('SIGKILL'));
  child.stdin.end(`${JSON.stringify({ token, approvalPublicKey, parentPid: process.pid })}\n`);
  const runtime = await ready(child);
  const origin = `http://${runtime.host}:${runtime.port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  assert.equal((await fetch(`${origin}/v1/host/events`)).status, 401);
  const eventAbort = new AbortController();
  const eventResponse = await fetch(`${origin}/v1/host/events`, {
    headers,
    signal: eventAbort.signal,
  });
  assert.equal(eventResponse.status, 200);
  assert.match(eventResponse.headers.get('content-type'), /text\/event-stream/);
  eventAbort.abort();

  const malformedReceipt = await fetch(`${origin}/v1/host/events/receipts`, {
    method: 'POST', headers, body: '{}',
  });
  assert.equal(malformedReceipt.status, 400);

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

  child.kill('SIGTERM');
  await waitForExit(child);
});
