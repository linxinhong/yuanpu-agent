import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { AssistantDelegationService } = require('../dist/index.cjs');

const brief = (taskId) => ({ taskId, assistantSessionId: 'assistant_session', skillName: 'reviewer',
  goal: 'Check the bounded artifact.', completionCriteria: ['Return cited evidence.'],
  contextRefs: ['source:one'], authorizedCapabilities: [], readOnly: true,
  deadlineAt: new Date(Date.now() + 60_000).toISOString() });

async function eventually(check) {
  const until = Date.now() + 3_000;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out awaiting delegation state.');
}

test('durable task ID deduplicates concurrent submissions and preserves one follow-up session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-delegation-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const adapter = {
    async run(input, followUp) {
      calls.push({ taskId: input.taskId, followUp, contextRefs: input.contextRefs });
      return { status: 'completed', summary: followUp ? 'corrected' : 'checked',
        resultRef: `result:${input.taskId}`, evidenceRefs: ['source:one'] };
    },
    async query() { throw new Error('Completed task should not be queried again.'); },
    async cancel() {}, async close() {},
  };
  const service = new AssistantDelegationService(root, adapter);
  await service.open();
  const firstBrief = brief('task_one');
  const [first, duplicate] = await Promise.all([service.start(firstBrief), service.start(firstBrief)]);
  assert.equal(first.taskId, duplicate.taskId);
  await assert.rejects(service.start({ ...firstBrief, assistantSessionId: 'other_session' }), /scope conflict/);
  await assert.rejects(service.start({ ...firstBrief, contextRefs: ['source:other'] }), /scope conflict/);
  await eventually(async () => (await service.status('task_one'))?.status === 'completed');
  assert.equal(calls.length, 1);
  await assert.rejects(service.followUp('task_one', 'other_session', 'correct it'), /Unknown delegation/);
  await service.followUp('task_one', 'assistant_session', 'correct it');
  await eventually(async () => (await service.status('task_one'))?.status === 'completed' && calls.length === 2);
  assert.deepEqual(calls.map((call) => call.taskId), ['task_one', 'task_one']);
  assert.equal(calls[1].followUp, 'correct it');
  await service.start(brief('task_two'));
  await eventually(async () => (await service.status('task_two'))?.status === 'completed');
  assert.equal(calls[2].followUp, undefined);
  await service.close();
});

test('restart marks accepted task unknown and queries original adapter without replay', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-delegation-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const existingBrief = brief('task_existing');
  const old = { ...existingBrief, status: 'running', followUps: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await writeFile(join(root, 'task_existing.json'), JSON.stringify(old));
  let starts = 0;
  let queries = 0;
  const adapter = { async run() { starts++; throw new Error('must not replay'); },
    async query(taskId) { queries++; assert.equal(taskId, 'task_existing');
      return { status: 'completed', resultRef: 'result:existing', evidenceRefs: ['source:one'] }; },
    async cancel() {}, async close() {} };
  const service = new AssistantDelegationService(root, adapter);
  await service.open();
  assert.equal((await service.start(existingBrief)).status, 'unknown');
  const resolved = await service.status('task_existing');
  assert.equal(resolved.status, 'completed');
  assert.equal(resolved.result.resultRef, 'result:existing');
  assert.equal(starts, 0);
  assert.equal(queries, 1);
  await service.close();
});

test('approval waits and cannot be converted to a follow-up or repeated execution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-delegation-approval-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let runs = 0;
  const service = new AssistantDelegationService(root, {
    async run() { runs++; return { status: 'waiting_approval', approvalRequestId: 'approval_one' }; },
    async query() { return undefined; }, async cancel() {}, async close() {},
  });
  await service.open();
  const approvalBrief = brief('task_approval');
  await service.start(approvalBrief);
  await eventually(async () => (await service.status('task_approval'))?.status === 'waiting_approval');
  await assert.rejects(service.followUp('task_approval', 'assistant_session', 'repeat'), /not ready/);
  assert.equal((await service.start(approvalBrief)).status, 'waiting_approval');
  assert.equal(runs, 1);
  await assert.rejects(service.settleApproval('task_approval', 'wrong_approval',
    { status: 'completed', resultRef: 'result:one' }), /does not match/);
  const settled = await service.settleApproval('task_approval', 'approval_one',
    { status: 'completed', resultRef: 'result:approved', evidenceRefs: ['source:one'] });
  assert.equal(settled.status, 'completed');
  assert.equal(settled.taskId, approvalBrief.taskId);
  assert.equal(runs, 1);
  await service.close();
});

