import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createReadOnlyProfessionalTaskHost } = require('../dist/index.cjs');

test('production task grant scopes every source read and refuses model-proposed execution', async () => {
  const reads = [];
  const sources = { async readDelegatedSource(ref) { reads.push(ref); return `source:${ref}`; } };
  const host = createReadOnlyProfessionalTaskHost(sources);
  const brief = { taskId: 'task_one', assistantSessionId: 'assistant_one',
    skillName: 'reviewer', goal: 'Review', completionCriteria: ['Cite source'],
    contextRefs: ['work-turn:one'], authorizedCapabilities: [], readOnly: true,
    deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  const grant = await host.authorizeTask(brief);
  assert.equal(await grant.readSource('work-turn:one'), 'source:work-turn:one');
  await assert.rejects(grant.readSource('work-turn:two'), /outside this task grant/);
  await assert.rejects(grant.executeCapability({ name: 'fixture.inspect', arguments: {} }), /trusted user grant/);
  assert.deepEqual(reads, ['work-turn:one']);
  await assert.rejects(host.authorizeTask({ ...brief, readOnly: false }), /trusted user grant/);
  await assert.rejects(host.authorizeTask({ ...brief,
    authorizedCapabilities: ['fixture.inspect'] }), /trusted user grant/);
});
