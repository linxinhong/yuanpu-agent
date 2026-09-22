import type { AgentRunStatus } from './agent.js';

export const HOST_EVENT_CONTRACT_VERSION = 1;

interface HostEventBase<TType extends string, TPayload> {
  contractVersion: typeof HOST_EVENT_CONTRACT_VERSION;
  eventId: string;
  /** Monotonic within one Runtime process. Consumers deduplicate by eventId across reconnects. */
  sequence: number;
  occurredAt: string;
  type: TType;
  payload: TPayload;
}

export type RunStateChangedHostEvent = HostEventBase<'run_state_changed', {
  runId: string;
  previousStatus: AgentRunStatus;
  status: AgentRunStatus;
  conversationId: string;
}>;

export type NotificationRequestedHostEvent = HostEventBase<'notification_requested', {
  requestId: string;
  title: string;
  body: string;
  kind: 'run_succeeded' | 'run_failed' | 'approval_required' | 'reminder';
  conversationId?: string;
  runId?: string;
}>;

export type HostEvent = RunStateChangedHostEvent | NotificationRequestedHostEvent;

export interface HostEventReceipt {
  eventId: string;
  status: 'accepted' | 'duplicate' | 'unsupported' | 'rejected';
  message?: string;
}

export interface NotificationReceipt {
  requestId: string;
  status: 'submitted' | 'suppressed' | 'unavailable' | 'failed';
  /** OS submission is not evidence that a person saw or read the notification. */
  userVisibility: 'unknown';
  message?: string;
}

