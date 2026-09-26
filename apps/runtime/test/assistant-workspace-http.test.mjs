import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { RUNTIME_ROUTES } from '@yuanpu-agent/protocol';
import { openYuanpuMetadataDatabase } from '@yuanpu-agent/runtime-kit';

test('authenticated desktop service round-trips Assistant memory and pause through the real Worker', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'yp-assistant-workspace-http-'));
  await mkdir(join(home, 'workflows'));
  const sourceId = 'work-turn:work:fixture:turn-http';
  const sourceRef = `work-content:${createHash('sha256').update(sourceId).digest('hex')}`;
  const metadata = openYuanpuMetadataDatabase(join(home, 'workflows', 'automation.sqlite'));
  metadata.database.prepare(`INSERT INTO yp_work_turn_sources(conversation_id,turn_id,run_id,
    content_ref,source_version,committed_at,user_text,assistant_text)
    VALUES (?,?,?,?,?,?,?,?)`).run('work:fixture', 'turn-http', 'run-http', sourceRef,
      'http-v1', '2026-09-27T00:00:00.000Z', 'Original work remains', 'Original answer remains');
  metadata.close();
  const token = randomBytes(32).toString('hex');
  const approvalPublicKey = generateKeyPairSync('ed25519').publicKey
    .export({ type: 'spki', format: 'der' }).toString('base64');
  const child = spawn(process.execPath, [resolve(import.meta.dirname, '../dist/index.cjs'), '--serve', '--port', '0'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, YUANPU_HOME: home, YUANPU_PYTHON_MCP_EXECUTABLE: '',
      YUANPU_PYTHON_MCP_ROOT: '' },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { if (stderr.length < 3000) stderr += chunk; });
  child.stdin.end(`${JSON.stringify({ token, approvalPublicKey, parentPid: process.pid })}\n`);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await rm(home, { recursive: true, force: true });
  });
  const ready = await new Promise((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => reject(new Error(`Runtime readiness timed out: ${stderr}`)), 10_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout);
      reject(new Error(`Runtime exited before ready (${code}): ${stderr}`)); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      resolve(JSON.parse(stdout.slice(0, newline)));
    });
  });
  assert.equal(ready.event, 'ready');
  const url = `http://${ready.host}:${ready.port}${RUNTIME_ROUTES.assistantWorkspace}`;
  const request = async (body) => {
    const response = await fetch(url, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  const read = async () => {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'revoke-source', sourceId, expectedVersion: 'http-v1' }) })).status, 401);
  const untilSource = Date.now() + 10_000;
  while (!(await read()).sources.some((item) => item.sourceId === sourceId && item.current)) {
    if (Date.now() > untilSource) throw new Error('Work source was not ingested by Assistant Worker.');
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  assert.equal((await request({ action: 'revoke-source', sourceId,
    expectedVersion: 'stale-v0' })).status, 409);
  const accepted = await request({ action: 'revoke-source', sourceId, expectedVersion: 'http-v1' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.value.status, 'accepted');
  assert.equal((await request({ action: 'revoke-source', sourceId,
    expectedVersion: 'http-v1' })).value.status, 'already_accepted');
  const untilProcessed = Date.now() + 10_000;
  while (!(await read()).sources.some((item) => item.sourceId === sourceId
    && item.availability === 'deleted' && item.current)) {
    if (Date.now() > untilProcessed) throw new Error('Revocation was not processed by Assistant Worker.');
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  const original = openYuanpuMetadataDatabase(join(home, 'workflows', 'automation.sqlite'));
  assert.equal(original.workConversations.sourceById(sourceId).userText, 'Original work remains');
  original.close();
  assert.deepEqual((await read()).memories, []);
  const imported = await request({ action: 'import-saved', savedId: 'old-save', surface: 'work',
    text: 'The user likes concise reports.', savedAt: '2026-09-27T10:00:00.000Z' });
  assert.equal(imported.status, 200);
  assert.equal((await read()).memories.some((item) => item.id === imported.value.id), true);
  const correction = { action: 'correct-memory', id: imported.value.id,
    expectedVersion: imported.value.version, text: 'The user likes reports with evidence.',
    revisionId: 'http-correction-one' };
  const corrected = await request(correction);
  assert.equal(corrected.status, 200);
  assert.equal((await request(correction)).value.version, corrected.value.version,
    'a lost HTTP response can retry the same revision');
  const until = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal((await request({ action: 'pause-organizing', until })).value.organizingPausedUntil, until);
  assert.equal((await read()).organizingPausedUntil, until);
  assert.equal((await request({ action: 'forget-memory', id: imported.value.id })).status, 200);
  assert.equal((await request({ action: 'forget-memory', id: imported.value.id })).status, 200);
  assert.equal((await read()).memories.some((item) => item.id === imported.value.id), false);
});
