import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SettingsManager,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  CAPABILITY_TOOL_NAMES,
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
  approvalToken: Type.Optional(Type.String()),
}, { additionalProperties: false });

export function createYuanpuCapabilityTools(client: CapabilityToolClient): ToolDefinition[] {
  return [
    defineTool({
      name: CAPABILITY_TOOL_NAMES.search,
      label: 'Search capabilities',
      description: 'Find external capabilities available to the current workspace. Use an empty query to list available capabilities.',
      parameters: searchParameters,
      execute: async (_toolCallId, params) => {
        const result = await client.search(params);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: result,
        };
      },
    }),
    defineTool({
      name: CAPABILITY_TOOL_NAMES.execute,
      label: 'Execute capability',
      description: 'Execute an external capability by its exact name from search_capabilities.',
      parameters: executeParameters,
      execute: async (_toolCallId, params) => {
        const input = {
          name: params.name,
          arguments: params.arguments,
          approvalToken: params.approvalToken,
        } as ExecuteCapabilityInput;
        const result = await client.execute(input);
        return {
          content: [{ type: 'text', text: JSON.stringify(result.content) }],
          details: result,
        };
      },
    }),
  ];
}

export type CreateYuanpuAgentSessionOptions = CreateAgentSessionOptions & {
  capabilityClient: CapabilityToolClient;
};

export function createYuanpuAgentSession(
  options: CreateYuanpuAgentSessionOptions,
): Promise<CreateAgentSessionResult> {
  const { capabilityClient, ...sessionOptions } = options;
  const capabilityTools = createYuanpuCapabilityTools(capabilityClient);
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
  agentDir: string;
  cwd: string;
  provider: string;
  model: string;
  apiKey?: string;
  apiKeyEnv: string;
  baseUrl?: string;
  api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';
}

export interface YuanpuChatSession {
  prompt(message: string): Promise<YuanpuChatResult>;
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

  const { session } = await createYuanpuAgentSession({
    capabilityClient: options.capabilityClient,
    cwd: options.cwd,
    agentDir: options.agentDir,
    model,
    modelRuntime,
    resourceLoader,
    settingsManager,
  });

  let queue: Promise<void> = Promise.resolve();
  const runPrompt = async (message: string): Promise<YuanpuChatResult> => {
    let text = '';
    const toolStates = new Map<string, 'completed' | 'failed'>();
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        text += event.assistantMessageEvent.delta;
      }
      if (event.type === 'tool_execution_end') {
        toolStates.set(event.toolName, event.isError ? 'failed' : 'completed');
      }
    });
    try {
      await session.prompt(message);
      return {
        message: text.trim() || '完成。',
        tools: [...toolStates].map(([name, status]) => ({ name, status })),
      };
    } finally {
      unsubscribe();
    }
  };

  return {
    prompt(message) {
      const task = queue.then(() => runPrompt(message));
      queue = task.then(() => undefined, () => undefined);
      return task;
    },
    dispose() {
      session.dispose();
    },
  };
}
