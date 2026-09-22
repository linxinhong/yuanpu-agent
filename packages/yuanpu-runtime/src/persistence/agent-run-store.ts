import type {
  AgentApprovalBinding,
  AgentRunOutput,
  AgentRunRecord,
  AgentRunRequest,
  AgentRunStatus,
} from '@yuanpu-agent/protocol';
import type { DatabaseSync } from 'node:sqlite';

export interface PersistedQueuedAgentRun {
  run: AgentRunRecord;
  input: string;
  piSessionId: string;
}

export type PersistedSubmissionResult =
  | { kind: 'created'; run: AgentRunRecord }
  | { kind: 'duplicate'; run: AgentRunRecord }
  | { kind: 'idempotency_conflict' }
  | { kind: 'queue_full' }
  | { kind: 'binding_not_found' }
  | { kind: 'binding_context_conflict' }
  | { kind: 'workspace_conflict' };

interface ConversationBindingRow {
  binding_id: string;
  pi_session_id: string;
  workspace_id: string;
  namespace: string;
  conversation_id: string;
  thread_id: string;
}

interface AgentRunRow {
  run_id: string;
  entry_point: AgentRunRecord['owner']['entryPoint'];
  authority_id: string;
  subject_id: string;
  request_fingerprint: string;
  input_digest: string;
  request_metadata_json: string;
  status: AgentRunStatus;
  external_effect_state: AgentRunRecord['externalEffectState'];
  approval_request_id: string | null;
  approval_session_id: string | null;
  approval_workspace_id: string | null;
  approval_expires_at: string | null;
  output_digest: string | null;
  failure_code: string | null;
  failure_message: string | null;
  failure_retryable: number | null;
  created_at: string;
  updated_at: string;
}

interface StoredRunMetadata {
  identity: AgentRunRecord['owner']['identity'];
  workspaceId: string;
  conversation: AgentRunRecord['context']['conversation'];
  delivery: AgentRunRecord['context']['delivery'];
}

function rowToRun(row: AgentRunRow): AgentRunRecord {
  const metadata = JSON.parse(row.request_metadata_json) as StoredRunMetadata;
  const pendingApproval = row.approval_request_id
    && row.approval_session_id
    && row.approval_workspace_id
    && row.approval_expires_at
    ? {
        runId: row.run_id,
        approvalRequestId: row.approval_request_id,
        sessionId: row.approval_session_id,
        workspaceId: row.approval_workspace_id,
        expiresAt: row.approval_expires_at,
      }
    : undefined;
  return {
    runId: row.run_id,
    owner: { entryPoint: row.entry_point, identity: metadata.identity },
    context: {
      workspaceId: metadata.workspaceId,
      conversation: metadata.conversation,
      delivery: metadata.delivery,
    },
    requestFingerprint: row.request_fingerprint,
    inputDigest: row.input_digest,
    status: row.status,
    externalEffectState: row.external_effect_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(pendingApproval ? { pendingApproval } : {}),
    ...(row.output_digest ? { outputDigest: row.output_digest } : {}),
    ...(row.failure_code ? {
      failure: {
        code: row.failure_code,
        message: row.failure_message ?? row.failure_code,
        retryable: row.failure_retryable === 1,
      },
    } : {}),
  };
}

function recoverStatus(
  status: AgentRunStatus,
  externalEffectState: AgentRunRecord['externalEffectState'],
): AgentRunStatus {
  if (status !== 'running' && status !== 'waiting_approval') return status;
  return externalEffectState === 'possible' ? 'result_unknown' : 'interrupted';
}

export class AgentRunStore {
  constructor(private readonly database: DatabaseSync) {}

