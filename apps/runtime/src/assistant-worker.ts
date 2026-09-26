import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AssistantAutomationEngine, AssistantAutomationStore, AssistantMemoryRepository,
  assertSafeDirectory, createAssistantExecutor, resolveAssistantHome,
  type AssistantDelegationHost, type AssistantSession, type AssistantSourceHost } from '@yuanpu-agent/assistant';
import { assistantAutomationHandler } from './assistant-automation-handler.js';
import type { AssistantDelegationRecord } from '@yuanpu-agent/protocol';
import { assistantModelHost, type AssistantModelConfig } from './assistant-model.js';
import { bundledAssistantSkillFiles } from './assistant-skill-assets.generated.js';
import { installParentProcessMonitor, type ParentProcessMonitor } from './process-lifecycle.js';

interface TaskRecord {
  id: string;
  sessionId?: string;
  status: 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed';
  message?: string;
  error?: string;
  updatedAt: string;
}

type HostMessage =
  | { kind: 'bootstrap'; home: string; parentPid: number }
  | { kind: 'model'; id: string; config?: AssistantModelConfig; error?: string }
  | { kind: 'source-result'; id: string; value?: unknown; error?: string }
  | { kind: 'delegation-result'; id: string; value?: unknown; error?: string }
  | { kind: 'delegation-event'; record: AssistantDelegationRecord }
  | { kind: 'prompt'; id: string; correlationId: string; sessionId?: string; text: string; deadlineAt: number }
  | { kind: 'cancel'; id: string }
  | { kind: 'task'; id: string; correlationId: string }
  | { kind: 'shutdown' };

function send(message: Record<string, unknown>): void {
  if (process.connected) process.send?.(message);
}

function validId(id: string): boolean { return /^[a-zA-Z0-9_-]{1,128}$/.test(id); }

