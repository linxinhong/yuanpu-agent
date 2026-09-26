import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowManager, YuanpuSubagentManager } from '../dist/index.mjs';

async function setup(t, child = async ({ task }) => ({ text: `result:${task}`, usage: { totalTokens: 10, input: 7, output: 3, cost: 0.01 } })) {
  const directory = await mkdtemp(join(tmpdir(), 'yuanpu-workflow-'));
  const subagents = new YuanpuSubagentManager({ directory: join(directory, 'children'), tools: () => ['read'], prepareChild: () => child });
  const manager = new WorkflowManager({ directory: join(directory, 'runs'), cwd: directory, subagents, approveCheckpoint: async () => {} });
  t.after(async () => { await manager.dispose(); await subagents.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { manager, subagents, directory };
}
async function settled(manager, id) {
  for (let i = 0; i < 200; i++) {
    const run = await manager.status(id);
    if (run.status !== 'running') return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Test workflow did not settle.');
}
test('workflow code runs parallel agents, pipeline and phase with measured usage', async (t) => {
  const { manager } = await setup(t);
  const run = await manager.start({ background: false, args: ['a', 'b'], script: `await phase('inspect'); return await pipeline(args, item => agent(item, {agentType:'scout'}), item => agent(item, {agentType:'reviewer'}));` });
  assert.equal(run.status, 'completed', run.error);
  assert.deepEqual(JSON.parse(run.result), ['result:result:a', 'result:result:b']);
  assert.equal(run.reportedTokens, 40);
  assert.equal(run.phase, 'inspect');
});
test('checkpoint pauses safely and resume replays completed calls across manager reload', async (t) => {
  let calls = 0;
  const { manager, subagents, directory } = await setup(t, async ({ task }) => { calls++; return { text: task }; });
  const first = await manager.start({ background: false, script: `const a = await agent('first'); await checkpoint('Approve second phase?'); return await agent(a + ' second');` });
  assert.equal(first.status, 'paused', first.error);
  assert.equal(calls, 1);
  await assert.rejects(manager.resume(first.id), /confirmation/);
  const reloaded = new WorkflowManager({ directory: join(directory, 'runs'), cwd: directory, subagents, approveCheckpoint: async () => {} });
  try {
    await reloaded.confirm(first.id);
    const resumed = await reloaded.resume(first.id);
    const final = await settled(reloaded, resumed.id);
    assert.equal(final.status, 'completed', final.error);
    assert.equal(calls, 2);
    assert.equal(JSON.parse(final.result), 'first second');
  } finally {
    await reloaded.dispose();
  }
});
test('workflow timeout stops busy scripts and cancellation stops child agents', async (t) => {
  const { manager } = await setup(t, ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    if (signal.aborted) reject(signal.reason);
  }));
  const busy = await manager.start({ background: false, timeoutMs: 40, script: 'while (true) {}' });
  assert.equal(busy.status, 'failed'); assert.match(busy.error, /timed out/);
  const active = await manager.start({ script: "return await agent('wait');" });
  const stopped = await manager.control('stop', active.id);
  assert.equal(stopped.status, 'cancelled');
});
test('workflow fails closed on agent failures and budgets, and propagates approvals', async (t) => {
  const { manager } = await setup(t);
  const budget = await manager.start({ background: false, maxAgents: 1, script: "return await parallel([() => agent('a'), () => agent('b')]);" });
  assert.equal(budget.status, 'failed'); assert.match(budget.error, /budget/);
  const { manager: approvals } = await setup(t, async () => ({ text: '', pendingApprovalRequestId: 'host-approval' }));
  const run = await approvals.start({ background: false, script: "return await agent('protected');" });
  assert.equal(run.status, 'needs_approval');
  assert.equal(run.pendingApprovalRequestId, 'host-approval');
  await assert.rejects(manager.status('../other'), /Invalid/);
});

test('checkpoint uses host-issued approval, cannot be confirmed with an invented ID', async (t) => {
  const { CapabilityApprovalStore, createYuanpuMcpServer, createWorkflowCheckpointSource, createCapabilityId } = await import('../dist/index.mjs');
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-checkpoint-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = await CapabilityApprovalStore.open(join(root, 'approvals.json'));
  const server = createYuanpuMcpServer([createWorkflowCheckpointSource()], store);
  const input = { name: createCapabilityId('builtin.workflow-checkpoints', 'confirm_workflow_checkpoint'), arguments: { runId: '12345678-1234-1234-1234-123456789abc', checkpointId: '1', prompt: 'Continue?' } };
  const context = { sessionId: 's', workspaceId: 'w', runId: 'parent' };
  let id;
  await assert.rejects(server.execute(input, context), (error) => { id = error.failure.approvalRequestId; return error.failure.error === 'needs_approval'; });
  assert.ok(id);
  await assert.rejects(server.execute({ ...input, approvalRequestId: 'invented' }, context));
  await store.decide(id, 'approved');
  const result = await server.execute({ ...input, approvalRequestId: id }, context);
  assert.equal(JSON.parse(result.content[0].text).approved, true);
  await assert.rejects(server.execute({ ...input, approvalRequestId: id }, context));
});

test('workflow worktree isolates child writes and preserves the worktree result', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { writeFile, readFile, access } = await import('node:fs/promises');
  const exec = promisify(execFile);
  const { manager, directory } = await setup(t, async (input) => {
    assert.ok(input.cwd);
    await writeFile(join(input.cwd, 'child.txt'), 'child edit');
    return { text: 'done' };
  });
  await exec('git', ['init', '-q'], { cwd: directory });
  await writeFile(join(directory, 'initial.txt'), 'base');
  await exec('git', ['add', 'initial.txt'], { cwd: directory });
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture'], { cwd: directory });
  const run = await manager.start({ background: false, script: "return await agent('edit', {isolation:'worktree'});" });
  assert.equal(run.status, 'completed', run.error);
  assert.equal(run.worktrees.length, 1);
  assert.equal(await readFile(join(run.worktrees[0], 'child.txt'), 'utf8'), 'child edit');
  await assert.rejects(access(join(directory, 'child.txt')));
});
