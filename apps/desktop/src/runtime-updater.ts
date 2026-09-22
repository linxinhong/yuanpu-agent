import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { PROTOCOL_VERSION, type RuntimeUpdateState } from '@yuanpu-agent/protocol';

const execFileAsync = promisify(execFile);
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_RUNTIME_BYTES = 512 * 1024 * 1024;
const DATABASE_FILES: ReadonlyArray<readonly [suffix: string, backupName: string]> = [
  ['', 'database'],
  ['-wal', 'database-wal'],
  ['-shm', 'database-shm'],
];

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

interface CurrentRuntime {
  version: string;
  executable: string;
}

interface PendingActivation {
  previous: CurrentRuntime | null;
  activated: CurrentRuntime;
  databaseBackup: boolean;
}

export interface RuntimeActivation {
  executable: string;
  version?: string;
  pending: boolean;
}

export interface RuntimeUpdaterOptions {
  runtimeRoot: string;
  desktopVersion: string;
  platform?: NodeJS.Platform;
  arch?: string;
  metadataDatabasePath?: string;
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

function isCurrentRuntime(value: unknown): value is CurrentRuntime {
  const runtime = value as Partial<CurrentRuntime> | null;
  return Boolean(
    runtime
    && typeof runtime.version === 'string'
    && VERSION_PATTERN.test(runtime.version)
    && typeof runtime.executable === 'string'
    && runtime.executable,
  );
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

  private get currentPath(): string {
    return join(this.options.runtimeRoot, 'current.json');
  }

  private get pendingActivationPath(): string {
    return join(this.options.runtimeRoot, 'activation-pending.json');
  }

  private get databaseBackupRoot(): string {
    return join(this.options.runtimeRoot, 'activation-database-backup');
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async backupMetadataDatabase(): Promise<boolean> {
    const databasePath = this.options.metadataDatabasePath;
    await rm(this.databaseBackupRoot, { recursive: true, force: true });
    if (!databasePath || !await this.pathExists(databasePath)) return false;
    if ((await lstat(databasePath)).isSymbolicLink()) {
      throw new Error('Refusing to back up a symbolic-link metadata database.');
    }
    await mkdir(this.databaseBackupRoot, { recursive: true });
    for (const [suffix, name] of DATABASE_FILES) {
      const source = `${databasePath}${suffix}`;
      if (await this.pathExists(source)) await copyFile(source, join(this.databaseBackupRoot, name));
    }
    return true;
  }

  private async restoreMetadataDatabase(required: boolean): Promise<void> {
    if (!required) {
      await rm(this.databaseBackupRoot, { recursive: true, force: true });
      return;
    }
    const databasePath = this.options.metadataDatabasePath;
    const databaseBackup = join(this.databaseBackupRoot, 'database');
    if (!databasePath || !await this.pathExists(databaseBackup)) {
      throw new Error('Runtime rollback database backup is unavailable.');
    }
    await mkdir(dirname(databasePath), { recursive: true });
    for (const [suffix, name] of DATABASE_FILES) {
      const backup = join(this.databaseBackupRoot, name);
      const destination = `${databasePath}${suffix}`;
      if (!await this.pathExists(backup)) {
        await rm(destination, { force: true });
        continue;
      }
      const temporary = `${destination}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await copyFile(backup, temporary);
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    await rm(this.databaseBackupRoot, { recursive: true, force: true });
  }

  private async writeJsonAtomically(path: string, value: unknown): Promise<void> {
    await mkdir(this.options.runtimeRoot, { recursive: true });
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async validateExecutable(path: string, version: string): Promise<void> {
    if (this.platform !== 'win32') await chmod(path, 0o755);
    const { stdout } = await execFileAsync(path, ['--version'], { timeout: 10_000 });
    if (normalizedExecutableVersion(stdout) !== version) {
      throw new Error('Runtime smoke test version mismatch');
    }
  }

  private async currentRuntime(): Promise<CurrentRuntime | undefined> {
    try {
      const current = JSON.parse(await readFile(this.currentPath, 'utf8')) as Partial<CurrentRuntime>;
      return isCurrentRuntime(current)
        ? { version: current.version, executable: current.executable }
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async pendingActivation(): Promise<PendingActivation | undefined> {
    try {
      const pending = JSON.parse(
        await readFile(this.pendingActivationPath, 'utf8'),
      ) as Partial<PendingActivation>;
      if (!isCurrentRuntime(pending.activated)) return undefined;
      if (pending.previous !== null && !isCurrentRuntime(pending.previous)) return undefined;
      if (typeof pending.databaseBackup !== 'boolean') return undefined;
      return {
        previous: pending.previous ?? null,
        activated: pending.activated,
        databaseBackup: pending.databaseBackup,
      };
    } catch {
      return undefined;
    }
  }

  private async recoverUnconfirmedActivation(): Promise<void> {
    const pending = await this.pendingActivation();
    if (!pending) {
      await rm(this.pendingActivationPath, { force: true });
      return;
    }
    await this.restoreMetadataDatabase(pending.databaseBackup);
    if (pending.previous) await this.writeJsonAtomically(this.currentPath, pending.previous);
    else await rm(this.currentPath, { force: true });
    await rm(this.pendingActivationPath, { force: true });
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

      const previous = await this.currentRuntime();
      const activated = { version: staged.version, executable: destination };
      const databaseBackup = await this.backupMetadataDatabase();
      await this.writeJsonAtomically(
        this.pendingActivationPath,
        { previous: previous ?? null, activated, databaseBackup },
      );
      await this.writeJsonAtomically(this.currentPath, activated);
      await rm(this.stagingRoot, { recursive: true, force: true });
    } catch {
      await rm(this.stagingRoot, { recursive: true, force: true });
    }
  }

  async prepareActivation(fallbackExecutable: string): Promise<RuntimeActivation> {
    // A previous launch that never confirmed health is treated as failed before
    // considering another staged update. This keeps crash loops on the last
    // known-good Runtime instead of repeatedly retrying an unconfirmed binary.
    await this.recoverUnconfirmedActivation();
    await this.promoteStaged();
    const current = await this.currentRuntime();
    const pending = await this.pendingActivation();
    return {
      executable: current?.executable ?? fallbackExecutable,
      ...(current ? { version: current.version } : {}),
      pending: Boolean(pending && pending.activated.executable === current?.executable),
    };
  }

  async confirmActivation(executable: string): Promise<void> {
    const pending = await this.pendingActivation();
    if (!pending || pending.activated.executable !== executable) return;
    await rm(this.pendingActivationPath, { force: true });
    await rm(this.databaseBackupRoot, { recursive: true, force: true });
  }

  async rollbackActivation(executable: string): Promise<string | undefined> {
    const pending = await this.pendingActivation();
    if (!pending || pending.activated.executable !== executable) {
      return (await this.currentRuntime())?.executable;
    }
    await this.restoreMetadataDatabase(pending.databaseBackup);
    if (pending.previous) await this.writeJsonAtomically(this.currentPath, pending.previous);
    else await rm(this.currentPath, { force: true });
    await rm(this.pendingActivationPath, { force: true });
    return pending.previous?.executable;
  }

  async activate(fallbackExecutable: string): Promise<string> {
    const activation = await this.prepareActivation(fallbackExecutable);
    await this.confirmActivation(activation.executable);
    return activation.executable;
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