  #transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  get(runId: string): AgentRunRecord | undefined {
    const row = this.database.prepare(
      'SELECT * FROM yp_agent_runs WHERE run_id = ?',
    ).get(runId) as AgentRunRow | undefined;
    if (!row) return undefined;
    const run = rowToRun(row);
    const output = this.database.prepare(
      'SELECT output_json FROM yp_agent_run_outputs WHERE run_id = ?',
    ).get(runId) as { output_json: string } | undefined;
    return output ? { ...run, output: JSON.parse(output.output_json) as AgentRunOutput } : run;
  }

  submit(input: {
    request: AgentRunRequest;
    requestFingerprint: string;
    inputDigest: string;
    runId: string;
    bindingId: string;
    piSessionId: string;
    now: string;
    maximumQueuedRuns: number;
  }): PersistedSubmissionResult {
    return this.#transaction(() => {
      const { request } = input;
      const existing = this.database.prepare(`
        SELECT * FROM yp_agent_runs
        WHERE entry_point = ? AND authority_id = ? AND subject_id = ? AND idempotency_key = ?
      `).get(
        request.entryPoint,
        request.identity.authorityId,
        request.identity.subjectId,
        request.idempotencyKey,
      ) as AgentRunRow | undefined;
      if (existing) {
        if (existing.request_fingerprint !== input.requestFingerprint) {
          return { kind: 'idempotency_conflict' };
        }
        return { kind: 'duplicate', run: rowToRun(existing) };
      }

      const queued = this.database.prepare(
        "SELECT COUNT(*) AS count FROM yp_agent_runs WHERE status = 'queued'",
      ).get() as { count: number };
      if (queued.count >= input.maximumQueuedRuns) return { kind: 'queue_full' };

      const conversation = request.conversation;
      let binding = conversation.sessionBindingId
        ? this.database.prepare(`
            SELECT binding_id, pi_session_id, workspace_id, namespace, conversation_id, thread_id
            FROM yp_conversation_bindings
            WHERE binding_id = ? AND entry_point = ? AND authority_id = ? AND subject_id = ?
          `).get(
            conversation.sessionBindingId,
            request.entryPoint,
            request.identity.authorityId,
            request.identity.subjectId,
          ) as ConversationBindingRow | undefined
        : this.database.prepare(`
            SELECT binding_id, pi_session_id, workspace_id, namespace, conversation_id, thread_id
            FROM yp_conversation_bindings
            WHERE entry_point = ? AND authority_id = ? AND subject_id = ?
              AND namespace = ? AND conversation_id = ? AND thread_id = ?
          `).get(
            request.entryPoint,
            request.identity.authorityId,
            request.identity.subjectId,
            conversation.namespace,
            conversation.conversationId,
            conversation.threadId ?? '',
          ) as ConversationBindingRow | undefined;

      if (conversation.sessionBindingId && !binding) return { kind: 'binding_not_found' };
      if (
        conversation.sessionBindingId
        && binding
        && (
          binding.namespace !== conversation.namespace
          || binding.conversation_id !== conversation.conversationId
          || binding.thread_id !== (conversation.threadId ?? '')
        )
      ) {
        return { kind: 'binding_context_conflict' };
      }
      if (binding && binding.workspace_id !== request.workspaceId) return { kind: 'workspace_conflict' };
      if (!binding) {
        this.database.prepare(`
          INSERT INTO yp_conversation_bindings(
            binding_id, entry_point, authority_id, subject_id, namespace,
            conversation_id, thread_id, pi_session_id, workspace_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.bindingId,
          request.entryPoint,
          request.identity.authorityId,
          request.identity.subjectId,
          conversation.namespace,
          conversation.conversationId,
          conversation.threadId ?? '',
          input.piSessionId,
          request.workspaceId,
          input.now,
          input.now,
        );
        binding = {
          binding_id: input.bindingId,
          pi_session_id: input.piSessionId,
          workspace_id: request.workspaceId,
          namespace: conversation.namespace,
          conversation_id: conversation.conversationId,
          thread_id: conversation.threadId ?? '',
        };
      }

      const resolvedConversation = {
        ...conversation,
        sessionBindingId: binding.binding_id,
      };
      const metadata: StoredRunMetadata = {
        identity: request.identity,
        workspaceId: request.workspaceId,
        conversation: resolvedConversation,
        delivery: request.delivery,
      };
      this.database.prepare(`
        INSERT INTO yp_agent_runs(
          run_id, entry_point, authority_id, subject_id, idempotency_key,
          request_fingerprint, input_digest, request_metadata_json, binding_id,
          status, external_effect_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'none', ?, ?)
      `).run(
        input.runId,
        request.entryPoint,
        request.identity.authorityId,
        request.identity.subjectId,
        request.idempotencyKey,
        input.requestFingerprint,
        input.inputDigest,
        JSON.stringify(metadata),
        binding.binding_id,
        input.now,
        input.now,
      );
      this.database.prepare(`
        INSERT INTO yp_agent_run_queue_payloads(run_id, input_text, created_at)
        VALUES (?, ?, ?)
      `).run(input.runId, request.input.text, input.now);
      return { kind: 'created', run: this.get(input.runId)! };
    });
  }

  listQueued(): PersistedQueuedAgentRun[] {
    const rows = this.database.prepare(`
      SELECT r.*, p.input_text, b.pi_session_id
      FROM yp_agent_runs r
      JOIN yp_agent_run_queue_payloads p ON p.run_id = r.run_id
      JOIN yp_conversation_bindings b ON b.binding_id = r.binding_id
      WHERE r.status = 'queued'
      ORDER BY r.created_at, r.rowid
    `).all() as unknown as Array<AgentRunRow & { input_text: string; pi_session_id: string }>;
    return rows.map((row) => ({
      run: rowToRun(row),
      input: row.input_text,
      piSessionId: row.pi_session_id,
    }));
  }

  claimQueued(runId: string, now: string): PersistedQueuedAgentRun | undefined {
    return this.#transaction(() => {
      const row = this.database.prepare(`
        SELECT r.*, p.input_text, b.pi_session_id
        FROM yp_agent_runs r
        JOIN yp_agent_run_queue_payloads p ON p.run_id = r.run_id
        JOIN yp_conversation_bindings b ON b.binding_id = r.binding_id
        WHERE r.run_id = ? AND r.status = 'queued'
      `).get(runId) as (AgentRunRow & { input_text: string; pi_session_id: string }) | undefined;
      if (!row) return undefined;
      this.database.prepare(`
        UPDATE yp_agent_runs
        SET status = 'running', external_effect_state = 'possible', updated_at = ?
        WHERE run_id = ? AND status = 'queued'
      `).run(now, runId);
      this.database.prepare(
        'DELETE FROM yp_agent_run_queue_payloads WHERE run_id = ?',
      ).run(runId);
      return {
        run: this.get(runId)!,
        input: row.input_text,
        piSessionId: row.pi_session_id,
      };
    });
  }

  cancelQueued(runId: string, now: string): AgentRunRecord | undefined {
    return this.#transaction(() => {
      const result = this.database.prepare(`
        UPDATE yp_agent_runs SET status = 'cancelled', updated_at = ?
        WHERE run_id = ? AND status = 'queued'
      `).run(now, runId);
      if (result.changes === 0) return undefined;
      this.database.prepare(
        'DELETE FROM yp_agent_run_queue_payloads WHERE run_id = ?',
      ).run(runId);
      return this.get(runId);
    });
  }

  markWaitingApproval(binding: AgentApprovalBinding, now: string): AgentRunRecord {
    const result = this.database.prepare(`
      UPDATE yp_agent_runs
      SET status = 'waiting_approval', approval_request_id = ?, approval_session_id = ?,
        approval_workspace_id = ?, approval_expires_at = ?, updated_at = ?
      WHERE run_id = ? AND status = 'running'
    `).run(
      binding.approvalRequestId,
      binding.sessionId,
      binding.workspaceId,
      binding.expiresAt,
      now,
      binding.runId,
    );
    if (result.changes !== 1) throw new Error(`Run ${binding.runId} cannot wait for approval.`);
    return this.get(binding.runId)!;
  }

  resumeAfterApproval(runId: string, approvalRequestId: string, now: string): AgentRunRecord {
    const result = this.database.prepare(`
      UPDATE yp_agent_runs SET status = 'running', updated_at = ?
      WHERE run_id = ? AND status = 'waiting_approval' AND approval_request_id = ?
    `).run(now, runId, approvalRequestId);
    if (result.changes !== 1) throw new Error('Approval does not belong to a waiting Agent run.');
    return this.get(runId)!;
  }

  finish(input: {
    runId: string;
    status: Extract<AgentRunStatus, 'succeeded' | 'failed' | 'cancelled'>;
    now: string;
    outputDigest?: string;
    output?: AgentRunOutput;
    failure?: AgentRunRecord['failure'];
  }): AgentRunRecord {
    return this.#transaction(() => {
      const result = this.database.prepare(`
        UPDATE yp_agent_runs
        SET status = ?, output_digest = ?, failure_code = ?, failure_message = ?,
          failure_retryable = ?, approval_request_id = NULL, approval_session_id = NULL,
          approval_workspace_id = NULL, approval_expires_at = NULL, updated_at = ?
        WHERE run_id = ? AND status IN ('running', 'waiting_approval')
      `).run(
        input.status,
        input.outputDigest ?? null,
        input.failure?.code ?? null,
        input.failure?.message ?? null,
        input.failure ? Number(input.failure.retryable) : null,
        input.now,
        input.runId,
      );
      if (result.changes !== 1) {
        throw new Error(`Run ${input.runId} cannot finish from its current state.`);
      }
      const owner = this.database.prepare(
        'SELECT entry_point FROM yp_agent_runs WHERE run_id = ?',
      ).get(input.runId) as { entry_point: string };
      if (owner.entry_point === 'scheduler' && input.output) {
        this.database.prepare(`
          INSERT INTO yp_agent_run_outputs(run_id, output_json, created_at)
          VALUES (?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET output_json = excluded.output_json
        `).run(input.runId, JSON.stringify(input.output), input.now);
      }
      return this.get(input.runId)!;
    });
  }

  interrupt(runId: string, now: string): AgentRunRecord {
    const run = this.get(runId);
    if (!run || (run.status !== 'running' && run.status !== 'waiting_approval')) {
      throw new Error(`Run ${runId} cannot be interrupted from its current state.`);
    }
    const status = recoverStatus(run.status, run.externalEffectState);
    const result = this.database.prepare(`
      UPDATE yp_agent_runs
      SET status = ?, failure_code = ?, failure_message = ?, failure_retryable = 0,
        approval_request_id = NULL, approval_session_id = NULL,
        approval_workspace_id = NULL, approval_expires_at = NULL, updated_at = ?
      WHERE run_id = ? AND status IN ('running', 'waiting_approval')
    `).run(
      status,
      status === 'result_unknown' ? 'service_shutdown_result_unknown' : 'service_shutdown_interrupted',
      status === 'result_unknown'
        ? 'Runtime stopped after execution began; external effects may have completed.'
        : 'Runtime stopped before execution began and the run may be retried.',
      now,
      runId,
    );
    if (result.changes !== 1) throw new Error(`Run ${runId} cannot be interrupted from its current state.`);
    return this.get(runId)!;
  }

  recoverAfterRestart(now: string): AgentRunRecord[] {
    return this.#transaction(() => {
      const active = this.database.prepare(`
        SELECT * FROM yp_agent_runs WHERE status IN ('running', 'waiting_approval')
      `).all() as unknown as AgentRunRow[];
      const update = this.database.prepare(`
        UPDATE yp_agent_runs
        SET status = ?, approval_request_id = NULL, approval_session_id = NULL,
          approval_workspace_id = NULL, approval_expires_at = NULL, updated_at = ?
        WHERE run_id = ?
      `);
      for (const row of active) {
        update.run(recoverStatus(row.status, row.external_effect_state), now, row.run_id);
      }
      this.database.prepare(`
        UPDATE yp_delivery_attempts SET status = 'result_unknown', updated_at = ?
        WHERE status = 'delivering'
      `).run(now);
      return active.map((row) => this.get(row.run_id)!);
    });
  }
}
