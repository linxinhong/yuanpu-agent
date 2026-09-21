import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { PROTOCOL_VERSION, type RuntimeUpdateState } from '@yuanpu-agent/protocol';

const execFileAsync = promisify(execFile);
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_RUNTIME_BYTES = 512 * 1024 * 1024;

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

export interface RuntimeUpdaterOptions {
  runtimeRoot: string;
  desktopVersion: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

function versionParts(version: string): number[] {
  return version.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
}

export function compareRuntimeVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function normalizedExecutableVersion(stdout: string): string {
  return stdout.trim().replace(/^v/, '');
}

export class RuntimeUpdater {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;

  constructor(private readonly options: RuntimeUpdaterOptions) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
  }

  private get stagingRoot(): string {
    return join(this.options.runtimeRoot, '.staging');
  }

  private get executableName(): string {
    return this.platform === 'win32' ? 'YuanpuAgentRuntime.exe' : 'YuanpuAgentRuntime';
  }

  private get stagedName(): string {
    return this.platform === 'win32' ? 'runtime.exe' : 'runtime';
  }

  private async validateExecutable(path: string, version: string): Promise<void> {
    if (this.platform !== 'win32') await chmod(path, 0o755);
    const { stdout } = await execFileAsync(path, ['--version'], { timeout: 10_000 });
    if (normalizedExecutableVersion(stdout) !== version) {
      throw new Error('Runtime smoke test version mismatch');
    }
  }

  private async managedExecutable(): Promise<string | undefined> {
    try {
      const current = JSON.parse(
        await readFile(join(this.options.runtimeRoot, 'current.json'), 'utf8'),
      ) as { executable?: unknown };
      return typeof current.executable === 'string' ? current.executable : undefined;
    } catch {
      return undefined;
    }
  }

  private async promoteStaged(): Promise<void> {
    let staged: StagedRuntime;
    try {
      staged = JSON.parse(
        await readFile(join(this.stagingRoot, 'staged.json'), 'utf8'),
      ) as StagedRuntime;
    } catch {
      await rm(this.stagingRoot, { recursive: true, force: true });
      return;
    }

    if (
      staged.filename !== this.stagedName
      || !VERSION_PATTERN.test(staged.version)
      || !/^[a-f0-9]{64}$/.test(staged.sha256)
    ) {
      await rm(this.stagingRoot, { recursive: true, force: true });
      return;
    }

    const stagedPath = join(this.stagingRoot, staged.filename);
    const versionRoot = join(this.options.runtimeRoot, 'versions', staged.version);
    const destination = join(versionRoot, this.executableName);
    try {
      const bytes = await readFile(stagedPath);
      const checksum = createHash('sha256').update(bytes).digest('hex');
      if (checksum !== staged.sha256) throw new Error('Staged runtime checksum mismatch');
      await this.validateExecutable(stagedPath, staged.version);

      await mkdir(versionRoot, { recursive: true });
      await rm(destination, { force: true });
      await rename(stagedPath, destination);
      if (this.platform !== 'win32') await chmod(destination, 0o755);

      const currentPath = join(this.options.runtimeRoot, 'current.json');
      const temporaryCurrent = `${currentPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(
          temporaryCurrent,
          `${JSON.stringify({ version: staged.version, executable: destination }, null, 2)}\n`,
          { flag: 'wx' },
        );
        await rename(temporaryCurrent, currentPath);
      } finally {
        await rm(temporaryCurrent, { force: true });
      }
      await rm(this.stagingRoot, { recursive: true, force: true });
    } catch {
      await rm(this.stagingRoot, { recursive: true, force: true });
    }
  }

  async activate(fallbackExecutable: string): Promise<string> {
    await this.promoteStaged();
    return (await this.managedExecutable()) ?? fallbackExecutable;
  }

  async stage(currentVersion: string, manifestUrl: string): Promise<RuntimeUpdateState> {
    try {
      const response = await fetch(manifestUrl, { redirect: 'follow' });
      if (!response.ok) throw new Error(`Manifest request failed with HTTP ${response.status}`);
      const manifest = (await response.json()) as RuntimeManifest;
      if (
        manifest.schemaVersion !== 1
        || manifest.protocolVersion !== PROTOCOL_VERSION
        || !VERSION_PATTERN.test(manifest.version)
        || !VERSION_PATTERN.test(manifest.minDesktopVersion)
      ) {
        throw new Error('Update manifest is incompatible with this desktop version');
      }
      if (compareRuntimeVersions(this.options.desktopVersion, manifest.minDesktopVersion) < 0) {
        throw new Error(`Desktop ${manifest.minDesktopVersion} or newer is required`);
      }
      if (compareRuntimeVersions(manifest.version, currentVersion) <= 0) {
        return { status: 'current', currentVersion };
      }

      const artifact = manifest.platforms[`${this.platform}-${this.arch}`];
      if (
        !artifact
        || !Number.isSafeInteger(artifact.size)
        || artifact.size <= 0
        || artifact.size > MAX_RUNTIME_BYTES
        || !/^[a-f0-9]{64}$/.test(artifact.sha256)
      ) {
        throw new Error('No valid runtime update is available for this platform');
      }

      const download = await fetch(new URL(artifact.url, response.url), { redirect: 'follow' });
      if (!download.ok) throw new Error(`Runtime download failed with HTTP ${download.status}`);
      const bytes = Buffer.from(await download.arrayBuffer());
      if (bytes.byteLength !== artifact.size) throw new Error('Runtime download size mismatch');
      const checksum = createHash('sha256').update(bytes).digest('hex');
      if (checksum !== artifact.sha256) throw new Error('Runtime download checksum mismatch');

      await rm(this.stagingRoot, { recursive: true, force: true });
      await mkdir(this.stagingRoot, { recursive: true });
      const stagedPath = join(this.stagingRoot, this.stagedName);
      try {
        await writeFile(stagedPath, bytes, { flag: 'wx' });
        await this.validateExecutable(stagedPath, manifest.version);
        await writeFile(
          join(this.stagingRoot, 'staged.json'),
          `${JSON.stringify(
            { version: manifest.version, filename: this.stagedName, sha256: artifact.sha256 },
            null,
            2,
          )}\n`,
          { flag: 'wx' },
        );
      } catch (error) {
        await rm(this.stagingRoot, { recursive: true, force: true });
        throw error;
      }

      return {
        status: 'ready',
        currentVersion,
        availableVersion: manifest.version,
        message: 'Runtime update is staged and will activate after restart.',
      };
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }
}
