import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GoalManager } from '../dist/index.mjs';

test('ordered goal requires evidence and independent audit; progress survives reload', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-goal-')); t.after(() => rm(root, { recursive: true, force: true }));
  let approved = false;
  const manager = new GoalManager(join(root, 'goal.json'), async () => ({ approved, feedback: approved ? 'Verified' : 'Missing test' }));
  await manager.load();
  await manager.act({ action: 'create', objective: 'Deliver change', ordered: true, tasks: ['Implement', 'Verify'] });
  assert.equal(await manager.continuation(), undefined);
  await manager.act({ action: 'activate' });
  await assert.rejects(manager.act({ action: 'task', taskId: '2', taskStatus: 'completed', evidence: 'test' }), /earlier/);
  await assert.rejects(manager.act({ action: 'task', taskId: '1', taskStatus: 'completed' }), /evidence/);
  await manager.act({ action: 'task', taskId: '1', taskStatus: 'completed', evidence: 'source file' });
  await manager.act({ action: 'task', taskId: '2', taskStatus: 'completed', evidence: 'passing test' });
  await manager.act({ action: 'complete', evidence: 'all done' });
  assert.equal(manager.focused().status, 'active');
  assert.equal(manager.focused().feedback, 'Missing test');
  const loaded = new GoalManager(join(root, 'goal.json'), async () => ({ approved: true, feedback: 'Verified' }));
  await loaded.load();
  assert.equal(loaded.focused().status, 'paused');
  assert.equal(loaded.focused().tasks[1].status, 'completed');
  await loaded.act({ action: 'resume' });
  await loaded.act({ action: 'complete', evidence: 'verified after restart' });
  assert.equal(loaded.focused().status, 'completed');
});
test('autonomous continuation is bounded and requires explicit resume after pause', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-goal-')); t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new GoalManager(join(root, 'goal.json'), async () => ({ approved: true, feedback: '' }));
  await manager.load();
  await manager.act({ action: 'create', objective: 'Limited work', maxContinuations: 1, audit: false });
  await manager.act({ action: 'activate' });
  assert.match(await manager.continuation(), /Limited work/);
  assert.equal(await manager.continuation(), undefined);
  assert.equal(manager.focused().status, 'paused');
  await manager.act({ action: 'resume' });
  assert.match(await manager.continuation(), /Limited work/);
});

test('chat actually continues an active goal and stops after completion', async (t) => {
  const { createServer } = await import('node:http');
  const { mkdir, writeFile, readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { createYuanpuChatSession } = await import('../dist/index.mjs');
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-goal-sdk-'));
  const agentDir = join(root, 'agent'); await mkdir(agentDir);
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { /* drain */ }
    const index = ++calls;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'goal-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const input = index === 1 ? { action: 'create', objective: 'Test automatic work', audit: false, maxContinuations: 1 } : index === 2 ? { action: 'activate' } : index === 4 ? { action: 'complete', evidence: 'Goal integration fixture completed.' } : undefined;
    if (input) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: `goal-${index}`, type: 'function', function: { name: 'goal', arguments: JSON.stringify(input) } }] }); send({}, 'tool_calls');
    } else { send({ role: 'assistant', content: index === 3 ? 'Working.' : 'Completed.' }); send({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } } }));
  const chat = await createYuanpuChatSession({ agentDir, modelConfigDir: root, cwd: root, provider: 'fixture', model: 'fixture', apiKey: 'fixture-only', capabilityClient: { async search() { return { matches: [] }; }, async execute() { throw new Error('not used'); } } });
  try {
    const result = await chat.prompt('Create and directly execute a test goal without auditor.');
    assert.match(result.message, /Completed/); assert.equal(calls, 5);
    const scope = createHash('sha256').update(JSON.stringify([root, chat.sessionId])).digest('hex');
    const state = JSON.parse(await readFile(join(root, 'workflows', 'agent-tools', scope, 'goals.json'), 'utf8'));
    assert.equal(state.goals[0].status, 'completed'); assert.equal(state.goals[0].continuations, 1);
  } finally { await chat.abort(); chat.dispose(); }
});
