import {
  CAPABILITY_TOOL_NAMES,
  type CapabilityContext,
  type CapabilityDescriptor,
  type CapabilityFailure,
  type CapabilityRiskLevel,
  type CapabilityToolClient,
  type CapabilityToolDefinition,
  type ExecuteCapabilityInput,
  type ExecuteCapabilityResult,
  type SearchCapabilitiesInput,
  type SearchCapabilitiesResult,
} from './contracts.js';

export * from './contracts.js';

export interface CapabilitySource {
  list(context: CapabilityContext): Promise<CapabilityDescriptor[]>;
  resolve(
    name: string,
    context: CapabilityContext,
  ): Promise<CapabilityDescriptor | undefined>;
  execute(
    input: ExecuteCapabilityInput,
    context: CapabilityContext,
  ): Promise<ExecuteCapabilityResult | undefined>;
}

export class CapabilityError extends Error {
  readonly failure: CapabilityFailure;

  constructor(failure: CapabilityFailure) {
    super(failure.message);
    this.name = 'CapabilityError';
    this.failure = failure;
  }
}

const riskOrder: Record<CapabilityRiskLevel, number> = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4,
  R5: 5,
};

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function scoreCapability(capability: CapabilityDescriptor, query: string[]): number {
  const nameTokens = tokenize(capability.name);
  const descriptionTokens = tokenize(capability.description);
  return query.reduce((score, token) => {
    if (nameTokens.includes(token)) return score + 5;
    if (nameTokens.some((candidate) => candidate.startsWith(token))) return score + 3;
    if (descriptionTokens.includes(token)) return score + 2;
    return score;
  }, 0);
}

export class CapabilityRegistry implements CapabilityToolClient {
  readonly #sources: CapabilitySource[];

  constructor(sources: CapabilitySource[] = []) {
    this.#sources = [...sources];
  }

  async search(
    input: SearchCapabilitiesInput,
    context: CapabilityContext = {},
  ): Promise<SearchCapabilitiesResult> {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 5), 1), 20);
    const query = tokenize(input.query ?? '');
    const capabilities = (await Promise.all(this.#sources.map((source) => source.list(context))))
      .flat();

    const matches = query.length === 0
      ? capabilities.sort((left, right) => left.name.localeCompare(right.name)).slice(0, limit)
      : capabilities
          .map((capability) => ({ capability, score: scoreCapability(capability, query) }))
          .filter((item) => item.score > 0)
          .sort((left, right) => right.score - left.score || left.capability.name.localeCompare(right.capability.name))
          .slice(0, limit)
          .map((item) => item.capability);

    return matches.length > 0
      ? { matches }
      : { matches, hint: 'No capability matched. Try broader keywords.' };
  }

  async execute(
    input: ExecuteCapabilityInput,
    context: CapabilityContext = {},
  ): Promise<ExecuteCapabilityResult> {
    if (!input.name.trim()) {
      throw new CapabilityError({
        error: 'invalid_arguments',
        message: 'Capability name is required.',
        retry: { search: true, action: 'correct_arguments' },
      });
    }

    let resolved: { source: CapabilitySource; capability: CapabilityDescriptor } | undefined;
    for (const source of this.#sources) {
      const capability = await source.resolve(input.name, context);
      if (capability) {
        resolved = { source, capability };
        break;
      }
    }

    if (!resolved) {
      throw new CapabilityError({
        error: 'unknown_capability',
        message: `No capability named ${input.name}.`,
        retry: { search: true },
      });
    }
    const { capability } = resolved;
    if (capability.status === 'denied_by_policy' || capability.status === 'disabled') {
      throw new CapabilityError({
        error: 'policy_blocked',
        message: `${input.name} is not available under the current policy.`,
        retry: { search: false, action: 'contact_admin' },
      });
    }
    if ((capability.status === 'needs_approval' || riskOrder[capability.riskLevel] >= riskOrder.R2)
      && !input.approvalToken) {
      throw new CapabilityError({
        error: 'needs_approval',
        message: `${input.name} requires approval before execution.`,
        retry: { search: false, action: 'request_approval' },
        approvalHint: `Approve execution of ${input.name} and retry with a one-time token.`,
      });
    }

    const result = await resolved.source.execute(input, context);
    if (result) return result;

    throw new CapabilityError({
      error: 'unknown_capability',
      message: `No capability source accepted ${input.name}.`,
      retry: { search: true },
    });
  }
}

