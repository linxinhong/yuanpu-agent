import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { WorkConversationStore, WorkDirectoryMovePlan } from '@yuanpu-agent/runtime-kit';

import type { WorkMoveRequest, WorkMoveResult } from '@yuanpu-agent/protocol';

interface DirectoryChange { from: string; to: string; device: number; inode: number }
interface HeaderChange {
  file: string; before: string; after: string; bodyHash: string; mode: number;
}
interface MoveJournal {
  version: 1;
  request: WorkMoveRequest;
  plan: WorkDirectoryMovePlan;
  directories: DirectoryChange[];
  headers: HeaderChange[];
  state: 'prepared' | 'committed' | 'done' | 'rolled_back';
  result: WorkMoveResult;
}
interface Options {
  store: WorkConversationStore;
  workspaceId: string;
  workspaceRoot: string;
  sessionsRoot: string;
  toolStateRoot: string;
  assertIdle?: (conversationIds: string[], piSessionIds: string[]) => Promise<void>;
  drainSessions?: (piSessionIds: string[]) => Promise<void>;
  verifySession?: (cwd: string, piSessionId: string, file: string) => void;
  /** Tests may terminate the process at durable transition boundaries. */
  checkpoint?: (name: string) => void | Promise<void>;
}
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const exists = async (path: string) => lstat(path).catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return undefined;
  throw error;
});

export class WorkMoveConflict extends Error {}

/** A process-local lease also covers preview reads, create operations and run submission.
 * Disk intent recovery runs before the HTTP server or Agent scheduler can start. */
