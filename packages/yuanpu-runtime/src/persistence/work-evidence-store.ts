import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AssistantSourceChange } from '@yuanpu-agent/protocol';
import type { SavedWorkToolResult } from '../pi/index.js';

export interface WorkEvidenceSource {
  eventId: number;
  sourceId: string;
  contentRef: string;
  sourceVersion: string;
  kind: 'tool_result' | 'artifact';
  conversationId: string;
  piSessionId: string;
  runId?: string;
  entryId: string;
  toolName: string;
  resultStatus: 'completed' | 'failed';
  text?: string;
  relativePath?: string;
  fileSha256?: string;
  fileSize?: number;
  committedAt: string;
}

interface EvidenceRow {
  event_id: number; source_id: string; content_ref: string; source_version: string;
  kind: WorkEvidenceSource['kind']; conversation_id: string; pi_session_id: string;
  run_id: string | null; entry_id: string; tool_name: string;
  result_status: WorkEvidenceSource['resultStatus']; text_content: string | null;
  relative_path: string | null; file_sha256: string | null; file_size: number | null;
  committed_at: string; audience_id: string;
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function fromRow(row: EvidenceRow): WorkEvidenceSource {
  return { eventId: row.event_id, sourceId: row.source_id, contentRef: row.content_ref,
    sourceVersion: row.source_version, kind: row.kind, conversationId: row.conversation_id,
    piSessionId: row.pi_session_id, ...(row.run_id ? { runId: row.run_id } : {}),
    entryId: row.entry_id, toolName: row.tool_name, resultStatus: row.result_status,
    ...(row.text_content !== null ? { text: row.text_content } : {}),
    ...(row.relative_path !== null ? { relativePath: row.relative_path } : {}),
    ...(row.file_sha256 !== null ? { fileSha256: row.file_sha256 } : {}),
    ...(row.file_size !== null ? { fileSize: row.file_size } : {}),
    committedAt: row.committed_at };
}

function change(source: WorkEvidenceSource): AssistantSourceChange {
  return { sourceId: source.sourceId, sourceVersion: source.sourceVersion,
    kind: 'created', audience: { kind: 'personal', id: 'local-user' },
    occurredAt: source.committedAt, contentRef: source.contentRef,
    workId: source.conversationId };
}

/** Host-owned, immutable evidence ledger; Worker receives only opaque references. */
export class WorkEvidenceStore {
  constructor(private readonly database: DatabaseSync) {}

  private runByEntry(conversationId: string, piSessionId: string): Map<string, string> {
    const rows = this.database.prepare(`SELECT r.run_id, o.output_json FROM yp_agent_runs r
      JOIN yp_conversation_bindings b ON b.binding_id=r.binding_id
      JOIN yp_agent_run_outputs o ON o.run_id=r.run_id
      WHERE r.entry_point='desktop' AND r.status='succeeded'
        AND b.conversation_id=? AND b.pi_session_id=?`)
      .all(conversationId, piSessionId) as Array<{ run_id: string; output_json: string }>;
    const runs = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (const row of rows) {
      const output = JSON.parse(row.output_json) as { toolResults?: unknown };
      if (!Array.isArray(output.toolResults)) continue;
      for (const item of output.toolResults) {
        if (!item || typeof item !== 'object' || typeof item.entryId !== 'string') continue;
        if (runs.has(item.entryId) && runs.get(item.entryId) !== row.run_id) ambiguous.add(item.entryId);
        else runs.set(item.entryId, row.run_id);
      }
    }
    for (const entryId of ambiguous) runs.delete(entryId);
    return runs;
  }

