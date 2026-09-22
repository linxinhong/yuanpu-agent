import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  readWecomConnectionDocument,
  startConfiguredWecomChannels,
} from '../src/wecom-channel.ts';

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
      groupAllowlist: [],
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

test('rejects plaintext credentials, non-Keychain references, and premature group enablement', async () => {
  for (const document of [
    enabledConnection({ secret: 'plaintext-forbidden' }),
    enabledConnection({ credentialRefs: { botSecret: 'env:FORBIDDEN' } }),
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
