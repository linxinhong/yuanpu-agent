import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  CapabilityError,
  createDemoCapabilitySource,
  createYuanpuMcpServer,
  ManagedMcpCapabilitySource,
  ManagedMcpSourceError,
} from '../dist/index.mjs';

const pythonRoot = resolve('../../apps/python-capabilities');
const pythonExecutable = process.platform === 'win32'
  ? join(pythonRoot, '.venv', 'Scripts', 'python.exe')
  : join(pythonRoot, '.venv', 'bin', 'python');

function pythonSource(overrides = {}) {
  return new ManagedMcpCapabilitySource({
    sourceInstanceId: 'test.python.echo',
    packageVersion: '0.1.0',
    command: pythonExecutable,
    args: ['-m', 'yuanpu_echo_mcp'],
    cwd: pythonRoot,
    env: {
      PATH: dirname(pythonExecutable),
      PYTHONPATH: join(pythonRoot, 'src'),
      PYTHONUNBUFFERED: '1',
      ...(process.platform === 'win32' && process.env.SYSTEMROOT
        ? { SYSTEMROOT: process.env.SYSTEMROOT }
        : {}),
    },
    ...overrides,
  });
}

test('real Python MCP discovery and execution preserve structured results and errors', async (context) => {
  await access(pythonExecutable);
  const source = pythonSource();
  context.after(() => source.close());
  const server = createYuanpuMcpServer([source]);
  const search = await server.search({ query: 'echo' });
  const echo = search.matches.find((match) => match.originalName === 'yuanpu_echo_text');
  assert.ok(echo);
  const result = await server.execute({ name: echo.name, arguments: { text: '源谱' } });
  assert.deepEqual(result.structuredContent, { text: '源谱', length: 2 });
  assert.equal(result.content[0].type, 'text');
  assert.ok(source.processId);

  const all = await server.search({});
  const diagnostic = all.matches.find((match) => match.originalName === 'yuanpu_diagnostic_error');
  assert.ok(diagnostic);
  const failure = await server.execute({ name: diagnostic.name });
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /diagnostic error/i);
});

test('cancellation reaches a real Python MCP call and close terminates the child', async () => {
  const source = pythonSource({ executionTimeoutMs: 5_000 });
  const server = createYuanpuMcpServer([source]);
  const match = (await server.search({ query: 'wait' })).matches
    .find((capability) => capability.originalName === 'yuanpu_wait');
  assert.ok(match);
  const controller = new AbortController();
  const call = server.execute(
    { name: match.name, arguments: { seconds: 5 } },
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 50).unref();
  await assert.rejects(
    call,
    (error) => error instanceof CapabilityError && error.failure.error === 'cancelled',
  );
  const pid = source.processId;
  assert.ok(pid);
  await source.close();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  assert.throws(() => process.kill(pid, 0));
});

test('one failed source does not hide healthy capabilities', async () => {
  const hanging = {
    sourceInstanceId: 'test.hanging',
    async list() { return new Promise(() => undefined); },
    async resolve() { return undefined; },
    async execute() { return undefined; },
  };
  const server = createYuanpuMcpServer(
    [hanging, createDemoCapabilitySource()],
    undefined,
    { discoveryTimeoutMs: 25, discoveryCacheTtlMs: 25 },
  );
  const result = await server.search({ query: 'echo' });
  assert.equal(result.matches.length, 1);
  assert.equal(result.failures?.[0]?.sourceInstanceId, 'test.hanging');
  assert.equal(result.failures?.[0]?.error, 'timeout');
});

test('initialization failures respect the restart budget', async () => {
  const source = pythonSource({
    command: process.platform === 'win32' ? 'C:\\missing\\python.exe' : '/missing/python',
    restartLimit: 2,
    restartBackoffMs: 60_000,
  });
  await assert.rejects(source.list({}), ManagedMcpSourceError);
  await assert.rejects(source.list({}), ManagedMcpSourceError);
  await assert.rejects(source.list({}), /restart budget is exhausted/);
  await source.close();
});

test('an unknown side-effect outcome is never retried by the registry', async () => {
  let attempts = 0;
  const definition = {
    name: 'write_once',
    description: 'Write once',
    type: 'mcp_tool',
    riskLevel: 'R1',
    status: 'available',
    inputSchema: { type: 'object' },
    packageVersion: '1.0.0',
  };
  const source = {
    sourceInstanceId: 'test.side-effect',
    async list() { return [definition]; },
    async resolve() { return definition; },
    async execute() {
      attempts += 1;
      throw new ManagedMcpSourceError('result_unknown', 'connection closed after dispatch');
    },
  };
  const server = createYuanpuMcpServer([source]);
  const capability = (await server.search({})).matches[0];
  await assert.rejects(
    server.execute({ name: capability.name }),
    (error) => error instanceof CapabilityError && error.failure.error === 'result_unknown',
  );
  assert.equal(attempts, 1);
});
