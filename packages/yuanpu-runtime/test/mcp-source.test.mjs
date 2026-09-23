import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';

import {
  CapabilityError,
  CapabilityApprovalStore,
  createDemoCapabilitySource,
  createYuanpuMcpServer,
  ManagedMcpCapabilitySource,
  ManagedMcpSourceError,
} from '../dist/index.mjs';

const pythonRoot = resolve('../../apps/python-capabilities');
const pythonExecutable = process.platform === 'win32'
  ? join(pythonRoot, '.venv', 'Scripts', 'python.exe')
  : join(pythonRoot, '.venv', 'bin', 'python');
const testPrivateHome = await mkdtemp(join(tmpdir(), 'yuanpu-mcp-test-'));
const windowsDiagnosticFile = join(testPrivateHome, 'supervisor-stages.log');
after(() => rm(testPrivateHome, { recursive: true, force: true }));

function pythonSource(overrides = {}) {
  return new ManagedMcpCapabilitySource({
    sourceInstanceId: 'test.python.echo',
    packageVersion: '0.1.0',
    command: pythonExecutable,
    args: ['-m', 'yuanpu_echo_mcp'],
    cwd: pythonRoot,
    privateHome: join(testPrivateHome, randomUUID()),
    riskPolicy: {
      yuanpu_echo_text: 'R0',
      yuanpu_diagnostic_error: 'R0',
      yuanpu_wait: 'R0',
      yuanpu_spawn_child: 'R0',
      yuanpu_spawn_child_and_exit: 'R0',
    },
    env: {
      PATH: dirname(pythonExecutable),
      PYTHONPATH: join(pythonRoot, 'src'),
      PYTHONUNBUFFERED: '1',
      ...(process.platform === 'win32' ? { YUANPU_MCP_DIRECT_TEST: '1' } : {}),
      ...(process.platform === 'win32' ? { YUANPU_MCP_DIAGNOSTIC_FILE: windowsDiagnosticFile } : {}),
      YUANPU_MCP_TEST_FIXTURES: '1',
      ...(process.platform === 'win32' && process.env.SYSTEMROOT
        ? { SYSTEMROOT: process.env.SYSTEMROOT }
        : {}),
    },
    ...overrides,
  });
}

