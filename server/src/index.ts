import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';

import type { SkillCatalogItem } from '@yuanpu-agent/protocol';

import { catalog } from './catalog.js';

function writeJson(response: import('node:http').ServerResponse, status: number, value: unknown) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('access-control-allow-origin', '*');
  response.end(JSON.stringify(value));
}

export function createCatalogServer(items: SkillCatalogItem[] = catalog): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/v1/health') {
      writeJson(response, 200, { status: 'ok', schemaVersion: 1, items: items.length });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/catalog/search') {
      const query = (url.searchParams.get('q') ?? '').trim().toLocaleLowerCase();
      const matches = items.filter((item) => !query || [
        item.id,
        item.name,
        item.displayName,
        item.description,
        item.publisher,
        ...(item.components ?? []),
      ].some((value) => value?.toLocaleLowerCase().includes(query)));
      writeJson(response, 200, { schemaVersion: 1, items: matches });
      return;
    }
    const match = request.method === 'GET' && url.pathname.match(/^\/v1\/catalog\/items\/([^/]+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]!);
      const item = items.find((candidate) => candidate.id === id);
      writeJson(response, item ? 200 : 404, item ?? { error: 'Skill not found' });
      return;
    }
    writeJson(response, 404, { error: 'Not found' });
  });
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8787;
  const server = createCatalogServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`YuanpuAgent catalog server listening on http://127.0.0.1:${port}`);
  });
}
