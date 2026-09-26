/** Independent from the existing desktop HTTP protocol. Bump on incompatible assistant IPC changes. */
export const ASSISTANT_CONTRACT_VERSION = 1;

export type AssistantChannel = 'desktop' | 'wecom';

export interface AssistantAudience {
  kind: 'personal' | 'conversation' | 'organization';
  /** Stable host-issued scope ID; a display name is never an authority. */
  id: string;
}

/** The host creates this only after local authentication or an explicit channel pairing. */
export interface AssistantPrincipal {
  principalId: string;
  assistantId: string;
  pairingId: string;
  channel: AssistantChannel;
  accountId: string;
  organizationId?: string;
  externalUserId: string;
}

/** Opaque to the Worker: only the host owns credentials and actual delivery. */
export interface AssistantReplyTarget {
  routeId: string;
  channel: AssistantChannel;
  accountId: string;
  organizationId?: string;
  externalConversationId: string;
  threadId?: string;
}

export interface AssistantInboundMessage {
  channel: AssistantChannel;
  accountId: string;
  organizationId?: string;
  externalUserId: string;
  externalConversationId: string;
  threadId?: string;
  externalMessageId: string;
  receivedAt: string;
  text: string;
  attachments?: Array<{ sourceRef: string; name?: string; mediaType?: string }>;
}

/** Persist the inbound dedup key and request before dispatching to the Worker. */
export interface AssistantRequest {
  contractVersion: typeof ASSISTANT_CONTRACT_VERSION;
  requestId: string;
  assistantId: string;
  principalId: string;
  conversationId: string;
  sessionId: string;
  audience: AssistantAudience;
  inbound: AssistantInboundMessage;
  replyTarget: AssistantReplyTarget;
  acceptedAt: string;
  deadlineAt?: string;
}

/** Host-persisted binding. A channel payload cannot select a different Session or audience. */
export interface AssistantConversationBinding {
  assistantId: string;
  principalId: string;
  conversationId: string;
  sessionId: string;
  audience: AssistantAudience;
  replyTarget: AssistantReplyTarget;
}

export type AssistantRequestStatus = 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AssistantRequestRecord {
  requestId: string;
  status: AssistantRequestStatus;
  sessionId: string;
  runId?: string;
  replyId?: string;
  errorCode?: string;
  updatedAt: string;
}

/** Worker owns assistant Sessions, memory and reviews; host owns the source and its authorization. */
export interface AssistantSourceChange {
  sourceId: string;
  sourceVersion: string;
  kind: 'created' | 'updated' | 'deleted';
  audience: AssistantAudience;
  occurredAt: string;
  contentRef?: string;
  workId?: string;
}

export interface AssistantEvidenceRef {
  sourceId: string;
  sourceVersion: string;
  locator?: string;
  observedAt: string;
}

export type AssistantReviewJudgment = 'supported' | 'partial' | 'failed' | 'unverified';

/** Reviews assess work content and artifacts, never the assistant's own model score. */
export interface AssistantWorkReview {
  reviewId: string;
  workId: string;
  reviewVersion: number;
  audience: AssistantAudience;
  goal: string;
  constraints: string[];
  judgment: AssistantReviewJudgment;
  findings: Array<{ claim: string; judgment: AssistantReviewJudgment; evidence: AssistantEvidenceRef[] }>;
  unresolved: string[];
  followUp: string[];
  committedLedgerRevisionIds: string[];
  committedMemoryRevisionIds: string[];
  createdAt: string;
}

export interface AssistantMemoryRevision {
  revisionId: string;
  memoryId: string;
  expectedVersion: number;
  version: number;
  operation: 'create' | 'correct' | 'forget';
  audience: AssistantAudience;
  evidence: AssistantEvidenceRef[];
  /** A forget revision removes derived summaries and review references as well. */
  supersedesRevisionId?: string;
  committedAt: string;
}

export type AssistantDelegationStatus = 'requested' | 'accepted' | 'running' | 'waiting_approval'
  | 'completed' | 'failed' | 'cancelled' | 'unknown';

/** This is a logical task, not a local path or a borrowed Work session. */
export interface AssistantDelegationBrief {
  taskId: string;
  assistantSessionId: string;
  skillName: string;
  goal: string;
  completionCriteria: string[];
  contextRefs: string[];
  authorizedCapabilities: string[];
  readOnly: boolean;
  deadlineAt: string;
}

