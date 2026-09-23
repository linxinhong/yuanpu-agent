import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { AGENT_CONTRACT_VERSION } from '@yuanpu-agent/protocol';

async function eventually(check) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The expected Runtime state did not appear.');
}

async function startRuntime(home) {
  const token = randomBytes(32).toString('hex');
  const approvalPublicKey = generateKeyPairSync('ed25519').publicKey
    .export({ type: 'spki', format: 'der' }).toString('base64');
  const child = spawn(process.execPath, ['dist/index.cjs', '--serve', '--port', '0'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      YUANPU_HOME: home,
      TASK_019_PROVIDER_KEY: 'fixture-only',
      YUANPU_PYTHON_MCP_EXECUTABLE: '',
      YUANPU_PYTHON_MCP_ROOT: '',
    },
  });
  child.stderr.resume();
  child.stdin.end(`${JSON.stringify({ token, approvalPublicKey, parentPid: process.pid })}\n`);
  const ready = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Runtime readiness timed out.')), 10_000);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Runtime exited before readiness: ${code}`)));
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      resolve(JSON.parse(output.slice(0, newline)));
    });
  });
  return {
    child,
    baseUrl: `http://${ready.host}:${ready.port}`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  };
}

async function stopRuntime(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Runtime shutdown timed out.')), 10_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 || signal === 'SIGTERM') resolve();
      else reject(new Error(`Runtime shutdown failed: ${code}/${signal}`));
    });
  });
}

test('TASK-019 in-flight Runtime shutdown leaves an uncertain run queryable without replay', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-task-019-recovery-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(join(home, 'app'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  let providerRequests = 0;
  const provider = createServer(async (request) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return;
    for await (const _chunk of request) { /* consume the bounded fixture request */ }
    providerRequests += 1;
    // Hold the model response until Runtime shutdown closes the request.
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerPort = provider.address().port;
  const children = [];
  context.after(async () => {
    for (const child of children) child.kill('SIGKILL');
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(home, 'app', 'config.json'), JSON.stringify({
    schemaVersion: 1,
    provider: 'task-019-fixture',
    model: 'fixture-model',
    apiKeyEnv: 'TASK_019_PROVIDER_KEY',
    workingDirectory: workspace,
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    api: 'openai-completions',
  }));

  const first = await startRuntime(home);
  children.push(first.child);
  const submission = await fetch(`${first.baseUrl}/v1/agent/runs`, {
    method: 'POST',
    headers: first.headers,
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
      conversation: { namespace: 'desktop', conversationId: 'recovery-fixture' },
      input: { type: 'text', text: 'hold fixture model response' },
      idempotencyKey: 'task-019-in-flight',
      delivery: { kind: 'desktop' },
    }),
  });
  assert.equal(submission.status, 200);
  const { runId } = await submission.json();
  await eventually(async () => {
    const response = await fetch(`${first.baseUrl}/v1/agent/runs/${encodeURIComponent(runId)}`, {
      headers: first.headers,
    });
    const run = await response.json();
    return run.status === 'running' && providerRequests === 1;
  });

  await stopRuntime(first.child);
  const database = new DatabaseSync(join(home, 'workflows', 'automation.sqlite'), { readOnly: true });
  const stoppedRun = database.prepare('SELECT status, external_effect_state FROM yp_agent_runs WHERE run_id = ?')
    .get(runId);
  database.close();
  assert.equal(stoppedRun.status, 'result_unknown');
  assert.equal(stoppedRun.external_effect_state, 'possible');

  const second = await startRuntime(home);
  children.push(second.child);
  const afterRestart = await fetch(`${second.baseUrl}/v1/agent/runs/${encodeURIComponent(runId)}`, {
    headers: second.headers,
  });
  assert.equal(afterRestart.status, 200);
  assert.equal((await afterRestart.json()).status, 'result_unknown');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(providerRequests, 1);
  await stopRuntime(second.child);
});
