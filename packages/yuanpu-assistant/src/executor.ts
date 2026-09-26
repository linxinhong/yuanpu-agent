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
} from './home.js';
import { loadAssistantSkills } from './skills.js';

/** The host owns model selection and credentials; the assistant receives no auth file or Work executor. */
export interface AssistantHost {
  resolveModel(): Promise<{ models: Models; model: Model<Api> }>;
}

export interface AssistantTurnResult {
  sessionId: string;
  runId: string;
  message: string;
}

export interface AssistantSession {
  readonly sessionId: string;
  readonly skillNames: readonly string[];
  prompt(message: string): Promise<AssistantTurnResult>;
  invokeSkill(name: string, instructions?: string): Promise<AssistantTurnResult>;
  close(): Promise<void>;
}

export interface AssistantExecutor {
  readonly paths: AssistantHomePaths;
  openSession(sessionId?: string): Promise<AssistantSession>;
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
  const message = lastAssistantText(await lane.findEntries({
    start: result.value.tipId,
    ...(result.value.fromTipId ? { stopAtId: result.value.fromTipId } : {}),
    type: 'message',
    order: 'newestFirst',
  }, BACKGROUND_CONTEXT));
  if (!message) throw new Error('Assistant run completed without a text reply.');
  return { sessionId, runId: result.value.operationId, message };
}

/** Owns only assistant Sessions. Caller must keep one executor per assistant Home writer. */
export async function createAssistantExecutor(options: {
  assistantHome: string;
  host: AssistantHost;
  bundledSkillsRoot?: string;
}): Promise<AssistantExecutor> {
  const paths = await initializeAssistantHome(options.assistantHome,
    options.bundledSkillsRoot ? { bundledSkillsRoot: options.bundledSkillsRoot } : {});
  const repo = new JsonlSessionRepo({
    fileSystem: new NodeExecutionEnv({ cwd: paths.root }),
    sessionsRoot: 'sessions/pi',
  });
  const openSessions = new Map<string, Promise<AssistantSession>>();
  let closed = false;

  const openSession = async (selectedId?: string): Promise<AssistantSession> => {
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
      if (selectedId && !metadata) throw new Error(`Unknown assistant Session: ${selectedId}`);
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
        const { harness } = await AgentHarness.create({
          session,
          models,
          model,
          systemPrompt: frozen.prompt,
          resources: { skills },
          activeToolNames: [],
          tools: [],
        }, BACKGROUND_CONTEXT);
        const lane = await harness.lane('main', BACKGROUND_CONTEXT);
        let tail: Promise<unknown> = Promise.resolve();
        let sessionClosed = false;
        const serialize = (operation: () => Promise<AssistantTurnResult>): Promise<AssistantTurnResult> => {
          if (sessionClosed) return Promise.reject(new Error('Assistant Session is closed.'));
          const next = tail.then(operation);
          tail = next.catch(() => undefined);
          return next;
        };
        const assistantSession: AssistantSession = {
          sessionId,
          skillNames: Object.freeze(skills.map((skill) => skill.name)),
          prompt(message) {
            if (!message.trim()) return Promise.reject(new TypeError('Assistant message must not be empty.'));
            return serialize(() => completeTurn(lane, sessionId, lane.prompt(message, undefined, BACKGROUND_CONTEXT)));
          },
          invokeSkill(name, instructions) {
            if (!skills.some((skill) => skill.name === name)) {
              return Promise.reject(new Error(`Unknown assistant skill: ${name}`));
            }
            return serialize(() => completeTurn(lane, sessionId, lane.skill(name, instructions, BACKGROUND_CONTEXT)));
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
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...openSessions.values()].map(async (opening) => (await opening).close()));
      await repo.close(BACKGROUND_CONTEXT);
    },
  };
}
