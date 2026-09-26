import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AssistantDelegationCoordinator, createAssistantDelegationTool } from '@yuanpu-agent/assistant';

const require = createRequire(import.meta.url);
const { AssistantDelegationService } = require('../dist/index.cjs');

async function eventually(check) {
  const until = Date.now() + 3_000;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out awaiting delegated status.');
}

test('a replacement executor queries the same logical task and Assistant verifies opaque evidence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yp-delegation-swap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = join(root, 'host-ledger');
  const assistantHome = join(root, 'assistant');
  let firstRuns = 0;
  const first = new AssistantDelegationService(ledger, {
    async run() { firstRuns++; return { status: 'unknown', errorCode: 'response_lost' }; },
    async query() { return undefined; }, async cancel() {}, async close() {},
  });
  await first.open();
  const tool = createAssistantDelegationTool(new AssistantDelegationCoordinator(assistantHome, first), 'session_one');
  const started = JSON.parse((await tool.execute('stable_call', { action: 'start', skillName: 'reviewer',
    goal: 'Check one artifact.', completionCriteria: ['Evidence exists'], contextRefs: ['source:one'],
    readOnly: true })).content[0].text);
  await eventually(async () => (await first.status(started.taskId))?.status === 'unknown');
  await first.close();
  let secondRuns = 0;
  let secondQueries = 0;
  const replacement = new AssistantDelegationService(ledger, {
    async run() { secondRuns++; throw new Error('Replacement must not execute again.'); },
    async query(id) {
      secondQueries++;
      assert.equal(id, started.taskId);
      return { status: 'completed', resultRef: 'opaque:executor-result:fixture',
        evidenceRefs: ['source:one'], summary: 'Verified by replacement.' };
    },
    async cancel() {}, async close() {},
  });
  await replacement.open();
  const resumed = createAssistantDelegationTool(new AssistantDelegationCoordinator(assistantHome, replacement), 'session_one');
  const status = JSON.parse((await resumed.execute('status', { action: 'status', taskId: started.taskId })).content[0].text);
  assert.equal(status.status, 'completed');
  assert.equal(status.result.resultRef, 'opaque:executor-result:fixture');
  const evidence = JSON.parse((await resumed.execute('verify', { action: 'link_evidence', taskId: started.taskId,
    checks: [{ criterion: 'Evidence exists', evidenceRefs: ['source:one'] }] })).content[0].text);
  assert.equal(evidence.status, 'evidence_linked');
  assert.equal(firstRuns, 1);
  assert.equal(secondRuns, 0);
  assert.equal(secondQueries, 1);
  await replacement.close();
});
