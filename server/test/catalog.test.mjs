import assert from 'node:assert/strict';
import test from 'node:test';

import { createCatalogServer } from '../dist/index.mjs';

test('catalog server searches skills and returns item details', async (context) => {
  const server = createCatalogServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;

  const search = await fetch(`${origin}/v1/catalog/search?q=MCP`).then((response) => response.json());
  assert.equal(search.schemaVersion, 1);
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].displayName, 'MCP 服务连接');

  const detail = await fetch(`${origin}/v1/catalog/items/${search.items[0].id}`).then((response) => response.json());
  assert.deepEqual(detail.components, ['connector', 'extension']);
});
