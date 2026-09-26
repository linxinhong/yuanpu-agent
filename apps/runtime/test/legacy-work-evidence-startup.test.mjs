import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { ensureYuanpuHome, openYuanpuMetadataDatabase } from '@yuanpu-agent/runtime-kit';

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
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
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.stdin.end(`${JSON.stringify({ token, approvalPublicKey, parentPid: process.pid })}\n`);
  const ready = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Runtime readiness timed out: ${stderr}`)), 15_000);
    child.once('error', reject);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Runtime exited ${code}: ${stderr}`)); });
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(output.slice(0, newline)));
    });
  });
  return {
    async request(path) {
      const response = await fetch(`http://${ready.host}:${ready.port}${path}`, {
        headers: { authorization: `Bearer ${token}` },
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

test('Runtime starts with a bound legacy default Pi session and idempotently backfills saved evidence',
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'yuanpu-legacy-work-startup-'));
    let runtime;
    context.after(async () => { await runtime?.close(); await rm(root, { recursive: true, force: true }); });
    const home = await ensureYuanpuHome(root);
    const databasePath = join(home.workflowsPath, 'automation.sqlite');
    openYuanpuMetadataDatabase(databasePath).close();
    const piSessionId = 'old-default-work-session';
    const pi = SessionManager.create(home.workspacePath, home.sessionsPath, { id: piSessionId });
    pi.appendMessage({ role: 'user', content: 'Show the old note.', timestamp: Date.now() });
    pi.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: 'old-write', name: 'write',
      arguments: { path: 'old.md', content: 'historical note' } }],
    api: 'anthropic-messages', provider: 'anthropic', model: 'fixture', stopReason: 'toolUse',
    usage, timestamp: Date.now() });
    pi.appendMessage({ role: 'toolResult', toolCallId: 'old-write', toolName: 'write',
      content: [{ type: 'text', text: 'Saved old.md' }], isError: false, timestamp: Date.now() });
    pi.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'The old note is ready.' }],
      api: 'anthropic-messages', provider: 'anthropic', model: 'fixture', stopReason: 'stop',
      usage, timestamp: Date.now() });
    const originalJsonl = await readFile(pi.getSessionFile(), 'utf8');
    const database = new DatabaseSync(databasePath);
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO yp_conversation_bindings
      (binding_id,entry_point,authority_id,subject_id,namespace,conversation_id,thread_id,
       pi_session_id,workspace_id,created_at,updated_at)
      VALUES ('old-default','desktop','local-desktop','local-user','desktop','default','',?,?,?,?)`)
      .run(piSessionId, home.workspacePath, now, now);
    database.close();

    runtime = await startRuntime(root);
    const conversations = await runtime.request('/v1/work/conversations');
    assert.equal(conversations.status, 200);
    assert.equal(conversations.body.find((item) => item.id === 'default').archived, true);
    const transcript = await runtime.request('/v1/desktop/transcript?surface=work&conversationId=default');
    assert.equal(transcript.status, 200);
    assert.match(JSON.stringify(transcript.body), /The old note is ready/);
    await runtime.close();
    runtime = undefined;

    const first = new DatabaseSync(databasePath);
    const rows = first.prepare(`SELECT kind,conversation_id,pi_session_id,source_version
      FROM yp_work_evidence_sources ORDER BY kind`).all();
    assert.deepEqual(rows.map((row) => row.kind), ['artifact', 'tool_result']);
    assert.equal(rows.every((row) => row.conversation_id === 'default'
      && row.pi_session_id === piSessionId), true);
    assert.match(rows[0].source_version, /^unavailable:/);
    assert.equal(first.prepare("SELECT COUNT(*) AS n FROM yp_work_conversations WHERE conversation_id='default'").get().n, 0);
    first.close();

    runtime = await startRuntime(root);
    assert.equal((await runtime.request('/v1/desktop/transcript?surface=work&conversationId=default')).status, 200);
    const second = new DatabaseSync(databasePath);
    assert.deepEqual(second.prepare(`SELECT kind,conversation_id,pi_session_id,source_version
      FROM yp_work_evidence_sources ORDER BY kind`).all(), rows);
    second.close();
    assert.equal(await readFile(pi.getSessionFile(), 'utf8'), originalJsonl);
  });
