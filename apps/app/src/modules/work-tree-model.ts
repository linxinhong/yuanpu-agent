import type { WorkConversation, WorkFolder } from '@yuanpu-agent/protocol';

export type WorkTreeNode = { kind: 'folder'; item: WorkFolder; depth: number }
  | { kind: 'conversation'; item: WorkConversation; depth: number };

export function folderPath(folders: WorkFolder[], folderId: string | null): WorkFolder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const path: WorkFolder[] = [];
  const visited = new Set<string>();
  let id = folderId;
  while (id && id !== 'uncategorized' && !visited.has(id)) {
    visited.add(id);
    const folder = byId.get(id);
    if (!folder) break;
    path.unshift(folder);
    id = folder.parentId;
  }
  return path;
}

export function isFolderDescendant(folders: WorkFolder[], candidateId: string | null, ancestorId: string): boolean {
  return candidateId === ancestorId || folderPath(folders, candidateId).some((folder) => folder.id === ancestorId);
}

export function visibleWorkTree(folders: WorkFolder[], conversations: WorkConversation[],
  expanded: ReadonlySet<string>, archived: boolean): WorkTreeNode[] {
  const result: WorkTreeNode[] = [];
  const visited = new Set<string>();
  function append(parentId: string | null, depth: number): void {
    const children = folders.filter((folder) => !folder.system && folder.parentId === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    for (const folder of children) {
      if (visited.has(folder.id)) continue;
      visited.add(folder.id);
      result.push({ kind: 'folder', item: folder, depth });
      if (expanded.has(folder.id)) append(folder.id, depth + 1);
    }
    for (const item of conversations.filter((conversation) => conversation.id !== 'default'
      && conversation.folderId === parentId && conversation.archived === archived)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt))) {
      result.push({ kind: 'conversation', item, depth });
    }
  }
  append(null, 0);
  return result;
}

export function reorderedSiblingIds(ids: string[], id: string, direction: -1 | 1): string[] | undefined {
  const index = ids.indexOf(id);
  const other = index + direction;
  if (index < 0 || other < 0 || other >= ids.length) return undefined;
  const next = [...ids];
  [next[index], next[other]] = [next[other]!, next[index]!];
  return next;
}

export function reorderedVisibleSiblingIds(allIds: string[], visibleIds: string[], id: string,
  direction: -1 | 1): string[] | undefined {
  const reordered = reorderedSiblingIds(visibleIds, id, direction);
  if (!reordered) return undefined;
  const visible = new Set(visibleIds);
  let index = 0;
  return allIds.map((item) => visible.has(item) ? reordered[index++]! : item);
}
