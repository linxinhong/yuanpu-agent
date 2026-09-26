import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AssistantDelegationCoordinator, createAssistantDelegationTool } from '../dist/index.mjs';

test('delegation tool keeps one durable task ID and links only returned evidence', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'yp-assistant-delegation-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const records = new Map();
  let starts = 0;
  const host = {
    async start(brief) {
      starts++;
      const previous = records.get(brief.taskId);
      if (previous) return previous;
      const record = { ...brief, status: 'completed', followUps: [],
        result: { status: 'completed', resultRef: 'result:one', evidenceRefs: ['source:one'] },
        createdAt: '2026-09-26T00:00:00Z', updatedAt: '2026-09-26T00:00:00Z' };
      records.set(brief.taskId, record);
      return record;
    },
    async status(taskId) { return records.get(taskId); },
    async followUp(taskId, sessionId, text) {
      const record = records.get(taskId);
      assert.equal(sessionId, record.assistantSessionId);
      const updated = { ...record, followUps: [...record.followUps, text] };
      records.set(taskId, updated);
      return updated;
    },
    async cancel(taskId) { return records.get(taskId); },
  };
  const coordinator = new AssistantDelegationCoordinator(home, host);
  const tool = createAssistantDelegationTool(coordinator, 'session_one');
  const input = { action: 'start', skillName: 'reviewer', goal: 'Inspect source one.',
    completionCriteria: ['Cited finding', 'Scope checked'], contextRefs: ['source:one'], readOnly: true };
  const first = JSON.parse((await tool.execute('stable_tool_call', input)).content[0].text);
  const expectedId = createHash('sha256').update('session_one:stable_tool_call').digest('hex');
  assert.equal(first.taskId, expectedId);
  const retry = JSON.parse((await tool.execute('stable_tool_call', input)).content[0].text);
  assert.equal(retry.taskId, expectedId);
  assert.equal(starts, 2);
  await assert.rejects(tool.execute('check', { action: 'link_evidence', taskId: expectedId,
    checks: [{ criterion: 'Cited finding', evidenceRefs: ['invented'] }] }), /actual returned evidence/);
  await assert.rejects(tool.execute('check', { action: 'link_evidence', taskId: expectedId,
    checks: [{ criterion: 'Cited finding', evidenceRefs: ['source:one'] },
      { criterion: 'Cited finding', evidenceRefs: ['source:one'] }] }), /actual returned evidence/);
  await assert.rejects(tool.execute('check', { action: 'link_evidence', taskId: expectedId,
    checks: [{ criterion: 'Cited finding', evidenceRefs: ['source:one'] }] }), /actual returned evidence/);
  const linked = JSON.parse((await tool.execute('check', { action: 'link_evidence', taskId: expectedId,
    checks: [{ criterion: 'Cited finding', evidenceRefs: ['source:one'] },
      { criterion: 'Scope checked', evidenceRefs: ['source:one'] }] })).content[0].text);
  assert.equal(linked.status, 'evidence_linked');
  await tool.execute('follow', { action: 'follow_up', taskId: expectedId, text: 'Check the citation again.' });
  assert.deepEqual(records.get(expectedId).followUps, ['Check the citation again.']);
  const otherSessionTool = createAssistantDelegationTool(coordinator, 'session_two');
  await assert.rejects(otherSessionTool.execute('query', { action: 'status', taskId: expectedId }), /Unknown delegation/);
  const archive = JSON.parse(await readFile(join(home, 'delegations', `${expectedId}.json`), 'utf8'));
  assert.equal(archive.verification, undefined);
});
