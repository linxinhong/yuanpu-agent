import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileTree as PierreFileTree, useFileTree } from '@pierre/trees/react';

import type { ViewerFileHost } from '../host/file-host.js';

/** Shared recursive-listing query; the tree tab toolbar reuses it for refresh. */
export function useWorkspaceTree(host: ViewerFileHost, scopeKey: string) {
  return useQuery({
    queryKey: ['viewer', 'files', scopeKey],
    queryFn: () => host.listDirectory('', { recursive: true }),
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function TreeBody({ filePaths, fileSet, selectedPath, onOpenFile }: {
  filePaths: string[];
  fileSet: Set<string>;
  selectedPath?: string;
  onOpenFile: (path: string) => void;
}) {
  const { model } = useFileTree({
    paths: filePaths,
    initialExpansion: 1,
    ...(selectedPath ? { initialSelectedPaths: [selectedPath] } : {}),
    onSelectionChange: (selectedPaths) => {
      const latest = [...selectedPaths].reverse()[0];
      // Directory rows are selectable in the tree but never open a preview.
      if (latest && fileSet.has(latest)) onOpenFile(latest);
    },
  });

  useEffect(() => {
    model.resetPaths(filePaths);
  }, [model, filePaths]);

  useEffect(() => {
    if (!selectedPath) return;
    model.getItem(selectedPath)?.select();
    model.scrollToPath(selectedPath);
  }, [model, selectedPath]);

  return <PierreFileTree model={model} className="file-tree-host" />;
}

/**
 * Workspace file tree over @pierre/trees. The renderer is path-first, so the
 * file host provides one flat recursive listing (capped server-side) instead
 * of lazy per-directory loads. The app remounts this component (by scope key)
 * on conversation switch to reset expansion and selection.
 */
export function FileTree({ host, scopeKey, selectedPath, onOpenFile, hidden }: {
  host: ViewerFileHost;
  /** Opaque identity of the browsed scope (the Work conversation id). */
  scopeKey: string;
  selectedPath?: string;
  onOpenFile: (path: string) => void;
  hidden?: boolean;
}) {
  const tree = useWorkspaceTree(host, scopeKey);
  const filePaths = useMemo(
    () => (tree.data?.entries ?? []).filter((entry) => entry.kind === 'file').map((entry) => entry.path),
    [tree.data],
  );
  const fileSet = useMemo(() => new Set(filePaths), [filePaths]);
  return <div className={hidden ? 'file-tree hidden' : 'file-tree'} aria-hidden={hidden || undefined}>
    {tree.isLoading && <p className="file-tree-status">正在读取工作区…</p>}
    {tree.error && <p className="file-tree-status" role="alert">工作区读取失败：{formatError(tree.error)}</p>}
    {tree.data?.truncated && <p className="file-tree-status" role="status">文件较多，仅显示前一部分。</p>}
    {tree.data && filePaths.length === 0 && <p className="file-tree-status">工作区还没有文件。</p>}
    {filePaths.length > 0 && <TreeBody filePaths={filePaths} fileSet={fileSet}
      selectedPath={selectedPath} onOpenFile={onOpenFile} />}
  </div>;
}
