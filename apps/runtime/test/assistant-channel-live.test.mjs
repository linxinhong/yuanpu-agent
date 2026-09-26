import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { ChannelRouter, digestChannelValue, openYuanpuMetadataDatabase } from '@yuanpu-agent/runtime-kit';
import { AssistantHostService } from '../src/assistant-host.ts';

const require = createRequire(import.meta.url);
const { AssistantWorkerManager } = require('../dist/index.cjs');
const entry = resolve(import.meta.dirname, '../dist/index.cjs');
const execFileAsync = promisify(execFile);

async function isolatedClient(base, token, path, method = 'GET', body, discardBody = false) {
  const script = `const [base, token, path, method, body, discard] = process.argv.slice(1);
    const response = await fetch(base + path, { method,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      ...(body === 'undefined' ? {} : { body }) });
    if (discard === 'true') {
      await response.body?.cancel();
      process.stdout.write(JSON.stringify({ status: response.status }));
    } else process.stdout.write(JSON.stringify({ status: response.status, body: await response.json() }));`;
  const { stdout } = await execFileAsync(process.execPath,
    ['-e', script, base, token, path, method, body === undefined ? 'undefined' : JSON.stringify(body), String(discardBody)],
    { timeout: 15_000 });
  return JSON.parse(stdout);
}

async function eventually(check, message) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(message);
}

async function modelFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-assistant-channel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appPath = join(root, 'app');
  const agentPath = join(root, 'agent');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(appPath), mkdir(agentPath), mkdir(workspace)]);
  let calls = 0;
  const provider = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    for await (const _chunk of request) { /* consume bounded loopback prompt */ }
    calls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'loopback', object: 'chat.completion.chunk', created: 0,
      model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Assistant live reply.' },
        finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'loopback', object: 'chat.completion.chunk', created: 0,
      model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolveListen) => provider.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => { provider.closeAllConnections(); provider.close(resolveClose); }));
  await writeFile(join(appPath, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions',
    models: [{ id: 'fixture-model', name: 'Fixture model', reasoning: false, input: ['text'],
      contextWindow: 128000, maxTokens: 1024 }],
  } } }));
  await writeFile(join(appPath, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'fixture-only' } }));
  return { root, appPath, agentPath, workspace, get calls() { return calls; } };
}

test('real Runtime HTTP accepts desktop assistant once and two independent clients recover the same Worker result', async (t) => {
  const fixture = await modelFixture(t);
  await writeFile(join(fixture.appPath, 'config.json'), JSON.stringify({ schemaVersion: 1,
    provider: 'fixture', model: 'fixture-model', workingDirectory: fixture.workspace }));
  const token = randomBytes(32).toString('hex');
  const approvalPublicKey = generateKeyPairSync('ed25519').publicKey
    .export({ type: 'spki', format: 'der' }).toString('base64');
  const runtime = spawn(process.execPath, [entry, '--serve', '--port', '0'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, YUANPU_HOME: fixture.root, YUANPU_PYTHON_MCP_EXECUTABLE: '',
      YUANPU_PYTHON_MCP_ROOT: '' },
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
    const timeout = setTimeout(() => rejectReady(new Error(`Runtime ready timeout: ${stderr}`)), 10_000);
    runtime.once('exit', (code) => rejectReady(new Error(`Runtime exited ${code}: ${stderr}`)));
    runtime.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      resolveReady(JSON.parse(output.slice(0, newline)));
    });
  });
  const base = `http://${ready.host}:${ready.port}`;
  const input = { message: 'live desktop prompt', surface: 'assistant', clientMessageId: 'desktop-live-1' };
  // This client terminates after 202 headers without reading the accepted request ID.
  const submitted = await isolatedClient(base, token, '/v1/chat/submit', 'POST', input, true);
  assert.equal(submitted.status, 202);
  // A separate process reconnects and repeats the same business ID, then queries its result.
  const repeat = await isolatedClient(base, token, '/v1/chat/submit', 'POST', input);
  const receipt = repeat.body;
  assert.match(receipt.runId, /^asst_/);
  assert.equal(receipt.duplicate, true);
  const done = await eventually(async () => {
    const response = await isolatedClient(base, token, `/v1/agent/runs/${receipt.runId}`);
    const record = response.body;
    return record.status === 'succeeded' ? record : undefined;
  }, `Assistant Worker did not finish: ${stderr}`);
  assert.equal(done.output.message, 'Assistant live reply.');
  const transcript = (await isolatedClient(base, token, '/v1/desktop/transcript?surface=assistant')).body;
  assert.deepEqual(transcript.map((item) => item.role), ['user', 'assistant']);
  assert.equal(fixture.calls, 1);
});

