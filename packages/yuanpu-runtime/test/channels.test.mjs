import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ChannelRouter,
  PersistentAgentService,
  digestChannelValue,
  openYuanpuMetadataDatabase,
} from '../dist/index.mjs';

async function waitUntil(check, message = 'condition was not met') {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

class FixtureTransport {
  constructor(results = []) {
    this.results = [...results];
    this.replies = [];
    this.closed = false;
  }

  connect(handler) {
    this.handler = handler;
  }

  async ready() {}

  async reply(route, outboundId, content) {
    this.replies.push({ route, outboundId, content });
    return this.results.shift() ?? { status: 'accepted' };
  }

  close() {
    this.closed = true;
  }
}

class DeferredReadyTransport extends FixtureTransport {
  constructor() {
    super();
    this.readyGate = deferred();
  }

  ready() {
    return this.readyGate.promise;
  }

  becomeReady() {
    this.readyGate.resolve();
  }

  close() {
    this.becomeReady();
    super.close();
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function message(overrides = {}) {
  return {
    provider: 'wecom',
    connectionId: 'imc_fixture',
    providerBotId: 'bot-fixture',
    providerRequestId: overrides.providerRequestId ?? 'request-fixture-1',
    providerMessageId: overrides.providerMessageId ?? 'message-fixture-1',
    senderId: overrides.senderId ?? 'member-fixture-a',
    conversationType: overrides.conversationType ?? 'single',
    conversationId: overrides.conversationId ?? overrides.senderId ?? 'member-fixture-a',
    messageType: overrides.messageType ?? 'text',
    text: overrides.text ?? 'fixture hello',
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    provider: 'wecom',
    connectionId: 'imc_fixture',
    providerAccountRef: 'bot-fixture',
    credentialBindingDigest: digestChannelValue(
      'imc_fixture',
      'credential-reference',
      'keychain:yuanpu/im/imc_fixture/bot-secret',
    ),
    workspaceId: '/fixture-workspace',
    acceptedMessageTypes: ['text'],
    pairedSenderDigests: [
      digestChannelValue('imc_fixture', 'sender', 'member-fixture-a'),
      digestChannelValue('imc_fixture', 'sender', 'member-fixture-b'),
    ],
    groupEnabled: false,
    groupAllowlistDigests: [],
    ...overrides,
  };
}

async function fixture(options = {}) {
  const database = options.database ?? openYuanpuMetadataDatabase(':memory:');
  const executions = [];
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    maximumConcurrentRuns: 2,
    executor: {
      async execute(input) {
        executions.push({
          runId: input.run.runId,
          conversationId: input.run.context.conversation.conversationId,
          piSessionId: input.piSessionId,
          input: input.input,
        });
        return { kind: 'completed', output: { message: `reply:${input.input}`, tools: [] } };
      },
    },
  });
  const transport = options.transport ?? new FixtureTransport();
  const router = new ChannelRouter({
    config: options.config ?? config(),
    store: database.channels,
    agent: service,
    transport,
  });
  router.start();
  return { database, executions, router, service, transport };
}

test('rejects unauthenticated channel identities before Agent dispatch', async () => {
  const context = await fixture();
  assert.deepEqual(await context.router.handleInbound(message({ senderId: 'unpaired-member' })), {
    accepted: false,
    code: 'unpaired',
  });
  assert.deepEqual(await context.router.handleInbound(message({ providerBotId: 'other-bot' })), {
    accepted: false,
    code: 'wrong_bot',
  });
  assert.deepEqual(await context.router.handleInbound(message({
    conversationType: 'group',
    conversationId: 'fixture-group',
  })), { accepted: false, code: 'group_disabled' });
  assert.deepEqual(await context.router.handleInbound(message({ messageType: 'file', text: undefined })), {
    accepted: false,
    code: 'unsupported_message',
  });
  assert.equal(context.executions.length, 0);
  assert.equal(context.transport.replies.length, 0);
  await context.router.close();
  await context.service.close();
  context.database.close();
});

test('persists before dispatch, deduplicates replay, and replies with the original request route', async () => {
  const context = await fixture();
  const first = await context.router.handleInbound(message());
  const duplicate = await context.router.handleInbound(message());
  assert.equal(first.accepted, true);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.accepted, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.runId, first.runId);
  await waitUntil(() => context.transport.replies.length === 1);
  assert.equal(context.executions.length, 1);
  assert.deepEqual(context.transport.replies[0].route, {
    providerRequestId: 'request-fixture-1',
    providerMessageId: digestChannelValue('imc_fixture', 'message', 'message-fixture-1'),
  });
  assert.equal(context.database.channels.getOutboundForRun(first.runId).status, 'accepted');
  await context.router.close();
  await context.service.close();
  context.database.close();
});

