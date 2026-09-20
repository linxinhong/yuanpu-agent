import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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
  const child = spawn(process.execPath, ['dist/index.cjs', '--serve', '--port', '0'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  context.after(() => child.kill());

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

  const health = await fetch(`http://${ready.host}:${ready.port}/v1/health`).then((response) =>
    response.json(),
  );
  const greeting = await fetch(
    `http://${ready.host}:${ready.port}/v1/greeting?name=Integration`,
  ).then((response) => response.json());

  assert.deepEqual(health, {
    version: '0.1.0',
    protocolVersion: 1,
    piVersion: '0.86.1',
    mcpTools: ['search_capabilities', 'execute_capability'],
  });
  assert.deepEqual(greeting, { message: 'Hello, Integration!' });
});
