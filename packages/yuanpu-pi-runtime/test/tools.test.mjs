import assert from 'node:assert/strict';
import test from 'node:test';

import { createYuanpuCapabilityTools, PI_UPSTREAM_VERSION } from '../dist/index.mjs';

test('Pi receives only the two Yuanpu external capability tools', () => {
  const client = {
    async search() { return { matches: [] }; },
    async execute(input) { return { content: null, capability: input.name, riskLevel: 'R0' }; },
  };
  const tools = createYuanpuCapabilityTools(client);
  assert.equal(PI_UPSTREAM_VERSION, '0.86.1');
  assert.deepEqual(tools.map((tool) => tool.name), ['search_capabilities', 'execute_capability']);
});
