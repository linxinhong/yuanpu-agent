import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PersistentAgentService,
  fingerprintAgentRunRequest,
  openYuanpuMetadataDatabase,
} from '../dist/index.mjs';
import { AGENT_CONTRACT_VERSION } from '@yuanpu-agent/protocol';

function caller(overrides = {}) {
  const identity = {
    kind: 'local_user',
    subjectId: 'user-1',
    authorityId: 'desktop-1',
    authenticatedBy: 'electron',
    ...overrides.identity,
  };
  return {
    entryPoint: 'desktop',
    identity,
    authorizeWorkspace: (workspaceId) => workspaceId === (overrides.workspaceId ?? '/workspace'),
    authorizeConversation: () => true,
    authorizeDelivery: () => true,
  };
}

function request(overrides = {}) {
  return {
    contractVersion: AGENT_CONTRACT_VERSION,
    entryPoint: 'desktop',
    identity: {
      kind: 'local_user',
      subjectId: 'user-1',
      authorityId: 'desktop-1',
      authenticatedBy: 'electron',
      ...overrides.identity,
    },
    workspaceId: overrides.workspaceId ?? '/workspace',
    conversation: {
      namespace: overrides.namespace ?? 'desktop',
      conversationId: overrides.conversationId ?? 'conversation-1',
      ...(overrides.threadId ? { threadId: overrides.threadId } : {}),
      ...(overrides.sessionBindingId ? { sessionBindingId: overrides.sessionBindingId } : {}),
    },
    input: { type: 'text', text: overrides.text ?? 'hello' },
    idempotencyKey: overrides.idempotencyKey ?? 'request-1',
    delivery: { kind: 'desktop' },
  };
}

async function waitUntil(check, message = 'condition was not met') {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function futureExpiry(offsetMs = 60_000) {
  return new Date(Date.now() + offsetMs).toISOString();
}

test('publishes durable run state transitions to the host observer', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  const observed = [];
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    executor: {
      async execute() {
        return { kind: 'completed', output: { message: 'done', tools: [] } };
      },
    },
    onRunStateChanged: (run) => observed.push(run),
  });
  const submitted = await service.submit(caller(), request({ idempotencyKey: 'observer-1' }));
  assert.equal(submitted.accepted, true);
  await waitUntil(() => observed.some((run) => run.status === 'succeeded'));
  assert.deepEqual(observed.map((run) => run.status), ['queued', 'running', 'succeeded']);
  assert.equal(observed.every((run) => run.runId === submitted.runId), true);
  await service.close();
  database.close();
});

test('serializes one conversation while running independent conversations concurrently', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  const gates = new Map();
  const starts = [];
  const executor = {
    async execute(input) {
      starts.push({
        runId: input.run.runId,
        conversation: input.run.context.conversation.conversationId,
        piSessionId: input.piSessionId,
      });
      const gate = deferred();
      gates.set(input.run.runId, gate);
      await gate.promise;
      return { kind: 'completed', output: { message: input.input, tools: [] } };
    },
  };
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    executor,
    maximumConcurrentRuns: 2,
  });
  const first = await service.submit(caller(), request({ idempotencyKey: 'a-1' }));
  const second = await service.submit(caller(), request({ idempotencyKey: 'a-2', text: 'second' }));
  const other = await service.submit(caller(), request({
    idempotencyKey: 'b-1', conversationId: 'conversation-2', text: 'other',
  }));
  assert.equal(first.accepted && second.accepted && other.accepted, true);

  await waitUntil(() => starts.length === 2);
  assert.deepEqual(starts.map((entry) => entry.conversation).sort(), ['conversation-1', 'conversation-2']);
  assert.equal(starts.some((entry) => entry.runId === second.runId), false);

  gates.get(first.runId).resolve();
  await waitUntil(() => starts.some((entry) => entry.runId === second.runId));
  assert.equal(
    starts.find((entry) => entry.runId === first.runId).piSessionId,
    starts.find((entry) => entry.runId === second.runId).piSessionId,
  );
  assert.notEqual(
    starts.find((entry) => entry.runId === first.runId).piSessionId,
    starts.find((entry) => entry.runId === other.runId).piSessionId,
  );
  gates.get(second.runId).resolve();
  gates.get(other.runId).resolve();
  await service.waitForIdle();
  assert.equal((await service.get(caller(), first.runId)).status, 'succeeded');
  assert.equal((await service.get(caller(), second.runId)).output.message, 'second');
  await service.close();
  database.close();
});

