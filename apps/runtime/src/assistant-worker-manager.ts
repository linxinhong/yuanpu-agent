import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isSea } from 'node:sea';
import { resolveAssistantModelConfig, type AssistantModelSelection } from './assistant-model.js';

export interface AssistantTaskRecord {
  id: string;
  sessionId?: string;
  status: 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed';
  message?: string;
  error?: string;
  updatedAt: string;
}

interface WorkerCommand { executable: string; args: string[] }

export interface AssistantWorkerManagerOptions {
  home: string;
  model: AssistantModelSelection;
  command?: WorkerCommand;
  startupTimeoutMs?: number;
  shutdownGraceMs?: number;
  onError?: (error: Error) => void;
}

function command(): WorkerCommand {
  return isSea()
    ? { executable: process.execPath, args: ['--assistant-worker'] }
    : { executable: process.execPath, args: [process.argv[1]!, '--assistant-worker'] };
}

/** The Runtime host owns one Assistant Worker; UI client attachment has no lifecycle authority. */
export class AssistantWorkerManager {
  private child?: ChildProcess;
  private ready = false;
  private shouldRun = false;
  private startPromise?: Promise<void>;
  private restartTimer?: NodeJS.Timeout;
  private restartCount = 0;
  private pending = new Map<string, { resolve(value: AssistantTaskRecord | undefined): void; reject(error: Error): void }>();

  constructor(private readonly options: AssistantWorkerManagerOptions) {}

  get workerPid(): number | undefined { return this.ready ? this.child?.pid : undefined; }

  private report(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private async launch(): Promise<void> {
    const selected = this.options.command ?? command();
    const child = spawn(selected.executable, selected.args, {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: { ...process.env, PI_CODING_AGENT_DIR: '', PI_CODING_AGENT_SESSION_DIR: '' },
    });
    this.child = child;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString(); });
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Assistant Worker startup timed out.')),
        this.options.startupTimeoutMs ?? 10_000);
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };
      child.once('error', (error) => settle(() => reject(error)));
      child.once('exit', (code, signal) => settle(() => reject(new Error(
        `Assistant Worker exited before readiness (${code ?? signal}): ${stderr}`,
      ))));
      child.on('message', (value: unknown) => {
        const message = value as Record<string, unknown>;
        if (!message || typeof message !== 'object') return;
        if (message.kind === 'ready') {
          this.ready = true;
          settle(resolve);
        } else if (message.kind === 'model-request' && typeof message.id === 'string') {
          void resolveAssistantModelConfig(this.options.model).then(
            (config) => child.send?.({ kind: 'model', id: message.id, config }),
            (error) => child.send?.({ kind: 'model', id: message.id,
              error: error instanceof Error ? error.message : String(error) }),
          );
        } else if ((message.kind === 'result' || message.kind === 'task') && typeof message.correlationId === 'string') {
          const pending = this.pending.get(message.correlationId);
          if (!pending) return;
          this.pending.delete(message.correlationId);
          if (typeof message.error === 'string') pending.reject(new Error(message.error));
          else pending.resolve(message.record as AssistantTaskRecord | undefined);
        }
      });
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.ready = false;
      this.rejectPending(new Error(`Assistant Worker exited (${code ?? signal}).`));
      if (this.shouldRun) {
        this.report(new Error(`Assistant Worker exited (${code ?? signal}).`));
        this.scheduleRestart();
      }
    });
    try {
      child.send({ kind: 'bootstrap', home: this.options.home, parentPid: process.pid });
      await ready;
      if (!this.shouldRun) throw new Error('Assistant Worker startup was cancelled.');
    } catch (error) {
      await this.terminate(child);
      throw error;
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer || !this.shouldRun) return;
    if (this.restartCount >= 3) {
      this.report(new Error('Assistant Worker restart budget exhausted.'));
      return;
    }
    const delay = 250 * (2 ** this.restartCount++);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.shouldRun) void this.start().catch((error) => this.report(error));
    }, delay);
    this.restartTimer.unref();
  }

  async start(): Promise<void> {
    this.shouldRun = true;
    if (this.ready) return;
    this.startPromise ??= this.launch().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  private request(message: Record<string, unknown>): Promise<AssistantTaskRecord | undefined> {
    if (!this.ready || !this.child?.connected) return Promise.reject(new Error('Assistant Worker is unavailable.'));
    const correlationId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(correlationId, { resolve, reject });
      this.child!.send({ ...message, correlationId }, (error) => {
        if (error) {
          this.pending.delete(correlationId);
          reject(error);
        }
      });
    });
  }

  async prompt(id: string, text: string, deadlineAt: number, sessionId?: string): Promise<AssistantTaskRecord> {
    const result = await this.request({ kind: 'prompt', id, text, deadlineAt, sessionId });
    if (!result) throw new Error('Assistant Worker did not return a task record.');
    return result;
  }

  task(id: string): Promise<AssistantTaskRecord | undefined> { return this.request({ kind: 'task', id }); }
  cancel(id: string): void { if (this.ready) this.child?.send({ kind: 'cancel', id }); }

  private async terminate(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.connected) child.send({ kind: 'shutdown' });
    const exited = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), this.options.shutdownGraceMs ?? 5_000);
      child.once('exit', () => { clearTimeout(timeout); resolve(true); });
    });
    if (exited) return;
    if (process.platform === 'win32') child.kill('SIGKILL');
    else try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }

  async stop(): Promise<void> {
    this.shouldRun = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const child = this.child;
    if (child) await this.terminate(child);
    await this.startPromise?.catch(() => undefined);
    const late = this.child;
    if (late && late !== child) await this.terminate(late);
    this.rejectPending(new Error('Assistant Worker stopped.'));
  }
}
