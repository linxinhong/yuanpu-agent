import {
  PROTOCOL_VERSION,
  RUNTIME_ROUTES,
  capabilityApprovalSigningPayload,
  type CapabilityApprovalDecisionInput,
  type CapabilityApprovalDecisionResult,
  type CapabilityApprovalSummary,
  type ChatResponse,
  type InstalledPlugin,
  type LocalSkillList,
  type McpOwnershipConflict,
  type PluginConfigDocument,
  type PluginConfigInput,
  type PluginConfigScope,
  type PluginConfigValidation,
  type PluginSearchResult,
  type RuntimeGreeting,
  type RuntimeInfo,
  type RuntimeUpdateState,
} from '@yuanpu-agent/protocol';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { RuntimeUpdater, type RuntimeActivation } from './runtime-updater.js';

const DEFAULT_MANIFEST_URL =
  'https://github.com/linxinhong/yuanpu-agent/releases/latest/download/manifest.json';

interface RuntimeReady extends RuntimeInfo {
  event: 'ready';
  host: string;
  port: number;
}

interface RuntimeCommand extends RuntimeActivation {
  args: string[];
}

export interface RuntimeManagerOptions {
  command?: { executable: string; args: string[] };
  startupTimeoutMs?: number;
  shutdownGraceMs?: number;
  restartLimit?: number;
  restartWindowMs?: number;
  restartBaseDelayMs?: number;
  activationStabilityMs?: number;
  onError?: (error: Error) => void;
}

const execFileAsync = promisify(execFile);

export class RuntimeManager {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: RuntimeReady;
  private startPromise?: Promise<RuntimeReady>;
  private stopPromise?: Promise<void>;
  private restartTimer?: NodeJS.Timeout;
  private activationConfirmationTimer?: NodeJS.Timeout;
  private restartAttempts: number[] = [];
  private shouldRun = false;
  private readonly token = randomBytes(32).toString('hex');
  private readonly approvalKeyPair = generateKeyPairSync('ed25519');
  private readonly updater: RuntimeUpdater;
  private readonly options: Required<Omit<RuntimeManagerOptions, 'command' | 'onError'>>
    & Pick<RuntimeManagerOptions, 'command' | 'onError'>;

  constructor(
    private readonly appPath: string,
    private readonly resourcesPath: string,
    private readonly userDataPath: string,
    private readonly packaged: boolean,
    desktopVersion: string,
    options: RuntimeManagerOptions = {},
  ) {
    const yuanpuHome = resolve(process.env.YUANPU_HOME || join(homedir(), '.yuanpu'));
    this.updater = new RuntimeUpdater({
      runtimeRoot: this.runtimeRoot,
      desktopVersion,
      metadataDatabasePath: join(yuanpuHome, 'workflows', 'automation.sqlite'),
    });
    this.options = {
      command: options.command,
      startupTimeoutMs: options.startupTimeoutMs ?? 15_000,
      shutdownGraceMs: options.shutdownGraceMs ?? 10_000,
      restartLimit: options.restartLimit ?? 3,
      restartWindowMs: options.restartWindowMs ?? 60_000,
      restartBaseDelayMs: options.restartBaseDelayMs ?? 250,
      activationStabilityMs: options.activationStabilityMs ?? 2_000,
      onError: options.onError,
    };
  }

  private get runtimeRoot(): string {
    return join(this.userDataPath, 'runtime');
  }

  private packagedExecutable(): string {
    const target = `${process.platform}-${process.arch}`;
    const suffix = process.platform === 'win32' ? '.exe' : '';
    return join(this.resourcesPath, 'runtime', `YuanpuAgentRuntime-${target}${suffix}`);
  }

  private async command(): Promise<RuntimeCommand> {
    if (this.options.command) return { ...this.options.command, pending: false };
    if (!this.packaged) {
      return {
        executable: process.env.YUANPU_NODE_BINARY || 'node',
        args: [resolve(this.appPath, '../runtime/dist/index.cjs')],
        pending: false,
      };
    }
    return { ...(await this.updater.prepareActivation(this.packagedExecutable())), args: [] };
  }

