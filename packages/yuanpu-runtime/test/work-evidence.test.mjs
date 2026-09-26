import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';

import { openYuanpuMetadataDatabase, readYuanpuChatTranscript,
  readYuanpuSavedToolResults } from '../dist/index.mjs';

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test('saved Pi tool result and settled write payload become distinct stable Work sources', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-work-evidence-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const sessions = join(root, 'sessions');
  await mkdir(workspace);
  const databasePath = join(root, 'automation.sqlite');
  const metadata = openYuanpuMetadataDatabase(databasePath);
  const conversation = metadata.workConversations.create(workspace, workspace);
  const piSessionId = metadata.workConversations.sessionId(workspace, conversation.id);
  const pi = SessionManager.create(workspace, sessions, { id: piSessionId });
  pi.appendMessage({ role: 'user', content: 'make note', timestamp: Date.now() });
  pi.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'write-1', name: 'write',
    arguments: { path: 'note.md', content: 'verified note' } }],
  api: 'anthropic-messages', provider: 'anthropic', model: 'fixture', stopReason: 'toolUse',
  usage, timestamp: Date.now() });
  pi.appendMessage({ role: 'toolResult', toolCallId: 'write-1', toolName: 'write',
    content: [{ type: 'text', text: 'Successfully wrote note.md' }], isError: false,
    timestamp: Date.now() });
  pi.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Done.' }],
    api: 'anthropic-messages', provider: 'anthropic', model: 'fixture', stopReason: 'stop',
    usage, timestamp: Date.now() });
  const saved = readYuanpuSavedToolResults(workspace, piSessionId, sessions);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, 'write');
  assert.equal(saved[0].text, 'Successfully wrote note.md');
  assert.equal(metadata.workEvidence.recordToolResults(conversation.id, piSessionId, saved), 1);
  assert.equal(metadata.workEvidence.recordUnverifiedArtifacts(conversation.id, piSessionId, saved), 1);
  const earlyPage = metadata.workEvidence.sourcePage(0, 10);
  assert.equal(earlyPage.length, 2);

  const fixture = new DatabaseSync(databasePath);
  const binding = fixture.prepare('SELECT binding_id FROM yp_conversation_bindings WHERE conversation_id=?')
    .get(conversation.id).binding_id;
  fixture.prepare(`INSERT INTO yp_agent_runs
    (run_id,entry_point,authority_id,subject_id,idempotency_key,request_fingerprint,
     input_digest,request_metadata_json,binding_id,status,created_at,updated_at)
    VALUES ('run-note','desktop','local-desktop','local-user','request-note',?,?,'{}',?,'succeeded',?,?)`)
    .run('a'.repeat(64), createHash('sha256').update('make note').digest('hex'), binding,
      '2026-09-27T00:00:00Z', '2026-09-27T00:00:01Z');
  fixture.prepare('INSERT INTO yp_agent_run_outputs(run_id,output_json,created_at) VALUES (?,?,?)')
    .run('run-note', JSON.stringify({ message: 'Done.', tools: [{ name: 'write', status: 'completed' }],
      toolResults: [{ ...saved[0] }], artifacts: [{ entryId: saved[0].entryId,
        toolCallId: saved[0].toolCallId,
        relativePath: 'note.md', sha256: createHash('sha256').update('verified note').digest('hex'),
        size: 13, text: 'verified note' }] }), '2026-09-27T00:00:01Z');
  fixture.close();

  assert.equal(metadata.workEvidence.recordToolResults(conversation.id, piSessionId, saved), 1);
  assert.equal(metadata.workEvidence.recordArtifacts(conversation.id, piSessionId), 1);
  assert.equal(metadata.workEvidence.recordUnverifiedArtifacts(conversation.id, piSessionId, saved), 0);
  const page = metadata.workEvidence.sourcePage(0, 10);
  assert.equal(page.length, 2);
  assert.equal(metadata.workEvidence.sourcePage(earlyPage.at(-1).eventId, 10).length, 2);
  assert.equal(page.every((item) => item.change.workId === conversation.id), true);
  const tool = metadata.workEvidence.sourceById(`work-tool:${piSessionId}:${saved[0].entryId}`);
  const artifact = metadata.workEvidence.sourceById(`work-artifact:${piSessionId}:${saved[0].entryId}`);
  assert.equal(tool.runId, 'run-note');
  assert.equal(tool.text, 'Successfully wrote note.md');
  assert.equal(artifact.runId, 'run-note');
  assert.equal(artifact.relativePath, 'note.md');
  assert.equal(metadata.workEvidence.workspaceForSource(tool), workspace);
  assert.equal(metadata.workEvidence.recordToolResults(conversation.id, piSessionId, saved), 0);
  assert.equal(metadata.workEvidence.recordArtifacts(conversation.id, piSessionId), 0);
  metadata.close();

  const reopened = openYuanpuMetadataDatabase(databasePath);
  assert.deepEqual(reopened.workEvidence.sourcePage(0, 10), page);
  assert.equal(reopened.workEvidence.recordToolResults(conversation.id, piSessionId, saved), 0);
  reopened.close();
});

