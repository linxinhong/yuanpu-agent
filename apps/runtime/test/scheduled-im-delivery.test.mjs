import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  ChannelRouter,
  HostNotificationRouter,
  PersistentAgentService,
  PersistentScheduler,
  digestChannelValue,
  openYuanpuMetadataDatabase,
  requestTerminalRunNotification,
} from '@yuanpu-agent/runtime-kit';
import { RUNTIME_ROUTES, SCHEDULE_CONTRACT_VERSION } from '@yuanpu-agent/protocol';

import { createScheduledImDelivery, handleScheduledImHttp } from '../src/scheduled-im-delivery.ts';

async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Scheduled result was not observed.');
}

test('authenticated HTTP binds an observed private sender, accepts the schedule, then revokes the route', async (context) => {
  const metadata = openYuanpuMetadataDatabase(':memory:');
  let now = new Date('2026-09-23T00:00:00.000Z');
  let executions = 0;
  const notifications = [];
  const notificationRouter = new HostNotificationRouter();
  notificationRouter.subscribe(undefined, (event) => notifications.push(event));
  const sends = [];
  let proactiveResult = { status: 'accepted' };
  let transportReady = true;
  const agent = await PersistentAgentService.open({
    store: metadata.agentRuns,
    executor: { async execute() {
      executions += 1;
      return { kind: 'completed', output: { message: 'scheduled result', tools: [] } };
    } },
    onRunStateChanged: (run) => { void requestTerminalRunNotification(notificationRouter, run); },
    now: () => now,
  });
  const transport = {
    connect(handler) { this.handler = handler; },
    async ready() {},
    isReady() { return transportReady; },
    async reply() { return { status: 'accepted' }; },
    async sendProactive(recipientId, content) {
      sends.push({ recipientId, content });
      return proactiveResult;
    },
    async close() {},
  };
  const router = new ChannelRouter({
    config: {
      provider: 'wecom', connectionId: 'imc_fixture', providerAccountRef: 'bot-fixture',
      credentialBindingDigest: 'a'.repeat(64), workspaceId: '/workspace',
      acceptedMessageTypes: ['text'], groupEnabled: false, groupAllowlistDigests: [],
      pairedSenderDigests: [digestChannelValue('imc_fixture', 'sender', 'member-fixture')],
    },
    store: metadata.channels, agent, transport, now: () => now,
  });
  router.start();
  await router.handleInbound({
    provider: 'wecom', connectionId: 'imc_fixture', providerBotId: 'bot-fixture',
    providerRequestId: 'req-fixture', providerMessageId: 'msg-fixture',
    senderId: 'member-fixture', conversationType: 'single', conversationId: 'member-fixture',
    messageType: 'text', text: 'hello',
  });
  await agent.waitForIdle();
  const delivery = createScheduledImDelivery([router]);
  const caller = {
    entryPoint: 'scheduler',
    identity: { kind: 'scheduler', subjectId: 'local-scheduler', authorityId: 'local-runtime', authenticatedBy: 'scheduler' },
    authorizeWorkspace: (workspaceId) => workspaceId === '/workspace',
    authorizeConversation: (conversation) => conversation.namespace === 'scheduler',
    authorizeDelivery: (target) => target.kind === 'none' || delivery.supports(target),
  };
  const scheduler = await PersistentScheduler.open({
    store: metadata.schedules, agent, caller,
    authorizeWorkspace: caller.authorizeWorkspace,
    authorizeDelivery: caller.authorizeDelivery,
    delivery, now: () => now, scanIntervalMs: 60_000,
  });
  const token = 'fixture-token';
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const url = new URL(request.url, 'http://127.0.0.1');
    const handled = await handleScheduledImHttp({
      request, response, url, channelStore: metadata.channels, channels: [router], scheduler,
      async readJsonBody(source) {
        let raw = '';
        for await (const chunk of source) raw += chunk.toString();
        return JSON.parse(raw);
      },
    });
    if (!handled) { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await scheduler.close();
    await router.close();
    await agent.close();
    notificationRouter.close();
    metadata.close();
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  async function api(path, method = 'GET', body, authorization = token) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${authorization}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
  }
  const contactsPath = RUNTIME_ROUTES.channelScheduleTargets;
  assert.equal((await api(contactsPath, 'GET', undefined, 'wrong-token')).status, 401);
  const contacts = (await api(contactsPath)).body;
  assert.equal(contacts.length, 1);
  assert.equal(JSON.stringify(contacts).includes('member-fixture'), false);
  const scheduleInput = (routeId, at) => ({
    contractVersion: SCHEDULE_CONTRACT_VERSION, name: 'Private reminder', prompt: 'fixture',
    workspaceId: '/workspace', timing: { kind: 'once', at }, timeZone: 'UTC',
    delivery: { kind: 'channel', routeId },
  });
  assert.equal((await api(RUNTIME_ROUTES.schedules, 'POST', scheduleInput('arbitrary-userid', '2026-09-23T00:01:00.000Z'))).status, 400);
  assert.equal((await api(contactsPath, 'POST', { contactId: contacts[0].contactId, userid: 'forbidden' })).status, 400);
  const binding = await api(contactsPath, 'POST', { contactId: contacts[0].contactId });
  assert.equal(binding.status, 201);
  assert.match(binding.body.routeId, /^imtarget:/);
  const created = await api(RUNTIME_ROUTES.schedules, 'POST', scheduleInput(binding.body.routeId, '2026-09-23T00:01:00.000Z'));
  assert.equal(created.status, 201);
  assert.equal(JSON.stringify(created.body).includes('member-fixture'), false);
  const initialExecutions = executions;
  const initialNotifications = notifications.length;
  transportReady = false;
  now = new Date('2026-09-23T00:01:00.000Z');
  await scheduler.tick();
  await eventually(() => scheduler.history(created.body.scheduleId)[0]?.deliveryStatus === 'pending');
  assert.equal(scheduler.history(created.body.scheduleId)[0].deliveryAttempts, 0);
  assert.equal(sends.length, 0);
  transportReady = true;
  await scheduler.tick();
  await eventually(() => scheduler.history(created.body.scheduleId)[0]?.deliveryStatus === 'delivered');
  assert.equal(executions, initialExecutions + 1);
  assert.equal(notifications.length, initialNotifications + 1);
  assert.equal(notifications.at(-1).payload.kind, 'run_succeeded');
  assert.deepEqual(sends, [{ recipientId: 'member-fixture', content: 'scheduled result' }]);

  proactiveResult = { status: 'failed', code: 'provider_rejected' };
  const failed = await api(RUNTIME_ROUTES.schedules, 'POST', scheduleInput(binding.body.routeId, '2026-09-23T00:02:00.000Z'));
  assert.equal(failed.status, 201);
  now = new Date('2026-09-23T00:02:00.000Z');
  await scheduler.tick();
  await eventually(() => scheduler.history(failed.body.scheduleId)[0]?.deliveryStatus === 'failed');
  assert.equal(executions, initialExecutions + 2);
  assert.equal(notifications.length, initialNotifications + 2);
  assert.equal(sends.length, 2);
  await scheduler.tick();
  assert.equal(sends.length, 2);

  const pending = await api(RUNTIME_ROUTES.schedules, 'POST', scheduleInput(binding.body.routeId, '2026-09-23T00:03:00.000Z'));
  assert.equal(pending.status, 201);
  assert.equal((await api(`${contactsPath}/${encodeURIComponent(binding.body.routeId)}`, 'DELETE')).status, 204);
  assert.equal((await api(RUNTIME_ROUTES.schedules, 'POST', scheduleInput(binding.body.routeId, '2026-09-23T00:04:00.000Z'))).status, 400);
  now = new Date('2026-09-23T00:03:00.000Z');
  await scheduler.tick();
  await eventually(() => scheduler.history(pending.body.scheduleId)[0]?.triggerStatus === 'submission_failed');
  assert.equal(sends.length, 2);
  assert.equal(executions, initialExecutions + 2);
});
