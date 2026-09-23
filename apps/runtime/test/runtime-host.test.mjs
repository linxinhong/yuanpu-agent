import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanupRuntimeResources,
  getDesktopNavigableRun,
  getDesktopPrivateImRunSummary,
} from '../src/runtime-host.ts';

const desktopCaller = { entryPoint: 'desktop' };
const schedulerCaller = { entryPoint: 'scheduler' };

test('desktop navigation uses only the fixed desktop and scheduler authorization contexts', async () => {
  const calls = [];
  const agent = {
    async get(caller, runId) {
      calls.push([caller.entryPoint, runId]);
      if (runId === 'desktop-run' && caller === desktopCaller) return { runId };
      if (runId === 'scheduler-run' && caller === schedulerCaller) return { runId };
      return undefined;
    },
  };

  assert.equal(
    (await getDesktopNavigableRun(agent, 'desktop-run', desktopCaller, schedulerCaller)).runId,
    'desktop-run',
  );
  assert.deepEqual(calls, [['desktop', 'desktop-run']]);

  calls.length = 0;
  assert.equal(
    (await getDesktopNavigableRun(agent, 'scheduler-run', desktopCaller, schedulerCaller)).runId,
    'scheduler-run',
  );
  assert.deepEqual(calls, [
    ['desktop', 'scheduler-run'],
    ['scheduler', 'scheduler-run'],
  ]);

  calls.length = 0;
  assert.equal(await getDesktopNavigableRun(agent, 'foreign-desktop-run', desktopCaller, schedulerCaller), undefined);
  assert.deepEqual(calls, [
    ['desktop', 'foreign-desktop-run'],
    ['scheduler', 'foreign-desktop-run'],
  ]);
});

test('private IM summary requires a current paired sender and exposes only run and delivery states', () => {
  const run = {
    runId: 'im-run', status: 'succeeded',
    owner: { entryPoint: 'im', identity: {
      kind: 'channel_user', subjectId: 'conversation-digest',
      authorityId: 'imc_fixture', authenticatedBy: 'channel_adapter',
    } },
    context: { workspaceId: '/fixture/workspace', conversation: { namespace: 'im:wecom:fixture' } },
  };
  const inbound = {
    provider: 'wecom', connectionId: 'imc_fixture', conversationType: 'single',
    conversationDigest: 'conversation-digest', senderDigest: 'sender-digest', action: 'run',
  };
  const stores = {
    agentRuns: { get: () => run },
    channels: {
      getInboundForRun: () => inbound,
      getOutboundForRun: () => ({ status: 'unknown', contentDigest: 'secret-digest', failureCode: 'private-error' }),
    },
  };
  const document = {
    schemaVersion: 1,
    connections: [{ connectionId: 'imc_fixture', pairedSenderDigests: ['sender-digest'] }],
  };
  assert.deepEqual(getDesktopPrivateImRunSummary('im-run', stores, document, '/fixture/workspace'), {
    runId: 'im-run', runStatus: 'succeeded', replyDeliveryStatus: 'unknown',
  });
  assert.equal(getDesktopPrivateImRunSummary('im-run', stores, { ...document, connections: [] }, '/fixture/workspace'), undefined);
  assert.equal(getDesktopPrivateImRunSummary('im-run', stores, document, '/other/workspace'), undefined);
  assert.equal(getDesktopPrivateImRunSummary('im-run', {
    ...stores,
    channels: { ...stores.channels, getInboundForRun: () => ({ ...inbound, conversationType: 'group' }) },
  }, document, '/fixture/workspace'), undefined);
  assert.equal(getDesktopPrivateImRunSummary('im-run', {
    ...stores,
    agentRuns: { get: () => ({ ...run, owner: { ...run.owner, identity: { ...run.owner.identity, subjectId: 'foreign' } } }) },
  }, document, '/fixture/workspace'), undefined);
  assert.deepEqual(getDesktopPrivateImRunSummary('im-run', {
    ...stores,
    channels: { ...stores.channels, getOutboundForRun: () => undefined },
  }, document, '/fixture/workspace')?.replyDeliveryStatus, 'not_created');
});

test('cleanup continues after scheduler rejection and aggregates all close failures', async () => {
  const calls = [];
  const channelFailure = new Error('channel close failed');
  const schedulerFailure = new Error('scheduler close failed');
  const agentFailure = new Error('agent close failed');

  await assert.rejects(
    cleanupRuntimeResources({
      async closeChannels() {
        calls.push('channels');
        throw channelFailure;
      },
      async closeScheduler() {
        calls.push('scheduler');
        throw schedulerFailure;
      },
      closeNotificationRouter() {
        calls.push('notification');
      },
      async closeAgentService() {
        calls.push('agent');
        throw agentFailure;
      },
      async closePythonSource() {
        calls.push('python');
      },
      closeMetadata() {
        calls.push('metadata');
      },
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.deepEqual(error.errors, [schedulerFailure, channelFailure, agentFailure]);
      return true;
    },
  );
  assert.deepEqual(calls, ['scheduler', 'channels', 'notification', 'agent', 'python', 'metadata']);
});
