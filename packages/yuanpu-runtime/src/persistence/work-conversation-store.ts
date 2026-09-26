import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AssistantSourceChange, DesktopTranscriptMessage, WorkConversation, WorkFolder, WorkTag } from '@yuanpu-agent/protocol';

interface WorkRow {
  conversation_id: string;
  pi_session_id: string;
  working_directory: string;
  created_at: string;
  updated_at: string;
  title: string;
  icon_id: string;
  folder_id: string | null;
  sort_order: number;
  archived_at: string | null;
}

interface FolderRow {
  folder_id: string; workspace_id: string; parent_id: string | null; name: string;
  icon_id: string; relative_directory: string; sort_order: number;
  created_at: string; updated_at: string;
}
interface TagRow { tag_id: string; workspace_id: string; name: string; color: string; created_at: string; updated_at: string }

const icons = new Set(['chat', 'folder', 'briefcase', 'code', 'book', 'star', 'lightning', 'archive']);
function validName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120 || /[\x00-\x1f]/.test(name)) throw new Error('Invalid display name.');
  return name;
}
function validIcon(icon: string): string {
  if (!icons.has(icon)) throw new Error('Invalid icon ID.');
  return icon;
}
function validRequestId(requestId: string | undefined): string | null {
  if (requestId === undefined) return null;
  if (!/^[0-9a-f-]{36}$/.test(requestId)) throw new Error('Invalid Work create request ID.');
  return requestId;
}

interface SourceRow {
  conversation_id: string;
  turn_id: string;
  run_id: string;
  content_ref: string;
  source_version: string;
  committed_at: string;
  user_text: string;
  assistant_text: string;
}

export interface WorkTurnSource {
  sourceId: string;
  eventType: 'WorkTurnCommitted';
  conversationId: string;
  turnId: string;
  runId: string;
  contentRef: string;
  sourceVersion: string;
  committedAt: string;
  userText: string;
  assistantText: string;
}

export interface WorkDirectoryMovePlan {
  requestId: string;
  workspaceId: string;
  kind: 'folder' | 'conversation';
  id: string;
  targetFolderId: string | null;
  conversations: Array<{ id: string; piSessionId: string; from: string; to: string }>;
  folders: Array<{ id: string; from: string; to: string }>;
}

/** Owns the selected Work conversation and an idempotent source ledger. */
export class WorkConversationStore {
  constructor(private readonly database: DatabaseSync) {}

  moveRecords(): Array<{ requestId: string; value: string }> {
    return (this.database.prepare("SELECT key, value FROM yp_runtime_metadata WHERE key LIKE 'work.move.%'")
      .all() as Array<{ key: string; value: string }>).map((row) => ({ requestId: row.key.slice(10), value: row.value }));
  }

