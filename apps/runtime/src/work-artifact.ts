import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface RegisteredWorkWriteArtifact {
  entryId: string;
  relativePath: string;
  sha256: string;
  size: number;
  text: string;
}

const maximumArtifactBytes = 256 * 1024;

/** Register the exact successful write-tool payload, without reading a mutable Work path. */
export function registerWorkWriteArtifact(workspace: string, requestedPath: string,
  entryId: string, content: string): RegisteredWorkWriteArtifact | undefined {
  if (!entryId || !requestedPath || requestedPath.includes('\0') || typeof content !== 'string'
    || isAbsolute(requestedPath)
    || requestedPath.split(/[\\/]/u).some((segment) => !segment || segment === '.' || segment === '..')) {
    return undefined;
  }
  const root = resolve(workspace);
  const target = resolve(root, requestedPath);
  const relativePath = relative(root, target);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath) || relativePath.split(sep).some((segment) => !segment || segment === '..')) {
    return undefined;
  }
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.byteLength > maximumArtifactBytes || content.includes('\0')) return undefined;
  return { entryId, relativePath, sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength, text: content };
}
