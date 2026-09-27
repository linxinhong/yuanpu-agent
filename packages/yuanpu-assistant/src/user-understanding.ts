import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AssistantAudience, AssistantEvidenceRef } from '@yuanpu-agent/protocol';
import type { AutomationJob } from './automation.js';
import type { AssistantMemoryRepository, AssistantMemoryDocument } from './memory-documents.js';
import type { AssistantSourceStore } from './memory-sources.js';

export const userTopics = ['background', 'interests', 'hobbies', 'values', 'goals',
  'working-style', 'thinking-style', 'preferences', 'knowledge', 'experiences',
  'collaboration', 'context'] as const;
export type UserTopic = typeof userTopics[number];

export interface UnderstandingSnapshot {
  sourceId: string;
  sourceVersion: string;
  audience: AssistantAudience;
  observedAt: string;
  eventOrder: number;
  workId?: string;
  userText: string;
}

export interface UnderstandingProposal {
  observations: Array<{ topic: UserTopic; quote: string; supersedes: string[] }>;
}

interface ObservationRow {
  source_id: string;
  source_version: string;
  audience_kind: AssistantAudience['kind'];
  audience_id: string;
  observed_at: string;
  event_order: number;
  work_id: string | null;
  topic: UserTopic;
  quote: string;
}

const schema = `
  CREATE TABLE IF NOT EXISTS assistant_user_observations (
    source_id TEXT NOT NULL, source_version TEXT NOT NULL,
    quote_hash TEXT NOT NULL, audience_kind TEXT NOT NULL, audience_id TEXT NOT NULL,
    observed_at TEXT NOT NULL, event_order INTEGER NOT NULL,
    work_id TEXT, topic TEXT NOT NULL, quote TEXT NOT NULL,
    PRIMARY KEY(source_id,source_version,quote_hash)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS assistant_user_observations_topic
    ON assistant_user_observations(topic,audience_kind,audience_id);
  CREATE TABLE IF NOT EXISTS assistant_user_corrections (
    source_id TEXT NOT NULL, source_version TEXT NOT NULL,
    topic TEXT NOT NULL, prior_quote_hash TEXT NOT NULL,
    observed_at TEXT NOT NULL, event_order INTEGER NOT NULL,
    audience_kind TEXT NOT NULL, audience_id TEXT NOT NULL,
    PRIMARY KEY(source_id,source_version,topic,prior_quote_hash)
  ) STRICT;
`;

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const normalize = (value: string): string => value.normalize('NFKC').replace(/\s+/gu, ' ').trim();

function userSpeech(text: string): string | undefined {
  const match = /^User:\s*([\s\S]*?)(?:\n\s*Assistant:|$)/u.exec(text);
  return match?.[1]?.trim();
}

function looksSensitive(text: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-|gh[pousr]_|github_pat_|glpat-|npm_|xox[baprs]-|AKIA[A-Z0-9]{16}|AIza|Bearer\s|(?:api[_-]?key|password|secret|token)\s*[:=])|\b(?=[A-Za-z0-9_+/-]{24,}\b)(?=[A-Za-z0-9_+/-]*[A-Za-z])(?=[A-Za-z0-9_+/-]*\d)[A-Za-z0-9_+/-]{24,}\b/iu
    .test(text);
}

