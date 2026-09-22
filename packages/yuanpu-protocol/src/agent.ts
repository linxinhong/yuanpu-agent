export const AGENT_CONTRACT_VERSION = 1;

export type AgentEntryPoint = 'desktop' | 'im' | 'scheduler';

export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'result_unknown';

export type AgentTerminalRunStatus = Extract<
  AgentRunStatus,
  'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'result_unknown'
>;

export interface AgentHostIdentity {
  kind: 'local_user' | 'channel_user' | 'scheduler';
  /** Stable, host-authenticated principal. Never read this value from model input. */
  subjectId: string;
  /** Desktop instance, channel connection, or scheduler installation that vouched for the subject. */
  authorityId: string;
  authenticatedBy: 'electron' | 'channel_adapter' | 'scheduler';
}

export interface AgentConversationRef {
  /** Host-owned namespace. Channel adapters include their connection id in this value. */
  namespace: string;
  conversationId: string;
  threadId?: string;
  /** Present only after an explicit binding to a persisted Pi session. */
  sessionBindingId?: string;
}

export interface AgentModelInput {
  type: 'text';
  text: string;
}

export interface AgentDeliveryTarget {
  kind: 'desktop' | 'channel' | 'none';
  routeId?: string;
}

export interface AgentRunRequest {
  contractVersion: typeof AGENT_CONTRACT_VERSION;
  entryPoint: AgentEntryPoint;
  identity: AgentHostIdentity;
  workspaceId: string;
  conversation: AgentConversationRef;
  input: AgentModelInput;
  /** Unique within entryPoint + identity.authorityId. */
  idempotencyKey: string;
  delivery: AgentDeliveryTarget;
}

export interface AgentRunOutput {
  message: string;
  tools: Array<{ name: string; status: 'completed' | 'failed' }>;
}

export interface AgentRunRecord {
  runId: string;
  request: AgentRunRequest;
  requestFingerprint: string;
  status: AgentRunStatus;
  createdAt: string;
  updatedAt: string;
  output?: AgentRunOutput;
  failure?: { code: string; message: string; retryable: boolean };
}

export type AgentContractErrorCode =
  | 'invalid_request'
  | 'unsupported_contract_version'
  | 'identity_mismatch'
  | 'idempotency_conflict'
  | 'invalid_transition'
  | 'run_not_found';

export interface AgentContractRejection {
  accepted: false;
  code: AgentContractErrorCode;
  message: string;
  field?: string;
}

export interface AgentRunReceipt {
  accepted: true;
  runId: string;
  status: AgentRunStatus;
  duplicate: boolean;
}

export type AgentRunSubmissionResult = AgentRunReceipt | AgentContractRejection;

export interface AgentRunCancellationReceipt {
  runId: string;
  result: 'cancelled' | 'cancellation_requested' | 'already_terminal' | 'not_found';
  status?: AgentRunStatus;
}

export type AgentDeliveryStatus =
  | 'pending'
  | 'delivering'
  | 'delivered'
  | 'failed'
  | 'result_unknown';

export interface AgentDeliveryRecord {
  deliveryId: string;
  runId: string;
  idempotencyKey: string;
  target: AgentDeliveryTarget;
  status: AgentDeliveryStatus;
  attempts: number;
  updatedAt: string;
}

