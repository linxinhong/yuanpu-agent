import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WecomSdkTransport,
  createWecomRedactingLogger,
} from '../dist/index.mjs';

class FixtureClient {
  handlers = new Map();
  connected = false;
  disconnected = false;
  replies = [];
  sends = [];
  result = { errcode: 0 };

  on(event, handler) {
    this.handlers.set(event, handler);
    return this;
  }

  connect() {
    this.connected = true;
    return this;
  }

  disconnect() {
    this.disconnected = true;
    this.connected = false;
  }

  get isConnected() {
    return this.connected;
  }

  async replyStream(frame, streamId, content, finish) {
    this.replies.push({ frame, streamId, content, finish });
    if (this.result instanceof Error || (this.result && this.result.throw)) throw this.result.throw;
    return this.result;
  }

  async sendMessage(recipientId, body) {
    this.sends.push({ recipientId, body });
    if (this.result instanceof Error || (this.result && this.result.throw)) throw this.result.throw;
    return this.result;
  }

  emit(event, value) {
    this.handlers.get(event)?.(value);
  }
}

test('redacting logger never forwards SDK message text or variadic payloads at any level', () => {
  const records = [];
  const logger = createWecomRedactingLogger((record) => records.push(record));
  const forbidden = 'fixture-secret-body-and-identifiers';
  for (const level of ['debug', 'info', 'warn', 'error']) {
    logger[level](`unknown frame ${forbidden}`, { raw: forbidden }, new Error(forbidden));
  }
  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes(forbidden), false);
  assert.deepEqual(records.map((record) => record.level), ['debug', 'info', 'warn', 'error']);
  assert.equal(records.every((record) => record.event === 'wecom.frame'), true);
});

