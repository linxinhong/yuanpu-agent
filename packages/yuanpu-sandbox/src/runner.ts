import { spawn } from 'node:child_process';
import { access, constants, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createMacOsProfile } from './macos.js';
import { assertSandboxPolicy, type SandboxPolicy } from './policy.js';
import { createWindowsRunnerArguments, resolveWindowsRunnerPath, windowsRunnerEnvironment } from './windows.js';

const MACOS_SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;

export type SandboxFailureCode = 'unsupported_platform' | 'unavailable' | 'aborted' | 'timeout' | 'output_limit' | 'spawn_failed';

export class SandboxExecutionError extends Error {
  constructor(readonly code: SandboxFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SandboxExecutionError';
  }
}

export interface SandboxRunOptions {
  command: string;
  args?: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** A deliberately minimal environment is used unless values are explicitly provided. */
  env?: Readonly<Record<string, string>>;
}

export interface SandboxRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export async function isSandboxAvailable(): Promise<boolean> {
  if (process.platform === 'darwin') {
    try {
      await access(MACOS_SANDBOX_EXEC, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  if (process.platform === 'win32') {
    try { resolveWindowsRunnerPath(); return true; } catch { return false; }
  }
  return false;
}

function boundedPositive(value: number | undefined, fallback: number, ceiling: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > ceiling) {
    throw new RangeError(`${name} must be an integer between 1 and ${ceiling}.`);
  }
  return result;
}

export async function runSandboxed(policy: SandboxPolicy, options: SandboxRunOptions): Promise<SandboxRunResult> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new SandboxExecutionError('unsupported_platform', 'This sandbox runner currently supports macOS and Windows only.');
  }
  if (!(await isSandboxAvailable())) {
    throw new SandboxExecutionError('unavailable', 'The platform sandbox backend is unavailable.');
  }
  await assertSandboxPolicy(policy);
  if (!isAbsolute(options.command)) throw new Error('Sandbox command must use an absolute path.');
  if (options.signal?.aborted) throw new SandboxExecutionError('aborted', 'Sandbox run was aborted.');
  const timeoutMs = boundedPositive(options.timeoutMs, DEFAULT_TIMEOUT_MS, 600_000, 'timeoutMs');
  const maxOutputBytes = boundedPositive(options.maxOutputBytes, DEFAULT_OUTPUT_LIMIT, 10 * 1024 * 1024, 'maxOutputBytes');
  let privateTempDirectory: string | undefined;
  try {
    let command: string;
    let args: string[];
    let env: NodeJS.ProcessEnv;
    if (process.platform === 'darwin') {
      command = MACOS_SANDBOX_EXEC;
      args = ['-p', createMacOsProfile(policy), options.command, ...(options.args ?? [])];
      env = {
        PATH: '/usr/bin:/bin', LANG: 'C', HOME: policy.workspaceRoot, TMPDIR: policy.workspaceRoot,
        ...options.env,
      };
    } else {
      if (policy.network !== 'host' || policy.privateTempWrites !== 'allow') {
        throw new SandboxExecutionError('unsupported_platform',
          'Windows ACL confinement requires network: host and privateTempWrites: allow explicitly.');
      }
      privateTempDirectory = await realpath(await mkdtemp(join(tmpdir(), 'yuanpu-sandbox-')));
      command = process.execPath;
      args = createWindowsRunnerArguments(policy, options, privateTempDirectory);
      env = windowsRunnerEnvironment(privateTempDirectory, options.env);
    }

    return await new Promise<SandboxRunResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: policy.workspaceRoot,
        detached: process.platform === 'darwin',
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
      let failure: SandboxExecutionError | undefined;
      let outputBytes = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const killGroup = () => {
        if (!child.pid) return;
        if (process.platform === 'win32') { child.kill('SIGKILL'); return; }
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      };
      const fail = (error: SandboxExecutionError) => {
        if (failure) return;
        failure = error;
        killGroup();
      };
      const onOutput = (chunk: Buffer, target: Buffer[]) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          fail(new SandboxExecutionError('output_limit', 'Sandbox output exceeded its byte limit.'));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on('data', (chunk: Buffer) => onOutput(chunk, stdout));
      child.stderr.on('data', (chunk: Buffer) => onOutput(chunk, stderr));
      const timer = setTimeout(() => fail(new SandboxExecutionError('timeout', 'Sandbox run timed out.')), timeoutMs);
      timer.unref();
      const abort = () => fail(new SandboxExecutionError('aborted', 'Sandbox run was aborted.'));
      options.signal?.addEventListener('abort', abort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      child.once('error', (error) => {
        cleanup();
        reject(new SandboxExecutionError('spawn_failed', 'Failed to start sandboxed command.', { cause: error }));
      });
      child.once('close', (exitCode, signal) => {
        cleanup();
        if (failure) reject(failure);
        else {
          const stderrText = Buffer.concat(stderr).toString('utf8');
          if (process.platform === 'win32' && exitCode === 127 && stderrText.includes('windows-acl-run:')) {
            reject(new SandboxExecutionError('spawn_failed', 'Windows ACL sandbox runner failed: ' + stderrText.trim()));
          } else {
            resolve({ exitCode, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: stderrText });
          }
        }
      });
    });
  } finally {
    if (privateTempDirectory) await rm(privateTempDirectory, { recursive: true, force: true });
  }
}