test('deduplicates submissions, bounds the durable queue, and never executes queued cancellation', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  const gate = deferred();
  const executed = [];
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    maximumConcurrentRuns: 1,
    maximumQueuedRuns: 2,
    executor: {
      async execute(input) {
        executed.push(input.run.runId);
        await gate.promise;
        return { kind: 'completed', output: { message: 'done', tools: [] } };
      },
    },
  });
  const firstPromise = service.submit(caller(), request({ idempotencyKey: 'first' }));
  const queuedPromise = service.submit(caller(), request({
    idempotencyKey: 'queued', conversationId: 'conversation-2',
  }));
  const overflowPromise = service.submit(caller(), request({
    idempotencyKey: 'overflow', conversationId: 'conversation-3',
  }));
  const [first, queued, overflow] = await Promise.all([firstPromise, queuedPromise, overflowPromise]);
  assert.equal(first.accepted, true);
  assert.equal(queued.accepted, true);
  assert.deepEqual(overflow, {
    accepted: false,
    code: 'queue_full',
    message: 'The Agent run queue is full.',
  });
  const duplicate = await service.submit(caller(), request({ idempotencyKey: 'first' }));
  assert.equal(duplicate.accepted, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.runId, first.runId);
  const conflict = await service.submit(caller(), request({ idempotencyKey: 'first', text: 'changed' }));
  assert.equal(conflict.code, 'idempotency_conflict');

  await waitUntil(() => executed.includes(first.runId));
  const cancellation = await service.cancel(caller(), queued.runId);
  assert.deepEqual(cancellation, { runId: queued.runId, result: 'cancelled', status: 'cancelled' });
  gate.resolve();
  await service.waitForIdle();
  assert.deepEqual(executed, [first.runId]);
  await service.close();
  database.close();
});

test('running cancellation records cancellation without claiming that effects were reversed', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  const started = deferred();
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    executor: {
      async execute(input) {
        started.resolve();
        await new Promise((resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
        });
      },
    },
  });
  const submission = await service.submit(caller(), request());
  await started.promise;
  const receipt = await service.cancel(caller(), submission.runId);
  assert.equal(receipt.result, 'cancellation_requested');
  await service.waitForIdle();
  const run = await service.get(caller(), submission.runId);
  assert.equal(run.status, 'cancelled');
  assert.match(run.failure.message, /side effects were not reversed/);
  await service.close();
  database.close();
});

test('rejects an explicit session binding that names another conversation', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    executor: {
      async execute(input) {
        return { kind: 'completed', output: { message: input.input, tools: [] } };
      },
    },
  });
  const first = await service.submit(caller(), request({ idempotencyKey: 'binding-a' }));
  await service.waitForIdle();
  const bindingId = (await service.get(caller(), first.runId)).context.conversation.sessionBindingId;
  const conflict = await service.submit(caller(), request({
    idempotencyKey: 'binding-b',
    conversationId: 'conversation-2',
    sessionBindingId: bindingId,
  }));
  assert.deepEqual(conflict, {
    accepted: false,
    code: 'forbidden',
    message: 'The requested session binding belongs to another conversation.',
  });
  await service.close();
  database.close();
});

test('isolates Pi sessions and failures across identities and workspaces', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  const sessions = new Map();
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    maximumConcurrentRuns: 2,
    executor: {
      async execute(input) {
        sessions.set(input.run.owner.identity.subjectId, input.piSessionId);
        if (input.run.owner.identity.subjectId === 'user-a') throw new Error('private failure for user-a');
        return { kind: 'completed', output: { message: 'user-b result', tools: [] } };
      },
    },
  });
  const callerA = caller({ identity: { subjectId: 'user-a' }, workspaceId: '/workspace-a' });
  const callerB = caller({ identity: { subjectId: 'user-b' }, workspaceId: '/workspace-b' });
  const runA = await service.submit(callerA, request({
    identity: { subjectId: 'user-a' }, workspaceId: '/workspace-a', idempotencyKey: 'a',
  }));
  const runB = await service.submit(callerB, request({
    identity: { subjectId: 'user-b' }, workspaceId: '/workspace-b', idempotencyKey: 'b',
  }));
  await service.waitForIdle();
  const resultA = await service.get(callerA, runA.runId);
  const resultB = await service.get(callerB, runB.runId);
  assert.equal(resultA.status, 'failed');
  assert.equal(resultA.failure.message, 'private failure for user-a');
  assert.equal(resultB.status, 'succeeded');
  assert.equal(resultB.output.message, 'user-b result');
  assert.notEqual(sessions.get('user-a'), sessions.get('user-b'));
  assert.equal(await service.get(callerB, runA.runId), undefined);
  assert.equal(await service.get(callerA, runB.runId), undefined);
  await service.close();
  database.close();
});

