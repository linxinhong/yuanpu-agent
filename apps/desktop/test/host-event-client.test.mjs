import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { AuthenticatedHostEventClient } from '../dist/host-event-client.cjs';

const hostEvent = {
  contractVersion: 1,
  eventId: 'event-reconnect',
  sequence: 1,
  occurredAt: '2026-09-22T00:00:00.000Z',
  type: 'notification_requested',
  payload: {
    requestId: 'request-reconnect',
    title: 'Reconnect',
    body: 'Deliver once',
    kind: 'reminder',
  },
};

test('uses authenticated SSE, reconnects after a lost receipt, and permits host deduplication', async (context) => {
  let streams = 0;
  let receipts = 0;
  const auth = [];
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const server = createServer((request, response) => {
    auth.push(request.headers.authorization);
    if (request.url === '/v1/host/events') {
      streams += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`id: ${hostEvent.eventId}\ndata: ${JSON.stringify(hostEvent)}\n\n`);
      return;
    }
    if (request.url === '/v1/host/events/receipts') {
      receipts += 1;
      request.resume();
      if (receipts === 1) {
        response.writeHead(503).end();
      } else {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"acknowledged":true}');
        finish();
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const handled = [];
  const client = new AuthenticatedHostEventClient(
    async () => ({ host: '127.0.0.1', port: address.port, token: 'secret-token' }),
    async (incoming) => {
      handled.push(incoming.eventId);
      return {
        eventId: incoming.eventId,
        status: handled.length === 1 ? 'accepted' : 'duplicate',
        notification: {
          requestId: incoming.payload.requestId,
          status: 'submitted',
          userVisibility: 'unknown',
        },
      };
    },
    { reconnectDelayMs: 5 },
  );
  client.start();
  await completed;
  await client.stop();

  assert.equal(streams, 2);
  assert.equal(receipts, 2);
  assert.deepEqual(handled, ['event-reconnect', 'event-reconnect']);
  assert.deepEqual(auth, Array(auth.length).fill('Bearer secret-token'));
});
