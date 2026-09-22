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
      namespace: 'desktop',
      conversationId: overrides.conversationId ?? 'conversation-1',
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
            expiresAt: '2026-09-22T01:00:00.000Z',
          },
          output: { message: 'Approval required', tools: [] },
        };
      },
    },
  });
  const submission = await service.submit(caller(), request());
  await waitUntil(async () => (await service.get(caller(), submission.runId)).status === 'waiting_approval');
  assert.throws(
    () => service.completeApproval(submission.runId, 'approval-other', { message: 'no', tools: [] }),
    /does not belong/,
  );
  const completed = service.completeApproval(
    submission.runId,
    'approval-1',
    { message: 'approved result', tools: [{ name: 'capability', status: 'completed' }] },
  );
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.output.message, 'approved result');
  await service.close();
  database.close();
});
