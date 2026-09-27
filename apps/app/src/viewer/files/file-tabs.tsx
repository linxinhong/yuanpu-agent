import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { AppIcon } from '../../shared/app-icon.js';
import type { ImagePreview } from '../../shared/message-image.js';
import { BrowserView } from '../browser/browser-view.js';
import type { ViewerBrowserHost } from '../host/browser-host.js';
import type { ViewerFileHost } from '../host/file-host.js';
import { FilePreview } from '../preview/file-preview.js';
import { FileTree, useWorkspaceTree } from './file-tree.js';

type FileTab =
  | { id: 'activity' | 'run'; kind: 'activity' | 'run' }
  | { id: 'tree'; kind: 'tree' }
  | { id: string; kind: 'image'; image: ImagePreview }
  | { id: 'browser'; kind: 'browser' }
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
const BROWSER_TAB: FileTab = { id: 'browser', kind: 'browser' };

function fileTabId(path: string): string {
  return `file:${path}`;
}

function fileTabLabel(path: string): string {
  return path.split('/').pop() ?? path;
}

function WorkspaceTreeView({ host, scopeKey, selectedPath, onOpenFile, rootName, directoryPath, onDirectoryChange }: {
  host: ViewerFileHost;
  scopeKey: string;
  selectedPath?: string;
  onOpenFile: (path: string) => void;
  rootName?: string;
  directoryPath?: string;
  onDirectoryChange?: (path: string) => void;
}) {
  const tree = useWorkspaceTree(host, scopeKey, directoryPath);
  const fileCount = tree.data?.entries.filter((entry) => entry.kind === 'file').length;
  return <>
    <div className="file-toolbar">
      <div className="file-toolbar-side">
        <span className="file-preview-meta">工作区{fileCount !== undefined && fileCount !== 1 ? ` · ${fileCount} 个文件` : ''}</span>
      </div>
      <div className="file-toolbar-actions">
        <button type="button" className="file-toolbar-button" title="刷新工作区" aria-label="刷新工作区"
          onClick={() => { void tree.refetch(); }}><AppIcon name="refresh" /></button>
      </div>
    </div>
    <FileTree host={host} scopeKey={scopeKey} selectedPath={selectedPath} onOpenFile={onOpenFile} rootName={rootName}
      directoryPath={directoryPath} onDirectoryChange={onDirectoryChange} />
  </>;
}

