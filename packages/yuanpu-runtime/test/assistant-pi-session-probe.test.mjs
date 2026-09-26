import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createModels, fauxAssistantMessage, fauxProvider } from '../../ai/dist/index.js';
import { AgentHarness, BACKGROUND_CONTEXT, JsonlSessionRepo, NodeExecutionEnv } from '../../agent/dist/node.js';
import { decodeServiceControlCall } from '../../chord/dist/index.js';
import { Client } from '../../client/dist/index.js';
import { createUnixTransportFactory } from '../../client/dist/unix.js';
import { createUnixServer, getUnixSocketPath } from '../../server/dist/transports/unix/index.js';
import { createYuanpuChatSession } from '../dist/index.mjs';

const serverId = '00000000-0000-4000-8000-000000000037';
const serviceId = 'yuanpu.assistant.session';

test('Pi Session/Harness serves desktop and WeCom presentations, subscriptions and reconnect',
  { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp('/tmp/yp-pi-');
  const context = BACKGROUND_CONTEXT;
  const repo = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: 'sessions' });
  const seeded = await repo.create({ id: 'assistant-chat', cwd: root }, context);
  const metadata = seeded.metadata;
  await seeded.close(context);
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage('Checked the artifact.'),
    fauxAssistantMessage('Recovered the second result.'),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const requests = new Map();
  const acceptedRequestPath = join(root, 'accepted-requests.json');
  const persistRequests = () => writeFile(acceptedRequestPath, JSON.stringify([...requests]));
  const observers = new Set();
  let sequence = 0;
  let openCount = 0;
  let acceptedLostResponse;
  let releaseLostResponse;
  const lostResponseAccepted = new Promise((resolve) => { acceptedLostResponse = resolve; });
  const lostResponseGate = new Promise((resolve) => { releaseLostResponse = resolve; });
  let server;
  const clients = [];
  const presentationCapabilities = new Set(['desktop-capability', 'wecom-capability']);

  const snapshot = () => ({
    serviceId, mode: 'singleton',
    instances: [{ members: [{ name: 'state', kind: 'state', sequence, ops: [['r', { requests: Object.fromEntries(requests) }]] }] }],
  });
  const publish = async (requestId, record) => {
    sequence += 1;
    await Promise.all([...observers].map(({ id, send }) => send(id, {
      type: 'state', member: 'state', sequence, ops: [['s', ['requests', requestId], record]],
    }, context)));
  };
  const host = {
    serverServices: {
      attachClient(presentation) {
        return {
          async invokeService(call, _publish, ctx) {
            if (call.serviceId !== 'yuanpu.assistant.management' || call.member !== 'attach' ||
                call.args.length !== 2 || typeof call.args[0] !== 'string' ||
                !presentationCapabilities.has(call.args[1])) throw new Error('Unauthorized assistant attachment');
            await presentation.attachSession(call.args[0], ctx);
            return null;
          },
          release() {},
        };
      },
    },
    async resolveSession(id) {
      if (id !== metadata.id) throw new Error('Unknown assistant session');
      return metadata;
    },
    async openSession(meta, ctx) {
      openCount += 1;
      const session = await repo.open(meta, ctx);
      const { harness } = await AgentHarness.create({
        session, models, model: faux.getModel(), activeToolNames: [],
      }, ctx);
      const lane = await harness.lane('main', ctx);
      return {
        attachClient() {
          const subscriptions = new Set();
          return {
            async invokeService(call, send) {
              const control = decodeServiceControlCall(call);
              if (control?.type === 'subscribe' && control.serviceId === serviceId) {
                const observer = { id: control.subscriptionId, send };
                observers.add(observer);
                subscriptions.add(observer);
                return snapshot();
              }
              if (control?.type === 'unsubscribe') {
                for (const observer of subscriptions) {
                  if (observer.id === control.subscriptionId) {
                    observers.delete(observer);
                    subscriptions.delete(observer);
                  }
                }
                return null;
              }
              if (call.serviceId !== serviceId || call.args.length !== 1) throw new Error('Unsupported session call');
              if (call.member === 'get') return requests.get(call.args[0]) ?? null;
              if (call.member !== 'submit') throw new Error('Unsupported session member');
              const { requestId, text } = call.args[0];
              const prior = requests.get(requestId);
              if (prior) return prior;
              const accepted = { requestId, status: 'accepted' };
              requests.set(requestId, accepted);
              await persistRequests();
              await publish(requestId, accepted);
              void lane.prompt(text, undefined, context).then(async (result) => {
                const completed = { requestId, status: result.ok ? result.value.status : 'failed' };
                requests.set(requestId, completed);
                await persistRequests();
                await publish(requestId, completed);
              });
              if (requestId === 'lost-response') {
                acceptedLostResponse();
                await lostResponseGate;
              }
              return accepted;
            },
            release() {
              for (const observer of subscriptions) observers.delete(observer);
            },
          };
        },
        async close(closeContext) { await harness.close(closeContext); await session.close(closeContext); },
      };
    },
  };

  try {
    const path = getUnixSocketPath(serverId, root);
    server = createUnixServer(host, { serverId, path, mode: 0o600 });
    await server.start();
    const connect = async (capability) => {
      const client = await Client.connect({ serverId, transportFactory: createUnixTransportFactory({ path }) });
      clients.push(client);
      await client.request({ serverId }, {
        serviceId: 'yuanpu.assistant.management', member: 'attach', args: [metadata.id, capability],
      });
      assert.equal(client.attachment?.sessionId, metadata.id);
      return client;
    };
    const desktop = await connect('desktop-capability');
    const wecom = await connect('wecom-capability');
    const outsider = await Client.connect({ serverId, transportFactory: createUnixTransportFactory({ path }) });
    clients.push(outsider);
    await assert.rejects(outsider.request({ serverId }, {
      serviceId: 'yuanpu.assistant.management', member: 'attach', args: [metadata.id, 'unpaired'],
    }));
    assert.equal(outsider.attachment, undefined);
    await assert.rejects(outsider.request(desktop.attachment, {
      serviceId, member: 'get', args: ['business-request-1'],
    }), { code: 'session_not_attached' });
    assert.equal(openCount, 1);
    const desktopUpdates = [];
    const wecomUpdates = [];
    const subscribe = async (client, updates) => {
      const subscription = await client.subscribeService(client.attachment, serviceId, 'singleton',
        (update) => updates.push(update));
      assert.deepEqual(subscription.snapshot.instances[0].members[0].ops[0], ['r', { requests: {} }]);
      subscription.start();
      return subscription;
    };
    await subscribe(desktop, desktopUpdates);
    await subscribe(wecom, wecomUpdates);
    const accepted = await wecom.request(wecom.attachment, {
      serviceId, member: 'submit', args: [{ requestId: 'business-request-1', text: 'Review this artifact' }],
    });
    assert.deepEqual(accepted, { requestId: 'business-request-1', status: 'accepted' });
    for (let attempt = 0; attempt < 100 && requests.get('business-request-1')?.status !== 'completed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(requests.get('business-request-1')?.status, 'completed');
    assert.equal(faux.state.callCount, 1);
    for (let attempt = 0; attempt < 100 && (desktopUpdates.length < 2 || wecomUpdates.length < 2); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(desktopUpdates.length, 2);
    assert.equal(wecomUpdates.length, 2);
    assert.equal(desktopUpdates[1].ops[0][2].status, 'completed');

    const oldTarget = wecom.attachment;
    const lostReply = wecom.request(oldTarget, {
      serviceId, member: 'submit', args: [{ requestId: 'lost-response', text: 'Review another artifact' }],
    });
    await lostResponseAccepted;
    wecom.disconnect();
    await assert.rejects(lostReply, { name: 'DisconnectedError' });
    releaseLostResponse();
    await wecom.reconnect();
    assert.equal(wecom.attachment, undefined);
    await wecom.request({ serverId }, {
      serviceId: 'yuanpu.assistant.management', member: 'attach', args: [metadata.id, 'wecom-capability'],
    });
    assert.notEqual(wecom.attachment.attachmentId, oldTarget.attachmentId);
    await assert.rejects(() => wecom.request(oldTarget, { serviceId, member: 'get', args: ['business-request-1'] }),
      { code: 'session_not_attached' });
    const restored = await wecom.subscribeService(wecom.attachment, serviceId, 'singleton', () => {});
    assert.equal(restored.snapshot.instances[0].members[0].ops[0][1].requests['business-request-1'].status, 'completed');
    restored.start();
    assert.deepEqual(await wecom.request(wecom.attachment, {
      serviceId, member: 'submit', args: [{ requestId: 'business-request-1', text: 'Review this artifact' }],
    }), requests.get('business-request-1'));
    for (let attempt = 0; attempt < 100 && requests.get('lost-response')?.status !== 'completed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(requests.get('lost-response')?.status, 'completed');
    assert.deepEqual(await wecom.request(wecom.attachment, {
      serviceId, member: 'submit', args: [{ requestId: 'lost-response', text: 'Review another artifact' }],
    }), requests.get('lost-response'));
    assert.equal(faux.state.callCount, 2);

    await Promise.all(clients.map((client) => client.dispose()));
    await server.close();
    server = undefined;
    requests.clear();
    for (const [requestId, record] of JSON.parse(await readFile(acceptedRequestPath, 'utf8'))) {
      requests.set(requestId, record);
    }
    server = createUnixServer(host, { serverId, path, mode: 0o600 });
    await server.start();
    const restarted = await connect('desktop-capability');
    assert.equal(openCount, 2);
    assert.equal((await restarted.request(restarted.attachment, {
      serviceId, member: 'get', args: ['lost-response'],
    })).status, 'completed');
    assert.deepEqual(await restarted.request(restarted.attachment, {
      serviceId, member: 'submit', args: [{ requestId: 'lost-response', text: 'Review another artifact' }],
    }), requests.get('lost-response'));
    assert.equal(faux.state.callCount, 2);
  } finally {
    releaseLostResponse();
    await Promise.all(clients.map((client) => client.dispose()));
    if (server) await server.close();
    await repo.close(context);
    await rm(root, { recursive: true, force: true });
  }
});

test('current Yuanpu chat adapter opens its legacy Pi session seam independently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yp-chat-'));
  try {
    await writeFile(join(root, 'models.json'), JSON.stringify({ providers: { 'probe-fixture': {
      baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 1024 }],
    } } }));
    const chat = await createYuanpuChatSession({
      capabilityClient: { async search() { return { matches: [] }; }, async execute() { throw new Error('unused'); } },
      agentDir: root, modelConfigDir: root, cwd: root,
      provider: 'probe-fixture', model: 'fixture', apiKey: 'fixture-only',
      piSession: { id: 'legacy-chat', directory: join(root, 'legacy-sessions') },
    });
    assert.equal(chat.sessionId, 'legacy-chat');
    chat.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
