import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { register } from 'tsx/esm/api';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { openYuanpuMetadataDatabase, readYuanpuSavedToolResults } from '@yuanpu-agent/runtime-kit';

register();
const { RuntimeAssistantSourceHost } = await import('../src/assistant-source-host.ts');
const person = { kind: 'personal', id: 'local-user' };

test('host rechecks saved Work tool and artifact refs, and emits explicit deletion separately', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-work-evidence-host-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const sessions = join(root, 'sessions');
  await mkdir(workspace);
  await writeFile(join(workspace, 'report.md'), '# verified report\n');
  const metadata = openYuanpuMetadataDatabase(join(root, 'automation.sqlite'));
  context.after(() => metadata.close());
  const conversation = metadata.workConversations.create(workspace, workspace);
  const piSessionId = metadata.workConversations.sessionId(workspace, conversation.id);
  const pi = SessionManager.create(workspace, sessions, { id: piSessionId });
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  pi.appendMessage({ role: 'user', content: 'make report', timestamp: Date.now() });
  pi.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'write',
    arguments: { path: 'report.md', content: '# verified report\n' } }],
  api: 'anthropic-messages', provider: 'anthropic', model: 'fixture', stopReason: 'toolUse',
  usage, timestamp: Date.now() });
  pi.appendMessage({ role: 'toolResult', toolCallId: 'call-1', toolName: 'write',
    content: [{ type: 'text', text: 'File saved.' }], isError: false, timestamp: Date.now() });
  pi.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Done.' }],
    api: 'anthropic-messages', provider: 'anthropic', model: 'fixture', stopReason: 'stop',
    usage, timestamp: Date.now() });
  const saved = readYuanpuSavedToolResults(workspace, piSessionId, sessions);
  assert.equal(saved.length, 1);
  const fixture = new DatabaseSync(join(root, 'automation.sqlite'));
  const binding = fixture.prepare('SELECT binding_id FROM yp_conversation_bindings WHERE conversation_id=?')
    .get(conversation.id).binding_id;
  fixture.prepare(`INSERT INTO yp_agent_runs
    (run_id,entry_point,authority_id,subject_id,idempotency_key,request_fingerprint,
     input_digest,request_metadata_json,binding_id,status,created_at,updated_at)
    VALUES ('run-1','desktop','local-desktop','local-user','request-1',?,?,'{}',?,'succeeded',?,?)`)
    .run('a'.repeat(64), 'b'.repeat(64), binding, '2026-09-27T00:00:00Z', '2026-09-27T00:00:01Z');
  fixture.prepare('INSERT INTO yp_agent_run_outputs(run_id,output_json,created_at) VALUES (?,?,?)')
    .run('run-1', JSON.stringify({ message: 'Done', tools: [], toolResults: saved,
      artifacts: [{ entryId: saved[0].entryId, toolCallId: saved[0].toolCallId, relativePath: 'report.md',
        sha256: createHash('sha256').update('# verified report\n').digest('hex'),
        size: 18, text: '# verified report\n' }] }),
      '2026-09-27T00:00:01Z');
  fixture.close();
  metadata.workEvidence.recordToolResults(conversation.id, piSessionId, saved);
  metadata.workEvidence.recordArtifacts(conversation.id, piSessionId);
  const host = new RuntimeAssistantSourceHost(metadata.workConversations, metadata.assistantHost,
    metadata.assistantSourceLifecycle, undefined, metadata.workEvidence, sessions);
  const page = await host.listChanges('work-evidence', '0', 10);
  assert.equal(page.events.length, 2);
  const tool = page.events.find((entry) => entry.change.sourceId.startsWith('work-tool:')).change;
  const artifact = page.events.find((entry) => entry.change.sourceId.startsWith('work-artifact:')).change;
  assert.match((await host.readSource(tool.contentRef, tool.sourceId, tool.sourceVersion, person, 1_000)).text,
    /File saved/);
  assert.match((await host.readSource(artifact.contentRef, artifact.sourceId,
    artifact.sourceVersion, person, 1_000)).text, /verified report/);
  await assert.rejects(host.readSource(tool.contentRef, tool.sourceId, tool.sourceVersion,
    { kind: 'personal', id: 'other' }, 1_000), /not authorized/);
  assert.equal((await host.readSource('unknown', tool.sourceId, tool.sourceVersion, person, 1_000)).status,
    'temporarily_unavailable');
  await writeFile(join(workspace, 'report.md'), '# changed\n');
  assert.match((await host.readSource(artifact.contentRef, artifact.sourceId, artifact.sourceVersion,
    person, 1_000)).text, /verified report/);
  await rm(join(workspace, 'report.md'));
  await symlink(join(root, 'automation.sqlite'), join(workspace, 'report.md'));
  assert.match((await host.readSource(artifact.contentRef, artifact.sourceId, artifact.sourceVersion,
    person, 1_000)).text, /verified report/);
  host.markDeleted('work', tool.sourceId);
  assert.equal((await host.currentSource(tool.sourceId, person)).status, 'deleted');
  const deleted = await host.listChanges('work-deletions', '0', 10);
  assert.equal(deleted.events.length, 1);
  assert.equal(deleted.events[0].change.sourceId, tool.sourceId);
});
