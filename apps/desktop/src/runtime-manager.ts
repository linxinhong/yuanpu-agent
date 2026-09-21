import {
  PROTOCOL_VERSION,
  RUNTIME_ROUTES,
  capabilityApprovalSigningPayload,
  type CapabilityApprovalDecisionInput,
  type CapabilityApprovalSummary,
  type ChatResponse,
  type InstalledPlugin,
  type LocalSkillList,
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
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_MANIFEST_URL =
  'https://github.com/linxinhong/yuanpu-agent/releases/latest/download/manifest.json';

interface RuntimeReady extends RuntimeInfo {
  event: 'ready';
  host: string;
  port: number;
}

interface RuntimeArtifact {
  filename: string;
  url: string;
  size: number;
  sha256: string;
}

interface RuntimeManifest {
  schemaVersion: number;
  protocolVersion: number;
  minDesktopVersion: string;
  version: string;
  platforms: Record<string, RuntimeArtifact>;
}

interface StagedRuntime {
  version: string;
  filename: string;
  sha256: string;
}

function versionParts(version: string): number[] {
  return version.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
}

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export class RuntimeManager {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: RuntimeReady;
  private readonly token = randomBytes(32).toString('hex');
  private readonly approvalKeyPair = generateKeyPairSync('ed25519');

  constructor(
    private readonly appPath: string,
    private readonly resourcesPath: string,
    private readonly userDataPath: string,
    private readonly packaged: boolean,
    private readonly desktopVersion: string,
  ) {}

  private get runtimeRoot(): string {
    return join(this.userDataPath, 'runtime');
  }

  private get executableName(): string {
    return process.platform === 'win32' ? 'YuanpuAgentRuntime.exe' : 'YuanpuAgentRuntime';
  }

  private async promoteStagedRuntime(): Promise<void> {
    const stagingRoot = join(this.runtimeRoot, '.staging');
    let staged: StagedRuntime;
    try {
      staged = JSON.parse(await readFile(join(stagingRoot, 'staged.json'), 'utf8')) as StagedRuntime;
    } catch {
      return;
    }

    const expectedStagedName = process.platform === 'win32' ? 'runtime.exe' : 'runtime';
    if (
      staged.filename !== expectedStagedName ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(staged.version)
    ) {
      await rm(stagingRoot, { recursive: true, force: true });
      return;
    }

    const versionRoot = join(this.runtimeRoot, 'versions', staged.version);
    const destination = join(versionRoot, this.executableName);
    const stagedPath = join(stagingRoot, staged.filename);
    try {
      const stagedBytes = await readFile(stagedPath);
      const checksum = createHash('sha256').update(stagedBytes).digest('hex');
      if (checksum !== staged.sha256) throw new Error('Staged runtime checksum mismatch');
      if (process.platform !== 'win32') await chmod(stagedPath, 0o755);
      const { stdout } = await execFileAsync(stagedPath, ['--version'], { timeout: 10_000 });
      if (stdout.trim() !== staged.version) throw new Error('Staged runtime version mismatch');
    } catch {
      await rm(stagingRoot, { recursive: true, force: true });
      return;
    }

    await mkdir(versionRoot, { recursive: true });
    await rm(destination, { force: true });
    await rename(stagedPath, destination);
    if (process.platform !== 'win32') await chmod(destination, 0o755);
    await writeFile(
      join(this.runtimeRoot, 'current.json'),
      `${JSON.stringify({ version: staged.version, executable: destination }, null, 2)}\n`,
    );
    await rm(stagingRoot, { recursive: true, force: true });
  }

  private async managedExecutable(): Promise<string | undefined> {
    try {
      const current = JSON.parse(
        await readFile(join(this.runtimeRoot, 'current.json'), 'utf8'),
      ) as { executable: string };
      return current.executable;
    } catch {
      return undefined;
    }
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
    await this.promoteStagedRuntime();
    return { executable: (await this.managedExecutable()) ?? this.packagedExecutable(), args: [] };
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
  ): Promise<CapabilityApprovalSummary> {
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

  installPlugin(source: string): Promise<InstalledPlugin> {
    return this.request(RUNTIME_ROUTES.pluginInstall, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source }),
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

  async checkForUpdate(): Promise<RuntimeUpdateState> {
    try {
      const current = await this.info();
      const manifestUrl = process.env.YUANPU_RUNTIME_MANIFEST_URL || DEFAULT_MANIFEST_URL;
      const response = await fetch(manifestUrl, { redirect: 'follow' });
      if (!response.ok) throw new Error(`Manifest request failed with HTTP ${response.status}`);
      const manifest = (await response.json()) as RuntimeManifest;
      if (manifest.schemaVersion !== 1 || manifest.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error('Update manifest is incompatible with this desktop version');
      }
      if (compareVersions(this.desktopVersion, manifest.minDesktopVersion) < 0) {
        throw new Error(`Desktop ${manifest.minDesktopVersion} or newer is required`);
      }
      if (compareVersions(manifest.version, current.version) <= 0) {
        return { status: 'current', currentVersion: current.version };
      }

      const artifact = manifest.platforms[`${process.platform}-${process.arch}`];
      if (!artifact) throw new Error('No runtime update is available for this platform');
      const download = await fetch(new URL(artifact.url, response.url), { redirect: 'follow' });
      if (!download.ok) throw new Error(`Runtime download failed with HTTP ${download.status}`);
      const bytes = Buffer.from(await download.arrayBuffer());
      if (bytes.byteLength !== artifact.size) throw new Error('Runtime download size mismatch');
      const checksum = createHash('sha256').update(bytes).digest('hex');
      if (checksum !== artifact.sha256) throw new Error('Runtime download checksum mismatch');

      const stagingRoot = join(this.runtimeRoot, '.staging');
      const stagedName = process.platform === 'win32' ? 'runtime.exe' : 'runtime';
      const stagedPath = join(stagingRoot, stagedName);
      await rm(stagingRoot, { recursive: true, force: true });
      await mkdir(stagingRoot, { recursive: true });
      await writeFile(stagedPath, bytes);
      if (process.platform !== 'win32') await chmod(stagedPath, 0o755);
      const { stdout } = await execFileAsync(stagedPath, ['--version'], { timeout: 10_000 });
      if (stdout.trim() !== manifest.version) throw new Error('Runtime smoke test version mismatch');
      await writeFile(
        join(stagingRoot, 'staged.json'),
        `${JSON.stringify(
          { version: manifest.version, filename: stagedName, sha256: artifact.sha256 },
          null,
          2,
        )}\n`,
      );
      return {
        status: 'ready',
        currentVersion: current.version,
        availableVersion: manifest.version,
        message: 'Runtime update is staged and will activate after restart.',
      };
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }

  stop(): void {
    this.child?.kill();
    this.child = undefined;
    this.ready = undefined;
  }
}
