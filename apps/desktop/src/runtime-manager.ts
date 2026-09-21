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
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { join, resolve } from 'node:path';

import { RuntimeUpdater } from './runtime-updater.js';

const DEFAULT_MANIFEST_URL =
  'https://github.com/linxinhong/yuanpu-agent/releases/latest/download/manifest.json';

interface RuntimeReady extends RuntimeInfo {
  event: 'ready';
  host: string;
  port: number;
}

export class RuntimeManager {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: RuntimeReady;
  private readonly token = randomBytes(32).toString('hex');
  private readonly approvalKeyPair = generateKeyPairSync('ed25519');
  private readonly updater: RuntimeUpdater;

  constructor(
    private readonly appPath: string,
    private readonly resourcesPath: string,
    private readonly userDataPath: string,
    private readonly packaged: boolean,
    desktopVersion: string,
  ) {
    this.updater = new RuntimeUpdater({ runtimeRoot: this.runtimeRoot, desktopVersion });
  }

  private get runtimeRoot(): string {
    return join(this.userDataPath, 'runtime');
  }

  private packagedExecutable(): string {
    const target = `${process.platform}-${process.arch}`;
    const suffix = process.platform === 'win32' ? '.exe' : '';
    return join(this.resourcesPath, 'runtime', `YuanpuAgentRuntime-${target}${suffix}`);
  }

  private async command(): Promise<{ executable: string; args: string[] }> {
    if (!this.packaged) {
      return {
        executable: process.env.YUANPU_NODE_BINARY || 'node',
        args: [resolve(this.appPath, '../runtime/dist/index.cjs')],
      };
    }
    return { executable: await this.updater.activate(this.packagedExecutable()), args: [] };
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

  async start(): Promise<RuntimeReady> {
    if (this.ready) return this.ready;
    const command = await this.command();

    return await new Promise<RuntimeReady>((resolveReady, reject) => {
      const child = spawn(
        command.executable,
        [...command.args, '--serve', '--port', '0'],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: { ...process.env, ...this.capabilityEnvironment() },
        },
      );
      const approvalPublicKey = this.approvalKeyPair.publicKey.export({
        type: 'spki',
        format: 'der',
      }).toString('base64');
      child.stdin.end(`${JSON.stringify({ token: this.token, approvalPublicKey })}\n`);
      this.child = child;
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`Runtime startup timed out: ${stderr}`));
      }, 10_000);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        const lineEnd = stdout.indexOf('\n');
        if (lineEnd < 0) return;
        try {
          const ready = JSON.parse(stdout.slice(0, lineEnd)) as RuntimeReady;
          if (ready.event !== 'ready' || ready.protocolVersion !== PROTOCOL_VERSION) {
            throw new Error('Runtime protocol is incompatible');
          }
          clearTimeout(timeout);
          this.ready = ready;
          resolveReady(ready);
        } catch (error) {
          clearTimeout(timeout);
          child.kill();
          reject(error);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code) => {
        this.ready = undefined;
        if (code && code !== 0) console.error(`Runtime exited with code ${code}: ${stderr}`);
      });
    });
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

  stop(): void {
    this.child?.kill();
    this.child = undefined;
    this.ready = undefined;
  }
}
