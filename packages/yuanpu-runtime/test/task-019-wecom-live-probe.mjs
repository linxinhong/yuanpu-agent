import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  ChannelRouter,
  PersistentAgentService,
  WecomSdkTransport,
  digestChannelValue,
  openYuanpuMetadataDatabase,
} from '../dist/index.mjs';

const botId = process.env.WECOM_BOT_ID;
const secret = process.env.WECOM_BOT_SECRET;
const testUserId = process.env.WECOM_TEST_USER_ID;
if (!botId || !secret) {
  console.log(JSON.stringify({ status: 'missing_variables' }));
  process.exitCode = 1;
} else {
  const connectionId = 'imc_task019_probe';
  const challenge = `Yuanpu-019-${randomBytes(4).toString('hex')}`;
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-task019-live-'));
  const databasePath = join(root, 'metadata.sqlite');
  const database = openYuanpuMetadataDatabase(databasePath);
  let executions = 0;
  let matched = 0;
  let inboundSeen = 0;
  let privateTextSeen = 0;
  let pinnedSenderId = testUserId;
  let deliveryResult;
  let signalReply;
  const replyObserved = new Promise((resolve) => { signalReply = resolve; });
  const sdkEvents = {};
  let agent;
  let router;
  let authenticationTimer;
  let replyTimer;
  try {
    agent = await PersistentAgentService.open({
      store: database.agentRuns,
      executor: {
        async execute() {
          executions += 1;
          return {
            kind: 'completed',
            output: { message: 'TASK-019 授权私聊测试回复', tools: [] },
          };
        },
      },
    });
    const sdk = new WecomSdkTransport({
      connectionId,
      botId,
      secret,
      log: ({ event }) => { sdkEvents[event] = (sdkEvents[event] ?? 0) + 1; },
    });
    const transport = {
      connect(handler) {
        sdk.connect(async (message) => {
          inboundSeen += 1;
          if (message.conversationType === 'single' && message.messageType === 'text') {
            privateTextSeen += 1;
          }
          if (
            (pinnedSenderId && message.senderId !== pinnedSenderId)
            || matched !== 0
            || message.conversationType !== 'single'
            || message.messageType !== 'text'
            || message.text?.trim() !== challenge
          ) return;
          pinnedSenderId = message.senderId;
          database.channels.pair('wecom', connectionId,
            digestChannelValue(connectionId, 'sender', pinnedSenderId), new Date().toISOString());
          matched += 1;
          await handler(message);
        });
      },
      ready: () => sdk.ready(),
      async reply(route, outboundId, content) {
        deliveryResult = await sdk.reply(route, outboundId, content);
        signalReply();
        return deliveryResult;
      },
      close: () => sdk.close(),
    };
    router = new ChannelRouter({
      config: {
        provider: 'wecom',
        connectionId,
        providerAccountRef: botId,
        credentialBindingDigest: digestChannelValue(connectionId, 'credential-reference', 'temporary-env-probe'),
        workspaceId: '/task-019-live-probe',
        acceptedMessageTypes: ['text'],
        pairedSenderDigests: testUserId
          ? [digestChannelValue(connectionId, 'sender', testUserId)] : [],
        groupEnabled: false,
        groupAllowlistDigests: [],
      },
      store: database.channels,
      agent,
      transport,
    });
    router.start();
    const authenticated = await Promise.race([
      transport.ready().then(() => true),
      new Promise((resolve) => { authenticationTimer = setTimeout(() => resolve(false), 15_000); }),
    ]);
    clearTimeout(authenticationTimer);
    if (!authenticated) {
      console.log(JSON.stringify({ status: 'authentication_timeout', sdkEvents }));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ status: 'ready', challenge }));
      const replied = await Promise.race([
        replyObserved.then(() => true),
        new Promise((resolve) => { replyTimer = setTimeout(() => resolve(false), 240_000); }),
      ]);
      clearTimeout(replyTimer);
      await agent.waitForIdle();
      const inspection = new DatabaseSync(databasePath, { readOnly: true });
      const runCount = inspection.prepare('SELECT COUNT(*) AS count FROM yp_agent_runs').get().count;
      let outbound = inspection.prepare('SELECT status FROM yp_channel_outbound').all();
      for (let attempt = 0; replied && outbound[0]?.status === 'delivering' && attempt < 50; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        outbound = inspection.prepare('SELECT status FROM yp_channel_outbound').all();
      }
      inspection.close();
      console.log(JSON.stringify({
        status: replied ? 'reply_attempted' : 'message_timeout',
        inboundSeen,
        privateTextSeen,
        matched,
        executions,
        runCount,
        outboundStatuses: outbound.map((row) => row.status),
        providerReceipt: deliveryResult?.status ?? null,
        sdkEvents,
      }));
      if (!replied || matched !== 1 || executions !== 1 || runCount !== 1
        || outbound.length !== 1 || outbound[0].status !== 'accepted') process.exitCode = 1;
    }
  } catch {
    console.log(JSON.stringify({ status: 'probe_error' }));
    process.exitCode = 1;
  } finally {
    clearTimeout(authenticationTimer);
    clearTimeout(replyTimer);
    await router?.close();
    await agent?.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
}
