import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function greeting(name = 'world'): string {
  return `Hello, ${name}!`;
}

export interface YuanpuConfig {
  schemaVersion: 1;
  provider: string;
  model: string;
  apiKeyEnv: string;
  workingDirectory: string;
  baseUrl?: string;
  api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';
}

export interface YuanpuHome {
  root: string;
  configPath: string;
  skillsPath: string;
  memoryPath: string;
  sessionsPath: string;
  config: YuanpuConfig;
}

const DEFAULT_CONFIG: Omit<YuanpuConfig, 'workingDirectory'> = {
  schemaVersion: 1,
  provider: 'openai',
  model: 'gpt-5.6-luna',
  apiKeyEnv: 'OPENAI_API_KEY',
};

function validateConfig(value: unknown, configPath: string): YuanpuConfig {
  if (!value || typeof value !== 'object') throw new Error(`Invalid Yuanpu config: ${configPath}`);
  const config = value as Partial<YuanpuConfig>;
  if (
    config.schemaVersion !== 1
    || typeof config.provider !== 'string'
    || typeof config.model !== 'string'
    || typeof config.apiKeyEnv !== 'string'
    || typeof config.workingDirectory !== 'string'
    || (config.baseUrl !== undefined && typeof config.baseUrl !== 'string')
    || (config.api !== undefined && ![
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
      'google-generative-ai',
    ].includes(config.api))
  ) {
    throw new Error(`Invalid Yuanpu config: ${configPath}`);
  }
  return { ...config } as YuanpuConfig;
}

export async function ensureYuanpuHome(root = join(homedir(), '.yuanpu')): Promise<YuanpuHome> {
  const resolvedRoot = resolve(root);
  const configPath = join(resolvedRoot, 'config.json');
  const skillsPath = join(resolvedRoot, 'skills');
  const memoryPath = join(resolvedRoot, 'memory');
  const sessionsPath = join(resolvedRoot, 'sessions');
  await Promise.all([
    mkdir(skillsPath, { recursive: true }),
    mkdir(memoryPath, { recursive: true }),
    mkdir(sessionsPath, { recursive: true }),
  ]);

  let config: YuanpuConfig;
  try {
    config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')), configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    config = { ...DEFAULT_CONFIG, workingDirectory: homedir() };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  }

  const memoryFile = join(memoryPath, 'MEMORY.md');
  try {
    await writeFile(
      memoryFile,
      '# YuanpuAgent memory\n\nAdd durable preferences and working context here.\n',
      { flag: 'wx' },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  return { root: resolvedRoot, configPath, skillsPath, memoryPath, sessionsPath, config };
}