export class WorkDirectoryMoveCoordinator {
  #readers = 0;
  #moving = false;
  #blocked = false;
  constructor(private readonly options: Options) {}
  get busy(): boolean { return this.#moving || this.#blocked; }
  acquireRead(): () => void {
    if (this.busy) throw new WorkMoveConflict('工作目录正在搬迁或等待恢复，请稍后重试。');
    this.#readers += 1;
    let released = false;
    return () => { if (!released) { released = true; this.#readers -= 1; } };
  }
  private save(journal: MoveJournal): void {
    this.options.store.saveMove(journal.request.requestId, JSON.stringify(journal));
  }
  private async checkpoint(name: string): Promise<void> { await this.options.checkpoint?.(name); }

  async recover(): Promise<void> {
    this.#blocked = true;
    for (const record of this.options.store.moveRecords()) {
      const journal = JSON.parse(record.value) as MoveJournal;
      if (journal.version !== 1) throw new Error('Unsupported Work move journal.');
      if (journal.state === 'done' || journal.state === 'rolled_back') continue;
      await this.reconcile(journal);
    }
    this.#blocked = false;
  }

  async move(request: WorkMoveRequest): Promise<WorkMoveResult> {
    if (!request || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(request.requestId)
      || !['folder', 'conversation'].includes(request.kind) || typeof request.id !== 'string'
      || (request.targetFolderId !== null && typeof request.targetFolderId !== 'string')) {
      throw new WorkMoveConflict('Invalid Work move request.');
    }
    if (request.targetFolderId === 'uncategorized') request = { ...request, targetFolderId: null };
    if (this.busy || this.#readers) throw new WorkMoveConflict('工作目录正被读取、创建或运行，请稍后重试移动。');
    this.#moving = true;
    let journal: MoveJournal | undefined;
    try {
      const previous = this.options.store.moveRecords().find((item) => item.requestId === request.requestId);
      if (previous) {
        const saved = JSON.parse(previous.value) as MoveJournal;
        if (saved.plan.workspaceId !== this.options.workspaceId) throw new WorkMoveConflict('Move request belongs to a different workspace.');
        if (saved.request.kind !== request.kind || saved.request.id !== request.id
          || saved.request.targetFolderId !== request.targetFolderId) throw new WorkMoveConflict('Move request ID conflicts with an earlier request.');
        if (saved.state === 'done') return saved.result;
        if (saved.state !== 'rolled_back') throw new WorkMoveConflict('Move requires startup recovery.');
      }
      journal = await this.prepare(request);
      this.save(journal);
      await this.checkpoint('prepared');
      for (let index = 0; index < journal.directories.length; index += 1) {
        await this.relocate(journal.directories[index]!, true);
        await this.checkpoint(`directory:${index}`);
      }
      for (let index = 0; index < journal.headers.length; index += 1) {
        await this.rewriteHeader(journal.headers[index]!, true);
        await this.checkpoint(`header:${index}`);
      }
      this.verify(journal, true);
      this.options.store.commitMove(journal.plan, JSON.stringify({ ...journal, state: 'committed' }));
      journal.state = 'committed';
      await this.checkpoint('committed');
      await this.reconcile(journal);
      return journal.result;
    } catch (error) {
      if (journal && this.options.store.moveRecords().some((item) => item.requestId === request.requestId)) {
        try { await this.reconcile(journal); }
        catch (recoveryError) {
          this.#blocked = true;
          throw new WorkMoveConflict(`工作目录恢复未完成，已阻止继续写入：${String(recoveryError)}`);
        }
      }
      if (!(error instanceof WorkMoveConflict)) throw new WorkMoveConflict(error instanceof Error ? error.message : String(error));
      throw error;
    } finally { this.#moving = false; }
  }

  private async prepare(request: WorkMoveRequest): Promise<MoveJournal> {
    const { store, workspaceId, workspaceRoot, toolStateRoot } = this.options;
    const allFolders = store.listFolders(workspaceId).filter((item) => !item.system);
    const target = request.targetFolderId ? allFolders.find((item) => item.id === request.targetFolderId) : undefined;
    if (request.targetFolderId && !target) throw new WorkMoveConflict('Unknown destination folder.');
    const allConversations = store.listExisting(workspaceId).filter((item) => item.id !== 'default');
    let source: string;
    const folderIds = new Set<string>();
    if (request.kind === 'folder') {
      const folder = allFolders.find((item) => item.id === request.id);
      if (!folder) throw new WorkMoveConflict('Unknown or system Work folder.');
      folderIds.add(folder.id);
      for (let size = -1; size !== folderIds.size;) {
        size = folderIds.size;
        for (const child of allFolders) if (child.parentId && folderIds.has(child.parentId)) folderIds.add(child.id);
      }
      if (request.targetFolderId && folderIds.has(request.targetFolderId)) throw new WorkMoveConflict('Cannot move a folder inside itself.');
      const targetDepth = target ? target.relativeDirectory.split('/').length : 0;
      const sourceDepth = folder.relativeDirectory.split('/').length;
      const subtreeDepth = Math.max(...allFolders.filter((item) => folderIds.has(item.id))
        .map((item) => item.relativeDirectory.split('/').length - sourceDepth + 1));
      if (targetDepth + subtreeDepth > 5) throw new WorkMoveConflict('工作文件夹最多支持五级。');
      source = join(workspaceRoot, folder.relativeDirectory);
    } else {
      const conversation = allConversations.find((item) => item.id === request.id);
      if (!conversation) throw new WorkMoveConflict('Unknown or legacy Work conversation.');
      source = conversation.workingDirectory;
    }
    source = resolve(source);
    const destination = join(workspaceRoot, target?.relativeDirectory ?? '', basename(source));
    if (source === destination) throw new WorkMoveConflict('Work node is already in this folder.');
    await this.validatePath(workspaceRoot, source, true);
    await this.validatePath(workspaceRoot, dirname(destination), true, true);
    if (await exists(destination)) throw new WorkMoveConflict('目标目录已存在；移动不会覆盖文件。');
    await this.checkTree(source);
    const sourceInfo = await lstat(source);
    const targetInfo = await lstat(dirname(destination));
    if (sourceInfo.dev !== targetInfo.dev) throw new WorkMoveConflict('Cross-volume moves require an explicit import.');
    await access(dirname(source), constants.W_OK | constants.X_OK);
    await access(dirname(destination), constants.W_OK | constants.X_OK);
    for (const folder of allFolders) {
      const path = resolve(workspaceRoot, folder.relativeDirectory);
      const inside = path === source || path.startsWith(`${source}${sep}`);
      if (inside !== folderIds.has(folder.id)) throw new WorkMoveConflict('Work folder paths do not match the tree.');
    }
    const selected = allConversations.filter((item) => request.kind === 'conversation'
      ? item.id === request.id : item.folderId !== null && folderIds.has(item.folderId));
    // Metadata must describe the complete physical subtree. Shared/overlapping cwd is unsafe.
    for (const item of allConversations) {
      const physicallyInside = item.workingDirectory === source || item.workingDirectory.startsWith(`${source}${sep}`);
      if (physicallyInside !== selected.includes(item)) throw new WorkMoveConflict('Work tree and physical directories disagree.');
    }
    const plan: WorkDirectoryMovePlan = {
      ...request, workspaceId,
      conversations: selected.map((item) => ({ id: item.id, piSessionId: store.sessionId(workspaceId, item.id)!,
        from: item.workingDirectory, to: join(destination, relative(source, item.workingDirectory)) })),
      folders: allFolders.filter((item) => folderIds.has(item.id)).map((item) => ({ id: item.id,
        from: item.relativeDirectory,
        to: relative(workspaceRoot, join(destination, relative(source, join(workspaceRoot, item.relativeDirectory)))).split(sep).join('/') })),
    };
    for (const item of plan.conversations) await this.validatePath(workspaceRoot, item.from, true);
    store.assertMoveIdle(plan.conversations.map((item) => item.id));
    await this.options.assertIdle?.(plan.conversations.map((item) => item.id), plan.conversations.map((item) => item.piSessionId));
    await this.options.drainSessions?.(plan.conversations.map((item) => item.piSessionId));
    const directories: DirectoryChange[] = [{ from: source, to: destination, device: sourceInfo.dev, inode: sourceInfo.ino }];
    const headers: HeaderChange[] = [];
    for (const item of plan.conversations) {
      const foundHeaders = await this.prepareHeaders(item.piSessionId, item.from, item.to);
      if (!foundHeaders.length && store.sources(item.id).length) throw new WorkMoveConflict('Saved Work history is missing.');
      headers.push(...foundHeaders);
      const oldState = join(toolStateRoot, digest(JSON.stringify([item.from, item.piSessionId])));
      const newState = join(toolStateRoot, digest(JSON.stringify([item.to, item.piSessionId])));
      const oldInfo = await exists(oldState);
      if (await exists(newState)) throw new WorkMoveConflict('Destination session tool state already exists.');
      if (oldInfo) {
        await this.validatePath(toolStateRoot, oldState, true);
        await this.checkTree(oldState);
        await this.assertPersistedToolsIdle(oldState);
        directories.push({ from: oldState, to: newState, device: oldInfo.dev, inode: oldInfo.ino });
      }
    }
    return { version: 1, request, plan, directories, headers, state: 'prepared', result: {
      requestId: request.requestId, conversationIds: plan.conversations.map((item) => item.id),
      previousDirectories: plan.conversations.map((item) => ({ conversationId: item.id, path: item.from })),
      warning: '工作目录已移动。历史消息和工具输出中的旧绝对路径保留原文，可能已失效。',
    } };
  }

  private async validatePath(root: string, path: string, directory: boolean, allowRoot = false): Promise<void> {
    root = resolve(root); path = resolve(path);
    const rel = relative(root, path);
    if ((!rel && !allowRoot) || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new WorkMoveConflict('Directory is outside the managed workspace.');
    let cursor = root;
    for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
      if (part) cursor = join(cursor, part);
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink() || !entry.isDirectory() && (cursor !== path || directory)) throw new WorkMoveConflict('Symbolic links and non-directories cannot be moved.');
    }
    if (await realpath(path) !== join(await realpath(root), rel)) throw new WorkMoveConflict('Workspace path changed.');
  }

  private async checkTree(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === '.git') {
        if (!entry.isDirectory()) throw new WorkMoveConflict('Linked Git worktrees require an explicit Git-aware relocation.');
        const registrations = await exists(join(path, '.git', 'worktrees'));
        const config = await readFile(join(path, '.git', 'config'), 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return ''; throw error;
        });
        if (registrations || /worktree\s*=/i.test(config)) throw new WorkMoveConflict('Git worktree registrations require an explicit Git-aware relocation.');
      }
      if (entry.isSymbolicLink()) throw new WorkMoveConflict('移动子树中含符号链接，请先移除链接。');
      if (entry.isDirectory()) await this.checkTree(join(path, entry.name));
      else if (!entry.isFile()) throw new WorkMoveConflict('Work directory contains a special file.');
    }
  }

  private async assertPersistedToolsIdle(root: string): Promise<void> {
    const load = async (file: string): Promise<Record<string, unknown> | undefined> => {
      const entry = await exists(file);
      if (!entry) return undefined;
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 8 * 1024 * 1024) throw new WorkMoveConflict('Invalid persisted tool state.');
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new WorkMoveConflict('Invalid persisted tool state.');
      return parsed as Record<string, unknown>;
    };
    const goals = await load(join(root, 'goals.json'));
    if (goals && (goals.version !== 1 || !Array.isArray(goals.goals) || goals.goals.some((goal) =>
      !goal || typeof goal !== 'object' || !['draft', 'paused', 'blocked', 'completed'].includes(String(goal.status))))) {
      throw new WorkMoveConflict('Persisted goal is active or invalid. Open and pause it before moving.');
    }
    const runsRoot = join(root, 'runs');
    if (!await exists(runsRoot)) return;
    for (const name of await readdir(runsRoot)) {
      const run = await load(join(runsRoot, name, 'run.json'));
      if (!run || !['completed', 'failed', 'paused', 'cancelled', 'interrupted'].includes(String(run.status))
        || (run.status === 'paused' && run.checkpoint)) {
        throw new WorkMoveConflict('Persisted workflow or checkpoint must be settled before moving.');
      }
    }
  }