  saveMove(requestId: string, value: string): void {
    this.database.prepare(`INSERT INTO yp_runtime_metadata(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(`work.move.${requestId}`, value, new Date().toISOString());
  }

  assertMoveIdle(ids: string[]): void {
    for (const id of ids) {
      const work = this.database.prepare('SELECT pi_session_id,working_directory FROM yp_work_conversations WHERE conversation_id=?')
        .get(id) as { pi_session_id: string; working_directory: string } | undefined;
      if (!work) throw new Error('Unknown Work conversation.');
      const bindings = this.database.prepare(`SELECT pi_session_id,workspace_id,conversation_id,thread_id
        FROM yp_conversation_bindings WHERE (namespace='desktop' AND conversation_id=?) OR workspace_id=?`)
        .all(id, work.working_directory) as Array<{ pi_session_id: string; workspace_id: string; conversation_id: string; thread_id: string }>;
      if (bindings.length !== 1 || bindings[0]!.pi_session_id !== work.pi_session_id
        || bindings[0]!.workspace_id !== work.working_directory || bindings[0]!.thread_id !== '') {
        throw new Error('Work directory has inconsistent or additional session bindings; resolve them before moving.');
      }
      const active = this.database.prepare(`SELECT r.run_id FROM yp_agent_runs r
        JOIN yp_conversation_bindings b ON b.binding_id=r.binding_id
        WHERE b.namespace='desktop' AND b.conversation_id=? AND r.status IN ('queued','running','waiting_approval') LIMIT 1`).get(id);
      if (active) throw new Error('Work conversation has a queued, running or approval-waiting run.');
    }
  }

  /** The commit marker and all live paths become authoritative in one transaction. */
  commitMove(plan: WorkDirectoryMovePlan, committedJournal: string): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.assertMoveIdle(plan.conversations.map((item) => item.id));
      const now = new Date().toISOString();
      for (const item of plan.conversations) {
        const result = this.database.prepare(`UPDATE yp_work_conversations SET working_directory=?,updated_at=?
          WHERE workspace_id=? AND conversation_id=? AND working_directory=?`)
          .run(item.to, now, plan.workspaceId, item.id, item.from);
        if (result.changes !== 1) throw new Error('Work directory changed while moving.');
        this.database.prepare(`UPDATE yp_conversation_bindings SET workspace_id=?,updated_at=?
          WHERE namespace='desktop' AND conversation_id=? AND workspace_id=?`).run(item.to, now, item.id, item.from);
      }
      for (const item of plan.folders) {
        const result = this.database.prepare(`UPDATE yp_work_folders SET relative_directory=?,updated_at=?
          WHERE workspace_id=? AND folder_id=? AND relative_directory=?`)
          .run(item.to, now, plan.workspaceId, item.id, item.from);
        if (result.changes !== 1) throw new Error('Work folder changed while moving.');
      }
      if (plan.kind === 'conversation') {
        this.database.prepare('UPDATE yp_work_conversations SET folder_id=?,sort_order=? WHERE conversation_id=?')
          .run(plan.targetFolderId, this.nextOrder('yp_work_conversations','folder_id',plan.workspaceId,plan.targetFolderId),plan.id);
      } else {
        this.database.prepare('UPDATE yp_work_folders SET parent_id=?,sort_order=? WHERE folder_id=?')
          .run(plan.targetFolderId, this.nextOrder('yp_work_folders','parent_id',plan.workspaceId,plan.targetFolderId),plan.id);
      }
      this.saveMove(plan.requestId, committedJournal);
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  private currentKey(workspaceId: string): string {
    return `work.current.${createHash('sha256').update(workspaceId).digest('hex')}`;
  }

  private selectedId(workspaceId: string): string | undefined {
    const row = this.database.prepare('SELECT value FROM yp_runtime_metadata WHERE key = ?')
      .get(this.currentKey(workspaceId)) as { value: string } | undefined;
    return row?.value;
  }

  private toConversation(row: WorkRow, currentId: string): WorkConversation {
    return { id: row.conversation_id, createdAt: row.created_at, updatedAt: row.updated_at,
      workingDirectory: row.working_directory,
      previousWorkingDirectories: this.moveRecords().flatMap(({ value }) => {
        const move = JSON.parse(value) as { state: string; result: { previousDirectories: Array<{ conversationId: string; path: string }> } };
        return move.state === 'done' || move.state === 'committed'
          ? move.result.previousDirectories.filter((item) => item.conversationId === row.conversation_id).map((item) => item.path) : [];
      }), title: row.title, iconId: row.icon_id,
      folderId: row.folder_id, sortOrder: row.sort_order, archivedAt: row.archived_at,
      tagIds: (this.database.prepare('SELECT tag_id FROM yp_work_conversation_tags WHERE conversation_id = ? ORDER BY tag_id')
        .all(row.conversation_id) as Array<{ tag_id: string }>).map((item) => item.tag_id),
      current: row.conversation_id === currentId, archived: row.archived_at !== null };
  }

  current(workspaceId: string): WorkConversation {
    const selected = this.selectedId(workspaceId);
    const row = selected ? this.row(workspaceId, selected) : undefined;
    return row && !row.archived_at ? this.toConversation(row, selected!) : this.create(workspaceId);
  }

  create(workspaceId: string, workingDirectory = workspaceId, folderId: string | null = null,
    id = `work:${randomUUID()}`, requestId?: string): WorkConversation {
    if (folderId && !this.folderRow(workspaceId, folderId)) throw new Error('Unknown Work folder.');
    const piSessionId = randomUUID();
    const now = new Date().toISOString();
    const sortOrder = this.nextOrder('yp_work_conversations', 'folder_id', workspaceId, folderId);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`INSERT INTO yp_work_conversations
        (conversation_id, pi_session_id, workspace_id, working_directory, created_at, updated_at, folder_id, sort_order, request_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, piSessionId, workspaceId, workingDirectory, now, now, folderId, sortOrder, validRequestId(requestId));
      this.database.prepare(`INSERT INTO yp_conversation_bindings
        (binding_id, entry_point, authority_id, subject_id, namespace, conversation_id,
         thread_id, pi_session_id, workspace_id, created_at, updated_at)
        VALUES (?, 'desktop', 'local-desktop', 'local-user', 'desktop', ?, '', ?, ?, ?, ?)`)
        .run(randomUUID(), id, piSessionId, workingDirectory, now, now);
      this.database.prepare(`INSERT INTO yp_runtime_metadata(key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(this.currentKey(workspaceId), id, now);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.toConversation(this.row(workspaceId, id)!, id);
  }

  select(workspaceId: string, id: string): WorkConversation {
    const row = this.row(workspaceId, id);
    if (!row || row.archived_at) throw new Error('Unknown Work conversation.');
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO yp_runtime_metadata(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(this.currentKey(workspaceId), id, now);
    return this.toConversation(row, id);
  }

  row(workspaceId: string, id: string): WorkRow | undefined {
    return this.database.prepare(`SELECT *
      FROM yp_work_conversations WHERE workspace_id = ? AND conversation_id = ?`)
      .get(workspaceId, id) as WorkRow | undefined;
  }

  conversationForRequest(workspaceId: string, requestId: string): WorkConversation | undefined {
    const row = this.database.prepare('SELECT * FROM yp_work_conversations WHERE workspace_id=? AND request_id=?')
      .get(workspaceId, validRequestId(requestId)) as WorkRow | undefined;
    return row ? this.toConversation(row, this.selectedId(workspaceId) ?? '') : undefined;
  }

  hasWorkingDirectory(workspaceId: string, workingDirectory: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM yp_work_conversations
      WHERE workspace_id = ? AND working_directory = ? LIMIT 1`)
      .get(workspaceId, workingDirectory));
  }

