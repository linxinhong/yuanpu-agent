import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPABILITY_TOOL_NAMES,
  CapabilityError,
  createCapabilityId,
  createDemoCapabilitySource,
  createYuanpuMcpServer,
  parseCapabilityId,
} from '../dist/index.mjs';

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
