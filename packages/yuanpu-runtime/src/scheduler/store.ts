import type {
  AgentDeliveryRecord,
  AgentDeliveryStatus,
  AgentRunOutput,
  AgentRunRequest,
  ScheduleHistoryRecord,
  ScheduleRecord,
  ScheduleTriggerStatus,
} from '@yuanpu-agent/protocol';
import type { DatabaseSync } from 'node:sqlite';

interface ScheduleRow {
  schedule_id: string;
  revision: number;
  name: string;
  prompt: string;
  workspace_id: string;
  timing_json: string;
  time_zone: string;
  enabled: number;
  misfire_policy: ScheduleRecord['misfirePolicy'];
  maximum_lateness_ms: number;
  allow_overlap: number;
  conversation_id: string;
  delivery_json: string;
  next_trigger_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TriggerRow {
  trigger_key: string;
  schedule_id: string;
  schedule_revision: number;
  scheduled_at: string;
  request_json: string;
  status: ScheduleTriggerStatus;
  run_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface DeliveryRow {
  delivery_id: string;
  run_id: string;
  idempotency_key: string;
  target_json: string;
  status: AgentDeliveryStatus;
  attempts: number;
  last_error: string | null;
  updated_at: string;
}

export interface PersistedScheduleTrigger {
  triggerKey: string;
  scheduleId: string;
  scheduleRevision: number;
  scheduledAt: string;
  request: AgentRunRequest;
  status: ScheduleTriggerStatus;
  runId?: string;
}

function rowToSchedule(row: ScheduleRow): ScheduleRecord {
  return {
    scheduleId: row.schedule_id,
    revision: row.revision,
    name: row.name,
    prompt: row.prompt,
    workspaceId: row.workspace_id,
    timing: JSON.parse(row.timing_json) as ScheduleRecord['timing'],
    timeZone: row.time_zone,
    enabled: row.enabled === 1,
    misfirePolicy: row.misfire_policy,
    maximumLatenessMs: row.maximum_lateness_ms,
    allowOverlap: row.allow_overlap === 1,
    conversationId: row.conversation_id,
    delivery: JSON.parse(row.delivery_json) as ScheduleRecord['delivery'],
    ...(row.next_trigger_at ? { nextTriggerAt: row.next_trigger_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTrigger(row: TriggerRow): PersistedScheduleTrigger {
  return {
    triggerKey: row.trigger_key,
    scheduleId: row.schedule_id,
    scheduleRevision: row.schedule_revision,
    scheduledAt: row.scheduled_at,
    request: JSON.parse(row.request_json) as AgentRunRequest,
    status: row.status,
    ...(row.run_id ? { runId: row.run_id } : {}),
  };
}

function redactedRequest(request: AgentRunRequest): AgentRunRequest {
  return {
    ...request,
    input: { type: 'text', text: '[prompt retained only in active schedule]' },
  };
}

function rowToDelivery(row: DeliveryRow): AgentDeliveryRecord & { lastError?: string } {
  return {
    deliveryId: row.delivery_id,
    runId: row.run_id,
    idempotencyKey: row.idempotency_key,
    target: JSON.parse(row.target_json) as AgentDeliveryRecord['target'],
    status: row.status,
    attempts: row.attempts,
    updatedAt: row.updated_at,
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

export class SchedulerStore {
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

  create(schedule: ScheduleRecord): ScheduleRecord {
    this.database.prepare(`
      INSERT INTO yp_schedules(
        schedule_id, revision, name, prompt, workspace_id, timing_json, time_zone,
        enabled, misfire_policy, maximum_lateness_ms, allow_overlap,
        conversation_id, delivery_json, next_trigger_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      schedule.scheduleId,
      schedule.revision,
      schedule.name,
      schedule.prompt,
      schedule.workspaceId,
      JSON.stringify(schedule.timing),
      schedule.timeZone,
      Number(schedule.enabled),
      schedule.misfirePolicy,
      schedule.maximumLatenessMs,
      Number(schedule.allowOverlap),
      schedule.conversationId,
      JSON.stringify(schedule.delivery),
      schedule.nextTriggerAt ?? null,
      schedule.createdAt,
      schedule.updatedAt,
    );
    return this.get(schedule.scheduleId)!;
  }

  update(schedule: ScheduleRecord, expectedRevision: number): ScheduleRecord {
    const result = this.database.prepare(`
      UPDATE yp_schedules SET
        revision = ?, name = ?, prompt = ?, workspace_id = ?, timing_json = ?,
        time_zone = ?, enabled = ?, misfire_policy = ?, maximum_lateness_ms = ?,
        allow_overlap = ?, conversation_id = ?, delivery_json = ?,
        next_trigger_at = ?, updated_at = ?
      WHERE schedule_id = ? AND revision = ?
    `).run(
      schedule.revision,
      schedule.name,
      schedule.prompt,
      schedule.workspaceId,
      JSON.stringify(schedule.timing),
      schedule.timeZone,
      Number(schedule.enabled),
      schedule.misfirePolicy,
      schedule.maximumLatenessMs,
      Number(schedule.allowOverlap),
      schedule.conversationId,
      JSON.stringify(schedule.delivery),
      schedule.nextTriggerAt ?? null,
      schedule.updatedAt,
      schedule.scheduleId,
      expectedRevision,
    );
    if (result.changes !== 1) throw new Error('Schedule changed while it was being updated.');
    return this.get(schedule.scheduleId)!;
  }

  get(scheduleId: string): ScheduleRecord | undefined {
    const row = this.database.prepare(
      'SELECT * FROM yp_schedules WHERE schedule_id = ?',
    ).get(scheduleId) as ScheduleRow | undefined;
    return row ? rowToSchedule(row) : undefined;
  }

  list(): ScheduleRecord[] {
    return (this.database.prepare(
      'SELECT * FROM yp_schedules ORDER BY created_at, schedule_id',
    ).all() as unknown as ScheduleRow[]).map(rowToSchedule);
  }

  listDue(now: string): ScheduleRecord[] {
    return (this.database.prepare(`
      SELECT * FROM yp_schedules
      WHERE enabled = 1 AND next_trigger_at IS NOT NULL AND next_trigger_at <= ?
      ORDER BY next_trigger_at, schedule_id
    `).all(now) as unknown as ScheduleRow[]).map(rowToSchedule);
  }

  reserveTrigger(input: {
    schedule: ScheduleRecord;
    scheduledAt: string;
    nextTriggerAt?: string;
    request: AgentRunRequest;
    now: string;
    skipMisfire?: boolean;
  }): PersistedScheduleTrigger | undefined {
    return this.#transaction(() => {
      const current = this.database.prepare(
        'SELECT revision FROM yp_schedules WHERE schedule_id = ?',
      ).get(input.schedule.scheduleId) as { revision: number } | undefined;
      if (!current || current.revision !== input.schedule.revision) return undefined;

      const triggerKey = [
        input.schedule.scheduleId,
        input.schedule.revision,
        input.scheduledAt,
      ].join(':');
      const existing = this.database.prepare(
        'SELECT * FROM yp_schedule_triggers WHERE trigger_key = ?',
      ).get(triggerKey) as TriggerRow | undefined;
      if (existing) return rowToTrigger(existing);

      const overlap = !input.skipMisfire && !input.schedule.allowOverlap && Boolean(this.database.prepare(`
        SELECT 1 FROM yp_schedule_triggers t
        LEFT JOIN yp_agent_runs r ON r.run_id = t.run_id
        WHERE t.schedule_id = ? AND (
          t.status = 'pending_submission'
          OR (t.status = 'submitted' AND r.status IN ('queued', 'running', 'waiting_approval'))
        )
        LIMIT 1
      `).get(input.schedule.scheduleId));
      const status: ScheduleTriggerStatus = input.skipMisfire
        ? 'skipped_misfire'
        : overlap
          ? 'skipped_overlap'
          : 'pending_submission';
      this.database.prepare(`
        INSERT INTO yp_schedule_triggers(
          trigger_key, schedule_id, schedule_revision, scheduled_at,
          request_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        triggerKey,
        input.schedule.scheduleId,
        input.schedule.revision,
        input.scheduledAt,
        JSON.stringify(status === 'pending_submission' ? input.request : redactedRequest(input.request)),
        status,
        input.now,
        input.now,
      );
      this.database.prepare(`
        UPDATE yp_schedules SET next_trigger_at = ?,
          enabled = CASE WHEN ? IS NULL THEN 0 ELSE enabled END,
          updated_at = ?
        WHERE schedule_id = ? AND revision = ?
      `).run(
        input.nextTriggerAt ?? null,
        input.nextTriggerAt ?? null,
        input.now,
        input.schedule.scheduleId,
        input.schedule.revision,
      );
      return rowToTrigger(this.database.prepare(
        'SELECT * FROM yp_schedule_triggers WHERE trigger_key = ?',
      ).get(triggerKey) as unknown as TriggerRow);
    });
  }

  listPendingSubmissions(): PersistedScheduleTrigger[] {
    return (this.database.prepare(`
      SELECT * FROM yp_schedule_triggers
      WHERE status = 'pending_submission'
      ORDER BY created_at, trigger_key
    `).all() as unknown as TriggerRow[]).map(rowToTrigger);
  }

  attachRun(triggerKey: string, runId: string, now: string): void {
    this.#transaction(() => {
      const row = this.database.prepare(
        'SELECT request_json FROM yp_schedule_triggers WHERE trigger_key = ? AND status = ?',
      ).get(triggerKey, 'pending_submission') as { request_json: string } | undefined;
      if (!row) return;
      const request = JSON.parse(row.request_json) as AgentRunRequest;
      this.database.prepare(`
        UPDATE yp_schedule_triggers
        SET status = 'submitted', run_id = ?, request_json = ?,
          last_error = NULL, updated_at = ?
        WHERE trigger_key = ? AND status = 'pending_submission'
      `).run(runId, JSON.stringify(redactedRequest(request)), now, triggerKey);
    });
  }

  failSubmission(triggerKey: string, error: string, now: string): void {
    this.#transaction(() => {
      const row = this.database.prepare(
        'SELECT request_json FROM yp_schedule_triggers WHERE trigger_key = ? AND status = ?',
      ).get(triggerKey, 'pending_submission') as { request_json: string } | undefined;
      if (!row) return;
      const request = JSON.parse(row.request_json) as AgentRunRequest;
      this.database.prepare(`
        UPDATE yp_schedule_triggers
        SET status = 'submission_failed', request_json = ?, last_error = ?, updated_at = ?
        WHERE trigger_key = ? AND status = 'pending_submission'
      `).run(JSON.stringify(redactedRequest(request)), error, now, triggerKey);
    });
  }

  markOutputUnknown(triggerKey: string, now: string): void {
    this.database.prepare(`
      UPDATE yp_schedule_triggers SET status = 'output_unknown', updated_at = ?
      WHERE trigger_key = ? AND status = 'submitted'
    `).run(now, triggerKey);
  }

  listSubmitted(): PersistedScheduleTrigger[] {
    return (this.database.prepare(`
      SELECT * FROM yp_schedule_triggers
      WHERE status = 'submitted' AND run_id IS NOT NULL
      ORDER BY created_at, trigger_key
    `).all() as unknown as TriggerRow[]).map(rowToTrigger);
  }

  recoverDeliveries(now: string): void {
    this.database.prepare(`
      UPDATE yp_delivery_attempts SET status = 'result_unknown', updated_at = ?
      WHERE status = 'delivering'
        AND run_id IN (SELECT run_id FROM yp_schedule_triggers)
    `).run(now);
  }

  prepareDelivery(input: {
    trigger: PersistedScheduleTrigger;
    now: string;
  }): AgentDeliveryRecord & { lastError?: string } {
    if (!input.trigger.runId) throw new Error('Cannot deliver a trigger without an Agent run.');
    const deliveryId = `delivery:${input.trigger.triggerKey}`;
    const target = input.trigger.request.delivery;
    const initialStatus: AgentDeliveryStatus = target.kind === 'channel' ? 'pending' : 'delivered';
    this.database.prepare(`
      INSERT INTO yp_delivery_attempts(
        delivery_id, run_id, idempotency_key, target_json, status,
        attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(delivery_id) DO NOTHING
    `).run(
      deliveryId,
      input.trigger.runId,
      `schedule-delivery:${input.trigger.triggerKey}`,
      JSON.stringify(target),
      initialStatus,
      input.now,
      input.now,
    );
    return this.getDelivery(deliveryId)!;
  }

  getDelivery(deliveryId: string): (AgentDeliveryRecord & { lastError?: string }) | undefined {
    const row = this.database.prepare(
      'SELECT * FROM yp_delivery_attempts WHERE delivery_id = ?',
    ).get(deliveryId) as DeliveryRow | undefined;
    return row ? rowToDelivery(row) : undefined;
  }

  listDeliveriesForRetry(): Array<AgentDeliveryRecord & { lastError?: string }> {
    return (this.database.prepare(`
      SELECT d.* FROM yp_delivery_attempts d
      JOIN yp_schedule_triggers t ON t.run_id = d.run_id
      WHERE d.status IN ('pending', 'failed', 'result_unknown')
      ORDER BY d.created_at, d.delivery_id
    `).all() as unknown as DeliveryRow[]).map(rowToDelivery);
  }

  claimDelivery(deliveryId: string, now: string): (AgentDeliveryRecord & { lastError?: string }) | undefined {
    return this.#transaction(() => {
      const result = this.database.prepare(`
        UPDATE yp_delivery_attempts
        SET status = 'delivering', attempts = attempts + 1, last_error = NULL, updated_at = ?
        WHERE delivery_id = ? AND status IN ('pending', 'failed', 'result_unknown')
      `).run(now, deliveryId);
      return result.changes === 1 ? this.getDelivery(deliveryId) : undefined;
    });
  }

  finishDelivery(deliveryId: string, status: 'delivered' | 'failed', now: string, error?: string): void {
    this.database.prepare(`
      UPDATE yp_delivery_attempts SET status = ?, last_error = ?, updated_at = ?
      WHERE delivery_id = ? AND status = 'delivering'
    `).run(status, error ?? null, now, deliveryId);
  }

  markDeliveryUnknown(deliveryId: string, now: string): void {
    this.database.prepare(`
      UPDATE yp_delivery_attempts
      SET status = 'result_unknown', last_error = NULL, updated_at = ?
      WHERE delivery_id = ? AND status = 'delivering'
    `).run(now, deliveryId);
  }

  history(scheduleId: string, limit: number): ScheduleHistoryRecord[] {
    const rows = this.database.prepare(`
      SELECT
        t.*,
        r.status AS run_status,
        r.failure_code,
        r.failure_message,
        r.failure_retryable,
        o.output_json,
        d.status AS delivery_status,
        d.attempts AS delivery_attempts,
        d.last_error AS delivery_error
      FROM yp_schedule_triggers t
      LEFT JOIN yp_agent_runs r ON r.run_id = t.run_id
      LEFT JOIN yp_agent_run_outputs o ON o.run_id = t.run_id
      LEFT JOIN yp_delivery_attempts d ON d.run_id = t.run_id
      WHERE t.schedule_id = ?
      ORDER BY t.scheduled_at DESC, t.trigger_key DESC
      LIMIT ?
    `).all(scheduleId, limit) as unknown as Array<TriggerRow & {
      run_status: ScheduleHistoryRecord['runStatus'] | null;
      failure_code: string | null;
      failure_message: string | null;
      failure_retryable: number | null;
      output_json: string | null;
      delivery_status: AgentDeliveryStatus | null;
      delivery_attempts: number | null;
      delivery_error: string | null;
    }>;
    return rows.map((row) => ({
      triggerKey: row.trigger_key,
      scheduleId: row.schedule_id,
      scheduleRevision: row.schedule_revision,
      scheduledAt: row.scheduled_at,
      triggerStatus: row.status,
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.run_status ? { runStatus: row.run_status } : {}),
      ...(row.output_json ? { output: JSON.parse(row.output_json) as AgentRunOutput } : {}),
      ...(row.failure_code ? {
        runFailure: {
          code: row.failure_code,
          message: row.failure_message ?? row.failure_code,
          retryable: row.failure_retryable === 1,
        },
      } : {}),
      ...(row.delivery_status ? { deliveryStatus: row.delivery_status } : {}),
      ...(row.delivery_attempts !== null ? { deliveryAttempts: row.delivery_attempts } : {}),
      ...(row.delivery_error ? { deliveryError: row.delivery_error } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}
