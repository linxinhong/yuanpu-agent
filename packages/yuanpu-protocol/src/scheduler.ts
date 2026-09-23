import type {
  AgentDeliveryStatus,
  AgentDeliveryTarget,
  AgentRunOutput,
  AgentRunStatus,
} from './agent.js';

export const SCHEDULE_CONTRACT_VERSION = 1;

export type ScheduleTiming =
  | { kind: 'once'; at: string }
  | { kind: 'cron'; expression: string };

export type ScheduleMisfirePolicy = 'coalesce' | 'skip';

export interface ScheduleInput {
  contractVersion: typeof SCHEDULE_CONTRACT_VERSION;
  name: string;
  prompt: string;
  workspaceId: string;
  timing: ScheduleTiming;
  /** IANA time zone used by cron schedules and for presenting one-time schedules. */
  timeZone: string;
  enabled?: boolean;
  misfirePolicy?: ScheduleMisfirePolicy;
  maximumLatenessMs?: number;
  allowOverlap?: boolean;
  conversationId?: string;
  delivery: AgentDeliveryTarget;
}

export interface ScheduleRecord {
  scheduleId: string;
  revision: number;
  name: string;
  prompt: string;
  workspaceId: string;
  timing: ScheduleTiming;
  timeZone: string;
  enabled: boolean;
  misfirePolicy: ScheduleMisfirePolicy;
  maximumLatenessMs: number;
  allowOverlap: boolean;
  conversationId: string;
  delivery: AgentDeliveryTarget;
  nextTriggerAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ScheduleTriggerStatus =
  | 'pending_submission'
  | 'submitted'
  | 'submission_failed'
  | 'skipped_misfire'
  | 'skipped_overlap'
  | 'output_unknown';

export interface ScheduleHistoryRecord {
  triggerKey: string;
  scheduleId: string;
  scheduleRevision: number;
  scheduledAt: string;
  triggerStatus: ScheduleTriggerStatus;
  runId?: string;
  runStatus?: AgentRunStatus;
  output?: AgentRunOutput;
  runFailure?: { code: string; message: string; retryable: boolean };
  deliveryStatus?: AgentDeliveryStatus;
  deliveryAttempts?: number;
  deliveryError?: string;
  notificationStatus?: 'pending' | 'submitted' | 'suppressed' | 'unavailable' | 'failed' | 'result_unknown';
  createdAt: string;
  updatedAt: string;
}

/** An observed private contact; never exposes its provider user ID. */
export interface SchedulePrivateContact {
  contactId: string;
  connectionId: string;
  lastSeenAt: string;
  boundRouteId?: string;
}
