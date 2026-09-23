import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  PersistentAgentService,
  PersistentScheduler,
  nextCronOccurrence,
  openYuanpuMetadataDatabase,
} from '../dist/index.mjs';
import { SCHEDULE_CONTRACT_VERSION } from '@yuanpu-agent/protocol';

const schedulerCaller = {
  entryPoint: 'scheduler',
  identity: {
    kind: 'scheduler',
    subjectId: 'local-scheduler',
    authorityId: 'test-runtime',
    authenticatedBy: 'scheduler',
  },
  authorizeWorkspace: (workspaceId) => workspaceId === '/workspace',
  authorizeConversation: (conversation) => conversation.namespace === 'scheduler',
  authorizeDelivery: () => true,
};

function scheduleInput(overrides = {}) {
  return {
    contractVersion: SCHEDULE_CONTRACT_VERSION,
    name: 'Daily work',
    prompt: 'Prepare the report',
    workspaceId: '/workspace',
    timing: { kind: 'cron', expression: '* * * * *' },
    timeZone: 'UTC',
    delivery: { kind: 'desktop' },
    ...overrides,
  };
}

async function eventually(predicate, message = 'condition was not reached') {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

test('cron skips nonexistent DST time and uses only the first ambiguous wall time', () => {
  const spring = nextCronOccurrence(
    '30 2 * * *',
    'America/New_York',
    new Date('2026-03-08T06:00:00.000Z'),
  );
  assert.equal(spring.toISOString(), '2026-03-09T06:30:00.000Z');

  const firstFall = nextCronOccurrence(
    '30 1 * * *',
    'America/New_York',
    new Date('2026-11-01T04:00:00.000Z'),
  );
  assert.equal(firstFall.toISOString(), '2026-11-01T05:30:00.000Z');
  const afterFirstFall = nextCronOccurrence('30 1 * * *', 'America/New_York', firstFall);
  assert.equal(afterFirstFall.toISOString(), '2026-11-02T06:30:00.000Z');

  const leapDay = nextCronOccurrence('0 0 29 2 *', 'UTC', new Date('2026-03-01T00:00:00.000Z'));
  assert.equal(leapDay.toISOString(), '2028-02-29T00:00:00.000Z');
});

test('each schedule revision fires once and default overlap policy skips a concurrent occurrence', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-scheduler-once-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, 'automation.sqlite');
  const metadata = openYuanpuMetadataDatabase(databasePath);
  let now = new Date('2026-09-22T00:00:30.000Z');
  const executions = [];
  const executor = {
    execute(input) {
      return new Promise((resolve) => executions.push({ input, resolve }));
    },
  };
  const agent = await PersistentAgentService.open({
    store: metadata.agentRuns,
    executor,
    now: () => now,
  });
  const scheduler = await PersistentScheduler.open({
    store: metadata.schedules,
    agent,
    caller: schedulerCaller,
    authorizeWorkspace: schedulerCaller.authorizeWorkspace,
    authorizeDelivery: () => true,
    now: () => now,
    scanIntervalMs: 60_000,
  });
  context.after(async () => {
    await scheduler.close();
    await agent.close();
    metadata.close();
  });

  const created = scheduler.create(scheduleInput());
  assert.equal(created.revision, 1);
  assert.equal(created.nextTriggerAt, '2026-09-22T00:01:00.000Z');

  now = new Date('2026-09-22T00:01:00.000Z');
  await scheduler.tick();
  await eventually(() => executions.length === 1);
  const inspection = new DatabaseSync(databasePath, { readOnly: true });
  const persistedTrigger = inspection.prepare(
    'SELECT request_json FROM yp_schedule_triggers WHERE schedule_id = ?',
  ).get(created.scheduleId);
  inspection.close();
  assert.doesNotMatch(persistedTrigger.request_json, /Prepare the report/);
  await scheduler.tick();
  assert.equal(executions.length, 1);

  now = new Date('2026-09-22T00:02:00.000Z');
  await scheduler.tick();
  assert.equal(executions.length, 1);
  assert.equal(scheduler.history(created.scheduleId)[0].triggerStatus, 'skipped_overlap');

  executions[0].resolve({ kind: 'completed', output: { message: 'first', tools: [] } });
  await agent.waitForIdle();
  await eventually(() => scheduler.history(created.scheduleId).some((item) => item.output?.message === 'first'));

  const revised = scheduler.update(created.scheduleId, scheduleInput({ prompt: 'Revised report' }));
  assert.equal(revised.revision, 2);
  assert.equal(revised.nextTriggerAt, '2026-09-22T00:03:00.000Z');
  now = new Date('2026-09-22T00:03:00.000Z');
  await scheduler.tick();
  await eventually(() => executions.length === 2);
  assert.equal(executions[1].input.input, 'Revised report');
  executions[1].resolve({ kind: 'completed', output: { message: 'second', tools: [] } });
  await agent.waitForIdle();
  const revisionKeys = scheduler.history(created.scheduleId).map((item) => item.triggerKey);
  assert.equal(revisionKeys.some((key) => key.includes(':1:')), true);
  assert.equal(revisionKeys.some((key) => key.includes(':2:')), true);
});

