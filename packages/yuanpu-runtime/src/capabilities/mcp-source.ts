import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

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
  privateHome: string;
  riskPolicy?: Record<string, CapabilityRiskLevel>;
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

const execFileAsync = promisify(execFile);

async function descendantPids(rootPid: number): Promise<number[]> {
  if (process.platform === 'win32') return [];
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 1024 * 1024,
    });
    const children = new Map<number, number[]>();
    for (const line of stdout.split('\n')) {
      const [pidText, parentText] = line.trim().split(/\s+/);
      const pid = Number(pidText);
      const parent = Number(parentText);
      if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
      const siblings = children.get(parent) ?? [];
      siblings.push(pid);
      children.set(parent, siblings);
    }
    const result: number[] = [];
    const visit = (parent: number) => {
      for (const child of children.get(parent) ?? []) {
        visit(child);
        result.push(child);
      }
    };
    visit(rootPid);
    return result;
  } catch {
    return [];
  }
}

async function terminateDescendants(rootPid: number): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(rootPid), '/T', '/F'], {
      timeout: 5_000,
      windowsHide: true,
    }).catch(() => undefined);
    return;
  }
  const descendants = await descendantPids(rootPid);
  for (const pid of descendants) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  for (const pid of descendants) {
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

export class ManagedMcpCapabilitySource {
  readonly sourceInstanceId: string;
  readonly #options: Required<Omit<ManagedMcpSourceOptions, 'args' | 'env'>> & {
    args: string[];
    env: Record<string, string>;
    riskPolicy: Record<string, CapabilityRiskLevel>;
  };
  #client?: Client;
  #transport?: StdioClientTransport;
  #connecting?: Promise<Client>;
  #tools = new Map<string, Tool>();
  #toolsExpiresAt = 0;
  #restartAttempts: number[] = [];
  #disabledUntil = 0;
  #closing = false;

  constructor(options: ManagedMcpSourceOptions) {
    if (!options.sourceInstanceId.trim()) throw new Error('MCP sourceInstanceId is required.');
    if (!options.packageVersion.trim()) throw new Error('MCP packageVersion is required.');
    if (!isAbsolute(options.command)) throw new Error('Managed MCP command must be an absolute path.');
    if (!isAbsolute(options.cwd)) throw new Error('Managed MCP cwd must be an absolute path.');
    if (!isAbsolute(options.privateHome)) throw new Error('Managed MCP privateHome must be an absolute path.');
    this.sourceInstanceId = options.sourceInstanceId;
    this.#options = {
      ...options,
      args: [...(options.args ?? [])],
      env: { ...(options.env ?? {}) },
      riskPolicy: { ...(options.riskPolicy ?? {}) },
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
      await mkdir(this.#options.privateHome, { recursive: true });
      const appData = join(this.#options.privateHome, 'app-data');
      const localAppData = join(this.#options.privateHome, 'local-app-data');
      await Promise.all([mkdir(appData, { recursive: true }), mkdir(localAppData, { recursive: true })]);
      const transport = new StdioClientTransport({
        command: this.#options.command,
        args: this.#options.args,
        cwd: this.#options.cwd,
        env: {
          ...this.#options.env,
          HOME: this.#options.privateHome,
          USERPROFILE: this.#options.privateHome,
          APPDATA: appData,
          LOCALAPPDATA: localAppData,
        },
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
          this.#toolsExpiresAt = 0;
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
    this.#toolsExpiresAt = Date.now() + 1_000;
    return tools;
  }

  async list(context: CapabilityContext): Promise<CapabilityDefinition[]> {
    return (await this.#refreshTools(context)).map((tool) => {
      // MCP annotations are untrusted hints. Only host policy may downgrade the
      // default approval-required risk level.
      const riskLevel = this.#options.riskPolicy[tool.name] ?? 'R2';
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
    // Re-discover before policy enforcement so revoked tools and changed
    // schemas are not authorized from an indefinitely stale cache.
    await this.#refreshTools(context);
    const tool = this.#tools.get(originalName);
    if (!tool) return undefined;
    const riskLevel = this.#options.riskPolicy[tool.name] ?? 'R2';
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
    if (!this.#tools.has(input.originalName) || Date.now() >= this.#toolsExpiresAt) {
      await this.#refreshTools(context);
    }
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
    const pid = transport?.pid ?? null;
    this.#client = undefined;
    this.#transport = undefined;
    this.#tools.clear();
    this.#toolsExpiresAt = 0;
    if (pid) await terminateDescendants(pid);
    if (client) await client.close().catch(() => undefined);
    else if (transport) await transport.close().catch(() => undefined);
  }
}
