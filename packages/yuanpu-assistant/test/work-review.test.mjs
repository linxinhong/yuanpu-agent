import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AssistantAutomationStore, AssistantSourceStore, AssistantWorkReviewStore,
  parseWorkReviewProposal } from '../dist/index.mjs';

const audience = { kind: 'personal', id: 'local-user' };
const at = '2026-09-27T00:00:00.000Z';

function event(eventId, sourceId, text, workId = 'work:example') {
  return { eventId, change: { sourceId, sourceVersion: `v${eventId}`,
    kind: 'created', audience, occurredAt: at, contentRef: `ref:${eventId}`, workId }, text };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'yp-work-review-'));
  const home = join(root, 'assistant');
  let sources = await AssistantSourceStore.open(home);
  t.after(async () => { sources?.close(); await rm(root, { recursive: true, force: true }); });
  const values = new Map();
  const host = { async currentSource(id) {
    const item = values.get(id);
    return item?.deleted ? { status: 'deleted', sourceVersion: item.version }
      : { status: 'available', sourceVersion: item.version };
  }, async readSource(_ref, id) {
    const item = values.get(id);
    return { status: 'available', sourceVersion: item.version, text: item.text };
  } };
  const add = async (feed, item) => {
    values.set(item.change.sourceId, { version: item.change.sourceVersion, text: item.text });
    const cursor = sources.cursor(feed);
    sources.enqueuePage(feed, cursor, { nextCursor: item.eventId,
      events: [{ eventId: item.eventId, change: item.change }] });
    assert.equal((await sources.processNext(host)).status, 'processed');
  };
  return { home, host, values, add, get sources() { return sources; },
    reopen: async () => { sources.close(); sources = await AssistantSourceStore.open(home); } };
}

function proposal(refs, judgment = 'supported') {
  return parseWorkReviewProposal(JSON.stringify({ goal: 'Create a report', constraints: ['Save a report'],
    judgment, findings: [{ claim: 'The report was written', judgment, evidenceRefs: refs }],
    unresolved: [], followUp: [], memoryCandidates: ['Check the report later'],
    ledgerCandidates: ['Review report status'] }));
}

function commitReview(store, reviews, job, snapshot, value) {
  store.start(job.jobId);
  return reviews.record(job, snapshot, value,
    (write) => store.commit(job.jobId, write),
    (checkpoint) => store.recordCheckpoint(job, checkpoint));
}

test('review preserves source versions and waits for real tool evidence before completion', async (t) => {
  const context = await fixture(t);
  await context.add('work', event('1', 'work-turn:one',
    'User: Write exactly `# Report` to `report.md`.\nAssistant: Done.'));
  const store = new AssistantAutomationStore(context.sources.database);
  const reviews = new AssistantWorkReviewStore(context.sources.database, context.sources, context.home);
  store.reconcileProcessedSources();
  const first = store.next();
  const snapshot = reviews.snapshot(first);
  assert.equal(snapshot.workId, 'work:example');
  assert.equal(commitReview(store, reviews, first, snapshot,
    proposal(['work-turn:one'])), true);
  await reviews.flushPending();
  const firstReviewId = context.sources.database.prepare('SELECT review_id FROM work_reviews WHERE job_id=?')
    .get(first.jobId).review_id;
  assert.equal(reviews.get(firstReviewId).judgment, 'unverified',
    'a model reply and user claim cannot by themselves prove completion');
  assert.match(await readFile(join(context.home, 'reviews', 'example', `${firstReviewId}.md`), 'utf8'),
    /sourceVersion: v1/);

  await context.add('work-evidence', event('2', 'work-tool:one',
    'Tool write (completed), run run_1:\nFile written.'));
  await context.add('work-evidence', event('3', 'work-artifact:one',
    'Successful write payload for requested Work path report.md, run run_1:\n# Report'));
  store.reconcileProcessedSources();
  const artifactJob = store.byKey('source:review-work:work-artifact:one:v3');
  const complete = reviews.snapshot(artifactJob);
  assert.deepEqual(complete.materials.map((item) => item.kind), ['turn', 'tool', 'artifact']);
  assert.throws(() => commitReview(store, reviews, artifactJob, complete,
    proposal(['outside-source'])), /unknown evidence/);
  const exactProposal = proposal(['work-tool:one', 'work-artifact:one']);
  exactProposal.constraints = [];
  exactProposal.findings[0].claim = 'Production database was deleted';
  assert.equal(commitReview(store, reviews, artifactJob, complete, exactProposal), true);
  await reviews.flushPending();
  const record = context.sources.database.prepare('SELECT review_id FROM work_reviews WHERE job_id=?')
    .get(artifactJob.jobId);
  assert.equal(reviews.get(record.review_id).judgment, 'supported');
  assert.equal(reviews.get(record.review_id).findings[0].claim,
    'The exact text requested by the user was written to the requested Work path.');
  assert.equal(reviews.get(record.review_id).reviewVersion, 2);
  assert.deepEqual(reviews.get(record.review_id).findings[0].evidence.map((ref) => ref.sourceVersion),
    ['v2', 'v3']);
  context.sources.setCurrent({ feedId: 'work-evidence', eventId: '3', change: {
    sourceId: 'work-artifact:one', sourceVersion: 'v3', kind: 'created', audience,
    occurredAt: at, contentRef: 'ref:3', workId: 'work:example' } }, 'temporarily_unavailable');
  assert.equal(reviews.get(record.review_id).judgment, 'unverified',
    'an offline supporting source is unknown, not deleted');
  assert.equal(reviews.get(record.review_id).findings[0].judgment, 'unverified');
  await reviews.reconcileSources();
  const file = join(context.home, 'reviews', 'example', `${record.review_id}.md`);
  assert.match(await readFile(file, 'utf8'),
    /Judgment: unverified[\s\S]*- unverified: The exact text requested by the user was written/);
  context.sources.setCurrent({ feedId: 'work-evidence', eventId: '3', change: {
    sourceId: 'work-artifact:one', sourceVersion: 'v3', kind: 'created', audience,
    occurredAt: at, contentRef: 'ref:3', workId: 'work:example' } }, 'available');
  await reviews.reconcileSources();
  assert.match(await readFile(file, 'utf8'), /Judgment: supported/);
});