  private async prepareHeaders(piSessionId: string, from: string, to: string): Promise<HeaderChange[]> {
    const root = this.options.sessionsRoot;
    const matches: HeaderChange[] = [];
    if (!await exists(root)) return matches;
    await this.validatePath(root, root, true, true);
    for (const name of await readdir(root)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = join(root, name);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new WorkMoveConflict('Session storage contains an unsafe JSONL path.');
      const handle = await open(file, 'r');
      let head: Buffer;
      try { const buffer = Buffer.alloc(1024 * 1024); const read = await handle.read(buffer); head = buffer.subarray(0, read.bytesRead); }
      finally { await handle.close(); }
      const end = head.indexOf(10);
      let header: { type?: string; id?: string; cwd?: string };
      try { header = JSON.parse(head.subarray(0, end < 0 ? head.length : end).toString('utf8')); }
      catch { if (name.includes(piSessionId)) throw new WorkMoveConflict('Session header is corrupt.'); else continue; }
      if (header.id !== piSessionId) {
        if (name.includes(piSessionId)) throw new WorkMoveConflict('Session filename and header ID disagree.');
        continue;
      }
      if (header.type !== 'session' || header.cwd !== from || end < 0 || info.size > 512 * 1024 * 1024) throw new WorkMoveConflict('Session header does not match the Work directory, or exceeds the move limit.');
      const bytes = await readFile(file);
      matches.push({ file, before: bytes.subarray(0, end).toString('base64'),
        after: Buffer.from(JSON.stringify({ ...header, cwd: to })).toString('base64'),
        bodyHash: digest(bytes.subarray(end)), mode: info.mode & 0o777 });
    }
    if (matches.length > 1) throw new WorkMoveConflict('Duplicate Pi session IDs cannot be moved safely.');
    return matches;
  }

