import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Standalone TASK-050 regression probe, deliberately excluded from pnpm check until fixed.
// Real Worker/Pi session and persistence; loopback model, synthetic memory, temporary Home.
const require = createRequire(import.meta.url);
const { AssistantWorkerManager } = require('../dist/index.cjs');
const entry = resolve(import.meta.dirname, '../dist/index.cjs');
const root = await mkdtemp(join(tmpdir(), 'yp-task050-memory-refresh-'));
const appPath = join(root, 'app');
const agentPath = join(root, 'agent');
const home = join(root, 'assistant');
const sessionId = randomUUID();
const question = '我的验收口令偏好是什么？请只回答四个字。';
const requests = [];
const server = createServer(async (request, response) => {
  let text = '';
  for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  const serialized = JSON.stringify(body.messages ?? []);
  if (serialized.includes(question)) requests.push(serialized);
  const content = serialized.includes(question)
    ? serialized.includes('我的验收口令偏好是绿色纸鹤') ? '绿色纸鹤' : '未知'
    : '收到';
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ id: 'task-050-refresh', object: 'chat.completion.chunk',
    created: 1, model: 'fixture-model', choices: [{ index: 0,
      delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: 'task-050-refresh', object: 'chat.completion.chunk',
    created: 1, model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  response.end('data: [DONE]\n\n');
});
let manager;
try {
  await Promise.all([mkdir(appPath), mkdir(agentPath)]);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  await writeFile(join(appPath, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions',
    models: [{ id: 'fixture-model', name: 'Fixture', reasoning: false, input: ['text'],
      contextWindow: 128000, maxTokens: 1024 }],
  } } }));
  await writeFile(join(appPath, 'auth.json'), JSON.stringify({ fixture: {
    type: 'api_key', key: 'fixture-only' } }));
  manager = new AssistantWorkerManager({ home,
    model: { appPath, agentPath, provider: 'fixture', model: 'fixture-model' },
    command: { executable: process.execPath, args: [entry, '--assistant-worker'] } });
  await manager.start();
  const first = await manager.prompt('task050-first', '你好。', Date.now() + 10_000, sessionId);
  assert.equal(first.status, 'completed');
  const imported = await manager.importSavedMemory('task050-controlled', 'assistant',
    '我的验收口令偏好是蓝色纸鹤', new Date().toISOString());
  const corrected = await manager.correctMemory(imported.id, imported.version,
    '我的验收口令偏好是绿色纸鹤', 'task050-corrected');
  assert.equal(corrected.version, imported.version + 1);
  const second = await manager.prompt('task050-second', question, Date.now() + 10_000, sessionId);
  assert.equal(second.status, 'completed');
  assert.equal(requests.length, 1);
  const refreshed = requests[0].includes('我的验收口令偏好是绿色纸鹤');
  console.log(JSON.stringify({ mode: 'real-worker-loopback', sessionReused: true,
    correctedMemoryVersion: corrected.version, refreshedMemoryVisibleToModel: refreshed,
    answerMatchesCorrection: second.message === '绿色纸鹤' }));
  assert.equal(refreshed, true, 'the established Assistant session must see the corrected memory');
  assert.equal(second.message, '绿色纸鹤');
} finally {
  await manager?.stop();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await rm(root, { recursive: true, force: true });
}
