import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AssistantSourceHost, AssistantSourcePage, AssistantSourceRead,
  AssistantSourceState } from '@yuanpu-agent/assistant';
import type { AssistantHostStore, AssistantSourceLifecycleStore,
  WorkConversationStore } from '@yuanpu-agent/runtime-kit';
import type { AssistantAudience, AssistantSourceChange } from '@yuanpu-agent/protocol';

const feeds = ['work', 'assistant', 'work-deletions', 'assistant-deletions', 'legacy-memory'] as const;
const legacySourceId = 'legacy-memory:MEMORY';

function cursorNumber(cursor: string): number {
  const value = Number(cursor);
  if (!/^\d+$/u.test(cursor) || !Number.isSafeInteger(value)) throw new Error('Invalid source cursor.');
  return value;
}

function personal(audience: AssistantAudience): void {
  if (audience.kind !== 'personal' || audience.id !== 'local-user') {
    throw new Error('Source audience is not authorized.');
  }
}

/** Runtime is the only resolver of host-owned content references. */
export class RuntimeAssistantSourceHost implements AssistantSourceHost {
  constructor(private readonly work: WorkConversationStore, private readonly assistant: AssistantHostStore,
    private readonly lifecycle: AssistantSourceLifecycleStore, private readonly legacyMemoryPath?: string) {}

  private async legacy(): Promise<{ sourceVersion: string; contentRef: string;
    text: string } | undefined> {
    if (!this.legacyMemoryPath) return undefined;
    try {
      for (const parent of [dirname(this.legacyMemoryPath), dirname(dirname(this.legacyMemoryPath))]) {
        const info = await lstat(parent);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new Error('Legacy memory parent is not a real directory.');
        }
      }
      const entry = await lstat(this.legacyMemoryPath);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Legacy memory path is not a real file.');
      const file = await open(this.legacyMemoryPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let text: string;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 64_000) throw new Error('Legacy memory is not a bounded real file.');
        const buffer = Buffer.alloc(64_001);
        let bytes = 0;
        while (bytes < buffer.length) {
          const result = await file.read(buffer, bytes, buffer.length - bytes, bytes);
          if (!result.bytesRead) break;
          bytes += result.bytesRead;
        }
        if (bytes > 64_000) throw new Error('Legacy memory exceeds source budget.');
        text = buffer.subarray(0, bytes).toString('utf8');
      } finally { await file.close(); }
      const sourceVersion = createHash('sha256').update(text).digest('hex');
      return { sourceVersion, contentRef: `legacy-memory:${sourceVersion}`, text };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /** Called only after the host has authoritative confirmation of source deletion. */
  markDeleted(feedId: 'work' | 'assistant', sourceId: string): AssistantSourceChange {
    const original = feedId === 'work' ? this.work.sourceById(sourceId)
      : this.assistant.currentSourceChange(sourceId);
    if (!original) throw new Error('Cannot delete an unknown source.');
    const audienceId = feedId === 'work' ? 'local-user' : (original as AssistantSourceChange).audience.id;
    if (audienceId !== 'local-user') throw new Error('Source audience is not authorized.');
    return this.lifecycle.markDeleted(feedId, sourceId, audienceId);
  }

  async listChanges(feedId: string, afterCursor: string, limit: number): Promise<AssistantSourcePage> {
    if (!feeds.includes(feedId as typeof feeds[number]) || !Number.isSafeInteger(limit)
      || limit < 1 || limit > 500) throw new Error('Invalid source feed request.');
    if (feedId === 'legacy-memory') {
      const legacy = await this.legacy();
      if (legacy) {
        this.lifecycle.recordLegacyVersion(legacy.sourceVersion);
      }
      const rows = this.lifecycle.legacyPage(cursorNumber(afterCursor), limit);
      return { events: rows.map((row) => ({ eventId: String(row.eventId), change: {
        sourceId: legacySourceId, sourceVersion: row.sourceVersion,
        kind: row.eventId === 1 ? 'created' : 'updated',
        audience: { kind: 'personal', id: 'local-user' }, occurredAt: row.occurredAt,
        contentRef: `legacy-memory:${row.sourceVersion}` } })),
      nextCursor: rows.length ? String(rows.at(-1)!.eventId) : afterCursor };
    }
    const after = cursorNumber(afterCursor);
    if (feedId.endsWith('-deletions')) {
      const origin = feedId.slice(0, -'-deletions'.length);
      const rows = this.lifecycle.deletionPage(origin as 'work' | 'assistant', after, limit);
      return { events: rows.map((row) => ({ eventId: String(row.eventId), change: row.change })),
      nextCursor: rows.length ? String(rows.at(-1)!.eventId) : afterCursor };
    }
    const rows = feedId === 'work'
      ? this.work.sourcePage(after, limit)
      : this.assistant.sourcePage(after, limit);
    return { events: rows.map((row) => ({ eventId: String(row.eventId), change: row.change })),
      nextCursor: rows.length ? String(rows.at(-1)!.eventId) : afterCursor };
  }

