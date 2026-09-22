import {
  HOST_EVENT_CONTRACT_VERSION,
  type HostEvent,
  type HostEventReceipt,
  type NotificationNavigationTarget,
  type NotificationReceipt,
  type NotificationTargetValidation,
} from '@yuanpu-agent/protocol';

export interface NativeNotification {
  once(event: 'show', listener: () => void): this;
  once(event: 'failed', listener: (_event: unknown, error: string) => void): this;
  on(event: 'click' | 'close', listener: () => void): this;
  show(): void;
  close(): void;
}

export interface NativeNotificationPlatform {
  isSupported(): boolean;
  permissionState(): 'granted' | 'denied' | 'unknown';
  create(options: { title: string; body: string }): NativeNotification;
}

export interface ElectronNotificationHostOptions {
  platform: NativeNotificationPlatform;
  enabled(): boolean;
  validateTarget(target: NotificationNavigationTarget): Promise<NotificationTargetValidation>;
  navigate(target: NotificationNavigationTarget): void;
  focus(): void;
  submissionTimeoutMs?: number;
  maximumRememberedEvents?: number;
  onError?: (error: Error) => void;
}

interface ActiveNotification {
  notification: NativeNotification;
  finish(receipt: NotificationReceipt): void;
  requestId: string;
}

function statusReceipt(
  requestId: string,
  status: NotificationReceipt['status'],
  message?: string,
): NotificationReceipt {
  return {
    requestId,
    status,
    userVisibility: 'unknown',
    ...(message ? { message } : {}),
  };
}

function targetFor(event: Extract<HostEvent, { type: 'notification_requested' }>): NotificationNavigationTarget | undefined {
  const { conversationId, runId } = event.payload;
  if (!conversationId && !runId) return undefined;
  return {
    ...(conversationId ? { conversationId } : {}),
    ...(runId ? { runId } : {}),
  };
}

export class ElectronNotificationHost {
  readonly #options: ElectronNotificationHostOptions;
  readonly #submissionTimeoutMs: number;
  readonly #maximumRememberedEvents: number;
  readonly #receiptsByEvent = new Map<string, NotificationReceipt>();
  readonly #receiptsByRequest = new Map<string, NotificationReceipt>();
  readonly #active = new Map<string, ActiveNotification>();
  #stopped = false;

  constructor(options: ElectronNotificationHostOptions) {
    this.#options = options;
    this.#submissionTimeoutMs = options.submissionTimeoutMs ?? 2_000;
    this.#maximumRememberedEvents = options.maximumRememberedEvents ?? 500;
  }

  async handle(event: HostEvent): Promise<HostEventReceipt> {
    if (event.contractVersion !== HOST_EVENT_CONTRACT_VERSION) {
      return { eventId: event.eventId, status: 'unsupported', message: 'Unsupported host event contract.' };
    }
    if (event.type !== 'notification_requested') {
      return { eventId: event.eventId, status: 'unsupported', message: `Unsupported event type ${event.type}.` };
    }
    const previous = this.#receiptsByEvent.get(event.eventId)
      ?? this.#receiptsByRequest.get(event.payload.requestId);
    if (previous) return { eventId: event.eventId, status: 'duplicate', notification: previous };

    let receipt: NotificationReceipt;
    if (this.#stopped) {
      receipt = statusReceipt(event.payload.requestId, 'unavailable', 'The App is exiting.');
      this.#remember(event, receipt);
      return { eventId: event.eventId, status: 'rejected', notification: receipt };
    }
    if (!this.#options.enabled()) {
      receipt = statusReceipt(event.payload.requestId, 'suppressed', 'Notifications are disabled by the user.');
      this.#remember(event, receipt);
      return { eventId: event.eventId, status: 'accepted', notification: receipt };
    }
    if (!this.#options.platform.isSupported()) {
      receipt = statusReceipt(event.payload.requestId, 'unavailable', 'Native notifications are not supported on this system.');
      this.#remember(event, receipt);
      return { eventId: event.eventId, status: 'accepted', notification: receipt };
    }
    if (this.#options.platform.permissionState() === 'denied') {
      receipt = statusReceipt(event.payload.requestId, 'unavailable', 'Notification permission is denied in system settings.');
      this.#remember(event, receipt);
      return { eventId: event.eventId, status: 'accepted', notification: receipt };
    }

    receipt = await this.#submit(event);
    this.#remember(event, receipt);
    return { eventId: event.eventId, status: 'accepted', notification: receipt };
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const active of this.#active.values()) {
      active.notification.close();
      active.finish(statusReceipt(active.requestId, 'unavailable', 'The App exited before submission completed.'));
    }
    this.#active.clear();
  }

  #submit(event: Extract<HostEvent, { type: 'notification_requested' }>): Promise<NotificationReceipt> {
    const { requestId, title, body } = event.payload;
    return new Promise<NotificationReceipt>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (result: NotificationReceipt) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      let notification: NativeNotification;
      try {
        notification = this.#options.platform.create({ title, body });
        this.#active.set(event.eventId, { notification, finish, requestId });
        notification.once('show', () => finish(statusReceipt(
          requestId,
          'submitted',
          'The operating system accepted the notification; whether the user saw it is unknown.',
        )));
        notification.once('failed', (_nativeEvent, error) => {
          this.#active.delete(event.eventId);
          finish(statusReceipt(requestId, 'failed', error || 'The operating system rejected the notification.'));
        });
        notification.on('close', () => this.#active.delete(event.eventId));
        notification.on('click', () => {
          void this.#activate(event).catch((error) => this.#options.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          ));
        });
        timer = setTimeout(() => {
          this.#active.delete(event.eventId);
          finish(statusReceipt(requestId, 'failed', 'The operating system did not confirm notification submission.'));
        }, this.#submissionTimeoutMs);
        timer.unref?.();
        notification.show();
      } catch (error) {
        this.#active.delete(event.eventId);
        finish(statusReceipt(
          requestId,
          'failed',
          error instanceof Error ? error.message : String(error),
        ));
      }
    });
  }

  async #activate(event: Extract<HostEvent, { type: 'notification_requested' }>): Promise<void> {
    if (this.#stopped) return;
    const target = targetFor(event);
    if (!target) {
      this.#options.focus();
      return;
    }
    const validation = await this.#options.validateTarget(target);
    if (this.#stopped || !validation.valid || !validation.target) return;
    this.#options.focus();
    this.#options.navigate(validation.target);
  }

  #remember(
    event: Extract<HostEvent, { type: 'notification_requested' }>,
    receipt: NotificationReceipt,
  ): void {
    this.#receiptsByEvent.set(event.eventId, receipt);
    this.#receiptsByRequest.set(event.payload.requestId, receipt);
    while (this.#receiptsByEvent.size > this.#maximumRememberedEvents) {
      const oldest = this.#receiptsByEvent.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#receiptsByEvent.delete(oldest);
    }
    while (this.#receiptsByRequest.size > this.#maximumRememberedEvents) {
      const oldest = this.#receiptsByRequest.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#receiptsByRequest.delete(oldest);
    }
  }
}
