import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanupRuntimeResources,
  getDesktopNavigableRun,
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

test('cleanup continues after scheduler rejection and aggregates all close failures', async () => {
  const calls = [];
  const schedulerFailure = new Error('scheduler close failed');
  const agentFailure = new Error('agent close failed');

  await assert.rejects(
    cleanupRuntimeResources({
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
      assert.deepEqual(error.errors, [schedulerFailure, agentFailure]);
      return true;
    },
  );
  assert.deepEqual(calls, ['scheduler', 'notification', 'agent', 'python', 'metadata']);
});
