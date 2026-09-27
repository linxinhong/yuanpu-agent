import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AssistantMemoryRepository } from '../dist/index.mjs';

const person = { kind: 'personal', id: 'local-user' };
const other = { kind: 'personal', id: 'other-user' };
const now = '2026-09-27T00:00:00.000Z';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const change = (sourceId, sourceVersion, contentRef, kind = 'created', audience = person) => ({
  sourceId, sourceVersion, kind, audience, occurredAt: now,
  ...(contentRef ? { contentRef } : {}),
});

async function temporaryHome(t) {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-assistant-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'assistant');
}

test('interactive personal memory context follows corrections, forget and source withdrawal', async (t) => {
  const home = await temporaryHome(t);
  const host = fakeHost();
  const repo = await AssistantMemoryRepository.open(home);
  t.after(() => repo.close());
  const base = { section: 'memories', kind: 'explicit', audience: person,
    context: '测试偏好', verifiedAt: now, evidence: [], dependsOn: [],
    manualAuthority: true, reason: 'User supplied' };
  await repo.commit({ ...base, id: 'current-preference', expectedVersion: 0,
    revisionId: 'preference-v1', text: '蓝色纸鹤' });
  await repo.commit({ ...base, id: 'other-audience', audience: other, expectedVersion: 0,
    revisionId: 'other-v1', text: '其他用户秘密' });
  await repo.commit({ ...base, id: 'work-note', section: 'work', expectedVersion: 0,
    revisionId: 'work-note-v1', text: '工作原文秘密' });
  const old = await repo.get('current-preference');
  await repo.commit({ ...old, expectedVersion: 1, revisionId: 'preference-v2',
    text: '绿色纸鹤', reason: 'User correction' });
  let current = await repo.personalPromptContext();
  assert.match(current, /绿色纸鹤/);
  assert.doesNotMatch(current, /蓝色纸鹤|其他用户秘密|工作原文秘密/);

  const sourceId = 'work-turn:fixture:one';
  const contentRef = 'work-content:fixture-one';
  repo.sources.enqueuePage('work', '0', { nextCursor: '1', events: [{ eventId: '1',
    change: change(sourceId, 'work-v1', contentRef) }] });
  host.current.set(sourceId, { status: 'available', sourceVersion: 'work-v1' });
  host.contents.set(contentRef, { status: 'available', sourceVersion: 'work-v1', text: '来源内容' });
  await repo.processNext(host);
  await repo.commit({ ...base, id: 'source-bound', kind: 'observed', manualAuthority: false,
    expectedVersion: 0, revisionId: 'source-bound-v1', text: '来源支持的偏好',
    evidence: [{ sourceId, sourceVersion: 'work-v1', observedAt: now }] });
  await repo.commit({ ...base, id: 'dependent-memory', kind: 'inferred', manualAuthority: false,
    expectedVersion: 0, revisionId: 'dependent-v1', text: '由来源推断的偏好',
    dependsOn: ['source-bound'] });
  current = await repo.personalPromptContext();
  assert.match(current, /来源支持的偏好/);
  assert.match(current, /由来源推断的偏好/);
  assert.doesNotMatch(await repo.personalPromptContext(8_000, false), /来源支持的偏好|由来源推断的偏好/);
  repo.sources.database.prepare("UPDATE source_current SET availability='temporarily_unavailable' WHERE source_id=?")
    .run(sourceId);
  assert.doesNotMatch(await repo.personalPromptContext(), /来源支持的偏好|由来源推断的偏好/);
  repo.sources.database.prepare("UPDATE source_current SET availability='available' WHERE source_id=?")
    .run(sourceId);
  await repo.forget('current-preference');
  current = await repo.personalPromptContext();
  assert.doesNotMatch(current, /绿色纸鹤/);
  assert.match(current, /来源支持的偏好/);
  repo.sources.enqueuePage('work', '1', { nextCursor: '2', events: [{ eventId: '2',
    change: change(sourceId, 'deleted-v1', undefined, 'deleted') }] });
  host.current.set(sourceId, { status: 'deleted', sourceVersion: 'deleted-v1' });
  await repo.processNext(host);
  assert.doesNotMatch(await repo.personalPromptContext(), /来源支持的偏好/);
  assert.equal(await repo.personalPromptContext(), '');
});