export interface AssistantDelegationResult {
  status: 'completed' | 'failed' | 'waiting_approval' | 'unknown';
  summary?: string;
  /** Opaque host-owned result reference; never an executor filesystem path. */
  resultRef?: string;
  evidenceRefs?: string[];
  approvalRequestId?: string;
  errorCode?: string;
}

export interface AssistantDelegationRecord extends AssistantDelegationBrief {
  status: Exclude<AssistantDelegationStatus, 'requested'>;
  followUps: string[];
  result?: AssistantDelegationResult;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantDelegationBase {
  taskId: string;
  requestId: string;
  audience: AssistantAudience;
  instructions: string;
  /** Explicit, bounded references; never an implicit copy of private memory or a Work session. */
  contextRefs: string[];
  readOnly: boolean;
  deadlineAt?: string;
  updatedAt: string;
}

/** A completed task must identify an artifact; failure and cancellation stay explicit terminal states. */
export type AssistantDelegation = AssistantDelegationBase & (
  | { status: 'requested' | 'accepted' | 'running' | 'waiting_approval' | 'unknown'; resultRef?: never; errorCode?: never }
  | { status: 'completed'; resultRef: string; errorCode?: never }
  | { status: 'failed'; resultRef?: never; errorCode: string }
  | { status: 'cancelled'; resultRef?: never; errorCode?: string }
);

export type AssistantDeliveryStatus = 'pending' | 'delivering' | 'accepted' | 'failed' | 'unknown';

export interface AssistantReply {
  replyId: string;
  requestId: string;
  target: AssistantReplyTarget;
  text: string;
  status: AssistantDeliveryStatus;
  platformMessageId?: string;
  updatedAt: string;
}

export type AssistantIngressResult =
  | { ok: true; dedupKey: string }
  | { ok: false; code: 'unsupported_contract_version' | 'identity_mismatch' | 'route_mismatch' | 'invalid_request' };

/** Run at the trusted host boundary. Message text and sender names never establish identity. */
export function validateAssistantIngress(
  request: AssistantRequest,
  principal: AssistantPrincipal,
  binding: AssistantConversationBinding,
): AssistantIngressResult {
  if (request.contractVersion !== ASSISTANT_CONTRACT_VERSION) return { ok: false, code: 'unsupported_contract_version' };
  if (request.assistantId !== principal.assistantId || request.principalId !== principal.principalId ||
      request.inbound.channel !== principal.channel || request.inbound.accountId !== principal.accountId ||
      request.inbound.organizationId !== principal.organizationId ||
      request.inbound.externalUserId !== principal.externalUserId) {
    return { ok: false, code: 'identity_mismatch' };
  }
  const target = request.replyTarget;
  if (target.channel !== request.inbound.channel || target.accountId !== request.inbound.accountId ||
      target.organizationId !== request.inbound.organizationId ||
      target.externalConversationId !== request.inbound.externalConversationId ||
      target.threadId !== request.inbound.threadId) {
    return { ok: false, code: 'route_mismatch' };
  }
  if (binding.assistantId !== request.assistantId || binding.principalId !== request.principalId ||
      binding.conversationId !== request.conversationId || binding.sessionId !== request.sessionId ||
      (request.audience.kind === 'personal' && request.audience.id !== principal.principalId) ||
      !sameAssistantAudience(request.audience, binding.audience) ||
      target.routeId !== binding.replyTarget.routeId || target.channel !== binding.replyTarget.channel ||
      target.accountId !== binding.replyTarget.accountId ||
      target.organizationId !== binding.replyTarget.organizationId ||
      target.externalConversationId !== binding.replyTarget.externalConversationId ||
      target.threadId !== binding.replyTarget.threadId) return { ok: false, code: 'route_mismatch' };
  if (!request.requestId || !request.conversationId || !request.sessionId || !request.audience.id ||
      !target.routeId || !request.inbound.externalMessageId || !request.inbound.externalConversationId ||
      (!request.inbound.text.trim() && !request.inbound.attachments?.some((attachment) => attachment.sourceRef.trim()))) {
    return { ok: false, code: 'invalid_request' };
  }
  return { ok: true, dedupKey: JSON.stringify([
    request.inbound.channel, request.inbound.accountId, request.inbound.organizationId ?? '',
    request.inbound.externalConversationId, request.inbound.threadId ?? '', request.inbound.externalMessageId,
  ]) };
}

/** Equality only; the host must separately authorize membership in a conversation or organization. */
export function sameAssistantAudience(left: AssistantAudience, right: AssistantAudience): boolean {
  return left.kind === right.kind && left.id === right.id;
}
