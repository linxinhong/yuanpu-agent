import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  formatSkillsForSystemPrompt,
  JsonlSessionRepo,
  NodeExecutionEnv,
  type AgentLane,
  type Entry,
} from '@earendil-works/pi-agent-core/node';
import type { Api, Model, Models } from '@earendil-works/pi-ai';
import {
  createFrozenAssistantPrompt,
  initializeAssistantHome,
  readAssistantHomeFile,
  type AssistantHomePaths,
  type BundledAssistantSkillFile,
} from './home.js';
import { loadAssistantSkills } from './skills.js';
import { AssistantDelegationCoordinator, createAssistantDelegationTool,
  type AssistantDelegationHost } from './delegations.js';

/** The host owns model selection and credentials; the assistant receives no auth file or Work executor. */
export interface AssistantHost {
  resolveModel(): Promise<{ models: Models; model: Model<Api> }>;
}

export interface AssistantTurnResult {
  sessionId: string;
  runId: string;
  message: string;
  costUsd: number;
  usageKnown: boolean;
}

export interface AssistantSession {
  readonly sessionId: string;
  readonly skillNames: readonly string[];
  prompt(message: string, signal?: AbortSignal): Promise<AssistantTurnResult>;
  invokeSkill(name: string, instructions?: string, signal?: AbortSignal): Promise<AssistantTurnResult>;
  verifyDelegation(taskId: string, signal?: AbortSignal,
    beforeModel?: () => boolean): Promise<AssistantTurnResult>;
  close(): Promise<void>;
}

export interface AssistantExecutor {
  readonly paths: AssistantHomePaths;
  openSession(sessionId?: string, options?: { createIfMissing?: boolean }): Promise<AssistantSession>;
  linkDelegationEvidence(taskId: string, sessionId: string,
    checks: Array<{ criterion: string; evidenceRefs: string[] }>): Promise<unknown>;
  close(): Promise<void>;
}

interface FrozenSessionPrompt {
  version: 1;
  prompt: string;
}

function snapshotPath(paths: AssistantHomePaths, sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new TypeError('Invalid assistant session ID.');
  return join(paths.snapshots, `${sessionId}.json`);
}

