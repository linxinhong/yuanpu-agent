import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { register } from 'tsx/esm/api';

register();
const { DelegationApprovalDetails, isVisibleAssistantDelegationApproval } =
  await import('../src/shared/delegation-approval-details.tsx');

test('professional approval displays the bounded task and only the Assistant surface can approve it', () => {
  const approval = { requestId: 'approval-one', sessionId: 'session-one',
    workspaceId: 'assistant-delegation:task-one', sourceInstanceId: 'assistant-delegation',
    capabilityId: 'assistant:professional-task', argumentsDigest: 'digest', status: 'pending',
    createdAt: '2026-09-27T00:00:00Z', expiresAt: '2026-09-27T00:05:00Z',
    assistantDelegation: { taskId: 'task-one', skillName: 'reviewer', goal: '核对合同条款',
      completionCriteria: ['指出差异'], contextRefs: ['source:one'],
      sourceVersions: { 'source:one': 'version-one' },
      authorizedCapabilities: ['fixture.inspect'], readOnly: false } };
  assert.equal(isVisibleAssistantDelegationApproval(approval, 'assistant'), true);
  assert.equal(isVisibleAssistantDelegationApproval(approval, 'work'), false);
  assert.equal(isVisibleAssistantDelegationApproval({ ...approval,
    workspaceId: 'assistant-delegation:other' }, 'assistant'), false);
  const markup = renderToStaticMarkup(createElement(DelegationApprovalDetails,
    { delegation: approval.assistantDelegation }));
  for (const content of ['核对合同条款', 'reviewer', '指出差异', 'source:one', 'version-one',
    'fixture.inspect', '否']) assert.match(markup, new RegExp(content));
});