test('rejects a replay whose immutable route or content differs from the persisted inbound', async () => {
  const context = await fixture();
  const first = await context.router.handleInbound(message());
  assert.equal(first.accepted, true);
  for (const replay of [
    message({ text: 'changed fixture body' }),
    message({ conversationId: 'changed-conversation' }),
    message({ providerRequestId: 'changed-request-route' }),
  ]) {
    assert.deepEqual(await context.router.handleInbound(replay), {
      accepted: false,
      code: 'invalid_message',
    });
  }
  await waitUntil(() => context.transport.replies.length === 1);
  assert.equal(context.executions.length, 1);
  assert.deepEqual(context.transport.replies[0].route, {
    providerRequestId: 'request-fixture-1',
    providerMessageId: digestChannelValue('imc_fixture', 'message', 'message-fixture-1'),
  });
  await context.router.close();
  await context.service.close();
  context.database.close();
});

test('returns an acceptance receipt without waiting for model completion', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  const gate = deferred();
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    executor: {
      async execute() {
        await gate.promise;
        return { kind: 'completed', output: { message: 'fixture delayed reply', tools: [] } };
      },
    },
  });
  const transport = new FixtureTransport();
  const router = new ChannelRouter({ config: config(), store: database.channels, agent: service, transport });
  router.start();
  const receipt = await Promise.race([
    router.handleInbound(message()),
    new Promise((_, reject) => setTimeout(() => reject(new Error('receipt waited for model')), 100)),
  ]);
  assert.equal(receipt.accepted, true);
  assert.equal(transport.replies.length, 0);
  gate.resolve();
  await waitUntil(() => transport.replies.length === 1);
  await router.close();
  await service.close();
  database.close();
});

test('closes promptly while an Agent run is still non-terminal', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  const gate = deferred();
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    executor: {
      async execute() {
        await gate.promise;
        return { kind: 'completed', output: { message: 'fixture delayed reply', tools: [] } };
      },
    },
  });
  const router = new ChannelRouter({
    config: config(),
    store: database.channels,
    agent: service,
    transport: new FixtureTransport(),
  });
  router.start();
  const receipt = await router.handleInbound(message());
  assert.equal(receipt.accepted, true);
  await Promise.race([
    router.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('channel close deadlocked')), 100)),
  ]);
  gate.resolve();
  await service.close();
  database.close();
});

test('requires an explicit cancellation target and restores cancellation as a control action', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  const cancelled = [];
  const fakeAgent = {
    async submit() { throw new Error('cancel recovery must not submit an Agent run'); },
    async get() { return undefined; },
    async cancel(_caller, runId) {
      cancelled.push(runId);
      return { runId, result: 'not_found' };
    },
    async *subscribe() {},
  };
  const initial = new ChannelRouter({
    config: config(),
    store: database.channels,
    agent: fakeAgent,
    transport: new FixtureTransport(),
  });
  initial.start();
  assert.deepEqual(await initial.handleInbound(message({ text: '/cancel' })), {
    accepted: false,
    code: 'invalid_message',
  });
  await initial.close();

  database.channels.acceptInbound({
    inboundId: 'cancel-inbound-fixture',
    provider: 'wecom',
    connectionId: 'imc_fixture',
    providerMessageId: 'cancel-message-digest',
    providerRequestId: 'cancel-request-fixture',
    senderDigest: digestChannelValue('imc_fixture', 'sender', 'member-fixture-a'),
    conversationType: 'single',
    conversationDigest: digestChannelValue(
      'imc_fixture',
      'conversation:single',
      'member-fixture-a',
    ),
    messageType: 'text',
    contentDigest: 'c'.repeat(64),
    pendingInput: '/cancel run-fixture-target',
    action: 'cancel',
    cancelTargetRunId: 'run-fixture-target',
    receivedAt: new Date().toISOString(),
  });
  const recovered = new ChannelRouter({
    config: config(),
    store: database.channels,
    agent: fakeAgent,
    transport: new FixtureTransport(),
  });
  recovered.start();
  await waitUntil(() => cancelled.length === 1);
  assert.deepEqual(cancelled, ['run-fixture-target']);
  assert.equal(database.channels.pendingInbound('wecom', 'imc_fixture').length, 0);
  await recovered.close();
  database.close();
});