test('closed scheduler executes nothing and restart coalesces bounded missed cron runs', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-scheduler-restart-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'automation.sqlite');
  let now = new Date('2026-09-22T00:00:30.000Z');
  let executions = 0;
  let metadata = openYuanpuMetadataDatabase(path);
  let agent = await PersistentAgentService.open({
    store: metadata.agentRuns,
    executor: {
      async execute(input) {
        executions += 1;
        return { kind: 'completed', output: { message: input.input, tools: [] } };
      },
    },
    now: () => now,
  });
  let scheduler = await PersistentScheduler.open({
    store: metadata.schedules,
    agent,
    caller: schedulerCaller,
    authorizeWorkspace: schedulerCaller.authorizeWorkspace,
    authorizeDelivery: () => true,
    now: () => now,
    scanIntervalMs: 60_000,
  });
  const created = scheduler.create(scheduleInput({ maximumLatenessMs: 10 * 60_000 }));
  await scheduler.close();

  now = new Date('2026-09-22T02:00:00.000Z');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(executions, 0, 'App exit must leave no scheduler execution behind');
  await agent.close();
  metadata.close();

  metadata = openYuanpuMetadataDatabase(path);
  agent = await PersistentAgentService.open({
    store: metadata.agentRuns,
    executor: {
      async execute(input) {
        executions += 1;
        return { kind: 'completed', output: { message: input.input, tools: [] } };
      },
    },
    now: () => now,
  });
  scheduler = await PersistentScheduler.open({
    store: metadata.schedules,
    agent,
    caller: schedulerCaller,
    authorizeWorkspace: schedulerCaller.authorizeWorkspace,
    authorizeDelivery: () => true,
    now: () => now,
    scanIntervalMs: 60_000,
  });
  await agent.waitForIdle();
  await eventually(() => scheduler.history(created.scheduleId).some((item) => item.runStatus === 'succeeded'));
  assert.equal(executions, 1);
  assert.equal(scheduler.history(created.scheduleId)[0].scheduledAt, '2026-09-22T02:00:00.000Z');

  now = new Date('2026-09-22T01:00:00.000Z');
  await scheduler.tick();
  assert.equal(executions, 1, 'backward clock changes must not replay an existing trigger');
  await scheduler.close();
  await agent.close();
  metadata.close();
});

test('history exposes execution failures and waiting approval without retrying either run', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-scheduler-history-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const metadata = openYuanpuMetadataDatabase(join(root, 'automation.sqlite'));
  let now = new Date('2026-09-22T00:00:30.000Z');
  let executions = 0;
  const agent = await PersistentAgentService.open({
    store: metadata.agentRuns,
    executor: {
      async execute(input) {
        executions += 1;
        if (input.input === 'needs approval') {
          return {
            kind: 'waiting_approval',
            approval: {
              runId: input.run.runId,
              approvalRequestId: `approval-${input.run.runId}`,
              sessionId: input.piSessionId,
              workspaceId: input.run.context.workspaceId,
              expiresAt: '2099-01-01T00:00:00.000Z',
            },
            output: { message: 'Approval required', tools: [] },
          };
        }
        throw new Error('controlled model failure');
      },
    },
    now: () => now,
  });
  const scheduler = await PersistentScheduler.open({
    store: metadata.schedules,
    agent,
    caller: schedulerCaller,
    authorizeWorkspace: schedulerCaller.authorizeWorkspace,
    authorizeDelivery: () => true,
    now: () => now,
    scanIntervalMs: 60_000,
  });
  const failed = scheduler.create(scheduleInput({
    name: 'Failure',
    prompt: 'fail',
    timing: { kind: 'once', at: '2026-09-22T00:01:00.000Z' },
  }));
  const waiting = scheduler.create(scheduleInput({
    name: 'Approval',
    prompt: 'needs approval',
    timing: { kind: 'once', at: '2026-09-22T00:01:00.000Z' },
  }));
  now = new Date('2026-09-22T00:01:00.000Z');
  await scheduler.tick();
  await agent.waitForIdle();
  await eventually(() => scheduler.history(failed.scheduleId)[0]?.runStatus === 'failed');
  await eventually(() => scheduler.history(waiting.scheduleId)[0]?.runStatus === 'waiting_approval');
  assert.match(scheduler.history(failed.scheduleId)[0].runFailure.message, /controlled model failure/);
  assert.equal(scheduler.history(waiting.scheduleId)[0].output, undefined);
  await scheduler.tick();
  assert.equal(executions, 2);

  await scheduler.close();
  await agent.close();
  metadata.close();
});

