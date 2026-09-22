import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CAPABILITY_TOOL_NAMES,
  CapabilityApprovalStore,
  CapabilityError,
  createCapabilityId,
  createDemoCapabilitySource,
  createYuanpuMcpServer,
  parseCapabilityId,
} from '../dist/index.mjs';

function sensitiveSource(onExecute = () => undefined, packageVersion = '1.2.3') {
  const definition = {
    name: 'publish',
    description: 'Publish external data',
    type: 'mcp_tool',
    riskLevel: 'R3',
    status: 'needs_approval',
    packageVersion,
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: { target: { type: 'string' } },
      additionalProperties: false,
    },
  };
  return {
    sourceInstanceId: 'test.sensitive',
    async list() { return [definition]; },
    async resolve(name) { return name === definition.name ? definition : undefined; },
    async execute() {
      onExecute();
      return { content: [{ type: 'text', text: 'published' }] };
    },
  };
}

test('the MCP surface always exposes exactly two meta tools', () => {
  const server = createYuanpuMcpServer();
  assert.deepEqual(server.listTools().map((tool) => tool.name), [
    CAPABILITY_TOOL_NAMES.search,
    CAPABILITY_TOOL_NAMES.execute,
  ]);
});

test('capability ids round-trip source instance and original tool without collisions', () => {
  const first = createCapabilityId('workspace/a', 'demo:echo');
  const second = createCapabilityId('workspace:a', 'demo/echo');
  assert.notEqual(first, second);
  assert.deepEqual(parseCapabilityId(first), {
    sourceInstanceId: 'workspace/a',
    originalName: 'demo:echo',
  });
  assert.equal(parseCapabilityId('demo:echo'), undefined);
});

