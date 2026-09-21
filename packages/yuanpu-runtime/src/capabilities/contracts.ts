export const CAPABILITY_TOOL_NAMES = {
  search: 'search_capabilities',
  execute: 'execute_capability',
} as const;

export type CapabilityToolName =
  (typeof CAPABILITY_TOOL_NAMES)[keyof typeof CAPABILITY_TOOL_NAMES];

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
}

export type CapabilityRiskLevel = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5';

export type CapabilityStatus =
  | 'available'
  | 'needs_approval'
  | 'denied_by_policy'
  | 'disabled';

export interface CapabilityDescriptor {
  name: string;
  description: string;
  type: string;
  riskLevel: CapabilityRiskLevel;
  status: CapabilityStatus;
  inputSchema: JsonSchema;
}

export interface CapabilityContext {
  workspaceId?: string;
  userId?: string;
  roles?: string[];
}

export interface SearchCapabilitiesInput {
  query?: string;
  limit?: number;
}

export interface SearchCapabilitiesResult {
  matches: CapabilityDescriptor[];
  hint?: string;
}

export interface ExecuteCapabilityInput {
  name: string;
  arguments?: Record<string, JsonValue>;
  approvalToken?: string;
}

export interface ExecuteCapabilityResult {
  content: JsonValue;
  capability: string;
  riskLevel: CapabilityRiskLevel;
}

export type CapabilityErrorCode =
  | 'unknown_capability'
  | 'invalid_arguments'
  | 'forbidden'
  | 'needs_approval'
  | 'policy_blocked'
  | 'execution_failed'
  | 'timeout';

export interface CapabilityFailure {
  error: CapabilityErrorCode;
  message: string;
  retry: {
    search: boolean;
    action?: 'correct_arguments' | 'request_approval' | 'contact_admin' | 'retry';
  };
  approvalHint?: string;
}

export interface CapabilityToolDefinition {
  name: CapabilityToolName;
  description: string;
  inputSchema: JsonSchema;
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
