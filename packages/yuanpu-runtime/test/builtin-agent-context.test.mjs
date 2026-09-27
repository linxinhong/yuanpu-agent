import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createYuanpuChatSession } from '../dist/index.mjs';

const builtinAgentRoot = fileURLToPath(new URL('../../../apps/app/agents/', import.meta.url));

test('Work Pi session loads bundled AGENTS.md before workspace context and discovers bundled skills', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-builtin-agent-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'AGENTS.md'), '# Workspace instructions\n\nPROJECT_CONTEXT_MARKER\n');

  let systemPrompt = '';
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const messages = JSON.parse(body).messages;
    systemPrompt = String(messages.find((message) => message.role === 'system')?.content ?? '');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"Ready."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  await writeFile(join(root, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl, api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
      contextWindow: 128000, maxTokens: 1024 }],
  } } }));

  const chat = await createYuanpuChatSession({
    capabilityClient: { async search() { return { matches: [] }; }, async execute() { throw new Error('not used'); } },
    agentDir: root, modelConfigDir: root, cwd: workspace, provider: 'fixture', model: 'fixture',
    apiKey: 'fixture-only', builtinAgentRoot,
    browserControlAvailable: true,
  });
  context.after(() => chat.dispose());
  await chat.prompt('Reply briefly.');

  assert.match(systemPrompt, /Yuanpu Agent conversation guide/);
  assert.match(systemPrompt, /html-preview/);
  assert.match(systemPrompt, /markdown-visuals/);
  assert.match(systemPrompt, /browser-control/);
  assert.match(systemPrompt, /Save user-facing artifacts with relative paths under cwd, not \/tmp/);
  assert.match(systemPrompt, /Do not create a file, start a server, or navigate the browser merely to display a diagram/);
  assert.ok(systemPrompt.indexOf('Yuanpu Agent conversation guide') < systemPrompt.indexOf('PROJECT_CONTEXT_MARKER'));
});
