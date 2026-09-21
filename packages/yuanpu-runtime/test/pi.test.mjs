import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createYuanpuCapabilityTools,
  createYuanpuChatSession,
  inspectYuanpuExtensions,
  inspectYuanpuSkills,
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

test('Pi preserves supported MCP blocks and keeps unsupported blocks in details', async () => {
  const mcpResult = {
    capability: 'ypcap:test:result',
    sourceInstanceId: 'test',
    riskLevel: 'R0',
    content: [
      { type: 'text', text: 'hello' },
      { type: 'resource_link', name: 'report', uri: 'file:///report.txt' },
    ],
    structuredContent: { count: 1 },
    isError: true,
  };
  const tools = createYuanpuCapabilityTools({
    async search() { return { matches: [] }; },
    async execute() { return mcpResult; },
  });
  const result = await tools[1].execute('call-1', { name: mcpResult.capability });
  assert.equal(result.details, mcpResult);
  assert.deepEqual(result.content, [
    { type: 'text', text: '[The external capability reported an error]' },
    { type: 'text', text: 'hello' },
    { type: 'text', text: '[Unsupported MCP resource_link content preserved in tool details]' },
  ]);
});

test('Pi receives the host approval request id as a structured capability error', async () => {
  const failure = {
    error: 'needs_approval',
    message: 'Approval required.',
    retry: { search: false, action: 'request_approval' },
    approvalRequestId: 'host-request-1',
  };
  const tools = createYuanpuCapabilityTools({
    async search() { return { matches: [] }; },
    async execute() { throw Object.assign(new Error(failure.message), { failure }); },
  });
  const result = await tools[1].execute('call-1', { name: 'ypcap:test:approval' });
  assert.deepEqual(result.details, { capabilityError: failure });
  assert.deepEqual(JSON.parse(result.content[0].text), { capabilityError: failure });
});

test('skill inspection lists user skills from the Yuanpu Agent directory', async (context) => {
  const agentDir = await mkdtemp(join(tmpdir(), 'yuanpu-pi-skill-'));
  context.after(() => rm(agentDir, { recursive: true, force: true }));
  const skillDir = join(agentDir, 'skills', 'meeting-notes');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(skillDir, { recursive: true }));
  await writeFile(join(skillDir, 'SKILL.md'), [
    '---',
    'name: meeting-notes',
    'description: Turn meeting notes into action items.',
    '---',
    '',
    '# Meeting notes',
  ].join('\n'));

  const result = await inspectYuanpuSkills({ agentDir, cwd: agentDir });
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].name, 'meeting-notes');
});

test('extension inspection reports a broken user plugin without modifying Pi upstream', async (context) => {
  const agentDir = await mkdtemp(join(tmpdir(), 'yuanpu-pi-extension-'));
  context.after(() => rm(agentDir, { recursive: true, force: true }));
  const extensionPath = join(agentDir, 'broken-extension.js');
  await writeFile(extensionPath, 'export default function () { throw new Error("broken extension fixture"); }\n');
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: [extensionPath] }));

  const diagnostics = await inspectYuanpuExtensions({ agentDir, cwd: agentDir });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].path, extensionPath);
  assert.match(diagnostics[0].error, /broken extension fixture/);
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
