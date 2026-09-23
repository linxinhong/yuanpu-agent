import { randomUUID } from 'node:crypto';

import {
  HOST_EVENT_CONTRACT_VERSION,
  type HostEvent,
  type HostEventReceipt,
  type AgentRunRecord,
  type NotificationReceipt,
} from '@yuanpu-agent/protocol';

import type {
  CapabilityContext,
  CapabilityDefinition,
  CapabilitySourceExecuteInput,
} from '../capabilities/contracts.js';
import type { CapabilitySource } from '../capabilities/index.js';
import type { SchedulerStore } from '../scheduler/store.js';

export interface NotificationRequestInput {
  title: string;
  body: string;
  kind: 'run_succeeded' | 'run_failed' | 'approval_required' | 'reminder';
  conversationId?: string;
  runId?: string;
}

export interface HostNotificationRouterOptions {
  receiptTimeoutMs?: number;
  maximumPendingEvents?: number;
  createId?: () => string;
  now?: () => Date;
}

type HostEventListener = (event: HostEvent) => void;

interface PendingNotification {
  event: Extract<HostEvent, { type: 'notification_requested' }>;
  resolve(receipt: NotificationReceipt): void;
  timer?: NodeJS.Timeout;
}

function unavailable(requestId: string, message: string): NotificationReceipt {
  return { requestId, status: 'unavailable', userVisibility: 'unknown', message };
}

function assertBoundedText(value: string, name: string, maximumLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new Error(`${name} must be a non-empty string of at most ${maximumLength} characters.`);
  }
  return normalized;
}

export class HostNotificationRouter {
  readonly #receiptTimeoutMs?: number;
  readonly #maximumPendingEvents: number;
  readonly #createId: () => string;
  readonly #now: () => Date;
  readonly #listeners = new Set<HostEventListener>();
  readonly #pending = new Map<string, PendingNotification>();
  #sequence = 0;
  #closed = false;