  recordToolResults(conversationId: string, piSessionId: string,
    results: readonly SavedWorkToolResult[]): number {
    const binding = this.database.prepare(`SELECT 1 FROM yp_conversation_bindings b
      JOIN yp_work_conversations w ON w.conversation_id=b.conversation_id
      WHERE b.conversation_id=? AND b.pi_session_id=? AND b.entry_point='desktop'
        AND b.subject_id='local-user' LIMIT 1`)
      .get(conversationId, piSessionId);
    if (!binding) throw new Error('Work evidence is not bound to a local conversation.');
    const runs = this.runByEntry(conversationId, piSessionId);
    let inserted = 0;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const result of results) {
        if (!result.entryId || !result.toolCallId || !result.name || !result.text) continue;
        const sourceId = `work-tool:${piSessionId}:${result.entryId}`;
        const runId = runs.get(result.entryId) ?? null;
        const version = hash(JSON.stringify([result.name, result.status, result.text,
          result.truncated, runId]));
        const contentRef = `work-evidence:${hash(sourceId)}`;
        const existing = this.database.prepare(`SELECT run_id FROM yp_work_evidence_sources
          WHERE source_id=?`).get(sourceId) as { run_id: string | null } | undefined;
        if (existing && existing.run_id === null && runId) {
          // Reinsert with a new event ID: a scanner may have seen the saved Pi entry
          // before the successful run and its output descriptor committed.
          this.database.prepare('DELETE FROM yp_work_evidence_sources WHERE source_id=?').run(sourceId);
        }
        const added = this.database.prepare(`INSERT OR IGNORE INTO yp_work_evidence_sources
          (source_id,content_ref,source_version,kind,conversation_id,pi_session_id,run_id,
           entry_id,tool_name,result_status,text_content,committed_at,audience_id)
          VALUES (?,?,?,'tool_result',?,?,?,?,?,?,?,?,'local-user')`)
          .run(sourceId, contentRef, version, conversationId, piSessionId,
            runId, result.entryId, result.name, result.status,
            result.text, result.at);
        inserted += Number(added.changes);
      }
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    return inserted;
  }

