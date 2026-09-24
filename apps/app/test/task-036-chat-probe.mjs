// Explicit UI regression probe. Requires an isolated running Vite server and agent-browser.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const url = process.env.TASK_036_RENDERER_URL;
if (!url || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) throw new Error('Set TASK_036_RENDERER_URL.');
const session = `task036-regression-${process.pid}`;
function browser(...args) { return execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8' }); }
function evaluate(source) {
  const result = execFileSync('agent-browser', ['--session', session, '--json', 'eval', '--stdin'], { input: source, encoding: 'utf8' });
  const parsed = JSON.parse(result);
  if (!parsed.success) throw new Error(result);
  return parsed.data.result;
}
async function until(source) {
  for (let i = 0; i < 50; i++) {
    if (evaluate(source)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`UI condition failed: ${source}`);
}
try {
  browser('open', url);
  evaluate(`window.probe = { count: 0, mode: 'outage', status: 'running', approved: false };
    window.yuanpu = {
      runtimeInfo: async () => ({ piVersion: 'fixture' }),
      listCapabilityApprovals: async () => window.probe.mode === 'approval' && !window.probe.approved ? [{
        requestId: 'approval-fixture', runId: 'approval-run', capabilityId: 'controlled-echo', sourceInstanceId: 'fixture', argumentsDigest: '000000000000000000',
      }] : [],
      submitDesktopMessage: async () => { window.probe.count++; return { runId: 'run-fixture', status: 'queued' }; },
      getAgentRun: async () => {
        if (window.probe.mode === 'outage') throw new Error('controlled poll outage');
        const run = { runId: 'run-fixture', status: window.probe.status, owner: { entryPoint: 'desktop' }, pendingApproval: { approvalRequestId: 'approval-fixture' },
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), output: { message: 'fixture finished', tools: [] } };
        if (window.probe.mode === 'late' && run.status === 'running') await new Promise(r => setTimeout(r, 1600));
        return run;
      },
      cancelAgentRun: async () => { window.probe.status = 'cancelled'; return { result: 'cancelled' }; },
      decideCapabilityApproval: async () => { window.probe.approved = true; window.probe.status = 'running'; return { status: 'completed', message: '受控授权已完成' }; },
    }; true`);
  browser('fill', '[aria-label="消息"]', 'recover exactly this run');
  // IME composition Enter must not dispatch a message.
  evaluate(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })); true`);
  assert.equal(evaluate('window.probe.count'), 0);
  browser('click', '[aria-label="发送消息"]');
  await until('Boolean(document.querySelector(".run-recovery"))');
  assert.equal(evaluate('window.probe.count'), 1);
  browser('fill', '[aria-label="消息"]', 'keep next draft');
  assert.equal(evaluate('document.querySelector(".composer button").disabled'), true);
  evaluate(`window.probe.mode = 'success'; window.probe.status = 'succeeded'; true`);
  browser('find', 'text', '重新获取状态', 'click');
  await until('!document.querySelector(".run-recovery") && document.body.innerText.includes("fixture finished")');
  assert.equal(evaluate('window.probe.count'), 1);
  assert.equal(evaluate('document.querySelector("textarea").value'), 'keep next draft');

  // New run IDs prevent the terminal cache from obscuring subsequent fixture states.
  evaluate(`window.probe.mode = 'approval'; window.probe.status = 'running';
    const original = window.yuanpu.getAgentRun;
    window.yuanpu.getAgentRun = async () => ({ ...await original(), runId: 'approval-run' });
    window.yuanpu.submitDesktopMessage = async () => { window.probe.count++; return { runId: 'approval-run', status: 'running' }; }; true`);
  browser('click', '[aria-label="发送消息"]');
  await until('document.body.innerText.includes("正在准备授权…")');
  assert.equal(evaluate('document.querySelector(".approval-actions .primary").disabled'), true);
  evaluate("window.probe.status = 'waiting_approval'; true");
  await until('Array.from(document.querySelectorAll(".approval-actions button")).some(button => button.textContent.trim() === "允许一次" && !button.disabled)');
  browser('find', 'text', '允许一次', 'click');
  await until('window.probe.approved');
  browser('fill', '[aria-label="消息"]', 'must remain locked');
  assert.equal(evaluate('document.querySelector(".composer button").disabled'), true);
  assert.equal(evaluate('window.probe.count'), 2);
  evaluate(`window.probe.mode = 'late'; window.confirm = () => true; true`);
  browser('find', 'text', '取消任务', 'click');
  await until('!document.querySelector(".thinking")');
  assert.equal(evaluate('document.querySelector("textarea").value'), 'must remain locked');
  assert.equal(evaluate('document.querySelector(".activity-current").textContent.includes("已取消")'), true);
  console.log(JSON.stringify({ status: 'passed', mode: 'browser-bridge-fixture', scenarios: ['IME Enter', 'poll recovery without duplicate submit', 'draft retention', 'approval preserves send lock', 'cancel/late poll terminal'] }));
} finally { browser('close'); }
