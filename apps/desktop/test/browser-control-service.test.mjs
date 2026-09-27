import assert from 'node:assert/strict';
import test from 'node:test';

import { startBrowserControlService } from '../dist/browser-control-service.cjs';

test('browser control service accepts only authenticated loopback runtime requests', async (t) => {
  const received = [];
  const service = await startBrowserControlService({
    token: 'test-secret',
    manager: {
      execute: async (command) => {
        received.push(command);
        return { ok: true, method: command.method };
      },
    },
  });
  t.after(() => service.close());
  const url = `http://127.0.0.1:${service.port}/browser/execute`;
  const body = JSON.stringify({ method: 'snapshot', conversationId: 'work:one' });

  const unauthorized = await fetch(url, { method: 'POST', body });
  assert.equal(unauthorized.status, 401);

  const browserOrigin = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer test-secret', origin: 'https://example.com' },
    body,
  });
  assert.equal(browserOrigin.status, 403);

  const invalid = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer test-secret' },
    body: JSON.stringify({ method: 'snapshot' }),
  });
  assert.equal(invalid.status, 400);

  const oversized = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer test-secret' },
    body: JSON.stringify({ method: 'type', conversationId: 'work:one', text: 'x'.repeat(1_048_576) }),
  });
  assert.equal(oversized.status, 413);

  const accepted = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer test-secret' },
    body,
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { ok: true, method: 'snapshot' });
  assert.deepEqual(received, [{ method: 'snapshot', conversationId: 'work:one' }]);
});
