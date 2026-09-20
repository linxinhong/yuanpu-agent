import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createYuanpuCapabilityTools,
  createYuanpuChatSession,
  PI_UPSTREAM_VERSION,
} from '../dist/index.mjs';

test('Pi receives only the two Yuanpu external capability tools', () => {
  const client = {
    async search() { return { matches: [] }; },
    async execute(input) { return { content: null, capability: input.name, riskLevel: 'R0' }; },
  };
  const tools = createYuanpuCapabilityTools(client);
  assert.equal(PI_UPSTREAM_VERSION, '0.86.1');
  assert.deepEqual(tools.map((tool) => tool.name), ['search_capabilities', 'execute_capability']);
});

test('custom OpenAI-compatible model config is materialized outside Pi upstream packages', async (context) => {
  const agentDir = await mkdtemp(join(tmpdir(), 'yuanpu-pi-custom-'));
  context.after(() => rm(agentDir, { recursive: true, force: true }));
  const capabilityClient = {
    async search() { return { matches: [] }; },
    async execute() { throw new Error('not used'); },
  };

  const chat = await createYuanpuChatSession({
    capabilityClient,
    agentDir,
    cwd: agentDir,
    provider: 'custom',
    model: 'LongCat-2.0',
    apiKeyEnv: 'LONGCAT_API_KEY',
    baseUrl: 'https://api.example.test/openai/v1',
    api: 'openai-completions',
  });
  context.after(() => chat.dispose());

  const models = JSON.parse(await readFile(join(agentDir, 'yuanpu-models.json'), 'utf8'));
  assert.equal(models.providers.custom.models[0].id, 'LongCat-2.0');
  assert.equal(models.providers.custom.apiKey, '$LONGCAT_API_KEY');
});