test('unindexed legacy core files are preserved and excluded until reviewed', async (t) => {
  const home = await temporaryHome(t);
  const path = join(home, 'memories', 'USER.md');
  await mkdir(join(home, 'memories'), { recursive: true });
  await writeFile(path, '# About the user\n\nLegacy user fact.\n');
  const repo = await AssistantMemoryRepository.open(home);
  t.after(() => repo.close());
  assert.deepEqual(await repo.unindexedLegacyCoreFiles(), [path]);
  assert.doesNotMatch(await repo.personalPromptContext(), /Legacy user fact/);
  assert.equal(await readFile(path, 'utf8'), '# About the user\n\nLegacy user fact.\n');
});

function fakeHost() {
  const feeds = new Map();
  const current = new Map();
  const contents = new Map();
  const reads = [];
  return {
    feeds, current, contents, reads,
    async listChanges(feedId, afterCursor, limit) {
      const events = (feeds.get(feedId) ?? []).filter((event) => Number(event.eventId) > Number(afterCursor))
        .slice(0, limit);
      return { events, nextCursor: events.length ? String(Math.max(...events.map((e) => Number(e.eventId))))
        : afterCursor };
    },
    async currentSource(sourceId) { return current.get(sourceId); },
    async readSource(contentRef, sourceId, version, audience, maxCharacters) {
      reads.push({ contentRef, sourceId, version, audience, maxCharacters });
      return contents.get(contentRef);
    },
  };
}

test('opaque Work and Assistant source events survive restart, order changes, and Chinese lookup', async (t) => {
  const home = await temporaryHome(t);
  const host = fakeHost();
  host.feeds.set('work', [
    { eventId: '2', change: change('work-turn:1', 'v2-hash', 'work-content:opaque', 'updated') },
    { eventId: '1', change: change('work-turn:1', 'v1-hash', 'work-content:old') },
  ]);
  host.feeds.set('assistant', [
    { eventId: '1', change: change('assistant-turn:1', 'assistant-v1', 'assistant-content:opaque') },
  ]);
  host.current.set('work-turn:1', { status: 'available', sourceVersion: 'v2-hash' });
  host.current.set('assistant-turn:1', { status: 'available', sourceVersion: 'assistant-v1' });
  host.contents.set('work-content:opaque', { status: 'available', sourceVersion: 'v2-hash',
    text: '元朴项目进展已经核实，产物可回看。',
    artifacts: [{ contentRef: 'artifact:opaque', summary: '项目交付文件' }] });
  host.contents.set('assistant-content:opaque', { status: 'available', sourceVersion: 'assistant-v1',
    text: '用户明确希望记录项目进展。' });
  const repo = await AssistantMemoryRepository.open(home);
  assert.equal(await repo.sources.sync(host, 'work'), 2);
  assert.equal(await repo.sources.sync(host, 'assistant'), 1);
  assert.equal(await repo.sources.sync(host, 'work'), 0);
  for (let index = 0; index < 3; index++) await repo.processNext(host);
  assert.equal(repo.sources.event('work', '1').status, 'obsolete');
  assert.equal(repo.sources.event('work', '2').status, 'processed');
  assert.deepEqual(repo.sources.search('项目进展', person).map((hit) => hit.contentRef).sort(),
    ['assistant-content:opaque', 'work-content:opaque']);
  assert.deepEqual(repo.sources.search('项目进展', other), []);
  assert.deepEqual(repo.sources.artifacts('work-turn:1', person),
    [{ contentRef: 'artifact:opaque', summary: '项目交付文件' }]);
  assert.deepEqual(repo.sources.artifacts('work-turn:1', other), []);
  assert.deepEqual(host.reads.map((item) => item.contentRef).sort(),
    ['assistant-content:opaque', 'work-content:opaque']);
  assert.equal(host.reads[0].maxCharacters, 32_000);
  const legacy = { id: 'legacy-memory', text: '只读旧记忆导入。',
    source: { sourceId: 'assistant-turn:1', sourceVersion: 'assistant-v1', observedAt: now },
    audience: person, context: '历史记录' };
  assert.equal((await repo.importLegacyMemory(legacy)).version, 1);
  assert.equal((await repo.importLegacyMemory(legacy)).version, 1,
    'repeating a host-supplied legacy import reuses its revision ID');
  assert.equal((await repo.search('只读旧记忆', person)).length, 1);
  for (const [eventId, version, text] of [
    ['2', 'assistant-v2', '新版旧记忆。'], ['3', 'assistant-v1', legacy.text],
  ]) {
    const ref = `assistant-content:${eventId}`;
    host.current.set('assistant-turn:1', { status: 'available', sourceVersion: version });
    host.contents.set(ref, { status: 'available', sourceVersion: version, text });
    repo.sources.enqueuePage('assistant', String(Number(eventId) - 1), { nextCursor: eventId,
      events: [{ eventId, change: change('assistant-turn:1', version, ref, 'updated') }] });
    await repo.processNext(host);
    await repo.importLegacyMemory({ ...legacy, text, source: { ...legacy.source,
      sourceVersion: version } });
    assert.equal((await repo.get('legacy-memory')).text, text);
  }
  assert.equal((await repo.importLegacyMemory(legacy)).version, 5,
    'repeating reverted content does not create another revision');
  repo.close();

  const reopened = await AssistantMemoryRepository.open(home);
  assert.equal(reopened.sources.cursor('work'), '2');
  assert.equal(reopened.sources.cursor('assistant'), '3');
  assert.equal(reopened.sources.nextEvent(), undefined);
  reopened.sources.rebuildIndex();
  assert.equal(reopened.sources.search('项目进展', person).length, 1);
  reopened.close();
});