test('keeps callers isolated and resumes only safely queued work after restart', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  const firstRequest = request({ idempotencyKey: 'uncertain' });
  const firstFingerprint = fingerprintAgentRunRequest(firstRequest);
  const first = database.agentRuns.submit({
    request: firstRequest,
    requestFingerprint: firstFingerprint,
    inputDigest: 'a'.repeat(64),
    runId: 'run-uncertain',
    bindingId: 'binding-uncertain',
    piSessionId: '11111111-1111-4111-8111-111111111111',
    now: '2026-09-22T00:00:00.000Z',
    maximumQueuedRuns: 10,
  });
  database.agentRuns.claimQueued(first.run.runId, '2026-09-22T00:00:01.000Z');
  database.agentRuns.markWaitingApproval({
    runId: first.run.runId,
    approvalRequestId: 'approval-before-restart',
    sessionId: '11111111-1111-4111-8111-111111111111',
    workspaceId: '/workspace',
    expiresAt: '2026-09-22T01:00:00.000Z',
  }, '2026-09-22T00:00:01.500Z');
  const queuedRequest = request({
    idempotencyKey: 'safe-queued', conversationId: 'conversation-2', text: 'resume me',
  });
  const queued = database.agentRuns.submit({
    request: queuedRequest,
    requestFingerprint: fingerprintAgentRunRequest(queuedRequest),
    inputDigest: 'b'.repeat(64),
    runId: 'run-queued',
    bindingId: 'binding-queued',
    piSessionId: '22222222-2222-4222-8222-222222222222',
    now: '2026-09-22T00:00:02.000Z',
    maximumQueuedRuns: 10,
  });
  const approvalCancellations = [];
  const executed = [];
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    approvals: { async cancelRun(runId) { approvalCancellations.push(runId); } },
    executor: {
      async execute(input) {
        executed.push(input.input);
        return { kind: 'completed', output: { message: input.input, tools: [] } };
      },
    },
  });
  await service.waitForIdle();
  assert.equal((await service.get(caller(), first.run.runId)).status, 'result_unknown');
  assert.equal((await service.get(caller(), queued.run.runId)).status, 'succeeded');
  assert.deepEqual(executed, ['resume me']);
  assert.deepEqual(approvalCancellations, ['run-uncertain']);

  const otherCaller = caller({ identity: { subjectId: 'other-user' } });
  assert.equal(await service.get(otherCaller, first.run.runId), undefined);
  assert.deepEqual(await service.cancel(otherCaller, first.run.runId), {
    runId: first.run.runId, result: 'not_found',
  });
  await service.close();
  database.close();
});

test('binds approval completion to the original run', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    executor: {
      async execute(input) {
        return {
          kind: 'waiting_approval',
          approval: {
            runId: input.run.runId,
            approvalRequestId: 'approval-1',
            sessionId: input.piSessionId,
            workspaceId: input.run.context.workspaceId,
            expiresAt: futureExpiry(),
          },
          output: { message: 'Approval required', tools: [] },
        };
      },
    },
  });
  const submission = await service.submit(caller(), request());
  await waitUntil(async () => (await service.get(caller(), submission.runId)).status === 'waiting_approval');
  assert.throws(
    () => service.completeApproval(
      submission.runId,
      'approval-other',
      new AbortController().signal,
      { message: 'no', tools: [] },
    ),
    /not owned/,
  );
  const approvalSignal = await service.beginApproval(submission.runId, 'approval-1');
  assert.equal(approvalSignal.aborted, false);
  assert.equal((await service.get(caller(), submission.runId)).status, 'running');
  const completed = service.completeApproval(
    submission.runId,
    'approval-1',
    approvalSignal,
    { message: 'approved result', tools: [{ name: 'capability', status: 'completed' }] },
  );
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.output.message, 'approved result');
  await service.close();
  database.close();
});

