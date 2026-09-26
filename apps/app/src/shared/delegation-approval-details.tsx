import React from 'react';
import type { CapabilityApprovalSummary } from '@yuanpu-agent/protocol';

export function isVisibleAssistantDelegationApproval(approval: CapabilityApprovalSummary,
  surface: 'assistant' | 'work'): boolean {
  return surface === 'assistant' && !approval.runId
    && approval.workspaceId.startsWith('assistant-delegation:')
    && (!approval.assistantDelegation || approval.sourceInstanceId === 'assistant-delegation'
      && approval.workspaceId === `assistant-delegation:${approval.assistantDelegation.taskId}`);
}

export function DelegationApprovalDetails({ delegation }: {
  delegation: NonNullable<CapabilityApprovalSummary['assistantDelegation']>;
}) {
  return <dl>
    <div><dt>目标</dt><dd>{delegation.goal}</dd></div>
    <div><dt>专业技能</dt><dd>{delegation.skillName}</dd></div>
    <div><dt>完成条件</dt><dd>{delegation.completionCriteria.join('；')}</dd></div>
    <div><dt>来源引用</dt><dd>{delegation.contextRefs.join('、') || '无'}</dd></div>
    <div><dt>来源版本</dt><dd>{Object.entries(delegation.sourceVersions ?? {})
      .map(([ref, version]) => `${ref} · ${version.slice(0, 12)}`).join('；') || '无'}</dd></div>
    <div><dt>可请求能力</dt><dd>{delegation.authorizedCapabilities.join('、') || '无'}</dd></div>
    <div><dt>只读</dt><dd>{delegation.readOnly ? '是' : '否'}</dd></div>
  </dl>;
}
