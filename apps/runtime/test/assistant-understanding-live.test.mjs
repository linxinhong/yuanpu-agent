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

async function eventually(check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; }
    catch { /* Worker can be between SQLite and Markdown commits. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  throw new Error('Timed out waiting for assistant understanding.');
}

test('real Worker invokes isolated understand-user skill and writes evidence-backed user note', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-understand-live-'));
  const appPath = join(root, 'app');
  const agentPath = join(root, 'agent');
  await mkdir(appPath);
  await mkdir(agentPath);
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(body);
    const content = body.includes('understand-user')
      ? JSON.stringify({ observations: [{ topic: 'interests', quote: '我喜欢安静地阅读。',
        supersedes: [] }] })
      : JSON.stringify({ goal: 'Understand the user', constraints: [], judgment: 'unverified',
        findings: [], unresolved: [], followUp: [], memoryCandidates: [], ledgerCandidates: [] });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'loopback', object: 'chat.completion.chunk',
      created: 0, model: 'fixture-model', choices: [{ index: 0,
        delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'loopback', object: 'chat.completion.chunk',
      created: 0, model: 'fixture-model', choices: [{ index: 0,
        delta: {}, finish_reason: 'stop' }] })}\n\n`);
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
  const source = { sourceId: 'assistant-turn:test-one', sourceVersion: 'v1',
    kind: 'created', audience, occurredAt: '2026-09-27T00:00:00.000Z',
    contentRef: 'opaque:one' };
  const sources = { async listChanges(feed, cursor) { return feed === 'assistant' && cursor === '0'
    ? { events: [{ eventId: '1', change: source }], nextCursor: '1' }
    : { events: [], nextCursor: cursor }; },
  async currentSource() { return { status: 'available', sourceVersion: 'v1' }; },
  async readSource() { return { status: 'available', sourceVersion: 'v1',
    text: 'User: 我喜欢安静地阅读。\nAssistant: 了解。' }; } };
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
  const note = await eventually(() => readFile(join(home, 'memories', 'user', 'interests.md'), 'utf8'));
  assert.match(note, /我喜欢安静地阅读/);
  assert.match(note, /assistant-turn:test-one/);
  assert.ok(requests.some((body) => body.includes('understand-user')));
  for (const body of requests) if (body.includes('understand-user')) {
    assert.equal(JSON.parse(body).tools?.length ?? 0, 0,
      'background understanding cannot invoke professional delegation');
  }
  const db = new DatabaseSync(join(home, 'state.sqlite'));
  try {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM automation_jobs
      WHERE kind='understand-user' AND status='completed'`).get().n, 1);
  } finally { db.close(); }
});
