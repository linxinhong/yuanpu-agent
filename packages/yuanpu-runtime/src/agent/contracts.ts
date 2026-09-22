import { createHash } from 'node:crypto';

import {
  AGENT_CONTRACT_VERSION,
  type AgentContractErrorCode,
  type AgentContractRejection,
  type AgentDeliveryStatus,
  type AgentEntryPoint,
  type AgentHostIdentity,
  type AgentRunCancellationReceipt,
  type AgentRunRecord,
  type AgentRunRequest,
  type AgentRunStatus,
  type AgentRunSubmissionResult,
} from '@yuanpu-agent/protocol';

export interface AgentService {
  submit(input: unknown): Promise<AgentRunSubmissionResult>;
  get(runId: string): Promise<AgentRunRecord | undefined>;
  cancel(runId: string): Promise<AgentRunCancellationReceipt>;
  subscribe(runId: string): AsyncIterable<AgentRunRecord>;
}

export type AgentRunEvent =
  | 'start'
  | 'await_approval'
  | 'approval_granted'
  | 'succeed'
  | 'fail'
  | 'cancel_observed'
  | 'interrupt'
  | 'mark_result_unknown';

export type AgentDeliveryEvent = 'start' | 'confirm' | 'fail' | 'mark_result_unknown';

export interface AgentRequestValidationSuccess {
  ok: true;
  value: AgentRunRequest;
}

export interface AgentRequestValidationFailure {
  ok: false;
  error: AgentContractRejection;
}

export type AgentRequestValidation = AgentRequestValidationSuccess | AgentRequestValidationFailure;

export interface ExistingIdempotentRun {
  runId: string;
  status: AgentRunStatus;
  requestFingerprint: string;
}

export type IdempotencyResolution =
  | { kind: 'new'; request: AgentRunRequest; requestFingerprint: string }
  | { kind: 'replay'; result: AgentRunSubmissionResult }
  | { kind: 'rejected'; result: AgentContractRejection };

const terminalStatuses = new Set<AgentRunStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'result_unknown',
]);

const transitions: Record<AgentRunStatus, Partial<Record<AgentRunEvent, AgentRunStatus>>> = {
  queued: {
    start: 'running',
    cancel_observed: 'cancelled',
    interrupt: 'interrupted',
  },
  running: {
    await_approval: 'waiting_approval',
    succeed: 'succeeded',
    fail: 'failed',
    cancel_observed: 'cancelled',
    interrupt: 'interrupted',
    mark_result_unknown: 'result_unknown',
  },
  waiting_approval: {
    approval_granted: 'running',
    fail: 'failed',
    cancel_observed: 'cancelled',
    interrupt: 'interrupted',
    mark_result_unknown: 'result_unknown',
  },
  succeeded: {},
  failed: {},
  cancelled: {},
  interrupted: {},
  result_unknown: {},
};

const deliveryTransitions: Record<
  AgentDeliveryStatus,
  Partial<Record<AgentDeliveryEvent, AgentDeliveryStatus>>
> = {
  pending: { start: 'delivering', fail: 'failed' },
  delivering: { confirm: 'delivered', fail: 'failed', mark_result_unknown: 'result_unknown' },
  delivered: {},
  failed: { start: 'delivering' },
  result_unknown: {},
};