test('execution task waits durably for an exact grant before one same-ID run', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-delegation-task-grant-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runs = [];
  const adapter = { async run(input, followUp, _signal, grant) {
    runs.push([input.taskId, followUp, grant]);
    return { status: 'completed', resultRef: `result:${input.taskId}` };
  }, async query() { return undefined; }, async cancel() {}, async close() {} };
  const input = { ...brief('task_granted'), readOnly: false,
    authorizedCapabilities: ['fixture.inspect'] };
  const first = new AssistantDelegationService(root, adapter);
  await first.open();
  const waiting = await first.start(input);
  assert.equal(waiting.status, 'waiting_approval');
  assert.equal(runs.length, 0);
  const grant = waiting.result.approvalRequestId;
  assert.deepEqual((await first.pendingApprovals()).map((record) => record.taskId), ['task_granted']);
  await first.close();
  const resumed = new AssistantDelegationService(root, adapter);
  await resumed.open();
  assert.equal((await resumed.start(input)).result.approvalRequestId, grant);
  await assert.rejects(resumed.decideApproval('task_granted', 'wrong', 'approved'), /does not match/);
  assert.equal((await resumed.decideApproval('task_granted', grant, 'approved')).status, 'accepted');
  await eventually(async () => (await resumed.status('task_granted'))?.status === 'completed');
  assert.deepEqual(runs, [['task_granted', undefined, grant]]);
  assert.equal((await resumed.pendingApprovals()).length, 0);
  await assert.rejects(resumed.decideApproval('task_granted', grant, 'approved'), /does not match/);
  await resumed.followUp('task_granted', 'assistant_session', 'check again');
  const followApproval = (await resumed.status('task_granted')).result.approvalRequestId;
  assert.notEqual(followApproval, grant);
  assert.equal(runs.length, 1);
  await resumed.decideApproval('task_granted', followApproval, 'denied');
  assert.equal((await resumed.status('task_granted')).result.errorCode, 'user_denied');
  assert.equal(runs.length, 1);
  await resumed.close();
});

test('restart never replays an unsettled approved external effect', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-delegation-effect-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = { ...brief('task_effect'), readOnly: false,
    authorizedCapabilities: ['fixture.effect'] };
  await writeFile(join(root, 'task_effect.json'), JSON.stringify({ ...input,
    status: 'waiting_approval', approvedGrantId: 'task-grant',
    result: { status: 'waiting_approval', approvalRequestId: 'effect-grant' },
    followUps: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  let runs = 0;
  const service = new AssistantDelegationService(root, { async run() { runs++; throw new Error('replayed'); },
    async query() { return undefined; }, async cancel() {}, async close() {} });
  await service.open();
  await service.reconcileEffectApprovals((id) => id === 'effect-grant' ? 'cancelled' : undefined);
  const record = await service.status('task_effect');
  assert.equal(record.status, 'unknown');
  assert.equal(record.result.errorCode, 'external_effect_unresolved_after_restart');
  assert.equal(runs, 0);
  await service.close();
});

test('delegation ledger refuses a symlinked root before writing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-delegation-symlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actual = join(root, 'actual');
  await mkdir(actual);
  await symlink(actual, join(root, 'linked'));
  const service = new AssistantDelegationService(join(root, 'linked', 'ledger'), {
    async run() { throw new Error('must not run'); }, async query() { return undefined; },
    async cancel() {}, async close() {},
  });
  await assert.rejects(service.open(), /Symlinked delegation path/);
});

test('deadline leaves an uncertain task under its original ID and requests cancellation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-delegation-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let runs = 0;
  let cancels = 0;
  const service = new AssistantDelegationService(root, {
    async run() { runs++; return new Promise(() => undefined); },
    async query() { return undefined; },
    async cancel() { cancels++; },
    async close() {},
  });
  await service.open();
  const input = { ...brief('task_timeout'), deadlineAt: new Date(Date.now() + 300).toISOString() };
  await service.start(input);
  await eventually(async () => (await service.status(input.taskId))?.status === 'unknown');
  assert.equal(runs, 1);
  assert.equal(cancels, 1);
  assert.equal((await service.start(input)).taskId, input.taskId);
  assert.equal(runs, 1);
  await service.close();
});

test('service shutdown aborts an adapter-owned child process', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-delegation-child-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let child;
  const stopChild = () => { if (child && child.exitCode === null) child.kill('SIGTERM'); };
  const service = new AssistantDelegationService(root, {
    async run(_brief, _followUp, signal) {
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      signal.addEventListener('abort', stopChild, { once: true });
      return new Promise((resolve) => child.once('exit', () => resolve({ status: 'unknown' })));
    },
    async query() { return undefined; },
    async cancel() { stopChild(); },
    async close() { stopChild(); },
  });
  await service.open();
  await service.start(brief('task_child'));
  await eventually(() => child?.pid);
  const pid = child.pid;
  await service.close();
  await eventually(() => child.exitCode !== null || child.signalCode !== null);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