/** One tab strip for workspace content and the host's run views. */
export function FileWorkspace({ host, browserHost, scopeKey, requestPath, browserRequest, onActiveFileChange,
  requestImage, tabHost, view, onViewChange, runContent, onClose, rootName }: {
  host?: ViewerFileHost;
  browserHost?: ViewerBrowserHost;
  scopeKey: string;
  requestPath?: string;
  browserRequest?: number;
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
  const [browserTitle, setBrowserTitle] = useState('浏览器');
  const [treeOpen, setTreeOpen] = useState(true);
  const [directoryPath, setDirectoryPath] = useState('');
  const [openLocalError, setOpenLocalError] = useState<string>();

  function activate(tab: FileTab) {
    setTabs((current) => current.some((item) => item.id === tab.id) ? current : [...current, tab]);
    setActiveTabId(tab.id);
    onViewChange(tab.kind === 'file' || tab.kind === 'image' || tab.kind === 'tree' || tab.kind === 'browser' ? 'files' : tab.kind);
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

  useEffect(() => {
    if (!browserRequest || !browserHost) return;
    setTabs((current) => current.some((tab) => tab.kind === 'browser') ? current : [...current, BROWSER_TAB]);
    setActiveTabId('browser');
    onViewChange('files');
  }, [browserRequest, browserHost, onViewChange]);

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
        const label = tab.kind === 'file' ? fileTabLabel(tab.path) : tab.kind === 'image' ? tab.image.alt || '图片' : tab.kind === 'browser' ? browserTitle : tab.kind === 'tree' ? '文件' : tab.kind === 'activity' ? '动态' : '运行';
        return <div key={tab.id} className={`file-tab ${tab.id === activeTabId ? 'active' : ''}`}>
          <button type="button" role="tab" aria-selected={tab.id === activeTabId} className="file-tab-title"
            title={tab.kind === 'file' ? tab.path : label} onClick={() => activate(tab)}>
            <AppIcon name={tab.kind === 'image' ? 'image' : tab.kind === 'browser' ? 'globe' : tab.kind === 'file' ? 'file' : tab.kind === 'tree' ? 'folder' : 'schedules'} /><span>{label}</span>
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
          {browserHost && <button type="button" onClick={() => activate(BROWSER_TAB)}><AppIcon name="globe" />浏览器</button>}
          <button type="button" onClick={() => activate({ id: 'activity', kind: 'activity' })}><AppIcon name="schedules" />动态</button>
          <button type="button" onClick={() => activate({ id: 'run', kind: 'run' })}><AppIcon name="send" />运行</button>
        </div>
      </>}
    </div>
  </div>;

  return <div className="file-workspace">
    {tabHost && createPortal(tabStrip, tabHost)}
    {tabs.some((tab) => tab.kind === 'browser') && browserHost && <div className="file-workspace-body"
      style={{ display: activeTab?.kind === 'browser' ? undefined : 'none' }}>
      <BrowserView host={browserHost} scopeKey={scopeKey} onTitleChange={setBrowserTitle} />
    </div>}
    {activeTab?.kind === 'browser' ? null : activeTab?.kind === 'activity' || activeTab?.kind === 'run' ? runContent : <div className="file-workspace-body">
      {activeTab?.kind === 'image' ? <ImagePreviewPanel image={activeTab.image} />
        : !host ? <div className="activity-empty"><strong>还没有打开的工作</strong><span>选择或新建工作后，可在这里浏览工作区文件。</span></div>
        : activeTab?.kind === 'file'
          ? <div className="file-preview-layout">
              <div className="file-preview-main">
                <div className="file-preview-breadcrumb"><button type="button" onClick={() => activate(TREE_TAB)}>{rootName ?? '工作区'}</button>
                  {activeTab.path.split('/').map((part, index) => <span key={`${index}:${part}`}><AppIcon name="chevron" />{part}</span>)}
                </div>
                <FilePreview host={host} scopeKey={scopeKey} filePath={activeTab.path}
                  onRequestLocate={(path) => { setTreeSelection(path); setTreeOpen(true); }} />
              </div>
              <aside className={`file-preview-sidebar${treeOpen ? '' : ' collapsed'}`} aria-label="文件目录">
                <div className="file-sidebar-toolbar">
                  {treeOpen && host.openFile && <button type="button" className="file-toolbar-button" title="用本地程序打开" aria-label="用本地程序打开"
                    onClick={() => { setOpenLocalError(undefined); void host.openFile!(activeTab.path).catch((error: unknown) => setOpenLocalError(error instanceof Error ? error.message : String(error))); }}><AppIcon name="external" /></button>}
                  <button type="button" className="file-toolbar-button" title={treeOpen ? '隐藏文件列表' : '显示文件列表'} aria-label={treeOpen ? '隐藏文件列表' : '显示文件列表'}
                    aria-pressed={treeOpen} onClick={() => setTreeOpen((value) => !value)}><AppIcon name="panel" /></button>
                </div>
                {openLocalError && <p className="file-tree-status" role="alert">打开失败：{openLocalError}</p>}
                {treeOpen && <WorkspaceTreeView host={host} scopeKey={scopeKey}
                  selectedPath={activeTab.path} rootName={rootName} directoryPath={directoryPath} onDirectoryChange={setDirectoryPath}
                  onOpenFile={(path) => activate({ id: fileTabId(path), kind: 'file', path })} />}
              </aside>
            </div>
          : <WorkspaceTreeView host={host} scopeKey={scopeKey} selectedPath={treeSelection} rootName={rootName}
              directoryPath={directoryPath} onDirectoryChange={setDirectoryPath}
              onOpenFile={(path) => activate({ id: fileTabId(path), kind: 'file', path })} />}
    </div>}
  </div>;
}