test('manual edit wins a version race; unavailable source preserves evidence until deletion', async (t) => {
  const home = await temporaryHome(t);
  const host = fakeHost();
  host.feeds.set('work', [{ eventId: '1', change: change('work-turn:2', 'hash-one', 'opaque:one') }]);
  host.current.set('work-turn:2', { status: 'available', sourceVersion: 'hash-one' });
  host.contents.set('opaque:one', { status: 'available', sourceVersion: 'hash-one',
    text: '用户说项目进展需要每周回顾。' });
  const repo = await AssistantMemoryRepository.open(home);
  await repo.sources.sync(host, 'work');
  await repo.processNext(host);
  const evidence = [{ sourceId: 'work-turn:2', sourceVersion: 'hash-one', observedAt: now }];
  const initial = await repo.commit({ id: 'project-progress', expectedVersion: 0,
    revisionId: 'revision-one', section: 'memories', kind: 'explicit', audience: person,
    context: '元朴项目', verifiedAt: now, text: '用户希望每周回顾项目进展。',
    evidence, dependsOn: [], manualAuthority: false, reason: '用户明确表达' });
  assert.equal(initial.version, 1);
  const file = join(home, 'memories', 'notes', 'project-progress.md');
  const edited = (await readFile(file, 'utf8')).replace('每周回顾项目进展', '每两周回顾项目进展');
  await writeFile(file, edited);
  assert.equal((await repo.search('每两周回顾', person))[0].document.text,
    '用户希望每两周回顾项目进展。', 'search observes a direct edit before get() is called');
  const manual = await repo.get('project-progress');
  assert.equal(manual.version, 2);
  assert.equal(manual.manualAuthority, true);
  await assert.rejects(repo.commit({ ...initial, text: '旧自动结论', expectedVersion: 1,
    revisionId: 'stale-revision', reason: 'stale' }), /version conflict/);
  assert.equal((await repo.search('每两周回顾', person))[0].document.text,
    '用户希望每两周回顾项目进展。');

  host.feeds.get('work').push({ eventId: '2', change: change('work-turn:2', 'hash-two', 'opaque:two', 'updated') });
  host.current.set('work-turn:2', { status: 'temporarily_unavailable', sourceVersion: 'hash-two' });
  await repo.sources.sync(host, 'work');
  assert.equal((await repo.processNext(host)).status, 'unavailable');
  assert.equal(await repo.processNext(host), undefined, 'offline source does not spin a queue worker');
  assert.equal(repo.sources.source('work-turn:2').availability, 'temporarily_unavailable');
  assert.equal((await repo.search('每两周回顾', person)).length, 1);
  host.current.set('work-turn:2', { status: 'available', sourceVersion: 'hash-two' });
  host.contents.set('opaque:two', { status: 'available', sourceVersion: 'hash-two',
    text: '项目进展恢复可读。' });
  assert.equal((await repo.processNext(host, true)).status, 'processed');
  host.feeds.get('work').push({ eventId: '3', change: change('work-turn:2', 'deleted-three', undefined, 'deleted') });
  host.current.set('work-turn:2', { status: 'deleted', sourceVersion: 'deleted-three' });
  await repo.sources.sync(host, 'work');
  await repo.processNext(host);
  assert.equal((await repo.get('project-progress')).status, 'active',
    'manual correction remains authoritative after source withdrawal');
  assert.deepEqual((await repo.get('project-progress')).evidence, []);
  assert.equal(repo.sources.search('项目进展', person).length, 0);
  repo.close();
});