  /** Only the host-verified descriptors durably settled with a successful Work run count. */
  recordArtifacts(conversationId: string, piSessionId: string): number {
    const rows = this.database.prepare(`SELECT r.run_id,r.updated_at,o.output_json
      FROM yp_agent_runs r JOIN yp_conversation_bindings b ON b.binding_id=r.binding_id
      JOIN yp_agent_run_outputs o ON o.run_id=r.run_id
      WHERE r.entry_point='desktop' AND r.status='succeeded' AND b.conversation_id=?
        AND b.pi_session_id=? ORDER BY r.created_at,r.rowid`)
      .all(conversationId, piSessionId) as Array<{ run_id: string; updated_at: string; output_json: string }>;
    let inserted = 0;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const output = JSON.parse(row.output_json) as { artifacts?: unknown; toolResults?: unknown };
        if (!Array.isArray(output.artifacts) || !Array.isArray(output.toolResults)) continue;
        for (const item of output.artifacts) {
          if (!item || typeof item !== 'object' || typeof item.entryId !== 'string'
            || typeof item.relativePath !== 'string' || typeof item.sha256 !== 'string'
            || typeof item.size !== 'number' || !Number.isSafeInteger(item.size)
            || item.size < 0 || item.size > 256 * 1024 || !/^[a-f0-9]{64}$/u.test(item.sha256)
            || !item.relativePath || item.relativePath.includes('\0')) continue;
          const result = output.toolResults.find((candidate: unknown) => candidate && typeof candidate === 'object'
            && 'entryId' in candidate && candidate.entryId === item.entryId
            && 'status' in candidate && candidate.status === 'completed'
            && 'name' in candidate && (candidate.name === 'write' || candidate.name === 'edit')) as
            { name: string } | undefined;
          if (!result) continue;
          const sourceId = `work-artifact:${piSessionId}:${item.entryId}`;
          const version = hash(JSON.stringify([row.run_id, item.entryId, item.relativePath,
            item.sha256, item.size]));
          const contentRef = `work-evidence:${hash(sourceId)}`;
          const existing = this.database.prepare(`SELECT source_version FROM yp_work_evidence_sources
            WHERE source_id=?`).get(sourceId) as { source_version: string } | undefined;
          if (existing?.source_version.startsWith('unavailable:')) {
            // Promote a historical placeholder only after the host has a descriptor.
            // A new event ID ensures consumers with an older cursor see the revision.
            this.database.prepare('DELETE FROM yp_work_evidence_sources WHERE source_id=?').run(sourceId);
          }
          const added = this.database.prepare(`INSERT OR IGNORE INTO yp_work_evidence_sources
            (source_id,content_ref,source_version,kind,conversation_id,pi_session_id,run_id,
             entry_id,tool_name,result_status,relative_path,file_sha256,file_size,committed_at,audience_id)
            VALUES (?,?,?,'artifact',?,?,?,?,?,'completed',?,?,?,?,'local-user')`)
            .run(sourceId, contentRef, version, conversationId, piSessionId, row.run_id,
              item.entryId, result.name, item.relativePath, item.sha256, item.size, row.updated_at);
          inserted += Number(added.changes);
        }
      }
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    return inserted;
  }

  /** Historical file tools without a verified descriptor remain visible as unavailable, never guessed. */
  recordUnverifiedArtifacts(conversationId: string, piSessionId: string,
    results: readonly SavedWorkToolResult[]): number {
    const workspace = this.database.prepare(`SELECT 1 FROM yp_work_conversations w
      JOIN yp_conversation_bindings b ON b.conversation_id=w.conversation_id
      WHERE w.conversation_id=? AND b.pi_session_id=? AND b.entry_point='desktop'
        AND b.subject_id='local-user' LIMIT 1`).get(conversationId, piSessionId);
    if (!workspace) throw new Error('Work artifact is not bound to a local conversation.');
    let inserted = 0;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const result of results) {
        if (result.status !== 'completed' || (result.name !== 'write' && result.name !== 'edit')) continue;
        const sourceId = `work-artifact:${piSessionId}:${result.entryId}`;
        const added = this.database.prepare(`INSERT OR IGNORE INTO yp_work_evidence_sources
          (source_id,content_ref,source_version,kind,conversation_id,pi_session_id,entry_id,
           tool_name,result_status,committed_at,audience_id)
          VALUES (?,?,?,'artifact',?,?,?,?,'completed',?,'local-user')`)
          .run(sourceId, `work-evidence:${hash(sourceId)}`,
            `unavailable:${hash(JSON.stringify([piSessionId, result.entryId]))}`,
            conversationId, piSessionId, result.entryId, result.name, result.at);
        inserted += Number(added.changes);
      }
      this.database.exec('COMMIT');
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    return inserted;
  }

  sourcePage(afterEventId: number, limit: number): Array<{ eventId: number; change: AssistantSourceChange }> {
    if (!Number.isSafeInteger(afterEventId) || afterEventId < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid evidence page.');
    const rows = this.database.prepare(`SELECT * FROM yp_work_evidence_sources
      WHERE event_id>? ORDER BY event_id LIMIT ?`).all(afterEventId, limit) as unknown as EvidenceRow[];
    return rows.map((row) => {
      const source = fromRow(row);
      return { eventId: source.eventId, change: change(source) };
    });
  }

  sourceById(sourceId: string): WorkEvidenceSource | undefined {
    const row = this.database.prepare('SELECT * FROM yp_work_evidence_sources WHERE source_id=?')
      .get(sourceId) as EvidenceRow | undefined;
    return row && fromRow(row);
  }

  resolveContentRef(contentRef: string): WorkEvidenceSource | undefined {
    const row = this.database.prepare('SELECT * FROM yp_work_evidence_sources WHERE content_ref=?')
      .get(contentRef) as EvidenceRow | undefined;
    return row && fromRow(row);
  }

  /** Recheck the local owner and run every time the host resolves a reference. */
  workspaceForSource(source: WorkEvidenceSource): string | undefined {
    const row = this.database.prepare(`SELECT w.working_directory FROM yp_work_conversations w
      JOIN yp_conversation_bindings b ON b.conversation_id=w.conversation_id
      WHERE w.conversation_id=? AND b.pi_session_id=? AND b.entry_point='desktop'
        AND b.subject_id='local-user' AND b.authority_id='local-desktop' LIMIT 1`)
      .get(source.conversationId, source.piSessionId) as { working_directory: string } | undefined;
    if (!row) return undefined;
    if (source.runId) {
      const run = this.database.prepare(`SELECT 1 FROM yp_agent_runs r
        JOIN yp_conversation_bindings b ON b.binding_id=r.binding_id
        WHERE r.run_id=? AND r.entry_point='desktop' AND r.status='succeeded'
          AND r.subject_id='local-user' AND r.authority_id='local-desktop'
          AND b.conversation_id=? AND b.pi_session_id=? LIMIT 1`)
        .get(source.runId, source.conversationId, source.piSessionId);
      if (!run) return undefined;
    }
    return row.working_directory;
  }
}
