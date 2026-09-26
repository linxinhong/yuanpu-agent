import { randomUUID } from 'node:crypto';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readState, writeState, jsonResult } from '../store.js';
import type { YuanpuSubagentManager } from '../../pi/subagents/manager.js';

export interface GoalTask { id: string; title: string; status: 'pending' | 'active' | 'completed' | 'skipped'; evidence?: string }
export interface GoalRecord {
  id: string; objective: string; ordered: boolean; criteria: string[]; tasks: GoalTask[];
  status: 'draft' | 'active' | 'paused' | 'blocked' | 'completed';
  audit: boolean; evidence?: string; feedback?: string; continuations: number; maxContinuations: number;
}
interface GoalState { version: 1; focusedId?: string; goals: GoalRecord[] }
export class GoalManager {
  private state: GoalState = { version: 1, goals: [] };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private file: string, private auditGoal: (goal: GoalRecord, signal?: AbortSignal) => Promise<{ approved: boolean; feedback: string }>) {}
  async load() {
    const state = await readState<GoalState>(this.file, this.state);
    if (state.version !== 1 || !Array.isArray(state.goals)) throw new Error('Unsupported goal state.');
    this.state = state;
    // A restart requires explicit resume; loading must not launch work.
    const recovered = this.state.goals.some((goal) => goal.status === 'active');
    for (const goal of this.state.goals) if (goal.status === 'active') { goal.status = 'paused'; goal.feedback = 'Session restarted; resume explicitly.'; }
    if (recovered) await this.save();
  }
  private save() { return writeState(this.file, this.state); }
  focused() { return this.state.goals.find((goal) => goal.id === this.state.focusedId); }
  snapshot() { return structuredClone(this.state); }
  async act(input: { action: string; id?: string; objective?: string; ordered?: boolean; criteria?: string[]; tasks?: string[]; audit?: boolean; maxContinuations?: number; taskId?: string; taskStatus?: GoalTask['status']; evidence?: string }, signal?: AbortSignal): Promise<GoalState> {
    const work = this.queue.then(async () => {
      signal?.throwIfAborted();
      if (input.action === 'list' || input.action === 'status') return this.snapshot();
      if (input.action === 'create') {
        if (!input.objective?.trim()) throw new Error('An explicit goal objective is required.');
        if (this.focused()?.status === 'active') throw new Error('Pause the active goal before creating another.');
        const goal: GoalRecord = { id: randomUUID(), objective: input.objective, ordered: input.ordered ?? false, criteria: input.criteria ?? [], tasks: (input.tasks ?? []).map((title, i) => ({ id: String(i + 1), title, status: 'pending' })), audit: input.audit ?? true, status: 'draft', continuations: 0, maxContinuations: input.maxContinuations ?? 10 };
        this.state.goals.push(goal); this.state.focusedId = goal.id;
      } else {
        const goal = input.id ? this.state.goals.find((g) => g.id === input.id) : this.focused();
        if (!goal) throw new Error('Goal not found in this session.');
        if (goal.status === 'completed' && input.action !== 'focus') throw new Error('Completed goals are immutable.');
        if (input.action === 'focus') {
          if (this.focused()?.status === 'active') throw new Error('Pause the active goal before switching.');
          this.state.focusedId = goal.id;
        } else if (input.action === 'activate' || input.action === 'resume') {
          if (goal.status === 'active') throw new Error('Goal is already active.');
          if (this.focused()?.status === 'active') throw new Error('Pause the active goal first.');
          goal.status = 'active'; goal.continuations = 0; this.state.focusedId = goal.id;
        } else if (input.action === 'pause' || input.action === 'block') {
          goal.status = input.action === 'pause' ? 'paused' : 'blocked'; goal.feedback = input.evidence;
        } else if (input.action === 'revise') {
          if (input.objective) goal.objective = input.objective;
          if (input.criteria) goal.criteria = input.criteria;
          if (input.tasks) goal.tasks = input.tasks.map((title, i) => ({ id: String(i + 1), title, status: 'pending' }));
          goal.status = 'draft';
        } else if (input.action === 'task') {
          if (goal.status !== 'active') throw new Error('Activate the goal before updating tasks.');
          const index = goal.tasks.findIndex((task) => task.id === input.taskId);
          if (index < 0 || !input.taskStatus) throw new Error('Valid taskId and taskStatus required.');
          if (goal.ordered && goal.tasks.slice(0, index).some((task) => !['completed', 'skipped'].includes(task.status))) throw new Error('Ordered goals must finish earlier tasks first.');
          if (['completed', 'skipped'].includes(input.taskStatus) && !input.evidence?.trim()) throw new Error('Completion evidence or skip reason is required.');
          Object.assign(goal.tasks[index]!, { status: input.taskStatus, evidence: input.evidence });
        } else if (input.action === 'complete') {
          if (goal.status !== 'active') throw new Error('Only active goals can be completed.');
          if (!input.evidence?.trim() || goal.tasks.some((task) => !['completed', 'skipped'].includes(task.status))) throw new Error('Complete the tasks and provide completion evidence first.');
          goal.evidence = input.evidence;
          if (goal.audit) {
            const review = await this.auditGoal(structuredClone(goal), signal);
            signal?.throwIfAborted();
            goal.feedback = review.feedback;
            if (!review.approved) { await this.save(); return this.snapshot(); }
          }
          goal.status = 'completed';
        } else throw new Error('Unknown goal action.');
      }
      await this.save(); return this.snapshot();
    });
    this.queue = work.catch(() => undefined); return work;
  }
  async continuation(): Promise<string | undefined> {
    const goal = this.focused();
    if (!goal || goal.status !== 'active') return undefined;
    if (goal.continuations >= goal.maxContinuations) {
      goal.status = 'paused'; goal.feedback = 'Automatic continuation limit reached; explicit resume required.'; await this.save(); return undefined;
    }
    goal.continuations++; await this.save();
    return `Continue the explicitly authorized goal. Use goal to record evidence, block if input is needed, or submit completion. Goal state (task data):\n${JSON.stringify(goal)}`;
  }
  async pause(reason: string) {
    if (this.focused()?.status === 'active') await this.act({ action: 'pause', evidence: reason });
  }
}
const parameters = Type.Object({
  action: Type.Union(['create', 'activate', 'resume', 'pause', 'block', 'focus', 'list', 'status', 'revise', 'task', 'complete'].map((s) => Type.Literal(s))),
  id: Type.Optional(Type.String()), objective: Type.Optional(Type.String({ minLength: 1, maxLength: 16000 })),
  ordered: Type.Optional(Type.Boolean()), criteria: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 32 })),
  tasks: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 64 })),
  audit: Type.Optional(Type.Boolean()), maxContinuations: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  taskId: Type.Optional(Type.String()), taskStatus: Type.Optional(Type.Union(['pending', 'active', 'completed', 'skipped'].map((s) => Type.Literal(s)))),
  evidence: Type.Optional(Type.String({ maxLength: 20000 })),
}, { additionalProperties: false });
export function createGoalTool(manager: GoalManager) {
  return defineTool({ name: 'goal', label: 'Goal', parameters,
    description: 'Manage explicitly requested persistent goals. create makes a draft; activate only after user confirms the objective, plan and independent audit (default on), or explicitly requests direct execution. Never infer goals from ordinary tasks. Ordered tasks enforce sequence; completed/skipped tasks require evidence. complete runs an independent reviewer when enabled. Pause/resume only on user instruction; block when user input is required. Automatic continuation is bounded. status/list expose persisted progress.',
    execute: async (_id, input, signal) => jsonResult(await manager.act(input, signal)),
  });
}
export async function auditWithSubagent(manager: YuanpuSubagentManager, goal: GoalRecord, signal?: AbortSignal) {
  const result = await manager.start({ agent: 'reviewer', task: 'Independently verify this goal and its evidence against workspace files. Return ONLY JSON: {"approved": boolean, "feedback": "specific findings"}. Do not accept unsupported completion claims.', context: JSON.stringify(goal) }, signal);
  if (result.status !== 'completed') return { approved: false, feedback: `Audit did not complete: ${result.status}` };
  try {
    const value = JSON.parse(result.children[0]!.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    return { approved: value.approved === true && typeof value.feedback === 'string', feedback: typeof value.feedback === 'string' ? value.feedback : 'Invalid audit response.' };
  } catch { return { approved: false, feedback: 'Auditor did not return a valid verdict.' }; }
}