test('forget purges document, derived review and suggestion, index and revisions; old source stays suppressed', async (t) => {
  const home = await temporaryHome(t);
  const host = fakeHost();
  host.feeds.set('work', [{ eventId: '1', change: change('work-turn:3', 'hash-three', 'opaque:three') }]);
  host.current.set('work-turn:3', { status: 'available', sourceVersion: 'hash-three' });
  host.contents.set('opaque:three', { status: 'available', sourceVersion: 'hash-three',
    text: '用户准备公开发布一个项目。' });
  const repo = await AssistantMemoryRepository.open(home);
  await repo.sources.sync(host, 'work');
  await repo.processNext(host);
  await repo.commit({ id: 'private-plan', expectedVersion: 0, revisionId: 'memory-r1',
    section: 'memories', kind: 'explicit', audience: person, context: '项目',
    verifiedAt: now, text: '用户准备公开发布一个项目。',
    evidence: [{ sourceId: 'work-turn:3', sourceVersion: 'hash-three', observedAt: now }],
    dependsOn: [], manualAuthority: false, reason: '直接表达' });
  for (const [section, id] of [['reviews', 'review-private'], ['suggestions', 'suggestion-private']]) {
    await repo.commit({ id, expectedVersion: 0, revisionId: `${id}-r1`, section,
      kind: 'inferred', audience: person, context: '项目', verifiedAt: now,
      text: '这个项目需要后续核实。', evidence: [], dependsOn: ['private-plan'],
      manualAuthority: false, reason: '派生记录' });
  }
  assert.equal((await repo.search('项目', person)).length, 3);
  assert.deepEqual((await repo.forget('private-plan')).sort(),
    ['private-plan', 'review-private', 'suggestion-private']);
  assert.deepEqual(await repo.search('项目', person), []);
  assert.equal(repo.sources.search('公开发布', person).length, 0);
  assert.equal(repo.sources.isForgotten('work-turn:3'), true);
  host.feeds.get('work').push({ eventId: '2', change: change('work-turn:3', 'hash-three', 'opaque:three') });
  await repo.sources.sync(host, 'work');
  assert.equal(repo.sources.event('work', '2').status, 'forgotten');
  assert.equal(repo.sources.nextEvent(), undefined);
  repo.close();

  const reopened = await AssistantMemoryRepository.open(home);
  reopened.rebuildIndex();
  assert.deepEqual(await reopened.search('项目', person), []);
  assert.equal(reopened.sources.isForgotten('work-turn:3'), true);
  const revisions = reopened.sources.database.prepare(`SELECT COUNT(*) AS count FROM memory_revisions
    WHERE memory_id IN ('private-plan','review-private','suggestion-private')`).get().count;
  assert.equal(revisions, 0);
  reopened.close();
});

test('source queue preserves duplicate identity, continues past offline events, and rejects cross-feed ownership', async (t) => {
  const home = await temporaryHome(t);
  const host = fakeHost();
  const offline = change('work:offline', 'hash-a', 'opaque:offline');
  const ready = change('work:ready', 'hash-b', 'opaque:ready');
  const repo = await AssistantMemoryRepository.open(home);
  assert.equal(repo.sources.enqueuePage('work', '0', { nextCursor: '2', events: [
    { eventId: '1', change: offline }, { eventId: '2', change: ready },
  ] }), 2);
  assert.equal(repo.sources.enqueuePage('work', '2', { nextCursor: '2', events: [
    { eventId: '1', change: { contentRef: 'opaque:offline', sourceVersion: 'hash-a',
      sourceId: 'work:offline', occurredAt: now, audience: person, kind: 'created' } },
  ] }), 0);
  assert.throws(() => repo.sources.enqueuePage('assistant', '0', { nextCursor: '1', events: [
    { eventId: '1', change: offline },
  ] }), /another feed/);
  assert.equal(repo.sources.cursor('assistant'), '0');
  host.current.set('work:offline', { status: 'temporarily_unavailable' });
  host.current.set('work:ready', { status: 'available', sourceVersion: 'hash-b' });
  host.contents.set('opaque:ready', { status: 'available', sourceVersion: 'hash-b', text: '本周交付完成。' });
  assert.equal((await repo.processNext(host)).status, 'unavailable');
  assert.equal((await repo.processNext(host)).change.sourceId, 'work:ready');
  assert.equal(await repo.processNext(host), undefined);
  repo.close();
});

