import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';

import { ModelRuntime } from '@earendil-works/pi-coding-agent';
const require = createRequire(import.meta.url);
const { createProfessionalSession, createProfessionalTools, LocalProfessionalAdapter } = require('../dist/index.cjs');

const skill = (name) => `---\nname: ${name}\ndescription: Fixture professional skill.\n---\n\n# ${name}\nUse only authorized references.\n`;

test('professional task loads only its selected skill and two scoped tools', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-professional-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skillsRoot = join(root, 'professional-skills');
  const selected = join(skillsRoot, 'reviewer');
  const other = join(skillsRoot, 'writer');
  const assistantHome = join(root, 'assistant');
  const appPath = join(root, 'app');
  await Promise.all([mkdir(selected, { recursive: true }), mkdir(other, { recursive: true }),
    mkdir(assistantHome), mkdir(appPath)]);
  await writeFile(join(selected, 'SKILL.md'), skill('reviewer'));
  await writeFile(join(other, 'SKILL.md'), skill('writer'));
  await writeFile(join(assistantHome, 'MEMORY.md'), 'private assistant memory');
  await writeFile(join(root, 'AGENTS.md'), 'Untrusted project instructions must not enter child.');
  await writeFile(join(appPath, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions',
    models: [{ id: 'fixture-model', name: 'Fixture', reasoning: false, input: ['text'],
      contextWindow: 128000, maxTokens: 1024 }],
  } } }));
  await writeFile(join(appPath, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'fixture-only' } }));
  const modelRuntime = await ModelRuntime.create({
    authPath: join(appPath, 'auth.json'), modelsPath: join(appPath, 'models.json'),
  });
  const model = modelRuntime.getModel('fixture', 'fixture-model');
  assert.ok(model);
  const scope = { taskId: 'task_01', skillName: 'reviewer', contextRefs: ['source:allowed'],
    authorizedCapabilities: ['fixture.inspect'] };
  let reads = 0;
  let executions = 0;
  const host = {
    async authorizeTask() {},
    async readSource() { reads++; return 'bounded source'; },
    async executeCapability() { executions++; return { status: 'completed', resultRef: 'result:one' }; },
  };
  const opened = await createProfessionalSession({ root: join(root, 'delegations'), assistantHome,
    skillsRoot, scope, host, model, modelRuntime });
  t.after(async () => { await opened.session.abort(); opened.session.dispose(); });
  assert.deepEqual(opened.skillNames, ['reviewer']);
  assert.deepEqual(opened.activeToolNames, ['read_task_source', 'execute_authorized_capability']);
  assert.equal(opened.session.getAllTools().some((tool) => ['bash', 'read', 'write', 'edit'].includes(tool.name)), false);
  assert.equal(opened.session.getActiveToolNames().some((name) => ['bash', 'read', 'write', 'edit'].includes(name)), false);
  const [readSource, executeCapability] = createProfessionalTools(scope, host);
  await assert.rejects(readSource.execute('call', { ref: 'source:private' }), /outside the delegated scope/);
  await assert.rejects(executeCapability.execute('call', { name: 'fixture.modify', arguments: {} }), /outside the delegated scope/);
  assert.equal(reads, 0);
  assert.equal(executions, 0);
  assert.equal((await readSource.execute('call', { ref: 'source:allowed' })).content[0].text, 'bounded source');
  assert.equal((await executeCapability.execute('call', { name: 'fixture.inspect', arguments: {} })).details.resultRef, 'result:one');
  assert.equal(reads, 1);
  assert.equal(executions, 1);
  await assert.rejects(createProfessionalSession({ root: assistantHome, assistantHome,
    skillsRoot, scope: { ...scope, taskId: 'task_02' }, host, model, modelRuntime }), /separate from Assistant Home/);
  await symlink(assistantHome, join(root, 'alias-to-assistant'));
  await assert.rejects(createProfessionalSession({ root: join(root, 'alias-to-assistant', 'delegations'),
    assistantHome, skillsRoot, scope: { ...scope, taskId: 'task_04' }, host, model, modelRuntime }),
  /Symlinked delegation path/);
  await symlink(assistantHome, join(root, 'delegations', 'task_05'));
  await assert.rejects(createProfessionalSession({ root: join(root, 'delegations'), assistantHome,
    skillsRoot, scope: { ...scope, taskId: 'task_05' }, host, model, modelRuntime }),
  /Symlinked delegation path/);
  await symlink(other, join(skillsRoot, 'linked'));
  await assert.rejects(createProfessionalSession({ root: join(root, 'delegations'), assistantHome,
    skillsRoot, scope: { ...scope, taskId: 'task_03', skillName: 'linked' }, host, model, modelRuntime }), /regular skill/);
});

