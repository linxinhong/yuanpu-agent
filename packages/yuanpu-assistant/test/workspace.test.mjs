import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AssistantMemoryRepository, AssistantWorkReviewStore,
  AssistantWorkspaceService } from '../dist/index.mjs';

test('Assistant workspace exposes personal records and commits versioned correction and forget', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'assistant');
  const memory = await AssistantMemoryRepository.open(home);
  t.after(() => memory.close());
  const audience = { kind: 'personal', id: 'local-user' };
  await memory.commit({ id: 'user-goals', section: 'memories', kind: 'explicit', audience,
    context: 'User goals', verifiedAt: '2026-09-27T10:00:00.000Z', text: 'Old goal',
    evidence: [], dependsOn: [], manualAuthority: true, expectedVersion: 0,
    revisionId: 'goal-r1', reason: 'User said so' });
  await memory.commit({ id: 'org-note', section: 'memories', kind: 'explicit',
    audience: { kind: 'organization', id: 'other' }, context: 'Other scope',
    verifiedAt: '2026-09-27T10:00:00.000Z', text: 'Should stay private',
    evidence: [], dependsOn: [], manualAuthority: true, expectedVersion: 0,
    revisionId: 'org-r1', reason: 'Fixture' });
  memory.sources.database.prepare(`INSERT INTO source_events
    (feed_id,event_id,source_id,source_version,kind,audience_kind,audience_id,occurred_at,status)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('other', 'event-one', 'org-source', 'v1', 'created',
    'organization', 'other', '2026-09-27T10:00:00.000Z', 'processed');
  const reviews = new AssistantWorkReviewStore(memory.sources.database, memory.sources, home);
  const host = { async status() { return undefined; }, async followUp() { throw new Error('Unexpected'); },
    async cancel() { throw new Error('Unexpected'); } };
  const workspace = new AssistantWorkspaceService(home, memory, reviews, host);
  const until = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal(workspace.pauseOrganizing(until).organizingPausedUntil, until);
  assert.equal(workspace.isOrganizingPaused(), true);
  assert.equal((await workspace.snapshot()).organizingPausedUntil, until);
  workspace.pauseOrganizing();
  assert.equal(workspace.isOrganizingPaused(), false);
  const personalSnapshot = await workspace.snapshot();
  assert.deepEqual(personalSnapshot.memories.map((item) => item.id), ['user-goals']);
  assert.equal(personalSnapshot.sourceSync.processed, 0);
  assert.equal(personalSnapshot.sourceSync.lastObservedAt, undefined);
  await memory.commit({ id: 'older-note', section: 'memories', kind: 'explicit', audience,
    context: 'Another personal note', verifiedAt: '2026-09-27T10:00:00.000Z', text: 'Second note',
    evidence: [], dependsOn: [], manualAuthority: true, expectedVersion: 0,
    revisionId: 'older-r1', reason: 'Fixture' });
  const firstPage = await workspace.snapshot(1);
  assert.equal(firstPage.memories.length, 1);
  assert.equal(firstPage.hasMoreMemories, true);
  assert.equal((await workspace.snapshot(2)).memories.length, 2);
  await assert.rejects(workspace.snapshot(10_001), /Invalid memory page size/);
  await assert.rejects(workspace.correctMemory('org-note', 1, 'Leak', 'org-r2'));
  const corrected = await workspace.correctMemory('user-goals', 1, 'New goal', 'goal-r2');
  assert.equal(corrected.version, 2);
  assert.equal(corrected.text, 'New goal');
  assert.equal((await workspace.correctMemory('user-goals', 1, 'New goal', 'goal-r2')).version, 2,
    'a lost response may be retried with the same correction ID');
  await assert.rejects(workspace.correctMemory('user-goals', 1, 'Stale', 'goal-r3'), /version conflict/);
  assert.deepEqual((await workspace.forgetMemory('user-goals')).forgottenIds, ['user-goals']);
  assert.deepEqual((await workspace.forgetMemory('user-goals')).forgottenIds, ['user-goals'],
    'a lost forget response may be retried');
  assert.deepEqual((await workspace.snapshot()).memories.map((item) => item.id), ['older-note']);
  assert.equal(await memory.get('user-goals'), undefined);
});

test('delegation actions require an Assistant-owned archive and retain task identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-workspace-delegation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'assistant');
  const memory = await AssistantMemoryRepository.open(home);
  t.after(() => memory.close());
  const reviews = new AssistantWorkReviewStore(memory.sources.database, memory.sources, home);
  const calls = [];
  const record = { taskId: 'task-one', assistantSessionId: 'asst_one', status: 'completed',
    updatedAt: '2026-09-27T10:00:00.000Z' };
  const host = { async status(taskId) { calls.push(['status', taskId]); return record; },
    async followUp(...args) { calls.push(['followUp', ...args]); return record; },
    async cancel(...args) { calls.push(['cancel', ...args]); return record; } };
  const workspace = new AssistantWorkspaceService(home, memory, reviews, host);
  await assert.rejects(workspace.cancelDelegation('task-one'));
  await mkdir(join(home, 'delegations'));
  await writeFile(join(home, 'delegations', 'task-one.json'),
    JSON.stringify({ taskId: 'task-one', assistantSessionId: 'asst_one',
      verification: { checkedAt: '2026-09-27T11:00:00.000Z',
        evidenceByCriterion: { 'Cited result': ['result:one'] } } }));
  const snapshot = await workspace.snapshot();
  assert.deepEqual(snapshot.delegations, [record]);
  assert.deepEqual(snapshot.delegationVerifications['task-one'].evidenceByCriterion,
    { 'Cited result': ['result:one'] });
  await workspace.followUpDelegation('task-one', 'Check again');
  await workspace.cancelDelegation('task-one');
  assert.deepEqual(calls, [['status', 'task-one'],
    ['followUp', 'task-one', 'asst_one', 'Check again',
      calls[1][4]], ['cancel', 'task-one', 'asst_one']]);
  assert.match(calls[1][4], /^[a-f0-9]{64}$/);
  host.status = async () => { throw new Error('Host temporarily unavailable'); };
  const degraded = await workspace.snapshot();
  assert.equal(degraded.delegationsUnavailable, true);
  assert.deepEqual(degraded.delegations, []);
});
