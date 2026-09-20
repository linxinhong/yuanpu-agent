import { ensureYuanpuHome, greeting } from '@yuanpu-agent/core';
import { createDemoCapabilitySource, createYuanpuMcpServer } from '@yuanpu-agent/mcp';
import {
  createYuanpuCapabilityTools,
  createYuanpuChatSession,
  PI_UPSTREAM_VERSION,
  type YuanpuChatSession,
} from '@yuanpu-agent/pi-runtime';
import { PROTOCOL_VERSION, RUNTIME_ROUTES } from '@yuanpu-agent/protocol';
import { createServer, type IncomingMessage } from 'node:http';

declare const __APP_VERSION__: string;

const args = process.argv.slice(2);

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024) throw new Error('Request body is too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function serve(): Promise<void> {
  const portIndex = args.indexOf('--port');
  const requestedPort = portIndex >= 0 ? Number(args[portIndex + 1]) : 0;
  const tokenIndex = args.indexOf('--token');
  const token = tokenIndex >= 0 ? args[tokenIndex + 1] : undefined;
  if (!token) throw new Error('Runtime server requires --token');

  const home = await ensureYuanpuHome(process.env.YUANPU_HOME);
  const mcp = createYuanpuMcpServer([createDemoCapabilitySource()]);
  const piCapabilityTools = createYuanpuCapabilityTools(mcp);
  let chatPromise: Promise<YuanpuChatSession> | undefined;
  const getChat = () => {
    chatPromise ??= createYuanpuChatSession({
      capabilityClient: mcp,
      agentDir: home.root,
      cwd: home.config.workingDirectory,
      provider: home.config.provider,
      model: home.config.model,
      apiKey: process.env[home.config.apiKeyEnv],
      apiKeyEnv: home.config.apiKeyEnv,
      baseUrl: home.config.baseUrl,
      api: home.config.api,
    });
    return chatPromise;
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.setHeader('content-type', 'application/json; charset=utf-8');

    if (request.headers.authorization !== `Bearer ${token}`) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    try {
      if (url.pathname === RUNTIME_ROUTES.health && request.method === 'GET') {
        response.end(
          JSON.stringify({
            version: __APP_VERSION__,
            protocolVersion: PROTOCOL_VERSION,
            piVersion: PI_UPSTREAM_VERSION,
            mcpTools: piCapabilityTools.map((tool) => tool.name),
            configRoot: home.root,
          }),
        );
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.greeting && request.method === 'GET') {
        response.end(JSON.stringify({ message: greeting(url.searchParams.get('name') || 'world') }));
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.chat && request.method === 'POST') {
        const body = await readJsonBody(request) as { message?: unknown };
        if (typeof body.message !== 'string' || !body.message.trim()) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: 'A non-empty message is required.' }));
          return;
        }
        const result = await (await getChat()).prompt(body.message.trim());
        response.end(JSON.stringify(result));
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      response.statusCode = 500;
      const message = error instanceof Error ? error.message : String(error);
      const safeMessage = message.includes('No API key found')
        ? `未找到 ${home.config.provider} API 密钥。请设置 ${home.config.apiKeyEnv} 后重启 YuanpuAgent。`
        : message;
      response.end(JSON.stringify({
        error: safeMessage,
        hint: `Check ${home.configPath} and ${home.config.apiKeyEnv}.`,
      }));
    }
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
        piVersion: PI_UPSTREAM_VERSION,
        mcpTools: piCapabilityTools.map((tool) => tool.name),
        configRoot: home.root,
      }),
    );
  });

  const shutdown = () => {
    void chatPromise?.then((chat) => chat.dispose(), () => undefined);
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (args.includes('--version') || args.includes('-v')) {
  console.log(__APP_VERSION__);
} else if (args.includes('--serve')) {
  void serve().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const nameIndex = args.indexOf('--name');
  const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
  console.log(greeting(name || 'world'));
}
