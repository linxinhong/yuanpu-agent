import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { capabilityApprovalSigningPayload } from '@yuanpu-agent/protocol';
import { createCapabilityId } from '@yuanpu-agent/runtime-kit';

const entry = resolve(import.meta.dirname, '../dist/index.cjs');
const capability = createCapabilityId('builtin.demo', 'yuanpu.echo');

async function eventually(read, label) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    try { const value = await read(); if (value) return value; }
    catch { /* startup or transition still pending */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

test('real Runtime waits for a signed user grant before starting one professional task', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-delegation-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'app');
  const skills = join(root, 'agent', 'skills', 'reviewer');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(app, { recursive: true }), mkdir(skills, { recursive: true }), mkdir(workspace)]);
  await writeFile(join(skills, 'SKILL.md'), '---\nname: reviewer\ndescription: Fixture review.\n---\n\n# Review\nUse the authorized echo capability.\n');
  let professionalCalls = 0;
  let capabilityCalls = 0;
  const provider = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const tools = (input.tools ?? []).map((tool) => tool.function?.name);
    const returned = input.messages.some((message) => message.role === 'tool');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'fixture',
      object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
      choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (tools.includes('delegate_and_verify') && !returned) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'delegate-once', type: 'function',
        function: { name: 'delegate_and_verify', arguments: JSON.stringify({ action: 'start',
          skillName: 'reviewer', goal: 'Echo the fixture through the authorized capability.',
          completionCriteria: ['Return the fixture result'], contextRefs: [],
          authorizedCapabilities: [capability], readOnly: false }) } }] });
      send({}, 'tool_calls');
    } else if (tools.includes('execute_authorized_capability') && !returned) {
      professionalCalls++;
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'effect-once', type: 'function',
        function: { name: 'execute_authorized_capability', arguments: JSON.stringify({ name: capability,
          arguments: { text: 'bounded fixture' } }) } }] });
      send({}, 'tool_calls');
    } else {
      if (tools.includes('execute_authorized_capability')) capabilityCalls++;
      send({ role: 'assistant', content: 'Fixture task acknowledged.' }); send({}, 'stop');
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolveListen) => provider.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => { provider.closeAllConnections(); provider.close(resolveClose); }));
  await writeFile(join(app, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions',
    models: [{ id: 'fixture-model', name: 'Fixture', reasoning: false, input: ['text'],
      contextWindow: 128000, maxTokens: 1024 }],
  } } }));
  await writeFile(join(app, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'fixture-only' } }));
  await writeFile(join(app, 'config.json'), JSON.stringify({ schemaVersion: 1,
    provider: 'fixture', model: 'fixture-model', workingDirectory: workspace }));
  const token = randomBytes(32).toString('hex');
  const keys = generateKeyPairSync('ed25519');
  const approvalPublicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const runtime = spawn(process.execPath, [entry, '--serve', '--port', '0'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, YUANPU_HOME: root,
      YUANPU_PYTHON_MCP_EXECUTABLE: '', YUANPU_PYTHON_MCP_ROOT: '' },
  });
  let stderr = '';
  runtime.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (runtime.exitCode === null && runtime.signalCode === null) {
      runtime.kill('SIGTERM');
      await new Promise((resolveExit) => runtime.once('exit', resolveExit));
    }
  });
  runtime.stdin.end(`${JSON.stringify({ token, approvalPublicKey, parentPid: process.pid })}\n`);
  const ready = await new Promise((resolveReady, rejectReady) => {
    let output = '';
    const timeout = setTimeout(() => rejectReady(new Error(`Runtime ready timeout: ${stderr}`)), 15_000);
    runtime.once('exit', (code) => rejectReady(new Error(`Runtime exited ${code}: ${stderr}`)));
    runtime.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      resolveReady(JSON.parse(output.slice(0, newline)));
    });
  });
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`http://${ready.host}:${ready.port}${path}`, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const submitted = await api('/v1/chat/submit', 'POST', { surface: 'assistant',
    clientMessageId: 'delegation-fixture', message: 'Start the professional fixture.' });
  assert.equal(submitted.status, 202);
  const approval = await eventually(async () => {
    const listed = (await api('/v1/capabilities/approvals')).body;
    return listed.find((item) => item.assistantDelegation);
  }, 'visible professional approval');
  assert.equal(approval.assistantDelegation.skillName, 'reviewer');
  assert.deepEqual(approval.assistantDelegation.authorizedCapabilities, [capability]);
  assert.equal(professionalCalls, 0, 'Pi professional task must not start before signed approval');
  const unsigned = { requestId: approval.requestId, decision: 'approved', issuedAt: Date.now(),
    nonce: randomBytes(16).toString('base64url') };
  const signed = { ...unsigned, signature: sign(null,
    capabilityApprovalSigningPayload(unsigned), keys.privateKey).toString('base64url') };
  assert.equal((await api('/v1/capabilities/approvals/decision', 'POST', signed)).status, 200);
  const taskId = approval.assistantDelegation.taskId;
  const record = await eventually(async () => {
    const value = JSON.parse(await readFile(join(root, 'workflows', 'delegation-ledger', `${taskId}.json`), 'utf8'));
    return value.status === 'completed' ? value : undefined;
  }, `professional completion: ${stderr}`);
  assert.equal(record.taskId, taskId);
  assert.match(record.result.resultRef, /^delegation-result:/);
  assert.equal(professionalCalls, 1);
  assert.equal(capabilityCalls, 1);
  assert.equal((await api('/v1/capabilities/approvals')).body.some((item) => item.requestId === approval.requestId), false);
});
