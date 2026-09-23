import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  configuredWecomDocument,
  listWecomConnectionSummaries,
  readWecomConnectionDocument,
  startConfiguredWecomChannels,
  writeWecomConnectionDocument,
} from '../src/wecom-channel.ts';

test('management updates preserve pairing and write only strict Keychain references', async () => {
  await withConfig(enabledConnection(), async (appPath) => {
    const original = await readWecomConnectionDocument(appPath);
    const disabled = configuredWecomDocument(original, { connectionId: 'imc_fixture', enabled: false });
    assert.equal(disabled.connections[0].providerAccountRef, 'bot-fixture');
    assert.deepEqual(disabled.connections[0].pairedSenderDigests, ['a'.repeat(64)]);
    assert.throws(() => configuredWecomDocument(original, {
      connectionId: 'imc_fixture', enabled: true, botId: 'different-bot',
    }), /cannot be changed/);
    const newConnection = configuredWecomDocument(disabled, {
      connectionId: 'new_fixture', enabled: false, botId: 'new-bot',
    });
    await writeWecomConnectionDocument(appPath, newConnection);
    const persisted = await readWecomConnectionDocument(appPath);
    assert.equal(persisted.connections.length, 2);
    assert.equal(persisted.connections[1].credentialRefs.botSecret, 'keychain:yuanpu/im/new_fixture/bot-secret');
    assert.equal(persisted.connections[1].groupEnabled, false);
    assert.equal((await stat(join(appPath, 'connections', 'wecom.json'))).mode & 0o777, 0o600);
    assert.throws(() => configuredWecomDocument(persisted, {
      connectionId: 'new_fixture', enabled: true, secret: 'fixture-plaintext',
    }), /Invalid Enterprise WeChat connection configuration/);
  });
});

test('connection summaries expose live readiness without account or credential values', async () => {
  await withConfig(enabledConnection(), async (appPath) => {
    const disconnected = await listWecomConnectionSummaries(appPath, [], 'credential_unavailable');
    assert.deepEqual(disconnected, {
      status: 'ok',
      connections: [{
        connectionId: 'imc_fixture',
        enabled: true,
        pairedSenderCount: 1,
        groupEnabled: false,
        status: 'unavailable',
        diagnostic: 'credential_unavailable',
      }],
    });
    assert.equal(JSON.stringify(disconnected).includes('bot-fixture'), false);
    assert.equal(JSON.stringify(disconnected).includes('bot-secret'), false);
    const connected = await listWecomConnectionSummaries(appPath, [
      { connectionId: 'imc_fixture', isReady: () => true },
    ]);
    assert.equal(connected.connections[0].status, 'connected');
    const failed = await listWecomConnectionSummaries(appPath, [
      { connectionId: 'imc_fixture', isReady: () => false, connectionIssue: () => 'authentication_failed' },
    ]);
    assert.equal(failed.connections[0].status, 'unavailable');
    assert.equal(failed.connections[0].diagnostic, 'authentication_failed');
  });
  await withConfig({ schemaVersion: 2, connections: [] }, async (appPath) => {
    assert.deepEqual(await listWecomConnectionSummaries(appPath, []), {
      status: 'invalid_configuration', connections: [],
    });
  });
});

