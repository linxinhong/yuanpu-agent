import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { AGENT_CONTRACT_VERSION } from '@yuanpu-agent/protocol';
import {
  CapabilityApprovalStore,
  PersistentAgentService,
  openYuanpuMetadataDatabase,
} from '../dist/index.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

function caller(subjectId, workspaceId) {
  return {
    entryPoint: 'desktop',
    identity: {
      kind: 'local_user',
      subjectId,
      authorityId: 'task-014-host',
      authenticatedBy: 'electron',
    },
    authorizeWorkspace: (candidate) => candidate === workspaceId,
    authorizeConversation: () => true,
    authorizeDelivery: () => true,
  };
}

function request(subjectId, workspaceId, overrides = {}) {
  return {
    contractVersion: AGENT_CONTRACT_VERSION,
    entryPoint: 'desktop',
    identity: {
      kind: 'local_user',
      subjectId,
      authorityId: 'task-014-host',
      authenticatedBy: 'electron',
    },
    workspaceId,
    conversation: {
      namespace: 'task-014',
      conversationId: overrides.conversationId ?? `conversation-${subjectId}`,
    },
    input: { type: 'text', text: overrides.text ?? `input-${subjectId}` },
    idempotencyKey: overrides.idempotencyKey ?? 'same-key-across-identities',
    delivery: { kind: 'desktop' },
  };
}

async function temporaryDatabase(context, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'automation.sqlite');
  return { root, path, database: openYuanpuMetadataDatabase(path) };
}

test('TASK-014 isolates two concurrent identities and Pi session bindings in a real SQLite file', async (context) => {
  const { root, path, database } = await temporaryDatabase(context, 'yuanpu-task-014-identities-');
  const effectsPath = join(root, 'effects.jsonl');
  const starts = [];
  const gates = new Map();
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    maximumConcurrentRuns: 2,
    executor: {
      async execute(input) {
        starts.push({
          runId: input.run.runId,
          subjectId: input.run.owner.identity.subjectId,
          piSessionId: input.piSessionId,
        });
        await appendFile(effectsPath, `${JSON.stringify(starts.at(-1))}\n`);
        const gate = deferred();
        gates.set(input.run.runId, gate);
        await gate.promise;
        return {
          kind: 'completed',
          output: { message: `result-${input.run.owner.identity.subjectId}`, tools: [] },
        };
      },
    },
  });
  const callerA = caller('identity-a', '/workspace/a');
  const callerB = caller('identity-b', '/workspace/b');
  const [runA, runB] = await Promise.all([
    service.submit(callerA, request('identity-a', '/workspace/a')),
    service.submit(callerB, request('identity-b', '/workspace/b')),
  ]);
  const duplicateA = await service.submit(callerA, request('identity-a', '/workspace/a'));
  assert.equal(duplicateA.duplicate, true);
  assert.equal(duplicateA.runId, runA.runId);
  await waitUntil(() => gates.size === 2);
  assert.deepEqual(starts.map((entry) => entry.subjectId).sort(), ['identity-a', 'identity-b']);
  assert.notEqual(starts[0].piSessionId, starts[1].piSessionId);
  assert.equal(await service.get(callerA, runB.runId), undefined);
  assert.equal(await service.get(callerB, runA.runId), undefined);
  assert.deepEqual(await service.cancel(callerA, runB.runId), {
    runId: runB.runId,
    result: 'not_found',
  });
  gates.get(runA.runId).resolve();
  gates.get(runB.runId).resolve();
  await service.waitForIdle();
  assert.equal((await service.get(callerA, runA.runId)).output.message, 'result-identity-a');
  assert.equal((await service.get(callerB, runB.runId)).output.message, 'result-identity-b');
  await service.close();
  database.close();

  const effects = (await readFile(effectsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(effects.length, 2);
  const inspection = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(inspection.prepare(`
    SELECT subject_id, status FROM yp_agent_runs ORDER BY subject_id
  `).all().map((row) => ({ ...row })), [
    { subject_id: 'identity-a', status: 'succeeded' },
    { subject_id: 'identity-b', status: 'succeeded' },
  ]);
  const bindings = inspection.prepare(`
    SELECT subject_id, pi_session_id FROM yp_conversation_bindings ORDER BY subject_id
  `).all();
  assert.equal(bindings.length, 2);
  assert.notEqual(bindings[0].pi_session_id, bindings[1].pi_session_id);
  inspection.close();
});

