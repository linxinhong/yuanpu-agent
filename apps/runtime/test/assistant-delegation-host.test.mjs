import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createReadOnlyProfessionalTaskHost } = require('../dist/index.cjs');

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
