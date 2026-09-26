import { useEffect, useState } from 'react';

import { AppIcon } from '../../shared/app-icon.js';
import type { ViewerBrowserHost } from '../host/browser-host.js';
import type { ViewerFileHost } from '../host/file-host.js';
import { BrowserView } from '../browser/browser-view.js';
import { FilePreview } from '../preview/file-preview.js';
import { FileTree, useWorkspaceTree } from './file-tree.js';

type FileTab =
  | { id: 'tree'; kind: 'tree' }
  | { id: 'browser'; kind: 'browser' }
  | { id: string; kind: 'file'; path: string };

const TREE_TAB: FileTab = { id: 'tree', kind: 'tree' };
const BROWSER_TAB: FileTab = { id: 'browser', kind: 'browser' };

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
 * Tabbed workspace viewer: a directory-tree tab, an embedded-browser tab and
 * one closable tab per opened file, mirroring the review-tab design with a
 * per-view toolbar. The app remounts it (by scope key) on conversation
 * switch; `requestPath` opens or activates a file tab and `browserRequest`
 * bumps open the shared browser tab.
 */
export function FileWorkspace({ host, browserHost, scopeKey, requestPath, browserRequest, onActiveFileChange }: {
  host: ViewerFileHost;
  browserHost?: ViewerBrowserHost;
  /** Opaque identity of the browsed scope (the Work conversation id). */
  scopeKey: string;
  /** File path requested by the app (e.g. a clicked chat link). */
  requestPath?: string;
  /** Incremented by the app when the shared browser tab should open. */
  browserRequest?: number;
  onActiveFileChange?: (path: string | undefined) => void;
}) {
  const [tabs, setTabs] = useState<FileTab[]>([TREE_TAB]);
  const [activeTabId, setActiveTabId] = useState<string>('tree');
  const [treeSelection, setTreeSelection] = useState<string>();
  const [browserTitle, setBrowserTitle] = useState('浏览器');
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  useEffect(() => {
    if (!requestPath) return;
    const id = fileTabId(requestPath);
    setTabs((current) => current.some((tab) => tab.id === id) ? current : [...current, { id, kind: 'file', path: requestPath }]);
    setActiveTabId(id);
  }, [requestPath]);

  useEffect(() => {
    if (!browserRequest) return;
    openBrowserTab();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserRequest]);

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

  function openBrowserTab() {
    setTabs((current) => current.some((tab) => tab.kind === 'browser') ? current : [...current, BROWSER_TAB]);
    setActiveTabId('browser');
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

  function tabLabel(tab: FileTab): string {
    if (tab.kind === 'tree') return '文件';
    if (tab.kind === 'browser') return browserTitle || '浏览器';
    return fileTabLabel(tab.path);
  }

  return <div className="file-workspace">
    <div className="file-tabs" role="tablist" aria-label="打开的文件">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const label = tabLabel(tab);
        return <div key={tab.id} className={`file-tab ${active ? 'active' : ''}`} role="tab" aria-selected={active}>
          <button type="button" className="file-tab-title" title={tab.kind === 'file' ? tab.path : label}
            onClick={() => setActiveTabId(tab.id)}>{label}</button>
          <button type="button" className="file-tab-close" aria-label={`关闭 ${label}`} onClick={() => closeTab(tab.id)}>×</button>
        </div>;
      })}
      <div className="file-tab-add-wrap">
        <button type="button" className="file-tab-add" aria-label="新建标签页" aria-expanded={addMenuOpen}
          onClick={() => setAddMenuOpen((value) => !value)}>+</button>
        {addMenuOpen && <div className="file-tab-add-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); showTree(); }}>文件列表</button>
          {browserHost && <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); openBrowserTab(); }}>浏览器</button>}
        </div>}
      </div>
    </div>
    <div className="file-workspace-body">
      {activeTab.kind === 'tree'
        ? <WorkspaceTreeView host={host} scopeKey={scopeKey} selectedPath={treeSelection ?? activeFilePath} onOpenFile={openFile} />
        : activeTab.kind === 'browser'
          ? browserHost
            ? <BrowserView host={browserHost} scopeKey={scopeKey} onTitleChange={setBrowserTitle} />
            : <p className="file-preview-loading">浏览器在此环境不可用。</p>
          : <FilePreview host={host} scopeKey={scopeKey} filePath={activeTab.path} onRequestLocate={locateInTree} />}
    </div>
  </div>;
}
