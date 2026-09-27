import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BrowserControlClient, createBuiltinBrowserSource } from '../dist/index.mjs';

function fakeServer(handler) {
  const received = [];
  const server = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer control-token') {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const command = JSON.parse(body);
      received.push(command);
      const outcome = handler(command);
      response.setHeader('content-type', 'application/json');
      if ('status' in outcome) {
        response.statusCode = outcome.status;
        response.end(JSON.stringify(outcome.body));
        return;
      }
      response.end(JSON.stringify(outcome));
    });
  });
  return {
    received,
    listen: () => new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const context = { conversationId: 'work:demo', sessionId: 'session-1' };

test('browser capability source exposes definitions with the expected risk levels', async () => {
  const source = createBuiltinBrowserSource({ execute: async () => ({ ok: true, method: 'snapshot' }) });
  assert.equal(source.sourceInstanceId, 'builtin.host.browser');
  const definitions = await source.list();
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  assert.equal(byName.get('browser_navigate').riskLevel, 'R1');
  assert.equal(byName.get('browser_click').riskLevel, 'R2');
  assert.equal(byName.get('browser_evaluate').riskLevel, 'R3');
  assert.equal((await source.resolve('browser_navigate')).type, 'browser');
  assert.equal(await source.resolve('browser_missing'), undefined);
});

test('browser capability validates arguments and builds commands per method', async () => {
  const seen = [];
  const source = createBuiltinBrowserSource({ execute: async (command, executionContext) => {
    seen.push({ command, context: executionContext });
    return { ok: true, method: command.method, url: 'https://example.com/', title: 'Example' };
  } });

  const ok = await source.execute({
    capabilityId: 'ypcap.browser_navigate',
    originalName: 'browser_navigate',
    arguments: { url: 'https://example.com/' },
  }, context);
  assert.equal(ok.isError, undefined);
  assert.match(ok.content[0].text, /Example/);

  await assert.rejects(source.execute({
    capabilityId: 'ypcap.browser_navigate',
    originalName: 'browser_navigate',
    arguments: { url: 'file:///etc/passwd' },
  }, context), /http\(s\) URL/);

  await assert.rejects(source.execute({
    capabilityId: 'ypcap.browser_click',
    originalName: 'browser_click',
    arguments: { x: -1, y: 10 },
  }, context), /非负数字/);

  await assert.rejects(source.execute({
    capabilityId: 'ypcap.browser_evaluate',
    originalName: 'browser_evaluate',
    arguments: {},
  }, context), /expression/);

  await assert.rejects(source.execute({
    capabilityId: 'ypcap.browser_navigate',
    originalName: 'browser_navigate',
    arguments: { url: 'https://example.com/' },
  }, { conversationId: undefined }), /Work 会话/);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].command.method, 'navigate');
  assert.equal(seen[0].command.conversationId, 'work:demo');
});

test('browser control client posts bearer-authenticated commands and maps http errors', async (t) => {
  const server = fakeServer((command) => command.method === 'navigate'
    ? { ok: true, method: 'navigate', url: command.url, title: 'Example' }
    : { status: 400, body: { error: 'Invalid command.' } });
  const port = await server.listen();
  t.after(() => server.close());
  const client = new BrowserControlClient({ port, token: 'control-token' });

  const ok = await client.execute({ method: 'navigate', conversationId: 'work:demo', url: 'https://example.com/' });
  assert.equal(ok.ok, true);
  assert.equal(ok.title, 'Example');

  const bad = await client.execute({ method: 'click', conversationId: 'work:demo', x: 1, y: 2 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Invalid command/);

  const unauthenticated = await fetch(`http://127.0.0.1:${port}/browser/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'snapshot', conversationId: 'work:demo' }),
  });
  assert.equal(unauthenticated.status, 401);
});