export const YUANPU_MCP_TOOLS: readonly CapabilityToolDefinition[] = [
  {
    name: CAPABILITY_TOOL_NAMES.search,
    description: 'Find external capabilities available in the current workspace. Use an empty query to list available capabilities.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords describing the required capability.' },
        limit: { type: 'integer', description: 'Maximum matches. Defaults to 5 and is capped at 20.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: CAPABILITY_TOOL_NAMES.execute,
    description: 'Execute a capability by the exact name returned from search_capabilities.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Exact capability name returned by search_capabilities.' },
        arguments: { type: 'object', description: 'Arguments matching the capability input schema.' },
        approvalToken: { type: 'string', description: 'One-time approval token for sensitive capabilities.' },
      },
      additionalProperties: false,
    },
  },
] as const;

export class YuanpuMcpServer implements CapabilityToolClient {
  readonly #registry: CapabilityRegistry;

  constructor(sources: CapabilitySource[] = []) {
    this.#registry = new CapabilityRegistry(sources);
  }

  listTools(): readonly CapabilityToolDefinition[] {
    return YUANPU_MCP_TOOLS;
  }

  search(
    input: SearchCapabilitiesInput,
    context: CapabilityContext = {},
  ): Promise<SearchCapabilitiesResult> {
    return this.#registry.search(input, context);
  }

  execute(
    input: ExecuteCapabilityInput,
    context: CapabilityContext = {},
  ): Promise<ExecuteCapabilityResult> {
    return this.#registry.execute(input, context);
  }

  callTool(
    name: string,
    input: SearchCapabilitiesInput | ExecuteCapabilityInput,
    context: CapabilityContext = {},
  ): Promise<SearchCapabilitiesResult | ExecuteCapabilityResult> {
    if (name === CAPABILITY_TOOL_NAMES.search) {
      return this.search(input as SearchCapabilitiesInput, context);
    }
    if (name === CAPABILITY_TOOL_NAMES.execute) {
      return this.execute(input as ExecuteCapabilityInput, context);
    }
    return Promise.reject(new CapabilityError({
      error: 'unknown_capability',
      message: `The MCP server does not expose a tool named ${name}.`,
      retry: { search: false },
    }));
  }
}

export function createYuanpuMcpServer(sources: CapabilitySource[] = []): YuanpuMcpServer {
  return new YuanpuMcpServer(sources);
}

const echoCapability: CapabilityDescriptor = {
  name: 'yuanpu.echo',
  description: 'Echo text back unchanged. Use this capability to verify the external MCP execution path.',
  type: 'mcp_tool',
  riskLevel: 'R0',
  status: 'available',
  inputSchema: {
    type: 'object',
    required: ['text'],
    properties: { text: { type: 'string', description: 'Text to echo.' } },
    additionalProperties: false,
  },
};

export function createDemoCapabilitySource(): CapabilitySource {
  return {
    async list() {
      return [echoCapability];
    },
    async resolve(name) {
      return name === echoCapability.name ? echoCapability : undefined;
    },
    async execute(input) {
      if (input.name !== echoCapability.name) return undefined;
      const text = input.arguments?.text;
      if (typeof text !== 'string') {
        throw new CapabilityError({
          error: 'invalid_arguments',
          message: 'yuanpu.echo requires a string argument named text.',
          retry: { search: false, action: 'correct_arguments' },
        });
      }
      return {
        capability: echoCapability.name,
        riskLevel: echoCapability.riskLevel,
        content: { text },
      };
    },
  };
}