test('forget includes core summary and all same-source records; a recorded forget job survives restart', async (t) => {
  const home = await temporaryHome(t);
  const host = fakeHost();
  host.feeds.set('work', [{ eventId: '1', change: change('work:secret', 'hash', 'opaque:secret') }]);
  host.current.set('work:secret', { status: 'available', sourceVersion: 'hash' });
  host.contents.set('opaque:secret', { status: 'available', sourceVersion: 'hash', text: '保密的项目安排。' });
  const repo = await AssistantMemoryRepository.open(home);
  await repo.sources.sync(host, 'work');
  await repo.processNext(host);
  const evidence = [{ sourceId: 'work:secret', sourceVersion: 'hash', observedAt: now }];
  for (const [id, section] of [['secret-note', 'memories'], ['user-summary', 'memories'],
    ['same-source-review', 'reviews']]) {
    await repo.commit({ id, expectedVersion: 0, revisionId: `${id}-v1`, section,
      kind: 'explicit', audience: person, context: '保密项目', verifiedAt: now,
      text: '保密的项目安排。', evidence, dependsOn: [], manualAuthority: false,
      reason: 'Source review' });
  }
  assert.match(await readFile(join(home, 'memories', 'USER.md'), 'utf8'), /user-summary/);
  const found = await repo.search('保密项目', person);
  assert.equal(found.length, 3);
  const db = repo.sources.database;
  db.exec('BEGIN IMMEDIATE');
  for (const [id, section] of [['secret-note', 'memories'], ['user-summary', 'memories'],
    ['same-source-review', 'reviews']]) {
    db.prepare(`INSERT INTO memory_forget_jobs(memory_id,section,source_ids_json) VALUES (?,?,?)`)
      .run(id, section, JSON.stringify(['work:secret']));
    db.prepare('INSERT INTO forgotten_memories(memory_id,forgotten_at) VALUES (?,?)')
      .run(id, now);
  }
  db.exec('COMMIT');
  repo.close();
  const reopened = await AssistantMemoryRepository.open(home);
  assert.equal(await reopened.get('secret-note'), undefined);
  assert.equal(reopened.sources.isForgotten('work:secret'), true);
  assert.equal(reopened.sources.search('保密', person).length, 0);
  assert.equal(await reopened.get('user-summary'), undefined);
  assert.equal(await reopened.get('same-source-review'), undefined);
  assert.equal((await reopened.search('保密项目', person)).length, 0);
  reopened.close();
});

