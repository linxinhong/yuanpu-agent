import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileTree as PierreFileTree, useFileTree } from '@pierre/trees/react';

import { AppIcon } from '../../shared/app-icon.js';
import type { WorkFileEntry } from '@yuanpu-agent/protocol';
import type { ViewerFileHost } from '../host/file-host.js';

/** Shared recursive-listing query; the tree tab toolbar reuses it for refresh. */
export function useWorkspaceTree(host: ViewerFileHost, scopeKey: string, directoryPath = '') {
  return useQuery({
    queryKey: ['viewer', 'files', scopeKey, directoryPath],
    queryFn: () => host.listDirectory(directoryPath, { recursive: true }),
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function visibleWorkspacePaths(entries: readonly WorkFileEntry[], filter: string): string[] {
  const query = filter.trim().toLocaleLowerCase();
  const included = query
    ? entries.filter((entry) => entry.path.toLocaleLowerCase().includes(query))
    : entries;
  const visible = new Set(included.map((entry) => entry.path));
  for (const entry of included) {
    const parts = entry.path.split('/');
    for (let index = 1; index < parts.length; index++) visible.add(parts.slice(0, index).join('/'));
  }
  return entries.filter((entry) => visible.has(entry.path))
    .map((entry) => entry.kind === 'directory' ? `${entry.path}/` : entry.path);
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
export function FileTree({ host, scopeKey, selectedPath, onOpenFile, rootName, directoryPath = '', onDirectoryChange, hidden }: {
  host: ViewerFileHost;
  /** Opaque identity of the browsed scope (the Work conversation id). */
  scopeKey: string;
  selectedPath?: string;
  onOpenFile: (path: string) => void;
  rootName?: string;
  directoryPath?: string;
  onDirectoryChange?: (path: string) => void;
  hidden?: boolean;
}) {
  const tree = useWorkspaceTree(host, scopeKey, directoryPath);
  const workspaceTree = useWorkspaceTree(host, scopeKey);
  const [filter, setFilter] = useState('');
  const entries = useMemo(() => (tree.data?.entries ?? []).map((entry) => ({
    ...entry,
    path: directoryPath ? entry.path.slice(directoryPath.length + 1) : entry.path,
  })), [tree.data, directoryPath]);
  const fileSet = useMemo(() => new Set(entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path)), [entries]);
  const paths = useMemo(() => visibleWorkspacePaths(entries, filter), [entries, filter]);
  const relativeSelection = selectedPath && directoryPath && selectedPath.startsWith(`${directoryPath}/`)
    ? selectedPath.slice(directoryPath.length + 1) : directoryPath ? undefined : selectedPath;
  const directories = workspaceTree.data?.entries.filter((entry) => entry.kind === 'directory') ?? [];
  return <div className={hidden ? 'file-tree hidden' : 'file-tree'} aria-hidden={hidden || undefined}>
    <label className="file-tree-root" title={directoryPath || rootName || '工作区'}><AppIcon name="folder" />
      <select aria-label="切换工作区目录" value={directoryPath} onChange={(event) => { setFilter(''); onDirectoryChange?.(event.target.value); }}>
        <option value="">{rootName ?? '工作区'}</option>
        {directories.map((directory) => <option key={directory.path} value={directory.path}>{directory.path}</option>)}
      </select>
    </label>
    <label className="file-tree-filter"><input aria-label="筛选文件"
      type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选文件…" /></label>
    {tree.isLoading && <p className="file-tree-status">正在读取工作区…</p>}
    {tree.error && <p className="file-tree-status" role="alert">工作区读取失败：{formatError(tree.error)}</p>}
    {tree.data?.truncated && <p className="file-tree-status" role="status">文件较多，仅显示前一部分。</p>}
    {tree.data && entries.length === 0 && <p className="file-tree-status">工作区还没有文件。</p>}
    {tree.data && entries.length > 0 && paths.length === 0 && <p className="file-tree-status">没有匹配的文件。</p>}
    {paths.length > 0 && <TreeBody key={`${directoryPath}:${filter}`} filePaths={paths} fileSet={fileSet}
      selectedPath={relativeSelection} onOpenFile={(path) => onOpenFile(directoryPath ? `${directoryPath}/${path}` : path)} />}
  </div>;
}
