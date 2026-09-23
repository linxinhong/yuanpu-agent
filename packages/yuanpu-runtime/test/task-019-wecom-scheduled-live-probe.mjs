import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SCHEDULE_CONTRACT_VERSION } from '@yuanpu-agent/protocol';
import {
  ChannelRouter,
  HostNotificationRouter,
  PersistentAgentService,
  PersistentScheduler,
  WecomSdkTransport,
  digestChannelValue,
  openYuanpuMetadataDatabase,
  requestRecordedTerminalRunNotification,
} from '../dist/index.mjs';

const botId = process.env.WECOM_BOT_ID;
const secret = process.env.WECOM_BOT_SECRET;
if (!botId || !secret) {
  console.log(JSON.stringify({ status: 'missing_variables' }));
  process.exitCode = 1;
} else {
  const connectionId = 'imc_task019_scheduled_probe';
  const challenge = `Yuanpu-019-plan-${randomBytes(4).toString('hex')}`;
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-task019-scheduled-live-'));
  const path = join(root, 'metadata.sqlite');
  const database = openYuanpuMetadataDatabase(path);
  const notifications = new HostNotificationRouter();
  let now = new Date();
  let matched = 0;
  let inboundSeen = 0;
  let executions = 0;
  let replyStatus;
  let proactiveStatus;
  let resolveInbound;
  const inbound = new Promise((resolve) => { resolveInbound = resolve; });
  const sdkEvents = {};
  let inboundTimer;
  let authTimer;
  let agent;
  let router;
  let scheduler;
  try {
    notifications.subscribe(undefined, (event) => {
      notifications.acknowledge({
        eventId: event.eventId,
        status: 'accepted',
        notification: {
          requestId: event.payload.requestId,
          status: 'submitted',
          userVisibility: 'unknown',
        },
      });
    });
    agent = await PersistentAgentService.open({
      store: database.agentRuns,
      now: () => now,
      executor: {
        async execute() {
          executions += 1;
          return {
            kind: 'completed',
            output: {
              message: executions === 1
                ? 'TASK-019 私聊回复验收'
                : 'TASK-019 定时投递验收',
              tools: [],
            },
          };
        },
      },
      onRunStateChanged: (run) => requestRecordedTerminalRunNotification(
        notifications, database.schedules, run, () => now,
      ),
    });
    const sdk = new WecomSdkTransport({
      connectionId, botId, secret,
      log: ({ event }) => { sdkEvents[event] = (sdkEvents[event] ?? 0) + 1; },
    });
    const transport = {
      connect(handler) {
        sdk.connect(async (message) => {
          inboundSeen += 1;
          if (
            matched !== 0
            || message.conversationType !== 'single'
            || message.messageType !== 'text'
            || message.text?.trim() !== challenge
          ) return;
          database.channels.pair(
            'wecom', connectionId,
            digestChannelValue(connectionId, 'sender', message.senderId),
            now.toISOString(),
          );
          matched = 1;
          await handler(message);
          resolveInbound();
        });
      },
      ready: () => sdk.ready(),
      isReady: () => sdk.isReady(),
      async reply(route, outboundId, content) {
        const result = await sdk.reply(route, outboundId, content);
        replyStatus = result.status;
        return result;
      },
      async sendProactive(recipientId, content) {
        const result = await sdk.sendProactive(recipientId, content);
        proactiveStatus = result.status;
        return result;
      },
      close: () => sdk.close(),
    };
    router = new ChannelRouter({
      config: {
        provider: 'wecom', connectionId, providerAccountRef: botId,
        credentialBindingDigest: digestChannelValue(connectionId, 'credential-reference', 'temporary-env-probe'),
        workspaceId: '/task-019-scheduled-live-probe',
        acceptedMessageTypes: ['text'], pairedSenderDigests: [],
        groupEnabled: false, groupAllowlistDigests: [],
      },
      store: database.channels,
      agent,
      transport,
      now: () => now,
    });
    router.start();
    const authenticated = await Promise.race([
      transport.ready().then(() => true),
      new Promise((resolve) => { authTimer = setTimeout(() => resolve(false), 15_000); }),
    ]);
    clearTimeout(authTimer);
    if (!authenticated) throw new Error('authentication_timeout');
    console.log(JSON.stringify({ status: 'ready', challenge }));
    const received = await Promise.race([
      inbound.then(() => true),
      new Promise((resolve) => { inboundTimer = setTimeout(() => resolve(false), 180_000); }),
    ]);
    clearTimeout(inboundTimer);
    if (!received) throw new Error('message_timeout');
    await agent.waitForIdle();
    const contacts = database.channels.listPrivateContacts('wecom');
    if (contacts.length !== 1) throw new Error('contact_count_invalid');
    const routeId = router.bindScheduledContact(contacts[0].contactId);
    if (!routeId) throw new Error('binding_failed');
    const delivery = {
      supports: (target) => target.kind === 'channel' && target.routeId === routeId
        && router.canDeliverScheduled(routeId),
      supportsIdempotency: () => false,
      deliver: ({ output, signal }) => router.sendScheduled(routeId, output.message, signal),
    };
    const caller = {
      entryPoint: 'scheduler',
      identity: {
        kind: 'scheduler', subjectId: 'local-scheduler',
        authorityId: 'task-019-fixture', authenticatedBy: 'scheduler',
      },
      authorizeWorkspace: (workspaceId) => workspaceId === '/task-019-scheduled-live-probe',
      authorizeConversation: (conversation) => conversation.namespace === 'scheduler',
      authorizeDelivery: (target) => target.kind === 'none' || delivery.supports(target),
    };
    scheduler = await PersistentScheduler.open({
      store: database.schedules, agent, caller,
      authorizeWorkspace: caller.authorizeWorkspace,
      authorizeDelivery: caller.authorizeDelivery,
      delivery, now: () => now, scanIntervalMs: 60_000,
    });
    const due = new Date(now.getTime() + 60_000);
    const schedule = scheduler.create({
      contractVersion: SCHEDULE_CONTRACT_VERSION,
      name: 'Authorized private schedule probe',
      prompt: 'fixture scheduled result',
      workspaceId: '/task-019-scheduled-live-probe',
      timing: { kind: 'once', at: due.toISOString() },
      timeZone: 'UTC',
      delivery: { kind: 'channel', routeId },
    });
    now = due;
    await scheduler.tick();
    let history;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      history = scheduler.history(schedule.scheduleId)[0];
      if (['delivered', 'failed', 'result_unknown'].includes(history?.deliveryStatus)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
      await scheduler.tick();
    }
    const inspection = new DatabaseSync(path, { readOnly: true });
    const runCount = inspection.prepare('SELECT COUNT(*) AS count FROM yp_agent_runs').get().count;
    const outboundStatuses = inspection.prepare('SELECT status FROM yp_channel_outbound').all()
      .map((row) => row.status);
    inspection.close();
    console.log(JSON.stringify({
      status: 'completed', inboundSeen, matched, executions, runCount,
      outboundStatuses, replyStatus: replyStatus ?? null,
      proactiveStatus: proactiveStatus ?? null,
      scheduledDeliveryStatus: history?.deliveryStatus ?? null,
      notificationStatus: history?.notificationStatus ?? null,
      sdkEvents,
    }));
    if (matched !== 1 || executions !== 2 || runCount !== 2
      || outboundStatuses.length !== 1 || outboundStatuses[0] !== 'accepted'
      || replyStatus !== 'accepted' || proactiveStatus !== 'accepted'
      || history?.deliveryStatus !== 'delivered' || history?.notificationStatus !== 'submitted') {
      process.exitCode = 1;
    }
  } catch (error) {
    const knownFailure = error instanceof Error && [
      'authentication_timeout',
      'message_timeout',
      'contact_count_invalid',
      'binding_failed',
    ].includes(error.message) ? error.message : 'probe_error';
    console.log(JSON.stringify({
      status: knownFailure,
      inboundSeen, matched, executions, sdkEvents,
    }));
    process.exitCode = 1;
  } finally {
    clearTimeout(authTimer);
    clearTimeout(inboundTimer);
    await scheduler?.close();
    await router?.close();
    await agent?.close();
    notifications.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
}
