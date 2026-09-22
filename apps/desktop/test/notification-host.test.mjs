import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { ElectronNotificationHost } from '../dist/notification-host.cjs';

function event(overrides = {}) {
  return {
    contractVersion: 1,
    eventId: 'event-1',
    sequence: 1,
    occurredAt: '2026-09-22T00:00:00.000Z',
    type: 'notification_requested',
    payload: {
      requestId: 'request-1',
      title: 'Done',
      body: 'Task completed',
      kind: 'run_succeeded',
      conversationId: 'default',
      runId: 'run-1',
    },
    ...overrides,
  };
}

class FakeNotification extends EventEmitter {
  constructor(mode = 'show') {
    super();
    this.mode = mode;
    this.closed = false;
  }

  show() {
    if (this.mode === 'show') queueMicrotask(() => this.emit('show'));
    if (this.mode === 'failed') queueMicrotask(() => this.emit('failed', {}, 'permission denied'));
  }

  close() {
    this.closed = true;
    this.emit('close');
  }
}

function setup(overrides = {}) {
  const { platform: platformOverrides = {}, ...hostOverrides } = overrides;
  const created = [];
  const navigated = [];
  let focused = 0;
  const host = new ElectronNotificationHost({
    platform: {
      isSupported: () => true,
      permissionState: () => 'granted',
      create: () => {
        const notification = new FakeNotification();
        created.push(notification);
        return notification;
      },
      ...platformOverrides,
    },
    enabled: () => true,
    validateTarget: async (target) => ({ valid: true, target }),
    navigate: (target) => navigated.push(target),
    focus: () => { focused += 1; },
    submissionTimeoutMs: 50,
    ...hostOverrides,
  });
  return { host, created, navigated, focused: () => focused };
}

test('reports native submission without claiming the user saw it and deduplicates replay', async () => {
  const { host, created } = setup();
  const first = await host.handle(event());
  assert.equal(first.status, 'accepted');
  assert.equal(first.notification.status, 'submitted');
  assert.equal(first.notification.userVisibility, 'unknown');
  assert.match(first.notification.message, /whether the user saw it is unknown/);
  const replay = await host.handle(event());
  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.notification.status, 'submitted');
  assert.equal(created.length, 1);
});

test('returns explicit disabled, unsupported, denied, and native failure states', async () => {
  const disabled = setup({ enabled: () => false });
  assert.equal((await disabled.host.handle(event())).notification.status, 'suppressed');

  const unsupported = setup({ platform: { isSupported: () => false } });
  assert.equal((await unsupported.host.handle(event())).notification.status, 'unavailable');

  const denied = setup({ platform: { permissionState: () => 'denied' } });
  const deniedReceipt = await denied.host.handle(event());
  assert.equal(deniedReceipt.notification.status, 'unavailable');
  assert.match(deniedReceipt.notification.message, /permission is denied/);

  const failed = setup({
    platform: { create: () => new FakeNotification('failed') },
  });
  const failedReceipt = await failed.host.handle(event());
  assert.equal(failedReceipt.notification.status, 'failed');
  assert.equal(failedReceipt.notification.message, 'permission denied');
});

test('click navigates only after Runtime canonicalizes the conversation and run target', async () => {
  const accepted = setup({
    validateTarget: async () => ({
      valid: true,
      target: { conversationId: 'default', runId: 'run-canonical' },
    }),
  });
  await accepted.host.handle(event());
  accepted.created[0].emit('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accepted.focused(), 1);
  assert.deepEqual(accepted.navigated, [{ conversationId: 'default', runId: 'run-canonical' }]);

  const forged = setup({ validateTarget: async () => ({ valid: false, message: 'not owned' }) });
  await forged.host.handle(event({
    payload: {
      ...event().payload,
      runId: 'forged',
      command: 'open https://attacker.invalid',
    },
  }));
  forged.created[0].emit('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forged.focused(), 0);
  assert.deepEqual(forged.navigated, []);
});

test('App stop closes active notifications and prevents any later submission', async () => {
  const pendingNative = new FakeNotification('pending');
  const { host } = setup({ platform: { create: () => pendingNative } });
  const pending = host.handle(event());
  host.stop();
  const receipt = await pending;
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.notification.status, 'unavailable');
  assert.equal(pendingNative.closed, true);

  const after = await host.handle(event({ eventId: 'event-after', payload: { ...event().payload, requestId: 'request-after' } }));
  assert.equal(after.status, 'rejected');
  assert.equal(after.notification.status, 'unavailable');
});

test('bounds active native notifications and expires retained instances', async () => {
  const bounded = setup({ maximumActiveNotifications: 1, activeNotificationTtlMs: 1_000 });
  await bounded.host.handle(event());
  await bounded.host.handle(event({
    eventId: 'event-2',
    payload: { ...event().payload, requestId: 'request-2' },
  }));
  assert.equal(bounded.created.length, 2);
  assert.equal(bounded.created[0].closed, true);

  const expiring = setup({ activeNotificationTtlMs: 5 });
  await expiring.host.handle(event());
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(expiring.created[0].closed, true);
});
