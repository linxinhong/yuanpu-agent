import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface VerifiedWorkArtifact {
  entryId: string;
  relativePath: string;
  sha256: string;
  size: number;
  text: string;
}

const maximumArtifactBytes = 256 * 1024;

/** A successful file tool is only a candidate until the host verifies this file. */
export async function inspectWorkArtifact(workspace: string, relativePath: string,
  entryId: string): Promise<VerifiedWorkArtifact | undefined> {
  if (!entryId || !relativePath || relativePath.includes('\0') || isAbsolute(relativePath)
    || relativePath.split(sep).some((segment) => !segment || segment === '..' || segment === '.')) {
    return undefined;
  }
  try {
    const root = await realpath(workspace);
    const target = resolve(root, relativePath);
    const within = relative(root, target);
    if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) return undefined;
    let current = root;
    for (const [index, segment] of relativePath.split(sep).entries()) {
      current = join(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink()) return undefined;
      if (index < relativePath.split(sep).length - 1 ? !info.isDirectory() : !info.isFile()) {
        return undefined;
      }
    }
    const realTarget = await realpath(target);
    const realWithin = relative(root, realTarget);
    if (!realWithin || realWithin === '..' || realWithin.startsWith(`..${sep}`)
      || isAbsolute(realWithin)) return undefined;
    const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maximumArtifactBytes) return undefined;
      const stillBoundToTarget = async (): Promise<boolean> => {
        // O_NOFOLLOW covers only the last component. Revalidate each parent and
        // compare the opened inode with the path after open, before and after read.
        let component = root;
        for (const segment of relativePath.split(sep)) {
          component = join(component, segment);
          const current = await lstat(component);
          if (current.isSymbolicLink()) return false;
        }
        const resolvedTarget = await realpath(target);
        const inside = relative(root, resolvedTarget);
        if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
          return false;
        }
        const current = await lstat(target);
        return current.isFile() && current.dev === info.dev && current.ino === info.ino;
      };
      if (!await stillBoundToTarget()) return undefined;
      const buffer = Buffer.alloc(info.size + 1);
      let count = 0;
      while (count < buffer.length) {
        const read = await file.read(buffer, count, buffer.length - count, count);
        if (!read.bytesRead) break;
        count += read.bytesRead;
      }
      if (count !== info.size) return undefined;
      if (!await stillBoundToTarget()) return undefined;
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count)); }
      catch { return undefined; }
      if (text.includes('\0')) return undefined;
      return { entryId, relativePath,
        sha256: createHash('sha256').update(buffer.subarray(0, count)).digest('hex'), size: count, text };
    } finally { await file.close(); }
  } catch { return undefined; }
}