/** Reject first-person text embedded in somebody else's speech or a quoted document. */
export function isDirectUserStatement(userText: string, quote: string, topic: UserTopic): boolean {
  const personal = /^(?:我|本人|I\b|I'm\b|I've\b|我的|请|以后|不要|给我)/iu.test(quote);
  const lastingDirective = /^(?:以后|今后|始终|每次|默认|长期|记住|请记住|不要再|不再)/u.test(quote);
  if (!personal && !(lastingDirective
    && ['preferences', 'collaboration', 'working-style'].includes(topic))) return false;
  if (/^(?:请|以后|不要|给我)/u.test(quote)
    && topic !== 'preferences' && topic !== 'collaboration') return false;
  const text = normalize(userText);
  let start = 0;
  while (start <= text.length - quote.length) {
    const index = text.indexOf(quote, start);
    if (index < 0) return false;
    start = index + 1;
    const before = text.slice(0, index);
    const pairs: Array<[string, string]> = [['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['"', '"']];
    if (pairs.some(([open, close]) => open === close
      ? (before.match(/"/gu)?.length ?? 0) % 2 === 1
      : before.lastIndexOf(open) > before.lastIndexOf(close))) continue;
    const segment = before.slice(Math.max(before.lastIndexOf('。'), before.lastIndexOf('！'),
      before.lastIndexOf('？'), before.lastIndexOf('.'), before.lastIndexOf('!'),
      before.lastIndexOf('?'), before.lastIndexOf('\n')) + 1);
    if (/[：:]/u.test(segment)
      || /(?:摘录|引用|转述|原话|例句|举例|听.{0,8}说|说的是|写着|读到|看到|转告|quote|quoted|heard|read|example)/iu
        .test(segment)) continue;
    if (/(?:同事|朋友|家人|他|她|他们|别人|客户|老师|领导|老板|同学|团队|文档|文章|网页|帖子|colleague|friend|someone|they|he|she|document|article|website)/iu
      .test(segment)) continue;
    const prefix = segment.trim();
    if (prefix && !/^(?:(?:其实|现在|另外|不过|还有)[，,]?|(?:关于|至于|说到)(?:我的?)?(?:爱好|兴趣|工作|偏好|目标|经历|知识|合作)[，,]|(?:其实)?我(?:不再喜欢|并非喜欢|不是喜欢)[^，,]{1,60}[，,]|actually[,]?)$/iu
      .test(prefix)) continue;
    return true;
  }
  return false;
}

/** The model may choose a topic, but the note body is always a verified user quotation. */
export function parseUnderstandingProposal(message: string): UnderstandingProposal {
  if (message.length > 8000) throw new Error('Understanding proposal exceeds budget.');
  const trimmed = message.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/iu.exec(trimmed);
  const value = JSON.parse(fenced?.[1] ?? trimmed) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray(value.observations) || value.observations.length > 8) {
    throw new Error('Invalid understanding proposal.');
  }
  const observations = value.observations.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Invalid user observation.');
    }
    const record = item as Record<string, unknown>;
    if (!userTopics.includes(record.topic as UserTopic) || typeof record.quote !== 'string'
      || record.quote.length < 4 || record.quote.length > 300
      || /[\x00-\x1f]/u.test(record.quote) || looksSensitive(record.quote)) {
      throw new Error('Invalid or sensitive user observation.');
    }
    const supersedes = record.supersedes ?? [];
    if (!Array.isArray(supersedes) || supersedes.length > 4 || supersedes.some((prior) =>
      typeof prior !== 'string' || prior.length < 4 || prior.length > 300
      || /[\x00-\x1f]/u.test(prior) || looksSensitive(prior))) {
      throw new Error('Invalid user correction.');
    }
    return { topic: record.topic as UserTopic, quote: normalize(record.quote),
      supersedes: supersedes.map((prior: string) => normalize(prior)) };
  });
  return { observations };
}

function sameAudience(left: AssistantAudience, right: AssistantAudience): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function evidence(row: ObservationRow): AssistantEvidenceRef {
  return { sourceId: row.source_id, sourceVersion: row.source_version,
    observedAt: row.observed_at };
}

async function put(memory: AssistantMemoryRepository, input: {
  id: string; section: 'memories' | 'work'; kind: 'explicit' | 'observed';
  audience: AssistantAudience; context: string; verifiedAt: string; text: string;
  evidence: AssistantEvidenceRef[]; dependsOn: string[]; status?: 'active' | 'withdrawn';
}): Promise<AssistantMemoryDocument | undefined> {
  const current = await memory.get(input.id);
  if (current?.manualAuthority) return current;
  const status = input.status ?? 'active';
  if (current && current.text === input.text && current.status === status
    && JSON.stringify(current.evidence) === JSON.stringify(input.evidence)
    && JSON.stringify(current.dependsOn) === JSON.stringify(input.dependsOn)) return current;
  if (!current && status === 'withdrawn') return undefined;
  const revisionId = `understanding-${digest(JSON.stringify([input.id, current?.version ?? 0,
    status, input.text,
    input.evidence, input.dependsOn])).slice(0, 32)}`;
  return memory.commit({ ...input, expectedVersion: current?.version ?? 0,
    revisionId, reason: 'Reconcile evidence-backed user understanding',
    manualAuthority: false, status });
}