test('local Pi adapter follows up in one isolated task session without leaking Assistant Home', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-professional-turn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 0,
      model: 'fixture-model', choices: [{ index: 0,
        delta: { role: 'assistant', content: `evidence summary ${requests.length}` }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 0,
      model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const appPath = join(root, 'app');
  const skillsRoot = join(root, 'skills');
  const assistantHome = join(root, 'assistant');
  await Promise.all([mkdir(appPath), mkdir(join(skillsRoot, 'reviewer'), { recursive: true }), mkdir(assistantHome)]);
  await writeFile(join(skillsRoot, 'reviewer', 'SKILL.md'), skill('reviewer'));
  await writeFile(join(assistantHome, 'MEMORY.md'), 'PRIVATE_ASSISTANT_MEMORY_MARKER');
  await writeFile(join(root, 'AGENTS.md'), 'PRIVATE_PROJECT_INSTRUCTIONS_MARKER');
  await writeFile(join(appPath, 'models.json'), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions',
    models: [{ id: 'fixture-model', name: 'Fixture', reasoning: false, input: ['text'],
      contextWindow: 128000, maxTokens: 1024 }],
  } } }));
  await writeFile(join(appPath, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'fixture-only' } }));
  const modelRuntime = await ModelRuntime.create({ authPath: join(appPath, 'auth.json'),
    modelsPath: join(appPath, 'models.json') });
  const model = modelRuntime.getModel('fixture', 'fixture-model');
  assert.ok(model);
  const authorizations = [];
  const adapter = new LocalProfessionalAdapter({ root: join(root, 'delegations'), assistantHome,
    skillsRoot, model, modelRuntime, host: {
      async authorizeTask(brief) { authorizations.push(brief.taskId); if (!brief.readOnly) throw new Error('No write grant.'); },
      async readSource() { return 'bounded source'; },
      async executeCapability() { throw new Error('No capability grant.'); },
    } });
  t.after(() => adapter.close());
  const brief = { taskId: 'task_one', assistantSessionId: 'assistant_one', skillName: 'reviewer',
    goal: 'Check only the supplied source.', completionCriteria: ['Return a finding.'],
    contextRefs: ['source:one'], authorizedCapabilities: [], readOnly: true,
    deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  await assert.rejects(adapter.run({ ...brief, taskId: 'task_denied', readOnly: false }, undefined,
    new AbortController().signal), /No write grant/);
  assert.equal(requests.length, 0);
  const first = await adapter.run(brief, undefined, new AbortController().signal);
  assert.equal(first.status, 'completed');
  assert.match(first.resultRef, /^delegation-result:task_one:/);
  assert.equal((await adapter.query(brief.taskId)).resultRef, first.resultRef);
  const second = await adapter.run(brief, 'Check the finding again.', new AbortController().signal);
  assert.equal(second.status, 'completed');
  assert.equal(requests.length, 2);
  assert.equal(authorizations.length, 3);
  assert.match(requests[0], /Use only authorized references/);
  assert.match(requests[1], /Check the finding again/);
  for (const body of requests) {
    assert.doesNotMatch(body, /PRIVATE_ASSISTANT_MEMORY_MARKER|PRIVATE_PROJECT_INSTRUCTIONS_MARKER/);
    assert.doesNotMatch(body, /\"name\":\"bash\"|\"name\":\"read\"|\"name\":\"write\"|\"name\":\"edit\"/);
  }
});