test('TASK-014 duplicate admission and queued cancellation produce no duplicate controlled effect', async (context) => {
  const { root, path, database } = await temporaryDatabase(context, 'yuanpu-task-014-dedup-');
  const effectsPath = join(root, 'effects.jsonl');
  const gate = deferred();
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    maximumConcurrentRuns: 1,
    executor: {
      async execute(input) {
        await appendFile(effectsPath, `${input.run.runId}\n`);
        await gate.promise;
        return { kind: 'completed', output: { message: 'done', tools: [] } };
      },
    },
  });
  const owner = caller('identity-a', '/workspace/a');
  const firstRequest = request('identity-a', '/workspace/a', { idempotencyKey: 'first' });
  const queuedRequest = request('identity-a', '/workspace/a', {
    conversationId: 'queued-conversation',
    idempotencyKey: 'queued',
  });
  const first = await service.submit(owner, firstRequest);
  const duplicate = await service.submit(owner, firstRequest);
  const queued = await service.submit(owner, queuedRequest);
  assert.equal(duplicate.runId, first.runId);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(await service.cancel(owner, queued.runId), {
    runId: queued.runId,
    result: 'cancelled',
    status: 'cancelled',
  });
  gate.resolve();
  await service.waitForIdle();
  await service.close();
  database.close();

  assert.deepEqual((await readFile(effectsPath, 'utf8')).trim().split('\n'), [first.runId]);
  const inspection = new DatabaseSync(path, { readOnly: true });
  assert.equal(inspection.prepare('SELECT status FROM yp_agent_runs WHERE run_id = ?').get(queued.runId).status, 'cancelled');
  assert.equal(inspection.prepare('SELECT COUNT(*) AS count FROM yp_agent_run_queue_payloads').get().count, 0);
  inspection.close();
});

test('TASK-014 running cancellation persists the non-reversal boundary', async (context) => {
  const { path, database } = await temporaryDatabase(context, 'yuanpu-task-014-cancel-');
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
  const owner = caller('identity-a', '/workspace/a');
  const submission = await service.submit(owner, request('identity-a', '/workspace/a'));
  await started.promise;
  const receipt = await service.cancel(owner, submission.runId);
  assert.equal(receipt.result, 'cancellation_requested');
  await service.waitForIdle();
  const run = await service.get(owner, submission.runId);
  assert.equal(run.status, 'cancelled');
  assert.match(run.failure.message, /side effects were not reversed/);
  await service.close();
  database.close();

  const inspection = new DatabaseSync(path, { readOnly: true });
  const persisted = inspection.prepare(`
    SELECT status, external_effect_state, failure_message FROM yp_agent_runs WHERE run_id = ?
  `).get(submission.runId);
  assert.equal(persisted.status, 'cancelled');
  assert.equal(persisted.external_effect_state, 'possible');
  assert.match(persisted.failure_message, /side effects were not reversed/);
  inspection.close();
});

test('TASK-014 restart invalidates waiting approval and never replays the uncertain run', async (context) => {
  const { root, path, database } = await temporaryDatabase(context, 'yuanpu-task-014-approval-');
  const approvalPath = join(root, 'approvals.json');
  const approvals = await CapabilityApprovalStore.open(approvalPath, {
    createId: () => 'task-014-approval',
  });
  const authorizationBase = {
    sessionId: '',
    workspaceId: '/workspace/a',
    sourceInstanceId: 'task-014-source',
    packageVersion: '1.0.0',
    capabilityId: 'task-014-capability',
    arguments: { target: 'fixture' },
  };
  let capturedAuthorization;
  const service = await PersistentAgentService.open({
    store: database.agentRuns,
    approvals,
    executor: {
      async execute(input) {
        capturedAuthorization = {
          ...authorizationBase,
          runId: input.run.runId,
          sessionId: input.piSessionId,
        };
        const pending = await approvals.authorize(capturedAuthorization);
        assert.equal(pending.status, 'pending');
        const record = approvals.get(pending.requestId);
        return {
          kind: 'waiting_approval',
          approval: {
            runId: input.run.runId,
            approvalRequestId: pending.requestId,
            sessionId: input.piSessionId,
            workspaceId: input.run.context.workspaceId,
            expiresAt: record.expiresAt,
          },
          output: { message: 'approval required', tools: [] },
        };
      },
    },
  });
  const owner = caller('identity-a', '/workspace/a');
  const submission = await service.submit(owner, request('identity-a', '/workspace/a'));
  await waitUntil(async () => (await service.get(owner, submission.runId)).status === 'waiting_approval');
  const wrongRun = await approvals.authorize({
    ...capturedAuthorization,
    runId: 'other-run',
    approvalRequestId: 'task-014-approval',
  });
  assert.equal(wrongRun.status, 'invalid');
  assert.match(wrongRun.message, /binding does not match/);

  await service.close();
  assert.equal((await service.get(owner, submission.runId)).status, 'result_unknown');
  database.close();

  const reopenedApprovals = await CapabilityApprovalStore.open(approvalPath);
  assert.equal(reopenedApprovals.get('task-014-approval').status, 'cancelled');
  const replay = await reopenedApprovals.authorize({
    ...capturedAuthorization,
    approvalRequestId: 'task-014-approval',
  });
  assert.equal(replay.status, 'invalid');
  assert.match(replay.message, /cancelled/);

  const reopenedDatabase = openYuanpuMetadataDatabase(path);
  let restartedExecutions = 0;
  const restarted = await PersistentAgentService.open({
    store: reopenedDatabase.agentRuns,
    approvals: reopenedApprovals,
    executor: {
      async execute() {
        restartedExecutions += 1;
        return { kind: 'completed', output: { message: 'must not run', tools: [] } };
      },
    },
  });
  await restarted.waitForIdle();
  assert.equal(restartedExecutions, 0);
  assert.equal((await restarted.get(owner, submission.runId)).status, 'result_unknown');
  await restarted.close();
  reopenedDatabase.close();
});
