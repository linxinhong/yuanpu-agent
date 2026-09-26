import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AssistantMemoryRepository, AssistantWorkOrganization } from '../dist/index.mjs';

const audience = { kind: 'personal', id: 'local-user' };
const when = '2026-09-27T00:00:00.000Z';

test('work organizer indexes review state, explicit commitments and private follow-up candidates', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-organize-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'assistant');
  const memory = await AssistantMemoryRepository.open(home);
  t.after(() => memory.close());
  const sourceId = 'work-turn:work:one:turn-one';
  const change = { sourceId, sourceVersion: 'v1', kind: 'created', audience,
    occurredAt: when, contentRef: 'opaque:one', workId: 'work:one' };
  const host = { async listChanges(_feed, cursor) { return { events: cursor === '0'
    ? [{ eventId: '1', change }] : [], nextCursor: '1' }; },
  async currentSource() { return { status: 'available', sourceVersion: 'v1' }; },
  async readSource() { return { status: 'available', sourceVersion: 'v1',
    text: 'User: 我会在周五检查报告。\nAssistant: 好的。' }; } };
  await memory.sources.sync(host, 'work');
  await memory.processNext(host);
  const database = memory.sources.database;
  database.exec(`CREATE TABLE work_reviews (review_id TEXT,work_id TEXT,source_id TEXT,
    source_version TEXT,review_version INTEGER,status TEXT)`);
  database.prepare(`INSERT INTO work_reviews VALUES (?,?,?,?,?,'active')`)
    .run('review-one', 'work:one', sourceId, 'v1', 1);
  const review = { reviewId: 'review-one', workId: 'work:one', reviewVersion: 1,
    audience, goal: '检查报告', judgment: 'unverified', unresolved: ['报告尚未核验'],
    findings: [], followUp: [], constraints: [], createdAt: when };
  const reviewTwo = { ...review, reviewId: 'review-two', workId: 'work:two' };
  const organizer = new AssistantWorkOrganization(memory, { get: (id) =>
    id === 'review-two' ? reviewTwo : review });
  await organizer.reconcile();
  const context = await memory.get('work-context');
  const focus = await memory.get('work-focus');
  assert.match(context.text, /work-project-/);
  assert.match(focus.text, /unverified/);
  const commitments = await memory.get('work-commitments');
  assert.match(commitments.text, /work-commitment-/);
  const childId = commitments.dependsOn[0];
  assert.match((await memory.get(childId)).text, /Status: unverified/);
  assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM memory_documents
    WHERE section='suggestions' AND status='active'`).get().n, 1);
  assert.match(await readFile(join(home, 'work', 'commitments.md'), 'utf8'), /work-commitment-/);
  const secondSourceId = 'work-turn:work:two:turn-one';
  const secondChange = { ...change, sourceId: secondSourceId,
    contentRef: 'opaque:two', workId: 'work:two' };
  await memory.sources.sync({ ...host, async listChanges(_feed, cursor) { return {
    events: cursor === '1' ? [{ eventId: '2', change: secondChange }] : [], nextCursor: '2',
  }; } }, 'work');
  await memory.processNext(host);
  database.prepare(`INSERT INTO work_reviews VALUES (?,?,?,?,?,'active')`)
    .run('review-two', 'work:two', secondSourceId, 'v1', 1);
  await organizer.reconcile();
  assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM memory_documents
    WHERE id LIKE 'work-commitment-%' AND status='active'`).get().n, 1);
  assert.equal((await memory.get(childId)).evidence.length, 2);
  assert.deepEqual(organizer.verificationCandidates().map((item) =>
    [item.workId, item.readOnly, item.authorizedCapabilities]),
  [['work:one', true, []], ['work:two', true, []]]);
  database.prepare(`UPDATE source_current SET availability='temporarily_unavailable'
    WHERE source_id=?`).run(sourceId);
  await organizer.reconcile();
  assert.equal((await memory.get(childId)).status, 'active',
    'a temporary source outage does not erase a prior explicit commitment');
  memory.sources.forgetSource(sourceId);
  memory.sources.forgetSource(secondSourceId);
  await organizer.reconcile();
  assert.equal((await memory.get('work-context')).status, 'withdrawn');
  assert.equal((await memory.get(childId)).status, 'withdrawn');
  assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM memory_documents
    WHERE section='suggestions' AND status='active'`).get().n, 0);
});

test('more than twelve active Work records keep their individual commitments and follow-ups', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-organize-many-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memory = await AssistantMemoryRepository.open(join(root, 'assistant'));
  t.after(() => memory.close());
  const changes = Array.from({ length: 13 }, (_, index) => ({
    eventId: String(index + 1), change: {
      sourceId: `work-turn:work:${String(index).padStart(2, '0')}:turn-one`,
      sourceVersion: 'v1', kind: 'created', audience,
      occurredAt: new Date(Date.parse(when) + index * 1000).toISOString(),
      contentRef: `opaque:${index}`, workId: `work:${String(index).padStart(2, '0')}`,
    },
  }));
  const host = { async listChanges(_feed, cursor) { return { events: cursor === '0' ? changes : [],
    nextCursor: '13' }; },
  async currentSource() { return { status: 'available', sourceVersion: 'v1' }; },
  async readSource(_ref, id) { return { status: 'available', sourceVersion: 'v1',
    text: `User: 我会完成${id.includes('work:00:') ? '第一项' : '另一项'}。\nAssistant: 收到。` }; } };
  await memory.sources.sync(host, 'work');
  for (let index = 0; index < changes.length; index++) await memory.processNext(host);
  const database = memory.sources.database;
  database.exec(`CREATE TABLE work_reviews (review_id TEXT,work_id TEXT,source_id TEXT,
    source_version TEXT,review_version INTEGER,status TEXT)`);
  const reviews = new Map();
  for (const { change } of changes) {
    const reviewId = `review:${change.workId}`;
    database.prepare(`INSERT INTO work_reviews VALUES (?,?,?,?,?,'active')`)
      .run(reviewId, change.workId, change.sourceId, 'v1', 1);
    reviews.set(reviewId, { reviewId, workId: change.workId, reviewVersion: 1,
      audience, goal: `完成 ${change.workId}`, judgment: 'unverified', unresolved: ['尚未核验'],
      findings: [], followUp: [], constraints: [], createdAt: change.occurredAt });
  }
  const organizer = new AssistantWorkOrganization(memory, { get: (id) => reviews.get(id) });
  await organizer.reconcile();
  const firstProject = database.prepare(`SELECT id FROM memory_documents
    WHERE id LIKE 'work-project-%' AND status='active' ORDER BY rowid LIMIT 1`).get();
  assert.ok(firstProject);
  assert.equal((await memory.get(firstProject.id)).status, 'active');
  assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM memory_documents
    WHERE id LIKE 'follow-up-%' AND status='active'`).get().n, 13);
  const commitmentIds = database.prepare(`SELECT id FROM memory_documents
    WHERE id LIKE 'work-commitment-%'`).all();
  let firstCommitment;
  for (const { id } of commitmentIds) if ((await memory.get(id)).text.includes('第一项')) {
    firstCommitment = { id };
    break;
  }
  assert.ok(firstCommitment);
  assert.equal((await memory.get(firstCommitment.id)).status, 'active');
  await organizer.reconcile();
  assert.equal((await memory.get(firstCommitment.id)).status, 'active');
});
