import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createCatalogServer } from '../dist/index.mjs';

test('catalog server searches skills and returns item details', async (context) => {
  const server = createCatalogServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;

  const search = await fetch(`${origin}/v1/catalog/search?q=%E5%A4%96%E9%83%A8%20MCP`).then((response) => response.json());
  assert.equal(search.schemaVersion, 1);
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].displayName, 'MCP 服务连接');

  const detail = await fetch(`${origin}/v1/catalog/items/${search.items[0].id}`).then((response) => response.json());
  assert.deepEqual(detail.components, ['connector', 'extension']);
});

test('catalog server exposes controlled signed metadata and immutable artifacts', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-catalog-artifact-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const body = Buffer.from('signed-fixture');
  await writeFile(join(root, 'manifest.json'), JSON.stringify({
    id: 'builtin.python.echo',
    version: '9.8.7',
    artifacts: [
      { url: 'artifacts/YuanpuEchoMcp-linux-x64.tar.gz' },
      { url: 'artifacts/private.pem' },
    ],
    signature: { value: 'fixture' },
  }));
  await writeFile(join(root, 'YuanpuEchoMcp-linux-x64.tar.gz'), body);
  await writeFile(join(root, 'private.pem'), 'must-not-leak');
  const server = createCatalogServer(undefined, { artifactRoot: root });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;

  const search = await fetch(`${origin}/v1/catalog/search?q=Python`).then((response) => response.json());
  assert.equal(search.items[0].version, '9.8.7');

  const manifest = await fetch(`${origin}/v1/capability-packages/builtin.python.echo/manifest`).then((response) => response.json());
  assert.equal(manifest.signature.value, 'fixture');
  const artifact = await fetch(`${origin}/v1/capability-packages/builtin.python.echo/artifacts/YuanpuEchoMcp-linux-x64.tar.gz`);
  assert.equal(artifact.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.deepEqual(Buffer.from(await artifact.arrayBuffer()), body);
  assert.equal((await fetch(`${origin}/v1/capability-packages/builtin.python.echo/artifacts/..%2Fsecret`)).status, 400);
  assert.equal((await fetch(`${origin}/v1/capability-packages/builtin.python.echo/artifacts/private.pem`)).status, 404);
  assert.equal((await fetch(`${origin}/v1/capability-packages/%/manifest`)).status, 400);

  const linkName = 'YuanpuEchoMcp-darwin-arm64.tar.gz';
  await symlink(join(root, 'private.pem'), join(root, linkName));
  const currentManifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  currentManifest.artifacts.push({ url: `artifacts/${linkName}` });
  await writeFile(join(root, 'manifest.json'), JSON.stringify(currentManifest));
  assert.equal(
    (await fetch(`${origin}/v1/capability-packages/builtin.python.echo/artifacts/${linkName}`)).status,
    404,
  );
});
