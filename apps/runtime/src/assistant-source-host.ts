import type { AssistantSourceHost, AssistantSourcePage, AssistantSourceRead,
  AssistantSourceState } from '@yuanpu-agent/assistant';
import type { AssistantHostStore, WorkConversationStore } from '@yuanpu-agent/runtime-kit';
import type { AssistantAudience, AssistantSourceChange } from '@yuanpu-agent/protocol';

const feeds = ['work', 'assistant'] as const;

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
  constructor(private readonly work: WorkConversationStore, private readonly assistant: AssistantHostStore) {}

  async listChanges(feedId: string, afterCursor: string, limit: number): Promise<AssistantSourcePage> {
    if (!feeds.includes(feedId as typeof feeds[number]) || !Number.isSafeInteger(limit)
      || limit < 1 || limit > 500) throw new Error('Invalid source feed request.');
    const after = cursorNumber(afterCursor);
    const rows = feedId === 'work'
      ? this.work.sourcePage(after, limit)
      : this.assistant.sourcePage(after, limit);
    return { events: rows.map((row) => ({ eventId: String(row.eventId), change: row.change })),
      nextCursor: rows.length ? String(rows.at(-1)!.eventId) : afterCursor };
  }

  private latest(sourceId: string): AssistantSourceChange | undefined {
    if (sourceId.startsWith('work-turn:')) {
      const source = this.work.sourceById(sourceId);
      return source && { sourceId, sourceVersion: source.sourceVersion, kind: 'created',
        audience: { kind: 'personal', id: 'local-user' }, occurredAt: source.committedAt,
        contentRef: source.contentRef, workId: source.conversationId };
    }
    return this.assistant.currentSourceChange(sourceId);
  }

  async currentSource(sourceId: string, audience: AssistantAudience): Promise<AssistantSourceState> {
    personal(audience);
    const current = this.latest(sourceId);
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
    const current = this.latest(sourceId);
    if (!current || current.audience.kind !== audience.kind || current.audience.id !== audience.id
      || current.contentRef !== contentRef || current.sourceVersion !== sourceVersion) {
      return { status: 'temporarily_unavailable' };
    }
    if (current.kind === 'deleted') return { status: 'deleted' };
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
