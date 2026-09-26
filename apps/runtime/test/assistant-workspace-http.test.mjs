import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { RUNTIME_ROUTES } from '@yuanpu-agent/protocol';

test('authenticated desktop service round-trips Assistant memory and pause through the real Worker', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'yp-assistant-workspace-http-'));
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
