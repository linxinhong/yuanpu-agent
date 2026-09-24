import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentToolResult,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  CAPABILITY_TOOL_NAMES,
  type CapabilityContext,
  type CapabilityFailure,
  type CapabilityToolClient,
  type ExecuteCapabilityInput,
} from '../capabilities/contracts.js';
import { Type } from 'typebox';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PI_UPSTREAM_VERSION = '0.86.1';

const searchParameters = Type.Object({
  query: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
}, { additionalProperties: false });

const executeParameters = Type.Object({
  name: Type.String({ minLength: 1 }),
  arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  approvalRequestId: Type.Optional(Type.String()),
}, { additionalProperties: false });

function capabilityResultForPi(
  result: Awaited<ReturnType<CapabilityToolClient['execute']>>,
): AgentToolResult<Awaited<ReturnType<CapabilityToolClient['execute']>>> {
  const content: AgentToolResult['content'] = [];
  for (const block of result.content) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image') {
      content.push({ type: 'image', data: block.data, mimeType: block.mimeType });
      continue;
    }
    content.push({
      type: 'text' as const,
      text: `[Unsupported MCP ${block.type} content preserved in tool details]`,
    });
  }
  if (content.length === 0 && result.structuredContent) {
    content.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
  }
  if (result.isError) {
    content.unshift({ type: 'text', text: '[The external capability reported an error]' });
  }
  return { content, details: result };
}

function capabilityFailureFrom(error: unknown): CapabilityFailure | undefined {
  if (!error || typeof error !== 'object' || !('failure' in error)) return undefined;
  const failure = (error as { failure?: unknown }).failure;
  if (!failure || typeof failure !== 'object' || !('error' in failure) || !('message' in failure)) {
    return undefined;
  }
  return failure as CapabilityFailure;
}

export function createYuanpuCapabilityTools(
  client: CapabilityToolClient,
  context: CapabilityContext = {},
): ToolDefinition[] {
  return [
    defineTool({
      name: CAPABILITY_TOOL_NAMES.search,
      label: 'Search capabilities',
      description: 'Find external capabilities available to the current workspace. Use an empty query to list available capabilities.',
      parameters: searchParameters,
      execute: async (_toolCallId, params, signal) => {
        const result = await client.search(params, { ...context, signal });
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: result,
        };
      },
    }),
    defineTool<typeof executeParameters, (
      Awaited<ReturnType<CapabilityToolClient['execute']>> | { capabilityError: CapabilityFailure }
    )>({
      name: CAPABILITY_TOOL_NAMES.execute,
      label: 'Execute capability',
      description: 'Execute an external capability by its exact name from search_capabilities.',
      parameters: executeParameters,
      execute: async (_toolCallId, params, signal) => {
        const input = {
          name: params.name,
          arguments: params.arguments,
          approvalRequestId: params.approvalRequestId,
        } as ExecuteCapabilityInput;
        try {
          const result = await client.execute(input, { ...context, signal });
          return capabilityResultForPi(result);
        } catch (error) {
          const failure = capabilityFailureFrom(error);
          if (!failure) throw error;
          return {
            content: [{ type: 'text', text: JSON.stringify({ capabilityError: failure }) }],
            details: { capabilityError: failure },
          };
        }
      },
    }),
  ];
}

export type CreateYuanpuAgentSessionOptions = CreateAgentSessionOptions & {
  capabilityClient: CapabilityToolClient;
  capabilityContext?: CapabilityContext;
};

export function createYuanpuAgentSession(
  options: CreateYuanpuAgentSessionOptions,
): Promise<CreateAgentSessionResult> {
  const { capabilityClient, capabilityContext, ...sessionOptions } = options;
  const capabilityTools = createYuanpuCapabilityTools(capabilityClient, capabilityContext);
  const tools = sessionOptions.tools ?? [
    'read',
    'write',
    'edit',
    'bash',
    CAPABILITY_TOOL_NAMES.search,
    CAPABILITY_TOOL_NAMES.execute,
  ];

  return createAgentSession({
    ...sessionOptions,
    tools,
    customTools: [...(sessionOptions.customTools ?? []), ...capabilityTools],
  });
}

export interface YuanpuChatResult {
  message: string;
  tools: Array<{ name: string; status: 'completed' | 'failed' }>;
  pendingApprovalRequestId?: string;
}

export interface YuanpuExtensionDiagnostic {
  path: string;
  error: string;
}

export interface YuanpuLocalSkill {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation: boolean;
}

export interface YuanpuSkillDiagnostic {
  path: string;
  message: string;
}

export async function inspectYuanpuSkills(options: {
  agentDir: string;
  cwd: string;
}): Promise<{ skills: YuanpuLocalSkill[]; diagnostics: YuanpuSkillDiagnostic[] }> {
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    noExtensions: true,
    noThemes: true,
  });
  await resourceLoader.reload();
  const result = resourceLoader.getSkills();
  const localSkillsRoot = join(options.agentDir, 'skills');
  return {
    skills: result.skills.filter((skill) => skill.filePath.startsWith(localSkillsRoot)).map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      disableModelInvocation: skill.disableModelInvocation,
    })),
    diagnostics: result.diagnostics.filter((diagnostic) => (
      !diagnostic.path || diagnostic.path.startsWith(localSkillsRoot)
    )).map((diagnostic) => ({
      path: diagnostic.path ?? '',
      message: diagnostic.message,
    })),
  };
}