  sessionId(workspaceId: string, id: string): string | undefined {
    if (id === 'default') {
      const legacy = this.database.prepare(`SELECT pi_session_id FROM yp_conversation_bindings
        WHERE entry_point = 'desktop' AND authority_id = 'local-desktop' AND subject_id = 'local-user'
          AND namespace = 'desktop' AND conversation_id = 'default' AND workspace_id = ?`)
        .get(workspaceId) as { pi_session_id: string } | undefined;
      return legacy?.pi_session_id;
    }
    return this.row(workspaceId, id)?.pi_session_id;
  }

  touch(workspaceId: string, id: string, at = new Date().toISOString()): void {
    this.database.prepare(`UPDATE yp_work_conversations SET updated_at = ?
      WHERE workspace_id = ? AND conversation_id = ?`).run(at, workspaceId, id);
  }

  list(workspaceId: string): WorkConversation[] {
    this.current(workspaceId);
    return this.listExisting(workspaceId);
  }

  /** Scans must not create an empty conversation merely because Runtime started. */
  listExisting(workspaceId: string): WorkConversation[] {
    const currentId = this.selectedId(workspaceId) ?? '';
    const rows = this.database.prepare(`SELECT *
      FROM yp_work_conversations WHERE workspace_id = ? ORDER BY folder_id, sort_order, created_at`)
      .all(workspaceId) as unknown as WorkRow[];
    const conversations = rows.map((row) => this.toConversation(row, currentId));
    const legacy = this.database.prepare(`SELECT created_at, updated_at FROM yp_conversation_bindings
      WHERE entry_point = 'desktop' AND authority_id = 'local-desktop' AND subject_id = 'local-user'
        AND namespace = 'desktop' AND conversation_id = 'default' AND workspace_id = ?`)
      .get(workspaceId) as { created_at: string; updated_at: string } | undefined;
    if (legacy) conversations.push({ id: 'default', createdAt: legacy.created_at, workingDirectory: workspaceId,
      updatedAt: legacy.updated_at, current: false, archived: true, archivedAt: null,
      title: '', iconId: 'archive', folderId: null, sortOrder: -1, tagIds: [] });
    return conversations;
  }