  private capabilityEnvironment(): NodeJS.ProcessEnv {
    if (this.packaged) {
      const root = join(this.resourcesPath, 'capabilities', 'builtin.python.echo', 'YuanpuEchoMcp');
      return {
        YUANPU_PYTHON_MCP_EXECUTABLE: join(root, process.platform === 'win32' ? 'YuanpuEchoMcp.exe' : 'YuanpuEchoMcp'),
        YUANPU_PYTHON_MCP_ROOT: root,
        YUANPU_PYTHON_MCP_ARGS: '[]',
        YUANPU_CAPABILITY_TRUST_ROOT_FILE: join(
          this.resourcesPath,
          'capabilities',
          'builtin.python.echo',
          'trust-root.json',
        ),
      };
    }
    const pythonRoot = resolve(this.appPath, '../python-capabilities');
    return {
      YUANPU_PYTHON_MCP_EXECUTABLE: process.platform === 'win32'
        ? join(pythonRoot, '.venv', 'Scripts', 'python.exe')
        : join(pythonRoot, '.venv', 'bin', 'python'),
      YUANPU_PYTHON_MCP_ROOT: pythonRoot,
      YUANPU_PYTHON_MCP_ARGS: JSON.stringify(['-m', 'yuanpu_echo_mcp']),
      ...(process.env.YUANPU_CAPABILITY_TRUST_ROOT_FILE
        ? { YUANPU_CAPABILITY_TRUST_ROOT_FILE: process.env.YUANPU_CAPABILITY_TRUST_ROOT_FILE }
        : {}),
    };
  }