test('partial source withdrawal preserves a record but excludes stale mixed text until correction', async (t) => {
  const home = await temporaryHome(t);
  const host = fakeHost();
  const repo = await AssistantMemoryRepository.open(home);
  for (const [index, sourceId] of ['work:one', 'work:two'].entries()) {
    const version = `v${index + 1}`;
    const contentRef = `opaque:${index + 1}`;
    repo.sources.enqueuePage('work', String(index), { nextCursor: String(index + 1),
      events: [{ eventId: String(index + 1), change: change(sourceId, version, contentRef) }] });
    host.current.set(sourceId, { status: 'available', sourceVersion: version });
    host.contents.set(contentRef, { status: 'available', sourceVersion: version, text: '项目证据。' });
    await repo.processNext(host);
  }
  const evidence = ['work:one', 'work:two'].map((sourceId, index) => ({ sourceId,
    sourceVersion: `v${index + 1}`, observedAt: now }));
  await repo.commit({ id: 'two-source-claim', expectedVersion: 0, revisionId: 'two-r1',
    section: 'memories', kind: 'observed', audience: person, context: '项目证据',
    verifiedAt: now, text: '来源一事实；来源二事实。', evidence, dependsOn: [],
    manualAuthority: false, reason: 'Two sources' });
  assert.match(await repo.personalPromptContext(), /来源一事实/);
  repo.sources.enqueuePage('work', '2', { nextCursor: '3', events: [{ eventId: '3',
    change: change('work:one', 'deleted', undefined, 'deleted') }] });
  host.current.set('work:one', { status: 'deleted', sourceVersion: 'deleted' });
  await repo.processNext(host);
  const remaining = await repo.get('two-source-claim');
  assert.equal(remaining.status, 'active');
  assert.deepEqual(remaining.evidence.map((ref) => ref.sourceId), ['work:two']);
  assert.doesNotMatch(await repo.personalPromptContext(), /来源一事实|来源二事实/);
  await repo.commit({ ...remaining, expectedVersion: remaining.version,
    revisionId: 'two-r3', text: '来源二事实。', reason: 'Reviewed remaining source' });
  assert.match(await repo.personalPromptContext(), /来源二事实/);
  assert.doesNotMatch(await repo.personalPromptContext(), /来源一事实/);
  const reviewed = await repo.get('two-source-claim');
  await repo.commit({ ...reviewed, expectedVersion: reviewed.version,
    revisionId: 'two-r4', text: '临时表述。', reason: 'Draft wording' });
  const draft = await repo.get('two-source-claim');
  await repo.commit({ ...draft, expectedVersion: draft.version,
    revisionId: 'two-r5', text: '来源一事实；来源二事实。', reason: 'Reverted wording' });
  assert.doesNotMatch(await repo.personalPromptContext(), /来源一事实|来源二事实/);
  await repo.forget('two-source-claim');
  assert.equal(repo.sources.isForgotten('work:two'), true);
  assert.equal(repo.sources.isForgotten('work:one'), true,
    'previously withdrawn evidence cannot reappear after a later replay');
  repo.close();
});

test('pending file revision after a crash replays exactly once', async (t) => {
  const home = await temporaryHome(t);
  const repo = await AssistantMemoryRepository.open(home);
  const first = await repo.commit({ id: 'human-entry', expectedVersion: 0,
    revisionId: 'human-r1', section: 'memories', kind: 'explicit', audience: person,
    context: '人工记录', verifiedAt: now, text: '原始内容。', evidence: [],
    dependsOn: [], manualAuthority: true, reason: 'Human entry' });
  const path = join(home, 'memories', 'notes', 'human-entry.md');
  const original = await readFile(path, 'utf8');
  const revised = original.replace('version: 1', 'version: 2').replace('原始内容。', '修订后的内容。');
  const document = { ...first, version: 2, text: '修订后的内容。' };
  repo.sources.database.prepare(`INSERT INTO memory_pending_writes(revision_id,memory_id,path,
    expected_hash,new_hash,new_content,document_json,reason) VALUES (?,?,?,?,?,?,?,?)`)
    .run('human-r2', first.id, path, hash(original), hash(revised), revised,
      JSON.stringify(document), 'Crash fixture');
  await writeFile(path, revised);
  repo.close();
  const reopened = await AssistantMemoryRepository.open(home);
  assert.equal((await reopened.get('human-entry')).version, 2);
  assert.equal((await reopened.search('修订后的内容', person)).length, 1);
  assert.equal(reopened.sources.database.prepare(`SELECT COUNT(*) AS count FROM memory_revisions
    WHERE memory_id='human-entry'`).get().count, 2);
  assert.equal(reopened.sources.database.prepare('SELECT COUNT(*) AS count FROM memory_pending_writes')
    .get().count, 0);
  reopened.close();
});

