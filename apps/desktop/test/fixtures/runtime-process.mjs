import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [mode = 'healthy', eventFile, counterFile] = process.argv.slice(2, 5);
let bootstrap = '';
for await (const chunk of process.stdin) {
  bootstrap += chunk.toString();
}
const credentials = JSON.parse(bootstrap);
const record = (event, extra = {}) => {
  if (eventFile) appendFileSync(eventFile, `${JSON.stringify({ event, pid: process.pid, ...extra })}\n`);
};

let startNumber = 1;
if (counterFile) {
  try { startNumber = Number.parseInt(readFileSync(counterFile, 'utf8'), 10) + 1; } catch {}
  writeFileSync(counterFile, String(startNumber));
}
record('start', { startNumber });

const server = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${credentials.token}`) {
    response.writeHead(401).end();
    return;
  }
  if (request.url === '/v1/health') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      version: '0.1.0',
      protocolVersion: mode === 'health-protocol-mismatch' ? 999 : 3,
      piVersion: 'fixture',
      mcpTools: [],
      configRoot: '/fixture',
    }));
    return;
  }
  response.writeHead(404).end();
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const protocolVersion = mode === 'ready-protocol-mismatch' ? 999 : 3;
  process.stdout.write(`${JSON.stringify({
    event: 'ready',
    host: '127.0.0.1',
    port: address.port,
    version: '0.1.0',
    protocolVersion,
    piVersion: 'fixture',
    mcpTools: [],
    configRoot: '/fixture',
  })}\n`);
  if ((mode === 'crash-once' && startNumber === 1) || mode === 'always-crash') {
    setTimeout(() => {
      record('crash', { startNumber });
      process.exit(23);
    }, 40);
  }
});

if (mode !== 'ignore-term') {
  process.once('SIGTERM', () => {
    record('term');
    server.close(() => process.exit(0));
  });
}
