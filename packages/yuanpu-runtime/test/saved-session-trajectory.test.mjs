import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { readYuanpuSavedContextUsage, readYuanpuSessionTrajectory } from '../dist/index.mjs';

test('saved trajectory refreshes after the Pi session grows', async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), 'yuanpu-trajectory-'));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  const directory = join(cwd, 'sessions');
  const sessionId = randomUUID();
  const session = SessionManager.create(cwd, directory, { id: sessionId });
  const answer = (text) => session.appendMessage({ role: 'assistant', content: [{ type: 'text', text }],
    api: 'fixture', provider: 'fixture', model: 'fixture', stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  session.appendMessage({ role: 'user', content: 'first', timestamp: Date.now() });
  answer('one');
  const read = () => readYuanpuSessionTrajectory(cwd, sessionId, directory, 'work:test', cwd);
  assert.equal(read().rounds, 1);
  assert.equal(read().rounds, 1);
  session.appendMessage({ role: 'user', content: 'second', timestamp: Date.now() });
  answer('two');
  assert.equal(read().rounds, 2);
});

test('saved Work session restores its context ring from Pi usage and the configured model window', async (context) => {
  const cwd = await mkdtemp(join(tmpdir(), 'yuanpu-context-'));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: 'https://example.test/v1', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'],
      contextWindow: 1000, maxTokens: 100 }],
  } } }));
  const directory = join(cwd, 'sessions');
  const sessionId = randomUUID();
  const session = SessionManager.create(cwd, directory, { id: sessionId });
  session.appendMessage({ role: 'user', content: 'first', timestamp: Date.now() });
  session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'done' }],
    api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 220, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 250,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const usage = await readYuanpuSavedContextUsage(cwd, sessionId, directory, cwd, cwd,
    { provider: 'fixture', model: 'fixture' });
  assert.equal(usage?.tokens, 250);
  assert.equal(usage?.contextWindow, 1000);
  assert.equal(usage?.percent, 25);
});
