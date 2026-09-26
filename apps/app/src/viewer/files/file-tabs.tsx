import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { AppIcon } from '../../shared/app-icon.js';
import type { ImagePreview } from '../../shared/message-image.js';
import type { ViewerFileHost } from '../host/file-host.js';
import { FilePreview } from '../preview/file-preview.js';
import { FileTree, useWorkspaceTree } from './file-tree.js';

type FileTab =
  | { id: 'activity' | 'run'; kind: 'activity' | 'run' }
  | { id: 'tree'; kind: 'tree' }
  | { id: string; kind: 'image'; image: ImagePreview }
  | { id: string; kind: 'file'; path: string };

export type ImagePreviewRequest = ImagePreview & { id: string };

export function ImagePreviewPanel({ image, onClose }: { image: ImagePreview; onClose?: () => void }) {
  return <div className="image-side-preview">
    <div className="image-side-preview-heading"><strong>{image.alt || '图片预览'}</strong>
      {onClose && <button type="button" onClick={onClose} aria-label="关闭图片预览">×</button>}
    </div>
    <div className="image-side-preview-body"><img src={image.src} alt={image.alt} referrerPolicy="no-referrer" /></div>
  </div>;
}

const TREE_TAB: FileTab = { id: 'tree', kind: 'tree' };

function fileTabId(path: string): string {
  return `file:${path}`;
}

function fileTabLabel(path: string): string {
  return path.split('/').pop() ?? path;
}