  private reportError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (this.options.onError) this.options.onError(normalized);
    else console.error(normalized.message);
  }

  private async waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise<boolean>((resolveExit) => {
      const timeout = setTimeout(() => {
        child.off('exit', onExit);
        resolveExit(false);
      }, timeoutMs);
      const onExit = () => {
        clearTimeout(timeout);
        resolveExit(true);
      };
      child.once('exit', onExit);
    });
  }

  private async forceTerminate(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        timeout: 5_000,
        windowsHide: true,
      }).catch(() => child.kill('SIGKILL'));
      return;
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }

  private async terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    if (await this.waitForExit(child, this.options.shutdownGraceMs)) return;
    await this.forceTerminate(child);
    await this.waitForExit(child, 1_000);
  }

  private scheduleRestart(): void {
    if (!this.shouldRun || this.restartTimer) return;
    const now = Date.now();
    const cutoff = now - this.options.restartWindowMs;
    this.restartAttempts = this.restartAttempts.filter((attempt) => attempt >= cutoff);
    if (this.restartAttempts.length >= this.options.restartLimit) {
      this.reportError(new Error('Runtime restart budget is exhausted; restart the App to retry.'));
      return;
    }
    const attempt = this.restartAttempts.length;
    this.restartAttempts.push(now);
    const delay = this.options.restartBaseDelayMs * (2 ** attempt);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (!this.shouldRun) return;
      void this.start().catch((error) => {
        this.reportError(error);
        this.scheduleRestart();
      });
    }, delay);
    this.restartTimer.unref();
  }

  private scheduleActivationConfirmation(
    child: ChildProcessWithoutNullStreams,
    executable: string,
  ): void {
    if (this.activationConfirmationTimer) clearTimeout(this.activationConfirmationTimer);
    this.activationConfirmationTimer = setTimeout(() => {
      this.activationConfirmationTimer = undefined;
      if (!this.shouldRun || this.child !== child || !this.ready || child.exitCode !== null) return;
      void this.updater.confirmActivation(executable).catch((error) => this.reportError(error));
    }, this.options.activationStabilityMs);
    this.activationConfirmationTimer.unref();
  }

  private async launch(command: RuntimeCommand): Promise<{ child: ChildProcessWithoutNullStreams; ready: RuntimeReady }> {
    if (!this.shouldRun) throw new Error('Runtime start was cancelled because the App is stopping.');
    const child = await new Promise<ChildProcessWithoutNullStreams>((resolveSpawn, rejectSpawn) => {
      const child = spawn(
        command.executable,
        [...command.args, '--serve', '--port', '0'],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
          env: { ...process.env, ...this.capabilityEnvironment() },
        },
      );
      child.once('spawn', () => resolveSpawn(child));
      child.once('error', rejectSpawn);
    });
    this.child = child;
    if (!this.shouldRun) {
      await this.terminate(child);
      throw new Error('Runtime start was cancelled because the App is stopping.');
    }
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString();
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      if (this.activationConfirmationTimer) clearTimeout(this.activationConfirmationTimer);
      this.activationConfirmationTimer = undefined;
      const wasReady = Boolean(this.ready);
      this.child = undefined;
      this.ready = undefined;
      if (code && code !== 0) {
        this.reportError(new Error(`Runtime exited with code ${code}: ${stderr}`));
      } else if (signal && this.shouldRun) {
        this.reportError(new Error(`Runtime exited from signal ${signal}.`));
      }
      if (wasReady && this.shouldRun) this.scheduleRestart();
    });

    try {
      const approvalPublicKey = this.approvalKeyPair.publicKey.export({
        type: 'spki',
        format: 'der',
      }).toString('base64');
      child.stdin.end(`${JSON.stringify({
        token: this.token,
        approvalPublicKey,
        parentPid: process.pid,
      })}\n`);
      let stdout = '';
      const ready = await new Promise<RuntimeReady>((resolveReady, rejectReady) => {
        let settled = false;
        const settle = (callback: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          callback();
        };
        const timeout = setTimeout(() => {
          settle(() => rejectReady(new Error(`Runtime startup timed out: ${stderr}`)));
        }, this.options.startupTimeoutMs);
        child.stdout.on('data', (chunk: Buffer) => {
          if (settled) return;
          stdout += chunk.toString();
          if (stdout.length > 64 * 1024) {
            settle(() => rejectReady(new Error('Runtime startup response exceeded 64 KiB.')));
            return;
          }
          const lineEnd = stdout.indexOf('\n');
          if (lineEnd < 0) return;
          try {
            const value = JSON.parse(stdout.slice(0, lineEnd)) as RuntimeReady;
            if (value.event !== 'ready') throw new Error('Runtime returned an invalid readiness event.');
            if (value.protocolVersion !== PROTOCOL_VERSION) {
              throw new Error(
                `Runtime protocol is incompatible: desktop expects ${PROTOCOL_VERSION}, Runtime reported ${String(value.protocolVersion)}.`,
              );
            }
            if (command.version && value.version !== command.version) {
              throw new Error(
                `Runtime update health check expected version ${command.version}, but Runtime reported ${String(value.version)}.`,
              );
            }
            settle(() => resolveReady(value));
          } catch (error) {
            settle(() => rejectReady(error));
          }
        });
        child.once('error', (error) => settle(() => rejectReady(error)));
        child.once('exit', (code, signal) => settle(() => rejectReady(new Error(
          `Runtime exited before becoming healthy (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
        ))));
      });
      const response = await fetch(`http://${ready.host}:${ready.port}${RUNTIME_ROUTES.health}`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(this.options.startupTimeoutMs),
      });
      if (!response.ok) throw new Error(`Runtime health check failed with HTTP ${response.status}.`);
      const health = await response.json() as RuntimeInfo;
      if (health.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(
          `Runtime protocol is incompatible: desktop expects ${PROTOCOL_VERSION}, health reported ${String(health.protocolVersion)}.`,
        );
      }
      if (command.version && health.version !== command.version) {
        throw new Error(
          `Runtime update health check expected version ${command.version}, but health reported ${String(health.version)}.`,
        );
      }
      return { child, ready };
    } catch (error) {
      await this.terminate(child);
      throw error;
    }
  }

  private async startInternal(): Promise<RuntimeReady> {
    let command = await this.command();
    if (!this.shouldRun) throw new Error('Runtime start was cancelled because the App is stopping.');
    try {
      const launched = await this.launch(command);
      if (this.child !== launched.child || launched.child.exitCode !== null) {
        throw new Error('Runtime exited before activation health was confirmed.');
      }
      this.ready = launched.ready;
      if (command.pending) {
        this.scheduleActivationConfirmation(launched.child, command.executable);
      }
      return launched.ready;
    } catch (error) {
      if (!command.pending) throw error;
      if (this.child) await this.terminate(this.child);
      const previous = await this.updater.rollbackActivation(command.executable);
      command = {
        executable: previous ?? this.packagedExecutable(),
        args: [],
        pending: false,
      };
      try {
        const launched = await this.launch(command);
        if (this.child !== launched.child || launched.child.exitCode !== null) {
          throw new Error('Restored Runtime exited before health was confirmed.');
        }
        this.ready = launched.ready;
        this.reportError(new Error(
          `Runtime update failed and the previous version was restored: ${error instanceof Error ? error.message : String(error)}`,
        ));
        return launched.ready;
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Runtime update failed and the previous Runtime could not be restored.',
        );
      }
    }
  }

  async start(): Promise<RuntimeReady> {
    if (this.stopPromise) await this.stopPromise;
    this.shouldRun = true;
    if (this.ready) return this.ready;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const runtime = await this.start();
    const response = await fetch(`http://${runtime.host}:${runtime.port}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...init?.headers,
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string; hint?: string };
      throw new Error([body.error || `Runtime request failed with HTTP ${response.status}`, body.hint]
        .filter(Boolean).join(' '));
    }
    return (await response.json()) as T;
  }

  info(): Promise<RuntimeInfo> {
    return this.request(RUNTIME_ROUTES.health);
  }

  listCapabilityApprovals(): Promise<CapabilityApprovalSummary[]> {
    return this.request(RUNTIME_ROUTES.capabilityApprovals);
  }

  decideCapabilityApproval(
    requestId: string,
    decision: CapabilityApprovalDecisionInput['decision'],
  ): Promise<CapabilityApprovalDecisionResult> {
    const unsigned = {
      requestId,
      decision,
      issuedAt: Date.now(),
      nonce: randomBytes(16).toString('base64url'),
    };
    const input: CapabilityApprovalDecisionInput = {
      ...unsigned,
      signature: sign(
        null,
        capabilityApprovalSigningPayload(unsigned),
        this.approvalKeyPair.privateKey,
      ).toString('base64url'),
    };
    return this.request(RUNTIME_ROUTES.capabilityApprovalDecision, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  greeting(name: string): Promise<RuntimeGreeting> {
    return this.request(`${RUNTIME_ROUTES.greeting}?name=${encodeURIComponent(name)}`);
  }

  chat(message: string): Promise<ChatResponse> {
    return this.request(RUNTIME_ROUTES.chat, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
  }

  searchPlugins(query: string): Promise<PluginSearchResult[]> {
    return this.request(`${RUNTIME_ROUTES.pluginSearch}?q=${encodeURIComponent(query)}`);
  }

  listPlugins(): Promise<InstalledPlugin[]> {
    return this.request(RUNTIME_ROUTES.plugins);
  }

  listLocalSkills(): Promise<LocalSkillList> {
    return this.request(RUNTIME_ROUTES.localSkills);
  }

  installPlugin(source: string, artifactManifestDigest?: string): Promise<InstalledPlugin> {
    return this.request(RUNTIME_ROUTES.pluginInstall, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source, artifactManifestDigest }),
    });
  }

  setPluginEnabled(name: string, enabled: boolean): Promise<InstalledPlugin> {
    return this.request(RUNTIME_ROUTES.pluginState, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, enabled }),
    });
  }

  async uninstallPlugin(name: string): Promise<void> {
    await this.request(RUNTIME_ROUTES.pluginUninstall, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  }

  getPluginConfig(name: string, scope: PluginConfigScope): Promise<PluginConfigDocument> {
    return this.request(
      `${RUNTIME_ROUTES.pluginConfig}?name=${encodeURIComponent(name)}&scope=${encodeURIComponent(scope)}`,
    );
  }

  validatePluginConfig(input: PluginConfigInput): Promise<PluginConfigValidation> {
    return this.request(RUNTIME_ROUTES.pluginConfigValidate, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  savePluginConfig(input: PluginConfigInput): Promise<PluginConfigDocument> {
    return this.request(RUNTIME_ROUTES.pluginConfigSave, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  resetPluginConfig(name: string, scope: PluginConfigScope): Promise<PluginConfigDocument> {
    return this.request(RUNTIME_ROUTES.pluginConfigReset, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, scope }),
    });
  }

  rollbackPlugin(name: string, version: string): Promise<InstalledPlugin> {
    return this.request(RUNTIME_ROUTES.pluginRollback, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, version }),
    });
  }

  listMcpOwnershipConflicts(
    source: string,
    artifactManifestDigest: string,
  ): Promise<McpOwnershipConflict[]> {
    return this.request(
      `${RUNTIME_ROUTES.pluginMcpConflicts}?source=${encodeURIComponent(source)}&manifestDigest=${encodeURIComponent(artifactManifestDigest)}`,
    );
  }

  async checkForUpdate(): Promise<RuntimeUpdateState> {
    const current = await this.info();
    return this.updater.stage(
      current.version,
      process.env.YUANPU_RUNTIME_MANIFEST_URL || DEFAULT_MANIFEST_URL,
    );
  }

  async stop(): Promise<void> {
    this.shouldRun = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    if (this.activationConfirmationTimer) clearTimeout(this.activationConfirmationTimer);
    this.activationConfirmationTimer = undefined;
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      const initialChild = this.child;
      if (initialChild) await this.terminate(initialChild);
      await this.startPromise?.catch(() => undefined);
      const lateChild = this.child;
      if (lateChild && lateChild !== initialChild) await this.terminate(lateChild);
      this.child = undefined;
      this.ready = undefined;
    })().finally(() => {
      this.stopPromise = undefined;
    });
    return this.stopPromise;
  }
}