  private nextOrder(table: 'yp_work_folders' | 'yp_work_conversations',
    parentColumn: 'parent_id' | 'folder_id', workspaceId: string, parentId: string | null): number {
    const row = this.database.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM ${table}
      WHERE workspace_id = ? AND ${parentColumn} IS ?`).get(workspaceId, parentId) as { next: number };
    return row.next;
  }

  beginCreateIntent(workspaceId: string, id: string, relativeDirectory: string,
    kind: 'folder' | 'conversation'): void {
    if (!/^(?:f-[0-9a-f-]{36}\/)*[cf]-[0-9a-f-]{36}$/.test(relativeDirectory)) {
      throw new Error('Invalid Work creation path.');
    }
    this.database.prepare(`INSERT INTO yp_work_create_intents(node_id,workspace_id,relative_directory,kind)
      VALUES (?,?,?,?)`).run(id, workspaceId, relativeDirectory, kind);
  }
  finishCreateIntent(id: string): void {
    this.database.prepare('DELETE FROM yp_work_create_intents WHERE node_id=?').run(id);
  }
  pendingCreateIntents(workspaceId: string): Array<{ id: string; relativeDirectory: string; committed: boolean }> {
    const rows = this.database.prepare(`SELECT i.node_id, i.relative_directory,
      CASE WHEN i.kind='folder' THEN f.folder_id ELSE c.conversation_id END AS committed_id
      FROM yp_work_create_intents i
      LEFT JOIN yp_work_folders f ON f.folder_id=i.node_id
      LEFT JOIN yp_work_conversations c ON c.conversation_id=i.node_id
      WHERE i.workspace_id=?`).all(workspaceId) as Array<{
      node_id: string; relative_directory: string; committed_id: string | null;
    }>;
    return rows.map((row) => ({ id: row.node_id, relativeDirectory: row.relative_directory,
      committed: Boolean(row.committed_id) }));
  }

  folderRow(workspaceId: string, id: string): FolderRow | undefined {
    return this.database.prepare('SELECT * FROM yp_work_folders WHERE workspace_id = ? AND folder_id = ?')
      .get(workspaceId, id) as FolderRow | undefined;
  }

  private toFolder(row: FolderRow): WorkFolder {
    return { id: row.folder_id, parentId: row.parent_id, name: row.name, iconId: row.icon_id,
      relativeDirectory: row.relative_directory, sortOrder: row.sort_order,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  listFolders(workspaceId: string): WorkFolder[] {
    const folders = (this.database.prepare('SELECT * FROM yp_work_folders WHERE workspace_id = ? ORDER BY parent_id, sort_order')
      .all(workspaceId) as unknown as FolderRow[]).map((row) => this.toFolder(row));
    return [{ id: 'uncategorized', parentId: null, name: '未分类', iconId: 'folder',
      relativeDirectory: '', sortOrder: -1, createdAt: '', updatedAt: '', system: true }, ...folders];
  }

  createFolder(workspaceId: string, id: string, parentId: string | null, name: string,
    iconId: string, relativeDirectory: string, requestId?: string): WorkFolder {
    const parent = parentId ? this.folderRow(workspaceId, parentId) : undefined;
    if (parentId && !parent) throw new Error('Unknown Work parent folder.');
    if (!/^folder:[0-9a-f-]{36}$/.test(id)
      || !/^f-[0-9a-f-]{36}(\/f-[0-9a-f-]{36})*$/.test(relativeDirectory)
      || (parent ? !relativeDirectory.startsWith(`${parent.relative_directory}/`)
        || relativeDirectory.slice(parent.relative_directory.length + 1).includes('/') : relativeDirectory.includes('/'))) {
      throw new Error('Invalid Work folder directory.');
    }
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO yp_work_folders
      (folder_id,workspace_id,parent_id,name,icon_id,relative_directory,sort_order,created_at,updated_at,request_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, workspaceId, parentId, validName(name), validIcon(iconId),
        relativeDirectory, this.nextOrder('yp_work_folders', 'parent_id', workspaceId, parentId), now, now,
        validRequestId(requestId));
    return this.toFolder(this.folderRow(workspaceId, id)!);
  }
  folderForRequest(workspaceId: string, requestId: string): WorkFolder | undefined {
    const row = this.database.prepare('SELECT * FROM yp_work_folders WHERE workspace_id=? AND request_id=?')
      .get(workspaceId, validRequestId(requestId)) as FolderRow | undefined;
    return row ? this.toFolder(row) : undefined;
  }

  updateFolder(workspaceId: string, id: string, patch: { name?: string; iconId?: string }): WorkFolder {
    const row = this.folderRow(workspaceId, id);
    if (!row) throw new Error('Unknown Work folder.');
    if (patch.name !== undefined) row.name = validName(patch.name);
    if (patch.iconId !== undefined) row.icon_id = validIcon(patch.iconId);
    this.database.prepare('UPDATE yp_work_folders SET name=?, icon_id=?, updated_at=? WHERE folder_id=?')
      .run(row.name, row.icon_id, new Date().toISOString(), id);
    return this.toFolder(this.folderRow(workspaceId, id)!);
  }

  updateConversation(workspaceId: string, id: string,
    patch: { title?: string; iconId?: string; archived?: boolean; tagIds?: string[] }): WorkConversation {
    const row = this.row(workspaceId, id);
    if (!row) throw new Error('Unknown Work conversation.');
    const title = patch.title === undefined ? row.title : validName(patch.title);
    const iconId = patch.iconId === undefined ? row.icon_id : validIcon(patch.iconId);
    if (patch.archived !== undefined && typeof patch.archived !== 'boolean') throw new Error('Invalid archive state.');
    if (patch.tagIds !== undefined && (!Array.isArray(patch.tagIds)
      || patch.tagIds.some((tagId) => typeof tagId !== 'string') || new Set(patch.tagIds).size !== patch.tagIds.length)) {
      throw new Error('Invalid Work tags.');
    }
    const tags = patch.tagIds;
    if (tags?.some((tagId) => !this.tagRow(workspaceId, tagId))) throw new Error('Unknown Work tag.');
    const archivedAt = patch.archived === undefined ? row.archived_at
      : patch.archived ? row.archived_at ?? new Date().toISOString() : null;
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`UPDATE yp_work_conversations SET title=?, icon_id=?, archived_at=?, updated_at=?
        WHERE workspace_id=? AND conversation_id=?`).run(title, iconId, archivedAt, now, workspaceId, id);
      if (tags) {
        this.database.prepare('DELETE FROM yp_work_conversation_tags WHERE conversation_id=?').run(id);
        for (const tagId of tags) this.database.prepare(
          'INSERT INTO yp_work_conversation_tags(conversation_id,tag_id) VALUES (?,?)').run(id, tagId);
      }
      if (archivedAt && this.selectedId(workspaceId) === id) {
        this.database.prepare('DELETE FROM yp_runtime_metadata WHERE key=?').run(this.currentKey(workspaceId));
      }
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    return this.toConversation(this.row(workspaceId, id)!, this.selectedId(workspaceId) ?? '');
  }

  private tagRow(workspaceId: string, id: string): TagRow | undefined {
    return this.database.prepare('SELECT * FROM yp_work_tags WHERE workspace_id=? AND tag_id=?')
      .get(workspaceId, id) as TagRow | undefined;
  }
  private toTag(row: TagRow): WorkTag {
    return { id: row.tag_id, name: row.name, color: row.color,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }
  listTags(workspaceId: string): WorkTag[] {
    return (this.database.prepare('SELECT * FROM yp_work_tags WHERE workspace_id=? ORDER BY name')
      .all(workspaceId) as unknown as TagRow[]).map((row) => this.toTag(row));
  }
  createTag(workspaceId: string, name: string, color = 'gray', requestId?: string): WorkTag {
    if (!/^(gray|red|orange|yellow|green|blue|purple)$/.test(color)) throw new Error('Invalid Work tag color.');
    const id = `tag:${randomUUID()}`;
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO yp_work_tags(tag_id,workspace_id,name,color,created_at,updated_at,request_id)
      VALUES (?,?,?,?,?,?,?)`).run(id, workspaceId, validName(name), color, now, now, validRequestId(requestId));
    return this.toTag(this.tagRow(workspaceId, id)!);
  }
  tagForRequest(workspaceId: string, requestId: string): WorkTag | undefined {
    const row = this.database.prepare('SELECT * FROM yp_work_tags WHERE workspace_id=? AND request_id=?')
      .get(workspaceId, validRequestId(requestId)) as TagRow | undefined;
    return row ? this.toTag(row) : undefined;
  }
  updateTag(workspaceId: string, id: string, patch: { name?: string; color?: string }): WorkTag {
    const row = this.tagRow(workspaceId, id);
    if (!row) throw new Error('Unknown Work tag.');
    const name = patch.name === undefined ? row.name : validName(patch.name);
    const color = patch.color ?? row.color;
    if (!/^(gray|red|orange|yellow|green|blue|purple)$/.test(color)) throw new Error('Invalid Work tag color.');
    this.database.prepare('UPDATE yp_work_tags SET name=?,color=?,updated_at=? WHERE tag_id=?')
      .run(name, color, new Date().toISOString(), id);
    return this.toTag(this.tagRow(workspaceId, id)!);
  }

  reorder(workspaceId: string, kind: 'folder' | 'conversation', parentId: string | null, ids: string[]): void {
    if (parentId && !this.folderRow(workspaceId, parentId)) throw new Error('Unknown Work folder.');
    const items = kind === 'folder' ? this.listFolders(workspaceId).filter((item) => !item.system && item.parentId === parentId)
      : this.listExisting(workspaceId).filter((item) => item.id !== 'default' && item.folderId === parentId);
    if (!Array.isArray(ids) || ids.length !== items.length || new Set(ids).size !== ids.length
      || ids.some((id) => !items.some((item) => item.id === id))) throw new Error('Invalid Work sibling order.');
    const table = kind === 'folder' ? 'yp_work_folders' : 'yp_work_conversations';
    const column = kind === 'folder' ? 'folder_id' : 'conversation_id';
    this.database.exec('BEGIN IMMEDIATE');
    try {
      ids.forEach((id, index) => this.database.prepare(`UPDATE ${table} SET sort_order=? WHERE workspace_id=? AND ${column}=?`)
        .run(index, workspaceId, id));
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  /** A run is eligible only after both its success and output have been committed. */
  private succeededRuns(conversationId: string): Array<{ runId: string; inputDigest: string; output: string }> {
    const rows = this.database.prepare(`SELECT r.run_id, r.input_digest, o.output_json
      FROM yp_agent_runs r
      JOIN yp_conversation_bindings b ON b.binding_id = r.binding_id
      JOIN yp_agent_run_outputs o ON o.run_id = r.run_id
      WHERE r.entry_point = 'desktop' AND b.conversation_id = ? AND r.status = 'succeeded'
      ORDER BY r.created_at, r.rowid`).all(conversationId) as Array<{ run_id: string; input_digest: string; output_json: string }>;
    return rows.flatMap((row) => {
      const output = JSON.parse(row.output_json) as { message?: unknown };
      return typeof output.message === 'string'
        ? [{ runId: row.run_id, inputDigest: row.input_digest, output: output.message }]
        : [];
    });
  }

  /** Insert only complete persisted turns whose Agent run succeeded. Repeated scans are harmless. */
  recordSavedTurns(conversationId: string, messages: readonly DesktopTranscriptMessage[]): number {
    const runs = this.succeededRuns(conversationId);
    const candidates: Array<{ user: DesktopTranscriptMessage; assistant: DesktopTranscriptMessage }> = [];
    let user: DesktopTranscriptMessage | undefined;
    let assistant: DesktopTranscriptMessage | undefined;
    for (const message of messages) {
      if (message.role === 'user') {
        if (user && assistant) candidates.push({ user, assistant });
        user = message;
        assistant = undefined;
      } else if (user && message.text.trim()) assistant = message;
    }
    if (user && assistant) candidates.push({ user, assistant });
    let inserted = 0;
    const matched = new Set<string>();
    for (const run of runs) {
      const match = candidates.find(({ user: candidateUser, assistant: candidateAssistant }) =>
        !matched.has(candidateAssistant.id)
        && createHash('sha256').update(candidateUser.text).digest('hex') === run.inputDigest
        && run.output.trim().endsWith(candidateAssistant.text.trim()));
      if (!match) continue;
      matched.add(match.assistant.id);
      const version = createHash('sha256').update(JSON.stringify([
        run.runId, match.user.id, match.user.text, match.assistant.id, match.assistant.text,
      ])).digest('hex');
      const sourceId = `work-turn:${conversationId}:${match.assistant.id}`;
      const contentRef = `work-content:${createHash('sha256').update(sourceId).digest('hex')}`;
      const result = this.database.prepare(`INSERT OR IGNORE INTO yp_work_turn_sources
        (conversation_id, turn_id, run_id, content_ref, source_version, committed_at, user_text, assistant_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(conversationId, match.assistant.id, run.runId, contentRef, version,
          match.assistant.at, match.user.text, match.assistant.text);
      inserted += Number(result.changes);
    }
    return inserted;
  }

  sources(conversationId?: string): WorkTurnSource[] {
    const rows = conversationId
      ? this.database.prepare(`SELECT * FROM yp_work_turn_sources WHERE conversation_id = ? ORDER BY committed_at, turn_id`).all(conversationId)
      : this.database.prepare(`SELECT * FROM yp_work_turn_sources ORDER BY committed_at, turn_id`).all();
    return (rows as unknown as SourceRow[]).map((row) => this.sourceFromRow(row));
  }

  private sourceFromRow(row: SourceRow): WorkTurnSource {
    return {
      sourceId: `work-turn:${row.conversation_id}:${row.turn_id}`, eventType: 'WorkTurnCommitted',
      conversationId: row.conversation_id,
      turnId: row.turn_id, runId: row.run_id, contentRef: row.content_ref,
      sourceVersion: row.source_version, committedAt: row.committed_at,
      userText: row.user_text, assistantText: row.assistant_text,
    };
  }

  /** The Worker can receive these serializable notices without a filesystem path or connection ID. */
  sourceChanges(conversationId?: string): AssistantSourceChange[] {
    return this.sources(conversationId).map((source) => ({
      sourceId: source.sourceId, sourceVersion: source.sourceVersion, kind: 'created',
      audience: { kind: 'personal', id: 'local-user' }, occurredAt: source.committedAt,
      contentRef: source.contentRef, workId: source.conversationId,
    }));
  }

  /** Explicit event IDs survive VACUUM and are independent of turn timestamps. */
  sourcePage(afterRowId: number, limit: number): Array<{ eventId: number; change: AssistantSourceChange }> {
    if (!Number.isSafeInteger(afterRowId) || afterRowId < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Invalid Work source page boundary.');
    }
    const rows = this.database.prepare(`SELECT * FROM yp_work_turn_sources
      WHERE event_id > ? ORDER BY event_id LIMIT ?`).all(afterRowId, limit) as unknown as
      Array<SourceRow & { event_id: number }>;
    return rows.map((row) => {
      const source = this.sourceFromRow(row);
      return { eventId: row.event_id, change: {
        sourceId: source.sourceId, sourceVersion: source.sourceVersion, kind: 'created',
        audience: { kind: 'personal', id: 'local-user' }, occurredAt: source.committedAt,
        contentRef: source.contentRef, workId: source.conversationId,
      } };
    });
  }

  /** The host resolves the opaque reference; a Worker never sees a local absolute path. */
  resolveContentRef(contentRef: string): WorkTurnSource | undefined {
    const row = this.database.prepare('SELECT * FROM yp_work_turn_sources WHERE content_ref = ?')
      .get(contentRef) as unknown as SourceRow | undefined;
    return row ? this.sourceFromRow(row) : undefined;
  }

  sourceById(sourceId: string): WorkTurnSource | undefined {
    if (!sourceId.startsWith('work-turn:')) return undefined;
    const contentRef = `work-content:${createHash('sha256').update(sourceId).digest('hex')}`;
    const source = this.resolveContentRef(contentRef);
    return source?.sourceId === sourceId ? source : undefined;
  }
}
