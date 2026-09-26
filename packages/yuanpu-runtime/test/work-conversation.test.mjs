import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';

import { openYuanpuMetadataDatabase, readYuanpuChatTranscript } from '../dist/index.mjs';

test('new Work sessions remain isolated and selected across restart while default is read only', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-work-conversations-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'automation.sqlite');
  const workspace = join(root, 'workspace');
  const sessions = join(root, 'sessions');
  await mkdir(workspace);
  const legacySession = SessionManager.create(workspace, sessions, { id: 'legacy-pi-session' });
  legacySession.appendMessage({ role: 'user', content: 'old Work question', timestamp: Date.now() });
  legacySession.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'old Work answer' }],
    api: 'anthropic-messages', provider: 'anthropic', model: 'fixture', stopReason: 'stop',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() });
  openYuanpuMetadataDatabase(path).close();
  const legacy = new DatabaseSync(path);
  legacy.prepare(`INSERT INTO yp_conversation_bindings
    (binding_id, entry_point, authority_id, subject_id, namespace, conversation_id,
      thread_id, pi_session_id, workspace_id, created_at, updated_at)
    VALUES ('legacy-binding', 'desktop', 'local-desktop', 'local-user', 'desktop', 'default',
      '', 'legacy-pi-session', ?, '2026-09-25T00:00:00Z', '2026-09-25T00:00:00Z')`).run(workspace);
  legacy.close();
  const database = openYuanpuMetadataDatabase(path);
  const first = database.workConversations.current(workspace);
  const second = database.workConversations.create(workspace);
  assert.notEqual(first.id, second.id);
  assert.notEqual(database.workConversations.sessionId(workspace, first.id),
    database.workConversations.sessionId(workspace, second.id));
  assert.equal(database.workConversations.current(workspace).id, second.id);
  assert.equal(database.workConversations.sessionId(workspace, 'default'), 'legacy-pi-session');
  assert.equal(database.workConversations.list(workspace).find((item) => item.id === 'default').archived, true);
  assert.throws(() => database.workConversations.select(workspace, 'default'), /Unknown Work conversation/);
  assert.throws(() => database.workConversations.select('/another/workspace', first.id), /Unknown Work conversation/);
  database.workConversations.select(workspace, first.id);
  database.close();

  const reopened = openYuanpuMetadataDatabase(path);
  assert.equal(reopened.workConversations.current(workspace).id, first.id);
  assert.deepEqual(reopened.workConversations.list(workspace).map((item) => item.id).sort(),
    [first.id, second.id, 'default'].sort());
  assert.deepEqual(readYuanpuChatTranscript(workspace, 'legacy-pi-session', sessions).map((item) => item.text),
    ['old Work question', 'old Work answer']);
  reopened.close();
});

test('only saved complete turns produce stable source events on repeated scans', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-work-source-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'automation.sqlite');
  const database = openYuanpuMetadataDatabase(path);
  const conversation = database.workConversations.current('/workspace');
  const fixture = new DatabaseSync(path);
  const binding = fixture.prepare('SELECT binding_id FROM yp_conversation_bindings WHERE conversation_id = ?')
    .get(conversation.id).binding_id;
  const addRun = (id, input, status, answer) => {
    fixture.prepare(`INSERT INTO yp_agent_runs
      (run_id, entry_point, authority_id, subject_id, idempotency_key, request_fingerprint,
       input_digest, request_metadata_json, binding_id, status, created_at, updated_at)
      VALUES (?, 'desktop', 'local-desktop', 'local-user', ?, ?, ?, '{}', ?, ?, ?, ?)`)
      .run(id, id, 'a'.repeat(64), createHash('sha256').update(input).digest('hex'), binding,
        status, '2026-09-26T01:00:00Z', '2026-09-26T01:01:00Z');
    fixture.prepare(`INSERT INTO yp_agent_run_outputs(run_id, output_json, created_at) VALUES (?, ?, ?)`)
      .run(id, JSON.stringify({ message: answer, tools: [] }), '2026-09-26T01:01:00Z');
  };
  addRun('run-one', 'first', 'running', 'answer');
  addRun('run-two', 'unfinished', 'failed', 'not saved');
  const messages = [
    { id: 'user-1', role: 'user', text: 'first', at: '2026-09-26T01:00:00Z' },
    { id: 'assistant-1', role: 'assistant', text: 'answer', at: '2026-09-26T01:01:00Z' },
    { id: 'user-2', role: 'user', text: 'unfinished', at: '2026-09-26T01:02:00Z' },
    { id: 'assistant-2', role: 'assistant', text: 'not saved', at: '2026-09-26T01:03:00Z' },
  ];
  assert.equal(database.workConversations.recordSavedTurns(conversation.id, messages), 0);
  fixture.prepare("UPDATE yp_agent_runs SET status = 'succeeded' WHERE run_id = 'run-one'").run();
  assert.equal(database.workConversations.recordSavedTurns(conversation.id, messages), 1);
  assert.equal(database.workConversations.recordSavedTurns(conversation.id, messages), 0);
  const sources = database.workConversations.sources(conversation.id);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].turnId, 'assistant-1');
  assert.equal(sources[0].runId, 'run-one');
  assert.equal(sources[0].userText, 'first');
  assert.equal(sources[0].assistantText, 'answer');
  const sourceChanges = database.workConversations.sourceChanges(conversation.id);
  assert.deepEqual(JSON.parse(JSON.stringify(sourceChanges)), sourceChanges);
  assert.deepEqual(sourceChanges[0].audience, { kind: 'personal', id: 'local-user' });
  assert.equal(sourceChanges[0].sourceId, sources[0].sourceId);
  assert.equal(database.workConversations.resolveContentRef(sourceChanges[0].contentRef).runId, 'run-one');
  fixture.close();
  database.close();

  const movedRoot = join(root, 'moved-home');
  await mkdir(movedRoot);
  const movedPath = join(movedRoot, 'automation.sqlite');
  await copyFile(path, movedPath);
  const reopened = openYuanpuMetadataDatabase(movedPath);
  assert.equal(reopened.workConversations.recordSavedTurns(conversation.id, messages), 0);
  assert.deepEqual(reopened.workConversations.sources(conversation.id), sources);
  assert.deepEqual(reopened.workConversations.sourceChanges(conversation.id), sourceChanges);
  reopened.close();
});