function rejection(
  code: AgentContractErrorCode,
  message: string,
  field?: string,
): AgentContractRejection {
  return { accepted: false, code, message, ...(field ? { field } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  maximumLength = 512,
): string | AgentContractRejection {
  if (typeof value !== 'string' || !value.trim() || value.length > maximumLength) {
    return rejection('invalid_request', `${field} must be a non-empty string of at most ${maximumLength} characters.`, field);
  }
  return value.trim();
}

function isRejection(value: string | AgentContractRejection): value is AgentContractRejection {
  return typeof value !== 'string';
}

function readEntryPoint(value: unknown): AgentEntryPoint | AgentContractRejection {
  if (value === 'desktop' || value === 'im' || value === 'scheduler') return value;
  return rejection('invalid_request', 'entryPoint must be desktop, im, or scheduler.', 'entryPoint');
}

function readIdentity(
  value: unknown,
  entryPoint: AgentEntryPoint,
): AgentHostIdentity | AgentContractRejection {
  if (!isRecord(value)) return rejection('invalid_request', 'identity is required.', 'identity');
  const subjectId = requiredString(value.subjectId, 'identity.subjectId', 256);
  if (isRejection(subjectId)) return subjectId;
  const authorityId = requiredString(value.authorityId, 'identity.authorityId', 256);
  if (isRejection(authorityId)) return authorityId;

  const expected = {
    desktop: { kind: 'local_user', authenticatedBy: 'electron' },
    im: { kind: 'channel_user', authenticatedBy: 'channel_adapter' },
    scheduler: { kind: 'scheduler', authenticatedBy: 'scheduler' },
  } as const;
  const rule = expected[entryPoint];
  if (value.kind !== rule.kind || value.authenticatedBy !== rule.authenticatedBy) {
    return rejection(
      'identity_mismatch',
      `identity kind/authenticator does not match the ${entryPoint} entry point.`,
      'identity',
    );
  }
  return { kind: rule.kind, subjectId, authorityId, authenticatedBy: rule.authenticatedBy };
}

export function validateAgentRunRequest(input: unknown): AgentRequestValidation {
  if (!isRecord(input)) {
    return { ok: false, error: rejection('invalid_request', 'Agent run request must be an object.') };
  }
  if (input.contractVersion !== AGENT_CONTRACT_VERSION) {
    return {
      ok: false,
      error: rejection(
        'unsupported_contract_version',
        `Agent contract version ${String(input.contractVersion)} is not supported.`,
        'contractVersion',
      ),
    };
  }
  const entryPoint = readEntryPoint(input.entryPoint);
  if (typeof entryPoint !== 'string') return { ok: false, error: entryPoint };
  const identity = readIdentity(input.identity, entryPoint);
  if ('accepted' in identity) return { ok: false, error: identity };
  const workspaceId = requiredString(input.workspaceId, 'workspaceId');
  if (isRejection(workspaceId)) return { ok: false, error: workspaceId };
  const idempotencyKey = requiredString(input.idempotencyKey, 'idempotencyKey', 200);
  if (isRejection(idempotencyKey)) return { ok: false, error: idempotencyKey };

  if (!isRecord(input.conversation)) {
    return { ok: false, error: rejection('invalid_request', 'conversation is required.', 'conversation') };
  }
  const namespace = requiredString(input.conversation.namespace, 'conversation.namespace', 256);
  if (isRejection(namespace)) return { ok: false, error: namespace };
  const conversationId = requiredString(input.conversation.conversationId, 'conversation.conversationId');
  if (isRejection(conversationId)) return { ok: false, error: conversationId };
  const threadId = input.conversation.threadId === undefined
    ? undefined
    : requiredString(input.conversation.threadId, 'conversation.threadId');
  if (threadId && isRejection(threadId)) return { ok: false, error: threadId };
  const sessionBindingId = input.conversation.sessionBindingId === undefined
    ? undefined
    : requiredString(input.conversation.sessionBindingId, 'conversation.sessionBindingId');
  if (sessionBindingId && isRejection(sessionBindingId)) return { ok: false, error: sessionBindingId };

  if (!isRecord(input.input) || input.input.type !== 'text') {
    return { ok: false, error: rejection('invalid_request', 'input must be a text model input.', 'input') };
  }
  const text = requiredString(input.input.text, 'input.text', 64 * 1024);
  if (isRejection(text)) return { ok: false, error: text };

  if (!isRecord(input.delivery)) {
    return { ok: false, error: rejection('invalid_request', 'delivery is required.', 'delivery') };
  }
  if (input.delivery.kind !== 'desktop' && input.delivery.kind !== 'channel' && input.delivery.kind !== 'none') {
    return { ok: false, error: rejection('invalid_request', 'delivery.kind is invalid.', 'delivery.kind') };
  }
  const routeId = input.delivery.routeId === undefined
    ? undefined
    : requiredString(input.delivery.routeId, 'delivery.routeId');
  if (routeId && isRejection(routeId)) return { ok: false, error: routeId };
  if (input.delivery.kind === 'channel' && !routeId) {
    return { ok: false, error: rejection('invalid_request', 'Channel delivery requires routeId.', 'delivery.routeId') };
  }

  return {
    ok: true,
    value: {
      contractVersion: AGENT_CONTRACT_VERSION,
      entryPoint,
      identity,
      workspaceId,
      conversation: {
        namespace,
        conversationId,
        ...(typeof threadId === 'string' ? { threadId } : {}),
        ...(typeof sessionBindingId === 'string' ? { sessionBindingId } : {}),
      },
      input: { type: 'text', text },
      idempotencyKey,
      delivery: {
        kind: input.delivery.kind,
        ...(typeof routeId === 'string' ? { routeId } : {}),
      },
    },
  };
}

export function fingerprintAgentRunRequest(request: AgentRunRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

export function resolveIdempotentSubmission(
  input: unknown,
  existing?: ExistingIdempotentRun,
): IdempotencyResolution {
  const validation = validateAgentRunRequest(input);
  if (!validation.ok) return { kind: 'rejected', result: validation.error };
  const requestFingerprint = fingerprintAgentRunRequest(validation.value);
  if (!existing) return { kind: 'new', request: validation.value, requestFingerprint };
  if (existing.requestFingerprint !== requestFingerprint) {
    return {
      kind: 'rejected',
      result: rejection(
        'idempotency_conflict',
        'The idempotency key was already used for a different request.',
        'idempotencyKey',
      ),
    };
  }
  return {
    kind: 'replay',
    result: { accepted: true, runId: existing.runId, status: existing.status, duplicate: true },
  };
}

export function transitionAgentRun(status: AgentRunStatus, event: AgentRunEvent): AgentRunStatus {
  const next = transitions[status][event];
  if (!next) throw new Error(`Invalid Agent run transition: ${status} + ${event}.`);
  return next;
}

export function cancellationForRun(
  runId: string,
  status: AgentRunStatus | undefined,
): AgentRunCancellationReceipt {
  if (!status) return { runId, result: 'not_found' };
  if (terminalStatuses.has(status)) return { runId, result: 'already_terminal', status };
  if (status === 'queued') return { runId, result: 'cancelled', status: 'cancelled' };
  return { runId, result: 'cancellation_requested', status };
}

export function recoverAgentRunAfterRestart(
  status: AgentRunStatus,
  externalEffectsMayHaveOccurred: boolean,
): AgentRunStatus {
  if (status === 'queued' || terminalStatuses.has(status)) return status;
  return externalEffectsMayHaveOccurred ? 'result_unknown' : 'interrupted';
}

export function transitionDelivery(
  status: AgentDeliveryStatus,
  event: AgentDeliveryEvent,
): AgentDeliveryStatus {
  const next = deliveryTransitions[status][event];
  if (!next) throw new Error(`Invalid delivery transition: ${status} + ${event}.`);
  return next;
}

export function recoverDeliveryAfterRestart(status: AgentDeliveryStatus): AgentDeliveryStatus {
  return status === 'delivering' ? 'result_unknown' : status;
}