test('coalesce advances a sparse cron schedule when no missed occurrence remains inside the bound', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-scheduler-sparse-misfire-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'automation.sqlite');
  let now = new Date('2026-09-22T23:59:00.000Z');
  let executions = 0;
  let metadata = openYuanpuMetadataDatabase(path);
  let agent = await PersistentAgentService.open({
    store: metadata.agentRuns,
    executor: {
      async execute() {
        executions += 1;
        return { kind: 'completed', output: { message: '', tools: [] } };
      },
    },
    now: () => now,
  });
  let scheduler = await PersistentScheduler.open({
    store: metadata.schedules,
    agent,
    caller: schedulerCaller,
    authorizeWorkspace: schedulerCaller.authorizeWorkspace,
    authorizeDelivery: () => true,
    now: () => now,
    scanIntervalMs: 60_000,
  });
  const schedule = scheduler.create(scheduleInput({
    timing: { kind: 'cron', expression: '0 0 * * *' },
    maximumLatenessMs: 60_000,
  }));
  assert.equal(schedule.nextTriggerAt, '2026-09-23T00:00:00.000Z');
  await scheduler.close();
  await agent.close();
  metadata.close();

  now = new Date('2026-09-23T12:00:00.000Z');
  metadata = openYuanpuMetadataDatabase(path);
  agent = await PersistentAgentService.open({
    store: metadata.agentRuns,
    executor: {
      async execute() {
        executions += 1;
        return { kind: 'completed', output: { message: '', tools: [] } };
      },
    },
    now: () => now,
  });
  scheduler = await PersistentScheduler.open({
    store: metadata.schedules,
    agent,
    caller: schedulerCaller,
    authorizeWorkspace: schedulerCaller.authorizeWorkspace,
    authorizeDelivery: () => true,
    now: () => now,
    scanIntervalMs: 60_000,
  });
  assert.equal(executions, 0);
  assert.equal(scheduler.history(schedule.scheduleId)[0].triggerStatus, 'skipped_misfire');
  assert.equal(scheduler.get(schedule.scheduleId).nextTriggerAt, '2026-09-24T00:00:00.000Z');
  await scheduler.tick();
  assert.equal(scheduler.history(schedule.scheduleId).length, 1);
  await scheduler.close();
  await agent.close();
  metadata.close();
});

