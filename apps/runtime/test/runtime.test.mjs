import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('runtime CLI prints the default greeting from @yuanpu-agent/core', () => {
  const output = execFileSync(process.execPath, ['dist/index.cjs'], { encoding: 'utf8' });
  assert.equal(output.trim(), 'Hello, world!');
});

test('runtime CLI accepts a name', () => {
  const output = execFileSync(process.execPath, ['dist/index.cjs', '--name', 'CI'], {
    encoding: 'utf8',
  });
  assert.equal(output.trim(), 'Hello, CI!');
});

test('runtime server exposes its protocol and greeting', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'yuanpu-runtime-test-'));
  const token = 'integration-token';
  const child = spawn(process.execPath, [
    'dist/index.cjs', '--serve', '--port', '0', '--token', token,
  ], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, YUANPU_HOME: home },
  });
  context.after(async () => {
    child.kill();
    await rm(home, { recursive: true, force: true });
  });

  const ready = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('runtime server did not start')), 5_000);
    child.once('error', reject);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      resolve(JSON.parse(output.slice(0, newline)));
    });
  });

  const headers = { authorization: `Bearer ${token}` };
  const unauthorized = await fetch(`http://${ready.host}:${ready.port}/v1/health`);
  const health = await fetch(`http://${ready.host}:${ready.port}/v1/health`, { headers }).then((response) =>
    response.json(),
  );
  const greeting = await fetch(
    `http://${ready.host}:${ready.port}/v1/greeting?name=Integration`,
    { headers },
  ).then((response) => response.json());
  const invalidChat = await fetch(`http://${ready.host}:${ready.port}/v1/chat`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ message: '' }),
  });
  const unconfiguredChat = await fetch(`http://${ready.host}:${ready.port}/v1/chat`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Hello' }),
  });
  const unconfiguredError = await unconfiguredChat.json();

  assert.equal(unauthorized.status, 401);
  assert.equal(invalidChat.status, 400);
  assert.equal(unconfiguredChat.status, 500);
  assert.match(unconfiguredError.hint, /config\.json/);
  assert.deepEqual(health, {
    version: '0.1.0',
    protocolVersion: 1,
    piVersion: '0.86.1',
    mcpTools: ['search_capabilities', 'execute_capability'],
    configRoot: home,
  });
  assert.deepEqual(greeting, { message: 'Hello, Integration!' });
});
