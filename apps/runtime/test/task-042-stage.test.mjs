import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { ChannelRouter, digestChannelValue, openYuanpuMetadataDatabase,
  readYuanpuChatTranscript } from '@yuanpu-agent/runtime-kit';
import { AssistantHostService } from '../src/assistant-host.ts';

const require = createRequire(import.meta.url);
const { AssistantWorkerManager } = require('../dist/index.cjs');
const entry = resolve(import.meta.dirname, '../dist/index.cjs');

async function loopbackFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-task-042-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appPath = join(root, 'app');
  const agentPath = join(root, 'agent');
  await Promise.all([mkdir(appPath), mkdir(agentPath)]);
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* local fixture input */ }
    calls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 0,
      model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Relocated reply.' },
        finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 0,
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
  const options = (home) => ({ home, model: { appPath, agentPath,
    provider: 'fixture', model: 'fixture-model' },
  command: { executable: process.execPath, args: [entry, '--assistant-worker'] } });
  return { root, options, get calls() { return calls; } };
}

test('headless host relocates stopped Assistant Home, preserves accepted task, and fences a second writer',
  async (t) => {
    const fixture = await loopbackFixture(t);
    const firstHome = join(fixture.root, 'first-home');
    const secondHome = join(fixture.root, 'relocated-home');
    const first = new AssistantWorkerManager(fixture.options(firstHome));
    t.after(() => first.stop());
    await first.start();
    const completed = await first.prompt('business-accepted-1', 'answer once', Date.now() + 15_000,
      'business-session-1');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.message, 'Relocated reply.');
    assert.equal(fixture.calls, 1);
    await first.stop();
    await cp(firstHome, secondHome, { recursive: true });

    const relocated = new AssistantWorkerManager(fixture.options(secondHome));
    t.after(() => relocated.stop());
    await relocated.start();
    assert.equal((await relocated.task('business-accepted-1')).message, 'Relocated reply.');
    const replay = await relocated.prompt('business-accepted-1', 'answer once', Date.now() + 15_000,
      'business-session-1');
    assert.equal(replay.status, 'completed');
    assert.equal(fixture.calls, 1, 'moving Home and repeating accepted task must not call the model twice');

    const competing = new AssistantWorkerManager({ ...fixture.options(secondHome), startupTimeoutMs: 3_000 });
    t.after(() => competing.stop());
    await assert.rejects(competing.start(), /already has a writer/);
    assert.equal((await relocated.task('business-accepted-1')).status, 'completed');
    await relocated.stop();
    assert.equal(relocated.workerPid, undefined);
  });

