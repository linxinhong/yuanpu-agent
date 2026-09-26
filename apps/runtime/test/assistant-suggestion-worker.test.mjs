import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { AssistantMemoryRepository, AssistantSuggestionStore, AssistantWorkReviewStore,
  AssistantWorkOrganization } from '@yuanpu-agent/assistant';
import { YuanpuMetadataDatabase } from '@yuanpu-agent/runtime-kit';
import { AssistantHostService } from '../src/assistant-host.ts';

const require = createRequire(import.meta.url);
const { AssistantWorkerManager } = require('../dist/index.cjs');
const entry = resolve(import.meta.dirname, '../dist/index.cjs');
const audience = { kind: 'personal', id: 'local-user' };

async function eventually(check, label) {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out awaiting ${label}.`);
}

test('real Assistant Worker routes one opted-in suggestion through paired host and never replays accepted delivery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-suggestion-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assistantHome = join(root, 'assistant');
  const appPath = join(root, 'app');
  const agentPath = join(root, 'agent');
  await mkdir(appPath);
  await mkdir(agentPath);
  const memory = await AssistantMemoryRepository.open(assistantHome);
  const sourceId = 'work-turn:suggestion';
  const workId = 'work:suggestion';
  const when = new Date().toISOString();
  memory.sources.database.prepare(`INSERT INTO source_current
    (source_id,feed_id,source_version,content_ref,audience_kind,audience_id,availability,occurred_at)
    VALUES (?,'legacy-memory','v1',NULL,'personal','local-user','available',?)`).run(sourceId, when);
  memory.sources.database.prepare(`INSERT INTO source_events
    (feed_id,event_id,source_id,source_version,kind,audience_kind,audience_id,
     content_ref,work_id,occurred_at,status)
    VALUES ('legacy-memory','1',?,'v1','created','personal','local-user',NULL,?,?,'processed')`)
    .run(sourceId, workId, when);
  const reviews = new AssistantWorkReviewStore(memory.sources.database, memory.sources, assistantHome);
  const reviewId = `review-${'d'.repeat(24)}`;
  const review = { reviewId, workId, reviewVersion: 1, audience,
    goal: 'Check the report', constraints: [], judgment: 'unverified', findings: [],
    unresolved: ['The report has not been checked.'], followUp: [], createdAt: when };
  memory.sources.database.prepare(`INSERT INTO work_reviews
    (review_id,job_id,work_id,source_id,source_version,material_versions_json,
     review_version,review_json,proposal_json,status,file_hash)
    VALUES (?,?,?,?,?,'[]',1,?,'{"memoryCandidates":[],"ledgerCandidates":[]}','active',NULL)`)
    .run(reviewId, 'fixture-review', workId, sourceId, 'v1', JSON.stringify(review));
  await new AssistantWorkOrganization(memory, reviews).reconcile();
  const suggestions = new AssistantSuggestionStore(memory);
  const candidates = await suggestions.candidates();
  assert.equal(candidates.length, 1);
  const candidateId = candidates[0].candidateId;
  suggestions.record(candidates, [{ candidateId, reason: 'The report is unverified.',
    nextStep: 'Check its totals.' }]);
  const suggestionId = suggestions.list()[0].suggestionId;
  memory.close();
  const config = join(assistantHome, 'config.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, proactiveWecomEnabled: true,
    proactiveWecomHours: { start: 0, end: 24 } }));

  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const metadata = new YuanpuMetadataDatabase(raw);
  t.after(() => metadata.close());
  metadata.channels.bindConnection({ provider: 'wecom', connectionId: 'bot-1',
    providerAccountDigest: 'a'.repeat(64), credentialBindingDigest: 'b'.repeat(64), now: when });
  metadata.channels.pair('wecom', 'bot-1', 'sender-1', when);
  metadata.channels.observePrivateSender({ provider: 'wecom', connectionId: 'bot-1',
    senderDigest: 'sender-1', recipientId: 'member-1', now: when });
  metadata.assistantHost.linkWecomContact(metadata.channels.listPrivateContacts('wecom')[0].contactId);
  let current = { status: 'available', sourceVersion: 'v1' };
  const sources = { async listChanges(_feedId, afterCursor) { return { events: [], nextCursor: afterCursor }; },
    async currentSource() { return current; },
    async readSource() { return { status: 'available', sourceVersion: 'v1', text: '' }; } };
  let service;
  const manager = new AssistantWorkerManager({ home: assistantHome, sources,
    model: { appPath, agentPath, provider: 'unused', model: 'unused' },
    command: { executable: process.execPath, args: [entry, '--assistant-worker'] },
    deliverSuggestion: (id, content) => service.deliverSuggestion(id, content) });
  t.after(() => manager.stop());
  service = new AssistantHostService(metadata.assistantHost, manager, '/work', config);
  t.after(() => service.close());
  let sends = 0;
  service.recoverWecom('bot-1', { isReady: () => true,
    async sendProactive(recipient, content) {
      sends++;
      assert.equal(recipient, 'member-1');
      assert.match(content, /Check its totals/);
      return { status: 'accepted' };
    } });
  await manager.start();
  await eventually(async () => (await manager.suggestions()).items[0]?.deliveryStatus === 'accepted',
    'suggestion delivery status');
  assert.equal(sends, 1);
  assert.equal((await manager.suggestions()).items[0].readAt, undefined);
  assert.equal(metadata.assistantHost.proactiveDelivery(suggestionId).status, 'accepted');
  const imported = await manager.importSavedMemory('old-bookmark-one', 'work',
    'The user prefers a short report.', when);
  assert.match(imported.context, /旧本地工作收藏（手动导入）/);
  assert.equal((await manager.workspace()).memories.find((item) => item.id === imported.id)?.text,
    'The user prefers a short report.');
  const corrected = await manager.correctMemory(imported.id, imported.version,
    'The user prefers a concise written report.', 'old-bookmark-correction');
  await assert.rejects(manager.correctMemory(imported.id, imported.version,
    'Stale correction', 'stale-correction'), /version conflict/);
  assert.equal(corrected.version, imported.version + 1);
  assert.deepEqual((await manager.forgetMemory(imported.id)).forgottenIds, [imported.id]);
  assert.equal((await manager.workspace()).memories.some((item) => item.id === imported.id), false);
  const pausedUntil = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal((await manager.pauseOrganizing(pausedUntil)).organizingPausedUntil, pausedUntil);
  await manager.stop();
  await manager.start();
  await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  assert.equal(sends, 1, 'a restarted Worker does not replay an accepted host receipt');
  assert.equal((await manager.workspace()).memories.some((item) => item.id === imported.id), false,
    'forgotten memory is still absent after Worker restart');
  assert.equal((await manager.workspace()).organizingPausedUntil, pausedUntil,
    'organizing pause survives Worker restart');
  current = { status: 'deleted', sourceVersion: 'v1' };
});
