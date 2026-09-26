import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { register } from 'tsx/esm/api';
import { PersistentAgentService, openYuanpuMetadataDatabase,
  readYuanpuChatTranscript, readYuanpuSavedToolResults } from '@yuanpu-agent/runtime-kit';
import { AGENT_CONTRACT_VERSION } from '@yuanpu-agent/protocol';

register();
const { RuntimeAgentExecutor } = await import('../src/agent-runtime.ts');
const { RuntimeAssistantSourceHost } = await import('../src/assistant-source-host.ts');
const require = createRequire(import.meta.url);
const { AssistantWorkerManager } = require('../dist/index.cjs');
const entry = resolve(import.meta.dirname, '../dist/index.cjs');

async function eventually(assertion) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    try { return await assertion(); }
    catch { await new Promise((resolveWait) => setTimeout(resolveWait, 80)); }
  }
  return assertion();
}

test('real Runtime/Pi Work file tool settles distinct turn, tool and verified artifact sources', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-work-evidence-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  const sessions = join(root, 'sessions');
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume local model prompt */ }
    calls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({
      id: `fixture-${calls}`, object: 'chat.completion.chunk', created: 0, model: 'fixture-model',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);
    if (calls === 1) {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-write-report', type: 'function',
        function: { name: 'write', arguments: JSON.stringify({ path: 'report.md', content: '# report\n' }) } }] });
      chunk({}, 'tool_calls');
    } else {
      chunk({ role: 'assistant', content: 'Report written.' });
      chunk({}, 'stop');
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions',
    models: [{ id: 'fixture-model', name: 'Fixture model', reasoning: false, input: ['text'],
      contextWindow: 128000, maxTokens: 1024 }],
  } } }));

  const metadata = openYuanpuMetadataDatabase(join(root, 'metadata.sqlite'));
  t.after(() => metadata.close());
  const conversation = metadata.workConversations.create(workspace, workspace);
  const piSessionId = metadata.workConversations.sessionId(workspace, conversation.id);
  const executor = new RuntimeAgentExecutor({ sessionsPath: sessions,
    getCapabilityClient: () => ({ async search() { return { matches: [] }; },
      async execute() { throw new Error('unexpected external capability'); } }),
    approvals: { get() { return undefined; } },
    chat: { agentDir, modelConfigDir: agentDir, cwd: workspace,
      provider: 'fixture', model: 'fixture-model', apiKey: 'fixture-only' },
  });
  const service = await PersistentAgentService.open({ store: metadata.agentRuns, executor });
  t.after(async () => { await service.close(); await executor.close(); });
  const identity = { kind: 'local_user', subjectId: 'local-user', authorityId: 'local-desktop',
    authenticatedBy: 'electron' };
  const caller = { entryPoint: 'desktop', identity,
    authorizeWorkspace: (path) => path === workspace,
    authorizeConversation: () => true, authorizeDelivery: () => true };
  const submitted = await service.submit(caller, { contractVersion: AGENT_CONTRACT_VERSION,
    entryPoint: 'desktop', identity, workspaceId: workspace,
    conversation: { namespace: 'desktop', conversationId: conversation.id },
    input: { type: 'text', text: 'Write the report.' }, idempotencyKey: 'write-report',
    delivery: { kind: 'desktop' } });
  assert.equal(submitted.accepted, true);
  await service.waitForIdle();
  const settled = await service.get(caller, submitted.runId);
  assert.equal(settled.status, 'succeeded');
  assert.equal(calls, 2);
  assert.equal(await readFile(join(workspace, 'report.md'), 'utf8'), '# report\n');
  assert.equal(settled.output.toolResults?.[0].name, 'write');
  assert.equal(settled.output.artifacts?.[0].relativePath, 'report.md');
  const transcript = readYuanpuChatTranscript(workspace, piSessionId, sessions, 100_000, true);
  assert.equal(metadata.workConversations.recordSavedTurns(conversation.id, transcript), 1);
  const results = readYuanpuSavedToolResults(workspace, piSessionId, sessions);
  assert.equal(metadata.workEvidence.recordToolResults(conversation.id, piSessionId, results), 1);
  assert.equal(metadata.workEvidence.recordArtifacts(conversation.id, piSessionId), 1);
  assert.equal(metadata.workEvidence.recordUnverifiedArtifacts(conversation.id, piSessionId, results), 0);
  const host = new RuntimeAssistantSourceHost(metadata.workConversations, metadata.assistantHost,
    metadata.assistantSourceLifecycle, undefined, metadata.workEvidence, sessions);
  const turn = (await host.listChanges('work', '0', 10)).events[0].change;
  const evidence = (await host.listChanges('work-evidence', '0', 10)).events.map((item) => item.change);
  assert.equal(evidence.length, 2);
  assert.equal(evidence.every((item) => item.workId === conversation.id), true);
  assert.equal(turn.workId, conversation.id);
  const artifact = evidence.find((item) => item.sourceId.startsWith('work-artifact:'));
  assert.match((await host.readSource(artifact.contentRef, artifact.sourceId, artifact.sourceVersion,
    { kind: 'personal', id: 'local-user' }, 1_000)).text, /# report/);
  assert.equal(metadata.workEvidence.recordToolResults(conversation.id, piSessionId, results), 0);
  assert.equal(metadata.workEvidence.recordArtifacts(conversation.id, piSessionId), 0);

  const assistantHome = join(root, 'assistant');
  const workerOptions = { home: assistantHome, model: { appPath: agentDir, agentPath: agentDir,
    provider: 'fixture', model: 'fixture-model' }, sources: host,
  command: { executable: process.execPath, args: [entry, '--assistant-worker'] } };
  const worker = new AssistantWorkerManager(workerOptions);
  t.after(() => worker.stop());
  await worker.start();
  const statePath = join(assistantHome, 'state.sqlite');
  await eventually(() => {
    const state = new DatabaseSync(statePath);
    try {
      assert.equal(state.prepare("SELECT COUNT(*) AS n FROM source_events WHERE status='processed'").get().n, 3);
      assert.equal(state.prepare("SELECT COUNT(*) AS n FROM automation_jobs WHERE kind='review-work'").get().n, 3);
      assert.equal(state.prepare("SELECT cursor FROM source_feeds WHERE feed_id='work-evidence'").get().cursor,
        String(metadata.workEvidence.sourcePage(0, 10).at(-1).eventId));
    } finally { state.close(); }
  });
  await worker.stop();
  const restarted = new AssistantWorkerManager(workerOptions);
  t.after(() => restarted.stop());
  await restarted.start();
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  await restarted.stop();
  const state = new DatabaseSync(statePath);
  try {
    assert.equal(state.prepare('SELECT COUNT(*) AS n FROM source_events').get().n, 3);
    assert.equal(state.prepare("SELECT COUNT(*) AS n FROM automation_jobs WHERE kind='review-work'").get().n, 3);
  } finally { state.close(); }

  host.markDeleted('work', artifact.sourceId);
  const afterDelete = new AssistantWorkerManager(workerOptions);
  t.after(() => afterDelete.stop());
  await afterDelete.start();
  await eventually(() => {
    const state = new DatabaseSync(statePath);
    try {
      assert.equal(state.prepare('SELECT availability FROM source_current WHERE source_id=?')
        .get(artifact.sourceId).availability, 'deleted');
      assert.equal(state.prepare('SELECT COUNT(*) AS n FROM source_text WHERE source_id=?')
        .get(artifact.sourceId).n, 0);
      assert.equal(state.prepare("SELECT COUNT(*) AS n FROM automation_jobs WHERE kind='maintain-memory' AND source_id=?")
        .get(artifact.sourceId).n, 1);
    } finally { state.close(); }
  });
  await afterDelete.stop();
});