test('delivery retries reuse one key while unknown Agent results are never resubmitted', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-scheduler-delivery-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'automation.sqlite');
  let now = new Date('2026-09-22T00:00:30.000Z');
  const deliveries = [];
  let executions = 0;
  let metadata = openYuanpuMetadataDatabase(path);
  let agent = await PersistentAgentService.open({
    store: metadata.agentRuns,
    executor: {
      async execute(input) {
        executions += 1;
        return { kind: 'completed', output: { message: input.input, tools: [] } };
      },
    },
    now: () => now,
  });
  let scheduler = await PersistentScheduler.open({
    store: metadata.schedules,
    agent,
    caller: schedulerCaller,
    authorizeWorkspace: schedulerCaller.authorizeWorkspace,
    authorizeDelivery: () => true,
    delivery: {
      supports: (target) => target.kind === 'channel',
      supportsIdempotency: () => true,
      async deliver(input) {
        deliveries.push(input);
        if (deliveries.length === 1) throw new Error('temporary send failure');
      },
    },
    now: () => now,
    scanIntervalMs: 60_000,
  });
  const deliveredSchedule = scheduler.create(scheduleInput({
    timing: { kind: 'once', at: '2026-09-22T00:01:00.000Z' },
    delivery: { kind: 'channel', routeId: 'test-route' },
  }));
  now = new Date('2026-09-22T00:01:00.000Z');
  await scheduler.tick();
  await agent.waitForIdle();
  await eventually(() => scheduler.history(deliveredSchedule.scheduleId)[0]?.deliveryStatus === 'failed');
  await scheduler.tick();
  await eventually(() => scheduler.history(deliveredSchedule.scheduleId)[0]?.deliveryStatus === 'delivered');
  assert.equal(executions, 1);
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].idempotencyKey, deliveries[1].idempotencyKey);
  assert.equal(scheduler.history(deliveredSchedule.scheduleId)[0].deliveryAttempts, 2);

  await scheduler.close();
  await agent.close();
  metadata.close();

  now = new Date('2026-09-22T01:00:30.000Z');
  let started = false;
  metadata = openYuanpuMetadataDatabase(path);
  agent = await PersistentAgentService.open({
    store: metadata.agentRuns,
    executor: {
      execute(input) {
        executions += 1;
        started = true;
        return new Promise((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
        });
      },
    },
    now: () => now,
  });
  scheduler = await PersistentScheduler.open({
    store: metadata.schedules,
    agent,
    caller: schedulerCaller,
    authorizeWorkspace: schedulerCaller.authorizeWorkspace,
    authorizeDelivery: () => true,
    now: () => now,
    scanIntervalMs: 60_000,
  });
  const uncertainSchedule = scheduler.create(scheduleInput({
    name: 'Unknown result',
    timing: { kind: 'once', at: '2026-09-22T01:01:00.000Z' },
    delivery: { kind: 'none' },
  }));
  now = new Date('2026-09-22T01:01:00.000Z');
  await scheduler.tick();
  await eventually(() => started);
  await scheduler.close();
  await agent.close();
  metadata.close();
  const executionsBeforeRestart = executions;

  metadata = openYuanpuMetadataDatabase(path);
  let restartedExecutions = 0;
  agent = await PersistentAgentService.open({
    store: metadata.agentRuns,
    executor: {
      async execute() {
        restartedExecutions += 1;
        return { kind: 'completed', output: { message: 'must not run', tools: [] } };
      },
    },
    now: () => now,
  });
  scheduler = await PersistentScheduler.open({
    store: metadata.schedules,
    agent,
    caller: schedulerCaller,
    authorizeWorkspace: schedulerCaller.authorizeWorkspace,
    authorizeDelivery: () => true,
    now: () => now,
    scanIntervalMs: 60_000,
  });
  assert.equal(restartedExecutions, 0);
  assert.equal(executions, executionsBeforeRestart);
  assert.equal(scheduler.history(uncertainSchedule.scheduleId)[0].runStatus, 'result_unknown');
  assert.equal(scheduler.history(uncertainSchedule.scheduleId)[0].deliveryStatus, undefined);
  await scheduler.close();
  await agent.close();
  metadata.close();
});

