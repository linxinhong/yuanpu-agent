import { useMemo } from 'react';
import { PatchDiff } from '@pierre/diffs/react';

import { createUnifiedDiff } from './text-diff.js';

function currentAppTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-yuanpu-theme') === 'yuanpu-dark' ? 'dark' : 'light';
}

/**
 * Renders the replacement effect between the previously seen file version and
 * the current one via @pierre/diffs. Large changes return no patch and
 * degrade to a clear message instead of a broken render.
 */
export function FileDiffView({ fileName, oldText, newText }: { fileName: string; oldText: string; newText: string }) {
  const patch = useMemo(
    () => createUnifiedDiff(oldText, newText, fileName),
    [oldText, newText, fileName],
  );
  if (!patch) {
    return <p className="file-preview-error" role="status">改动过大，替换效果视图不可用，请查看最终内容。</p>;
  }
  return <div className="file-diff-view">
    <PatchDiff patch={patch} disableWorkerPool
      options={{ theme: { light: 'github-light', dark: 'github-dark' }, themeType: currentAppTheme(), diffStyle: 'unified' }} />
  </div>;
}
