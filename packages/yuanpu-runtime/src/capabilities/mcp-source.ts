import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, JSONRPCMessage, Tool } from '@modelcontextprotocol/sdk/types.js';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
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

const WINDOWS_JOB_SUPERVISOR = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class YuanpuJob {
  [StructLayout(LayoutKind.Sequential)]
  public struct BasicLimits {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IoCounters {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct ExtendedLimits {
    public BasicLimits BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);
  [DllImport("kernel32.dll")]
  public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll")]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);
}
'@

$job = [YuanpuJob]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { throw 'CreateJobObject failed' }
$limits = New-Object YuanpuJob+ExtendedLimits
$limits.BasicLimitInformation.LimitFlags = 0x2000
$size = [Runtime.InteropServices.Marshal]::SizeOf($limits)
$pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
try {
  [Runtime.InteropServices.Marshal]::StructureToPtr($limits, $pointer, $false)
  if (-not [YuanpuJob]::SetInformationJobObject($job, 9, $pointer, $size)) {
    throw 'SetInformationJobObject failed'
  }
} finally {
  [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer)
}

$process = New-Object Diagnostics.Process
$process.StartInfo.FileName = $env:YUANPU_MCP_CHILD_COMMAND
$process.StartInfo.Arguments = $env:YUANPU_MCP_CHILD_ARGUMENTS
$process.StartInfo.UseShellExecute = $false
$process.StartInfo.RedirectStandardInput = $true
$process.StartInfo.RedirectStandardOutput = $true
$process.StartInfo.RedirectStandardError = $true
$process.StartInfo.CreateNoWindow = $true
try {
  if (-not $process.Start()) { throw 'MCP child failed to start' }
  if (-not [YuanpuJob]::AssignProcessToJobObject($job, $process.Handle)) {
    $process.Kill()
    throw 'AssignProcessToJobObject failed'
  }
  $stdout = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
  $stderr = $process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
  $stdin = [Console]::OpenStandardInput().CopyToAsync($process.StandardInput.BaseStream)
  $process.WaitForExit()
  $process.StandardInput.Close()
  $stdout.GetAwaiter().GetResult()
  $stderr.GetAwaiter().GetResult()
  $exitCode = $process.ExitCode
} finally {
  [YuanpuJob]::CloseHandle($job) | Out-Null
  $process.Dispose()
}
exit $exitCode
`;

function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\*)$/u, '$1$1')}"`;
}

async function terminateProcessGroup(rootPid: number): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(rootPid), '/T', '/F'], {
      timeout: 5_000,
      windowsHide: true,
    }).catch(() => undefined);
    return;
  }
  try { process.kill(-rootPid, 'SIGTERM'); } catch { /* already gone */ }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  try { process.kill(-rootPid, 'SIGKILL'); } catch { /* already gone */ }
}

class ProcessGroupStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  readonly #command: string;
  readonly #args: string[];
  readonly #cwd: string;
  readonly #env: Record<string, string>;
  readonly #readBuffer = new ReadBuffer();
  #process?: ChildProcess;
  #groupId?: number;
  #closing?: Promise<void>;

  constructor(options: { command: string; args: string[]; cwd: string; env: Record<string, string> }) {
    this.#command = options.command;
    this.#args = options.args;
    this.#cwd = options.cwd;
    this.#env = options.env;
  }

  get pid(): number | null {
    return this.#process?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.#process) throw new Error('Managed MCP transport is already started.');
    await new Promise<void>((resolveStart, rejectStart) => {
      const child = spawn(this.#command, this.#args, {
        cwd: this.#cwd,
        env: this.#env,
        detached: process.platform !== 'win32',
        shell: false,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
      this.#process = child;
      this.#groupId = child.pid;
      child.once('spawn', resolveStart);
      child.once('error', rejectStart);
      child.on('error', (error) => this.onerror?.(error));
      child.stdin?.on('error', (error) => this.onerror?.(error));
      child.stdout?.on('data', (chunk: Buffer) => {
        this.#readBuffer.append(chunk);
        while (true) {
          try {
            const message = this.#readBuffer.readMessage();
            if (!message) break;
            this.onmessage?.(message);
          } catch (error) {
            this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
      child.stdout?.on('error', (error) => this.onerror?.(error));
      child.once('close', () => {
        this.#process = undefined;
        const groupId = this.#groupId;
        this.#groupId = undefined;
        if (groupId) {
          void terminateProcessGroup(groupId).finally(() => this.onclose?.());
        } else {
          this.onclose?.();
        }
      });
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.#process?.stdin;
    if (!stdin) throw new Error('Managed MCP transport is not connected.');
    const payload = serializeMessage(message);
    if (stdin.write(payload)) return;
    await new Promise<void>((resolveDrain) => stdin.once('drain', resolveDrain));
  }

  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      const groupId = this.#groupId;
      this.#groupId = undefined;
      if (groupId) await terminateProcessGroup(groupId);
      this.#process = undefined;
      this.#readBuffer.clear();
    })();
    return this.#closing;
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
  #transport?: ProcessGroupStdioTransport;
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
      initializationTimeoutMs: options.initializationTimeoutMs ?? (process.platform === 'win32' ? 15_000 : 5_000),
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
      const isolatedEnv: Record<string, string> = {
        ...this.#options.env,
        HOME: this.#options.privateHome,
        USERPROFILE: this.#options.privateHome,
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
      };
      let command = this.#options.command;
      let args = this.#options.args;
      if (process.platform === 'win32') {
        const systemRoot = isolatedEnv.SYSTEMROOT;
        if (!systemRoot) throw new ManagedMcpSourceError('unavailable', 'SYSTEMROOT is required for Windows MCP isolation.');
        const supervisor = join(this.#options.privateHome, 'mcp-job-supervisor.ps1');
        await writeFile(supervisor, WINDOWS_JOB_SUPERVISOR, { encoding: 'utf8', mode: 0o600 });
        isolatedEnv.YUANPU_MCP_CHILD_COMMAND = command;
        isolatedEnv.YUANPU_MCP_CHILD_ARGUMENTS = args.map(quoteWindowsArgument).join(' ');
        command = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        args = [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          supervisor,
        ];
      }
      const transport = new ProcessGroupStdioTransport({
        command,
        args,
        cwd: this.#options.cwd,
        env: isolatedEnv,
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
    this.#client = undefined;
    this.#transport = undefined;
    this.#tools.clear();
    this.#toolsExpiresAt = 0;
    if (client) await client.close().catch(() => undefined);
    else if (transport) await transport.close().catch(() => undefined);
  }
}
