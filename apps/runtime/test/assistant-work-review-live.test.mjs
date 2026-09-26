import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { AssistantWorkerManager } = require('../dist/index.cjs');
const entry = resolve(import.meta.dirname, '../dist/index.cjs');
const audience = { kind: 'personal', id: 'local-user' };

async function eventually(check, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; }
    catch { /* Worker may still be writing its first review. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  throw new Error('Timed out waiting for the Work review.');
}

test('real Worker invokes review-work for a saved Work source and persists a cautious review', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-work-review-live-'));
  const appPath = join(root, 'app');
  const agentPath = join(root, 'agent');
  await mkdir(appPath);
  await mkdir(agentPath);
  const requests = [];
  let answer = JSON.stringify({ goal: 'Create a report', constraints: ['Include a result'],
    judgment: 'supported', findings: [{ claim: 'The report is complete', judgment: 'supported',
      evidenceRefs: ['work-turn:work:review-live:turn-one'] }], unresolved: [], followUp: [],
    memoryCandidates: [], ledgerCandidates: [] });
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'loopback', object: 'chat.completion.chunk', created: 0,
      model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: answer },
        finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'loopback', object: 'chat.completion.chunk', created: 0,
      model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  await writeFile(join(appPath, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions',
    models: [{ id: 'fixture-model', name: 'Fixture model', reasoning: false, input: ['text'],
      contextWindow: 128000, maxTokens: 1024 }],
  } } }));
  await writeFile(join(appPath, 'auth.json'), JSON.stringify({ fixture: {
    type: 'api_key', key: 'fixture-only' } }));
  const source = { sourceId: 'work-turn:work:review-live:turn-one', sourceVersion: 'v1',
    kind: 'created', audience, occurredAt: '2026-09-27T00:00:00.000Z',
    contentRef: 'opaque:turn-one', workId: 'work:review-live' };
  let evidenceReady = false;
  const tool = { sourceId: 'work-tool:one', sourceVersion: 'v2', kind: 'created', audience,
    occurredAt: '2026-09-27T00:00:01.000Z', contentRef: 'opaque:tool', workId: 'work:review-live' };
  const artifact = { sourceId: 'work-artifact:one', sourceVersion: 'v3', kind: 'created', audience,
    occurredAt: '2026-09-27T00:00:02.000Z', contentRef: 'opaque:artifact', workId: 'work:review-live' };
  const sources = { async listChanges(feedId, cursor) {
    if (feedId === 'work-evidence' && cursor === '0' && evidenceReady) {
      return { events: [{ eventId: '2', change: tool }, { eventId: '3', change: artifact }],
        nextCursor: '3' };
    }
    return feedId === 'work' && cursor === '0'
      ? { events: [{ eventId: '1', change: source }], nextCursor: '1' }
      : { events: [], nextCursor: cursor };
  }, async currentSource(sourceId) { return { status: 'available',
    sourceVersion: sourceId === tool.sourceId ? 'v2' : sourceId === artifact.sourceId ? 'v3' : 'v1' }; },
  async readSource(_ref, sourceId) { return { status: 'available',
    sourceVersion: sourceId === tool.sourceId ? 'v2' : sourceId === artifact.sourceId ? 'v3' : 'v1',
    text: sourceId === tool.sourceId ? 'Tool write (completed), run run_1:\nFile written.'
      : sourceId === artifact.sourceId
        ? 'Successful write payload for requested Work path report.md, run run_1:\n# Report'
        : 'User: Write exactly `# Report` to `report.md`.\nAssistant: Done.' }; } };
  const home = join(root, 'assistant');
  const manager = new AssistantWorkerManager({ home, sources,
    model: { appPath, agentPath, provider: 'fixture', model: 'fixture-model' },
    command: { executable: process.execPath, args: [entry, '--assistant-worker'] } });
  t.after(async () => {
    await manager.stop();
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  });
  await manager.start();
  const state = join(home, 'state.sqlite');
  const reviewId = await eventually(() => {
    const database = new DatabaseSync(state);
    try { return database.prepare('SELECT review_id FROM work_reviews').get()?.review_id; }
    finally { database.close(); }
  });
  const markdown = await eventually(() => readFile(join(home, 'reviews', 'review-live',
    `${reviewId}.md`), 'utf8'));
  assert.match(markdown, /Judgment: unverified/);
  assert.match(markdown, /sourceVersion: v1/);
  assert.ok(requests.some((body) => body.includes('review-work')),
    'the Worker must load and invoke its assistant-only review skill');
  answer = JSON.stringify({ goal: 'Write exactly # Report to report.md', constraints: [],
    judgment: 'supported', findings: [{ claim: 'The exact requested file was written',
      judgment: 'supported', evidenceRefs: [tool.sourceId, artifact.sourceId] }],
    unresolved: [], followUp: [], memoryCandidates: [], ledgerCandidates: [] });
  evidenceReady = true;
  const supported = await eventually(() => {
    const database = new DatabaseSync(state);
    try { return database.prepare("SELECT review_id FROM work_reviews WHERE review_json LIKE '%\"judgment\":\"supported\"%' ORDER BY review_version DESC LIMIT 1").get()?.review_id; }
    finally { database.close(); }
  }, 20_000);
  assert.match(await eventually(() => readFile(join(home, 'reviews', 'review-live',
    `${supported}.md`), 'utf8')),
    /Judgment: supported/);
  await eventually(() => {
    const database = new DatabaseSync(state);
    try { return database.prepare("SELECT COUNT(*) AS n FROM automation_jobs WHERE kind='review-work' AND status='completed'").get().n === 3; }
    finally { database.close(); }
  }, 20_000);
  await manager.stop();
  const database = new DatabaseSync(state);
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM automation_jobs WHERE kind='review-work' AND status='completed'").get().n, 3);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM work_reviews').get().n, 3);
  } finally { database.close(); }
});
