import {
  createAgentSession,
  defineTool,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  CAPABILITY_TOOL_NAMES,
  type CapabilityToolClient,
  type ExecuteCapabilityInput,
} from '@yuanpu-agent/mcp-contracts';
import { Type } from 'typebox';

export const PI_UPSTREAM_VERSION = '0.86.1';

const searchParameters = Type.Object({
  query: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
}, { additionalProperties: false });

const executeParameters = Type.Object({
  name: Type.String({ minLength: 1 }),
  arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  approvalToken: Type.Optional(Type.String()),
}, { additionalProperties: false });

export function createYuanpuCapabilityTools(client: CapabilityToolClient): ToolDefinition[] {
  return [
    defineTool({
      name: CAPABILITY_TOOL_NAMES.search,
      label: 'Search capabilities',
      description: 'Find external capabilities available to the current workspace. Use an empty query to list available capabilities.',
      parameters: searchParameters,
      execute: async (_toolCallId, params) => {
        const result = await client.search(params);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: result,
        };
      },
    }),
    defineTool({
      name: CAPABILITY_TOOL_NAMES.execute,
      label: 'Execute capability',
      description: 'Execute an external capability by its exact name from search_capabilities.',
      parameters: executeParameters,
      execute: async (_toolCallId, params) => {
        const input = {
          name: params.name,
          arguments: params.arguments,
          approvalToken: params.approvalToken,
        } as ExecuteCapabilityInput;
        const result = await client.execute(input);
        return {
          content: [{ type: 'text', text: JSON.stringify(result.content) }],
          details: result,
        };
      },
    }),
  ];
}

export type CreateYuanpuAgentSessionOptions = CreateAgentSessionOptions & {
  capabilityClient: CapabilityToolClient;
};

export function createYuanpuAgentSession(
  options: CreateYuanpuAgentSessionOptions,
): Promise<CreateAgentSessionResult> {
  const { capabilityClient, ...sessionOptions } = options;
  const capabilityTools = createYuanpuCapabilityTools(capabilityClient);
  const tools = sessionOptions.tools ?? [
    'read',
    'write',
    'edit',
    'bash',
    CAPABILITY_TOOL_NAMES.search,
    CAPABILITY_TOOL_NAMES.execute,
  ];

  return createAgentSession({
    ...sessionOptions,
    tools,
    customTools: [...(sessionOptions.customTools ?? []), ...capabilityTools],
  });
}
