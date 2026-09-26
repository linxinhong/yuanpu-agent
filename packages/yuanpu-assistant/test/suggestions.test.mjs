import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AssistantAutomationStore, AssistantMemoryRepository, AssistantSuggestionStore,
  parseSuggestionProposal } from '../dist/index.mjs';

const when = '2026-09-27T10:00:00.000Z';
const audience = { kind: 'personal', id: 'local-user' };

test('suggestions require current evidence and persist dedupe, feedback, pause and delivery separately', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-suggestion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'assistant');
  const memory = await AssistantMemoryRepository.open(home);
  const sourceId = 'work-turn:project:one';
  const host = {
    async listChanges(_feed, cursor) { return { events: cursor === '0' ? [{ eventId: '1',
      change: { sourceId, sourceVersion: 'v1', kind: 'created', audience,
        occurredAt: when, contentRef: 'opaque:one' } }] : [], nextCursor: '1' }; },
    async currentSource() { return { status: 'available', sourceVersion: 'v1' }; },
    async readSource() { return { status: 'available', sourceVersion: 'v1', text: 'User: Please verify the report.' }; },
  };
  await memory.sources.sync(host, 'work');
  await memory.processNext(host);
  const evidence = [{ sourceId, sourceVersion: 'v1', observedAt: when }];
  await memory.commit({ id: 'follow-up-aaaaaaaaaaaaaaaaaaaaaaaa', section: 'suggestions',
    kind: 'observed', audience, context: 'Report remains unverified', verifiedAt: when,
    text: '# Follow-up candidate\n\nReport still needs verification.', evidence,
    dependsOn: [], manualAuthority: false, expectedVersion: 0, revisionId: 'suggestion-candidate-r1',
    reason: 'Current work review' });
  let clock = when;
  let store = new AssistantSuggestionStore(memory, () => new Date(clock));
  const candidates = await store.candidates();
  assert.equal(candidates.length, 1);
  assert.deepEqual(parseSuggestionProposal(JSON.stringify({ suggestions: [{ candidateId: candidates[0].candidateId,
    reason: 'The report has not been verified.', nextStep: 'Open the report and check the totals.' }] }),
  candidates).length, 1);
  assert.throws(() => parseSuggestionProposal(JSON.stringify({ suggestions: [{ candidateId: 'unknown',
    reason: 'x', nextStep: 'y' }] }), candidates));
  assert.deepEqual(parseSuggestionProposal(JSON.stringify({ suggestions: [{ candidateId: candidates[0].candidateId,
    reason: 'Bearer abcdefghijklmnop', nextStep: 'Send this token.' }] }), candidates), [],
  'credential-like model output cannot be saved or sent');
  store.record(candidates, [{ candidateId: candidates[0].candidateId,
    reason: 'The report has not been verified.', nextStep: 'Open the report and check the totals.' }]);
  const automation = new AssistantAutomationStore(memory.sources.database);
  const daily = automation.scheduleActivePeriods()[0];
  store.recordReflectionAttempt(daily.effectId, candidates);
  automation.savePreparedProposal(daily, { costUsd: 0.01,
    value: { candidateKeys: candidates.map(({ candidateId, fingerprint }) => ({ candidateId, fingerprint })),
      parsed: [{ candidateId: candidates[0].candidateId,
        reason: 'Private report marker', nextStep: 'Review the report.' }] } });
  assert.deepEqual(await store.candidates(), [], 'the same evidence does not trigger another model turn');
  const suggestion = store.list()[0];
  assert.equal(suggestion.deliveryStatus, 'not_requested');
  assert.equal(suggestion.readAt, undefined);
  store.recordDelivery(suggestion.suggestionId, 'accepted', `assistant-proactive:${suggestion.suggestionId}`);
  assert.equal(store.get(suggestion.suggestionId).readAt, undefined,
    'transport acceptance is not a read receipt');
  store.feedback(suggestion.suggestionId, 'snoozed', '2026-10-10T10:00:00.000Z');
  store.pause('2026-09-28T10:00:00.000Z');
  memory.close();

  const reopened = await AssistantMemoryRepository.open(home);
  t.after(() => reopened.close());
  store = new AssistantSuggestionStore(reopened, () => new Date(clock));
  assert.equal(store.list()[0].feedback, 'snoozed');
  assert.equal(store.pausedUntil(), '2026-09-28T10:00:00.000Z');
  assert.deepEqual(await store.candidates(), []);
  store.markRead(suggestion.suggestionId);
  assert.ok(store.get(suggestion.suggestionId).readAt);
  clock = '2026-10-11T10:00:00.000Z';
  assert.equal(store.list()[0].feedback, 'none', 'snooze resumes after the persisted deadline');
  assert.equal(store.get(suggestion.suggestionId).readAt, undefined,
    'a new reminder is unread until the user views it');
  assert.equal((await store.nextForDelivery()).suggestionId, suggestion.suggestionId,
    'a long snooze can be delivered after its due date');
  assert.equal(store.deliveryId(suggestion.suggestionId), `${suggestion.suggestionId}-r1`,
    'the user-requested reminder has a new host idempotency key');
  const candidateFile = join(home, 'suggestions', 'follow-ups', 'a'.repeat(24) + '.md');
  const original = await readFile(candidateFile);
  await writeFile(candidateFile, 'temporarily invalid document');
  await assert.rejects(store.reconcileSources(), 'read failures block use without erasing durable state');
  assert.equal(store.get(suggestion.suggestionId)?.suggestionId, suggestion.suggestionId);
  assert.equal(reopened.sources.database.prepare('SELECT COUNT(*) AS n FROM assistant_suggestion_reflections').get().n, 1);
  assert.equal(reopened.sources.database.prepare('SELECT COUNT(*) AS n FROM automation_prepared_proposals').get().n, 1);
  await writeFile(candidateFile, original);
  reopened.sources.forgetSource(sourceId);
  await reopened.reconcileDeletedSources();
  await store.reconcileSources();
  assert.deepEqual(store.list(), [], 'forget removes the independent suggestion copy');
  assert.equal(reopened.sources.database.prepare('SELECT COUNT(*) AS n FROM assistant_suggestions').get().n, 0);
  assert.equal(reopened.sources.database.prepare('SELECT COUNT(*) AS n FROM assistant_suggestion_reflections').get().n, 0);
  assert.equal(reopened.sources.database.prepare('SELECT COUNT(*) AS n FROM automation_prepared_proposals').get().n, 0);
});

