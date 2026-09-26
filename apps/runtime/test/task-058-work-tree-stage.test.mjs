import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function startRuntime(home) {
  const token = randomBytes(32).toString('hex');
  const approvalPublicKey = generateKeyPairSync('ed25519').publicKey
    .export({ type: 'spki', format: 'der' }).toString('base64');
  const child = spawn(process.execPath, ['dist/index.cjs', '--serve', '--port', '0'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, YUANPU_HOME: home, YUANPU_PYTHON_MCP_EXECUTABLE: '',
      YUANPU_PYTHON_MCP_ROOT: '' },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify({ token, approvalPublicKey, parentPid: process.pid })}\n`);
  const ready = await new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`Runtime readiness timed out: ${stderr}`)), 10_000);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Runtime exited ${code}: ${stderr}`)));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(stdout.slice(0, newline)));
    });
  });
  assert.equal(ready.event, 'ready');
  const base = `http://${ready.host}:${ready.port}`;
  return {
    async request(path, method = 'GET', body) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

function persistedSession(home, conversation) {
  const db = new DatabaseSync(join(home, 'workflows', 'automation.sqlite'));
  try {
    const row = db.prepare('SELECT pi_session_id, working_directory, folder_id, title, icon_id, archived_at FROM yp_work_conversations WHERE conversation_id=?')
      .get(conversation.id);
    const binding = db.prepare('SELECT workspace_id FROM yp_conversation_bindings WHERE conversation_id=?')
      .get(conversation.id);
    return { ...row, binding: binding?.workspace_id };
  } finally { db.close(); }
}

test('TASK-058 real Runtime, SQLite and Pi JSONL retain one Work fact across subtree move and restart', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'yuanpu-task058-stage-'));
  let runtime;
  context.after(async () => { await runtime?.close(); await rm(home, { recursive: true, force: true }); });
  runtime = await startRuntime(home);
  const request = (...args) => runtime.request(...args);
  const parent = (await request('/v1/work/folders', 'POST', { name: 'Clients', iconId: 'folder' })).body;
  const child = (await request('/v1/work/folders', 'POST', { parentId: parent.id, name: 'Review' })).body;
  const destination = (await request('/v1/work/folders', 'POST', { name: 'Moved here' })).body;
  const one = (await request('/v1/work/conversations', 'POST', { folderId: child.id })).body;
  const two = (await request('/v1/work/conversations', 'POST', { folderId: child.id })).body;
  assert.notEqual(one.id, two.id);
  assert.equal((await stat(one.workingDirectory)).isDirectory(), true);
  assert.equal((await stat(two.workingDirectory)).isDirectory(), true);
  const tag = (await request('/v1/work/tags', 'POST', { name: 'Urgent', color: 'red' })).body;
  assert.equal((await request('/v1/work/conversations', 'PATCH', {
    conversationId: one.id, title: 'Quarterly plan', iconId: 'book', tagIds: [tag.id], archived: true,
  })).status, 200);
  assert.equal((await request('/v1/work/conversations', 'PATCH', {
    conversationId: two.id, title: 'Second note', iconId: 'code',
  })).status, 200);
  assert.equal((await request('/v1/work/order', 'PUT', {
    kind: 'conversation', parentId: child.id, ids: [two.id, one.id],
  })).status, 200);
  assert.equal((await request('/v1/work/folders', 'PATCH', {
    folderId: child.id, name: 'Edited Review', iconId: 'book',
  })).status, 200);
  const pi = persistedSession(home, one).pi_session_id;
  const session = SessionManager.create(one.workingDirectory, join(home, 'agent', 'sessions'), { id: pi });
  const entryId = session.appendMessage({ role: 'user', content: 'stage-needle visible history', timestamp: Date.now() });
  session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'saved answer' }],
    api: 'fixture', provider: 'fixture', model: 'fixture', stopReason: 'stop', usage, timestamp: Date.now() });
  const jsonl = session.getSessionFile();
  const before = (await readFile(jsonl, 'utf8')).split('\n').slice(1).join('\n');
  await writeFile(join(one.workingDirectory, 'preview.txt'), 'preview follows the session');
  const moveRequest = { requestId: randomUUID(), kind: 'folder', id: child.id, targetFolderId: destination.id };
  assert.equal((await request('/v1/work/move', 'POST', moveRequest)).status, 200);
  const moved = (await request('/v1/work/conversations')).body;
  const movedOne = moved.find((item) => item.id === one.id);
  const movedTwo = moved.find((item) => item.id === two.id);
  assert.equal(movedOne.folderId, child.id);
  assert.equal(movedTwo.folderId, child.id);
  assert.notEqual(movedOne.workingDirectory, one.workingDirectory);
  assert.equal(movedOne.workingDirectory, persistedSession(home, one).working_directory);
  assert.equal(movedOne.workingDirectory, persistedSession(home, one).binding);
  assert.equal(persistedSession(home, one).pi_session_id, pi);
  assert.equal(movedOne.archived, true);
  assert.deepEqual(movedOne.tagIds, [tag.id]);
  assert.equal(movedOne.title, 'Quarterly plan');
  assert.equal(movedOne.iconId, 'book');
  assert.ok(movedTwo.sortOrder < movedOne.sortOrder);
  assert.equal((await readFile(jsonl, 'utf8')).split('\n').slice(1).join('\n'), before);
  assert.equal(JSON.parse((await readFile(jsonl, 'utf8')).split('\n')[0]).cwd, movedOne.workingDirectory);
  assert.equal((await request(`/v1/work/files/content?conversationId=${one.id}&path=preview.txt`)).body.content,
    'preview follows the session');
  assert.deepEqual((await request('/v1/work/search?query=stage-needle&archive=archived')).body.items
    .map((item) => item.messageEntryId), [entryId]);
  assert.deepEqual((await request('/v1/work/search?query=stage-needle&archive=archived')).body.items[0]
    .folderPath.map((part) => part.name), ['Moved here', 'Edited Review']);
  assert.equal((await request(`/v1/work/messages/window?conversationId=${one.id}&entryId=${entryId}`))
    .body.messages[0].id, entryId);
  await runtime.close();
  runtime = await startRuntime(home);
  const afterRestart = (await request('/v1/work/conversations')).body.find((item) => item.id === one.id);
  assert.equal(afterRestart.workingDirectory, movedOne.workingDirectory);
  assert.equal(afterRestart.archived, true);
  assert.equal(afterRestart.sortOrder, movedOne.sortOrder);
  assert.deepEqual(afterRestart.tagIds, [tag.id]);
  assert.equal((await request(`/v1/desktop/transcript?surface=work&conversationId=${one.id}`)).body.length, 2);
  assert.equal(SessionManager.findById(movedOne.workingDirectory, pi, join(home, 'agent', 'sessions')), jsonl);
  assert.equal((await request(`/v1/work/files/content?conversationId=${one.id}&path=preview.txt`)).body.content,
    'preview follows the session');
  assert.deepEqual((await request('/v1/work/search?query=stage-needle&archive=archived')).body.items
    .map((item) => item.messageEntryId), [entryId]);
  const reopened = SessionManager.open(jsonl, join(home, 'agent', 'sessions'), movedOne.workingDirectory);
  reopened.appendMessage({ role: 'user', content: 'next turn from new cwd', timestamp: Date.now() });
  assert.equal((await request(`/v1/desktop/transcript?surface=work&conversationId=${one.id}`)).body.length, 3);
  assert.equal((await request('/v1/work/conversations', 'PATCH', { conversationId: one.id, archived: false })).body.archived, false);
  assert.equal((await request('/v1/work/search?query=stage-needle')).body.items[0].messageEntryId, entryId);
  assert.equal((await request('/v1/work/move', 'POST', moveRequest)).status, 200);
});