test('holds a conversation binding while waiting and counts approved execution against concurrency', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  const starts = [];
  const otherGate = deferred();
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    maximumConcurrentRuns: 1,
    executor: {
      async execute(input) {
        starts.push(input.run.runId);
        if (input.run.context.conversation.conversationId === 'conversation-1') {
          return {
            kind: 'waiting_approval',
            approval: {
              runId: input.run.runId,
              approvalRequestId: 'approval-held',
              sessionId: input.piSessionId,
              workspaceId: input.run.context.workspaceId,
              expiresAt: futureExpiry(),
            },
            output: { message: 'Approval required', tools: [] },
          };
        }
        await otherGate.promise;
        return { kind: 'completed', output: { message: 'other', tools: [] } };
      },
    },
  });
  const waiting = await service.submit(caller(), request({ idempotencyKey: 'waiting' }));
  await waitUntil(async () => (await service.get(caller(), waiting.runId)).status === 'waiting_approval');
  const sameBinding = await service.submit(caller(), request({ idempotencyKey: 'same-binding' }));
  const other = await service.submit(caller(), request({
    idempotencyKey: 'other-binding', conversationId: 'conversation-2',
  }));
  await waitUntil(() => starts.includes(other.runId));
  assert.equal(starts.includes(sameBinding.runId), false);

  let approvalStarted = false;
  const approvalPromise = service.beginApproval(waiting.runId, 'approval-held').then((signal) => {
    approvalStarted = true;
    return signal;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(approvalStarted, false);
  otherGate.resolve();
  const approvalSignal = await approvalPromise;
  assert.equal(starts.includes(sameBinding.runId), false);
  service.completeApproval(
    waiting.runId,
    'approval-held',
    approvalSignal,
    { message: 'approved', tools: [] },
  );
  await waitUntil(() => starts.includes(sameBinding.runId));
  await waitUntil(async () => (await service.get(caller(), sameBinding.runId)).status === 'waiting_approval');
  const sameSignal = await service.beginApproval(sameBinding.runId, 'approval-held');
  service.completeApproval(
    sameBinding.runId,
    'approval-held',
    sameSignal,
    { message: 'approved again', tools: [] },
  );
  await service.close();
  database.close();
});

test('grants a single approval execution owner under concurrent decisions', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    executor: {
      async execute(input) {
        return {
          kind: 'waiting_approval',
          approval: {
            runId: input.run.runId,
            approvalRequestId: 'approval-owner',
            sessionId: input.piSessionId,
            workspaceId: input.run.context.workspaceId,
            expiresAt: futureExpiry(),
          },
          output: { message: 'Approval required', tools: [] },
        };
      },
    },
  });
  const submission = await service.submit(caller(), request());
  await waitUntil(async () => (await service.get(caller(), submission.runId)).status === 'waiting_approval');
  const decisions = await Promise.allSettled([
    service.beginApproval(submission.runId, 'approval-owner'),
    service.beginApproval(submission.runId, 'approval-owner'),
  ]);
  assert.equal(decisions.filter((decision) => decision.status === 'fulfilled').length, 1);
  assert.equal(decisions.filter((decision) => decision.status === 'rejected').length, 1);
  const winner = decisions.find((decision) => decision.status === 'fulfilled').value;
  assert.throws(
    () => service.failApproval(
      submission.runId,
      'approval-owner',
      new AbortController().signal,
      'losing decision',
    ),
    /not owned/,
  );
  service.completeApproval(
    submission.runId,
    'approval-owner',
    winner,
    { message: 'winner', tools: [] },
  );
  assert.equal((await service.get(caller(), submission.runId)).status, 'succeeded');
  await service.close();
  database.close();
});

test('denial reserves and finishes an approval without waiting for an execution slot', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  const blockerGate = deferred();
  const blockerStarted = deferred();
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    maximumConcurrentRuns: 1,
    executor: {
      async execute(input) {
        if (input.run.context.conversation.conversationId === 'conversation-1') {
          return {
            kind: 'waiting_approval',
            approval: {
              runId: input.run.runId,
              approvalRequestId: 'approval-denied',
              sessionId: input.piSessionId,
              workspaceId: input.run.context.workspaceId,
              expiresAt: futureExpiry(),
            },
            output: { message: 'Approval required', tools: [] },
          };
        }
        blockerStarted.resolve();
        await blockerGate.promise;
        return { kind: 'completed', output: { message: 'blocker done', tools: [] } };
      },
    },
  });
  const waiting = await service.submit(caller(), request({ idempotencyKey: 'denied-waiting' }));
  await waitUntil(async () => (await service.get(caller(), waiting.runId)).status === 'waiting_approval');
  await service.submit(caller(), request({
    idempotencyKey: 'denied-blocker', conversationId: 'conversation-2',
  }));
  await blockerStarted.promise;

  const signal = await service.beginApproval(waiting.runId, 'approval-denied', {
    executeCapability: false,
  });
  const denied = service.failApproval(
    waiting.runId,
    'approval-denied',
    signal,
    'Capability approval was denied by the desktop user.',
  );
  assert.equal(denied.status, 'failed');
  assert.match(denied.failure.message, /denied/);
  blockerGate.resolve();
  await service.waitForIdle();
  await service.close();
  database.close();
});