async function withConfig(document, run) {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-wecom-config-'));
  try {
    await mkdir(join(root, 'connections'), { recursive: true });
    await writeFile(join(root, 'connections', 'wecom.json'), JSON.stringify(document), { mode: 0o600 });
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function store() {
  return {
    bindConnection() {},
    pair() {},
    markDeliveringUnknown() { return 0; },
    recoverableInbound() { return []; },
  };
}

function agent() {
  return {
    async submit() { throw new Error('not used'); },
    async get() { return undefined; },
    async cancel() { throw new Error('not used'); },
    async *subscribe() {},
  };
}

function enabledConnection(overrides = {}) {
  return {
    schemaVersion: 1,
    connections: [{
      enabled: true,
      provider: 'wecom',
      connectionId: 'imc_fixture',
      providerAccountRef: 'bot-fixture',
      credentialRefs: { botSecret: 'keychain:yuanpu/im/imc_fixture/bot-secret' },
      directMessagePolicy: 'paired-only',
      groupPolicy: 'allowlist-paired-sender-and-provider-at-mention',
      groupEnabled: false,
      pairedSenderDigests: ['a'.repeat(64)],
      groupAllowlistDigests: [],
      acceptedMessageTypes: ['text'],
      ...overrides,
    }],
  };
}

test('missing or disabled local config never resolves a credential or starts transport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-wecom-missing-'));
  try {
    assert.deepEqual(await readWecomConnectionDocument(root), { schemaVersion: 1, connections: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  await withConfig({
    schemaVersion: 1,
    connections: [{
      enabled: false,
      provider: 'wecom',
      connectionId: 'imc_disabled',
      credentialRefs: {},
      directMessagePolicy: 'paired-only',
      groupPolicy: 'allowlist-paired-sender-and-provider-at-mention',
      groupAllowlistDigests: [],
      acceptedMessageTypes: ['text'],
    }],
  }, async (appPath) => {
    let credentialCalls = 0;
    let transportCalls = 0;
    const routers = await startConfiguredWecomChannels({
      appPath,
      workspaceId: '/fixture-workspace',
      store: store(),
      agent: agent(),
      resolveCredential: async () => {
        credentialCalls += 1;
        return 'should-not-be-read';
      },
      createTransport: () => {
        transportCalls += 1;
        throw new Error('should not start');
      },
    });
    assert.deepEqual(routers, []);
    assert.equal(credentialCalls, 0);
    assert.equal(transportCalls, 0);
  });
});

test('enabled config resolves only the Keychain reference at runtime and closes its transport', async () => {
  await withConfig(enabledConnection(), async (appPath) => {
    const references = [];
    const created = [];
    const transport = {
      connect() { this.connected = true; },
      async ready() {},
      async reply() { return { status: 'accepted' }; },
      close() { this.closed = true; },
    };
    const routers = await startConfiguredWecomChannels({
      appPath,
      workspaceId: '/fixture-workspace',
      store: store(),
      agent: agent(),
      resolveCredential: async (reference) => {
        references.push(reference);
        return 'fixture-secret-from-keychain';
      },
      createTransport: (input) => {
        created.push({
          connectionId: input.connectionId,
          botId: input.botId,
          receivedSecret: input.secret === 'fixture-secret-from-keychain',
        });
        return transport;
      },
    });
    assert.deepEqual(references, ['keychain:yuanpu/im/imc_fixture/bot-secret']);
    assert.deepEqual(created, [{
      connectionId: 'imc_fixture',
      botId: 'bot-fixture',
      receivedSecret: true,
    }]);
    assert.equal(transport.connected, true);
    await routers[0].close();
    assert.equal(transport.closed, true);
  });
});

test('targeted startup leaves unrelated enabled connections untouched', async () => {
  const document = enabledConnection();
  document.connections.push({
    ...document.connections[0],
    connectionId: 'imc_other',
    providerAccountRef: 'other-bot-fixture',
    credentialRefs: { botSecret: 'keychain:yuanpu/im/imc_other/bot-secret' },
  });
  await withConfig(document, async (appPath) => {
    const started = [];
    const routers = await startConfiguredWecomChannels({
      appPath, workspaceId: '/fixture-workspace', store: store(), agent: agent(),
      connectionIds: ['imc_other'],
      resolveCredential: async () => 'fixture-secret',
      createTransport: ({ connectionId }) => {
        started.push(connectionId);
        return { connect() {}, ready: async () => {}, reply: async () => ({ status: 'accepted' }), close() {} };
      },
    });
    assert.deepEqual(started, ['imc_other']);
    assert.deepEqual(routers.map((router) => router.connectionId), ['imc_other']);
    await routers[0].close();
  });
});

test('rejects plaintext credentials, non-Keychain references, and premature group enablement', async () => {
  for (const document of [
    enabledConnection({ secret: 'plaintext-forbidden' }),
    enabledConnection({
      credentialRefs: {
        botSecret: 'keychain:yuanpu/im/imc_fixture/bot-secret',
        secret: 'nested-plaintext-forbidden',
      },
    }),
    enabledConnection({ credentialRefs: { botSecret: 'env:FORBIDDEN' } }),
    enabledConnection({ groupPolicy: 'allow-all' }),
    enabledConnection({
      connectionId: 'imc_other',
      credentialRefs: { botSecret: 'keychain:yuanpu/im/imc_fixture/bot-secret' },
    }),
    enabledConnection({ groupEnabled: true }),
  ]) {
    await withConfig(document, async (appPath) => {
      await assert.rejects(
        startConfiguredWecomChannels({
          appPath,
          workspaceId: '/fixture-workspace',
          store: store(),
          agent: agent(),
          resolveCredential: async () => 'fixture-secret',
          createTransport: () => { throw new Error('must not create transport'); },
        }),
        /Enterprise WeChat/,
      );
    });
  }
});

test('rejects duplicate connection ownership and closes an adapter whose start fails', async () => {
  const duplicate = enabledConnection();
  duplicate.connections.push({ ...duplicate.connections[0] });
  await withConfig(duplicate, async (appPath) => {
    await assert.rejects(
      startConfiguredWecomChannels({
        appPath,
        workspaceId: '/fixture-workspace',
        store: store(),
        agent: agent(),
      }),
      /invalid/i,
    );
  });

  const duplicateAccount = enabledConnection();
  duplicateAccount.connections.push({
    ...duplicateAccount.connections[0],
    connectionId: 'imc_fixture_second',
    credentialRefs: { botSecret: 'keychain:yuanpu/im/imc_fixture_second/bot-secret' },
  });
  await withConfig(duplicateAccount, async (appPath) => {
    await assert.rejects(
      startConfiguredWecomChannels({
        appPath,
        workspaceId: '/fixture-workspace',
        store: store(),
        agent: agent(),
      }),
      /invalid/i,
    );
  });

  await withConfig(enabledConnection(), async (appPath) => {
    let closed = false;
    await assert.rejects(
      startConfiguredWecomChannels({
        appPath,
        workspaceId: '/fixture-workspace',
        store: store(),
        agent: agent(),
        resolveCredential: async () => 'fixture-secret',
        createTransport: () => ({
          connect() { throw new Error('fixture connect failure'); },
          async ready() {},
          async reply() { return { status: 'accepted' }; },
          close() { closed = true; },
        }),
      }),
      /fixture connect failure/,
    );
    assert.equal(closed, true);
  });
});

test('a later connection failure closes an earlier started adapter', async () => {
  const document = enabledConnection();
  document.connections.push({
    ...document.connections[0],
    connectionId: 'imc_second',
    providerAccountRef: 'bot-second',
    credentialRefs: { botSecret: 'keychain:yuanpu/im/imc_second/bot-secret' },
  });
  await withConfig(document, async (appPath) => {
    let closed = false;
    await assert.rejects(startConfiguredWecomChannels({
      appPath,
      workspaceId: '/fixture-workspace',
      store: store(),
      agent: agent(),
      resolveCredential: async (reference) => {
        if (reference.includes('imc_second')) throw new Error('fixture credential unavailable');
        return 'fixture-secret';
      },
      createTransport: () => ({
        connect() {},
        async ready() {},
        async reply() { return { status: 'accepted' }; },
        close() { closed = true; },
      }),
    }), /fixture credential unavailable/);
    assert.equal(closed, true);
  });
});
