import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AssistantHomePaths {
  root: string;
  config: string;
  soul: string;
  user: string;
  memory: string;
  skills: string;
  sessions: string;
  snapshots: string;
}

const defaultSoul = '# Assistant identity\n\nYou are the user’s personal assistant. Work from evidence, respect source scope, and distinguish facts from uncertainty. Do not invent facts about the user.\n';
const defaultUser = '# About the user\n\n';
const defaultMemory = '# Current memory\n\n';
const maxCoreCharacters = 16_000;

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function resolveAssistantHome(assistantHome: string): AssistantHomePaths {
  if (!isAbsolute(assistantHome)) throw new TypeError('assistantHome must be an explicit absolute path.');
  const root = resolve(assistantHome);
  return {
    root,
    config: join(root, 'config.json'),
    soul: join(root, 'SOUL.md'),
    user: join(root, 'memories', 'USER.md'),
    memory: join(root, 'memories', 'MEMORY.md'),
    skills: join(root, 'skills'),
    sessions: join(root, 'sessions'),
    snapshots: join(root, 'sessions', 'snapshots'),
  };
}

export async function assertSafeDirectory(path: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
    info = await lstat(path);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Expected a real directory: ${path}`);
}

async function ensureFile(path: string, content: string | Uint8Array): Promise<void> {
  try {
    await writeFile(path, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a real file: ${path}`);
}

async function seedSkillTree(source: string, target: string): Promise<void> {
  await assertSafeDirectory(target);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      await seedSkillTree(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await ensureFile(targetPath, await readFile(sourcePath));
    } else {
      throw new Error(`Unsupported bundled assistant skill entry: ${sourcePath}`);
    }
  }
}

function bundledRoot(): string {
  return fileURLToPath(new URL('../skills/', import.meta.url));
}

/** Copy newly bundled skills once. Existing user-edited files remain authoritative. */
export async function seedBundledAssistantSkills(
  paths: AssistantHomePaths,
  sourceRoot = bundledRoot(),
): Promise<void> {
  await assertSafeDirectory(paths.skills);
  const sourceInfo = await lstat(sourceRoot);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error(`Expected a real bundled assistant skills directory: ${sourceRoot}`);
  }
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory()) throw new Error(`Unsupported bundled assistant skill entry: ${entry.name}`);
    await seedSkillTree(join(sourceRoot, entry.name), join(paths.skills, entry.name));
  }
}

export async function initializeAssistantHome(
  assistantHome: string,
  options: { bundledSkillsRoot?: string } = {},
): Promise<AssistantHomePaths> {
  const paths = resolveAssistantHome(assistantHome);
  await assertSafeDirectory(paths.root);
  await assertSafeDirectory(join(paths.root, 'memories'));
  await assertSafeDirectory(paths.sessions);
  await assertSafeDirectory(join(paths.sessions, 'pi'));
  await assertSafeDirectory(paths.snapshots);
  await ensureFile(paths.config, '{"schemaVersion":1}\n');
  await ensureFile(paths.soul, defaultSoul);
  await ensureFile(paths.user, defaultUser);
  await ensureFile(paths.memory, defaultMemory);
  await seedBundledAssistantSkills(paths, options.bundledSkillsRoot);
  return paths;
}

export async function readAssistantHomeFile(paths: AssistantHomePaths, path: string): Promise<string> {
  const canonicalRoot = await realpath(paths.root);
  const canonicalPath = await realpath(path);
  const child = relative(canonicalRoot, canonicalPath);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`File escapes assistantHome: ${path}`);
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a real assistant file: ${path}`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}

/** Core memory is frozen only when a new Session is created. */
export async function createFrozenAssistantPrompt(paths: AssistantHomePaths, skillList: string): Promise<string> {
  const sections = await Promise.all([
    readAssistantHomeFile(paths, paths.soul),
    readAssistantHomeFile(paths, paths.user),
    readAssistantHomeFile(paths, paths.memory),
  ]);
  for (const section of sections) {
    if (section.length > maxCoreCharacters) throw new Error('Assistant core file exceeds the session prompt budget.');
  }
  return [
    sections[0],
    'The following user information is verified only to the extent stated below. Empty sections contain no known facts.',
    sections[1],
    sections[2],
    skillList,
  ].filter(Boolean).join('\n\n');
}