function WorkspaceTreeView({ host, scopeKey, selectedPath, onOpenFile, rootName }: {
  host: ViewerFileHost;
  scopeKey: string;
  selectedPath?: string;
  onOpenFile: (path: string) => void;
  rootName?: string;
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
    <FileTree host={host} scopeKey={scopeKey} selectedPath={selectedPath} onOpenFile={onOpenFile} rootName={rootName} />
  </>;
}

/** One tab strip for workspace content and the host's run views. */
export function FileWorkspace({ host, scopeKey, requestPath, onActiveFileChange,
  requestImage, tabHost, view, onViewChange, runContent, onClose, rootName }: {
  host?: ViewerFileHost;
  scopeKey: string;
  requestPath?: string;
  requestImage?: ImagePreviewRequest;
  onActiveFileChange?: (path: string | undefined) => void;
  tabHost: HTMLElement | null;
  view: 'activity' | 'run' | 'files';
  onViewChange: (view: 'activity' | 'run' | 'files') => void;
  runContent: ReactNode;
  onClose: () => void;
  rootName?: string;
}) {
  const [initialTab] = useState<FileTab>(() => view === 'files'
    ? requestPath ? { id: fileTabId(requestPath), kind: 'file', path: requestPath } : TREE_TAB
    : { id: view, kind: view });
  const [tabs, setTabs] = useState<FileTab[]>([initialTab]);
  const [activeTabId, setActiveTabId] = useState(initialTab.id);
  const [treeSelection, setTreeSelection] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);

  function activate(tab: FileTab) {
    setTabs((current) => current.some((item) => item.id === tab.id) ? current : [...current, tab]);
    setActiveTabId(tab.id);
    onViewChange(tab.kind === 'file' || tab.kind === 'image' || tab.kind === 'tree' ? 'files' : tab.kind);
    setMenuOpen(false);
  }

  useEffect(() => {
    if (view === 'files' && requestPath) {
      const tab: FileTab = { id: fileTabId(requestPath), kind: 'file', path: requestPath };
      setTabs((current) => current.some((item) => item.id === tab.id) ? current : [...current, tab]);
      setActiveTabId(tab.id);
    }
  }, [requestPath, view]);

  useEffect(() => {
    if (!requestImage || view !== 'files') return;
    const tab: FileTab = { id: `image:${requestImage.id}`, kind: 'image', image: requestImage };
    setTabs((current) => current.some((item) => item.id === tab.id) ? current : [...current, tab]);
    setActiveTabId(tab.id);
  }, [requestImage, view]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const activeFilePath = activeTab?.kind === 'file' ? activeTab.path : undefined;
  useEffect(() => { onActiveFileChange?.(activeFilePath); }, [onActiveFileChange, activeFilePath]);

  function closeTab(id: string) {
    const index = tabs.findIndex((tab) => tab.id === id);
    const next = tabs.filter((tab) => tab.id !== id);
    setTabs(next);
    if (!next.length) { onClose(); return; }
    if (activeTabId === id) activate(next[Math.max(0, index - 1)]!);
  }

  const tabStrip = <div className="workspace-tabs">
    <div className="file-tabs" role="tablist" aria-label="右侧面板标签">
      {tabs.map((tab) => {
        const label = tab.kind === 'file' ? fileTabLabel(tab.path) : tab.kind === 'image' ? tab.image.alt || '图片' : tab.kind === 'tree' ? '文件' : tab.kind === 'activity' ? '动态' : '运行';
        return <div key={tab.id} className={`file-tab ${tab.id === activeTabId ? 'active' : ''}`}>
          <button type="button" role="tab" aria-selected={tab.id === activeTabId} className="file-tab-title"
            title={tab.kind === 'file' ? tab.path : label} onClick={() => activate(tab)}>
            <AppIcon name={tab.kind === 'image' ? 'image' : tab.kind === 'file' ? 'file' : tab.kind === 'tree' ? 'folder' : 'schedules'} /><span>{label}</span>
          </button>
          <button type="button" className="file-tab-close" aria-label={`关闭 ${label}`} onClick={() => closeTab(tab.id)}>×</button>
        </div>;
      })}
    </div>
    <div className="workspace-tab-add">
      <button type="button" className="file-tab-add" aria-label="添加面板标签" aria-expanded={menuOpen}
        onClick={() => setMenuOpen((value) => !value)}><AppIcon name="plus" /></button>
      {menuOpen && <>
        <button className="workspace-menu-dismiss" aria-label="关闭标签菜单" onClick={() => setMenuOpen(false)} />
        <div className="workspace-tab-menu" onKeyDown={(event) => { if (event.key === 'Escape') setMenuOpen(false); }}>
          <button type="button" onClick={() => activate(TREE_TAB)}><AppIcon name="folder" />文件列表</button>
          <button type="button" onClick={() => activate({ id: 'activity', kind: 'activity' })}><AppIcon name="schedules" />动态</button>
          <button type="button" onClick={() => activate({ id: 'run', kind: 'run' })}><AppIcon name="send" />运行</button>
        </div>
      </>}
    </div>
  </div>;

  return <div className="file-workspace">
    {tabHost && createPortal(tabStrip, tabHost)}
    {activeTab?.kind === 'activity' || activeTab?.kind === 'run' ? runContent : <div className="file-workspace-body">
      {activeTab?.kind === 'image' ? <ImagePreviewPanel image={activeTab.image} />
        : !host ? <div className="activity-empty"><strong>还没有打开的工作</strong><span>选择或新建工作后，可在这里浏览工作区文件。</span></div>
        : activeTab?.kind === 'file'
          ? <div className="file-preview-layout">
              <div className="file-preview-main">
                <div className="file-preview-breadcrumb"><button type="button" onClick={() => activate(TREE_TAB)}>{rootName ?? '工作区'}</button>
                  {activeTab.path.split('/').map((part, index) => <span key={`${index}:${part}`}><AppIcon name="chevron" />{part}</span>)}
                </div>
                <FilePreview host={host} scopeKey={scopeKey} filePath={activeTab.path}
                  onRequestLocate={(path) => { setTreeSelection(path); activate(TREE_TAB); }} />
              </div>
              <aside className="file-preview-sidebar" aria-label="文件目录"><WorkspaceTreeView host={host} scopeKey={scopeKey}
                selectedPath={activeTab.path} rootName={rootName} onOpenFile={(path) => activate({ id: fileTabId(path), kind: 'file', path })} /></aside>
            </div>
          : <WorkspaceTreeView host={host} scopeKey={scopeKey} selectedPath={treeSelection} rootName={rootName}
              onOpenFile={(path) => activate({ id: fileTabId(path), kind: 'file', path })} />}
    </div>}
  </div>;
}