test('isolates concurrent conversations while reusing one conversation binding', async () => {
  const context = await fixture();
  const first = await context.router.handleInbound(message());
  const samePeer = await context.router.handleInbound(message({
    providerMessageId: 'message-fixture-2',
    providerRequestId: 'request-fixture-2',
    text: 'fixture follow-up',
  }));
  const otherPeer = await context.router.handleInbound(message({
    providerMessageId: 'message-fixture-3',
    providerRequestId: 'request-fixture-3',
    senderId: 'member-fixture-b',
    conversationId: 'member-fixture-b',
    text: 'fixture other peer',
  }));
  assert.equal(first.accepted && samePeer.accepted && otherPeer.accepted, true);
  await waitUntil(() => context.executions.length === 3);
  const byRun = new Map(context.executions.map((entry) => [entry.runId, entry]));
  assert.equal(byRun.get(first.runId).piSessionId, byRun.get(samePeer.runId).piSessionId);
  assert.notEqual(byRun.get(first.runId).piSessionId, byRun.get(otherPeer.runId).piSessionId);
  await context.router.close();
  await context.service.close();
  context.database.close();
});

test('records explicit failure and unknown delivery without re-running Agent', async () => {
  const transport = new FixtureTransport([
    { status: 'failed', code: 'provider_rejected' },
    { status: 'unknown', code: 'ack_timeout' },
  ]);
  const context = await fixture({ transport });
  const failed = await context.router.handleInbound(message());
  const unknown = await context.router.handleInbound(message({
    providerMessageId: 'message-fixture-2',
    providerRequestId: 'request-fixture-2',
  }));
  await waitUntil(() => transport.replies.length === 2);
  assert.equal(context.database.channels.getOutboundForRun(failed.runId).status, 'failed');
  assert.equal(context.database.channels.getOutboundForRun(unknown.runId).status, 'unknown');
  assert.equal(context.executions.length, 2);
  assert.equal(await context.router.handleInbound(message()).then((result) => result.duplicate), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(context.executions.length, 2);
  assert.equal(transport.replies.length, 2);
  await context.router.close();
  await context.service.close();
  context.database.close();
});

test('marks an in-flight delivery unknown when the channel closes', async () => {
  const gate = deferred();
  const transport = new FixtureTransport();
  transport.reply = async function reply(route, outboundId, content) {
    this.replies.push({ route, outboundId, content });
    await gate.promise;
    return { status: 'accepted' };
  };
  transport.close = function close() {
    this.closed = true;
    gate.resolve();
  };
  const context = await fixture({ transport });
  const receipt = await context.router.handleInbound(message());
  await waitUntil(() => transport.replies.length === 1);
  assert.equal(context.database.channels.getOutboundForRun(receipt.runId).status, 'delivering');
  await context.router.close();
  assert.equal(context.database.channels.getOutboundForRun(receipt.runId).status, 'unknown');
  gate.resolve();
  await context.service.close();
  context.database.close();
});

test('restores pairings and deduplication after SQLite reopen and closes transport', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yuanpu-channel-fixture-'));
  const path = join(directory, 'metadata.sqlite');
  try {
    const first = await fixture({ database: openYuanpuMetadataDatabase(path) });
    const receipt = await first.router.handleInbound(message());
    await waitUntil(() => first.transport.replies.length === 1);
    await first.router.close();
    assert.equal(first.transport.closed, true);
    await first.service.close();
    first.database.close();

    const second = await fixture({
      database: openYuanpuMetadataDatabase(path),
      config: config({ pairedSenderDigests: [] }),
    });
    const replay = await second.router.handleInbound(message());
    assert.equal(replay.accepted, true);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.runId, receipt.runId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(second.executions.length, 0);
    assert.equal(second.transport.replies.length, 0);
    await second.router.close();
    await second.service.close();
    second.database.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('recovers a crash after Agent submission but before the inbound run link is attached', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  const executions = [];
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    executor: {
      async execute(input) {
        executions.push(input.run.runId);
        return { kind: 'completed', output: { message: 'fixture recovered reply', tools: [] } };
      },
    },
  });
  let simulateCrash = true;
  const crashStore = new Proxy(database.channels, {
    get(target, property) {
      if (property === 'attachRun') {
        return (...args) => {
          if (simulateCrash) {
            simulateCrash = false;
            throw new Error('fixture crash before inbound link');
          }
          return target.attachRun(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const first = new ChannelRouter({
    config: config(),
    store: crashStore,
    agent: service,
    transport: new FixtureTransport(),
  });
  first.start();
  await assert.rejects(first.handleInbound(message()), /fixture crash/);
  await first.close();

  const transport = new FixtureTransport();
  const recovered = new ChannelRouter({
    config: config(),
    store: database.channels,
    agent: service,
    transport,
  });
  recovered.start();
  await waitUntil(() => transport.replies.length === 1);
  assert.equal(executions.length, 1);
  const inbound = database.channels.pendingInbound('wecom', 'imc_fixture');
  assert.equal(inbound.length, 0);
  await recovered.close();
  await service.close();
  database.close();
});

test('waits for authenticated transport readiness before delivering a recovered terminal run', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    executor: {
      async execute() {
        return { kind: 'completed', output: { message: 'fixture terminal recovery', tools: [] } };
      },
    },
  });
  let simulateCrash = true;
  const crashAfterAttachStore = new Proxy(database.channels, {
    get(target, property) {
      if (property === 'attachRun') {
        return (...args) => {
          const attached = target.attachRun(...args);
          if (simulateCrash) {
            simulateCrash = false;
            throw new Error('fixture crash after inbound link');
          }
          return attached;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const first = new ChannelRouter({
    config: config(),
    store: crashAfterAttachStore,
    agent: service,
    transport: new FixtureTransport(),
  });
  first.start();
  await assert.rejects(first.handleInbound(message()), /fixture crash/);
  await first.close();

  const transport = new DeferredReadyTransport();
  const recovered = new ChannelRouter({
    config: config(),
    store: database.channels,
    agent: service,
    transport,
  });
  recovered.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(transport.replies.length, 0);
  transport.becomeReady();
  await waitUntil(() => transport.replies.length === 1);
  assert.equal(transport.replies[0].content, 'fixture terminal recovery');
  await recovered.close();
  await service.close();
  database.close();
});

test('refuses to reuse persisted pairings after changing provider account or credential binding', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    executor: {
      async execute(input) {
        return { kind: 'completed', output: { message: input.input, tools: [] } };
      },
    },
  });
  const first = new ChannelRouter({
    config: config(),
    store: database.channels,
    agent: service,
    transport: new FixtureTransport(),
  });
  first.start();
  await first.close();
  for (const changedConfig of [
    config({ providerAccountRef: 'other-bot-fixture' }),
    config({ credentialBindingDigest: 'b'.repeat(64) }),
  ]) {
    const changed = new ChannelRouter({
      config: changedConfig,
      store: database.channels,
      agent: service,
      transport: new FixtureTransport(),
    });
    assert.throws(() => changed.start(), /cannot be changed in place/);
    await changed.close();
  }
  await service.close();
  database.close();
});
