import {
  HOST_EVENT_CONTRACT_VERSION,
  RUNTIME_ROUTES,
  type HostEvent,
  type HostEventReceipt,
} from '@yuanpu-agent/protocol';

export interface HostEventConnection {
  host: string;
  port: number;
  token: string;
}

export interface AuthenticatedHostEventClientOptions {
  reconnectDelayMs?: number;
  fetch?: typeof fetch;
  onError?: (error: Error) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseHostEvent(value: unknown): HostEvent {
  if (!isRecord(value) || value.contractVersion !== HOST_EVENT_CONTRACT_VERSION) {
    throw new Error('The Runtime returned an unsupported host event contract.');
  }
  if (
    typeof value.eventId !== 'string'
    || !value.eventId
    || value.eventId.length > 200
    || !Number.isSafeInteger(value.sequence)
    || typeof value.occurredAt !== 'string'
    || !isRecord(value.payload)
  ) {
    throw new Error('The Runtime returned an invalid host event envelope.');
  }
  if (value.type === 'notification_requested') {
    if (
      typeof value.payload.requestId !== 'string'
      || typeof value.payload.title !== 'string'
      || typeof value.payload.body !== 'string'
      || !['run_succeeded', 'run_failed', 'approval_required', 'reminder'].includes(
        String(value.payload.kind),
      )
    ) {
      throw new Error('The Runtime returned an invalid notification event.');
    }
    return value as unknown as HostEvent;
  }
  if (value.type === 'run_state_changed') {
    if (
      typeof value.payload.runId !== 'string'
      || typeof value.payload.previousStatus !== 'string'
      || typeof value.payload.status !== 'string'
      || typeof value.payload.conversationId !== 'string'
    ) {
      throw new Error('The Runtime returned an invalid run state event.');
    }
    return value as unknown as HostEvent;
  }
  throw new Error(`The Runtime returned an unknown host event type: ${String(value.type)}.`);
}

function formatError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class AuthenticatedHostEventClient {
  readonly #resolveConnection: () => Promise<HostEventConnection>;
  readonly #handle: (event: HostEvent) => Promise<HostEventReceipt>;
  readonly #fetch: typeof fetch;
  readonly #reconnectDelayMs: number;
  readonly #onError?: (error: Error) => void;
  #running = false;
  #loop?: Promise<void>;
  #abort?: AbortController;
  #lastEventId?: string;

  constructor(
    resolveConnection: () => Promise<HostEventConnection>,
    handle: (event: HostEvent) => Promise<HostEventReceipt>,
    options: AuthenticatedHostEventClientOptions = {},
  ) {
    this.#resolveConnection = resolveConnection;
    this.#handle = handle;
    this.#fetch = options.fetch ?? fetch;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 250;
    this.#onError = options.onError;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#abort?.abort();
    await this.#loop?.catch(() => undefined);
    this.#loop = undefined;
  }

  async #run(): Promise<void> {
    while (this.#running) {
      this.#abort = new AbortController();
      try {
        const connection = await this.#resolveConnection();
        if (!this.#running) break;
        await this.#connect(connection, this.#abort.signal);
      } catch (error) {
        if (!this.#running || this.#abort.signal.aborted) break;
        this.#onError?.(formatError(error));
      }
      if (!this.#running) break;
      await new Promise<void>((resolveDelay) => {
        const timer = setTimeout(resolveDelay, this.#reconnectDelayMs);
        timer.unref?.();
      });
    }
    this.#abort = undefined;
  }

  async #connect(connection: HostEventConnection, signal: AbortSignal): Promise<void> {
    const origin = `http://${connection.host}:${connection.port}`;
    const response = await this.#fetch(`${origin}${RUNTIME_ROUTES.hostEvents}`, {
      headers: {
        accept: 'text/event-stream',
        authorization: `Bearer ${connection.token}`,
        ...(this.#lastEventId ? { 'last-event-id': this.#lastEventId } : {}),
      },
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Runtime host event connection failed with HTTP ${response.status}.`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (this.#running) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 256 * 1024) throw new Error('Runtime host event stream exceeded its buffer limit.');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary).replace(/\r/gu, '');
        buffer = buffer.slice(boundary + 2);
        await this.#consumeBlock(origin, connection.token, block, signal);
        boundary = buffer.indexOf('\n\n');
      }
    }
  }

  async #consumeBlock(origin: string, token: string, block: string, signal: AbortSignal): Promise<void> {
    if (!block || block.startsWith(':')) return;
    let eventId = '';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) eventId = line.slice(3).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!eventId || data.length === 0) return;
    const event = parseHostEvent(JSON.parse(data.join('\n')) as unknown);
    if (event.eventId !== eventId) throw new Error('Runtime SSE event id does not match its envelope.');
    const receipt = await this.#handle(event);
    if (receipt.eventId !== event.eventId) throw new Error('Host event handler returned a mismatched receipt.');
    const acknowledged = await this.#fetch(`${origin}${RUNTIME_ROUTES.hostEventReceipts}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(receipt),
      signal,
    });
    if (!acknowledged.ok) {
      throw new Error(`Runtime rejected a host event receipt with HTTP ${acknowledged.status}.`);
    }
    this.#lastEventId = event.eventId;
  }
}