test('capabilities are searched, schema-validated and executed through the registry', async () => {
  const sourceInstanceId = 'test.demo';
  const source = {
    sourceInstanceId,
    async list() {
      return [{
        name: 'echo',
        description: '回显外部文本',
        type: 'mcp_tool',
        riskLevel: 'R1',
        status: 'available',
        inputSchema: {
          type: 'object',
          required: ['payload'],
          properties: {
            payload: {
              oneOf: [
                { type: 'string' },
                { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
              ],
            },
          },
          additionalProperties: false,
        },
      }];
    },
    async resolve(name) { return name === 'echo' ? (await this.list())[0] : undefined; },
    async execute(input) {
      if (input.originalName !== 'echo') return undefined;
      return {
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { payload: input.arguments?.payload },
      };
    },
  };
  const server = createYuanpuMcpServer([source]);

  const search = await server.search({ query: '外部' });
  assert.equal(search.matches[0]?.sourceInstanceId, sourceInstanceId);
  assert.equal(search.matches[0]?.originalName, 'echo');
  const id = search.matches[0].name;
  const result = await server.execute({ name: id, arguments: { payload: { text: 'hello' } } });
  assert.deepEqual(result.structuredContent, { payload: { text: 'hello' } });
  assert.deepEqual(result.content, [{ type: 'text', text: 'ok' }]);

  await assert.rejects(
    server.execute({ name: id, arguments: { payload: 42 } }),
    (error) => error instanceof CapabilityError && error.failure.error === 'invalid_arguments',
  );
});

test('duplicate source identities are rejected instead of shadowing tools', () => {
  const source = {
    sourceInstanceId: 'duplicate',
    async list() { return []; },
    async resolve() { return undefined; },
    async execute() { return undefined; },
  };
  assert.throws(() => createYuanpuMcpServer([source, source]), /Duplicate capability source/);
});

test('model supplied approval ids do not authorize sensitive capabilities', async () => {
  let executions = 0;
  const descriptor = {
    name: 'publish',
    description: 'Publish external data',
    type: 'mcp_tool',
    riskLevel: 'R3',
    status: 'needs_approval',
    packageVersion: '1.2.3',
    inputSchema: { type: 'object' },
  };
  const server = createYuanpuMcpServer([{
    sourceInstanceId: 'test.sensitive',
    async list() { return [descriptor]; },
    async resolve(name) { return name === descriptor.name ? descriptor : undefined; },
    async execute() {
      executions += 1;
      return { content: [{ type: 'text', text: 'published' }] };
    },
  }]);
  const id = createCapabilityId('test.sensitive', 'publish');

  for (const approvalRequestId of [undefined, 'model-invented']) {
    await assert.rejects(
      server.execute({ name: id, approvalRequestId }),
      (error) => error instanceof CapabilityError && error.failure.error === 'needs_approval',
    );
  }
  assert.equal(executions, 0);
});

test('sensitive capabilities without immutable package versions are blocked', async () => {
  const source = sensitiveSource();
  const definition = (await source.list())[0];
  delete definition.packageVersion;
  const server = createYuanpuMcpServer([source], {
    async authorize() { throw new Error('authorizer must not be reached'); },
  });
  await assert.rejects(
    server.execute({
      name: createCapabilityId(source.sourceInstanceId, definition.name),
      arguments: { target: 'release' },
    }, { sessionId: 'session', workspaceId: '/workspace' }),
    (error) => error instanceof CapabilityError && error.failure.error === 'policy_blocked',
  );

  definition.packageVersion = '   ';
  await assert.rejects(
    server.execute({
      name: createCapabilityId(source.sourceInstanceId, definition.name),
      arguments: { target: 'release' },
    }, { sessionId: 'session', workspaceId: '/workspace' }),
    (error) => error instanceof CapabilityError && error.failure.error === 'policy_blocked',
  );
});

test('host approval is bound, atomically consumed once, and replay-safe', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-approval-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  let executions = 0;
  const store = await CapabilityApprovalStore.open(join(root, 'approvals.json'), {
    createId: () => 'host-request-1',
  });
  const server = createYuanpuMcpServer([sensitiveSource(() => { executions += 1; })], store);
  const capability = createCapabilityId('test.sensitive', 'publish');
  const execution = { name: capability, arguments: { target: 'release' } };
  const hostContext = { runId: 'run-a', sessionId: 'session-a', workspaceId: '/workspace/a' };

  let requestId;
  await assert.rejects(
    server.execute(execution, hostContext),
    (error) => {
      requestId = error.failure.approvalRequestId;
      return error instanceof CapabilityError
        && error.failure.error === 'needs_approval'
        && requestId === 'host-request-1';
    },
  );
  assert.equal((await store.listPending()).length, 1);
  assert.deepEqual(store.executionFor(requestId), {
    requestId,
    runId: hostContext.runId,
    sessionId: hostContext.sessionId,
    workspaceId: hostContext.workspaceId,
    capabilityId: capability,
    arguments: execution.arguments,
  });
  await store.decide(requestId, 'approved');

  const updatedServer = createYuanpuMcpServer([sensitiveSource(() => undefined, '2.0.0')], store);
  await assert.rejects(
    updatedServer.execute({ ...execution, approvalRequestId: requestId }, hostContext),
    (error) => error instanceof CapabilityError && error.failure.error === 'approval_invalid',
  );

  for (const [changed, changedContext] of [
    [{ target: 'other' }, hostContext],
    [execution.arguments, { ...hostContext, sessionId: 'session-b' }],
    [execution.arguments, { ...hostContext, workspaceId: '/workspace/b' }],
    [execution.arguments, { ...hostContext, runId: 'run-b' }],
  ]) {
    await assert.rejects(
      server.execute({ ...execution, arguments: changed, approvalRequestId: requestId }, changedContext),
      (error) => error instanceof CapabilityError && error.failure.error === 'approval_invalid',
    );
  }

  const attempts = await Promise.allSettled([
    server.execute({ ...execution, approvalRequestId: requestId }, hostContext),
    server.execute({ ...execution, approvalRequestId: requestId }, hostContext),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(executions, 1);
  assert.equal(store.executionFor(requestId), undefined);
  await assert.rejects(
    server.execute({ ...execution, approvalRequestId: requestId }, hostContext),
    (error) => error instanceof CapabilityError && error.failure.error === 'approval_invalid',
  );
});

test('run cancellation invalidates only approvals bound to that run', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-run-approval-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  let nextId = 0;
  const store = await CapabilityApprovalStore.open(join(root, 'approvals.json'), {
    createId: () => `request-${++nextId}`,
  });
  const base = {
    sessionId: 'session',
    workspaceId: '/workspace',
    sourceInstanceId: 'source',
    packageVersion: '1.0.0',
    capabilityId: 'capability',
    arguments: { value: 'fixture' },
  };
  await store.authorize({ ...base, runId: 'run-a' });
  await store.authorize({ ...base, runId: 'run-b' });
  await store.cancelRun('run-a');
  assert.deepEqual((await store.listPending()).map((record) => record.runId), ['run-b']);
  assert.equal(store.executionFor('request-1'), undefined);
  assert.equal(store.executionFor('request-2').runId, 'run-b');
});

test('expired, fabricated, denied and restarted approvals cannot execute', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-approval-state-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'approvals.json');
  let now = new Date('2026-09-21T00:00:00.000Z');
  let sequence = 0;
  const options = { ttlMs: 1_000, now: () => now, createId: () => `request-${++sequence}` };
  const capability = createCapabilityId('test.sensitive', 'publish');
  const execution = { name: capability, arguments: { target: 'release' } };
  const hostContext = { sessionId: 'session-a', workspaceId: '/workspace/a' };
  let store = await CapabilityApprovalStore.open(path, options);
  let server = createYuanpuMcpServer([sensitiveSource()], store);

  await assert.rejects(
    server.execute({ ...execution, approvalRequestId: 'fabricated' }, hostContext),
    (error) => error instanceof CapabilityError && error.failure.error === 'approval_invalid',
  );
  let requestId;
  await assert.rejects(server.execute(execution, hostContext), (error) => {
    requestId = error.failure.approvalRequestId;
    return true;
  });
  await store.decide(requestId, 'denied');
  await assert.rejects(
    server.execute({ ...execution, approvalRequestId: requestId }, hostContext),
    (error) => error instanceof CapabilityError && error.failure.error === 'approval_invalid',
  );

  await assert.rejects(server.execute(execution, hostContext), (error) => {
    requestId = error.failure.approvalRequestId;
    return true;
  });
  await store.decide(requestId, 'approved');
  now = new Date(now.getTime() + 2_000);
  await assert.rejects(
    server.execute({ ...execution, approvalRequestId: requestId }, hostContext),
    (error) => error instanceof CapabilityError && error.failure.error === 'approval_invalid',
  );

  now = new Date('2026-09-21T01:00:00.000Z');
  await assert.rejects(server.execute(execution, hostContext), (error) => {
    requestId = error.failure.approvalRequestId;
    return true;
  });
  await store.decide(requestId, 'approved');
  store = await CapabilityApprovalStore.open(path, options);
  server = createYuanpuMcpServer([sensitiveSource()], store);
  await assert.rejects(
    server.execute({ ...execution, approvalRequestId: requestId }, hostContext),
    (error) => error instanceof CapabilityError && error.failure.error === 'approval_invalid',
  );
});

test('demo capability completes discovery and preserves MCP result fields', async () => {
  const server = createYuanpuMcpServer([createDemoCapabilitySource()]);
  const search = await server.callTool(CAPABILITY_TOOL_NAMES.search, { query: 'echo' });
  const id = search.matches[0]?.name;
  assert.ok(id);
  const result = await server.callTool(CAPABILITY_TOOL_NAMES.execute, {
    name: id,
    arguments: { text: 'Yuanpu' },
  });
  assert.deepEqual(result.content, [{ type: 'text', text: 'Yuanpu' }]);
  assert.deepEqual(result.structuredContent, { text: 'Yuanpu' });
});
