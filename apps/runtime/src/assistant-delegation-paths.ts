import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve } from 'node:path';

/** Reject symlinked roots and ancestors before creating any task-owned directory. */
export async function assertNoSymlinkAncestors(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Delegation path must be absolute.');
  const absolute = resolve(path);
  for (let current = absolute; ; current = dirname(current)) {
    try {
      // macOS maps /var and /tmp through top-level system links. No unprivileged
      // caller can create that root-level entry; reject every lower symlink.
      if ((await lstat(current)).isSymbolicLink() && dirname(current) !== parse(current).root) {
        throw new Error('Symlinked delegation path is forbidden.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (dirname(current) === current) break;
  }
  return absolute;
}

export async function canonicalRealDirectory(path: string): Promise<string> {
  await assertNoSymlinkAncestors(path);
  const info = await lstat(path);
  if (!info.isDirectory()) throw new Error('Delegation path must be a directory.');
  return realpath(path);
}
