export interface CachedFileVersion {
  content: string;
  truncated: boolean;
  size: number;
  updatedAt: string;
}

const MAX_CACHED_FILES = 200;

/** Per-conversation in-memory snapshot of the last text preview, per file. */
const versions = new Map<string, CachedFileVersion>();

function cacheKey(scopeKey: string, path: string): string {
  return `${scopeKey}\u0000${path}`;
}

export function rememberFileVersion(scopeKey: string, path: string, version: CachedFileVersion): void {
  const key = cacheKey(scopeKey, path);
  versions.delete(key);
  versions.set(key, version);
  while (versions.size > MAX_CACHED_FILES) {
    const oldest = versions.keys().next().value;
    if (oldest === undefined) break;
    versions.delete(oldest);
  }
}

export function getKnownFileVersion(scopeKey: string, path: string): CachedFileVersion | undefined {
  return versions.get(cacheKey(scopeKey, path));
}

export function clearFileVersions(scopeKey: string): void {
  for (const key of versions.keys()) {
    if (key.startsWith(`${scopeKey}\u0000`)) versions.delete(key);
  }
}
