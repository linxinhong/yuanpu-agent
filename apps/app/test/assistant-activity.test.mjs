import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'tsx/esm/api';
register();
const { taskAction, executionAction, completedNow } = await import('../src/shared/assistant-activity.ts');

test('task content selects the four execution animations', () => {
  for (const [task, expected] of [
    ['搜索并汇总企微消息', 'reading'], ['阅读附件', 'reading'],
    ['修复代码然后测试', 'hammer'], ['部署应用', 'hammer'],
    ['撰写一封邮件', 'typing'], ['打开浏览器编辑表格', 'typing'],
    ['定时提醒我开会', 'backtyping'], ['批量同步数据', 'backtyping'],
  ]) assert.equal(taskAction(task), expected);
  assert.equal(taskAction('', 'scheduler'), 'backtyping');
  assert.equal(taskAction('帮我处理一下'), 'typing');
});
test('only confirmed running status animates work; terminal and approval states stop', () => {
  for (const status of [undefined, 'queued', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'interrupted', 'result_unknown']) {
    assert.equal(executionAction({ status, task: '修复代码' }), 'idle');
  }
  assert.equal(executionAction({ status: 'running', task: '修复代码' }), 'hammer');
  assert.equal(executionAction({ status: 'running', task: '修复代码', disconnected: true }), 'idle');
});
test('completion celebrates only an observed transition for the same run', () => {
  const finished = { runId: 'a', status: 'succeeded' };
  assert.equal(completedNow({ runId: 'a', status: 'running' }, finished), true);
  assert.equal(completedNow({ runId: 'a', status: 'queued' }, finished), true);
  assert.equal(completedNow({}, finished), false);
  assert.equal(completedNow(finished, finished), false);
  assert.equal(completedNow({ runId: 'b', status: 'running' }, finished), false);
  assert.equal(completedNow({ runId: 'a', status: 'running' }, { ...finished, status: 'failed' }), false);
});