  constructor(options: HostNotificationRouterOptions = {}) {
    this.#receiptTimeoutMs = options.receiptTimeoutMs;
    this.#maximumPendingEvents = options.maximumPendingEvents ?? 100;
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    if (this.#receiptTimeoutMs !== undefined
      && (!Number.isSafeInteger(this.#receiptTimeoutMs) || this.#receiptTimeoutMs < 1)) {
      throw new Error('receiptTimeoutMs must be a positive integer.');
    }
    if (!Number.isSafeInteger(this.#maximumPendingEvents) || this.#maximumPendingEvents < 1) {
      throw new Error('maximumPendingEvents must be a positive integer.');
    }
  }

  request(input: NotificationRequestInput): Promise<NotificationReceipt> {
    const requestId = this.#createId();
    if (this.#closed) return Promise.resolve(unavailable(requestId, 'The Runtime notification route is closed.'));
    if (this.#pending.size >= this.#maximumPendingEvents) {
      return Promise.resolve(unavailable(requestId, 'The Runtime notification queue is full.'));
    }
    const event: Extract<HostEvent, { type: 'notification_requested' }> = {
      contractVersion: HOST_EVENT_CONTRACT_VERSION,
      eventId: this.#createId(),
      sequence: ++this.#sequence,
      occurredAt: this.#now().toISOString(),
      type: 'notification_requested',
      payload: {
        requestId,
        title: assertBoundedText(input.title, 'title', 100),
        body: assertBoundedText(input.body, 'body', 500),
        kind: input.kind,
        ...(input.conversationId ? {
          conversationId: assertBoundedText(input.conversationId, 'conversationId', 512),
        } : {}),
        ...(input.runId ? { runId: assertBoundedText(input.runId, 'runId', 200) } : {}),
      },
    };

    return new Promise<NotificationReceipt>((resolve) => {
      const timer = this.#receiptTimeoutMs === undefined ? undefined : setTimeout(() => {
        if (!this.#pending.delete(event.eventId)) return;
        resolve(unavailable(requestId, 'The Electron host did not acknowledge the notification request in time.'));
      }, this.#receiptTimeoutMs);
      timer?.unref?.();
      this.#pending.set(event.eventId, { event, resolve, timer });
      for (const listener of this.#listeners) listener(event);
    });
  }

  subscribe(_lastEventId: string | undefined, listener: HostEventListener): () => void {
    if (this.#closed) return () => undefined;
    const events = [...this.#pending.values()].map(({ event }) => event);
    // A delivered SSE event remains pending until its authenticated receipt arrives.
    // Replay all pending events even when Last-Event-ID names one of them; the host
    // deduplicates by eventId and can re-send a lost receipt without showing twice.
    for (const event of events) listener(event);
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  acknowledge(receipt: HostEventReceipt): boolean {
    const pending = this.#pending.get(receipt.eventId);
    if (!pending) return false;
    const { requestId } = pending.event.payload;
    let notification = receipt.notification;
    if (notification && notification.requestId !== requestId) {
      notification = {
        requestId,
        status: 'failed',
        userVisibility: 'unknown',
        message: 'The host receipt did not match the notification request.',
      };
    }
    if (!notification) {
      notification = receipt.status === 'unsupported'
        ? unavailable(requestId, receipt.message ?? 'The Electron host does not support this event.')
        : {
            requestId,
            status: 'failed',
            userVisibility: 'unknown',
            message: receipt.message ?? 'The Electron host rejected the notification request.',
          };
    }
    if (pending.timer) clearTimeout(pending.timer);
    this.#pending.delete(receipt.eventId);
    pending.resolve(notification);
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    for (const [eventId, pending] of this.#pending) {
      if (pending.timer) clearTimeout(pending.timer);
      this.#pending.delete(eventId);
      pending.resolve(unavailable(
        pending.event.payload.requestId,
        'The Runtime stopped before the notification could be submitted.',
      ));
    }
  }
}

/**
 * Translate durable terminal run state into a data-minimal host notification.
 * This path is independent of model tool selection and deliberately excludes
 * prompts, outputs, and failure details from the native notification surface.
 */
export function requestTerminalRunNotification(
  router: HostNotificationRouter,
  run: AgentRunRecord,
): Promise<NotificationReceipt> | undefined {
  if (run.status !== 'succeeded' && run.status !== 'failed') return undefined;
  return router.request({
    title: run.status === 'succeeded' ? '任务已完成' : '任务执行失败',
    body: '点击查看对应会话与运行记录。',
    kind: run.status === 'succeeded' ? 'run_succeeded' : 'run_failed',
    conversationId: run.context.conversation.conversationId,
    runId: run.runId,
  });
}

/** Record the native-host submission result independently of scheduled IM delivery. */
export function requestRecordedTerminalRunNotification(
  router: HostNotificationRouter,
  store: Pick<SchedulerStore, 'beginNotification' | 'finishNotification'>,
  run: AgentRunRecord,
  now: () => Date = () => new Date(),
): void {
  if (run.status !== 'succeeded' && run.status !== 'failed') return;
  const scheduled = run.owner.entryPoint === 'scheduler';
  let recording = false;
  if (scheduled) {
    try {
      store.beginNotification(run.runId, now().toISOString());
      recording = true;
    } catch {
      console.error('Scheduled notification receipt could not be initialized.');
    }
  }
  const finish = (status: 'submitted' | 'suppressed' | 'unavailable' | 'failed'): void => {
    if (!recording) return;
    try {
      store.finishNotification(run.runId, status, now().toISOString());
    } catch {
      // A later startup records any unresolved receipt as unknown.
      console.error('Scheduled notification receipt could not be persisted.');
    }
  };
  try {
    const receipt = requestTerminalRunNotification(router, run);
    void receipt?.then((result) => finish(result.status)).catch(() => finish('failed'));
  } catch {
    finish('failed');
  }
}

const notifyUserCapability: CapabilityDefinition = {
  name: 'notify_user',
  description: 'Ask the Electron host to show a native system notification for the active Agent run.',
  type: 'host_notification',
  riskLevel: 'R1',
  status: 'available',
  inputSchema: {
    type: 'object',
    required: ['title', 'body'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 100 },
      body: { type: 'string', minLength: 1, maxLength: 500 },
    },
    additionalProperties: false,
  },
};

export function createNotificationCapabilitySource(router: HostNotificationRouter): CapabilitySource {
  return {
    sourceInstanceId: 'builtin.host.notifications',
    async list() {
      return [notifyUserCapability];
    },
    async resolve(name) {
      return name === notifyUserCapability.name ? notifyUserCapability : undefined;
    },
    async execute(input: CapabilitySourceExecuteInput, context: CapabilityContext) {
      if (input.originalName !== notifyUserCapability.name) return undefined;
      const title = input.arguments?.title;
      const body = input.arguments?.body;
      if (typeof title !== 'string' || typeof body !== 'string') return undefined;
      const receipt = await router.request({
        title,
        body,
        kind: 'reminder',
        ...(context.conversationId ? { conversationId: context.conversationId } : {}),
        ...(context.runId ? { runId: context.runId } : {}),
      });
      return {
        content: [{
          type: 'text',
          text: receipt.status === 'submitted'
            ? 'Notification submitted to the operating system; user visibility remains unknown.'
            : `Notification ${receipt.status}: ${receipt.message ?? 'no additional detail'}`,
        }],
        structuredContent: {
          requestId: receipt.requestId,
          status: receipt.status,
          userVisibility: receipt.userVisibility,
          ...(receipt.message ? { message: receipt.message } : {}),
        },
        isError: receipt.status === 'failed',
      };
    },
  };
}