test('a successful irrelevant write is only partial and credentials are redacted', async (t) => {
  const context = await fixture(t);
  await context.add('work', event('1', 'work-turn:one',
    'User: Create a chart report.\nAssistant: Done.'));
  await context.add('work-evidence', event('2', 'work-tool:one',
    'Tool write (completed), run run_1:\nFile written.'));
  await context.add('work-evidence', event('3', 'work-artifact:one',
    'Successful write payload for requested Work path report.md, run run_1:\nhello'));
  const store = new AssistantAutomationStore(context.sources.database);
  const reviews = new AssistantWorkReviewStore(context.sources.database, context.sources, context.home);
  store.reconcileProcessedSources();
  const job = store.byKey('source:review-work:work-artifact:one:v3');
  const snapshot = reviews.snapshot(job);
  const result = proposal(['work-tool:one', 'work-artifact:one']);
  result.goal = 'Create a chart report ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
  result.findings[0].claim = 'Done ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
  result.memoryCandidates = ['Remember npm_abcdefghijklmnopqrstuvwxyz0123456789'];
  result.ledgerCandidates = ['-----BEGIN PRIVATE KEY----- ABCDEFGHIJKLMNOP1234567890 -----END PRIVATE KEY-----'];
  assert.equal(commitReview(store, reviews, job, snapshot, result), true);
  await reviews.flushPending();
  const row = context.sources.database.prepare('SELECT review_id,review_json,proposal_json FROM work_reviews WHERE job_id=?')
    .get(job.jobId);
  assert.equal(reviews.get(row.review_id).judgment, 'partial');
  const file = await readFile(join(context.home, 'reviews', 'example', `${row.review_id}.md`), 'utf8');
  assert.doesNotMatch(file + row.review_json + row.proposal_json,
    /ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456|npm_abcdefghijklmnopqrstuvwxyz0123456789|BEGIN PRIVATE KEY/);
});

test('review file intent survives restart and source deletion scrubs the committed finding', async (t) => {
  const context = await fixture(t);
  await context.add('work', event('1', 'work-turn:one', 'User: Do the task\nAssistant: Done.'));
  let store = new AssistantAutomationStore(context.sources.database);
  let reviews = new AssistantWorkReviewStore(context.sources.database, context.sources, context.home);
  store.reconcileProcessedSources();
  const job = store.next();
  assert.equal(commitReview(store, reviews, job, reviews.snapshot(job),
    proposal(['work-turn:one'])), true);
  const reviewId = context.sources.database.prepare('SELECT review_id FROM work_reviews WHERE job_id=?')
    .get(job.jobId).review_id;
  assert.equal(context.sources.database.prepare('SELECT COUNT(*) AS n FROM work_review_pending').get().n, 1);
  await context.reopen();
  store = new AssistantAutomationStore(context.sources.database);
  reviews = new AssistantWorkReviewStore(context.sources.database, context.sources, context.home);
  await reviews.flushPending();
  const file = join(context.home, 'reviews', 'example', `${reviewId}.md`);
  assert.match(await readFile(file, 'utf8'), /The report was written/);
  await writeFile(file, `${await readFile(file, 'utf8')}\nHuman note: preserve source.\n`);
  context.values.set('work-turn:one', { deleted: true, version: 'deleted-v1' });
  context.sources.enqueuePage('work-deletions', '0', { nextCursor: '2', events: [{ eventId: '2',
    change: { sourceId: 'work-turn:one', sourceVersion: 'deleted-v1', kind: 'deleted',
      audience, occurredAt: at } }] });
  assert.equal((await context.sources.processNext(context.host)).status, 'processed');
  await reviews.reconcileSources();
  assert.equal(reviews.get(reviewId), undefined);
  assert.doesNotMatch(await readFile(file, 'utf8'), /The report was written/);
  assert.equal(context.sources.database.prepare('SELECT status FROM work_reviews WHERE review_id=?')
    .get(reviewId).status, 'withdrawn');
});

test('review proposals reject invented IDs, oversized content and malformed status', () => {
  assert.throws(() => parseWorkReviewProposal('{"goal":"x","judgment":"completed"}'), /Invalid/);
  assert.throws(() => parseWorkReviewProposal(JSON.stringify({ goal: 'x', judgment: 'supported',
    findings: [{ claim: 'x', judgment: 'supported', evidenceRefs: ['x'.repeat(257)] }],
    constraints: [], unresolved: [], followUp: [], memoryCandidates: [], ledgerCandidates: [] })),
  /Invalid review evidence references/);
});
