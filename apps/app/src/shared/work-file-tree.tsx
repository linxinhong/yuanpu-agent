import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WorkFileEntry } from '@yuanpu-agent/protocol';

import { AppIcon } from './app-icon.js';

function useWorkDirectory(conversationId: string | undefined, dirPath: string, enabled: boolean) {
  return useQuery({
    queryKey: ['work', 'files', conversationId, dirPath],
    queryFn: () => window.yuanpu!.listWorkFiles(conversationId!, dirPath),
    enabled: enabled && Boolean(conversationId) && Boolean(window.yuanpu),
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function FileRow({ conversationId, entry, depth, selectedPath, onOpenFile }: {
  conversationId: string;
  entry: WorkFileEntry;
  depth: number;
  selectedPath?: string;
  onOpenFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const children = useWorkDirectory(conversationId, entry.path, entry.kind === 'directory' && expanded);
  return <>
    <button type="button" className={`file-tree-row ${selectedPath === entry.path ? 'selected' : ''}`}
      style={{ paddingLeft: `${10 + depth * 14}px` }}
      aria-expanded={entry.kind === 'directory' ? expanded : undefined}
      aria-current={selectedPath === entry.path ? 'true' : undefined}
      onClick={() => entry.kind === 'directory' ? setExpanded((value) => !value) : onOpenFile(entry.path)}>
      {entry.kind === 'directory'
        ? <span className={`file-tree-caret ${expanded ? 'open' : ''}`} aria-hidden="true"><AppIcon name="chevron" /></span>
        : <span className="file-tree-dot" aria-hidden="true" />}
      <span className="file-tree-name">{entry.name}</span>
    </button>
    {entry.kind === 'directory' && expanded && (
      children.isLoading ? <p className="file-tree-status" style={{ paddingLeft: `${10 + (depth + 1) * 14}px` }}>正在读取…</p>
        : children.error ? <p className="file-tree-status" role="alert" style={{ paddingLeft: `${10 + (depth + 1) * 14}px` }}>读取失败：{formatError(children.error)}</p>
          : children.data && children.data.entries.length === 0
            ? <p className="file-tree-status" style={{ paddingLeft: `${10 + (depth + 1) * 14}px` }}>空目录</p>
            : children.data?.entries.map((child) => <FileRow key={child.path} conversationId={conversationId}
              entry={child} depth={depth + 1} selectedPath={selectedPath} onOpenFile={onOpenFile} />)
    )}
  </>;
}

/** Lazy-loading workspace file tree. Stays mounted behind the preview to keep expansion state. */
export function WorkFileTree({ conversationId, selectedPath, onOpenFile, hidden }: {
  conversationId: string;
  selectedPath?: string;
  onOpenFile: (path: string) => void;
  hidden?: boolean;
}) {
  const root = useWorkDirectory(conversationId, '', true);
  return <div className={hidden ? 'file-tree hidden' : 'file-tree'} aria-hidden={hidden || undefined} role="tree" aria-label="工作区文件">
    {root.isLoading && <p className="file-tree-status">正在读取工作区…</p>}
    {root.error && <p className="file-tree-status" role="alert">工作区读取失败：{formatError(root.error)}</p>}
    {root.data && root.data.entries.length === 0 && <p className="file-tree-status">工作区还没有文件。</p>}
    {root.data?.entries.map((entry) => <FileRow key={entry.path} conversationId={conversationId}
      entry={entry} depth={0} selectedPath={selectedPath} onOpenFile={onOpenFile} />)}
  </div>;
}