test('deleting A persists withdrawal when B is offline and withdraws evidence-only dependents', async (t) => {
  const home = await temporaryHome(t);
  const host = fakeHost();
  const repo = await AssistantMemoryRepository.open(home);
  for (const [index, sourceId] of ['source:a', 'source:b'].entries()) {
    const version = `v${index}`;
    const ref = `opaque:${index}`;
    repo.sources.enqueuePage('work', String(index), { nextCursor: String(index + 1),
      events: [{ eventId: String(index + 1), change: change(sourceId, version, ref) }] });
    host.current.set(sourceId, { status: 'available', sourceVersion: version });
    host.contents.set(ref, { status: 'available', sourceVersion: version, text: '来源文本。' });
    await repo.processNext(host);
  }
  const base = { section: 'memories', kind: 'observed', audience: person,
    context: '项目来源', verifiedAt: now, text: '项目来源已经记录。',
    dependsOn: [], manualAuthority: false, reason: 'fixture' };
  await repo.commit({ ...base, id: 'claim-a', expectedVersion: 0, revisionId: 'claim-a-v1',
    evidence: [{ sourceId: 'source:a', sourceVersion: 'v0', observedAt: now }] });
  await repo.commit({ ...base, id: 'claim-ab', expectedVersion: 0, revisionId: 'claim-ab-v1',
    evidence: ['source:a', 'source:b'].map((sourceId, index) => ({ sourceId,
      sourceVersion: `v${index}`, observedAt: now })) });
  await repo.commit({ ...base, id: 'review-a', section: 'reviews', expectedVersion: 0,
    revisionId: 'review-a-v1', evidence: [], dependsOn: ['claim-a'] });
  host.current.set('source:b', { status: 'temporarily_unavailable' });
  repo.sources.enqueuePage('work', '2', { nextCursor: '3', events: [{ eventId: '3',
    change: change('source:b', 'v1', 'opaque:1', 'updated') }] });
  assert.equal((await repo.processNext(host)).status, 'unavailable');
  host.current.set('source:a', { status: 'deleted', sourceVersion: 'deleted-a' });
  repo.sources.enqueuePage('work', '3', { nextCursor: '4', events: [{ eventId: '4',
    change: change('source:a', 'deleted-a', undefined, 'deleted') }] });
  assert.equal((await repo.processNext(host)).status, 'processed');
  assert.equal((await repo.get('claim-a')).status, 'withdrawn');
  assert.equal((await repo.get('review-a')).status, 'withdrawn');
  assert.equal((await repo.get('claim-ab')).status, 'active');
  assert.deepEqual((await repo.get('claim-ab')).evidence.map((ref) => ref.sourceId), ['source:b']);
  assert.equal((await repo.search('项目来源', person)).length, 1);
  host.current.set('source:b', { status: 'available', sourceVersion: 'v1' });
  assert.equal((await repo.processNext(host, true)).status, 'processed',
    'offline event retries without a new host change');
  repo.close();
});

test('forget purges another document that once cited the forgotten source', async (t) => {
  const home = await temporaryHome(t);
  const host = fakeHost();
  const repo = await AssistantMemoryRepository.open(home);
  for (const [index, sourceId] of ['source:old', 'source:new'].entries()) {
    const ref = `opaque:${index}`;
    repo.sources.enqueuePage('work', String(index), { nextCursor: String(index + 1),
      events: [{ eventId: String(index + 1), change: change(sourceId, `v${index}`, ref) }] });
    host.current.set(sourceId, { status: 'available', sourceVersion: `v${index}` });
    host.contents.set(ref, { status: 'available', sourceVersion: `v${index}`, text: '敏感项目。' });
    await repo.processNext(host);
  }
  const base = { section: 'memories', kind: 'observed', audience: person,
    context: '敏感项目', verifiedAt: now, text: '敏感项目记录。',
    dependsOn: [], manualAuthority: false, reason: 'fixture' };
  const oldEvidence = [{ sourceId: 'source:old', sourceVersion: 'v0', observedAt: now }];
  await repo.commit({ ...base, id: 'forget-target', expectedVersion: 0,
    revisionId: 'target-v1', evidence: oldEvidence });
  const sibling = await repo.commit({ ...base, id: 'former-sibling', expectedVersion: 0,
    revisionId: 'sibling-v1', evidence: oldEvidence });
  await repo.commit({ ...sibling, expectedVersion: 1, revisionId: 'sibling-v2',
    evidence: [{ sourceId: 'source:new', sourceVersion: 'v1', observedAt: now }], reason: 'changed source' });
  assert.deepEqual((await repo.forget('forget-target')).sort(), ['forget-target', 'former-sibling']);
  assert.equal(repo.sources.isForgotten('source:new'), false);
  assert.equal(repo.sources.database.prepare(`SELECT COUNT(*) AS n FROM memory_revisions
    WHERE memory_id='former-sibling'`).get().n, 0);
  repo.close();
});
