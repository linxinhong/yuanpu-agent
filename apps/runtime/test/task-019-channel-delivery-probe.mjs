import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    const timeout = setTimeout(() => reject(new Error(`Runtime startup timed out: ${errors}`)), 10_000);
    child.stderr.on('data', (chunk) => { errors += chunk.toString().slice(0, 500); });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Runtime exited before readiness (${code}): ${errors}`)));
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      resolve(JSON.parse(output.slice(0, newline)));
    });
  });
}

const root = await mkdtemp(join(tmpdir(), 'yuanpu-task-019-api-'));
let child;
try {
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(join(home, 'app'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(home, 'app', 'config.json'), JSON.stringify({
    schemaVersion: 1,
    provider: 'task-019-fixture',
    model: 'fixture-model',
    apiKeyEnv: 'TASK019_FIXTURE_KEY',
    workingDirectory: workspace,
    baseUrl: 'http://127.0.0.1:9/v1',
    api: 'openai-completions',
  }));
  const token = randomBytes(32).toString('hex');
  const pair = generateKeyPairSync('ed25519');
  const approvalPublicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  child = spawn(process.execPath, ['dist/index.cjs', '--serve', '--port', '0'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      YUANPU_HOME: home,
      TASK019_FIXTURE_KEY: 'fixture-only',
      YUANPU_PYTHON_MCP_EXECUTABLE: '',
      YUANPU_PYTHON_MCP_ROOT: '',
    },
  });
  child.stdin.end(`${JSON.stringify({ token, approvalPublicKey, parentPid: process.pid })}\n`);
  const ready = await waitForReady(child);
  const response = await fetch(`http://${ready.host}:${ready.port}/v1/schedules`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      contractVersion: 1,
      name: 'IM delivery acceptance probe',
      prompt: 'fixture only',
      workspaceId: workspace,
      timing: { kind: 'once', at: '2099-01-01T00:00:00.000Z' },
      timeZone: 'UTC',
      delivery: { kind: 'channel', routeId: 'fixture-bound-route' },
    }),
  });
  const body = await response.json();
  const schedulesResponse = await fetch(`http://${ready.host}:${ready.port}/v1/schedules`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const schedules = await schedulesResponse.json();
  console.log(JSON.stringify({
    status: response.status,
    error: body.error ?? null,
    scheduleCount: schedules.length,
  }));
  if (response.status !== 201) process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(resolve, 2_000).unref();
    });
  }
  await rm(root, { recursive: true, force: true });
}