export async function inspectYuanpuExtensions(options: {
  agentDir: string;
  cwd: string;
}): Promise<YuanpuExtensionDiagnostic[]> {
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    noThemes: true,
  });
  await resourceLoader.reload();
  const result = resourceLoader.getExtensions();
  const diagnostics = result.errors.map(({ path, error }) => ({ path, error }));
  result.runtime.invalidate('Extension inspection completed.');
  return diagnostics;
}

export interface CreateYuanpuChatOptions {
  capabilityClient: CapabilityToolClient;
  capabilityContext?: CapabilityContext;
  agentDir: string;
  cwd: string;
  provider: string;
  model: string;
  apiKey?: string;
  apiKeyEnv: string;
  baseUrl?: string;
  api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';
  piSession?: { id: string; directory: string };
}

export interface YuanpuChatSession {
  readonly sessionId: string;
  prompt(message: string, options?: { runId?: string; signal?: AbortSignal }): Promise<YuanpuChatResult>;
  abort(): Promise<void>;
  dispose(): void;
}

async function readMemory(agentDir: string): Promise<string> {
  try {
    return await readFile(join(agentDir, 'memory', 'MEMORY.md'), 'utf8');
  } catch {
    return '';
  }
}

export async function createYuanpuChatSession(
  options: CreateYuanpuChatOptions,
): Promise<YuanpuChatSession> {
  const modelsPath = options.baseUrl
    ? join(options.agentDir, 'yuanpu-models.json')
    : join(options.agentDir, 'models.json');
  if (options.baseUrl) {
    await writeFile(modelsPath, `${JSON.stringify({
      providers: {
        [options.provider]: {
          name: options.provider,
          baseUrl: options.baseUrl,
          api: options.api ?? 'openai-completions',
          apiKey: `$${options.apiKeyEnv}`,
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
          models: [{
            id: options.model,
            name: options.model,
            reasoning: false,
            input: ['text'],
            contextWindow: 128_000,
            maxTokens: 32_000,
          }],
        },
      },
    }, null, 2)}\n`);
  }
  const modelRuntime = await ModelRuntime.create({
    authPath: join(options.agentDir, 'auth.json'),
    modelsPath,
    modelsStorePath: join(options.agentDir, 'models-store.json'),
  });
  if (options.apiKey) await modelRuntime.setRuntimeApiKey(options.provider, options.apiKey);
  const model = modelRuntime.getModel(options.provider, options.model);
  if (!model) throw new Error(`Unknown model ${options.provider}/${options.model}`);

  const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
  const memory = await readMemory(options.agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    systemPromptOverride: () => [
      'You are YuanpuAgent, a concise work assistant.',
      'External capabilities are available only through search_capabilities and execute_capability.',
      'When the user explicitly asks to use, test, or call an external capability, search first and then execute the exact returned name.',
      memory ? `Durable user memory:\n${memory}` : '',
    ].filter(Boolean).join('\n\n'),
  });
  await resourceLoader.reload();

  const capabilityContext = { ...options.capabilityContext };
  const existingSessionPath = options.piSession
    ? SessionManager.findById(options.cwd, options.piSession.id, options.piSession.directory)
    : undefined;
  const sessionManager = options.piSession
    ? existingSessionPath
      ? SessionManager.open(existingSessionPath, options.piSession.directory, options.cwd)
      : SessionManager.create(options.cwd, options.piSession.directory, { id: options.piSession.id })
    : undefined;
  const { session } = await createYuanpuAgentSession({
    capabilityClient: options.capabilityClient,
    capabilityContext,
    cwd: options.cwd,
    agentDir: options.agentDir,
    model,
    modelRuntime,
    resourceLoader,
    ...(sessionManager ? { sessionManager } : {}),
    settingsManager,
  });

  let queue: Promise<void> = Promise.resolve();
  const runPrompt = async (
    message: string,
    options: { runId?: string; signal?: AbortSignal } = {},
  ): Promise<YuanpuChatResult> => {
    if (options.signal?.aborted) throw new DOMException('Agent run was cancelled.', 'AbortError');
    capabilityContext.runId = options.runId;
    let text = '';
    let modelFailed = false;
    const toolStates = new Map<string, 'completed' | 'failed'>();
    let pendingApprovalRequestId: string | undefined;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        modelFailed = event.message.stopReason === 'error';
      }
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        text += event.assistantMessageEvent.delta;
      }
      if (event.type === 'tool_execution_end') {
        const details = event.result?.details as {
          capabilityError?: { error?: unknown; approvalRequestId?: unknown };
        } | undefined;
        toolStates.set(event.toolName, event.isError || details?.capabilityError ? 'failed' : 'completed');
        if (
          details?.capabilityError?.error === 'needs_approval'
          && typeof details.capabilityError.approvalRequestId === 'string'
        ) {
          pendingApprovalRequestId ??= details.capabilityError.approvalRequestId;
        }
      }
    });
    const abort = () => {
      void session.abort();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      await session.prompt(message);
      if (options.signal?.aborted) throw new DOMException('Agent run was cancelled.', 'AbortError');
      if (modelFailed) throw new Error('模型请求失败，请检查模型配置或稍后重试。');
      return {
        message: text.trim() || '完成。',
        tools: [...toolStates].map(([name, status]) => ({ name, status })),
        ...(pendingApprovalRequestId ? { pendingApprovalRequestId } : {}),
      };
    } finally {
      options.signal?.removeEventListener('abort', abort);
      unsubscribe();
    }
  };

  return {
    sessionId: session.sessionId,
    prompt(message, options) {
      const task = queue.then(() => runPrompt(message, options));
      queue = task.then(() => undefined, () => undefined);
      return task;
    },
    abort() {
      return session.abort();
    },
    dispose() {
      session.dispose();
    },
  };
}