function lastAssistantText(entries: Entry[]): string | undefined {
  const message = entries.find((entry) => entry.type === 'message' && entry.message.role === 'assistant');
  if (message?.type !== 'message' || message.message.role !== 'assistant') return undefined;
  return message.message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

async function completeTurn(lane: AgentLane, sessionId: string, run: ReturnType<AgentLane['prompt']>): Promise<AssistantTurnResult> {
  const result = await run;
  if (!result.ok) throw result.error;
  if (result.value.status !== 'completed') {
    const detail = result.value.status === 'failed' && result.value.error
      ? `: ${result.value.error.message}`
      : '';
    throw new Error(`Assistant run ended ${result.value.status}${detail}.`);
  }
  if (!result.value.tipId) throw new Error('Assistant run completed without transcript entries.');
  const entries = await lane.findEntries({
    start: result.value.tipId,
    ...(result.value.fromTipId ? { stopAtId: result.value.fromTipId } : {}),
    type: 'message',
    order: 'newestFirst',
  }, BACKGROUND_CONTEXT);
  const message = lastAssistantText(entries);
  if (!message) throw new Error('Assistant run completed without a text reply.');
  const assistantMessages = entries.flatMap((entry) => entry.type === 'message'
    && entry.message.role === 'assistant' ? [entry.message] : []);
  const costUsd = assistantMessages.reduce((sum, item) => sum + item.usage.cost.total, 0);
  const usageKnown = assistantMessages.length > 0
    && assistantMessages.every((item) => item.usage.totalTokens > 0);
  return { sessionId, runId: result.value.operationId, message, costUsd, usageKnown };
}

/** Owns only assistant Sessions. Caller must keep one executor per assistant Home writer. */
export async function createAssistantExecutor(options: {
  assistantHome: string;
  host: AssistantHost;
  bundledSkillsRoot?: string;
  bundledSkillFiles?: readonly BundledAssistantSkillFile[];
  delegations?: AssistantDelegationHost;
}): Promise<AssistantExecutor> {
  const paths = await initializeAssistantHome(options.assistantHome, {
    ...(options.bundledSkillsRoot ? { bundledSkillsRoot: options.bundledSkillsRoot } : {}),
    ...(options.bundledSkillFiles ? { bundledSkillFiles: options.bundledSkillFiles } : {}),
  });
  const repo = new JsonlSessionRepo({
    fileSystem: new NodeExecutionEnv({ cwd: paths.root }),
    sessionsRoot: 'sessions/pi',
  });
  const openSessions = new Map<string, Promise<AssistantSession>>();
  const delegationCoordinator = options.delegations
    ? new AssistantDelegationCoordinator(paths.root, options.delegations) : undefined;
  let closed = false;

  const openSession = async (selectedId?: string, openOptions: { createIfMissing?: boolean } = {}): Promise<AssistantSession> => {
    if (closed) throw new Error('Assistant executor is closed.');
    const sessionId = selectedId ?? randomUUID();
    const existing = openSessions.get(sessionId);
    if (existing) return existing;
    const opening = (async () => {
      const { models, model } = await options.host.resolveModel();
      const skills = await loadAssistantSkills(paths);
      const metadata = selectedId
        ? (await repo.list({ cwd: paths.root }, BACKGROUND_CONTEXT)).find((item) => item.id === selectedId)
        : undefined;
      if (selectedId && !metadata && !openOptions.createIfMissing) {
        throw new Error(`Unknown assistant Session: ${selectedId}`);
      }
      const session = metadata
        ? await repo.open(metadata, BACKGROUND_CONTEXT)
        : await repo.create({ id: sessionId, cwd: paths.root }, BACKGROUND_CONTEXT);
      try {
        const snapshotFile = snapshotPath(paths, sessionId);
        let frozen: FrozenSessionPrompt;
        if (metadata) {
          frozen = JSON.parse(await readAssistantHomeFile(paths, snapshotFile)) as FrozenSessionPrompt;
          if (frozen.version !== 1 || typeof frozen.prompt !== 'string') {
            throw new Error(`Invalid assistant prompt snapshot: ${sessionId}`);
          }
        } else {
          frozen = {
            version: 1,
            prompt: await createFrozenAssistantPrompt(paths, formatSkillsForSystemPrompt(skills)),
          };
          await writeFile(snapshotFile, JSON.stringify(frozen), { flag: 'wx', mode: 0o600 });
        }
        let automationTaskId: string | undefined;
        const delegationTool = delegationCoordinator
          ? createAssistantDelegationTool(delegationCoordinator, sessionId, () => automationTaskId) : undefined;
        const { harness } = await AgentHarness.create({
          session,
          models,
          model,
          systemPrompt: frozen.prompt,
          resources: { skills },
          activeToolNames: delegationTool ? [delegationTool.name] : [],
          tools: delegationTool ? [delegationTool] : [],
        }, BACKGROUND_CONTEXT);
        const lane = await harness.lane('main', BACKGROUND_CONTEXT);
        let tail: Promise<unknown> = Promise.resolve();
        let sessionClosed = false;
        const serialize = (operation: () => Promise<AssistantTurnResult>, signal?: AbortSignal): Promise<AssistantTurnResult> => {
          if (sessionClosed) return Promise.reject(new Error('Assistant Session is closed.'));
          const next = tail.then(async () => {
            if (signal?.aborted) throw new Error('Assistant turn was cancelled before execution.');
            const onAbort = () => { void lane.abort(BACKGROUND_CONTEXT); };
            signal?.addEventListener('abort', onAbort, { once: true });
            try { return await operation(); }
            finally { signal?.removeEventListener('abort', onAbort); }
          });
          tail = next.catch(() => undefined);
          return next;
        };
        const assistantSession: AssistantSession = {
          sessionId,
          skillNames: Object.freeze(skills.map((skill) => skill.name)),
          prompt(message, signal) {
            if (!message.trim()) return Promise.reject(new TypeError('Assistant message must not be empty.'));
            return serialize(() => completeTurn(lane, sessionId, lane.prompt(message, undefined, BACKGROUND_CONTEXT)), signal);
          },
          invokeSkill(name, instructions, signal) {
            if (!skills.some((skill) => skill.name === name)) {
              return Promise.reject(new Error(`Unknown assistant skill: ${name}`));
            }
            return serialize(() => completeTurn(lane, sessionId, lane.skill(name, instructions, BACKGROUND_CONTEXT)), signal);
          },
          verifyDelegation(taskId, signal, beforeModel) {
            if (!delegationCoordinator || !/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) {
              return Promise.reject(new Error('Invalid delegation verification task.'));
            }
            return serialize(async () => {
              automationTaskId = taskId;
              try {
                if (signal?.aborted) throw new Error('Delegation notification was preempted before model dispatch.');
                if (beforeModel && !beforeModel()) throw new Error('Delegation notification is no longer current.');
                if (signal?.aborted) throw new Error('Delegation notification was preempted during model dispatch.');
                const result = await completeTurn(lane, sessionId, lane.skill('delegate-and-verify',
                  `A delegated task changed state. Query only task ID ${taskId}. This is a proposal phase: do not call link_evidence. If completed, return only JSON {"checks":[{"criterion":"...","evidenceRefs":["..."]}]} with one entry per actual completion criterion and only returned evidence references. For any other state, return only JSON {"checks":[]}. Do not start or follow up another task.`,
                  BACKGROUND_CONTEXT));
                if (!result.usageKnown && [model.cost.input, model.cost.output,
                  model.cost.cacheRead, model.cost.cacheWrite,
                  ...(model.cost.tiers ?? []).flatMap((tier) => [tier.input, tier.output,
                    tier.cacheRead, tier.cacheWrite])].some((rate) => rate > 0)) {
                  throw new Error('Delegation verification model usage is unknown; retain the original task ID.');
                }
                return result;
              } finally { automationTaskId = undefined; }
            }, signal);
          },
          async close() {
            if (sessionClosed) return;
            sessionClosed = true;
            await tail;
            await harness.close(BACKGROUND_CONTEXT);
            await session.close(BACKGROUND_CONTEXT);
            openSessions.delete(sessionId);
          },
        };
        return assistantSession;
      } catch (error) {
        await session.close(BACKGROUND_CONTEXT);
        throw error;
      }
    })();
    openSessions.set(sessionId, opening);
    try {
      return await opening;
    } catch (error) {
      openSessions.delete(sessionId);
      throw error;
    }
  };

  return {
    paths,
    openSession,
    linkDelegationEvidence(taskId, sessionId, checks) {
      if (!delegationCoordinator) return Promise.reject(new Error('Delegation host is unavailable.'));
      return delegationCoordinator.linkEvidence(taskId, sessionId, checks);
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...openSessions.values()].map(async (opening) => (await opening).close()));
      await repo.close(BACKGROUND_CONTEXT);
    },
  };
}
