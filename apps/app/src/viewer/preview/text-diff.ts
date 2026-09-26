/**
 * Minimal unified-diff generation for the preview's "replacement effect"
 * view. Not a general diff engine: the changed region is capped, and changes
 * too large to render meaningfully return undefined so the caller can hide
 * the diff option.
 */

const DEFAULT_CONTEXT_LINES = 3;
const MAX_REGION_LINES = 1200;
const MAX_PATCH_LINES = 3000;

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

type DiffStep = 'match' | 'remove' | 'insert';

/**
 * Walks the two regions once, pushing one step per emitted line: a match
 * (context), a removal from the old region, or an insertion from the new
 * region. The steps replay exactly into an ordered unified body.
 */
function lcsDiffSteps(oldLines: string[], newLines: string[]): DiffStep[] {
  const width = newLines.length + 1;
  const table = new Int32Array((oldLines.length + 1) * width);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = oldLines[i]! === newLines[j]!
        ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const steps: DiffStep[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i]! === newLines[j]!) {
      steps.push('match');
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      steps.push('remove');
      i += 1;
    } else {
      steps.push('insert');
      j += 1;
    }
  }
  while (i < oldLines.length) { steps.push('remove'); i += 1; }
  while (j < newLines.length) { steps.push('insert'); j += 1; }
  return steps;
}

/**
 * Builds a unified patch between the two texts, or undefined when the change
 * is too large. Common prefix/suffix is trimmed before diffing and restored
 * as context lines, so small edits inside big files still produce small
 * hunks with real context.
 */
export function createUnifiedDiff(
  oldText: string,
  newText: string,
  fileName: string,
  options?: { contextLines?: number; maxRegionLines?: number },
): string | undefined {
  if (oldText === newText) return undefined;
  const contextLines = options?.contextLines ?? DEFAULT_CONTEXT_LINES;
  const maxRegionLines = options?.maxRegionLines ?? MAX_REGION_LINES;
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;

  const oldRegion = oldLines.slice(prefix, oldLines.length - suffix);
  const newRegion = newLines.slice(prefix, newLines.length - suffix);
  if (oldRegion.length > maxRegionLines || newRegion.length > maxRegionLines) return undefined;

  const steps = lcsDiffSteps(oldRegion, newRegion);
  const regionBody: Array<{ marker: '-' | '+' | ' '; text: string }> = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const step of steps) {
    if (step === 'match') {
      regionBody.push({ marker: ' ', text: oldRegion[oldIndex]! });
      oldIndex += 1;
      newIndex += 1;
    } else if (step === 'remove') {
      regionBody.push({ marker: '-', text: oldRegion[oldIndex]! });
      oldIndex += 1;
    } else {
      regionBody.push({ marker: '+', text: newRegion[newIndex]! });
      newIndex += 1;
    }
  }
  const asContext = (text: string) => ({ marker: ' ' as const, text });
  const body = [
    ...oldLines.slice(0, prefix).map(asContext),
    ...regionBody,
    ...oldLines.slice(oldLines.length - suffix).map(asContext),
  ];

  const changed = body.map((line) => line.marker !== ' ');
  const hunks: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < body.length; index += 1) {
    if (!changed[index]) continue;
    const start = Math.max(0, index - contextLines);
    const last = hunks[hunks.length - 1];
    if (last && start <= last.end) {
      last.end = Math.min(body.length, index + contextLines + 1);
      continue;
    }
    hunks.push({ start, end: Math.min(body.length, index + contextLines + 1) });
  }

  const output: string[] = [`--- a/${fileName}`, `+++ b/${fileName}`];
  for (const hunk of hunks) {
    const slice = body.slice(hunk.start, hunk.end);
    const oldStart = body.slice(0, hunk.start).filter((line) => line.marker !== '+').length + 1;
    const newStart = body.slice(0, hunk.start).filter((line) => line.marker !== '-').length + 1;
    const oldCount = slice.filter((line) => line.marker !== '+').length;
    const newCount = slice.filter((line) => line.marker !== '-').length;
    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const line of slice) output.push(`${line.marker}${line.text}`);
  }
  if (output.length > MAX_PATCH_LINES) return undefined;
  return output.join('\n');
}

/** Counts +/- lines in a unified patch, ignoring headers and hunk markers. */
export function countDiffChanges(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}
