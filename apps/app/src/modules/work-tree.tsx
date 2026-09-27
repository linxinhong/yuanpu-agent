import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import type { DesktopBridge, WorkConversation, WorkFolder, WorkSearchItem, WorkTag } from '@yuanpu-agent/protocol';
import { AppIcon } from '../shared/app-icon.js';
import { WorkNodeIcon, workIconChoices } from './work-node-icons.js';
import { folderPath, isFolderDescendant, reorderedVisibleSiblingIds, visibleWorkTree, type WorkTreeNode } from './work-tree-model.js';
import './work-tree.css';

type NodeRef = { kind: 'folder' | 'conversation'; id: string };
type DialogState = { kind: 'move' | 'icon' | 'tags'; node: NodeRef };
type MenuState = { node: NodeRef; top: number; left: number };

function nodeName(node: WorkTreeNode): string {
  return node.kind === 'folder' ? node.item.name : node.item.title || '未命名会话';
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function WorkTree({ desktop, conversations, folders, tags, currentId, locked,
  onOpen, onCreate, onSearchHit, maximized, onToggleMaximized }: {
  desktop: DesktopBridge;
  conversations: WorkConversation[];
  folders: WorkFolder[];
  tags: WorkTag[];
  currentId?: string;
  locked: boolean;
  onOpen: (item: WorkConversation) => Promise<unknown>;
  onCreate: (folderId: string | undefined) => Promise<void>;
  onSearchHit: (item: WorkSearchItem) => Promise<void>;
  maximized: boolean;
  onToggleMaximized: () => void;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [archiveView, setArchiveView] = useState(false);
  const [query, setQuery] = useState('');
  const [searchText, setSearchText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [draftFolder, setDraftFolder] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [folderPlacement, setFolderPlacement] = useState<'sibling' | 'child'>('child');
  const [viewMode, setViewMode] = useState<'tree' | 'explorer'>('tree');
  const [explorerFolder, setExplorerFolder] = useState<string | null>(null);
  const [iconPage, setIconPage] = useState(0);
  const [editing, setEditing] = useState<NodeRef>();
  const [editingName, setEditingName] = useState('');
  const [menu, setMenu] = useState<MenuState>();
  const [dialog, setDialog] = useState<DialogState>();
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [detailIcon, setDetailIcon] = useState('chat');
  const [detailTagIds, setDetailTagIds] = useState<string[]>([]);
  const [newTagName, setNewTagName] = useState('');
  const [dragging, setDragging] = useState<NodeRef>();
  const [dropTarget, setDropTarget] = useState<string | null>();
  const [focusKey, setFocusKey] = useState('root');
  const draftInput = useRef<HTMLInputElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuAnchorRef = useRef<HTMLButtonElement>(null);
  const createRequestId = useRef<string | undefined>(undefined);
  const tagRequest = useRef<{ name: string; requestId: string } | undefined>(undefined);
  const moveRequest = useRef<{ key: string; requestId: string } | undefined>(undefined);
  const disabled = locked || pending;
  const searching = query.trim().length > 0;
  const selected = selectedFolder && folders.find((folder) => folder.id === selectedFolder);
  const creationParent = selected ? folderPlacement === 'child' ? selected.id : selected.parentId : null;
  const creationDepth = folderPath(folders, creationParent).length + 1;
  const explorerPath = folderPath(folders, explorerFolder);
  const explorerFolders = folders.filter((folder) => !folder.system && folder.parentId === explorerFolder)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const explorerConversations = conversations.filter((conversation) => conversation.id !== 'default'
    && conversation.folderId === explorerFolder && conversation.archived === archiveView)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
  const nodes = useMemo(() => visibleWorkTree(folders, conversations, expanded, archiveView),
    [folders, conversations, expanded, archiveView]);
  const searchQuery = useInfiniteQuery({
    queryKey: ['work', 'search', searchText, archiveView],
    queryFn: ({ pageParam }) => desktop.searchWorkConversations({ query: searchText,
      archive: archiveView ? 'archived' : 'active', limit: 50, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: searchText.length > 0,
  });
  const searchItems = searchQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const searchFailures = searchQuery.data?.pages.flatMap((page) => page.contentFailures) ?? [];

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchText(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => { if (draftFolder) draftInput.current?.focus(); }, [draftFolder]);
  useEffect(() => { if (editing) renameInput.current?.focus(); }, [editing]);
  useEffect(() => {
    const item = conversations.find((conversation) => conversation.id === currentId);
    if (!item) return;
    const ancestors = folderPath(folders, item.folderId).map((folder) => folder.id);
    setExpanded((value) => ancestors.every((id) => value.has(id)) ? value : new Set([...value, ...ancestors]));
  }, [currentId, conversations, folders]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !menuAnchorRef.current?.contains(event.target as Node)) setMenu(undefined);
    };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setMenu(undefined); };
    const scroll = () => setMenu(undefined);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    treeRef.current?.addEventListener('scroll', scroll);
    window.addEventListener('resize', scroll);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
      treeRef.current?.removeEventListener('scroll', scroll);
      window.removeEventListener('resize', scroll);
    };
  }, [menu]);

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ['work', 'conversations'] });
    void queryClient.invalidateQueries({ queryKey: ['work', 'folders'] });
    void queryClient.invalidateQueries({ queryKey: ['work', 'tags'] });
    void queryClient.invalidateQueries({ queryKey: ['work', 'search'] });
  }

  async function perform(action: () => Promise<unknown>, success?: () => void): Promise<boolean> {
    if (disabled) return false;
    setPending(true);
    setError('');
    try {
      await action();
      success?.();
      refresh();
      return true;
    } catch (cause) {
      setError(messageFor(cause));
      refresh();
      return false;
    } finally { setPending(false); }
  }

  function folderFor(id: string | null): string | null {
    return id === 'uncategorized' ? null : id;
  }

  async function saveFolder(): Promise<void> {
    const name = draftName.trim();
    if (!name) { setError('请输入文件夹名称。'); return; }
    if (creationDepth > 5) { setError('工作文件夹最多支持五级。'); return; }
    const requestId = createRequestId.current ?? crypto.randomUUID();
    createRequestId.current = requestId;
    await perform(() => desktop.createWorkFolder(creationParent, name, 'folder', requestId), () => {
      createRequestId.current = undefined;
      setDraftFolder(false);
      setDraftName('');
      if (creationParent) setExpanded((value) => new Set(value).add(creationParent));
    });
  }

  function beginFolderCreation(): void {
    setFolderPlacement(selectedFolder ? folderPath(folders, selectedFolder).length < 5 ? 'child' : 'sibling' : 'sibling');
    setDraftName('');
    setDraftFolder(true);
  }

  function folderSubtreeDepth(folderId: string): number {
    const base = folderPath(folders, folderId).length;
    return Math.max(1, ...folders.filter((folder) => isFolderDescendant(folders, folder.id, folderId))
      .map((folder) => folderPath(folders, folder.id).length - base + 1));
  }

  function canPlace(node: NodeRef, targetId: string | null): boolean {
    if (node.kind === 'folder' && isFolderDescendant(folders, targetId, node.id)) return false;
    return node.kind !== 'folder' || folderPath(folders, targetId).length + folderSubtreeDepth(node.id) <= 5;
  }

  function beginRename(node: NodeRef): void {
    if (disabled || node.id === 'default') return;
    const name = node.kind === 'folder' ? folders.find((item) => item.id === node.id)?.name
      : conversations.find((item) => item.id === node.id)?.title;
    setEditing(node);
    setEditingName(name ?? '');
    setMenu(undefined);
  }

  async function saveRename(): Promise<void> {
    if (!editing) return;
    const name = editingName.trim();
    if (!name) { setError('名称不能为空。'); return; }
    const node = editing;
    await perform(() => node.kind === 'folder'
      ? desktop.updateWorkFolder(node.id, { name })
      : desktop.updateWorkConversation(node.id, { title: name }), () => setEditing(undefined));
  }

  async function moveNode(node: NodeRef, targetId: string | null): Promise<void> {
    if (searching) { setError('请先清除搜索，再移动文件夹或会话。'); return; }
    const target = folderFor(targetId);
    if (!canPlace(node, target)) { setError('无法移动到此位置：文件夹不能包含自身，且最多支持五级。'); return; }
    const currentParent = node.kind === 'folder' ? folders.find((folder) => folder.id === node.id)?.parentId
      : conversations.find((conversation) => conversation.id === node.id)?.folderId;
    if (currentParent === target) { setDialog(undefined); return; }
    const key = `${node.kind}:${node.id}:${target ?? 'root'}`;
    const requestId = moveRequest.current?.key === key ? moveRequest.current.requestId : crypto.randomUUID();
    moveRequest.current = { key, requestId };
    await perform(() => desktop.moveWorkNode({ requestId, kind: node.kind, id: node.id, targetFolderId: target }), () => {
      moveRequest.current = undefined;
      setDialog(undefined);
      setMenu(undefined);
      if (target) setExpanded((value) => new Set(value).add(target));
    });
  }

  async function reorder(node: NodeRef, direction: -1 | 1): Promise<void> {
    const parentId = node.kind === 'folder' ? folders.find((item) => item.id === node.id)?.parentId ?? null
      : conversations.find((item) => item.id === node.id)?.folderId ?? null;
    const siblings = node.kind === 'folder'
      ? folders.filter((item) => !item.system && item.parentId === parentId).sort((a, b) => a.sortOrder - b.sortOrder)
      : conversations.filter((item) => item.id !== 'default' && item.folderId === parentId).sort((a, b) => a.sortOrder - b.sortOrder);
    const ids = reorderedVisibleSiblingIds(siblings.map((item) => item.id),
      siblings.filter((item) => node.kind === 'folder' || (item as WorkConversation).archived === archiveView)
        .map((item) => item.id), node.id, direction);
    if (ids) await perform(() => desktop.reorderWorkSiblings(node.kind, parentId, ids), () => setMenu(undefined));
  }

  function openDetails(node: NodeRef, kind: 'icon' | 'tags'): void {
    const item = node.kind === 'folder' ? folders.find((folder) => folder.id === node.id)
      : conversations.find((conversation) => conversation.id === node.id);
    if (!item) return;
    setDetailIcon(item.iconId);
    setIconPage(Math.max(0, Math.floor(workIconChoices.findIndex((icon) => icon.id === item.iconId) / 36)));
    setDetailTagIds(node.kind === 'conversation' ? (item as WorkConversation).tagIds : []);
    setNewTagName('');
    setDialog({ kind, node });
    setMenu(undefined);
  }

  async function saveDetails(): Promise<void> {
    if (!dialog) return;
    const { node } = dialog;
    await perform(async () => {
      let tagIds = detailTagIds;
      if (dialog.kind === 'tags' && node.kind === 'conversation' && newTagName.trim()) {
        const name = newTagName.trim();
        const requestId = tagRequest.current?.name === name ? tagRequest.current.requestId : crypto.randomUUID();
        tagRequest.current = { name, requestId };
        const tag = await desktop.createWorkTag(name, undefined, requestId);
        tagIds = [...tagIds, tag.id];
        setDetailTagIds(tagIds);
        setNewTagName('');
        tagRequest.current = undefined;
      }
      if (dialog.kind === 'icon') {
        if (node.kind === 'folder') await desktop.updateWorkFolder(node.id, { iconId: detailIcon });
        else await desktop.updateWorkConversation(node.id, { iconId: detailIcon });
      } else if (node.kind === 'conversation') await desktop.updateWorkConversation(node.id, { tagIds });
    }, () => setDialog(undefined));
  }

  function focusNode(key: string): void {
    setFocusKey(key);
    window.requestAnimationFrame(() => treeRef.current?.querySelector<HTMLElement>(`[data-tree-key="${key}"]`)?.focus());
  }

  function onTreeKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement && event.target.dataset.treeKey === undefined) return;
    const keys = ['root', ...nodes.map((node) => `${node.kind}:${node.item.id}`), ...(conversations.some((item) => item.id === 'default') ? ['legacy'] : [])];
    const current = (event.target as HTMLElement).dataset.treeKey ?? focusKey;
    const index = keys.indexOf(current);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); focusNode(keys[Math.max(0, Math.min(keys.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]!);
      return;
    }
    const node = nodes.find((item) => `${item.kind}:${item.item.id}` === current);
    if (event.key === 'F2' && node) { event.preventDefault(); beginRename({ kind: node.kind, id: node.item.id }); }
    if (node?.kind !== 'folder') return;
    if (event.key === 'ArrowRight' && !expanded.has(node.item.id)) {
      event.preventDefault(); setExpanded((value) => new Set(value).add(node.item.id));
    } else if (event.key === 'ArrowLeft' && expanded.has(node.item.id)) {
      event.preventDefault(); setExpanded((value) => { const next = new Set(value); next.delete(node.item.id); return next; });
    } else if (event.key === 'ArrowLeft' && node.item.parentId) {
      event.preventDefault(); focusNode(`folder:${node.item.parentId}`);
    }
  }

  function onDragStart(event: DragEvent<HTMLElement>, node: NodeRef): void {
    if (disabled || searching || node.id === 'default') { event.preventDefault(); return; }
    setDragging(node);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-yuanpu-work-node', `${node.kind}:${node.id}`);
  }
  function onDragOver(event: DragEvent<HTMLElement>, targetId: string | null): void {
    if (!dragging || disabled || searching || !canPlace(dragging, targetId)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget(targetId);
  }
  function onDrop(event: DragEvent<HTMLElement>, targetId: string | null): void {
    event.preventDefault();
    setDropTarget(undefined);
    if (!dragging || disabled || searching) return;
    const serialized = event.dataTransfer.getData('application/x-yuanpu-work-node');
    if (serialized !== `${dragging.kind}:${dragging.id}`) return;
    void moveNode(dragging, targetId);
    setDragging(undefined);
  }

  function openMenu(event: MouseEvent<HTMLButtonElement>, node: NodeRef): void {
    event.stopPropagation();
    menuAnchorRef.current = event.currentTarget;
    const rect = event.currentTarget.getBoundingClientRect();
    const height = node.kind === 'conversation' ? 294 : 252;
    setMenu((value) => value?.node.id === node.id ? undefined : {
      node, top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8)),
      left: Math.max(8, Math.min(rect.right - 188, window.innerWidth - 196)),
    });
  }

  return <div className="work-tree-shell">
    <div className="work-tree-actions" aria-label="工作管理工具">
      <button type="button" title="新建会话" aria-label="新建会话" disabled={disabled || archiveView || searching}
        onClick={() => void onCreate(folderFor(selectedFolder) ?? undefined)}><AppIcon name="plus" /></button>
      <button type="button" title="新建文件夹" aria-label="新建文件夹" disabled={disabled || archiveView || searching}
        onClick={beginFolderCreation}><AppIcon name="folder-plus" /></button>
      <button type="button" title={archiveView ? '查看工作' : '查看已归档'} aria-label={archiveView ? '查看工作' : '查看已归档'}
        aria-pressed={archiveView} onClick={() => { setArchiveView((value) => !value); setMenu(undefined); }}><AppIcon name="archive" /></button>
      <button type="button" title="刷新工作列表" aria-label="刷新工作列表" onClick={refresh}><AppIcon name="refresh" /></button>
      <span className="work-tree-actions-spacer" />
      <button type="button" title={maximized ? '退出工作列表全屏' : '工作列表全屏'} aria-label={maximized ? '退出工作列表全屏' : '工作列表全屏'}
        aria-pressed={maximized} onClick={onToggleMaximized}><AppIcon name={maximized ? 'collapse' : 'expand'} /></button>
      <button type="button" title={viewMode === 'tree' ? '切换到文件管理器视图' : '切换到树状列表视图'}
        aria-label={viewMode === 'tree' ? '切换到文件管理器视图' : '切换到树状列表视图'}
        aria-pressed={viewMode === 'explorer'} onClick={() => { setViewMode((value) => value === 'tree' ? 'explorer' : 'tree'); setMenu(undefined); }}>
        <AppIcon name={viewMode === 'tree' ? 'folder' : 'layers'} /></button>
    </div>
    <label className="work-tree-search">
      <input type="search" aria-label="搜索工作会话" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件夹、会话、标签和消息" />
    </label>
    {error && <div className="work-tree-error" role="alert">{error}<button type="button" onClick={() => setError('')}>关闭</button></div>}
    {locked && <p className="work-tree-hint" role="status">当前任务或授权处理期间，暂不能切换或移动会话。</p>}
    {searching ? <div className="work-tree-results" aria-label="搜索结果">
      {searchQuery.isFetching && <p>正在搜索…</p>}
      {searchQuery.error && <p role="alert">搜索失败：{messageFor(searchQuery.error)} <button type="button" onClick={() => void searchQuery.refetch()}>重试</button></p>}
      {searchItems.map((item, index) => <button type="button" key={`${item.conversationId}:${item.messageEntryId ?? item.matchedField}:${index}`}
        className="work-tree-result" disabled={disabled} onClick={() => void onSearchHit(item)}>
        <strong>{item.title || '未命名会话'}</strong>
        <small>{[...item.folderPath.map((part) => part.name), item.title || '未命名会话'].join(' / ')}</small>
        <span>{item.matchedField === 'message' ? '消息' : item.matchedField === 'folder' ? '文件夹' : item.matchedField === 'tag' ? '标签' : '标题'} · {item.snippet}</span>
      </button>)}
      {searchQuery.hasNextPage && <button className="work-tree-load-more" type="button" disabled={searchQuery.isFetchingNextPage}
        onClick={() => void searchQuery.fetchNextPage()}>{searchQuery.isFetchingNextPage ? '正在加载…' : '加载更多结果'}</button>}
      {searchQuery.data && searchItems.length === 0 && <p>没有找到匹配的工作。</p>}
      {searchFailures.length > 0 && <p role="status">部分历史消息暂不可搜索；仍可按标题和标签查找。</p>}
    </div> : viewMode === 'explorer' ? <div ref={treeRef} className="work-explorer" aria-label={archiveView ? '已归档工作文件管理器' : '工作文件管理器'}>
      <nav className="work-explorer-breadcrumb" aria-label="当前文件夹">
        <button type="button" onClick={() => { setExplorerFolder(null); setSelectedFolder(null); }}>未分类</button>
        {explorerPath.map((folder) => <span key={folder.id}><AppIcon name="chevron" /><button type="button"
          onClick={() => { setExplorerFolder(folder.id); setSelectedFolder(folder.id); }}>{folder.name}</button></span>)}
      </nav>
      <div className="work-explorer-content" onDragOver={(event) => onDragOver(event, explorerFolder)}
        onDrop={(event) => onDrop(event, explorerFolder)}>
        {explorerFolders.map((folder) => <div key={folder.id} className={`work-explorer-item ${dropTarget === folder.id ? 'drop-target' : ''}`}
          draggable={!disabled} onDragStart={(event) => onDragStart(event, { kind: 'folder', id: folder.id })}
          onDragEnd={() => { setDragging(undefined); setDropTarget(undefined); }}
          onDragOver={(event) => { event.stopPropagation(); onDragOver(event, folder.id); }}
          onDrop={(event) => { event.stopPropagation(); onDrop(event, folder.id); }}>
          <button type="button" className="work-explorer-open" title={`打开${folder.name}`} onClick={() => { setExplorerFolder(folder.id); setSelectedFolder(folder.id); }}>
            <span className="work-tree-icon"><WorkNodeIcon iconId={folder.iconId} /></span><span>{folder.name}</span></button>
          <button type="button" className="work-tree-more" aria-label={`${folder.name}的操作`} disabled={disabled}
            onClick={(event) => openMenu(event, { kind: 'folder', id: folder.id })}>···</button>
        </div>)}
        {explorerConversations.map((conversation) => <div key={conversation.id} className={`work-explorer-item ${currentId === conversation.id ? 'active' : ''}`}
          draggable={!disabled} onDragStart={(event) => onDragStart(event, { kind: 'conversation', id: conversation.id })}
          onDragEnd={() => { setDragging(undefined); setDropTarget(undefined); }}>
          <button type="button" className="work-explorer-open" title={conversation.title || '未命名会话'} disabled={disabled}
            onClick={() => void onOpen(conversation)}><span className="work-tree-icon"><WorkNodeIcon iconId={conversation.iconId} /></span>
            <span>{conversation.title || '未命名会话'}</span></button>
          <button type="button" className="work-tree-more" aria-label={`${conversation.title || '未命名会话'}的操作`} disabled={disabled}
            onClick={(event) => openMenu(event, { kind: 'conversation', id: conversation.id })}>···</button>
        </div>)}
        {!explorerFolders.length && !explorerConversations.length && <p>{archiveView ? '这里没有归档会话。' : '这里还没有文件夹或会话。'}</p>}
      </div>
    </div> : <div ref={treeRef} className="work-tree-nodes" role="tree" aria-label={archiveView ? '已归档工作文件树' : '工作文件树'} onKeyDown={onTreeKeyDown}>
      <div role="treeitem" tabIndex={focusKey === 'root' ? 0 : -1} data-tree-key="root" aria-level={1}
        className={`work-tree-row work-tree-root ${dropTarget === null ? 'drop-target' : ''} ${selectedFolder === null ? 'selected-folder' : ''}`}
        onFocus={() => setFocusKey('root')} onClick={() => setSelectedFolder(null)}
        onDragOver={(event) => onDragOver(event, null)} onDrop={(event) => onDrop(event, null)}>
        <AppIcon name="folder" /><span>未分类</span>
      </div>
      {nodes.map((node) => {
        const ref: NodeRef = { kind: node.kind, id: node.item.id };
        const key = `${node.kind}:${node.item.id}`;
        const active = node.kind === 'conversation' && node.item.id === currentId;
        const selected = node.kind === 'folder' && node.item.id === selectedFolder;
        return <div key={key} className="work-tree-entry">
          <div role="treeitem" tabIndex={focusKey === key ? 0 : -1} data-tree-key={key} aria-level={node.depth + 1}
            aria-expanded={node.kind === 'folder' ? expanded.has(node.item.id) : undefined}
            aria-selected={active || selected} draggable={!disabled && !searching} onDragStart={(event) => onDragStart(event, ref)}
            onDragEnd={() => { setDragging(undefined); setDropTarget(undefined); }}
            onDragOver={node.kind === 'folder' ? (event) => onDragOver(event, node.item.id) : undefined}
            onDrop={node.kind === 'folder' ? (event) => onDrop(event, node.item.id) : undefined}
            onFocus={() => setFocusKey(key)}
            onClick={() => node.kind === 'folder' ? setSelectedFolder(node.item.id) : void onOpen(node.item)}
            onDoubleClick={() => node.kind === 'folder' && setExpanded((value) => { const next = new Set(value); next.has(node.item.id) ? next.delete(node.item.id) : next.add(node.item.id); return next; })}
            onKeyDown={(event) => { if (event.key === 'Enter' && node.kind === 'folder') { event.preventDefault(); setSelectedFolder(node.item.id); setExpanded((value) => new Set(value).add(node.item.id)); }
              if (event.key === 'Enter' && node.kind === 'conversation') { event.preventDefault(); void onOpen(node.item); } }}
            className={`work-tree-row ${active ? 'active' : ''} ${selected ? 'selected-folder' : ''} ${dropTarget === node.item.id ? 'drop-target' : ''}`}
            style={{ paddingLeft: `${10 + node.depth * 18}px` }} title={nodeName(node)}>
            {node.kind === 'folder' ? <button type="button" className="work-tree-disclosure" aria-label={expanded.has(node.item.id) ? `收起${node.item.name}` : `展开${node.item.name}`}
              onClick={(event) => { event.stopPropagation(); setExpanded((value) => { const next = new Set(value); next.has(node.item.id) ? next.delete(node.item.id) : next.add(node.item.id); return next; }); }}>
              <AppIcon name="chevron" /></button> : <span className="work-tree-disclosure-spacer" />}
            <span className="work-tree-icon" aria-hidden="true"><WorkNodeIcon iconId={node.item.iconId} /></span>
            {editing?.id === node.item.id ? <input ref={renameInput} className="work-tree-rename" aria-label="重命名" value={editingName}
              onClick={(event) => event.stopPropagation()} onChange={(event) => setEditingName(event.target.value)}
              onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') void saveRename(); if (event.key === 'Escape') setEditing(undefined); }} />
              : <span className="work-tree-name">{nodeName(node)}</span>}
            {node.kind === 'conversation' && node.item.tagIds.length > 0 && <span className="work-tree-tag-count" title={node.item.tagIds.map((id) => tags.find((tag) => tag.id === id)?.name).filter(Boolean).join('、')}>{node.item.tagIds.length}</span>}
            <button ref={menu?.node.id === node.item.id ? menuAnchorRef : undefined} type="button" className="work-tree-more" aria-label={`${nodeName(node)}的操作`} aria-expanded={menu?.node.id === node.item.id}
              disabled={disabled} onClick={(event) => openMenu(event, ref)}>···</button>
          </div>
        </div>;
      })}
      {archiveView && conversations.some((item) => item.id === 'default') && <div role="treeitem" tabIndex={focusKey === 'legacy' ? 0 : -1} data-tree-key="legacy" aria-level={1}
        className={`work-tree-row ${currentId === 'default' ? 'active' : ''}`} onFocus={() => setFocusKey('legacy')}
        onClick={() => { const legacy = conversations.find((item) => item.id === 'default'); if (legacy) void onOpen(legacy); }}>
        <span className="work-tree-disclosure-spacer" /><span className="work-tree-icon"><AppIcon name="archive" /></span><span className="work-tree-name">旧工作（只读）</span>
      </div>}
      {nodes.length === 0 && <p>{archiveView ? '还没有归档会话。' : '新建会话或文件夹，开始整理工作。'}</p>}
    </div>}
    {menu && createPortal(<div ref={menuRef} className="work-tree-menu" role="menu"
      aria-label="会话操作" style={{ top: menu.top, left: menu.left }} onClick={(event) => event.stopPropagation()}>
      <button type="button" role="menuitem" onClick={() => beginRename(menu.node)}><AppIcon name="edit" />重命名</button>
      <button type="button" role="menuitem" onClick={() => openDetails(menu.node, 'icon')}><AppIcon name="image" />修改图标</button>
      {menu.node.kind === 'conversation' && <button type="button" role="menuitem" onClick={() => openDetails(menu.node, 'tags')}><AppIcon name="tag" />修改标签</button>}
      <button type="button" role="menuitem" onClick={() => {
        const parentId = menu.node.kind === 'folder' ? folders.find((folder) => folder.id === menu.node.id)?.parentId
          : conversations.find((conversation) => conversation.id === menu.node.id)?.folderId;
        setMoveTarget(parentId ?? null);
        setDialog({ kind: 'move', node: menu.node }); setMenu(undefined);
      }}><AppIcon name="folder" />移动到…</button>
      <button type="button" role="menuitem" onClick={() => void reorder(menu.node, -1)}><AppIcon name="arrow-up" />上移</button>
      <button type="button" role="menuitem" onClick={() => void reorder(menu.node, 1)}><AppIcon name="arrow-down" />下移</button>
      {menu.node.kind === 'conversation' && <button type="button" role="menuitem" onClick={() => {
        const item = conversations.find((conversation) => conversation.id === menu.node.id);
        if (item) void perform(() => desktop.updateWorkConversation(item.id, { archived: !item.archived }), () => setMenu(undefined));
      }}><AppIcon name="archive" />{conversations.find((conversation) => conversation.id === menu.node.id)?.archived ? '恢复会话' : '归档会话'}</button>}
    </div>, document.body)}
    {dialog && <div className="work-tree-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDialog(undefined); }}>
      <section role="dialog" aria-modal="true" aria-label={dialog.kind === 'move' ? '移动到文件夹' : dialog.kind === 'icon' ? '修改图标' : '修改标签'} className="work-tree-dialog">
        <div className="work-tree-dialog-heading"><strong>{dialog.kind === 'move' ? '移动到文件夹' : dialog.kind === 'icon' ? '修改图标' : '修改标签'}</strong><button type="button" onClick={() => setDialog(undefined)} aria-label="关闭">×</button></div>
        {dialog.kind === 'move' ? <>
          <p>移动会同时搬迁磁盘上的工作目录。运行中或外部工作目录会被服务端拒绝。</p>
          <label>目标文件夹<select value={moveTarget ?? ''} onChange={(event) => setMoveTarget(event.target.value || null)}>
            <option value="">未分类（根目录）</option>
            {folders.filter((folder) => !folder.system && canPlace(dialog.node, folder.id))
              .map((folder) => <option key={folder.id} value={folder.id}>{[...folderPath(folders, folder.parentId).map((part) => part.name), folder.name].join(' / ')}</option>)}
          </select></label>
          <div className="work-tree-dialog-actions"><button type="button" onClick={() => setDialog(undefined)}>取消</button><button type="button" disabled={disabled} onClick={() => void moveNode(dialog.node, moveTarget)}>移动</button></div>
        </> : dialog.kind === 'icon' ? <>
          <div className="work-tree-icon-options" role="group" aria-label="选择图标">
            {workIconChoices.slice(iconPage * 36, iconPage * 36 + 36).map((icon) => <button key={icon.id} type="button" title={icon.label} aria-label={icon.label} aria-pressed={detailIcon === icon.id}
              onClick={() => setDetailIcon(icon.id)}><WorkNodeIcon iconId={icon.id} /><span>{icon.label}</span></button>)}
          </div>
          <div className="work-tree-icon-pages"><button type="button" disabled={iconPage === 0} onClick={() => setIconPage(0)}>上一页</button>
            <span>{iconPage + 1} / 2</span><button type="button" disabled={iconPage === 1} onClick={() => setIconPage(1)}>下一页</button></div>
          <div className="work-tree-dialog-actions"><button type="button" onClick={() => setDialog(undefined)}>取消</button><button type="button" disabled={disabled} onClick={() => void saveDetails()}>保存</button></div>
        </> : <>
          <div className="work-tree-tag-options">{tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={detailTagIds.includes(tag.id)}
            onChange={(event) => setDetailTagIds((value) => event.target.checked ? [...value, tag.id] : value.filter((id) => id !== tag.id))} /><span style={{ backgroundColor: tag.color }} />{tag.name}</label>)}</div>
          <label>新标签<input value={newTagName} onChange={(event) => setNewTagName(event.target.value)} placeholder="输入新标签名称（可选）" /></label>
          <div className="work-tree-dialog-actions"><button type="button" onClick={() => setDialog(undefined)}>取消</button><button type="button" disabled={disabled} onClick={() => void saveDetails()}>保存</button></div>
        </>}
      </section>
    </div>}
    {draftFolder && <div className="work-tree-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDraftFolder(false); }}>
      <section role="dialog" aria-modal="true" aria-label="新建文件夹" className="work-tree-dialog">
        <div className="work-tree-dialog-heading"><strong>新建文件夹</strong><button type="button" onClick={() => setDraftFolder(false)} aria-label="关闭">×</button></div>
        <label>文件夹名称<input ref={draftInput} aria-label="新文件夹名称" value={draftName} onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void saveFolder(); if (event.key === 'Escape') setDraftFolder(false); }} /></label>
        <div className="work-tree-placement" role="group" aria-label="创建位置">
          <label><input type="radio" name="folder-placement" checked={folderPlacement === 'sibling'} onChange={() => setFolderPlacement('sibling')} />
            <span>同级{selected ? ` · ${selected.parentId ? folders.find((folder) => folder.id === selected.parentId)?.name ?? '上级' : '未分类'}` : ' · 未分类'}</span></label>
          <label><input type="radio" name="folder-placement" checked={folderPlacement === 'child'} disabled={!selected || folderPath(folders, selectedFolder).length >= 5}
            onChange={() => setFolderPlacement('child')} /><span>子级{selected ? ` · ${selected.name}` : ''}</span></label>
        </div>
        <p>目标位置：{creationParent ? folderPath(folders, creationParent).map((folder) => folder.name).join(' / ') : '未分类'} · 第 {creationDepth} 级（最多 5 级）</p>
        <div className="work-tree-dialog-actions"><button type="button" onClick={() => setDraftFolder(false)}>取消</button>
          <button type="button" disabled={disabled || !draftName.trim() || creationDepth > 5} onClick={() => void saveFolder()}>创建</button></div>
      </section>
    </div>}
  </div>;
}
