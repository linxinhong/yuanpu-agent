import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AssistantAutomationEngine, AssistantAutomationStore } from '@yuanpu-agent/assistant';

const require = createRequire(import.meta.url);
const { assistantAutomationHandler } = require('../dist/index.cjs');
const audience = { kind: 'personal', id: 'local-user' };

function fixture() {
  const database = new DatabaseSync(':memory:');
  const store = new AssistantAutomationStore(database);
  const record = { taskId: 'delegated_one', assistantSessionId: 'assistant_one',
    status: 'completed', updatedAt: new Date().toISOString(),
    completionCriteria: ['Cite evidence'], result: { status: 'completed',
      resultRef: 'opaque:result', evidenceRefs: ['source:one'] } };
  const job = store.enqueueDelegation(record.taskId, 'v1', audience, record.updatedAt, record.status);
  const memory = { sources: { database } };
  return { database, store, record, job, memory };
}

test('verification job accounts for cost before linking evidence and commits once', async (t) => {
  const { database, store, record, job, memory } = fixture();
  t.after(() => database.close());
  let notifications = 0;
  let links = 0;
  const host = { async current() { return record; },
    async notify(_record, _signal, beforeModel) { assert.equal(beforeModel(), true); notifications++; return { costUsd: 0.01,
      message: JSON.stringify({ checks: [{ criterion: 'Cite evidence', evidenceRefs: ['source:one'] }] }) }; },
    async linkEvidence() { links++; } };
  const engine = new AssistantAutomationEngine(store, assistantAutomationHandler(memory, store, host));
  assert.equal((await engine.tick()).status, 'completed');
  assert.equal(store.hasCheckpoint(job.effectId), true);
  assert.equal(store.hasEffectAttempt(job.effectId), true);
  assert.equal(notifications, 1);
  assert.equal(links, 1);
  await engine.tick();
  assert.equal(notifications, 1);
});

test('over-budget and interrupted notifications never link evidence or replay', async (t) => {
  const first = fixture();
  t.after(() => first.database.close());
  let overBudgetLinks = 0;
  const costly = { async current() { return first.record; },
    async notify(_record, _signal, beforeModel) { assert.equal(beforeModel(), true);
      return { costUsd: 1, message: '{"checks":[]}' }; },
    async linkEvidence() { overBudgetLinks++; } };
  const expensive = new AssistantAutomationEngine(first.store,
    assistantAutomationHandler(first.memory, first.store, costly));
  assert.equal((await expensive.tick()).status, 'failed');
  assert.equal(overBudgetLinks, 0);
  assert.equal(first.store.hasCheckpoint(first.job.effectId), false);

  const second = fixture();
  t.after(() => second.database.close());
  let notifications = 0;
  const interrupted = { async current() { return second.record; },
    async notify(_record, _signal, beforeModel) { assert.equal(beforeModel(), true);
      notifications++; throw new Error('Worker died after model request'); },
    async linkEvidence() { throw new Error('must not link'); } };
  const before = new AssistantAutomationEngine(second.store,
    assistantAutomationHandler(second.memory, second.store, interrupted));
  assert.equal((await before.tick()).status, 'waiting');
  const after = new AssistantAutomationEngine(second.store,
    assistantAutomationHandler(second.memory, second.store, interrupted));
  second.store.database.prepare("UPDATE automation_jobs SET retry_at=? WHERE job_id=?")
    .run(new Date(0).toISOString(), second.job.jobId);
  assert.equal((await after.tick()).status, 'waiting');
  assert.equal(notifications, 1);
  assert.equal(second.store.hasEffectAttempt(second.job.effectId), true);
});

