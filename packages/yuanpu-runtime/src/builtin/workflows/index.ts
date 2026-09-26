import { Worker } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readState, writeState, jsonResult } from '../store.js';
import type { YuanpuSubagentManager, SubagentExecutionContext } from '../../pi/subagents/manager.js';
import { WORKFLOW_WORKER } from './worker.js';
const exec = promisify(execFile);
type RunStatus = 'running' | 'completed' | 'failed' | 'paused' | 'cancelled' | 'interrupted' | 'needs_approval';
interface Journal { hash: string; result: string; worktree?: string; usage?: { input: number; output: number; totalTokens: number; cost: number } }
export interface WorkflowRun {
  id: string; name: string; script: string; args: unknown; status: RunStatus;
  journal: Record<string, Journal>; createdAt: string; finishedAt?: string; phase?: string;
  result?: unknown; error?: string; pendingApprovalRequestId?: string; checkpoint?: { index: string; prompt: string };
  approvals: Record<string, boolean>; log: string[]; calls: number; maxAgents: number; timeoutMs: number;
}
interface Job { run: WorkflowRun; abort: AbortController; done: Promise<void> }
const runId = (id: string) => { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid workflow run ID.'); return id; };
export const BUILTIN_WORKFLOWS: Record<string, string> = {
  'deep-research': `await phase('Research'); const findings = await parallel(['primary sources','contrary evidence','practical implications'].map(lens => () => agent(String(args) + '\\nResearch lens: ' + lens, {agentType:'researcher'}))); await phase('Audit'); return await agent('Synthesize with source links; distinguish verified and unsupported claims.\\n' + findings.join('\\n\\n'), {agentType:'evidence-auditor'});`,
  'code-review': `await phase('Review'); const findings = await parallel(['correctness','security','regressions and tests'].map(lens => () => agent(String(args ?? 'Review current working changes') + '\\nFocus: ' + lens, {agentType:'reviewer'}))); return await agent('Verify these findings against the code, discard unsupported claims, and give one review:\\n' + findings.join('\\n'), {agentType:'reviewer'});`,
  'adversarial-review': `const initial = await agent(String(args), {agentType:'reviewer'}); return await agent('Challenge and independently verify this review:\\n' + initial, {agentType:'reviewer'});`,
  'multi-perspective': `return await parallel(['design','implementation','verification'].map(lens => () => agent(String(args) + '\\nPerspective: ' + lens, {agentType:'oracle'})));`,
};
export class WorkflowManager {
  private jobs = new Map<string, Job>();
  private closed = false;
  constructor(private options: { directory: string; cwd: string; subagents: YuanpuSubagentManager; approveCheckpoint?: (input: { runId: string; checkpointId: string; prompt: string }, approvalRequestId?: string, signal?: AbortSignal) => Promise<void> }) {}
  private file(id: string) { return join(this.options.directory, runId(id), 'run.json'); }
  private snapshot(run: WorkflowRun) {
    const { script: _script, journal, args: _args, ...summary } = run;
    return { ...summary, completedAgents: Object.keys(journal).length, reportedTokens: Object.values(journal).reduce((sum, entry) => sum + (entry.usage?.totalTokens ?? 0), 0), reportedCost: Object.values(journal).reduce((sum, entry) => sum + (entry.usage?.cost ?? 0), 0), result: JSON.stringify(run.result ?? null).slice(0, 24000), worktrees: Object.values(journal).flatMap((entry) => entry.worktree ? [entry.worktree] : []) };
  }
  private async read(id: string): Promise<WorkflowRun> {
    const active = this.jobs.get(id)?.run;
    if (active) return active;
    const run = await readState<WorkflowRun | null>(this.file(id), null);
    if (!run || run.id !== id) throw new Error('Unknown workflow run in this session.');
    if (run.status === 'running') run.status = 'interrupted';
    return run;
  }
  async list() {
    let ids: string[] = [];
    try { ids = await readdir(this.options.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return Promise.all(ids.filter((id) => /^[a-f0-9-]{36}$/.test(id)).map(async (id) => this.snapshot(await this.read(id))));
  }
  async status(id: string) { return this.snapshot(await this.read(id)); }
  async control(action: 'pause' | 'stop', id: string) {
    const job = this.jobs.get(id);
    if (!job || job.run.status !== 'running') throw new Error('Workflow is not running in this process.');
    job.run.status = action === 'pause' ? 'paused' : 'cancelled'; job.abort.abort();
    await job.done; return this.snapshot(job.run);
  }
  async resume(id: string, signal?: AbortSignal) {
    const previous = await this.read(id);
    if (!['paused', 'interrupted', 'failed', 'cancelled'].includes(previous.status)) throw new Error('Only paused, interrupted, failed or cancelled workflows can resume.');
    if (previous.checkpoint && previous.approvals[previous.checkpoint.index] !== true) throw new Error('User checkpoint confirmation is required.');
    return this.launch({ ...structuredClone(previous), status: 'running', error: undefined, finishedAt: undefined, calls: 0 }, true, signal);
  }
  async confirm(id: string, approvalRequestId?: string, signal?: AbortSignal) {
    const run = await this.read(id);
    if (run.status !== 'paused' || !run.checkpoint) throw new Error('No pending checkpoint.');
    if (!this.options.approveCheckpoint) throw new Error('A host approval service is required to confirm checkpoints.');
    await this.options.approveCheckpoint({ runId: run.id, checkpointId: run.checkpoint.index, prompt: run.checkpoint.prompt }, approvalRequestId, signal);
    signal?.throwIfAborted();
    run.approvals[run.checkpoint.index] = true;
    await writeState(this.file(id), run);
    return this.snapshot(run);
  }
  async start(input: { name?: string; script?: string; args?: unknown; background?: boolean; maxAgents?: number; timeoutMs?: number }, signal?: AbortSignal) {
    const script = input.script ?? BUILTIN_WORKFLOWS[input.name ?? ''];
    if (!script || script.length > 100000) throw new Error('Provide a workflow script (max 100000 chars) or a known built-in name.');
    const run: WorkflowRun = { id: randomUUID(), name: input.name ?? 'workflow', script, args: input.args ?? null, status: 'running', journal: {}, approvals: {}, createdAt: new Date().toISOString(), log: [], calls: 0, maxAgents: input.maxAgents ?? 24, timeoutMs: input.timeoutMs ?? 600000 };
    if (!Number.isInteger(run.maxAgents) || run.maxAgents < 1 || run.maxAgents > 64 || !Number.isInteger(run.timeoutMs) || run.timeoutMs < 1 || run.timeoutMs > 1800000) throw new Error('Invalid workflow limits.');
    return this.launch(run, input.background ?? true, signal);
  }
  private async launch(run: WorkflowRun, background: boolean, signal?: AbortSignal) {
    if (this.closed) throw new Error('Parent session is closed.');
    signal?.throwIfAborted();
    if (this.jobs.get(run.id)?.run.status === 'running') throw new Error('Workflow is already running.');
    const executionContext = this.options.subagents.captureContext();
    await writeState(this.file(run.id), run);
    const abort = new AbortController();
    const stop = () => abort.abort(signal?.reason);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const job: Job = { run, abort, done: Promise.resolve() };
    this.jobs.set(run.id, job);
    job.done = this.execute(run, abort, executionContext).catch(() => { run.status = 'failed'; run.error = 'Workflow state could not be saved.'; }).finally(() => signal?.removeEventListener('abort', stop));
    if (!background) await job.done;
    return this.snapshot(run);
  }
  private async execute(run: WorkflowRun, abort: AbortController, executionContext: SubagentExecutionContext) {
    let worker: Worker | undefined;
    const operations = new Set<Promise<void>>();
    let writes: Promise<void> = Promise.resolve();
    const save = () => { writes = writes.then(() => writeState(this.file(run.id), run)); return writes; };
    const timer = setTimeout(() => { run.error = 'Workflow timed out.'; abort.abort(); }, run.timeoutMs);
    try {
      abort.signal.throwIfAborted();
      worker = new Worker(WORKFLOW_WORKER, { eval: true, execArgv: [], workerData: { script: run.script, args: run.args }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
      const activeWorker = worker;
      await new Promise<void>((resolve, reject) => {
        const cancelled = () => reject(new Error(run.error ?? 'Workflow stopped.'));
        abort.signal.addEventListener('abort', cancelled, { once: true });
        worker!.on('error', reject);
        worker!.on('exit', (code) => { if (code !== 0) reject(new Error(`Workflow worker exited (${code}).`)); });
        worker!.on('message', (message) => {
          if (message.type === 'done') { run.result = message.value; resolve(); return; }
          if (message.type === 'failed') { reject(new Error(message.error)); return; }
          if (message.type !== 'call') return;
          const operation = (async () => {
            try {
              abort.signal.throwIfAborted();
              let value: unknown;
              const payload = message.payload;
              if (message.kind === 'agent') {
                run.calls++;
                if (run.calls > run.maxAgents) throw new Error('Workflow agent budget exhausted.');
                if (typeof payload.prompt !== 'string' || payload.prompt.length > 100000) throw new Error('Invalid agent prompt.');
                const opts = payload.options ?? {};
                if (Object.keys(opts).some((key) => !['agentType', 'provider', 'model', 'isolation'].includes(key))) throw new Error('Supported agent options: agentType, provider, model, isolation.');
                if (opts.isolation !== undefined && opts.isolation !== 'worktree' && opts.isolation !== false) throw new Error('Unknown isolation mode.');
                const identity = String(message.id);
                const hash = createHash('sha256').update(JSON.stringify([payload, run.phase])).digest('hex');
                const cached = run.journal[identity];
                if (cached?.hash === hash) value = cached.result;
                else {
                  let worktree: string | undefined;
                  if (opts.isolation === 'worktree') {
                    worktree = join(this.options.directory, run.id, `worktree-${randomUUID()}`);
                    await mkdir(join(this.options.directory, run.id), { recursive: true });
                    await exec('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], { cwd: this.options.cwd, signal: abort.signal });
                    run.log.push(`Worktree preserved: ${worktree}`);
                  }
                  const result = await this.options.subagents.start({ tasks: [{ agent: opts.agentType ?? 'worker', task: payload.prompt, provider: opts.provider, model: opts.model, cwd: worktree }] }, abort.signal, undefined, executionContext);
                  if (result.status === 'needs_approval') { run.pendingApprovalRequestId = result.children.find((child) => child.pendingApprovalRequestId)?.pendingApprovalRequestId; run.status = 'needs_approval'; throw new Error('Child capability needs approval. Start a new workflow after resolving approval.'); }
                  if (result.status !== 'completed') throw new Error(result.children[0]?.error ?? `Agent ended: ${result.status}`);
                  value = result.children[0]!.text;
                  run.journal[identity] = { hash, result: String(value), worktree, usage: result.children[0]!.usage };
                  await save();
                }
              } else if (message.kind === 'phase') { run.phase = String(payload.title).slice(0, 200); await save(); }
              else if (message.kind === 'log') { run.log.push(String(payload.message).slice(0, 2000)); run.log = run.log.slice(-100); }
              else if (message.kind === 'checkpoint') {
                if (!run.approvals[String(message.id)]) { run.checkpoint = { index: String(message.id), prompt: String(payload.prompt).slice(0, 2000) }; run.status = 'paused'; abort.abort(); throw new Error('User confirmation required.'); }
                value = true;
              } else throw new Error('Unknown workflow operation.');
              activeWorker.postMessage({ id: message.id, value });
            } catch (error) {
              activeWorker.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
            }
          })();
          operations.add(operation); void operation.then(() => operations.delete(operation), () => operations.delete(operation));
        });
        if (abort.signal.aborted) cancelled();
      });
      // A script must await its work; do not orphan unawaited child calls.
      if (operations.size) { run.error = 'Workflow returned with unawaited operations.'; run.status = 'failed'; }
      else run.status = 'completed';
    } catch (error) {
      if (run.status === 'running') run.status = abort.signal.aborted && !run.error ? 'cancelled' : 'failed';
      run.error ??= error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer); abort.abort(); await worker?.terminate();
      await Promise.allSettled([...operations]);
      run.finishedAt = new Date().toISOString();
      await writes.catch(() => undefined);
      await writeState(this.file(run.id), run);
    }
  }
  async abortAll() { for (const job of this.jobs.values()) if (job.run.status === 'running') job.abort.abort(); await Promise.allSettled([...this.jobs.values()].map((job) => job.done)); }
  async dispose() { this.closed = true; await this.abortAll(); }
}
export function createWorkflowTools(manager: WorkflowManager) {
  return [defineTool({ name: 'workflow', label: 'Workflow', description: 'Run explicitly authorized JavaScript orchestration. Globals: await agent(prompt,{agentType,provider,model,isolation:"worktree"}), parallel(thunks), pipeline(items,...stages), await phase(title), await log(text), await checkpoint(prompt), verify(item), args. Return the final result. All operations must be awaited. No imports or Node globals. Defaults to background; workflow_control queries progress. Built-ins: deep-research, code-review, adversarial-review, multi-perspective. Worktrees are preserved, never automatically merged. Not a security sandbox for hostile scripts.',
    parameters: Type.Object({ name: Type.Optional(Type.String()), script: Type.Optional(Type.String({ maxLength: 100000 })), args: Type.Optional(Type.Unknown()), background: Type.Optional(Type.Boolean()), maxAgents: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })), timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800000 })) }, { additionalProperties: false }),
    execute: async (_id, input, signal) => {
      const result = await manager.start(input, signal);
      return { ...jsonResult(result), details: { ...result, ...(result.pendingApprovalRequestId ? { capabilityError: { error: 'needs_approval', approvalRequestId: result.pendingApprovalRequestId } } : {}) } };
    },
  }), defineTool({ name: 'workflow_control', label: 'Workflow control', description: 'List, inspect, pause, resume or stop workflows. confirm requests host-signed user approval for a pending checkpoint; retry with its approved approvalRequestId, then resume. Resuming replays completed calls from the journal, but unfinished calls may run again. Inspect their effects first. Background completion requires polling status.',
    parameters: Type.Object({ action: Type.Union(['list', 'status', 'pause', 'resume', 'stop', 'confirm'].map((s) => Type.Literal(s))), runId: Type.Optional(Type.String()), approvalRequestId: Type.Optional(Type.String()) }, { additionalProperties: false }),
    execute: async (_id, input, signal) => {
      if (input.action === 'list') return jsonResult(await manager.list());
      if (!input.runId) throw new Error('runId required.');
      try {
      const result = input.action === 'status' ? await manager.status(input.runId) : input.action === 'resume' ? await manager.resume(input.runId, signal) : input.action === 'confirm' ? await manager.confirm(input.runId, input.approvalRequestId, signal) : await manager.control(input.action, input.runId);
      return { ...jsonResult(result), details: { ...result, ...(result.pendingApprovalRequestId ? { capabilityError: { error: 'needs_approval', approvalRequestId: result.pendingApprovalRequestId } } : {}) } };
      } catch (error) {
        if (error && typeof error === 'object' && 'failure' in error) return jsonResult({ capabilityError: error.failure });
        throw error;
      }
    },
  })];
}