  private async relocate(change: DirectoryChange, forward: boolean): Promise<void> {
    const from = forward ? change.from : change.to;
    const to = forward ? change.to : change.from;
    const root = change.from.startsWith(`${resolve(this.options.workspaceRoot)}${sep}`)
      ? this.options.workspaceRoot : this.options.toolStateRoot;
    await this.validatePath(root, dirname(to), true, true);
    const source = await exists(from);
    const target = await exists(to);
    if (!source && target && target.dev === change.device && target.ino === change.inode) {
      await this.validatePath(root, to, true); return;
    }
    if (!source || target || source.dev !== change.device || source.ino !== change.inode) throw new WorkMoveConflict('Move recovery found conflicting directory identities.');
    await this.validatePath(root, from, true);
    await rename(from, to);
    await syncDirectory(dirname(from));
    await syncDirectory(dirname(to));
  }

  private async rewriteHeader(change: HeaderChange, forward: boolean): Promise<void> {
    await this.validatePath(this.options.sessionsRoot, change.file, false);
    const info = await lstat(change.file);
    if (!info.isFile() || info.nlink !== 1) throw new WorkMoveConflict('Session must be a regular unlinked file.');
    const bytes = await readFile(change.file);
    const end = bytes.indexOf(10);
    const current = bytes.subarray(0, end).toString('base64');
    const desired = forward ? change.after : change.before;
    if (end < 0 || digest(bytes.subarray(end)) !== change.bodyHash || (current !== change.before && current !== change.after)) throw new WorkMoveConflict('Session changed during directory migration.');
    if (current === desired) return;
    const temporary = `${change.file}.move-${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', change.mode);
    try { await handle.writeFile(Buffer.concat([Buffer.from(desired, 'base64'), bytes.subarray(end)])); await handle.chmod(change.mode); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, change.file); await syncDirectory(dirname(change.file)); }
    finally { await rm(temporary, { force: true }); }
  }

  private verify(journal: MoveJournal, forward: boolean): void {
    for (const item of journal.plan.conversations) {
      const header = journal.headers.find((candidate) => JSON.parse(Buffer.from(candidate.before, 'base64').toString()).id === item.piSessionId);
      if (header) this.options.verifySession?.(forward ? item.to : item.from, item.piSessionId, header.file);
    }
  }

  private async reconcile(journal: MoveJournal): Promise<void> {
    const forward = journal.state === 'committed' || journal.state === 'done';
    // Before DB commit old metadata remains authoritative. Headers are restored before cwd.
    for (const header of journal.headers) await this.rewriteHeader(header, forward);
    for (const directory of forward ? journal.directories : [...journal.directories].reverse()) await this.relocate(directory, forward);
    this.verify(journal, forward);
    journal.state = forward ? 'done' : 'rolled_back';
    this.save(journal);
    await this.checkpoint('settled');
  }
}

async function syncDirectory(path: string): Promise<void> {
  // Windows does not permit opening directories through the Node fs API.
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
