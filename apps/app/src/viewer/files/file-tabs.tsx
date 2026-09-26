import { useEffect, useState } from 'react';

import { AppIcon } from '../../shared/app-icon.js';
import type { ViewerFileHost } from '../host/file-host.js';
import { FilePreview } from '../preview/file-preview.js';
import { FileTree, useWorkspaceTree } from './file-tree.js';

type FileTab =
  | { id: 'tree'; kind: 'tree' }
  | { id: string; kind: 'file'; path: string };

const TREE_TAB: FileTab = { id: 'tree', kind: 'tree' };

function fileTabId(path: string): string {
  return `file:${path}`;
}

function fileTabLabel(path: string): string {
  return path.split('/').pop() ?? path;
}

function WorkspaceTreeView({ host, scopeKey, selectedPath, onOpenFile }: {
  host: ViewerFileHost;
  scopeKey: string;
  selectedPath?: string;
  onOpenFile: (path: string) => void;
}) {
  const tree = useWorkspaceTree(host, scopeKey);
  const fileCount = tree.data?.entries.filter((entry) => entry.kind === 'file').length;
  return <>
    <div className="file-toolbar">
      <div className="file-toolbar-side">
        <span className="file-preview-meta">工作区{fileCount !== undefined ? ` · ${fileCount} 个文件` : ''}</span>
      </div>
      <div className="file-toolbar-actions">
        <button type="button" className="file-toolbar-button" title="刷新工作区" aria-label="刷新工作区"
          onClick={() => { void tree.refetch(); }}><AppIcon name="refresh" /></button>
      </div>
    </div>
    <FileTree host={host} scopeKey={scopeKey} selectedPath={selectedPath} onOpenFile={onOpenFile} />
  </>;
}

/**
 * Tabbed workspace viewer: a directory-tree tab plus one closable tab per
 * opened file, mirroring the review-tab design with a per-view toolbar. The
 * app remounts it (by scope key) on conversation switch; `requestPath` opens
 * or activates a file tab.
 */
export function FileWorkspace({ host, scopeKey, requestPath, onActiveFileChange }: {
  host: ViewerFileHost;
  /** Opaque identity of the browsed scope (the Work conversation id). */
  scopeKey: string;
  /** File path requested by the app (e.g. a clicked chat link). */
  requestPath?: string;
  onActiveFileChange?: (path: string | undefined) => void;
}) {
  const [tabs, setTabs] = useState<FileTab[]>([TREE_TAB]);
  const [activeTabId, setActiveTabId] = useState<string>('tree');
  const [treeSelection, setTreeSelection] = useState<string>();

  useEffect(() => {
    if (!requestPath) return;
    const id = fileTabId(requestPath);
    setTabs((current) => current.some((tab) => tab.id === id) ? current : [...current, { id, kind: 'file', path: requestPath }]);
    setActiveTabId(id);
  }, [requestPath]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? TREE_TAB;
  const activeFilePath = activeTab.kind === 'file' ? activeTab.path : undefined;

  useEffect(() => {
    onActiveFileChange?.(activeFilePath);
  }, [onActiveFileChange, activeFilePath]);

  function openFile(path: string) {
    const id = fileTabId(path);
    setTabs((current) => current.some((tab) => tab.id === id) ? current : [...current, { id, kind: 'file', path }]);
    setActiveTabId(id);
  }

  function closeTab(id: string) {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const next = tabs.filter((tab) => tab.id !== id);
    const finalTabs = next.length ? next : [TREE_TAB];
    setTabs(finalTabs);
    if (activeTabId === id) {
      setActiveTabId(finalTabs[Math.max(0, index - 1)]?.id ?? 'tree');
    }
  }

  function showTree() {
    setTabs((current) => current.some((tab) => tab.kind === 'tree') ? current : [...current, TREE_TAB]);
    setActiveTabId('tree');
  }

  function locateInTree(path: string) {
    showTree();
    setTreeSelection(path);
  }

  return <div className="file-workspace">
    <div className="file-tabs" role="tablist" aria-label="打开的文件">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const label = tab.kind === 'tree' ? '文件' : fileTabLabel(tab.path);
        return <div key={tab.id} className={`file-tab ${active ? 'active' : ''}`} role="tab" aria-selected={active}>
          <button type="button" className="file-tab-title" title={tab.kind === 'file' ? tab.path : label}
            onClick={() => setActiveTabId(tab.id)}>{label}</button>
          <button type="button" className="file-tab-close" aria-label={`关闭 ${label}`} onClick={() => closeTab(tab.id)}>×</button>
        </div>;
      })}
      <button type="button" className="file-tab-add" aria-label="打开文件列表" onClick={showTree}>+</button>
    </div>
    <div className="file-workspace-body">
      {activeTab.kind === 'tree'
        ? <WorkspaceTreeView host={host} scopeKey={scopeKey} selectedPath={treeSelection ?? activeFilePath} onOpenFile={openFile} />
        : <FilePreview host={host} scopeKey={scopeKey} filePath={activeTab.path} onRequestLocate={locateInTree} />}
    </div>
  </div>;
}