test('shutdown marks an in-flight delivery unknown and restart retries only with the same safe key', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-scheduler-delivery-shutdown-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'automation.sqlite');
  let now = new Date('2026-09-22T00:00:30.000Z');
  let metadata = openYuanpuMetadataDatabase(path);
  let agent = await PersistentAgentService.open({
    store: metadata.agentRuns,
    executor: {
      async execute(input) {
        return { kind: 'completed', output: { message: input.input, tools: [] } };
      },
    },
    now: () => now,
  });
  let deliveryStarted = false;
  let firstKey;
  let scheduler = await PersistentScheduler.open({
    store: metadata.schedules,
    agent,
    caller: schedulerCaller,
    authorizeWorkspace: schedulerCaller.authorizeWorkspace,
    authorizeDelivery: () => true,
    delivery: {
      supports: () => true,
      supportsIdempotency: () => true,
      deliver(input) {
        deliveryStarted = true;
        firstKey = input.idempotencyKey;
        return new Promise((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
        });
      },
    },
    now: () => now,
    scanIntervalMs: 60_000,
  });
  const schedule = scheduler.create(scheduleInput({
    timing: { kind: 'once', at: '2026-09-22T00:01:00.000Z' },
    delivery: { kind: 'channel', routeId: 'shutdown-route' },
  }));
  now = new Date('2026-09-22T00:01:00.000Z');
  const deliveryTick = scheduler.tick();
  await eventually(() => deliveryStarted);
  await scheduler.close();
  await deliveryTick;
  assert.equal(scheduler.history(schedule.scheduleId)[0].deliveryStatus, 'result_unknown');
  await agent.close();
  metadata.close();

  let retriedKey;
  metadata = openYuanpuMetadataDatabase(path);
  agent = await PersistentAgentService.open({
    store: metadata.agentRuns,
    executor: {
      async execute() {
        throw new Error('completed Agent run must not execute again');
      },
    },
    now: () => now,
  });
  scheduler = await PersistentScheduler.open({
    store: metadata.schedules,
    agent,
    caller: schedulerCaller,
    authorizeWorkspace: schedulerCaller.authorizeWorkspace,
    authorizeDelivery: () => true,
    delivery: {
      supports: () => true,
      supportsIdempotency: () => true,
      async deliver(input) {
        retriedKey = input.idempotencyKey;
      },
    },
    now: () => now,
    scanIntervalMs: 60_000,
  });
  await eventually(() => scheduler.history(schedule.scheduleId)[0]?.deliveryStatus === 'delivered');
  assert.equal(retriedKey, firstKey);
  assert.equal(scheduler.history(schedule.scheduleId)[0].deliveryAttempts, 2);
  await scheduler.close();
  await agent.close();
  metadata.close();
});

test('a non-idempotent proactive send with uncertain receipt stays unknown after restart', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-scheduler-unknown-send-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'automation.sqlite');
  let now = new Date('2026-09-22T00:00:30.000Z');
  let sends = 0;
  let metadata = openYuanpuMetadataDatabase(path);
  let agent = await PersistentAgentService.open({
    store: metadata.agentRuns,
    executor: { async execute() { return { kind: 'completed', output: { message: 'output', tools: [] } }; } },
    now: () => now,
  });
  const delivery = {
    supports: () => true,
    supportsIdempotency: () => false,
    async deliver() { sends += 1; return { status: 'unknown', code: 'transport_uncertain' }; },
  };
  let scheduler = await PersistentScheduler.open({
    store: metadata.schedules, agent, caller: schedulerCaller,
    authorizeWorkspace: schedulerCaller.authorizeWorkspace,
    authorizeDelivery: () => true, delivery,
    now: () => now, scanIntervalMs: 60_000,
  });
  const schedule = scheduler.create(scheduleInput({
    timing: { kind: 'once', at: '2026-09-22T00:01:00.000Z' },
    delivery: { kind: 'channel', routeId: 'opaque-fixture' },
  }));
  now = new Date('2026-09-22T00:01:00.000Z');
  await scheduler.tick();
  await eventually(() => scheduler.history(schedule.scheduleId)[0]?.deliveryStatus === 'result_unknown');
  assert.equal(sends, 1);
  await scheduler.close();
  await agent.close();
  metadata.close();

  metadata = openYuanpuMetadataDatabase(path);
  agent = await PersistentAgentService.open({
    store: metadata.agentRuns,
    executor: { async execute() { throw new Error('must not rerun Agent'); } },
    now: () => now,
  });
  scheduler = await PersistentScheduler.open({
    store: metadata.schedules, agent, caller: schedulerCaller,
    authorizeWorkspace: schedulerCaller.authorizeWorkspace,
    authorizeDelivery: () => true, delivery,
    now: () => now, scanIntervalMs: 60_000,
  });
  await scheduler.tick();
  assert.equal(sends, 1);
  assert.equal(scheduler.history(schedule.scheduleId)[0].deliveryStatus, 'result_unknown');
  await scheduler.close();
  await agent.close();
  metadata.close();
});

