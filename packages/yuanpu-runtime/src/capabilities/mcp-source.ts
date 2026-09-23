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
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class YuanpuJob {
  private static readonly Dictionary<uint, IntPtr> TrackedDescendants = new Dictionary<uint, IntPtr>();
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
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct ProcessEntry {
    public uint Size;
    public uint Usage;
    public uint ProcessId;
    public UIntPtr DefaultHeapId;
    public uint ModuleId;
    public uint Threads;
    public uint ParentProcessId;
    public int BasePriority;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string Executable;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);
  [DllImport("kernel32.dll")]
  public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll")]
  public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, out uint returnedLength);
  [DllImport("kernel32.dll")]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")]
  public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll")]
  public static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll")]
  public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")]
  public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  public static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll")]
  public static extern bool TerminateProcess(IntPtr process, uint exitCode);
  public static bool HasKillOnClose(IntPtr job) {
    uint size = (uint)Marshal.SizeOf(typeof(ExtendedLimits));
    IntPtr info = Marshal.AllocHGlobal((int)size);
    try {
      uint returnedLength;
      if (!QueryInformationJobObject(job, 9, info, size, out returnedLength)) {
        throw new InvalidOperationException("QueryInformationJobObject failed");
      }
      ExtendedLimits limits = (ExtendedLimits)Marshal.PtrToStructure(info, typeof(ExtendedLimits));
      return (limits.BasicLimitInformation.LimitFlags & 0x2000) != 0;
    } finally {
      Marshal.FreeHGlobal(info);
    }
  }
  public static List<uint> FindDescendants(IEnumerable<uint> roots) {
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new InvalidOperationException("Process snapshot failed");
    var children = new Dictionary<uint, List<uint>>();
    try {
      ProcessEntry entry = new ProcessEntry();
      entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
      if (Process32FirstW(snapshot, ref entry)) {
        do {
          List<uint> siblings;
          if (!children.TryGetValue(entry.ParentProcessId, out siblings)) {
            siblings = new List<uint>();
            children.Add(entry.ParentProcessId, siblings);
          }
          siblings.Add(entry.ProcessId);
          entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
        } while (Process32NextW(snapshot, ref entry));
      }
    } finally {
      CloseHandle(snapshot);
    }
    var queue = new Queue<uint>();
    var seen = new HashSet<uint>();
    var descendants = new List<uint>();
    foreach (uint rootPid in roots) {
      queue.Enqueue(rootPid);
      seen.Add(rootPid);
    }
    while (queue.Count > 0) {
      List<uint> direct;
      if (!children.TryGetValue(queue.Dequeue(), out direct)) continue;
      foreach (uint pid in direct) {
        if (!seen.Add(pid)) continue;
        descendants.Add(pid);
        queue.Enqueue(pid);
      }
    }
    return descendants;
  }
  public static string AssignDescendantsToJob(IntPtr job, uint rootPid) {
    var outcomes = new List<string>();
    foreach (uint pid in FindDescendants(new uint[] { rootPid })) {
      IntPtr process = OpenProcess(0x101101, false, pid);
      if (process == IntPtr.Zero) {
        outcomes.Add(pid + ":not-open");
        continue;
      }
      try {
        if (WaitForSingleObject(process, 0) != 0) {
          outcomes.Add(pid + (AssignProcessToJobObject(job, process) ? ":assigned" : ":not-assigned"));
        } else {
          outcomes.Add(pid + ":exited");
        }
      } finally {
        CloseHandle(process);
      }
    }
    return string.Join(",", outcomes.ToArray());
  }
  public static string TrackDescendants(uint rootPid) {
    var outcomes = new List<string>();
    var roots = new List<uint>(TrackedDescendants.Keys);
    roots.Add(rootPid);
    foreach (uint pid in FindDescendants(roots)) {
      if (TrackedDescendants.ContainsKey(pid)) continue;
      IntPtr process = OpenProcess(0x100001, false, pid);
      if (process == IntPtr.Zero) {
        outcomes.Add(pid + ":not-open");
        continue;
      }
      TrackedDescendants.Add(pid, process);
      outcomes.Add(pid + ":tracked");
    }
    return string.Join(",", outcomes.ToArray());
  }
  public static string TerminateTrackedDescendants() {
    var outcomes = new List<string>();
    foreach (var descendant in TrackedDescendants) {
      try {
        if (WaitForSingleObject(descendant.Value, 0) == 0) {
          outcomes.Add(descendant.Key + ":exited");
        } else if (TerminateProcess(descendant.Value, 1) && WaitForSingleObject(descendant.Value, 5000) == 0) {
          outcomes.Add(descendant.Key + ":terminated");
        } else {
          outcomes.Add(descendant.Key + ":not-terminated");
        }
      } finally {
        CloseHandle(descendant.Value);
      }
    }
    TrackedDescendants.Clear();
    return string.Join(",", outcomes.ToArray());
  }
}
'@

