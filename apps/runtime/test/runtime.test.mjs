import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { capabilityApprovalSigningPayload } from '@yuanpu-agent/protocol';

test('runtime CLI prints the default greeting from the Yuanpu runtime kit', () => {
  const output = execFileSync(process.execPath, ['dist/index.cjs'], { encoding: 'utf8' });
  assert.equal(output.trim(), 'Hello, world!');
});

test('runtime CLI accepts a name', () => {
  const output = execFileSync(process.execPath, ['dist/index.cjs', '--name', 'CI'], {
    encoding: 'utf8',
  });
  assert.equal(output.trim(), 'Hello, CI!');
});

test('runtime server exposes its protocol and greeting', async (context) => {
  const home = await mkdtemp(join(tmpdir(), 'yuanpu-runtime-test-'));
  const pluginsRoot = join(home, 'plugins');
  const installPath = join(pluginsRoot, 'installed', 'fixture', 'node_modules', 'pi-mcp-adapter');
  await mkdir(installPath, { recursive: true });
  await writeFile(join(installPath, 'package.json'), JSON.stringify({
    name: 'pi-mcp-adapter',
    version: '1.0.0',
    pi: { extensions: ['./index.ts'] },
  }));
  await writeFile(
    join(installPath, 'index.ts'),
    'export default function (pi) { pi.registerCommand("fixture", { description: "fixture", handler: () => {} }); }\n',
  );
  await writeFile(join(pluginsRoot, 'state.json'), JSON.stringify({
    schemaVersion: 1,
    plugins: {
      'pi-mcp-adapter': {
        name: 'pi-mcp-adapter',
        version: '1.0.0',
        description: 'Runtime bundle fixture',
        source: 'npm:pi-mcp-adapter@1.0.0',
        installPath,
        enabled: false,
        installedAt: '2026-09-21T00:00:00.000Z',
      },
    },
  }));
  const localSkillRoot = join(home, 'skills', 'runtime-fixture');
  await mkdir(localSkillRoot, { recursive: true });
  await writeFile(join(localSkillRoot, 'SKILL.md'), [
    '---',
    'name: runtime-fixture',
    'description: Runtime skill fixture.',
    '---',
  ].join('\n'));
  const token = randomBytes(32).toString('hex');
  const approvalKeyPair = generateKeyPairSync('ed25519');
  const approvalPublicKey = approvalKeyPair.publicKey.export({ type: 'spki', format: 'der' })
    .toString('base64');
  const capabilityResourceRoot = join(home, 'capability-resource');
  const capabilityTrustRoot = join(capabilityResourceRoot, 'trust-root.json');
  await mkdir(capabilityResourceRoot, { recursive: true });
  await writeFile(capabilityTrustRoot, JSON.stringify({
    keyId: 'runtime-test',
    publicKeyPem: approvalKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }));
  await writeFile(join(capabilityResourceRoot, 'manifest.json'), JSON.stringify({ version: '0.1.0' }));
  const child = spawn(process.execPath, [
    'dist/index.cjs', '--serve', '--port', '0',
  ], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env,
      YUANPU_HOME: home,
      YUANPU_CAPABILITY_TRUST_ROOT_FILE: capabilityTrustRoot,
      YUANPU_PYTHON_MCP_EXECUTABLE: '',
      YUANPU_PYTHON_MCP_ROOT: '',
    },
  });
  child.stdin.end(`${JSON.stringify({ token, approvalPublicKey })}\n`);
  context.after(async () => {
    child.kill();
    await rm(home, { recursive: true, force: true });
  });

  const ready = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('runtime server did not start')), 5_000);
    child.once('error', reject);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      resolve(JSON.parse(output.slice(0, newline)));
    });
  });

  const headers = { authorization: `Bearer ${token}` };
  const unauthorized = await fetch(`http://${ready.host}:${ready.port}/v1/health`);
  const badToken = await fetch(`http://${ready.host}:${ready.port}/v1/health`, {
    headers: { authorization: 'Bearer invalid-stage-verification-token' },
  });
  const health = await fetch(`http://${ready.host}:${ready.port}/v1/health`, { headers }).then((response) =>
    response.json(),
  );
  const greeting = await fetch(
    `http://${ready.host}:${ready.port}/v1/greeting?name=Integration`,
    { headers },
  ).then((response) => response.json());
  const plugins = await fetch(`http://${ready.host}:${ready.port}/v1/plugins`, { headers })
    .then((response) => response.json());
  const localSkills = await fetch(`http://${ready.host}:${ready.port}/v1/skills/local`, { headers })
    .then((response) => response.json());
  const unauthorizedApprovals = await fetch(
    `http://${ready.host}:${ready.port}/v1/capabilities/approvals`,
  );
  const approvals = await fetch(
    `http://${ready.host}:${ready.port}/v1/capabilities/approvals`,
    { headers },
  ).then((response) => response.json());
  const invalidApprovalDecision = await fetch(
    `http://${ready.host}:${ready.port}/v1/capabilities/approvals/decision`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: '', decision: 'approved' }),
    },
  );
  const forgedApprovalDecision = await fetch(
    `http://${ready.host}:${ready.port}/v1/capabilities/approvals/decision`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: 'unknown',
        decision: 'approved',
        issuedAt: Date.now(),
        nonce: randomBytes(16).toString('base64url'),
        signature: randomBytes(64).toString('base64url'),
      }),
    },
  );
  const signedUnknown = {
    requestId: 'unknown',
    decision: 'approved',
    issuedAt: Date.now(),
    nonce: randomBytes(16).toString('base64url'),
  };
  const signedUnknownBody = JSON.stringify({
    ...signedUnknown,
    signature: sign(
      null,
      capabilityApprovalSigningPayload(signedUnknown),
      approvalKeyPair.privateKey,
    ).toString('base64url'),
  });
  const signedUnknownDecision = await fetch(
    `http://${ready.host}:${ready.port}/v1/capabilities/approvals/decision`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: signedUnknownBody,
    },
  );
  const replayedSignedDecision = await fetch(
    `http://${ready.host}:${ready.port}/v1/capabilities/approvals/decision`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: signedUnknownBody,
    },
  );
  const invalidPluginInstall = await fetch(`http://${ready.host}:${ready.port}/v1/plugins/install`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ source: '' }),
  });
  const floatingPluginInstall = await fetch(`http://${ready.host}:${ready.port}/v1/plugins/install`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'npm:pi-example@latest' }),
  });
  const floatingPluginError = await floatingPluginInstall.json();
  const oversizedManifest = createServer((_request, response) => {
    const body = JSON.stringify({ padding: 'x'.repeat(300 * 1024) });
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    oversizedManifest.once('error', reject);
    oversizedManifest.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => oversizedManifest.close());
  const manifestAddress = oversizedManifest.address();
  assert.notEqual(manifestAddress, null);
  assert.equal(typeof manifestAddress, 'object');
  const artifactInstall = await fetch(`http://${ready.host}:${ready.port}/v1/plugins/install`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      source: `artifact:http://127.0.0.1:${manifestAddress.port}/manifest.json`,
    }),
  });
  const artifactInstallError = await artifactInstall.json();
  const enablePlugin = await fetch(`http://${ready.host}:${ready.port}/v1/plugins/state`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'pi-mcp-adapter', enabled: true }),
  });
  const pluginConfig = await fetch(
    `http://${ready.host}:${ready.port}/v1/plugins/config?name=pi-mcp-adapter&scope=user`,
    { headers },
  ).then((response) => response.json());
  const savePluginConfig = await fetch(`http://${ready.host}:${ready.port}/v1/plugins/config/save`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'pi-mcp-adapter',
      scope: 'user',
      value: { mcpServers: { docs: { url: 'https://example.test/mcp' } } },
    }),
  });
  const invalidChat = await fetch(`http://${ready.host}:${ready.port}/v1/chat`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ message: '' }),
  });
  const unconfiguredChat = await fetch(`http://${ready.host}:${ready.port}/v1/chat`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Hello' }),
  });
  const unconfiguredError = await unconfiguredChat.json();

  assert.equal(unauthorized.status, 401);
  assert.equal(badToken.status, 401);
  assert.equal(unauthorizedApprovals.status, 401);
  assert.deepEqual(approvals, []);
  assert.equal(invalidApprovalDecision.status, 400);
  assert.equal(forgedApprovalDecision.status, 403);
  assert.equal(signedUnknownDecision.status, 409);
  assert.equal(replayedSignedDecision.status, 403);
  assert.equal(child.spawnargs.includes(token), false);
  assert.equal(invalidChat.status, 400);
  assert.equal(invalidPluginInstall.status, 400);
  assert.equal(floatingPluginInstall.status, 500);
  assert.match(floatingPluginError.error, /精确版本/);
  assert.equal(artifactInstall.status, 500);
  assert.match(artifactInstallError.error, /超过 262144 字节限制/);
  assert.equal('hint' in floatingPluginError, false);
  assert.equal(enablePlugin.status, 200);
  assert.equal(pluginConfig.kind, 'mcp');
  assert.equal(pluginConfig.path, join(home, 'agent', 'mcp.json'));
  assert.equal(savePluginConfig.status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'agent', 'mcp.json'), 'utf8')), {
    mcpServers: { docs: { url: 'https://example.test/mcp' } },
  });
  assert.equal(unconfiguredChat.status, 500);
  assert.match(unconfiguredError.hint, /config\.json/);
  assert.deepEqual(health, {
    version: '0.1.0',
    protocolVersion: 3,
    piVersion: '0.86.1',
    mcpTools: ['search_capabilities', 'execute_capability'],
    configRoot: home,
  });
  assert.deepEqual(greeting, { message: 'Hello, Integration!' });
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].name, 'pi-mcp-adapter');
  assert.equal(localSkills.diagnostics.length, 0);
  assert.equal(localSkills.skills.length, 1);
  assert.equal(localSkills.skills[0].name, 'runtime-fixture');
});