test('an interrupted model attempt remains unknown after reopening the automation database', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-delegation-wake-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.sqlite');
  const record = { taskId: 'restart_task', assistantSessionId: 'assistant_one',
    status: 'completed', updatedAt: new Date().toISOString() };
  let calls = 0;
  const host = { async current() { return record; },
    async notify(_record, _signal, beforeModel) { assert.equal(beforeModel(), true);
      calls++; throw new Error('model response lost'); },
    async linkEvidence() { throw new Error('must not link'); } };
  const firstDb = new DatabaseSync(path);
  const firstStore = new AssistantAutomationStore(firstDb);
  const job = firstStore.enqueueDelegation(record.taskId, 'v1', audience,
    record.updatedAt, record.status);
  const first = new AssistantAutomationEngine(firstStore,
    assistantAutomationHandler({ sources: { database: firstDb } }, firstStore, host));
  assert.equal((await first.tick()).status, 'waiting');
  firstDb.close();
  const reopenedDb = new DatabaseSync(path);
  t.after(() => reopenedDb.close());
  const reopenedStore = new AssistantAutomationStore(reopenedDb);
  reopenedDb.prepare("UPDATE automation_jobs SET retry_at=? WHERE job_id=?")
    .run(new Date(0).toISOString(), job.jobId);
  const restarted = new AssistantAutomationEngine(reopenedStore,
    assistantAutomationHandler({ sources: { database: reopenedDb } }, reopenedStore, host));
  assert.equal((await restarted.tick()).status, 'waiting');
  assert.equal(reopenedStore.hasEffectAttempt(job.effectId), true);
  assert.equal(calls, 1);
});

test('foreground preemption before model dispatch can resume the same notification', async (t) => {
  const { database, store, record, job, memory } = fixture();
  t.after(() => database.close());
  let entered;
  const firstNotify = new Promise((resolveEntered) => { entered = resolveEntered; });
  let calls = 0;
  let links = 0;
  const host = { async current() { return record; },
    async notify(_record, signal, beforeModel) {
      calls++;
      if (calls === 1) {
        entered();
        return new Promise((_resolve, reject) => signal.addEventListener('abort',
          () => reject(new Error('preempted before model dispatch')), { once: true }));
      }
      assert.equal(beforeModel(), true);
      return { costUsd: 0, message: JSON.stringify({ checks: [{ criterion: 'Cite evidence',
        evidenceRefs: ['source:one'] }] }) };
    },
    async linkEvidence() { links++; } };
  const engine = new AssistantAutomationEngine(store, assistantAutomationHandler(memory, store, host));
  const interrupted = engine.tick();
  await firstNotify;
  engine.setForeground(true);
  await interrupted;
  assert.equal(store.get(job.jobId).status, 'waiting');
  assert.equal(store.hasEffectAttempt(job.effectId), false);
  engine.setForeground(false);
  assert.equal((await engine.tick()).status, 'completed');
  assert.equal(calls, 2);
  assert.equal(links, 1);
});

test('a persisted billed proposal resumes local evidence commit without a second model turn', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-delegation-proposal-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state.sqlite');
  const archive = join(root, 'archive.json');
  const record = { taskId: 'proposal_task', assistantSessionId: 'assistant_one',
    status: 'completed', updatedAt: new Date().toISOString() };
  let notifications = 0;
  let links = 0;
  const host = { async current() { return record; },
    async notify(_record, _signal, beforeModel) {
      assert.equal(beforeModel(), true);
      notifications++;
      return { costUsd: 0.01, message: JSON.stringify({ checks: [{ criterion: 'Cite evidence',
        evidenceRefs: ['source:one'] }] }) };
    },
    async linkEvidence() {
      links++;
      await writeFile(archive, JSON.stringify({ taskId: record.taskId,
        verification: { 'Cite evidence': ['source:one'] } }));
      if (links === 1) throw new Error('Worker died after the idempotent archive write');
    } };
  const firstDb = new DatabaseSync(path);
  const firstStore = new AssistantAutomationStore(firstDb);
  const job = firstStore.enqueueDelegation(record.taskId, 'v1', audience,
    record.updatedAt, record.status);
  const first = new AssistantAutomationEngine(firstStore,
    assistantAutomationHandler({ sources: { database: firstDb } }, firstStore, host));
  assert.equal((await first.tick()).status, 'waiting');
  assert.ok(firstStore.preparedProposal(job));
  firstDb.close();
  const secondDb = new DatabaseSync(path);
  t.after(() => secondDb.close());
  const secondStore = new AssistantAutomationStore(secondDb);
  secondDb.prepare("UPDATE automation_jobs SET retry_at=? WHERE job_id=?")
    .run(new Date(0).toISOString(), job.jobId);
  const second = new AssistantAutomationEngine(secondStore,
    assistantAutomationHandler({ sources: { database: secondDb } }, secondStore, host));
  assert.equal((await second.tick()).status, 'completed');
  assert.equal(notifications, 1);
  assert.equal(links, 2);
  assert.equal(secondStore.hasCheckpoint(job.effectId), true);
  assert.deepEqual(JSON.parse(await readFile(archive, 'utf8')).verification,
    { 'Cite evidence': ['source:one'] });
});
