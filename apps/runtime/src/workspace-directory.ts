import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rmdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

function timestamp(date: Date): string {
  const parts = [date.getFullYear(), date.getMonth() + 1, date.getDate(),
    date.getHours(), date.getMinutes(), date.getSeconds()];
  return parts.map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
    .join('-');
}

/** An unnamed Work conversation owns a fresh directory; explicit directories remain user selected. */
export async function createWorkspaceDirectory(root: string, date = new Date()): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const directory = join(root, `${timestamp(date)}-${randomUUID().replaceAll('-', '').slice(0, 10)}`);
    try {
      await mkdir(directory, { mode: 0o700 });
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not allocate a unique workspace directory.');
}

export async function resolveSelectedWorkspaceDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('The selected workspace directory must be an absolute path.');
  const directory = resolve(path);
  if (!(await stat(directory)).isDirectory()) throw new Error('The selected workspace path is not a directory.');
  return directory;
}

/** Allocates a stable-ID child beneath a managed folder, rejecting symlinked parents. */
export async function createManagedWorkspaceDirectory(root: string, parentRelative: string,
  leaf: string): Promise<string> {
  if (!/^(?:f-[0-9a-f-]{36}(?:\/f-[0-9a-f-]{36})*)?$/.test(parentRelative)
    || !/^[cf]-[0-9a-f-]{36}$/.test(leaf)) throw new Error('Invalid managed workspace path.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Managed workspace root is a symbolic link.');
  const canonicalRoot = await realpath(root);
  const parent = join(root, parentRelative);
  let checked = root;
  for (const segment of parentRelative.split('/').filter(Boolean)) {
    checked = join(checked, segment);
    if ((await lstat(checked)).isSymbolicLink()) {
      throw new Error('Managed workspace parent is a symbolic link.');
    }
  }
  if (await realpath(parent) !== join(canonicalRoot, parentRelative)) {
    throw new Error('Managed workspace parent is a symbolic link.');
  }
  const directory = join(parent, leaf);
  await mkdir(directory, { mode: 0o700 });
  if (await realpath(directory) !== join(canonicalRoot, parentRelative, leaf)) {
    await rmdir(directory).catch(() => {});
    throw new Error('Managed workspace parent changed during creation.');
  }
  return directory;
}

export async function removeUncommittedWorkspaceDirectory(root: string, relativeDirectory: string): Promise<void> {
  if (!/^(?:f-[0-9a-f-]{36}\/)*[cf]-[0-9a-f-]{36}$/.test(relativeDirectory)) {
    throw new Error('Invalid pending Work directory.');
  }
  const rootEntry = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!rootEntry) return;
  if (rootEntry.isSymbolicLink()) throw new Error('Managed workspace root is a symbolic link.');
  const directory = join(root, relativeDirectory);
  const entry = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!entry) return;
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Pending Work directory is not a plain directory.');
  const canonicalRoot = await realpath(root);
  const parent = dirname(directory);
  if (await realpath(parent) !== join(canonicalRoot, dirname(relativeDirectory))) {
    throw new Error('Pending Work directory escapes managed workspace.');
  }
  await rmdir(directory);
}