async function saveTask(directory: string, record: TaskRecord): Promise<void> {
  const path = join(directory, `${record.id}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readTask(directory: string, id: string): Promise<TaskRecord | undefined> {
  if (!validId(id)) throw new Error('Invalid assistant task ID.');
  try { return JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')) as TaskRecord; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function acquireHomeLock(home: string): Promise<DatabaseSync> {
  const paths = resolveAssistantHome(home);
  await assertSafeDirectory(paths.root);
  const path = join(paths.root, '.writer-lock.sqlite');
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Assistant Home lock path is not a real file.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN EXCLUSIVE');
    return db;
  } catch (error) {
    db.close();
    throw new Error('Assistant Home already has a writer.', { cause: error });
  }
}

/** Private process mode: the Runtime host remains the only source of model credentials. */
export async function runAssistantWorker(): Promise<void> {
  const bootstrap = await new Promise<Extract<HostMessage, { kind: 'bootstrap' }>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Assistant Worker bootstrap timed out.')), 10_000);
    process.once('message', (value: unknown) => {
      clearTimeout(timeout);
      if (!value || typeof value !== 'object' || (value as { kind?: unknown }).kind !== 'bootstrap') {
        reject(new Error('Invalid Assistant Worker bootstrap.'));
      } else resolve(value as Extract<HostMessage, { kind: 'bootstrap' }>);
    });
  });
  if (!Number.isSafeInteger(bootstrap.parentPid) || bootstrap.parentPid <= 1
    || typeof bootstrap.home !== 'string') {
    throw new Error('Invalid Assistant Worker bootstrap.');
  }
  const paths = resolveAssistantHome(bootstrap.home);
  const lock = await acquireHomeLock(paths.root);
  let monitor: ParentProcessMonitor | undefined;
  let closed = false;
  const pendingModels = new Map<string, { resolve(value: AssistantModelConfig): void; reject(error: Error): void }>();
  const pendingSources = new Map<string, { resolve(value: unknown): void; reject(error: Error): void;
    timeout: NodeJS.Timeout }>();
  const pendingDelegations = new Map<string, { resolve(value: unknown): void; reject(error: Error): void;
    timeout: NodeJS.Timeout }>();
  const active = new Map<string, { cancel(): Promise<void>; result: Promise<TaskRecord> }>();
  const tasks = join(paths.root, 'tasks');
  let memory: AssistantMemoryRepository | undefined;
  let automation: AssistantAutomationStore | undefined;
  let automationEngine: AssistantAutomationEngine | undefined;
  let automationRun: Promise<unknown> | undefined;
  const pendingDelegationEvents = new Map<string, AssistantDelegationRecord>();
  let delegationScanOffset = 0;
  let sourceTimer: NodeJS.Timeout | undefined;
  let sourcePump: Promise<void> | undefined;
  const unsupportedSourceFeeds = new Set<string>();
  const sourceRequest = (method: string, args: unknown[]): Promise<unknown> => new Promise((resolve, reject) => {
    const id = randomUUID();
    const timeout = setTimeout(() => {
      pendingSources.delete(id);
      reject(new Error('Assistant source host timed out.'));
    }, 10_000);
    pendingSources.set(id, { resolve, reject, timeout });
    send({ kind: 'source-request', id, method, args });
  });
  const sourceHost: AssistantSourceHost = {
    listChanges: (feedId, afterCursor, limit) => sourceRequest('listChanges',
      [feedId, afterCursor, limit]) as ReturnType<AssistantSourceHost['listChanges']>,
    currentSource: (sourceId, audience) => sourceRequest('currentSource',
      [sourceId, audience]) as ReturnType<AssistantSourceHost['currentSource']>,
    readSource: (contentRef, sourceId, sourceVersion, audience, maxCharacters) => sourceRequest(
      'readSource', [contentRef, sourceId, sourceVersion, audience, maxCharacters]) as
      ReturnType<AssistantSourceHost['readSource']>,
  };
  const delegationRequest = (method: string, args: unknown[]): Promise<unknown> => new Promise((resolve, reject) => {
    const id = randomUUID();
    const timeout = setTimeout(() => {
      pendingDelegations.delete(id);
      reject(new Error('Assistant delegation host timed out; query the original task ID.'));
    }, 10_000);
    pendingDelegations.set(id, { resolve, reject, timeout });
    send({ kind: 'delegation-request', id, method, args });
  });
  const delegationHost: AssistantDelegationHost = {
    start: (brief) => delegationRequest('start', [brief]) as ReturnType<AssistantDelegationHost['start']>,
    status: (taskId) => delegationRequest('status', [taskId]) as ReturnType<AssistantDelegationHost['status']>,
    followUp: (taskId, sessionId, text) => delegationRequest('followUp', [taskId, sessionId, text]) as
      ReturnType<AssistantDelegationHost['followUp']>,
    cancel: (taskId, sessionId) => delegationRequest('cancel', [taskId, sessionId]) as
      ReturnType<AssistantDelegationHost['cancel']>,
  };
  const queueDelegation = (record: AssistantDelegationRecord): void => {
    if (!automation || !validId(record.taskId) || !validId(record.assistantSessionId)) return;
    const version = createHash('sha256').update(JSON.stringify({ status: record.status,
      updatedAt: record.updatedAt, followUps: record.followUps,
      resultRef: record.result?.resultRef, approvalRequestId: record.result?.approvalRequestId,
    })).digest('hex');
    const existed = automation.byKey(`delegation:${record.taskId}:${version}`);
    automation.enqueueDelegation(record.taskId, version, { kind: 'personal', id: 'local-user' },
      record.updatedAt, record.status);
    if (!existed) automationEngine?.preemptFor('verify-delegation');
  };
  const queueCurrentDelegation = async (taskId: string): Promise<void> => {
    const current = await delegationHost.status(taskId);
    if (current?.taskId === taskId) queueDelegation(current);
  };
  const reconcileDelegations = async (): Promise<void> => {
    const directory = join(paths.root, 'delegations');
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe delegation archive directory.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let names: string[];
    try { names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (!names.length) return;
    const count = Math.min(names.length, 20);
    await Promise.allSettled(Array.from({ length: count }, async (_, index) => {
      if (closed) return;
      const name = names[(delegationScanOffset + index) % names.length]!;
      const taskId = name.slice(0, -5);
      if (!validId(taskId)) return;
      try {
        const path = join(directory, name);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) return;
        const archive = JSON.parse(await readFile(path, 'utf8')) as { assistantSessionId?: unknown };
        const record = await delegationHost.status(taskId);
        if (record && record.taskId === taskId && archive.assistantSessionId === record.assistantSessionId) {
          queueDelegation(record);
        }
      } catch (error) { send({ kind: 'delegation-error', error: String(error) }); }
    }));
    delegationScanOffset = (delegationScanOffset + count) % names.length;
  };
  const pumpSources = (): void => {
    if (closed || sourcePump) return;
    sourcePump = (async () => {
      memory ??= await AssistantMemoryRepository.open(paths.root);
      automation ??= new AssistantAutomationStore(memory.sources.database);
      automationEngine ??= new AssistantAutomationEngine(automation,
        assistantAutomationHandler(memory, automation));
      automationEngine.setForeground(active.size > 0);
      automation.scheduleActivePeriods();
      for (const record of pendingDelegationEvents.values()) await queueCurrentDelegation(record.taskId);
      pendingDelegationEvents.clear();
      try {
        await memory.reconcileDeletedSources();
        for (const feed of ['work', 'work-evidence', 'assistant', 'work-deletions',
          'assistant-deletions', 'legacy-memory']) {
          if (unsupportedSourceFeeds.has(feed)) continue;
          try { await memory.sources.sync(sourceHost, feed, 100); }
          catch (error) {
            if (feed === 'work-evidence' && String(error).includes('Invalid source feed request')) {
              unsupportedSourceFeeds.add(feed);
            } else throw error;
          }
        }
        for (let count = 0; count < 50; count++) {
          if (closed) break;
          const event = await memory.processNext(sourceHost);
          if (!event) break;
          if (event.feedId === 'legacy-memory' && event.status === 'processed') {
            const audience = { kind: 'personal' as const, id: 'local-user' };
            const text = memory.sources.sourceText(event.change.sourceId, audience);
            if (text?.trim()) await memory.importLegacyMemory({ id: 'legacy-memory', text,
              source: { sourceId: event.change.sourceId,
                sourceVersion: event.change.sourceVersion, observedAt: event.change.occurredAt },
              audience, context: '旧版助理记忆（只读导入，待核实）' });
          }
        }
        if (!closed && !memory.sources.nextEvent()) await memory.processNext(sourceHost, true);
      } catch (error) { send({ kind: 'source-error', error: String(error) }); }
      if (closed) return;
      automation.reconcileProcessedSources(100);
      await reconcileDelegations();
      automationEngine.preemptInvalidated();
      const ready = automation.next();
      if (ready) automationEngine.preemptFor(ready.kind);
      if (!automationRun) {
        automationRun = automationEngine.tick().catch((error) => send({ kind: 'automation-error',
          error: String(error) })).finally(() => { automationRun = undefined; });
      }
    })().catch((error) => send({ kind: 'source-error', error: String(error) }))
      .finally(() => { sourcePump = undefined; });
  };
  let executor;
  try { executor = await createAssistantExecutor({
    assistantHome: paths.root,
    bundledSkillFiles: bundledAssistantSkillFiles.map((file) => ({
      path: file.path,
      bytes: Buffer.from(file.base64, 'base64'),
    })),
    host: assistantModelHost(() => new Promise<AssistantModelConfig>((resolve, reject) => {
      const id = randomUUID();
      pendingModels.set(id, { resolve, reject });
      send({ kind: 'model-request', id });
    })),
    delegations: delegationHost,
  }); } catch (error) {
    lock.exec('ROLLBACK');
    lock.close();
    throw error;
  }
  try {
    await assertSafeDirectory(tasks);
    for (const name of await readdir(tasks)) {
      if (!name.endsWith('.json')) continue;
      const record = await readTask(tasks, name.slice(0, -5));
      if (record?.status === 'running') {
        await saveTask(tasks, { ...record, status: 'interrupted', updatedAt: new Date().toISOString() });
      }
    }
    const shutdown = async () => {
      if (closed) return;
      closed = true;
      monitor?.dispose();
      for (const pending of pendingModels.values()) pending.reject(new Error('Assistant Worker is stopping.'));
      pendingModels.clear();
      if (sourceTimer) clearInterval(sourceTimer);
      automationEngine?.stop();
      for (const pending of pendingSources.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Assistant Worker is stopping.'));
      }
      pendingSources.clear();
      for (const pending of pendingDelegations.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Assistant Worker is stopping.'));
      }
      pendingDelegations.clear();
      await sourcePump?.catch(() => undefined);
      await automationRun?.catch(() => undefined);
      memory?.close();
      for (const task of active.values()) await task.cancel().catch(() => undefined);
      await Promise.allSettled([...active.values()].map((task) => task.result));
      await executor.close();
      lock.exec('ROLLBACK');
      lock.close();
      process.exit(0);
    };
    monitor = installParentProcessMonitor(bootstrap.parentPid, () => { void shutdown(); });
    process.once('disconnect', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
    process.once('SIGINT', () => { void shutdown(); });
    process.on('message', (value: unknown) => {
      const message = value as HostMessage;
      if (!message || typeof message !== 'object' || closed) return;
      if (message.kind === 'model') {
        const pending = pendingModels.get(message.id);
        if (!pending) return;
        pendingModels.delete(message.id);
        if (message.config) pending.resolve(message.config);
        else pending.reject(new Error(message.error ?? 'Assistant model unavailable.'));
        return;
      }
      if (message.kind === 'source-result') {
        const pending = pendingSources.get(message.id);
        if (!pending) return;
        pendingSources.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.value);
        return;
      }
      if (message.kind === 'delegation-result') {
        const pending = pendingDelegations.get(message.id);
        if (!pending) return;
        pendingDelegations.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.value);
        return;
      }
      if (message.kind === 'delegation-event') {
        const record = message.record;
        if (!record || !validId(record.taskId) || !validId(record.assistantSessionId)) return;
        if (automation) void queueCurrentDelegation(record.taskId).catch((error) => send({
          kind: 'delegation-error', error: String(error),
        }));
        else { pendingDelegationEvents.set(record.taskId, record); pumpSources(); }
        return;
      }
      if (message.kind === 'shutdown') { void shutdown(); return; }
      if (message.kind === 'cancel') {
        void active.get(message.id)?.cancel();
        return;
      }
      if (message.kind === 'task') {
        void readTask(tasks, message.id).then((record) => send({ kind: 'task', id: message.id,
          correlationId: message.correlationId, record }),
          (error) => send({ kind: 'task', id: message.id,
            correlationId: message.correlationId, error: String(error) }));
        return;
      }
      if (message.kind !== 'prompt') return;
      const reply = (result: Promise<TaskRecord>) => {
        void result.then((record) => send({ kind: 'result', id: message.id,
          correlationId: message.correlationId, record }),
        (error) => send({ kind: 'result', id: message.id,
          correlationId: message.correlationId, error: String(error) }));
      };
      const running = active.get(message.id);
      if (running) { reply(running.result); return; }
      let session: AssistantSession | undefined;
      let cancelled = false;
      const controller = new AbortController();
      const cancel = async () => { cancelled = true; controller.abort(); };
      const result = (async (): Promise<TaskRecord> => {
        if (!validId(message.id) || typeof message.text !== 'string' || !message.text.trim()
          || message.text.length > 64_000 || !Number.isSafeInteger(message.deadlineAt)) {
          throw new Error('Invalid assistant prompt request.');
        }
        const existing = await readTask(tasks, message.id);
        if (existing) return existing;
        if (message.deadlineAt <= Date.now()) throw new Error('Assistant prompt deadline expired.');
        let record: TaskRecord = { id: message.id, status: 'running', updatedAt: new Date().toISOString() };
        await saveTask(tasks, record);
        const timer = setTimeout(() => { void cancel(); }, Math.max(1, message.deadlineAt - Date.now()));
        try {
          session = await executor.openSession(message.sessionId, { createIfMissing: Boolean(message.sessionId) });
          if (!cancelled) {
            const result = await session.prompt(message.text, controller.signal);
            record = cancelled
              ? { ...record, sessionId: result.sessionId, status: 'cancelled', updatedAt: new Date().toISOString() }
              : { ...record, sessionId: result.sessionId, status: 'completed', message: result.message,
                updatedAt: new Date().toISOString() };
          } else record = { ...record, status: 'cancelled', updatedAt: new Date().toISOString() };
        } catch (error) {
          record = { ...record, status: cancelled ? 'cancelled' : 'failed',
            error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() };
        } finally {
          clearTimeout(timer);
        }
        await saveTask(tasks, record);
        return record;
      })();
      active.set(message.id, { cancel, result });
      automationEngine?.setForeground(true);
      void result.finally(() => {
        active.delete(message.id);
        automationEngine?.setForeground(active.size > 0);
      }).catch(() => undefined);
      reply(result);
    });
    send({ kind: 'ready', pid: process.pid });
    sourceTimer = setInterval(pumpSources, 5_000);
    sourceTimer.unref();
    pumpSources();
  } catch (error) {
    monitor?.dispose();
    await executor.close().catch(() => undefined);
    lock.exec('ROLLBACK');
    lock.close();
    throw error;
  }
}
