const LINK_TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'md', 'markdown', 'json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'html', 'htm', 'css',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp',
  'cs', 'php', 'sh', 'bash', 'zsh', 'toml', 'ini', 'cfg', 'conf', 'sql', 'env', 'lock',
]);

const LINK_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);

/**
 * Extracts file-path-like candidates from chat message text. A candidate
 * needs a separator-bearing path or a previewable extension; numeric versions
 * ("1.2.3") and URLs are ignored. Order is preserved and duplicates removed.
 */
export function extractFilePathCandidates(text: string): string[] {
  const candidates: string[] = [];
  const pattern = /[\w~+.-]+(?:\/[\w~+.-]+)*\.[A-Za-z][\w]{0,7}/g;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const before = text.slice(Math.max(0, index - 8), index);
    if (before.includes('://')) continue;
    const extension = raw.slice(raw.lastIndexOf('.') + 1).toLowerCase();
    const hasSeparator = raw.includes('/');
    if (!hasSeparator && !LINK_TEXT_EXTENSIONS.has(extension) && !LINK_IMAGE_EXTENSIONS.has(extension)
      && extension !== 'pdf') continue;
    if (!candidates.includes(raw)) candidates.push(raw);
  }
  return candidates;
}

/** Returns a normalized workspace-relative path, or null when the input escapes or is unusable. */
export function normalizeWorkspacePath(input: string): string | null {
  if (!input || input.includes('\0')) return null;
  const segments: string[] = [];
  for (const segment of input.split(/[\\/]+/)) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/** Splits text so path candidates can render as separate interactive nodes. */
export function splitTextByFilePaths(text: string): Array<{ kind: 'text' | 'path'; value: string }> {
  const candidates = extractFilePathCandidates(text);
  if (!candidates.length) return [{ kind: 'text', value: text }];
  const parts: Array<{ kind: 'text' | 'path'; value: string }> = [];
  let cursor = 0;
  for (const candidate of candidates) {
    const index = text.indexOf(candidate, cursor);
    if (index < 0) continue;
    if (index > cursor) parts.push({ kind: 'text', value: text.slice(cursor, index) });
    parts.push({ kind: 'path', value: candidate });
    cursor = index + candidate.length;
  }
  if (cursor < text.length) parts.push({ kind: 'text', value: text.slice(cursor) });
  return parts;
}