test('a candidate with withdrawn or unavailable source cannot be proposed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-suggestion-stale-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = await AssistantMemoryRepository.open(join(root, 'assistant'));
  t.after(() => memory.close());
  const store = new AssistantSuggestionStore(memory);
  assert.deepEqual(await store.candidates(), []);
});

test('considered recent candidates do not starve an older fresh follow-up', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-suggestion-page-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = await AssistantMemoryRepository.open(join(root, 'assistant'));
  t.after(() => memory.close());
  const sourceId = 'work-turn:many';
  const host = { async listChanges(_feed, cursor) { return { events: cursor === '0' ? [{ eventId: '1',
    change: { sourceId, sourceVersion: 'v1', kind: 'created', audience,
      occurredAt: when, contentRef: 'opaque:many' } }] : [], nextCursor: '1' }; },
  async currentSource() { return { status: 'available', sourceVersion: 'v1' }; },
  async readSource() { return { status: 'available', sourceVersion: 'v1', text: 'User: Check each item.' }; } };
  await memory.sources.sync(host, 'work');
  await memory.processNext(host);
  for (let index = 0; index < 33; index++) {
    const id = `follow-up-${index.toString(16).padStart(24, '0')}`;
    await memory.commit({ id, section: 'suggestions', kind: 'observed', audience,
      context: `Check ${index}`, verifiedAt: when, text: `Check item ${index}`,
      evidence: [{ sourceId, sourceVersion: 'v1', observedAt: when }], dependsOn: [],
      manualAuthority: false, expectedVersion: 0, revisionId: `candidate-${index}`,
      reason: 'Work review' });
  }
  const store = new AssistantSuggestionStore(memory, () => new Date(when));
  const newest = await store.candidates(32);
  assert.equal(newest.length, 32);
  store.record(newest, []);
  const remaining = await store.candidates();
  assert.deepEqual(remaining.map((item) => item.candidateId),
    [`follow-up-${'0'.repeat(24)}`]);
});

test('context edits and the ninth evidence source invalidate an old suggestion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-suggestion-nine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = await AssistantMemoryRepository.open(join(root, 'assistant'));
  t.after(() => memory.close());
  const evidence = Array.from({ length: 9 }, (_, index) => ({
    sourceId: `work-source-${index}`, sourceVersion: 'v1', observedAt: when,
  }));
  for (const ref of evidence) memory.sources.database.prepare(`INSERT INTO source_current
    (source_id,feed_id,source_version,content_ref,audience_kind,audience_id,availability,occurred_at)
    VALUES (?,'work','v1',NULL,'personal','local-user','available',?)`).run(ref.sourceId, when);
  const id = `follow-up-${'c'.repeat(24)}`;
  const draft = { id, section: 'suggestions', kind: 'observed', audience,
    context: 'No deadline known', verifiedAt: when, text: 'Review the unresolved work.', evidence,
    dependsOn: [], manualAuthority: false, expectedVersion: 0, revisionId: 'nine-r1',
    reason: 'Current review' };
  await memory.commit(draft);
  const store = new AssistantSuggestionStore(memory, () => new Date(when));
  const first = (await store.candidates())[0];
  assert.equal(first.evidence.length, 9);
  store.record([first], [{ candidateId: id, reason: 'The work is unresolved.',
    nextStep: 'Check the work.' }]);
  await memory.commit({ ...draft, context: 'Deadline is tomorrow', expectedVersion: 1,
    revisionId: 'nine-r2' });
  await store.reconcileSources();
  assert.deepEqual(store.list(), [], 'a context-only edit withdraws the old conclusion');
  const updated = (await store.candidates())[0];
  assert.notEqual(updated.fingerprint, first.fingerprint);
  store.record([updated], [{ candidateId: id, reason: 'The work is unresolved.',
    nextStep: 'Check the work.' }]);
  memory.sources.database.prepare(`UPDATE source_current SET source_version='v2'
    WHERE source_id=?`).run(evidence[8].sourceId);
  await store.reconcileSources();
  assert.deepEqual(store.list(), [], 'the ninth evidence dependency blocks stale delivery');
});
