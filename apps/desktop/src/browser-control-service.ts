import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { BrowserControlCommand } from '@yuanpu-agent/protocol';

import type { BrowserGuestManager } from './browser-guest-manager.js';

const MAX_BODY_BYTES = 1024 * 1024;

export interface BrowserControlService {
  port: number;
  close(): Promise<void>;
}

/**
 * Loopback-only control service. The runtime sidecar (which holds the same
 * bearer token delivered through its bootstrap) calls POST /browser/execute
 * to drive the shared embedded browser sessions managed in this process.
 */
export function startBrowserControlService(options: {
  manager: BrowserGuestManager;
  token: string;
}): Promise<BrowserControlService> {
  const { manager, token } = options;
  const server: Server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    const remote = request.socket.remoteAddress?.replace(/^::ffff:/, '');
    if (remote !== '127.0.0.1' && remote !== '::1') {
      response.statusCode = 403;
      response.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/browser/execute') {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    if (request.headers.origin) {
      response.statusCode = 403;
      response.end(JSON.stringify({ error: 'Browser-origin requests are not accepted.' }));
      return;
    }
    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        tooLarge = true;
        response.statusCode = 413;
        response.end(JSON.stringify({ error: 'Browser control request is too large.' }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) return;
      let command: BrowserControlCommand;
      try {
        command = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BrowserControlCommand;
      } catch {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: 'Invalid JSON body.' }));
        return;
      }
      if (!command || typeof command !== 'object' || typeof command.method !== 'string' || typeof command.conversationId !== 'string') {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: 'A browser control command requires method and conversationId.' }));
        return;
      }
      void manager.execute(command).then((result) => {
        response.end(JSON.stringify(result));
      }, (error: unknown) => {
        response.end(JSON.stringify({
          ok: false,
          method: command.method,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () => new Promise((resolveClose, rejectClose) => {
          server.close((error) => (error ? rejectClose(error) : resolveClose()));
        }),
      });
    });
  });
}