test('real Python MCP discovery and execution preserve structured results and errors', async (context) => {
  await access(pythonExecutable);
  const source = pythonSource({ initializationTimeoutMs: process.platform === 'win32' ? 90_000 : undefined });
  context.after(() => source.close());
  const server = createYuanpuMcpServer([source], undefined, {
    discoveryTimeoutMs: process.platform === 'win32' ? 90_000 : undefined,
  });
  const search = await server.search({ query: 'echo' });
  const echo = search.matches.find((match) => match.originalName === 'yuanpu_echo_text');
  const stages = process.platform === 'win32'
    ? await readFile(windowsDiagnosticFile, 'utf8').catch(() => 'no supervisor stage')
    : '';
  const childStderr = process.platform === 'win32'
    ? await readFile(`${windowsDiagnosticFile}.stderr`, 'utf8').catch(() => 'no child stderr')
    : '';
  assert.ok(echo, `${JSON.stringify(search)}; stages=${stages}; child stderr=${childStderr}`);
  const result = await server.execute({ name: echo.name, arguments: { text: '源谱' } });
  assert.deepEqual(result.structuredContent, { text: '源谱', length: 2 });
  assert.equal(result.content[0].type, 'text');
  assert.ok(source.processId);

  const dialogSearch = await server.search({ query: 'desktop message' });
  const dialog = dialogSearch.matches.find((match) => match.originalName === 'yuanpu_show_message');
  assert.ok(dialog);
  assert.equal(dialog.riskLevel, 'R2');
  assert.equal(dialog.status, 'needs_approval');
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

test('close terminates descendants instead of only the MCP server pid', async () => {
  const source = pythonSource();
  const server = createYuanpuMcpServer([source]);
  const match = (await server.search({ query: 'spawn child' })).matches
    .find((capability) => capability.originalName === 'yuanpu_spawn_child');
  assert.ok(match);
  const result = await server.execute({ name: match.name });
  const childPid = result.structuredContent?.pid;
  assert.equal(typeof childPid, 'number');
  process.kill(childPid, 0);
  await source.close();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  assert.throws(() => process.kill(childPid, 0));
});

test('an unexpected MCP root exit terminates its process group', async () => {
  const source = pythonSource();
  const server = createYuanpuMcpServer([source]);
  const match = (await server.search({ query: 'spawn child exit' })).matches
    .find((capability) => capability.originalName === 'yuanpu_spawn_child_and_exit');
  assert.ok(match);
  const result = await server.execute({ name: match.name });
  const childPid = result.structuredContent?.pid;
  assert.equal(typeof childPid, 'number');
  process.kill(childPid, 0);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
  assert.throws(() => process.kill(childPid, 0));
  await source.close();
});

test('a persisted approval is consumed before a real dispatch crash and is never replayed', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-mcp-dispatch-crash-'));
  const approvalPath = join(root, 'approvals.json');
  const markerPath = join(root, 'marker.txt');
  const source = pythonSource({ executionTimeoutMs: 1_000 });
  context.after(async () => {
    await source.close();
    await rm(root, { recursive: true, force: true });
  });
  let store = await CapabilityApprovalStore.open(approvalPath, {
    createId: () => 'dispatch-crash-approval',
  });
  let server = createYuanpuMcpServer([source], store);
  const search = await server.search({ query: 'write marker exit', limit: 20 });
  const match = search.matches
    .find((capability) => capability.originalName === 'yuanpu_write_marker_and_exit');
  assert.ok(match, JSON.stringify(search));
  const execution = { name: match.name, arguments: { marker: markerPath } };
  const hostContext = { sessionId: 'stage-verification', workspaceId: root };
  let requestId;
  await assert.rejects(server.execute(execution, hostContext), (error) => {
    requestId = error.failure.approvalRequestId;
    return error instanceof CapabilityError && error.failure.error === 'needs_approval';
  });
  await store.decide(requestId, 'approved');
  await assert.rejects(
    server.execute({ ...execution, approvalRequestId: requestId }, hostContext),
    (error) => error instanceof CapabilityError && error.failure.error === 'result_unknown',
  );
  assert.equal(await readFile(markerPath, 'utf8'), 'executed\n');
  const persisted = JSON.parse(await readFile(approvalPath, 'utf8'));
  assert.equal(persisted.records[0].status, 'consumed');

  store = await CapabilityApprovalStore.open(approvalPath);
  server = createYuanpuMcpServer([source], store);
  await assert.rejects(
    server.execute({ ...execution, approvalRequestId: requestId }, hostContext),
    (error) => error instanceof CapabilityError && error.failure.error === 'approval_invalid',
  );
  assert.equal(await readFile(markerPath, 'utf8'), 'executed\n');
});

test('untrusted MCP annotations cannot downgrade host approval policy', async (context) => {
  const source = pythonSource({ riskPolicy: {} });
  context.after(() => source.close());
  const match = (await createYuanpuMcpServer([source]).search({ query: 'echo' })).matches
    .find((capability) => capability.originalName === 'yuanpu_echo_text');
  assert.ok(match);
  assert.equal(match.riskLevel, 'R2');
  assert.equal(match.status, 'needs_approval');
});

test('one failed source does not hide healthy capabilities', async () => {
  let hangingCalls = 0;
  const hanging = {
    sourceInstanceId: 'test.hanging',
    async list(context) {
      hangingCalls += 1;
      return new Promise((_resolve, reject) => {
        context.signal?.addEventListener('abort', () => reject(context.signal.reason), { once: true });
      });
    },
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
  const repeated = await server.search({ query: 'echo' });
  assert.equal(repeated.matches.length, 1);
  assert.equal(hangingCalls, 2, 'a timed-out discovery can recover on a later search');
});

test('a real unresponsive process does not hide a healthy Python MCP source', async (context) => {
  const healthy = pythonSource({ sourceInstanceId: 'test.real-python-healthy' });
  const unresponsive = pythonSource({
    sourceInstanceId: 'test.real-process-unresponsive',
    args: ['-c', 'import time; time.sleep(10)'],
    initializationTimeoutMs: 200,
    restartLimit: 1,
  });
  context.after(async () => {
    await Promise.all([healthy.close(), unresponsive.close()]);
  });
  const server = createYuanpuMcpServer(
    [unresponsive, healthy],
    undefined,
    { discoveryTimeoutMs: process.platform === 'win32' ? 15_000 : 2_000 },
  );
  const result = await server.search({ query: 'echo', limit: 20 });
  assert.equal(
    result.matches.some((capability) => capability.sourceInstanceId === 'test.real-python-healthy'),
    true,
  );
  assert.equal(result.failures?.[0]?.sourceInstanceId, 'test.real-process-unresponsive');
  assert.match(result.failures?.[0]?.message ?? '', /initialization failed|timeout/i);
});

test('close interrupts an MCP process that is still stuck in initialization', async () => {
  const source = pythonSource({
    sourceInstanceId: 'test.initialization-close',
    command: process.execPath,
    args: ['-e', 'setInterval(() => undefined, 60000)'],
    initializationTimeoutMs: 1_000,
  });
  const connecting = source.list({});
  let pid = source.processId;
  for (let attempt = 0; !pid && attempt < 50; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    pid = source.processId;
  }
  assert.ok(pid);
  const startedAt = Date.now();
  await source.close();
  assert.ok(Date.now() - startedAt < 500, 'close waited for the initialization timeout');
  await assert.rejects(connecting, /initialization failed|closing|closed/i);
  assert.throws(() => process.kill(pid, 0));
});

test('tool discovery timeout terminates the initialized MCP process', async () => {
  const fixture = resolve('test/fixtures/hanging-list-tools.mjs');
  const source = pythonSource({
    sourceInstanceId: 'test.hanging-list-tools',
    command: process.execPath,
    args: [fixture],
    initializationTimeoutMs: process.platform === 'win32' ? 15_000 : 1_000,
    discoveryTimeoutMs: 100,
  });
  const discovery = source.list({});
  let pid = source.processId;
  for (let attempt = 0; !pid && attempt < 50; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    pid = source.processId;
  }
  assert.ok(pid);
  await assert.rejects(discovery, /tool discovery failed.*timed out/i);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  assert.equal(source.processId, null);
  assert.throws(() => process.kill(pid, 0));
  await source.close();
});

test('concurrent discovery waiters have independent cancellation', async () => {
  let calls = 0;
  const definition = {
    name: 'shared',
    description: 'Shared delayed capability',
    type: 'mcp_tool',
    riskLevel: 'R0',
    status: 'available',
    inputSchema: { type: 'object' },
    packageVersion: '1.0.0',
  };
  const source = {
    sourceInstanceId: 'test.shared-discovery',
    async list() {
      calls += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      return [definition];
    },
    async resolve() { return definition; },
    async execute() { return { content: [] }; },
  };
  const server = createYuanpuMcpServer([source], undefined, { discoveryTimeoutMs: 500 });
  const firstController = new AbortController();
  const first = server.search({}, { sessionId: 'shared', signal: firstController.signal });
  const second = server.search({}, { sessionId: 'shared' });
  firstController.abort();
  await assert.rejects(first, /cancelled/i);
  assert.equal((await second).matches.length, 1);
  assert.equal(calls, 1);
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

test('resolve failures use the stable capability error contract', async () => {
  const definition = {
    name: 'unstable',
    description: 'Unstable capability',
    type: 'mcp_tool',
    riskLevel: 'R0',
    status: 'available',
    inputSchema: { type: 'object' },
    packageVersion: '1.0.0',
  };
  const source = {
    sourceInstanceId: 'test.resolve-error',
    async list() { return [definition]; },
    async resolve() { throw new ManagedMcpSourceError('timeout', 'resolve timed out'); },
    async execute() { throw new Error('must not execute'); },
  };
  const server = createYuanpuMcpServer([source]);
  const capability = (await server.search({})).matches[0];
  await assert.rejects(
    server.execute({ name: capability.name }),
    (error) => error instanceof CapabilityError && error.failure.error === 'timeout',
  );
});