test('an unauthenticated channel defers a pending send without consuming an attempt', async () => {
  const metadata = openYuanpuMetadataDatabase(':memory:');
  let now = new Date('2026-09-22T00:00:30.000Z');
  let executions = 0;
  let ready = false;
  let sends = 0;
  const agent = await PersistentAgentService.open({
    store: metadata.agentRuns,
    executor: { async execute() {
      executions += 1;
      return { kind: 'completed', output: { message: 'output', tools: [] } };
    } },
    now: () => now,
  });
  const scheduler = await PersistentScheduler.open({
    store: metadata.schedules, agent, caller: schedulerCaller,
    authorizeWorkspace: schedulerCaller.authorizeWorkspace,
    authorizeDelivery: () => true,
    delivery: {
      supports: () => true,
      supportsIdempotency: () => false,
      async deliver() {
        if (!ready) return { status: 'deferred' };
        sends += 1;
        return { status: 'accepted' };
      },
    },
    now: () => now, scanIntervalMs: 60_000,
  });
  try {
    const schedule = scheduler.create(scheduleInput({
      timing: { kind: 'once', at: '2026-09-22T00:01:00.000Z' },
      delivery: { kind: 'channel', routeId: 'opaque-fixture' },
    }));
    now = new Date('2026-09-22T00:01:00.000Z');
    await scheduler.tick();
    await eventually(() => scheduler.history(schedule.scheduleId)[0]?.deliveryStatus === 'pending');
    assert.equal(scheduler.history(schedule.scheduleId)[0].deliveryAttempts, 0);
    assert.equal(executions, 1);
    ready = true;
    await scheduler.tick();
    await eventually(() => scheduler.history(schedule.scheduleId)[0]?.deliveryStatus === 'delivered');
    assert.equal(sends, 1);
    assert.equal(executions, 1);
  } finally {
    await scheduler.close();
    await agent.close();
    metadata.close();
  }
});

test('close racing an awaited run lookup cannot start a delivery afterwards', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-scheduler-close-race-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'automation.sqlite');
  let now = new Date('2026-09-22T00:00:30.000Z');
  const metadata = openYuanpuMetadataDatabase(path);
  const agent = await PersistentAgentService.open({
    store: metadata.agentRuns,
    executor: {
      async execute(input) {
        return { kind: 'completed', output: { message: input.input, tools: [] } };
      },
    },
    now: () => now,
  });
  let scheduler = await PersistentScheduler.open({
    store: metadata.schedules,
    agent,
    caller: schedulerCaller,
    authorizeWorkspace: schedulerCaller.authorizeWorkspace,
    authorizeDelivery: () => true,
    delivery: {
      supports: () => true,
      supportsIdempotency: () => true,
      async deliver() { throw new Error('initial failure'); },
    },
    now: () => now,
    scanIntervalMs: 60_000,
  });
  const schedule = scheduler.create(scheduleInput({
    timing: { kind: 'once', at: '2026-09-22T00:01:00.000Z' },
    delivery: { kind: 'channel', routeId: 'race-route' },
  }));
  now = new Date('2026-09-22T00:01:00.000Z');
  await scheduler.tick();
  await eventually(() => scheduler.history(schedule.scheduleId)[0]?.deliveryStatus === 'failed');
  await scheduler.close();
  await agent.close();

  let retryEnabled = false;
  let getCalls = 0;
  let lookupBlocked = false;
  let releaseLookup;
  const lookupBarrier = new Promise((resolve) => { releaseLookup = resolve; });
  const persistedAgent = {
    async submit() { throw new Error('no new submission expected'); },
    async get(_caller, runId) {
      getCalls += 1;
      if (retryEnabled && getCalls === 2) {
        lookupBlocked = true;
        await lookupBarrier;
      }
      return metadata.agentRuns.get(runId);
    },
    async cancel() { throw new Error('no cancellation expected'); },
    async *subscribe() {},
  };
  let deliveredAfterClose = false;
  scheduler = await PersistentScheduler.open({
    store: metadata.schedules,
    agent: persistedAgent,
    caller: schedulerCaller,
    authorizeWorkspace: schedulerCaller.authorizeWorkspace,
    authorizeDelivery: () => true,
    delivery: {
      supports: () => true,
      supportsIdempotency: () => retryEnabled,
      async deliver() { deliveredAfterClose = true; },
    },
    now: () => now,
    scanIntervalMs: 60_000,
  });
  getCalls = 0;
  retryEnabled = true;
  const tick = scheduler.tick();
  await eventually(() => lookupBlocked);
  const closing = scheduler.close();
  releaseLookup();
  await Promise.all([tick, closing]);
  assert.equal(deliveredAfterClose, false);
  assert.equal(scheduler.history(schedule.scheduleId)[0].deliveryStatus, 'failed');
  metadata.close();
});
