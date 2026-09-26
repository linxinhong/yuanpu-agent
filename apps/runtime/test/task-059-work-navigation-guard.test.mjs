import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function startRuntime(home) {
  const token = randomBytes(32).toString('hex');
  const approvalPublicKey = generateKeyPairSync('ed25519').publicKey
    .export({ type: 'spki', format: 'der' }).toString('base64');
  const child = spawn(process.execPath, ['dist/index.cjs', '--serve', '--port', '0'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, YUANPU_HOME: home, YUANPU_PYTHON_MCP_EXECUTABLE: '', YUANPU_PYTHON_MCP_ROOT: '' },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.stdin.end(`${JSON.stringify({ token, approvalPublicKey, parentPid: process.pid })}\n`);
  const ready = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Runtime readiness timed out: ${stderr}`)), 10000);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Runtime exited ${code}: ${stderr}`)));
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(output.slice(0, newline)));
    });
  });
  const base = `http://${ready.host}:${ready.port}`;
  return {
    async request(path, method = 'GET', body) {
      const response = await fetch(`${base}${path}`, { method,
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

function insertPersistedRun(home, conversationId, status, entryPoint = 'desktop') {
  const database = new DatabaseSync(join(home, 'workflows', 'automation.sqlite'));
  try {
    const binding = database.prepare('SELECT * FROM yp_conversation_bindings WHERE conversation_id=?')
      .get(conversationId);
    const now = new Date().toISOString();
    const id = randomUUID();
    database.prepare(`INSERT INTO yp_agent_runs
      (run_id,entry_point,authority_id,subject_id,idempotency_key,request_fingerprint,input_digest,
        request_metadata_json,binding_id,status,external_effect_state,created_at,updated_at,
        approval_request_id,approval_session_id,approval_workspace_id,approval_expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, entryPoint, binding.authority_id,
      binding.subject_id, id, id, id, '{}', binding.binding_id, status, 'none', now, now,
      ...(status === 'waiting_approval' ? [id, id, binding.workspace_id, now] : [null, null, null, null]));
    return id;
  } finally { database.close(); }
}

function settleRun(home, runId) {
  const database = new DatabaseSync(join(home, 'workflows', 'automation.sqlite'));
  try { database.prepare("UPDATE yp_agent_runs SET status='succeeded', approval_request_id=NULL, approval_session_id=NULL, approval_workspace_id=NULL, approval_expires_at=NULL WHERE run_id=?").run(runId); }
  finally { database.close(); }
}

function insertAssistantRun(home, workspaceDirectory) {
  const database = new DatabaseSync(join(home, 'workflows', 'automation.sqlite'));
  try {
    const id = randomUUID();
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO yp_conversation_bindings
      (binding_id,entry_point,authority_id,subject_id,namespace,conversation_id,thread_id,
        pi_session_id,workspace_id,created_at,updated_at) VALUES (?,'desktop','local-desktop','local-user',
        'assistant',?,'',?,?,?,?)`).run(id, `assistant:${id}`, randomUUID(), workspaceDirectory, now, now);
    database.prepare(`INSERT INTO yp_agent_runs
      (run_id,entry_point,authority_id,subject_id,idempotency_key,request_fingerprint,input_digest,
        request_metadata_json,binding_id,status,external_effect_state,created_at,updated_at)
      VALUES (?,'desktop','local-desktop','local-user',?,?,?,'{}',?,'running','none',?,?)`)
      .run(randomUUID(), id, id, id, id, now, now);
  } finally { database.close(); }
}

test('persisted Work run blocks create, switch and archive after a renderer reload', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'yuanpu-task059-guard-'));
  const runtime = await startRuntime(home);
  context.after(async () => { await runtime.close(); await rm(home, { recursive: true, force: true }); });
  const first = (await runtime.request('/v1/work/conversations')).body.find((item) => item.current);
  const created = await runtime.request('/v1/work/conversations', 'POST', {});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const second = created.body;
  assert.equal((await runtime.request('/v1/work/conversations')).body.find((item) => item.current).id, second.id);
  assert.equal((await runtime.request('/v1/work/conversations', 'PATCH', { conversationId: first.id, archived: true })).status, 200);
  const runId = insertPersistedRun(home, second.id, 'waiting_approval');
  assert.equal((await runtime.request('/v1/work/conversations', 'PUT', { conversationId: first.id })).status, 409);
  assert.equal((await runtime.request('/v1/work/conversations', 'PUT', { conversationId: first.id, previewArchived: true })).status, 409);
  assert.equal((await runtime.request('/v1/work/conversations', 'POST', {})).status, 409);
  assert.equal((await runtime.request('/v1/work/conversations', 'PATCH', { conversationId: second.id, archived: true })).status, 409);
  assert.equal((await runtime.request('/v1/work/conversations')).body.find((item) => item.current).id, second.id);
  settleRun(home, runId);
  insertAssistantRun(home, second.workingDirectory);
  assert.equal((await runtime.request('/v1/work/conversations', 'PUT', { conversationId: first.id, previewArchived: true })).status, 200);
  assert.equal((await runtime.request('/v1/work/conversations')).body.find((item) => item.current).id, second.id);
  assert.equal((await runtime.request('/v1/work/conversations', 'PATCH', { conversationId: first.id, archived: false })).status, 200);
  assert.equal((await runtime.request('/v1/work/conversations', 'PUT', { conversationId: first.id, previewArchived: false })).status, 200);
  assert.equal((await runtime.request('/v1/work/conversations', 'POST', {})).status, 201);
});
