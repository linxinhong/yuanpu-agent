import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface AssistantLink {
  contactId: string;
  connectionId: string;
  targetId: string;
  piSessionId: string;
}

export interface AssistantMirror {
  mirrorId: string;
  runId: string;
  part: 'user' | 'assistant';
  targetId: string;
  content?: string;
  status: 'pending' | 'delivering' | 'accepted' | 'failed' | 'unknown';
  failureCode?: string;
}

interface LinkRow {
  contact_id: string;
  connection_id: string;
  target_id: string;
  previous_pi_session_id: string;
  linked_pi_session_id: string;
}

interface MirrorRow {
  mirror_id: string;
  run_id: string;
  part: AssistantMirror['part'];
  target_id: string;
  content: string | null;
  status: AssistantMirror['status'];
  failure_code: string | null;
}

function mirrorFromRow(row: MirrorRow): AssistantMirror {
  return {
    mirrorId: row.mirror_id,
    runId: row.run_id,
    part: row.part,
    targetId: row.target_id,
    ...(row.content === null ? {} : { content: row.content }),
    status: row.status,
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
  };
}

export class AssistantLinkStore {
  constructor(private readonly database: DatabaseSync) {}

  #row(): LinkRow | undefined {
    return this.database.prepare('SELECT * FROM yp_desktop_assistant_link WHERE id = 1').get() as unknown as LinkRow | undefined;
  }

  current(): AssistantLink | undefined {
    const row = this.#row();
    if (!row) return undefined;
    const authorized = this.database.prepare(`
      SELECT 1 FROM yp_channel_private_contacts c
      JOIN yp_channel_pairings p ON p.provider = c.provider
        AND p.connection_id = c.connection_id AND p.sender_digest = c.sender_digest
      WHERE c.contact_id = ? AND c.connection_id = ? AND c.bound_target_id = ?
        AND c.recipient_id IS NOT NULL
    `).get(row.contact_id, row.connection_id, row.target_id);
    if (!authorized) throw new Error('助理绑定已失效。请先解除绑定，再选择已配对联系人。');
    return {
      contactId: row.contact_id,
      connectionId: row.connection_id,
      targetId: row.target_id,
      piSessionId: row.linked_pi_session_id,
    };
  }

  #busy(piSessionIds: readonly string[]): boolean {
    return piSessionIds.some((id) => Boolean(this.database.prepare(`
      SELECT 1 FROM yp_agent_runs r
      JOIN yp_conversation_bindings b ON b.binding_id = r.binding_id
      WHERE b.pi_session_id = ? AND r.status IN ('queued', 'running', 'waiting_approval') LIMIT 1
    `).get(id)));
  }

  bind(contactId: string, workspaceId: string): AssistantLink {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const contact = this.database.prepare(`
        SELECT c.connection_id, c.bound_target_id, c.recipient_id, i.conversation_digest
        FROM yp_channel_private_contacts c
        JOIN yp_channel_pairings p ON p.provider = c.provider
          AND p.connection_id = c.connection_id AND p.sender_digest = c.sender_digest
        JOIN yp_channel_inbound i ON i.provider = c.provider
          AND i.connection_id = c.connection_id AND i.sender_digest = c.sender_digest
          AND i.conversation_type = 'single' AND i.run_id IS NOT NULL
        WHERE c.contact_id = ? AND c.provider = 'wecom'
        ORDER BY i.received_at DESC LIMIT 1
      `).get(contactId) as {
        connection_id: string;
        bound_target_id: string | null;
        recipient_id: string | null;
        conversation_digest: string;
      } | undefined;
      if (!contact?.recipient_id) throw new Error('请选择已有私聊记录的已配对企业微信联系人。');
      const channel = this.database.prepare(`
        SELECT pi_session_id, workspace_id FROM yp_conversation_bindings
        WHERE entry_point = 'im' AND authority_id = ? AND subject_id = ?
          AND conversation_id = ?
      `).get(contact.connection_id, contact.conversation_digest, `single:${contact.conversation_digest}`) as {
        pi_session_id: string; workspace_id: string;
      } | undefined;
      if (!channel || channel.workspace_id !== workspaceId) throw new Error('联系人会话与当前工作区不一致。');
      const existing = this.#row();
      const desktop = this.database.prepare(`
        SELECT pi_session_id FROM yp_conversation_bindings
        WHERE entry_point = 'desktop' AND authority_id = 'local-desktop'
          AND subject_id = 'local-user' AND namespace = 'desktop' AND conversation_id = 'assistant'
      `).get() as { pi_session_id: string } | undefined;
      const previous = existing?.previous_pi_session_id ?? desktop?.pi_session_id ?? randomUUID();
      if (this.#busy([previous, channel.pi_session_id, ...(existing ? [existing.linked_pi_session_id] : [])])) {
        throw new Error('相关会话正在运行；请等待任务完成后再切换绑定。');
      }
      const targetId = contact.bound_target_id ?? `imtarget:${randomUUID()}`;
      if (!contact.bound_target_id) this.database.prepare(`
        UPDATE yp_channel_private_contacts SET bound_target_id = ? WHERE contact_id = ?
      `).run(targetId, contactId);
      if (!desktop) this.database.prepare(`
        INSERT INTO yp_conversation_bindings(
          binding_id, entry_point, authority_id, subject_id, namespace,
          conversation_id, thread_id, pi_session_id, workspace_id, created_at, updated_at
        ) VALUES (?, 'desktop', 'local-desktop', 'local-user', 'desktop', 'assistant', '', ?, ?, ?, ?)
      `).run(randomUUID(), previous, workspaceId, new Date().toISOString(), new Date().toISOString());
      this.database.prepare(`
        UPDATE yp_conversation_bindings SET pi_session_id = ?, updated_at = ?
        WHERE entry_point = 'desktop' AND authority_id = 'local-desktop'
          AND subject_id = 'local-user' AND namespace = 'desktop' AND conversation_id = 'assistant'
      `).run(channel.pi_session_id, new Date().toISOString());
      this.database.prepare(`
        INSERT INTO yp_desktop_assistant_link(id, contact_id, connection_id, target_id,
          previous_pi_session_id, linked_pi_session_id, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET contact_id = excluded.contact_id,
          connection_id = excluded.connection_id, target_id = excluded.target_id,
          linked_pi_session_id = excluded.linked_pi_session_id, updated_at = excluded.updated_at
      `).run(contactId, contact.connection_id, targetId, previous, channel.pi_session_id, new Date().toISOString());
      this.database.exec('COMMIT');
      return { contactId, connectionId: contact.connection_id, targetId, piSessionId: channel.pi_session_id };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  unbind(): void {
    const row = this.#row();
    if (!row) return;
    if (this.#busy([row.linked_pi_session_id])) throw new Error('助理会话正在运行；请等待任务完成后解除绑定。');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        UPDATE yp_conversation_bindings SET pi_session_id = ?, updated_at = ?
        WHERE entry_point = 'desktop' AND authority_id = 'local-desktop'
          AND subject_id = 'local-user' AND namespace = 'desktop' AND conversation_id = 'assistant'
      `).run(row.previous_pi_session_id, new Date().toISOString());
      this.database.prepare('DELETE FROM yp_desktop_assistant_link WHERE id = 1').run();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  sessionId(conversationId: 'default' | 'assistant'): string | undefined {
    const row = this.database.prepare(`
      SELECT pi_session_id FROM yp_conversation_bindings
      WHERE entry_point = 'desktop' AND authority_id = 'local-desktop'
        AND subject_id = 'local-user' AND namespace = 'desktop' AND conversation_id = ?
    `).get(conversationId) as { pi_session_id: string } | undefined;
    return row?.pi_session_id;
  }

  archivedAssistantSessionId(): string | undefined {
    return this.#row()?.previous_pi_session_id;
  }

  queueMirror(runId: string, part: AssistantMirror['part'], targetId: string, content: string): AssistantMirror {
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT OR IGNORE INTO yp_assistant_mirror(
        mirror_id, run_id, part, target_id, content, content_digest, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(randomUUID(), runId, part, targetId, content,
      createHash('sha256').update(content).digest('hex'), now, now);
    return this.mirror(runId, part)!;
  }

  mirror(runId: string, part: AssistantMirror['part']): AssistantMirror | undefined {
    const row = this.database.prepare('SELECT * FROM yp_assistant_mirror WHERE run_id = ? AND part = ?')
      .get(runId, part) as unknown as MirrorRow | undefined;
    return row ? mirrorFromRow(row) : undefined;
  }

  mirrorById(mirrorId: string): AssistantMirror | undefined {
    const row = this.database.prepare('SELECT * FROM yp_assistant_mirror WHERE mirror_id = ?')
      .get(mirrorId) as unknown as MirrorRow | undefined;
    return row ? mirrorFromRow(row) : undefined;
  }

  pendingMirrors(): AssistantMirror[] {
    const rows = this.database.prepare(`
      SELECT m.* FROM yp_assistant_mirror m WHERE m.status = 'pending'
      ORDER BY (SELECT MIN(first.created_at) FROM yp_assistant_mirror first WHERE first.run_id = m.run_id),
        CASE m.part WHEN 'user' THEN 0 ELSE 1 END
    `).all() as unknown as MirrorRow[];
    return rows.map(mirrorFromRow);
  }

  claimMirror(mirrorId: string): boolean {
    return this.database.prepare(`
      UPDATE yp_assistant_mirror SET status = 'delivering', updated_at = ?
      WHERE mirror_id = ? AND status = 'pending'
    `).run(new Date().toISOString(), mirrorId).changes === 1;
  }

  finishMirror(mirrorId: string, status: 'accepted' | 'failed' | 'unknown', failureCode?: string): void {
    this.database.prepare(`
      UPDATE yp_assistant_mirror SET status = ?, failure_code = ?,
        content = CASE WHEN ? = 'accepted' THEN NULL ELSE content END, updated_at = ?
      WHERE mirror_id = ? AND status = 'delivering'
    `).run(status, failureCode ?? null, status, new Date().toISOString(), mirrorId);
  }

  retryMirror(mirrorId: string): boolean {
    return this.database.prepare(`
      UPDATE yp_assistant_mirror SET status = 'pending', failure_code = NULL, updated_at = ?
      WHERE mirror_id = ? AND status = 'failed' AND content IS NOT NULL
    `).run(new Date().toISOString(), mirrorId).changes === 1;
  }

  markInterruptedMirrorsUnknown(): void {
    this.database.prepare(`
      UPDATE yp_assistant_mirror SET status = 'unknown', failure_code = 'process_interrupted', updated_at = ?
      WHERE status = 'delivering'
    `).run(new Date().toISOString());
  }
}
