import { WSClient } from '@wecom/aibot-node-sdk';

import type {
  ChannelDeliveryResult,
  ChannelReplyRoute,
  ChannelTransport,
  NormalizedChannelMessage,
} from '../contracts.js';

export type RedactedLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RedactedChannelLog {
  level: RedactedLogLevel;
  event: string;
}

export type RedactedChannelLogSink = (record: RedactedChannelLog) => void;

interface WecomFrame {
  headers?: { req_id?: unknown };
  body?: {
    msgid?: unknown;
    aibotid?: unknown;
    chatid?: unknown;
    chattype?: unknown;
    from?: { userid?: unknown };
    msgtype?: unknown;
    text?: { content?: unknown };
  };
}

interface WecomClientLike {
  connect(): unknown;
  disconnect(): void;
  on(event: 'message', handler: (frame: WecomFrame) => void): unknown;
  on(event: 'error', handler: (error: Error) => void): unknown;
  on(event: 'authenticated', handler: () => void): unknown;
  replyStream(
    frame: { headers: { req_id: string } },
    streamId: string,
    content: string,
    finish: boolean,
  ): Promise<{ errcode?: number }>;
  readonly isConnected: boolean;
}

export interface WecomTransportOptions {
  connectionId: string;
  botId: string;
  secret: string;
  log?: RedactedChannelLogSink;
  clientFactory?: (options: {
    botId: string;
    secret: string;
    logger: ReturnType<typeof createWecomRedactingLogger>;
  }) => WecomClientLike;
}

function safeEvent(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('authenticated') || normalized.includes('authentication successful')) {
    return 'wecom.authenticated';
  }
  if (normalized.includes('authentication failed') || normalized.includes('auth failed')) {
    return 'wecom.authentication_failed';
  }
  if (normalized.includes('reconnect')) return 'wecom.reconnecting';
  if (normalized.includes('heartbeat')) return 'wecom.heartbeat';
  if (normalized.includes('disconnect') || normalized.includes('closed')) return 'wecom.disconnected';
  if (normalized.includes('connect')) return 'wecom.connection';
  if (normalized.includes('reply ack timeout')) return 'wecom.reply_ack_timeout';
  if (normalized.includes('reply ack error')) return 'wecom.reply_rejected';
  if (normalized.includes('reply ack')) return 'wecom.reply_ack';
  if (normalized.includes('reply')) return 'wecom.reply';
  if (normalized.includes('message')) return 'wecom.message';
  if (normalized.includes('frame')) return 'wecom.frame';
  if (normalized.includes('error') || normalized.includes('failed')) return 'wecom.error';
  return 'wecom.sdk';
}

/**
 * The official SDK sometimes embeds entire frames in `message` and passes unsafe objects in `args`.
 * This boundary deliberately emits only a fixed event label and never forwards either value.
 */
export function createWecomRedactingLogger(sink: RedactedChannelLogSink = () => undefined) {
  const emit = (level: RedactedLogLevel) => (message: string, ..._args: unknown[]) => {
    sink({ level, event: safeEvent(String(message)) });
  };
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeFrame(connectionId: string, frame: WecomFrame): NormalizedChannelMessage | undefined {
  const body = frame.body;
  const providerRequestId = asString(frame.headers?.req_id);
  const providerMessageId = asString(body?.msgid);
  const providerBotId = asString(body?.aibotid);
  const senderId = asString(body?.from?.userid);
  const messageType = asString(body?.msgtype);
  const conversationType = body?.chattype === 'single' || body?.chattype === 'group'
    ? body.chattype
    : undefined;
  const conversationId = conversationType === 'group'
    ? asString(body?.chatid)
    : senderId;
  if (
    !providerRequestId
    || !providerMessageId
    || !providerBotId
    || !senderId
    || !messageType
    || !conversationType
    || !conversationId
  ) return undefined;
  const text = messageType === 'text' ? asString(body?.text?.content) : undefined;
  return {
    provider: 'wecom',
    connectionId,
    providerBotId,
    providerRequestId,
    providerMessageId,
    senderId,
    conversationType,
    conversationId,
    messageType,
    ...(text ? { text } : {}),
  };
}

export class WecomSdkTransport implements ChannelTransport {
  readonly #client: WecomClientLike;
  readonly #connectionId: string;
  readonly #log: RedactedChannelLogSink;
  #started = false;
  #closed = false;
  readonly #inboundTasks = new Set<Promise<void>>();
  readonly #readyPromise: Promise<void>;
  readonly #resolveReady: () => void;

  constructor(options: WecomTransportOptions) {
    this.#connectionId = options.connectionId;
    this.#log = options.log ?? (() => undefined);
    let resolveReady!: () => void;
    this.#readyPromise = new Promise((resolve) => { resolveReady = resolve; });
    this.#resolveReady = resolveReady;
    const logger = createWecomRedactingLogger(this.#log);
    this.#client = options.clientFactory
      ? options.clientFactory({ botId: options.botId, secret: options.secret, logger })
      : new WSClient({
          botId: options.botId,
          secret: options.secret,
          logger,
          maxReconnectAttempts: 10,
          maxAuthFailureAttempts: 5,
          reconnectInterval: 1_000,
          heartbeatInterval: 30_000,
          requestTimeout: 10_000,
          maxReplyQueueSize: 100,
        });
  }

  connect(onMessage: (message: NormalizedChannelMessage) => Promise<void>): void {
    if (this.#closed) throw new Error('WeCom transport is closed.');
    if (this.#started) return;
    this.#started = true;
    this.#client.on('message', (frame) => {
      const normalized = normalizeFrame(this.#connectionId, frame);
      if (!normalized) {
        this.#log({ level: 'warn', event: 'wecom.invalid_message' });
        return;
      }
      const task = Promise.resolve().then(() => onMessage(normalized))
        .catch(() => this.#log({ level: 'error', event: 'wecom.inbound_failed' }))
        .finally(() => this.#inboundTasks.delete(task));
      this.#inboundTasks.add(task);
    });
    this.#client.on('error', () => {
      this.#log({ level: 'error', event: 'wecom.transport_error' });
    });
    this.#client.on('authenticated', () => this.#resolveReady());
    this.#client.connect();
  }

  ready(): Promise<void> {
    return this.#readyPromise;
  }

  async reply(
    route: ChannelReplyRoute,
    outboundId: string,
    content: string,
  ): Promise<ChannelDeliveryResult> {
    if (this.#closed || !this.#client.isConnected) {
      return { status: 'failed', code: 'not_connected' };
    }
    try {
      const receipt = await this.#client.replyStream(
        { headers: { req_id: route.providerRequestId } },
        outboundId,
        content,
        true,
      );
      if (receipt.errcode === 0) return { status: 'accepted' };
      if (typeof receipt.errcode === 'number') {
        return { status: 'failed', code: `provider_${receipt.errcode}` };
      }
      return { status: 'unknown', code: 'malformed_receipt' };
    } catch (error) {
      if (
        error
        && typeof error === 'object'
        && 'errcode' in error
        && typeof error.errcode === 'number'
      ) {
        return { status: 'failed', code: `provider_${error.errcode}` };
      }
      return { status: 'unknown', code: 'transport_uncertain' };
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#resolveReady();
    if (this.#started) this.#client.disconnect();
    await Promise.allSettled([...this.#inboundTasks]);
  }
}