test('legacy paired WeCom history stays readable while new ingress deduplicates and uncertain reply stays unsent',
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'yuanpu-task-042-migration-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, 'workspace');
    const sessionsPath = join(root, 'sessions');
    await mkdir(workspace);
    const old = SessionManager.create(workspace, sessionsPath, { id: 'old-desktop-session' });
    old.appendMessage({ role: 'user', content: 'legacy private question', timestamp: Date.now() });
    old.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'legacy private answer' }],
      api: 'anthropic-messages', provider: 'anthropic', model: 'fixture', stopReason: 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() });
    const oldTranscript = readYuanpuChatTranscript(workspace, 'old-desktop-session', sessionsPath, 1000);
    assert.equal(oldTranscript[0].text, 'legacy private question');

    const path = join(root, 'automation.sqlite');
    const metadata = openYuanpuMetadataDatabase(path);
    t.after(() => metadata.close());
    const now = new Date().toISOString();
    const senderDigest = digestChannelValue('bot-fixture', 'sender', 'member-fixture');
    const config = { provider: 'wecom', connectionId: 'bot-fixture', providerAccountRef: 'bot-id-fixture',
      credentialBindingDigest: 'b'.repeat(64), workspaceId: workspace,
      acceptedMessageTypes: ['text'], pairedSenderDigests: [senderDigest],
      groupEnabled: false, groupAllowlistDigests: [] };
    metadata.channels.bindConnection({ provider: 'wecom', connectionId: 'bot-fixture',
      providerAccountDigest: digestChannelValue('bot-fixture', 'account', 'bot-id-fixture'),
      credentialBindingDigest: config.credentialBindingDigest, now });
    metadata.channels.pair('wecom', 'bot-fixture', senderDigest, now);
    metadata.channels.observePrivateSender({ provider: 'wecom', connectionId: 'bot-fixture',
      senderDigest, recipientId: 'member-fixture', now });
    const contactId = metadata.channels.listPrivateContacts('wecom')[0].contactId;
    metadata.database.prepare(`INSERT INTO yp_desktop_assistant_link(id, contact_id, connection_id, target_id,
      previous_pi_session_id, linked_pi_session_id, updated_at)
      VALUES (1, ?, 'bot-fixture', 'legacy-target', 'old-desktop-session', 'old-wecom-session', ?)`)
      .run(contactId, now);

    let prompts = 0;
    const tasks = new Map();
    const worker = { task: async (id) => tasks.get(id),
      prompt: async (id, text, _deadline, sessionId) => {
        prompts++;
        const record = { id, sessionId, status: 'completed', message: `fixture:${text}`, updatedAt: now };
        tasks.set(id, record);
        return record;
      }, cancel() {} };
    const service = new AssistantHostService(metadata.assistantHost, worker, workspace);
    t.after(() => service.close());
    const migrated = service.link;
    assert.equal(migrated.contactId, contactId);
    assert.notEqual(migrated.sessionId, 'old-wecom-session');
    assert.deepEqual(metadata.assistantLink.legacySessionIds(), ['old-desktop-session', 'old-wecom-session']);
    metadata.assistantHost.recordLegacyArchive('old-desktop-session', oldTranscript);
    const source = metadata.assistantHost.sourceChanges()[0].change;
    assert.deepEqual(metadata.assistantHost.resolveContentRef(source.contentRef, 'local-user'),
      { transcript: oldTranscript });
    assert.equal(metadata.assistantHost.resolveContentRef(source.contentRef, 'stranger'), undefined);

    let sends = 0;
    const transport = { connect() {}, ready: async () => undefined, isReady: () => true,
      reply: async () => { sends++; throw new Error('fixture uncertain ack'); },
      close: async () => undefined };
    const oldAgent = { submit: async () => { throw new Error('new assistant message entered Work'); },
      get: async () => undefined, cancel: async () => undefined, async *subscribe() {} };
    const router = new ChannelRouter({ config, store: metadata.channels, agent: oldAgent,
      assistant: service, transport });
    router.start();
    t.after(() => router.close().catch(() => undefined));
    const message = { provider: 'wecom', connectionId: 'bot-fixture', providerBotId: 'bot-id-fixture',
      providerRequestId: 'request-1', providerMessageId: 'message-1', senderId: 'member-fixture',
      conversationType: 'single', conversationId: 'member-fixture', messageType: 'text', text: 'new private question' };
    assert.equal((await router.handleInbound({ ...message, senderId: 'stranger' })).accepted, false);
    assert.equal((await router.handleInbound({ ...message, conversationType: 'group',
      conversationId: 'room' })).accepted, false);
    const receipt = await router.handleInbound(message);
    assert.equal(receipt.accepted, true);
    await service.drain();
    assert.equal(prompts, 1);
    assert.equal(sends, 1);
    assert.equal(metadata.assistantHost.delivery(receipt.runId).status, 'unknown');
    const repeated = await router.handleInbound({ ...message, providerRequestId: 'request-redelivery' });
    assert.equal(repeated.duplicate, true);
    service.recoverWecom('bot-fixture', transport);
    await service.drain();
    assert.equal(prompts, 1);
    assert.equal(sends, 1, 'unknown delivery must not be blindly resent');
    assert.equal(readYuanpuChatTranscript(workspace, 'old-desktop-session', sessionsPath, 1000)[0].text,
      'legacy private question');

    metadata.channels.unpair('wecom', 'bot-fixture', senderDigest);
    assert.equal(metadata.assistantHost.canDeliver(metadata.assistantHost.get(receipt.runId)), false);
    await router.close();
  });
