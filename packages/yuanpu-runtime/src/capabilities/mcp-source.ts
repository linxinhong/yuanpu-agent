import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { isAbsolute } from 'node:path';

import type {
  CapabilityContext,
  CapabilityDefinition,
  CapabilityInputSchema,
  CapabilityRiskLevel,
  CapabilitySourceExecuteInput,
} from './contracts.js';

export interface ManagedMcpSourceOptions {
  sourceInstanceId: string;
  packageVersion: string;
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  initializationTimeoutMs?: number;
  discoveryTimeoutMs?: number;
  executionTimeoutMs?: number;
  restartLimit?: number;
  restartWindowMs?: number;
  restartBackoffMs?: number;
}

export class ManagedMcpSourceError extends Error {
  constructor(
    readonly code: 'unavailable' | 'timeout' | 'cancelled' | 'result_unknown',
    message: string,
  ) {
    super(message);
    this.name = 'ManagedMcpSourceError';
  }
}

function riskFor(tool: Tool): CapabilityRiskLevel {
  if (tool.annotations?.readOnlyHint) return 'R0';
  if (tool.annotations?.destructiveHint === false) return 'R1';
  return 'R2';
}

export class ManagedMcpCapabilitySource {
  readonly sourceInstanceId: string;
  readonly #options: Required<Omit<ManagedMcpSourceOptions, 'args' | 'env'>> & {
    args: string[];
    env: Record<string, string>;
  };
  #client?: Client;
  #transport?: StdioClientTransport;
  #connecting?: Promise<Client>;
  #tools = new Map<string, Tool>();
  #restartAttempts: number[] = [];
  #disabledUntil = 0;
  #closing = false;

  constructor(options: ManagedMcpSourceOptions) {
    if (!options.sourceInstanceId.trim()) throw new Error('MCP sourceInstanceId is required.');
    if (!options.packageVersion.trim()) throw new Error('MCP packageVersion is required.');
    if (!isAbsolute(options.command)) throw new Error('Managed MCP command must be an absolute path.');
    if (!isAbsolute(options.cwd)) throw new Error('Managed MCP cwd must be an absolute path.');
    this.sourceInstanceId = options.sourceInstanceId;
    this.#options = {
      ...options,
      args: [...(options.args ?? [])],
      env: { ...(options.env ?? {}) },
      initializationTimeoutMs: options.initializationTimeoutMs ?? 5_000,
      discoveryTimeoutMs: options.discoveryTimeoutMs ?? 3_000,
      executionTimeoutMs: options.executionTimeoutMs ?? 30_000,
      restartLimit: options.restartLimit ?? 3,
      restartWindowMs: options.restartWindowMs ?? 60_000,
      restartBackoffMs: options.restartBackoffMs ?? 30_000,
    };
  }

  get processId(): number | null {
    return this.#transport?.pid ?? null;
  }

  async #connect(): Promise<Client> {
    if (this.#closing) throw new ManagedMcpSourceError('unavailable', 'MCP source is closing.');
    if (this.#client) return this.#client;
    if (this.#connecting) return this.#connecting;
    if (Date.now() < this.#disabledUntil) {
      throw new ManagedMcpSourceError('unavailable', 'MCP source restart budget is exhausted.');
    }
    const cutoff = Date.now() - this.#options.restartWindowMs;
    this.#restartAttempts = this.#restartAttempts.filter((attempt) => attempt >= cutoff);
    if (this.#restartAttempts.length >= this.#options.restartLimit) {
      this.#disabledUntil = Date.now() + this.#options.restartBackoffMs;
      throw new ManagedMcpSourceError('unavailable', 'MCP source restart budget is exhausted.');
    }
    this.#restartAttempts.push(Date.now());
    this.#connecting = (async () => {
      const transport = new StdioClientTransport({
        command: this.#options.command,
        args: this.#options.args,
        cwd: this.#options.cwd,
        env: this.#options.env,
        // Do not inherit or buffer an untrusted child process's diagnostics. A
        // future host logger may expose a redacted, bounded diagnostic sink.
        stderr: 'ignore',
      });
      const client = new Client({ name: 'yuanpu-agent', version: '0.1.0' });
      transport.onclose = () => {
        if (this.#transport === transport) {
          this.#transport = undefined;
          this.#client = undefined;
          this.#tools.clear();
        }
      };
      transport.onerror = () => undefined;
      try {
        await client.connect(transport, { timeout: this.#options.initializationTimeoutMs });
        this.#transport = transport;
        this.#client = client;
        return client;
      } catch (error) {
        await transport.close().catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        throw new ManagedMcpSourceError(
          /timeout/i.test(message) ? 'timeout' : 'unavailable',
          `MCP source initialization failed: ${message}`,
        );
      } finally {
        this.#connecting = undefined;
      }
    })();
    return this.#connecting;
  }

  async #refreshTools(context: CapabilityContext): Promise<Tool[]> {
    const client = await this.#connect();
    const tools: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      try {
        const result = await client.listTools(
          cursor ? { cursor } : undefined,
          { signal: context.signal, timeout: this.#options.discoveryTimeoutMs },
        );
        tools.push(...result.tools);
        cursor = result.nextCursor;
        if (!cursor) break;
      } catch (error) {
        if (context.signal?.aborted) throw new ManagedMcpSourceError('cancelled', 'MCP discovery was cancelled.');
        const message = error instanceof Error ? error.message : String(error);
        throw new ManagedMcpSourceError(
          /timeout/i.test(message) ? 'timeout' : 'unavailable',
          `MCP tool discovery failed: ${message}`,
        );
      }
    }
    if (cursor) throw new ManagedMcpSourceError('unavailable', 'MCP tool listing exceeded 20 pages.');
    if (tools.length > 1_000) throw new ManagedMcpSourceError('unavailable', 'MCP source exposed too many tools.');
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
    return tools;
  }

  async list(context: CapabilityContext): Promise<CapabilityDefinition[]> {
    return (await this.#refreshTools(context)).map((tool) => {
      const riskLevel = riskFor(tool);
      return {
        name: tool.name,
        description: tool.description ?? tool.title ?? tool.name,
        type: 'mcp_tool',
        riskLevel,
        status: riskLevel === 'R0' || riskLevel === 'R1' ? 'available' : 'needs_approval',
        inputSchema: tool.inputSchema as CapabilityInputSchema,
        outputSchema: tool.outputSchema as CapabilityDefinition['outputSchema'],
        packageVersion: this.#options.packageVersion,
      };
    });
  }

  async resolve(originalName: string, context: CapabilityContext): Promise<CapabilityDefinition | undefined> {
    if (!this.#tools.has(originalName)) await this.#refreshTools(context);
    const tool = this.#tools.get(originalName);
    if (!tool) return undefined;
    const riskLevel = riskFor(tool);
    return {
      name: tool.name,
      description: tool.description ?? tool.title ?? tool.name,
      type: 'mcp_tool',
      riskLevel,
      status: riskLevel === 'R0' || riskLevel === 'R1' ? 'available' : 'needs_approval',
      inputSchema: tool.inputSchema as CapabilityInputSchema,
      outputSchema: tool.outputSchema as CapabilityDefinition['outputSchema'],
      packageVersion: this.#options.packageVersion,
    };
  }

  async execute(input: CapabilitySourceExecuteInput, context: CapabilityContext): Promise<CallToolResult | undefined> {
    if (!this.#tools.has(input.originalName)) await this.#refreshTools(context);
    if (!this.#tools.has(input.originalName)) return undefined;
    const client = await this.#connect();
    try {
      return await client.callTool(
        { name: input.originalName, arguments: input.arguments },
        undefined,
        { signal: context.signal, timeout: this.#options.executionTimeoutMs },
      ) as CallToolResult;
    } catch (error) {
      if (context.signal?.aborted) throw new ManagedMcpSourceError('cancelled', 'MCP call was cancelled.');
      const message = error instanceof Error ? error.message : String(error);
      throw new ManagedMcpSourceError(
        /timeout/i.test(message) ? 'timeout' : 'result_unknown',
        `MCP call outcome is unknown and was not retried: ${message}`,
      );
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    await this.#connecting?.catch(() => undefined);
    const client = this.#client;
    const transport = this.#transport;
    this.#client = undefined;
    this.#transport = undefined;
    this.#tools.clear();
    if (client) await client.close().catch(() => undefined);
    else if (transport) await transport.close().catch(() => undefined);
  }
}
