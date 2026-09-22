import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

export const CAPABILITY_TOOL_NAMES = {
  search: 'search_capabilities',
  execute: 'execute_capability',
} as const;

export const CAPABILITY_CONTRACT_VERSION = 1;
export const CAPABILITY_ID_PREFIX = 'ypcap';

export type CapabilityToolName =
  (typeof CAPABILITY_TOOL_NAMES)[keyof typeof CAPABILITY_TOOL_NAMES];

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** MCP tool schemas default to JSON Schema 2020-12. */
export type CapabilityInputSchema = Tool['inputSchema'] & Record<string, unknown>;

export type CapabilityRiskLevel = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5';

export type CapabilityStatus =
  | 'available'
  | 'needs_approval'
  | 'denied_by_policy'
  | 'disabled';

/** A source-local definition as reported by an MCP server or a built-in provider. */
export interface CapabilityDefinition {
  name: string;
  description: string;
  type: string;
  riskLevel: CapabilityRiskLevel;
  status: CapabilityStatus;
  inputSchema: CapabilityInputSchema;
  outputSchema?: Tool['outputSchema'] & Record<string, unknown>;
  packageVersion?: string;
}

/** A globally routable descriptor returned to Pi. `name` is the opaque capability id. */
export interface CapabilityDescriptor extends Omit<CapabilityDefinition, 'name'> {
  name: string;
  sourceInstanceId: string;
  originalName: string;
}

export interface CapabilityContext {
  runId?: string;
  sessionId?: string;
  conversationId?: string;
  workspaceId?: string;
  userId?: string;
  roles?: string[];
  signal?: AbortSignal;
}

export interface SearchCapabilitiesInput {
  query?: string;
  limit?: number;
}

export interface CapabilitySourceFailure {
  sourceInstanceId: string;
  error: 'unavailable' | 'timeout';
  message: string;
}

export interface SearchCapabilitiesResult {
  matches: CapabilityDescriptor[];
  failures?: CapabilitySourceFailure[];
  hint?: string;
}

export interface ExecuteCapabilityInput {
  /** Exact opaque id returned in CapabilityDescriptor.name. */
  name: string;
  arguments?: Record<string, JsonValue>;
  /** Host-created request id. It is not an authorization secret or a model assertion. */
  approvalRequestId?: string;
}

export interface CapabilitySourceExecuteInput {
  capabilityId: string;
  originalName: string;
  arguments?: Record<string, JsonValue>;
}

export interface ExecuteCapabilityResult extends CallToolResult {
  capability: string;
  sourceInstanceId: string;
  riskLevel: CapabilityRiskLevel;
}

export type CapabilityApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'consumed'
  | 'expired'
  | 'cancelled';

export interface CapabilityApprovalBinding {
  requestId: string;
  runId?: string;
  sessionId: string;
  workspaceId: string;
  sourceInstanceId: string;
  packageVersion?: string;
  capabilityId: string;
  argumentsDigest: string;
  expiresAt: string;
}

export interface CapabilityApprovalRecord extends CapabilityApprovalBinding {
  status: CapabilityApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  consumedAt?: string;
}

export interface CapabilityAuthorizationInput {
  approvalRequestId?: string;
  runId?: string;
  sessionId?: string;
  workspaceId?: string;
  sourceInstanceId: string;
  packageVersion?: string;
  capabilityId: string;
  arguments: Record<string, JsonValue>;
}

export type CapabilityAuthorizationResult =
  | { status: 'authorized' }
  | { status: 'pending'; requestId: string }
  | { status: 'invalid'; message: string };

export interface CapabilityAuthorizer {
  authorize(input: CapabilityAuthorizationInput): Promise<CapabilityAuthorizationResult>;
}

export type CapabilityErrorCode =
  | 'unknown_capability'
  | 'invalid_arguments'
  | 'forbidden'
  | 'needs_approval'
  | 'approval_invalid'
  | 'policy_blocked'
  | 'execution_failed'
  | 'cancelled'
  | 'result_unknown'
  | 'timeout';

export interface CapabilityFailure {
  error: CapabilityErrorCode;
  message: string;
  retry: {
    search: boolean;
    action?: 'correct_arguments' | 'request_approval' | 'contact_admin' | 'retry';
  };
  approvalRequestId?: string;
}

export interface CapabilityToolDefinition {
  name: CapabilityToolName;
  description: string;
  inputSchema: CapabilityInputSchema;
}

export interface CapabilityToolClient {
  search(
    input: SearchCapabilitiesInput,
    context?: CapabilityContext,
  ): Promise<SearchCapabilitiesResult>;
  execute(
    input: ExecuteCapabilityInput,
    context?: CapabilityContext,
  ): Promise<ExecuteCapabilityResult>;
}

export type CapabilityContentBlock = CallToolResult['content'][number];