test('expires waiting approval and releases its conversation binding', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  const starts = [];
  const approvalCancellations = [];
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    approvals: { async cancelRun(runId) { approvalCancellations.push(runId); } },
    executor: {
      async execute(input) {
        starts.push(input.run.runId);
        if (input.input === 'needs approval') {
          return {
            kind: 'waiting_approval',
            approval: {
              runId: input.run.runId,
              approvalRequestId: 'approval-expiring',
              sessionId: input.piSessionId,
              workspaceId: input.run.context.workspaceId,
              expiresAt: futureExpiry(30),
            },
            output: { message: 'Approval required', tools: [] },
          };
        }
        return { kind: 'completed', output: { message: input.input, tools: [] } };
      },
    },
  });
  const expiring = await service.submit(caller(), request({
    idempotencyKey: 'expiring', text: 'needs approval',
  }));
  await waitUntil(async () => (await service.get(caller(), expiring.runId)).status === 'waiting_approval');
  const next = await service.submit(caller(), request({
    idempotencyKey: 'after-expiry', text: 'after expiry',
  }));
  await waitUntil(async () => (await service.get(caller(), expiring.runId)).status === 'failed');
  await waitUntil(async () => (await service.get(caller(), next.runId)).status === 'succeeded');
  const expired = await service.get(caller(), expiring.runId);
  assert.equal(expired.failure.code, 'approval_expired');
  assert.deepEqual(approvalCancellations, [expiring.runId]);
  assert.deepEqual(starts, [expiring.runId, next.runId]);
  await service.close();
  database.close();
});

test('shutdown records active work as result unknown, preserves queued work, and closes subscribers', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  const started = deferred();
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    maximumConcurrentRuns: 1,
    executor: {
      async execute(input) {
        started.resolve();
        await new Promise((resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
        });
      },
    },
  });
  const active = await service.submit(caller(), request({ idempotencyKey: 'active' }));
  const queued = await service.submit(caller(), request({
    idempotencyKey: 'queued', conversationId: 'conversation-2',
  }));
  await started.promise;
  const subscription = service.subscribe(caller(), queued.runId)[Symbol.asyncIterator]();
  assert.equal((await subscription.next()).value.status, 'queued');
  const pending = subscription.next();
  await service.close();
  assert.deepEqual(await pending, { value: undefined, done: true });
  assert.equal((await service.get(caller(), active.runId)).status, 'result_unknown');
  assert.equal((await service.get(caller(), queued.runId)).status, 'queued');
  database.close();
});

test('shutdown finishes abort and executor cleanup before reporting approval cancellation errors', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  let executorClosed = false;
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    approvals: {
      async cancelRun() {
        throw new Error('approval persistence failed');
      },
    },
    executor: {
      async execute(input) {
        return {
          kind: 'waiting_approval',
          approval: {
            runId: input.run.runId,
            approvalRequestId: 'approval-close-failure',
            sessionId: input.piSessionId,
            workspaceId: input.run.context.workspaceId,
            expiresAt: futureExpiry(),
          },
          output: { message: 'Approval required', tools: [] },
        };
      },
      async close() {
        executorClosed = true;
      },
    },
  });
  const submission = await service.submit(caller(), request({ idempotencyKey: 'close-failure' }));
  await waitUntil(async () => (await service.get(caller(), submission.runId)).status === 'waiting_approval');

  await assert.rejects(service.close(), /did not complete cleanly/);

  assert.equal(executorClosed, true);
  assert.equal((await service.get(caller(), submission.runId)).status, 'result_unknown');
  database.close();
});

test('orders approval execution against cancellation and records uncertain side effects', async () => {
  const database = openYuanpuMetadataDatabase(':memory:');
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    approvals: { async cancelRun() {} },
    executor: {
      async execute(input) {
        return {
          kind: 'waiting_approval',
          approval: {
            runId: input.run.runId,
            approvalRequestId: 'approval-race',
            sessionId: input.piSessionId,
            workspaceId: input.run.context.workspaceId,
            expiresAt: futureExpiry(),
          },
          output: { message: 'Approval required', tools: [] },
        };
      },
    },
  });
  const submission = await service.submit(caller(), request());
  await waitUntil(async () => (await service.get(caller(), submission.runId)).status === 'waiting_approval');
  const signal = await service.beginApproval(submission.runId, 'approval-race');
  const receipt = await service.cancel(caller(), submission.runId);
  assert.equal(receipt.result, 'cancellation_requested');
  assert.equal(signal.aborted, true);
  const cancelled = service.failApproval(
    submission.runId,
    'approval-race',
    signal,
    'Capability call observed cancellation.',
  );
  assert.equal(cancelled.status, 'cancelled');
  assert.match(cancelled.failure.message, /side effects were not reversed/);
  await service.close();
  database.close();
});
