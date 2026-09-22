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

  async reply(route, outboundId, content) {
    this.replies.push({ route, outboundId, content });
    return this.results.shift() ?? { status: 'accepted' };
  }

  close() {
    this.closed = true;
  }
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
