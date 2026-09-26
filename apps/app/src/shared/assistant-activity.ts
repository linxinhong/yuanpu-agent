import type { AgentRunStatus } from '@yuanpu-agent/protocol';

export type AssistantAction = 'idle' | 'wave' | 'heart' | 'reading' | 'typing' | 'backtyping' | 'hammer';
export interface AssistantActivity {
  runId?: string;
  status?: AgentRunStatus;
  /** Submitted request only; never classify model output or attachment bodies. */
  task?: string;
  entryPoint?: 'desktop' | 'im' | 'scheduler';
  disconnected?: boolean;
}

export const assistantActionLabels: Record<AssistantAction, string> = {
  idle: '待命', wave: '向你问好', heart: '任务完成', reading: '阅读与查资料',
  typing: '电脑办公', backtyping: '后台处理', hammer: '构建与修复',
};

/** Presentation policy only: it never changes the agent, tools or permissions. */
export function taskAction(task = '', entryPoint?: AssistantActivity['entryPoint']): AssistantAction {
  const text = task.slice(0, 2000).toLowerCase();
  if (/修复|编程|构建|部署|编译|写代码|开发|安装|测试|\b(build|debug|fix|deploy|compile|code|test|install)\b/.test(text)) return 'hammer';
  if (/阅读|读一下|查阅|资料|搜索|检索|研究|调研|查找|分析|总结|汇总|\b(read|search|research|lookup|review|summari[sz]e|analy[sz]e)\b/.test(text)) return 'reading';
  if (/定时|提醒|同步|监控|备份|后台|批量|\b(schedule|remind|sync|monitor|backup|batch)\b/.test(text)) return 'backtyping';
  if (/撰写|写|编辑|整理|表格|文档|浏览器|网页|电脑|\b(write|edit|draft|browser|spreadsheet)\b/.test(text)) return 'typing';
  return entryPoint === 'scheduler' ? 'backtyping' : 'typing';
}

export function executionAction(activity: AssistantActivity): AssistantAction {
  if (activity.disconnected || activity.status !== 'running') return 'idle';
  return taskAction(activity.task, activity.entryPoint);
}

export function completedNow(previous: AssistantActivity, next: AssistantActivity): boolean {
  return Boolean(next.runId && previous.runId === next.runId && next.status === 'succeeded'
    && previous.status && ['queued', 'running', 'waiting_approval'].includes(previous.status));
}
