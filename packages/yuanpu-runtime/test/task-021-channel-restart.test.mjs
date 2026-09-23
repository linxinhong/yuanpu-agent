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

async function eventually(check, message) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error(message);
}

const connectionId = 'imc_task021_fixture';
const senderId = 'synthetic-member';
const incoming = {
  provider: 'wecom', connectionId, providerBotId: 'synthetic-bot',
  providerRequestId: 'synthetic-request', providerMessageId: 'synthetic-message',
  senderId, conversationType: 'single', conversationId: senderId,
  messageType: 'text', text: 'synthetic input',
};
const config = {
  provider: 'wecom', connectionId, providerAccountRef: 'synthetic-bot',
  credentialBindingDigest: 'a'.repeat(64), workspaceId: '/synthetic-workspace',
  acceptedMessageTypes: ['text'], groupEnabled: false, groupAllowlistDigests: [],
  pairedSenderDigests: [digestChannelValue(connectionId, 'sender', senderId)],
};

test('in-flight IM reply becomes unknown across channel shutdown and SQLite reopen without replay', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-task-021-channel-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, 'automation.sqlite');
  let metadata = openYuanpuMetadataDatabase(databasePath);
  let executions = 0;
  let sends = 0;
  let unblockReply;
  const replyGate = new Promise((done) => { unblockReply = done; });
  const firstTransport = {
    connect() {}, async ready() {},
    async reply() {
      sends += 1;
      await replyGate;
      return { status: 'accepted' };
    },
    close() { unblockReply(); },
  };
  const firstAgent = await PersistentAgentService.open({
    store: metadata.agentRuns,
    executor: { async execute() {
      executions += 1;
      return { kind: 'completed', output: { message: 'synthetic reply', tools: [] } };
    } },
  });
  const firstRouter = new ChannelRouter({ config, store: metadata.channels, agent: firstAgent, transport: firstTransport });
  firstRouter.start();
  const receipt = await firstRouter.handleInbound(incoming);
  assert.equal(receipt.accepted, true);
  await eventually(() => sends === 1 && metadata.channels.getOutboundForRun(receipt.runId)?.status === 'delivering', 'Reply did not enter delivering.');
  assert.equal(executions, 1);
  await firstRouter.close();
  assert.equal(metadata.channels.getOutboundForRun(receipt.runId).status, 'unknown');
  await firstAgent.close();
  metadata.close();

  metadata = openYuanpuMetadataDatabase(databasePath);
  const secondTransport = {
    connect() {}, async ready() {},
    async reply() { sends += 1; return { status: 'accepted' }; },
    close() {},
  };
  const secondAgent = await PersistentAgentService.open({
    store: metadata.agentRuns,
    executor: { async execute() {
      executions += 1;
      return { kind: 'completed', output: { message: 'unexpected replay', tools: [] } };
    } },
  });
  const secondRouter = new ChannelRouter({ config, store: metadata.channels, agent: secondAgent, transport: secondTransport });
  secondRouter.start();
  await secondTransport.ready();
  const replay = await secondRouter.handleInbound(incoming);
  assert.equal(replay.accepted, true);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.runId, receipt.runId);
  assert.equal(metadata.channels.getOutboundForRun(receipt.runId).status, 'unknown');
  assert.equal(executions, 1);
  assert.equal(sends, 1);
  await secondRouter.close();
  await secondAgent.close();
  metadata.close();
});