  private async latest(sourceId: string): Promise<AssistantSourceChange | undefined> {
    if (sourceId === legacySourceId) {
      const source = await this.legacy();
      return source && { sourceId, sourceVersion: source.sourceVersion, kind: 'created',
        audience: { kind: 'personal', id: 'local-user' }, occurredAt: new Date().toISOString(),
        contentRef: source.contentRef };
    }
    if (sourceId.startsWith('work-turn:')) {
      const deleted = this.lifecycle.deletion('work', sourceId);
      if (deleted) return deleted;
      const source = this.work.sourceById(sourceId);
      return source && { sourceId, sourceVersion: source.sourceVersion, kind: 'created',
        audience: { kind: 'personal', id: 'local-user' }, occurredAt: source.committedAt,
        contentRef: source.contentRef, workId: source.conversationId };
    }
    const deleted = this.lifecycle.deletion('assistant', sourceId);
    if (deleted) return deleted;
    return this.assistant.currentSourceChange(sourceId);
  }

  async currentSource(sourceId: string, audience: AssistantAudience): Promise<AssistantSourceState> {
    personal(audience);
    const current = await this.latest(sourceId);
    if (!current || current.audience.kind !== audience.kind || current.audience.id !== audience.id) {
      return { status: 'temporarily_unavailable' };
    }
    return current.kind === 'deleted'
      ? { status: 'deleted', sourceVersion: current.sourceVersion }
      : { status: 'available', sourceVersion: current.sourceVersion };
  }

  async readSource(contentRef: string, sourceId: string, sourceVersion: string,
    audience: AssistantAudience, maxCharacters: number): Promise<AssistantSourceRead> {
    personal(audience);
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 32_000) {
      throw new Error('Invalid source read budget.');
    }
    const current = await this.latest(sourceId);
    if (!current || current.audience.kind !== audience.kind || current.audience.id !== audience.id) {
      return { status: 'temporarily_unavailable' };
    }
    if (current.kind === 'deleted') return { status: 'deleted' };
    if (current.contentRef !== contentRef || current.sourceVersion !== sourceVersion) {
      return { status: 'temporarily_unavailable' };
    }
    if (sourceId === legacySourceId) {
      const legacy = await this.legacy();
      return legacy && legacy.sourceVersion === sourceVersion
        ? { status: 'available', sourceVersion, text: legacy.text.slice(0, maxCharacters) }
        : { status: 'temporarily_unavailable' };
    }
    if (sourceId.startsWith('work-turn:')) {
      const source = this.work.resolveContentRef(contentRef);
      if (!source || source.sourceId !== sourceId || source.sourceVersion !== sourceVersion) {
        return { status: 'temporarily_unavailable' };
      }
      return { status: 'available', sourceVersion,
        text: `User:\n${source.userText}\n\nAssistant:\n${source.assistantText}`.slice(0, maxCharacters) };
    }
    const source = this.assistant.resolveContentRef(contentRef, audience.id);
    if (!source) return { status: 'temporarily_unavailable' };
    const text = 'transcript' in source
      ? source.transcript.map((message) => `${message.role}: ${message.text}`).join('\n\n')
      : `User:\n${source.userText}\n\nAssistant:\n${source.assistantText}`;
    return { status: 'available', sourceVersion, text: text.slice(0, maxCharacters) };
  }
}