/** Stores model candidates, then renders only source-verified quotations through the revision API. */
export class AssistantUserUnderstanding {
  constructor(private readonly memory: AssistantMemoryRepository,
    private readonly now: () => Date = () => new Date()) {
    memory.sources.database.exec(schema);
  }

  private get database(): DatabaseSync { return this.memory.sources.database; }
  private get sources(): AssistantSourceStore { return this.memory.sources; }

  snapshot(job: AutomationJob): UnderstandingSnapshot | undefined {
    if (job.kind !== 'understand-user' || !job.sourceId || !job.sourceVersion) return undefined;
    if (job.audience.kind !== 'personal' || job.audience.id !== 'local-user') return undefined;
    const source = this.sources.source(job.sourceId);
    if (!source || source.sourceVersion !== job.sourceVersion || source.availability !== 'available'
      || !sameAudience(source.audience, job.audience)
      || !(job.sourceId.startsWith('assistant-turn:') || job.sourceId.startsWith('work-turn:'))) {
      return undefined;
    }
    const text = this.sources.sourceText(job.sourceId, job.audience);
    const userText = text && userSpeech(text);
    if (!userText) return undefined;
    const event = this.database.prepare(`SELECT work_id,occurred_at,rowid AS event_order FROM source_events
      WHERE source_id=? AND source_version=? ORDER BY rowid DESC LIMIT 1`)
      .get(job.sourceId, job.sourceVersion) as
      { work_id: string | null; occurred_at: string; event_order: number } | undefined;
    if (!event || (job.sourceId.startsWith('work-turn:') && !event.work_id)) return undefined;
    return { sourceId: job.sourceId, sourceVersion: job.sourceVersion,
      audience: job.audience, observedAt: event.occurred_at, eventOrder: event.event_order,
      ...(event.work_id ? { workId: event.work_id } : {}),
      userText: userText.slice(0, 4000) };
  }

