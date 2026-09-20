import { greeting } from '@yuanpu-agent/core';
import { PROTOCOL_VERSION, RUNTIME_ROUTES } from '@yuanpu-agent/protocol';
import { createServer } from 'node:http';

declare const __APP_VERSION__: string;

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(__APP_VERSION__);
} else if (args.includes('--serve')) {
  const portIndex = args.indexOf('--port');
  const requestedPort = portIndex >= 0 ? Number(args[portIndex + 1]) : 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.setHeader('content-type', 'application/json; charset=utf-8');

    if (url.pathname === RUNTIME_ROUTES.health) {
      response.end(
        JSON.stringify({ version: __APP_VERSION__, protocolVersion: PROTOCOL_VERSION }),
      );
      return;
    }

    if (url.pathname === RUNTIME_ROUTES.greeting) {
      response.end(JSON.stringify({ message: greeting(url.searchParams.get('name') || 'world') }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(requestedPort, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Runtime did not bind a TCP port');
    console.log(
      JSON.stringify({
        event: 'ready',
        host: '127.0.0.1',
        port: address.port,
        version: __APP_VERSION__,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} else {
  const nameIndex = args.indexOf('--name');
  const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
  console.log(greeting(name || 'world'));
}
