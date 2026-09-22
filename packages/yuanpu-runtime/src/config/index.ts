import { access, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function greeting(name = 'world'): string {
  return `Hello, ${name}!`;
}

export interface YuanpuConfig {
  schemaVersion: 1;
  provider: string;
  model: string;
  apiKeyEnv: string;
  workingDirectory: string;
  catalogUrl?: string;
  baseUrl?: string;
  api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';
  notifications?: { enabled: boolean };
}

export interface YuanpuHome {
  root: string;
  appPath: string;
  agentPath: string;
  packagesPath: string;
  workflowsPath: string;
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
    || (config.catalogUrl !== undefined && typeof config.catalogUrl !== 'string')
    || (config.baseUrl !== undefined && typeof config.baseUrl !== 'string')
    || (config.api !== undefined && ![
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
      'google-generative-ai',
    ].includes(config.api))
    || (config.notifications !== undefined && (
      !config.notifications
      || typeof config.notifications !== 'object'
      || typeof config.notifications.enabled !== 'boolean'
    ))
  ) {
    throw new Error(`Invalid Yuanpu config: ${configPath}`);
  }
  return { ...config } as YuanpuConfig;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function migratePath(from: string, to: string): Promise<void> {
  if (!await pathExists(from) || await pathExists(to)) return;
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
}

function replaceLegacyPath(value: unknown, legacyRoot: string, packagesPath: string): unknown {
  if (typeof value === 'string') {
    return value.startsWith(legacyRoot) ? `${packagesPath}${value.slice(legacyRoot.length)}` : value;
  }
  if (Array.isArray(value)) return value.map((entry) => replaceLegacyPath(entry, legacyRoot, packagesPath));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => (
    [key, replaceLegacyPath(entry, legacyRoot, packagesPath)]
  )));
}

async function rewriteMigratedPackagePaths(agentPath: string, packagesPath: string, legacyPackagesPath: string) {
  for (const path of [join(packagesPath, 'state.json'), join(agentPath, 'settings.json')]) {
    if (!await pathExists(path)) continue;
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const migrated = replaceLegacyPath(value, legacyPackagesPath, packagesPath);
    await writeFile(path, `${JSON.stringify(migrated, null, 2)}\n`, { mode: 0o600 });
  }
}

export async function ensureYuanpuHome(root = join(homedir(), '.yuanpu')): Promise<YuanpuHome> {
  const resolvedRoot = resolve(root);
  const appPath = join(resolvedRoot, 'app');
  const agentPath = join(resolvedRoot, 'agent');
  const packagesPath = join(resolvedRoot, 'packages');
  const workflowsPath = join(resolvedRoot, 'workflows');
  const configPath = join(appPath, 'config.json');
  const skillsPath = join(agentPath, 'skills');
  const memoryPath = join(agentPath, 'memory');
  const sessionsPath = join(agentPath, 'sessions');
  const legacyPackagesPath = join(resolvedRoot, 'plugins');

  await mkdir(resolvedRoot, { recursive: true });
  await Promise.all([
    migratePath(join(resolvedRoot, 'config.json'), configPath),
    migratePath(join(resolvedRoot, 'settings.json'), join(agentPath, 'settings.json')),
    migratePath(join(resolvedRoot, 'auth.json'), join(agentPath, 'auth.json')),
    migratePath(join(resolvedRoot, 'models.json'), join(agentPath, 'models.json')),
    migratePath(join(resolvedRoot, 'models-store.json'), join(agentPath, 'models-store.json')),
    migratePath(join(resolvedRoot, 'yuanpu-models.json'), join(agentPath, 'yuanpu-models.json')),
    migratePath(join(resolvedRoot, 'mcp.json'), join(agentPath, 'mcp.json')),
    migratePath(join(resolvedRoot, 'mcp-cache.json'), join(agentPath, 'mcp-cache.json')),
    migratePath(join(resolvedRoot, 'skills'), skillsPath),
    migratePath(join(resolvedRoot, 'memory'), memoryPath),
    migratePath(join(resolvedRoot, 'sessions'), sessionsPath),
    migratePath(legacyPackagesPath, packagesPath),
  ]);
  await Promise.all([
    mkdir(appPath, { recursive: true }),
    mkdir(agentPath, { recursive: true }),
    mkdir(skillsPath, { recursive: true }),
    mkdir(memoryPath, { recursive: true }),
    mkdir(packagesPath, { recursive: true }),
    mkdir(sessionsPath, { recursive: true }),
    mkdir(workflowsPath, { recursive: true }),
  ]);
  if (process.platform !== 'win32') await chmod(workflowsPath, 0o700);
  await rewriteMigratedPackagePaths(agentPath, packagesPath, legacyPackagesPath);

  let config: YuanpuConfig;
  try {
    config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')), configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    config = { ...DEFAULT_CONFIG, workingDirectory: homedir() };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
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

  return {
    root: resolvedRoot,
    appPath,
    agentPath,
    packagesPath,
    workflowsPath,
    configPath,
    skillsPath,
    memoryPath,
    sessionsPath,
    config,
  };
}
