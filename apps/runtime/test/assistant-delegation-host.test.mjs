import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createProfessionalTaskHost, createReadOnlyProfessionalTaskHost } = require('../dist/index.cjs');

test('production task grant scopes every source read and refuses model-proposed execution', async () => {
  const reads = [];
  let version = 'version-one';
  const sources = {
    async delegatedSourceVersion() { return version; },
    async readDelegatedSource(ref, expectedVersion) {
      reads.push([ref, expectedVersion]);
      if (expectedVersion !== version) throw new Error('Delegated source changed after authorization.');
      return `source:${ref}`;
    },
  };
  const host = createReadOnlyProfessionalTaskHost(sources);
  const brief = { taskId: 'task_one', assistantSessionId: 'assistant_one',
    skillName: 'reviewer', goal: 'Review', completionCriteria: ['Cite source'],
    contextRefs: ['work-turn:one'], authorizedCapabilities: [], readOnly: true,
    deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  const grant = await host.authorizeTask(brief);
  assert.equal(await grant.readSource('work-turn:one'), 'source:work-turn:one');
  await assert.rejects(grant.readSource('work-turn:two'), /outside this task grant/);
  await assert.rejects(grant.executeCapability({ name: 'fixture.inspect', arguments: {} }), /trusted user grant/);
  version = 'version-two';
  await assert.rejects(grant.readSource('work-turn:one'), /changed after authorization/);
  assert.deepEqual(reads, [['work-turn:one', 'version-one'], ['work-turn:one', 'version-one']]);
  await assert.rejects(host.authorizeTask({ ...brief, readOnly: false }), /trusted user grant/);
  await assert.rejects(host.authorizeTask({ ...brief,
    authorizedCapabilities: ['fixture.inspect'] }), /trusted user grant/);
});

test('task-level approval binds capabilities but concrete effects still use MCP approval', async () => {
  const calls = [];
  let grantActive = true;
  const sources = { async delegatedSourceVersion() { return 'v1'; },
    async readDelegatedSource() { return 'source'; } };
  const brief = { taskId: 'task_capability', assistantSessionId: 'session_one',
    skillName: 'reviewer', goal: 'Inspect', completionCriteria: ['Report result'],
    contextRefs: [], authorizedCapabilities: ['fixture.inspect'], readOnly: false,
    deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  const host = createProfessionalTaskHost(sources, {
    async execute(input, context) {
      calls.push([input.name, context.sessionId, context.workspaceId]);
      if (!input.approvalRequestId) throw { failure: { error: 'needs_approval',
        approvalRequestId: 'effect_one' } };
      return { content: [{ type: 'text', text: 'inspected' }] };
    },
  }, async (candidate, grant) => grantActive && candidate.taskId === brief.taskId && grant === 'task_grant');
  await assert.rejects(host.authorizeTask(brief), /trusted user grant/);
  await assert.rejects(host.authorizeTask(brief, 'other'), /trusted user grant/);
  const access = await host.authorizeTask(brief, 'task_grant');
  const pending = await access.executeCapability({ name: 'fixture.inspect', arguments: {} });
  assert.equal(pending.status, 'needs_approval');
  assert.equal(pending.approvalRequestId, 'effect_one');
  await assert.rejects(access.executeCapability({ name: 'fixture.write', arguments: {} }), /trusted user grant/);
  const completed = await access.executeCapability({ name: 'fixture.inspect', arguments: {},
    approvalRequestId: 'effect_one' });
  assert.equal(completed.status, 'completed');
  assert.match(completed.resultRef, /^capability-result:task_capability:/);
  assert.deepEqual(calls, [['fixture.inspect', 'session_one', 'assistant-delegation:task_capability'],
    ['fixture.inspect', 'session_one', 'assistant-delegation:task_capability']]);
  grantActive = false;
  await assert.rejects(access.executeCapability({ name: 'fixture.inspect', arguments: {} }), /no longer active/);
  assert.equal(calls.length, 2, 'revoked task grant cannot reach MCP');
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(access.executeCapability({ name: 'fixture.inspect', arguments: {} }, aborted.signal),
    /aborted/i);
  assert.equal(calls.length, 2);
});
