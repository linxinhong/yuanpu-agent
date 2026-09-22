import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPABILITY_TOOL_NAMES,
  HostNotificationRouter,
  createNotificationCapabilitySource,
  createYuanpuCapabilityTools,
  createYuanpuMcpServer,
  requestTerminalRunNotification,
} from '../dist/index.mjs';

function ids() {
  let value = 0;
  return () => `id-${++value}`;
}

test('notify_user is discovered and executed through the two existing MCP meta tools', async () => {
  const router = new HostNotificationRouter({ createId: ids(), receiptTimeoutMs: 500 });
  let deliver;
  const deliveredEvent = new Promise((resolve) => { deliver = resolve; });
  router.subscribe(undefined, deliver);
  const mcp = createYuanpuMcpServer([createNotificationCapabilitySource(router)]);

  assert.deepEqual(mcp.listTools().map((tool) => tool.name), [
    CAPABILITY_TOOL_NAMES.search,
    CAPABILITY_TOOL_NAMES.execute,
  ]);
  const tools = createYuanpuCapabilityTools(mcp, {
    runId: 'run-1', conversationId: 'default', sessionId: 'pi-1',
  });
  const searchResult = await tools[0].execute('search-call', { query: 'notify user' });
  const search = searchResult.details;
  assert.equal(search.matches.length, 1);
  assert.equal(search.matches[0].originalName, 'notify_user');

  const execution = tools[1].execute('execute-call', {
    name: search.matches[0].name,
    arguments: { title: 'Search complete', body: 'The requested search has finished.' },
  });
  const delivered = await deliveredEvent;
  assert.equal(delivered.type, 'notification_requested');
  assert.deepEqual(delivered.payload, {
    requestId: 'id-1',
    title: 'Search complete',
    body: 'The requested search has finished.',
    kind: 'reminder',
    conversationId: 'default',
    runId: 'run-1',
  });
  router.acknowledge({
    eventId: delivered.eventId,
    status: 'accepted',
    notification: {
      requestId: delivered.payload.requestId,
      status: 'submitted',
      userVisibility: 'unknown',
    },
  });
  const result = await execution;
  assert.equal(result.details.structuredContent.status, 'submitted');
  assert.equal(result.details.structuredContent.userVisibility, 'unknown');
  assert.match(result.content[0].text, /visibility remains unknown/);
});

test('trusted system events use the same route without invoking a model and replay until receipt', async () => {
  const router = new HostNotificationRouter({ createId: ids() });
  const first = [];
  const unsubscribe = router.subscribe(undefined, (event) => first.push(event));
  const pending = requestTerminalRunNotification(router, {
    runId: 'run-system',
    owner: {
      entryPoint: 'scheduler',
      identity: {
        kind: 'scheduler', subjectId: 'schedule-1', authorityId: 'local', authenticatedBy: 'scheduler',
      },
    },
    context: {
      workspaceId: '/workspace',
      conversation: { namespace: 'scheduler', conversationId: 'default' },
      delivery: { kind: 'desktop' },
    },
    requestFingerprint: 'fingerprint',
    inputDigest: 'digest',
    status: 'succeeded',
    externalEffectState: 'possible',
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:01.000Z',
  });
  assert.ok(pending);
  assert.equal(first[0].payload.kind, 'run_succeeded');
  assert.equal(first[0].payload.body.includes('fingerprint'), false);
  unsubscribe();
  const replay = [];
  router.subscribe(first[0].eventId, (event) => replay.push(event));
  assert.equal(replay.length, 1);
  assert.equal(replay[0].eventId, first[0].eventId);

  router.acknowledge({
    eventId: replay[0].eventId,
    status: 'duplicate',
    notification: {
      requestId: replay[0].payload.requestId,
      status: 'submitted',
      userVisibility: 'unknown',
    },
  });
  assert.equal((await pending).status, 'submitted');
});

test('closing the Runtime resolves pending requests and prevents later delivery', async () => {
  const router = new HostNotificationRouter({ createId: ids(), receiptTimeoutMs: 500 });
  const events = [];
  router.subscribe(undefined, (event) => events.push(event));
  const pending = router.request({ title: 'Before quit', body: 'Do not leak', kind: 'reminder' });
  assert.equal(events.length, 1);
  router.close();
  assert.deepEqual(await pending, {
    requestId: 'id-1',
    status: 'unavailable',
    userVisibility: 'unknown',
    message: 'The Runtime stopped before the notification could be submitted.',
  });
  const after = await router.request({ title: 'After quit', body: 'Never deliver', kind: 'reminder' });
  assert.equal(after.status, 'unavailable');
  assert.equal(events.length, 1);
});
