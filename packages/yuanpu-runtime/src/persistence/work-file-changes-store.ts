import type { DatabaseSync } from 'node:sqlite';
import type { CapturedWorkFileChange, WorkFileSnapshot } from '../pi/file-changes.js';

export interface StoredWorkFileChange {
  changeId: number;
  conversationId: string;
  piSessionId: string;
  runId: string;
  toolCallId: string;
  toolName: CapturedWorkFileChange['toolName'];
  relativePath: string;
  /** null 表示工具执行前文件不存在（新建）。 */
  before: WorkFileSnapshot | null;
  after: WorkFileSnapshot;
  createdAt: string;
}

/** 审查视图的一行：同一文件的多次编辑合并为首 before + 末 after。 */
export interface MergedWorkFileChange {
  path: string;
  runId: string;
  toolName: CapturedWorkFileChange['toolName'];
  before: WorkFileSnapshot | null;
  after: WorkFileSnapshot;
  updatedAt: string;
}

const CHANGE_COLUMNS = `change_id, conversation_id, pi_session_id, run_id, tool_call_id, tool_name,
  relative_path, before_content, before_sha256, before_size, before_truncated,
  after_content, after_sha256, after_size, after_truncated, created_at`;

interface ChangeRow {
  change_id: number; conversation_id: string; pi_session_id: string; run_id: string;
  tool_call_id: string; tool_name: string; relative_path: string;
  before_content: string | null; before_sha256: string | null; before_size: number | null;
  before_truncated: number; after_content: string; after_sha256: string; after_size: number;
  after_truncated: number; created_at: string;
}

function snapshot(content: string | null, sha256: string | null, size: number | null, truncated: number): WorkFileSnapshot | null {
  if (content === null || sha256 === null || size === null) return null;
  return { content, sha256, size, truncated: truncated === 1 };
}

function fromRow(row: ChangeRow): StoredWorkFileChange {
  return {
    changeId: row.change_id, conversationId: row.conversation_id, piSessionId: row.pi_session_id,
    runId: row.run_id, toolCallId: row.tool_call_id,
    toolName: row.tool_name as StoredWorkFileChange['toolName'], relativePath: row.relative_path,
    before: snapshot(row.before_content, row.before_sha256, row.before_size, row.before_truncated),
    after: { content: row.after_content, sha256: row.after_sha256, size: row.after_size, truncated: row.after_truncated === 1 },
    createdAt: row.created_at,
  };
}

/** 同一文件取首次 before 与末次 after 合并（重算口径在调用方）；保持首次出现顺序。 */
export function mergeWorkFileChanges(rows: ReadonlyArray<StoredWorkFileChange>): MergedWorkFileChange[] {
  const merged = new Map<string, MergedWorkFileChange>();
  for (const row of rows) {
    const existing = merged.get(row.relativePath);
    if (!existing) {
      merged.set(row.relativePath, { path: row.relativePath, runId: row.runId,
        toolName: row.toolName, before: row.before, after: row.after, updatedAt: row.createdAt });
      continue;
    }
    existing.after = row.after;
    existing.runId = row.runId;
    existing.updatedAt = row.createdAt;
  }
  return [...merged.values()];
}

/** 会话文件变更台账：edit/write 捕获结果的唯一持久化位置，幂等追加。 */
export class WorkFileChangeStore {
  constructor(private readonly database: DatabaseSync) {}

  record(conversationId: string, piSessionId: string, runId: string,
    changes: ReadonlyArray<CapturedWorkFileChange>): void {
    if (!changes.length) return;
    const conversation = conversationId.startsWith('work:') ? conversationId.slice('work:'.length) : conversationId;
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO yp_work_file_changes (
        conversation_id, pi_session_id, run_id, tool_call_id, tool_name, relative_path,
        before_content, before_sha256, before_size, before_truncated,
        after_content, after_sha256, after_size, after_truncated, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const now = new Date().toISOString();
    for (const change of changes) {
      insert.run(conversation, piSessionId, runId, change.toolCallId, change.toolName, change.relativePath,
        change.before?.content ?? null, change.before?.sha256 ?? null, change.before?.size ?? null,
        change.before?.truncated ? 1 : 0,
        change.after.content, change.after.sha256, change.after.size, change.after.truncated ? 1 : 0, now);
    }
  }

  list(conversationId: string, runId?: string): StoredWorkFileChange[] {
    const conversation = conversationId.startsWith('work:') ? conversationId.slice('work:'.length) : conversationId;
    const rows = (runId
      ? this.database.prepare(
          `SELECT ${CHANGE_COLUMNS} FROM yp_work_file_changes WHERE conversation_id = ? AND run_id = ? ORDER BY change_id ASC`,
        ).all(conversation, runId)
      : this.database.prepare(
          `SELECT ${CHANGE_COLUMNS} FROM yp_work_file_changes WHERE conversation_id = ? ORDER BY change_id ASC`,
        ).all(conversation)) as unknown as ChangeRow[];
    return rows.map(fromRow);
  }
}