test('TASK-058 real Runtime rejects conflicting and unsafe moves without losing original contents', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'yuanpu-task058-deny-'));
  const runtime = await startRuntime(home);
  context.after(async () => { await runtime.close(); await rm(home, { recursive: true, force: true }); });
  const request = (...args) => runtime.request(...args);
  const source = (await request('/v1/work/folders', 'POST', { name: 'Source' })).body;
  const target = (await request('/v1/work/folders', 'POST', { name: 'Target' })).body;
  const conversation = (await request('/v1/work/conversations', 'POST', { folderId: source.id })).body;
  await writeFile(join(conversation.workingDirectory, 'kept.txt'), 'keep me');
  assert.equal((await request('/v1/work/move', 'POST', { requestId: randomUUID(), kind: 'folder',
    id: source.id, targetFolderId: source.id })).status, 409);
  assert.equal((await request('/v1/work/conversations', 'PATCH', { conversationId: conversation.id,
    workingDirectory: join(home, 'outside') })).status, 400);
  const escape = join(conversation.workingDirectory, 'escape');
  await symlink(join(home, 'outside'), escape);
  assert.equal((await request('/v1/work/move', 'POST', { requestId: randomUUID(), kind: 'conversation',
    id: conversation.id, targetFolderId: target.id })).status, 409);
  await rm(escape);
  const occupied = join(home, 'workspace', target.relativeDirectory, `c-${conversation.id.slice(5)}`);
  await mkdir(occupied);
  await writeFile(join(occupied, 'foreign.txt'), 'untouched');
  assert.equal((await request('/v1/work/move', 'POST', { requestId: randomUUID(), kind: 'conversation',
    id: conversation.id, targetFolderId: target.id })).status, 409);
  assert.equal(await readFile(join(occupied, 'foreign.txt'), 'utf8'), 'untouched');
  assert.equal(await readFile(join(conversation.workingDirectory, 'kept.txt'), 'utf8'), 'keep me');
  assert.equal(persistedSession(home, conversation).working_directory, conversation.workingDirectory);
});
