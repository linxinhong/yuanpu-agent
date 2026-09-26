import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AssistantSourceChange, DesktopTranscriptMessage, WorkConversation } from '@yuanpu-agent/protocol';

interface WorkRow {
  conversation_id: string;
  pi_session_id: string;
  working_directory: string;
  created_at: string;
  updated_at: string;
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

/** Owns the selected Work conversation and an idempotent source ledger. */
export class WorkConversationStore {
  constructor(private readonly database: DatabaseSync) {}

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
      current: row.conversation_id === currentId, archived: false };
  }

  current(workspaceId: string): WorkConversation {
    const selected = this.selectedId(workspaceId);
    const row = selected ? this.row(workspaceId, selected) : undefined;
    return row ? this.toConversation(row, selected!) : this.create(workspaceId);
  }

  create(workspaceId: string, workingDirectory = workspaceId): WorkConversation {
    const id = `work:${randomUUID()}`;
    const piSessionId = randomUUID();
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`INSERT INTO yp_work_conversations
        (conversation_id, pi_session_id, workspace_id, working_directory, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, piSessionId, workspaceId, workingDirectory, now, now);
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
    return { id, createdAt: now, updatedAt: now, workingDirectory, current: true, archived: false };
  }

  select(workspaceId: string, id: string): WorkConversation {
    const row = this.row(workspaceId, id);
    if (!row) throw new Error('Unknown Work conversation.');
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO yp_runtime_metadata(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(this.currentKey(workspaceId), id, now);
    return this.toConversation(row, id);
  }

  row(workspaceId: string, id: string): WorkRow | undefined {
    return this.database.prepare(`SELECT conversation_id, pi_session_id, working_directory, created_at, updated_at
      FROM yp_work_conversations WHERE workspace_id = ? AND conversation_id = ?`)
      .get(workspaceId, id) as WorkRow | undefined;
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
    const rows = this.database.prepare(`SELECT conversation_id, pi_session_id, working_directory, created_at, updated_at
      FROM yp_work_conversations WHERE workspace_id = ? ORDER BY updated_at DESC`)
      .all(workspaceId) as unknown as WorkRow[];
    const conversations = rows.map((row) => this.toConversation(row, currentId));
    const legacy = this.database.prepare(`SELECT created_at, updated_at FROM yp_conversation_bindings
      WHERE entry_point = 'desktop' AND authority_id = 'local-desktop' AND subject_id = 'local-user'
        AND namespace = 'desktop' AND conversation_id = 'default' AND workspace_id = ?`)
      .get(workspaceId) as { created_at: string; updated_at: string } | undefined;
    if (legacy) conversations.push({ id: 'default', createdAt: legacy.created_at, workingDirectory: workspaceId,
      updatedAt: legacy.updated_at, current: false, archived: true });
    return conversations;
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

  /** The host resolves the opaque reference; a Worker never sees a local absolute path. */
  resolveContentRef(contentRef: string): WorkTurnSource | undefined {
    const row = this.database.prepare('SELECT * FROM yp_work_turn_sources WHERE content_ref = ?')
      .get(contentRef) as unknown as SourceRow | undefined;
    return row ? this.sourceFromRow(row) : undefined;
  }
}