  record(job: AutomationJob, snapshot: UnderstandingSnapshot,
    proposal: UnderstandingProposal, commit: (write: () => void) => boolean,
    recordCheckpoint: (value: unknown) => void): boolean {
    if (job.sourceId !== snapshot.sourceId || job.sourceVersion !== snapshot.sourceVersion
      || !sameAudience(job.audience, snapshot.audience)) throw new Error('Understanding source changed.');
    const current = this.snapshot(job);
    if (!current || current.userText !== snapshot.userText) {
      throw new Error('Understanding material changed before commit.');
    }
    const valid = proposal.observations.filter((item) =>
      isDirectUserStatement(snapshot.userText, item.quote, item.topic));
    if (valid.length !== proposal.observations.length) {
      throw new Error('Understanding proposal quoted text outside the user message.');
    }
    return commit(() => {
      if (!this.snapshot(job)) throw new Error('Understanding source changed during commit.');
      for (const item of valid) {
        this.database.prepare(`INSERT OR IGNORE INTO assistant_user_observations
          (source_id,source_version,quote_hash,audience_kind,audience_id,observed_at,
           event_order,work_id,topic,quote) VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(snapshot.sourceId, snapshot.sourceVersion, digest(item.quote),
            job.audience.kind, job.audience.id, snapshot.observedAt, snapshot.eventOrder,
            snapshot.workId ?? null, item.topic, item.quote);
        if (item.supersedes.length
          && /(?:更正|其实|不再|现在|改为|并非|不是|rather|actually|no longer|instead)/iu
            .test(snapshot.userText)) {
          for (const prior of item.supersedes) {
            const existing = this.database.prepare(`SELECT 1 FROM assistant_user_observations
              WHERE topic=? AND quote=? AND audience_kind=? AND audience_id=? LIMIT 1`)
              .get(item.topic, prior, job.audience.kind, job.audience.id);
            if (existing) this.database.prepare(`INSERT OR IGNORE INTO assistant_user_corrections
              (source_id,source_version,topic,prior_quote_hash,observed_at,event_order,
               audience_kind,audience_id) VALUES (?,?,?,?,?,?,?,?)`)
              .run(snapshot.sourceId, snapshot.sourceVersion,
                item.topic, digest(prior), snapshot.observedAt, snapshot.eventOrder,
                job.audience.kind, job.audience.id);
          }
        }
      }
      recordCheckpoint({ sourceId: snapshot.sourceId, sourceVersion: snapshot.sourceVersion,
        observationCount: valid.length });
    });
  }

  /** Rebuilds readable notes after a crash, correction or source deletion. */
  async reconcile(audience: AssistantAudience = { kind: 'personal', id: 'local-user' }): Promise<void> {
    if (audience.kind !== 'personal' || audience.id !== 'local-user') return;
    // A deletion or replacement removes raw candidate text, including candidates that
    // never became a memory. Temporary source outages keep their candidates intact.
    this.database.prepare(`DELETE FROM assistant_user_observations WHERE source_id IN (
      SELECT o.source_id FROM assistant_user_observations o
      LEFT JOIN source_current s ON s.source_id=o.source_id
      LEFT JOIN forgotten_sources f ON f.source_id=o.source_id
      WHERE s.source_id IS NULL OR s.availability='deleted'
        OR s.source_version!=o.source_version OR f.source_id IS NOT NULL
    )`).run();
    this.database.prepare(`DELETE FROM assistant_user_corrections WHERE source_id IN (
      SELECT c.source_id FROM assistant_user_corrections c
      LEFT JOIN source_current s ON s.source_id=c.source_id
      LEFT JOIN forgotten_sources f ON f.source_id=c.source_id
      WHERE s.source_id IS NULL OR s.availability='deleted'
        OR s.source_version!=c.source_version OR f.source_id IS NOT NULL
    )`).run();
    const rows = this.database.prepare(`SELECT o.* FROM assistant_user_observations o
      JOIN source_current s ON s.source_id=o.source_id AND s.source_version=o.source_version
      WHERE o.audience_kind=? AND o.audience_id=? AND s.availability='available'
      ORDER BY o.observed_at,o.source_id`).all(audience.kind, audience.id) as unknown as ObservationRow[];
    const all = rows.filter((row) => !this.sources.isForgotten(row.source_id)
      && !this.database.prepare(`SELECT 1 FROM assistant_user_corrections c
        JOIN source_current s ON s.source_id=c.source_id AND s.source_version=c.source_version
        WHERE c.topic=? AND c.prior_quote_hash=? AND c.audience_kind=? AND c.audience_id=?
          AND s.availability!='deleted'
          AND (c.observed_at> ? OR (c.observed_at=? AND c.event_order>=?)) LIMIT 1`)
        .get(row.topic, digest(row.quote), audience.kind, audience.id,
          row.observed_at, row.observed_at, row.event_order));
    const counts = new Map<string, Set<string>>();
    for (const row of all) if (row.work_id) {
      const key = `${row.topic}:${row.quote}`;
      const distinct = counts.get(key) ?? new Set<string>();
      distinct.add(row.work_id);
      counts.set(key, distinct);
    }
    const promoted = all.filter((row) => !row.work_id
      || (counts.get(`${row.topic}:${row.quote}`)?.size ?? 0) >= 2);
    const activeTopics: Array<{ topic: UserTopic; id: string; text: string;
      evidence: AssistantEvidenceRef[]; verifiedAt: string }> = [];
    for (const topic of userTopics) {
      const topicRows = promoted.filter((row) => row.topic === topic
        && (topic !== 'context' || this.now().getTime() - Date.parse(row.observed_at) <= 7 * 86_400_000));
      const id = topic === 'collaboration' ? 'collaboration' : topic === 'context'
        ? 'work-user-context' : `user-${topic}`;
      const section: 'work' | 'memories' = topic === 'context' ? 'work' : 'memories';
      const current = await this.memory.get(id);
      // Preserve only claims already present in the readable note during an outage.
      // A correction may replace one claim without erasing unrelated unavailable claims.
      if (current?.status === 'active') for (const ref of current.evidence) {
        const source = this.sources.source(ref.sourceId);
        if (source?.sourceVersion !== ref.sourceVersion
          || source.availability !== 'temporarily_unavailable') continue;
        const saved = this.database.prepare(`SELECT * FROM assistant_user_observations
          WHERE source_id=? AND source_version=? AND topic=? AND audience_kind=? AND audience_id=?`)
          .all(ref.sourceId, ref.sourceVersion, topic, audience.kind, audience.id) as unknown as ObservationRow[];
        for (const row of saved) {
          if (!current.text.includes(`用户原话：「${row.quote}」`)
            || (topic === 'context' && this.now().getTime() - Date.parse(row.observed_at) > 7 * 86_400_000)) continue;
          const corrected = this.database.prepare(`SELECT 1 FROM assistant_user_corrections c
            JOIN source_current s ON s.source_id=c.source_id AND s.source_version=c.source_version
            WHERE c.topic=? AND c.prior_quote_hash=? AND c.audience_kind=? AND c.audience_id=?
              AND s.availability='available' AND (c.observed_at>?
                OR (c.observed_at=? AND c.event_order>=?)) LIMIT 1`)
            .get(topic, digest(row.quote), audience.kind, audience.id,
              row.observed_at, row.observed_at, row.event_order);
          if (!corrected) topicRows.push(row);
        }
      }
      topicRows.sort((left, right) => left.observed_at.localeCompare(right.observed_at)
        || left.event_order - right.event_order);
      const selected = topicRows.slice(-12);
      if (!selected.length) {
        if (current && !current.manualAuthority) await put(this.memory, { id, section,
          kind: 'explicit', audience, context: `User ${topic} evidence`,
          verifiedAt: this.now().toISOString(), text: 'No current evidence.',
          evidence: [], dependsOn: [], status: 'withdrawn' });
        continue;
      }
      const grouped = new Map<string, ObservationRow[]>();
      for (const row of selected) grouped.set(row.quote,
        [...(grouped.get(row.quote) ?? []), row]);
      const lines = [`# ${topic}`, ''];
      for (const [quote, supported] of grouped) {
        lines.push(`- 用户原话：「${quote}」`,
          `  - 来源：${supported.map((row) => `${row.source_id} @ ${row.source_version}`).join('；')}`);
      }
      const text = lines.join('\n');
      const refs = selected.map(evidence);
      const verifiedAt = selected.at(-1)!.observed_at;
      const document = await put(this.memory, { id, section,
        kind: selected.every((row) => row.work_id) ? 'observed' : 'explicit',
        audience, context: `Source-backed ${topic} statements`,
        verifiedAt, text, evidence: refs, dependsOn: [] });
      if (document?.status === 'active') activeTopics.push({ topic, id, text: document.text,
        evidence: document.evidence, verifiedAt: document.verifiedAt });
    }
    const lasting = activeTopics.filter((item) => item.topic !== 'context');
    await this.summary('user-summary', '# About the user', lasting, audience, 6000);
    await this.summary('core-memory', '# Current memory', lasting.filter((item) =>
      ['working-style', 'preferences', 'goals', 'collaboration'].includes(item.topic)),
    audience, 2500);
  }

  private async summary(id: 'user-summary' | 'core-memory', title: string,
    topics: Array<{ topic: UserTopic; id: string; text: string;
      evidence: AssistantEvidenceRef[]; verifiedAt: string }>, audience: AssistantAudience,
    maxCharacters: number): Promise<void> {
    const current = await this.memory.get(id);
    if (!topics.length) {
      if (current && !current.manualAuthority) await put(this.memory, { id,
        section: 'memories', kind: 'explicit', audience, context: 'Core assistant summary',
        verifiedAt: this.now().toISOString(), text: `${title}\n\nNo verified facts yet.`,
        evidence: [], dependsOn: [], status: 'withdrawn' });
      return;
    }
    const lines = [title, ''];
    const included: typeof topics = [];
    for (const topic of topics) {
      const entry = `- ${topic.topic}: ${topic.text.split('\n').filter((line) =>
        line.startsWith('- 用户原话')).map((line) => line.slice(2)).join('；')} (see ${topic.id})`;
      if (lines.join('\n').length + entry.length > maxCharacters) break;
      lines.push(entry);
      included.push(topic);
    }
    if (!included.length) return;
    await put(this.memory, { id, section: 'memories', kind: 'explicit', audience,
      context: 'Core assistant summary', verifiedAt: included.at(-1)!.verifiedAt,
      text: lines.join('\n'), evidence: [], dependsOn: included.map((item) => item.id) });
  }
}