test('WeCom ChannelRouter and desktop use one real Assistant Worker with separate sessions', async (t) => {
  const fixture = await modelFixture(t);
  const metadata = openYuanpuMetadataDatabase(':memory:');
  t.after(() => metadata.close());
  const manager = new AssistantWorkerManager({ home: join(fixture.root, 'assistant'),
    model: { appPath: fixture.appPath, agentPath: fixture.agentPath,
      provider: 'fixture', model: 'fixture-model' },
    command: { executable: process.execPath, args: [entry, '--assistant-worker'] },
  });
  t.after(() => manager.stop());
  await manager.start();
  const service = new AssistantHostService(metadata.assistantHost, manager, fixture.workspace);
  t.after(() => service.close());
  const senderDigest = digestChannelValue('bot-1', 'sender', 'member-1');
  const config = { provider: 'wecom', connectionId: 'bot-1', providerAccountRef: 'fixture-bot',
    credentialBindingDigest: 'b'.repeat(64), workspaceId: fixture.workspace,
    acceptedMessageTypes: ['text'], pairedSenderDigests: [senderDigest], groupEnabled: false,
    groupAllowlistDigests: [] };
  metadata.channels.bindConnection({ provider: 'wecom', connectionId: 'bot-1',
    providerAccountDigest: digestChannelValue('bot-1', 'account', 'fixture-bot'),
    credentialBindingDigest: config.credentialBindingDigest, now: new Date().toISOString() });
  metadata.channels.pair('wecom', 'bot-1', senderDigest, new Date().toISOString());
  metadata.channels.observePrivateSender({ provider: 'wecom', connectionId: 'bot-1',
    senderDigest, recipientId: 'member-1', now: new Date().toISOString() });
  await service.linkContact(metadata.channels.listPrivateContacts('wecom')[0].contactId);
  const replies = [];
  const transport = { connect() {}, ready: async () => undefined, isReady: () => true,
    reply: async (route, id, content) => { replies.push({ route, id, content }); return { status: 'accepted' }; },
    close: async () => undefined };
  const oldAgent = { submit: async () => { throw new Error('WeCom assistant reached Work executor'); },
    get: async () => undefined, cancel: async () => undefined, async *subscribe() {} };
  const router = new ChannelRouter({ config, store: metadata.channels, agent: oldAgent,
    assistant: service, transport });
  router.start();
  t.after(() => router.close().catch(() => undefined));
  const desktop = service.submitDesktop('desktop live', 'desktop-route-1');
  const incoming = { provider: 'wecom', connectionId: 'bot-1', providerBotId: 'fixture-bot',
    providerRequestId: 'req-1', providerMessageId: 'msg-1', senderId: 'member-1',
    conversationType: 'single', conversationId: 'member-1', messageType: 'text', text: 'wecom live' };
  const wecom = await router.handleInbound(incoming);
  assert.equal(wecom.accepted, true);
  await eventually(() => replies.length === 1, 'WeCom reply not delivered');
  await eventually(async () => (await service.getDesktopRun(desktop.runId))?.status === 'succeeded',
    'Desktop reply not completed');
  assert.equal(replies[0].route.providerRequestId, 'req-1');
  assert.equal(replies[0].content, 'Assistant live reply.');
  assert.equal(fixture.calls, 2);
  assert.notEqual(metadata.assistantHost.desktop().sessionId, metadata.assistantHost.wecomLink().sessionId);
  assert.equal(manager.workerPid > 0, true);
  await router.close();
});
