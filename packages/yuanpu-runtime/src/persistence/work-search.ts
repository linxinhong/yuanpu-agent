import { createHash } from 'node:crypto';
import type { WorkConversation, WorkFolder, WorkTag } from '@yuanpu-agent/protocol';
import type { WorkConversationStore } from './work-conversation-store.js';
import { readSavedWorkMessages, type SavedWorkMessages } from '../pi/work-message-search.js';

export interface WorkSearchInput {
  workspaceId: string;
  sessionsDirectory: string;
  query: string;
  archive?: 'active' | 'archived' | 'all';
  limit?: number;
  cursor?: string;
}

export interface WorkSearchItem {
  kind: 'conversation' | 'message';
  conversationId: string;
  title: string;
  archived: boolean;
  folderPath: Array<{ id: string; name: string }>;
  matchedField: 'title' | 'folder' | 'tag' | 'message';
  snippet: string;
  messageEntryId?: string;
  role?: 'user' | 'assistant';
  at?: string;
  messagePosition?: number;
}

export interface WorkSearchResult {
  items: WorkSearchItem[];
  nextCursor?: string;
  contentFailures: Array<{ conversationId: string; reason: Exclude<SavedWorkMessages['status'], 'ok'> | 'budget_exceeded' }>;
}

const maxSearchBytes = 128 * 1024 * 1024;
function titleOf(item: WorkConversation): string { return item.title || '未命名会话'; }
function includes(text: string, query: string): boolean { return text.toLocaleLowerCase().includes(query); }
function snippet(text: string, query: string): string {
  const at = text.toLocaleLowerCase().indexOf(query);
  const start = Math.max(0, at - 70);
  const end = Math.min(text.length, at + query.length + 110);
  return `${start ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}

function pathFor(folderId: string | null, folders: Map<string, WorkFolder>): Array<{ id: string; name: string }> {
  const path: Array<{ id: string; name: string }> = [];
  const visited = new Set<string>();
  let id = folderId;
  while (id) {
    if (visited.has(id)) throw new Error('Work folder tree contains a cycle.');
    visited.add(id);
    const folder = folders.get(id);
    if (!folder) throw new Error('Work folder tree contains a missing ancestor.');
    path.unshift({ id: folder.id, name: folder.name });
    id = folder.parentId;
  }
  return path.length ? path : [{ id: 'uncategorized', name: folders.get('uncategorized')?.name ?? '未分类' }];
}

function itemKey(item: WorkSearchItem): string {
  return [item.folderPath.map((part) => part.name).join('/').toLocaleLowerCase(),
    item.title.toLocaleLowerCase(), item.conversationId,
    item.kind === 'conversation' ? '0' : '1', String(item.messagePosition ?? 0).padStart(12, '0'),
    item.messageEntryId ?? ''].join('\u0000');
}

/** Search only metadata in the caller's Work scope and saved visible text in matching Pi sessions. */
export function searchWorkConversations(store: WorkConversationStore, input: WorkSearchInput): WorkSearchResult {
  if (typeof input.query !== 'string') throw new Error('Search query must be text.');
  const query = input.query.trim().toLocaleLowerCase();
  if (!query || query.length > 200) throw new Error('Search query must contain 1 to 200 characters.');
  const archive = input.archive ?? 'active';
  if (archive !== 'active' && archive !== 'archived' && archive !== 'all') throw new Error('Invalid archive filter.');
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Search page size must be 1 to 50.');
  const fingerprint = createHash('sha256').update(JSON.stringify([input.workspaceId, query, archive])).digest('hex');
  let after = '';
  if (input.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as { fingerprint: string; after: string };
      if (parsed.fingerprint !== fingerprint || typeof parsed.after !== 'string') throw new Error();
      after = parsed.after;
    } catch { throw new Error('Invalid search cursor.'); }
  }
  const folders = new Map(store.listFolders(input.workspaceId).map((item) => [item.id, item]));
  const tags = new Map<string, WorkTag>(store.listTags(input.workspaceId).map((item) => [item.id, item]));
  const items: WorkSearchItem[] = [];
  const contentFailures: WorkSearchResult['contentFailures'] = [];
  let searchedBytes = 0;
  for (const conversation of store.listExisting(input.workspaceId)) {
    if (archive === 'active' && conversation.archived || archive === 'archived' && !conversation.archived) continue;
    const folderPath = pathFor(conversation.folderId, folders);
    const title = titleOf(conversation);
    const folder = folderPath.find((part) => includes(part.name, query));
    const tag = conversation.tagIds.map((id) => tags.get(id)).find((item) => item && includes(item.name, query));
    const matchedField = includes(title, query) ? 'title' : folder ? 'folder' : tag ? 'tag' : undefined;
    if (matchedField) items.push({ kind: 'conversation', conversationId: conversation.id, title,
      archived: conversation.archived, folderPath, matchedField,
      snippet: matchedField === 'title' ? title : matchedField === 'folder' ? folder!.name : tag!.name });
    const piSessionId = store.sessionId(input.workspaceId, conversation.id);
    if (!piSessionId) { contentFailures.push({ conversationId: conversation.id, reason: 'missing' }); continue; }
    if (searchedBytes >= maxSearchBytes) {
      contentFailures.push({ conversationId: conversation.id, reason: 'budget_exceeded' }); continue;
    }
    const saved = readSavedWorkMessages(conversation.workingDirectory, piSessionId, input.sessionsDirectory);
    searchedBytes += saved.bytesRead;
    if (saved.status !== 'ok') { contentFailures.push({ conversationId: conversation.id, reason: saved.status }); continue; }
    for (const message of saved.messages) {
      if (!includes(message.text, query)) continue;
      items.push({ kind: 'message', conversationId: conversation.id, title, archived: conversation.archived,
        folderPath, matchedField: 'message', snippet: snippet(message.text, query),
        messageEntryId: message.entryId, messagePosition: message.position, role: message.role, at: message.at });
    }
  }
  items.sort((a, b) => itemKey(a).localeCompare(itemKey(b), 'en'));
  const page = items.filter((item) => itemKey(item) > after).slice(0, limit + 1);
  const hasMore = page.length > limit;
  if (hasMore) page.pop();
  return { items: page, ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ fingerprint, after: itemKey(page.at(-1)!) })).toString('base64url') } : {}),
    contentFailures };
}