$job = [YuanpuJob]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { throw 'CreateJobObject failed' }
$limits = New-Object YuanpuJob+ExtendedLimits
$basicLimits = New-Object YuanpuJob+BasicLimits
$basicLimits.LimitFlags = 0x2000
$limits.BasicLimitInformation = $basicLimits
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
if (-not [YuanpuJob]::HasKillOnClose($job)) { throw 'Job Object kill-on-close limit was not applied' }
$process = [YuanpuJob]::OpenProcess(0x101101, $false, [uint32]$env:YUANPU_MCP_CHILD_PID)
if ($process -eq [IntPtr]::Zero) { throw 'OpenProcess failed' }
try {
  if (-not [YuanpuJob]::AssignProcessToJobObject($job, $process)) {
    throw 'Assign child to Job Object failed'
  }
  # A venv launcher can create the real interpreter before it joins the Job.
  [YuanpuJob]::AssignDescendantsToJob($job, [uint32]$env:YUANPU_MCP_CHILD_PID) | Out-Null
  [YuanpuJob]::TrackDescendants([uint32]$env:YUANPU_MCP_CHILD_PID) | Out-Null
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  do {
    $waitResult = [YuanpuJob]::WaitForSingleObject($process, 50)
    if ($waitResult -eq 258) { [YuanpuJob]::TrackDescendants([uint32]$env:YUANPU_MCP_CHILD_PID) | Out-Null }
  } while ($waitResult -eq 258)
  [YuanpuJob]::TrackDescendants([uint32]$env:YUANPU_MCP_CHILD_PID) | Out-Null
  if (-not [YuanpuJob]::TerminateJobObject($job, 1)) { throw 'TerminateJobObject failed' }
} finally {
  [YuanpuJob]::TerminateTrackedDescendants() | Out-Null
  [YuanpuJob]::CloseHandle($process) | Out-Null
  [YuanpuJob]::CloseHandle($job) | Out-Null
}
`;

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
  readonly #windowsSupervisorScript?: string;
  readonly #readBuffer = new ReadBuffer();
  #process?: ChildProcess;
  #supervisor?: ChildProcess;
  #supervisorReady = false;
  #groupId?: number;
  #closing?: Promise<void>;

  constructor(options: { command: string; args: string[]; cwd: string; env: Record<string, string>; windowsSupervisorScript?: string }) {
    this.#command = options.command;
    this.#args = options.args;
    this.#cwd = options.cwd;
    this.#env = options.env;
    this.#windowsSupervisorScript = options.windowsSupervisorScript;
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
      // `exit` is intentionally used instead of `close`: a descendant may
      // inherit stdout and keep the pipe open after the MCP root has exited.
      child.once('exit', () => {
        this.#process = undefined;
        const groupId = this.#groupId;
        this.#groupId = undefined;
        if (groupId) {
          void (this.#supervisor ? this.#waitWindowsSupervisor() : terminateProcessGroup(groupId))
            .finally(() => this.onclose?.());
        } else {
          this.onclose?.();
        }
      });
    });
    if (this.#windowsSupervisorScript && this.#groupId) {
      try {
        await this.#attachWindowsSupervisor(this.#groupId);
      } catch (error) {
        await this.close();
        throw error;
      }
    }
  }

  async #attachWindowsSupervisor(rootPid: number): Promise<void> {
    const systemRoot = this.#env.SYSTEMROOT;
    if (!systemRoot || !this.#windowsSupervisorScript) throw new Error('Windows MCP supervisor is not configured.');
    const supervisor = spawn(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.#windowsSupervisorScript,
    ], {
      cwd: this.#cwd,
      env: { ...this.#env, YUANPU_MCP_CHILD_PID: String(rootPid) },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    this.#supervisor = supervisor;
    supervisor.on('error', (error) => this.onerror?.(error));
    await new Promise<void>((resolveReady, rejectReady) => {
      let output = '';
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) rejectReady(error);
        else resolveReady();
      };
      const timeout = setTimeout(() => finish(new Error('Windows MCP Job Object setup timed out.')), 90_000);
      const fail = (error: Error) => finish(error);
      supervisor.once('error', fail);
      supervisor.once('exit', () => finish(new Error('Windows MCP Job Object supervisor exited before ready.')));
      supervisor.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.includes('READY')) {
          this.#supervisorReady = true;
          finish();
        }
        if (output.length > 4_096) finish(new Error('Windows MCP Job Object supervisor did not become ready.'));
      });
    });
  }

  async #waitWindowsSupervisor(): Promise<void> {
    const supervisor = this.#supervisor;
    if (!supervisor) return;
    if (!this.#supervisorReady && supervisor.pid) {
      await terminateProcessGroup(supervisor.pid);
      this.#supervisor = undefined;
      this.#supervisorReady = false;
      return;
    }
    if (supervisor.exitCode === null && supervisor.signalCode === null) {
      await new Promise<void>((resolveExit) => {
        const timeout = setTimeout(resolveExit, 3_000);
        supervisor.once('exit', () => {
          clearTimeout(timeout);
          resolveExit();
        });
      });
    }
    if (supervisor.exitCode === null && supervisor.signalCode === null && supervisor.pid) {
      await terminateProcessGroup(supervisor.pid);
    }
    this.#supervisor = undefined;
    this.#supervisorReady = false;
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
      await this.#waitWindowsSupervisor();
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
      if (this.#closing) {
        throw new ManagedMcpSourceError('unavailable', 'MCP source is closing.');
      }
      const isolatedEnv: Record<string, string> = {
        ...this.#options.env,
        HOME: this.#options.privateHome,
        USERPROFILE: this.#options.privateHome,
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
      };
      let windowsSupervisorScript: string | undefined;
      if (process.platform === 'win32') {
        const systemRoot = isolatedEnv.SYSTEMROOT;
        if (!systemRoot) throw new ManagedMcpSourceError('unavailable', 'SYSTEMROOT is required for Windows MCP isolation.');
        const temp = join(this.#options.privateHome, 'temp');
        await mkdir(temp, { recursive: true });
        isolatedEnv.TEMP = temp;
        isolatedEnv.TMP = temp;
        isolatedEnv.PATH = [
          isolatedEnv.PATH,
          join(systemRoot, 'System32'),
          systemRoot,
        ].filter(Boolean).join(';');
        windowsSupervisorScript = join(this.#options.privateHome, 'mcp-job-supervisor.ps1');
        await writeFile(windowsSupervisorScript, WINDOWS_JOB_SUPERVISOR, { encoding: 'utf8', mode: 0o600 });
      }
      if (this.#closing) {
        throw new ManagedMcpSourceError('unavailable', 'MCP source is closing.');
      }
      const transport = new ProcessGroupStdioTransport({
        command: this.#options.command,
        args: this.#options.args,
        cwd: this.#options.cwd,
        env: isolatedEnv,
        windowsSupervisorScript,
      });
      const client = new Client({ name: 'yuanpu-agent', version: '0.1.0' });
      this.#transport = transport;
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
        if (this.#closing) {
          await transport.close();
          throw new ManagedMcpSourceError('unavailable', 'MCP source is closing.');
        }
        this.#client = client;
        return client;
      } catch (error) {
        await transport.close().catch(() => undefined);
        if (this.#transport === transport) this.#transport = undefined;
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

  async #resetConnection(expectedClient: Client): Promise<void> {
    if (this.#client !== expectedClient) return;
    const transport = this.#transport;
    this.#client = undefined;
    this.#transport = undefined;
    this.#tools.clear();
    this.#toolsExpiresAt = 0;
    await expectedClient.close().catch(async () => {
      await transport?.close().catch(() => undefined);
    });
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
        await this.#resetConnection(client);
        if (context.signal?.aborted) {
          throw new ManagedMcpSourceError('cancelled', 'MCP discovery was cancelled.');
        }
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
    // A transport is published before MCP initialization completes. Close it
    // first so an unresponsive initialize handshake cannot outlive the App.
    await this.#transport?.close().catch(() => undefined);
    await this.#connecting?.catch(() => undefined);
    const client = this.#client;
    const transport = this.#transport;
    this.#client = undefined;
    this.#transport = undefined;
    this.#tools.clear();
    this.#toolsExpiresAt = 0;
    // Terminate the process group directly as well as closing the MCP client.
    // This keeps App shutdown bounded even if the protocol-level close stalls.
    await Promise.allSettled([
      transport?.close(),
      client?.close(),
    ].filter((operation): operation is Promise<void> => Boolean(operation)));
  }
}