test('normalizes only required fields and keeps raw frame out of the transport log', async () => {
  const client = new FixtureClient();
  const logs = [];
  const received = [];
  const transport = new WecomSdkTransport({
    connectionId: 'imc_fixture',
    botId: 'bot-fixture',
    secret: 'secret-fixture',
    log: (record) => logs.push(record),
    clientFactory: ({ logger }) => {
      logger.warn('Received unknown frame:', { unsafe: 'fixture-private-content' });
      return client;
    },
  });
  transport.connect((message) => received.push(message));
  client.emit('message', {
    headers: { req_id: 'request-fixture' },
    body: {
      msgid: 'message-fixture',
      aibotid: 'bot-fixture',
      chattype: 'single',
      from: { userid: 'member-fixture' },
      msgtype: 'text',
      text: { content: 'fixture-private-content' },
      response_url: 'https://forbidden.invalid/token',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [{
    provider: 'wecom',
    connectionId: 'imc_fixture',
    providerBotId: 'bot-fixture',
    providerRequestId: 'request-fixture',
    providerMessageId: 'message-fixture',
    senderId: 'member-fixture',
    conversationType: 'single',
    conversationId: 'member-fixture',
    messageType: 'text',
    text: 'fixture-private-content',
  }]);
  assert.equal(JSON.stringify(logs).includes('fixture-private-content'), false);
  assert.equal(JSON.stringify(logs).includes('forbidden.invalid'), false);
  transport.close();
  assert.equal(client.disconnected, true);
});

test('uses the original request id and distinguishes accepted, failed, and unknown delivery', async () => {
  const client = new FixtureClient();
  const transport = new WecomSdkTransport({
    connectionId: 'imc_fixture',
    botId: 'bot-fixture',
    secret: 'secret-fixture',
    clientFactory: () => client,
  });
  transport.connect(() => undefined);
  const route = { providerRequestId: 'request-fixture', providerMessageId: 'message-digest' };
  assert.deepEqual(await transport.reply(route, 'outbound-fixture', 'fixture reply'), {
    status: 'accepted',
  });
  assert.equal(client.replies[0].frame.headers.req_id, 'request-fixture');
  assert.equal(client.replies[0].finish, true);

  client.result = { throw: { errcode: 40001 } };
  assert.deepEqual(await transport.reply(route, 'outbound-fixture-2', 'fixture reply'), {
    status: 'failed',
    code: 'provider_40001',
  });
  client.result = { throw: new Error('ack timeout after frame write') };
  assert.deepEqual(await transport.reply(route, 'outbound-fixture-3', 'fixture reply'), {
    status: 'unknown',
    code: 'transport_uncertain',
  });
  client.result = {};
  assert.deepEqual(await transport.reply(route, 'outbound-fixture-4', 'fixture reply'), {
    status: 'unknown',
    code: 'malformed_receipt',
  });
  transport.close();
});

test('tracks an asynchronous inbound failure and reports only a redacted event before close', async () => {
  const client = new FixtureClient();
  const logs = [];
  const transport = new WecomSdkTransport({
    connectionId: 'imc_fixture',
    botId: 'bot-fixture',
    secret: 'secret-fixture',
    log: (record) => logs.push(record),
    clientFactory: () => client,
  });
  transport.connect(async () => {
    throw new Error('fixture-sensitive-inbound-failure');
  });
  client.emit('message', {
    headers: { req_id: 'request-fixture' },
    body: {
      msgid: 'message-fixture',
      aibotid: 'bot-fixture',
      chattype: 'single',
      from: { userid: 'member-fixture' },
      msgtype: 'text',
      text: { content: 'fixture-private-content' },
    },
  });
  await transport.close();
  assert.equal(logs.some((record) => record.event === 'wecom.inbound_failed'), true);
  assert.equal(JSON.stringify(logs).includes('fixture-sensitive-inbound-failure'), false);
  assert.equal(JSON.stringify(logs).includes('fixture-private-content'), false);
});

test('proactive private delivery uses userid and distinguishes provider rejection from uncertain ack', async () => {
  const client = new FixtureClient();
  const transport = new WecomSdkTransport({
    connectionId: 'imc_fixture', botId: 'bot-fixture', secret: 'secret-fixture',
    clientFactory: () => client,
  });
  transport.connect(() => undefined);
  assert.deepEqual(await transport.sendProactive('member-fixture', 'scheduled output'), {
    status: 'deferred',
  });
  client.emit('authenticated');
  assert.deepEqual(await transport.sendProactive('member-fixture', 'scheduled output'), {
    status: 'accepted',
  });
  assert.deepEqual(client.sends[0], {
    recipientId: 'member-fixture',
    body: { msgtype: 'markdown', markdown: { content: 'scheduled output' } },
  });
  client.result = { errcode: 93006 };
  assert.deepEqual(await transport.sendProactive('member-fixture', 'scheduled output'), {
    status: 'failed', code: 'provider_93006',
  });
  client.result = { throw: new Error('ack timeout after frame write') };
  assert.deepEqual(await transport.sendProactive('member-fixture', 'scheduled output'), {
    status: 'unknown', code: 'transport_uncertain',
  });
  client.emit('disconnected');
  assert.deepEqual(await transport.sendProactive('member-fixture', 'scheduled output'), {
    status: 'deferred',
  });
  await transport.close();
  assert.deepEqual(await transport.sendProactive('member-fixture', 'scheduled output'), {
    status: 'failed', code: 'transport_closed',
  });
});

test('reports authentication failure without exposing SDK error contents and clears it on success', async () => {
  const client = new FixtureClient();
  const logs = [];
  const transport = new WecomSdkTransport({
    connectionId: 'imc_fixture', botId: 'bot-fixture', secret: 'secret-fixture',
    log: (record) => logs.push(record), clientFactory: () => client,
  });
  transport.connect(() => undefined);
  client.emit('error', new Error('Authentication failed: fixture-sensitive-detail'));
  assert.equal(transport.connectionIssue(), 'authentication_failed');
  assert.equal(JSON.stringify(logs).includes('fixture-sensitive-detail'), false);
  client.emit('authenticated');
  assert.equal(transport.connectionIssue(), undefined);
  await transport.close();
});