test('historical file result without a verified descriptor stays unavailable across scans and restart', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-work-evidence-legacy-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const sessions = join(root, 'sessions');
  await mkdir(workspace);
  const databasePath = join(root, 'automation.sqlite');
  const metadata = openYuanpuMetadataDatabase(databasePath);
  const conversation = metadata.workConversations.create(workspace, workspace);
  const piSessionId = metadata.workConversations.sessionId(workspace, conversation.id);
  const pi = SessionManager.create(workspace, sessions, { id: piSessionId });
  pi.appendMessage({ role: 'user', content: 'make note', timestamp: Date.now() });
  pi.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'legacy-write', name: 'write',
    arguments: { path: 'private/unknown.txt', content: 'historical content' } }],
  api: 'anthropic-messages', provider: 'anthropic', model: 'fixture', stopReason: 'toolUse',
  usage, timestamp: Date.now() });
  pi.appendMessage({ role: 'toolResult', toolCallId: 'legacy-write', toolName: 'write',
    content: [{ type: 'text', text: 'Saved.' }], isError: false, timestamp: Date.now() });
  const saved = readYuanpuSavedToolResults(workspace, piSessionId, sessions);
  assert.equal(saved.length, 1);
  assert.equal(metadata.workEvidence.recordToolResults(conversation.id, piSessionId, saved), 1);
  assert.equal(metadata.workEvidence.recordUnverifiedArtifacts(conversation.id, piSessionId, saved), 1);
  const artifactId = `work-artifact:${piSessionId}:${saved[0].entryId}`;
  const artifact = metadata.workEvidence.sourceById(artifactId);
  assert.match(artifact.sourceVersion, /^unavailable:/);
  assert.equal(artifact.relativePath, undefined);
  assert.equal(artifact.fileSha256, undefined);
  assert.equal(artifact.runId, undefined);
  assert.equal(metadata.workEvidence.recordUnverifiedArtifacts(conversation.id, piSessionId, saved), 0);
  metadata.close();

  const reopened = openYuanpuMetadataDatabase(databasePath);
  assert.equal(reopened.workEvidence.sourceById(artifactId).sourceVersion, artifact.sourceVersion);
  assert.equal(reopened.workEvidence.sourcePage(0, 10).length, 2);
  reopened.close();
});

test('legacy Pi backfill skips a symlinked session file', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-work-evidence-symlink-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const sessions = join(root, 'sessions');
  await mkdir(workspace);
  const pi = SessionManager.create(workspace, sessions, { id: 'legacy-safe-session' });
  pi.appendMessage({ role: 'user', content: 'private message', timestamp: Date.now() });
  pi.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'private reply' }],
    api: 'anthropic-messages', provider: 'anthropic', model: 'fixture', stopReason: 'stop',
    usage, timestamp: Date.now() });
  const original = pi.getSessionFile();
  const outside = join(root, 'outside.jsonl');
  await rename(original, outside);
  await symlink(outside, original);
  assert.deepEqual(readYuanpuSavedToolResults(workspace, 'legacy-safe-session', sessions), []);
  assert.deepEqual(readYuanpuChatTranscript(workspace, 'legacy-safe-session', sessions), []);
});

test('legacy Pi backfill requires a matching assistant tool call before accepting a result', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-work-evidence-pairing-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const sessions = join(root, 'sessions');
  await mkdir(workspace);
  const pi = SessionManager.create(workspace, sessions, { id: 'legacy-pairing-session' });
  pi.appendMessage({ role: 'user', content: 'prepare notes', timestamp: Date.now() });
  pi.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'paired-call', name: 'write',
    arguments: { path: 'note.md', content: 'verified' } }],
  api: 'anthropic-messages', provider: 'anthropic', model: 'fixture', stopReason: 'toolUse',
  usage, timestamp: Date.now() });
  pi.appendMessage({ role: 'toolResult', toolCallId: 'orphan-call', toolName: 'write',
    content: [{ type: 'text', text: 'fabricated orphan' }], isError: false, timestamp: Date.now() });
  pi.appendMessage({ role: 'toolResult', toolCallId: 'paired-call', toolName: 'edit',
    content: [{ type: 'text', text: 'wrong tool name' }], isError: false, timestamp: Date.now() });
  pi.appendMessage({ role: 'toolResult', toolCallId: 'paired-call', toolName: 'write',
    content: [{ type: 'text', text: 'verified result' }], isError: false, timestamp: Date.now() });
  assert.deepEqual(readYuanpuSavedToolResults(workspace, 'legacy-pairing-session', sessions)
    .map((item) => item.text), ['verified result']);
});
