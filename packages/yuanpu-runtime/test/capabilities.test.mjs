import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPABILITY_TOOL_NAMES,
  CapabilityError,
  createDemoCapabilitySource,
  createYuanpuMcpServer,
} from '../dist/index.mjs';

test('the MCP surface always exposes exactly two meta tools', () => {
  const server = createYuanpuMcpServer();
  assert.deepEqual(
    server.listTools().map((tool) => tool.name),
    [CAPABILITY_TOOL_NAMES.search, CAPABILITY_TOOL_NAMES.execute],
  );
});

test('capabilities are searched and executed through the registry', async () => {
  const server = createYuanpuMcpServer([{
    async list() {
      return [{
        name: 'mcp:demo:echo',
        description: 'Echo external text',
        type: 'mcp_tool',
        riskLevel: 'R1',
        status: 'available',
        inputSchema: { type: 'object' },
      }];
    },
    async resolve(name) {
      if (name !== 'mcp:demo:echo') return undefined;
      return {
        name,
        description: 'Echo external text',
        type: 'mcp_tool',
        riskLevel: 'R1',
        status: 'available',
        inputSchema: { type: 'object' },
      };
    },
    async execute(input) {
      if (input.name !== 'mcp:demo:echo') return undefined;
      return { content: input.arguments ?? {}, capability: input.name, riskLevel: 'R1' };
    },
  }]);

  const search = await server.search({ query: 'echo' });
  assert.equal(search.matches[0]?.name, 'mcp:demo:echo');
  const result = await server.execute({ name: 'mcp:demo:echo', arguments: { text: 'hello' } });
  assert.deepEqual(result.content, { text: 'hello' });
});

test('sensitive capabilities require approval before their source is invoked', async () => {
  let executions = 0;
  const descriptor = {
    name: 'mcp:demo:publish',
    description: 'Publish external data',
    type: 'mcp_tool',
    riskLevel: 'R3',
    status: 'needs_approval',
    inputSchema: { type: 'object' },
  };
  const server = createYuanpuMcpServer([{
    async list() { return [descriptor]; },
    async resolve(name) { return name === descriptor.name ? descriptor : undefined; },
    async execute(input) {
      executions += 1;
      return { content: { published: true }, capability: input.name, riskLevel: 'R3' };
    },
  }]);

  await assert.rejects(
    server.execute({ name: descriptor.name }),
    (error) => error instanceof CapabilityError && error.failure.error === 'needs_approval',
  );
  assert.equal(executions, 0);

  const result = await server.execute({ name: descriptor.name, approvalToken: 'approved-once' });
  assert.deepEqual(result.content, { published: true });
  assert.equal(executions, 1);
});

test('unknown capability fails with a structured retry hint', async () => {
  const server = createYuanpuMcpServer();
  await assert.rejects(
    server.execute({ name: 'mcp:missing:none' }),
    (error) => error instanceof CapabilityError
      && error.failure.error === 'unknown_capability'
      && error.failure.retry.search,
  );
});

test('demo MCP capability completes the two-tool discovery and execution path', async () => {
  const server = createYuanpuMcpServer([createDemoCapabilitySource()]);
  const search = await server.callTool(CAPABILITY_TOOL_NAMES.search, { query: 'echo' });
  assert.equal(search.matches[0]?.name, 'yuanpu.echo');
  const result = await server.callTool(CAPABILITY_TOOL_NAMES.execute, {
    name: 'yuanpu.echo',
    arguments: { text: 'Yuanpu' },
  });
  assert.deepEqual(result.content, { text: 'Yuanpu' });
});
