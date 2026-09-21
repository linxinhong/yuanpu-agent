import {
  createDemoCapabilitySource,
  CapabilityApprovalStore,
  ManagedMcpCapabilitySource,
  createYuanpuMcpServer,
  createYuanpuCapabilityTools,
  createYuanpuChatSession,
  CAPABILITY_TOOL_NAMES,
  ensureYuanpuHome,
  greeting,
  inspectYuanpuExtensions,
  inspectYuanpuSkills,
  PI_UPSTREAM_VERSION,
  PluginManager,
  type YuanpuChatSession,
} from '@yuanpu-agent/runtime-kit';
import {
  PROTOCOL_VERSION,
  RUNTIME_ROUTES,
  capabilityApprovalSigningPayload,
  type CapabilityApprovalDecisionInput,
  type PluginConfigInput,
  type PluginConfigScope,
} from '@yuanpu-agent/protocol';
import { createServer, type IncomingMessage } from 'node:http';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

declare const __APP_VERSION__: string;

const args = process.argv.slice(2);

interface RuntimeBootstrap {
  token: string;
  approvalPublicKey: string;
}

async function readBootstrap(): Promise<RuntimeBootstrap> {
  let input = '';
  for await (const chunk of process.stdin) {
    input += Buffer.from(chunk).toString('utf8');
    if (input.length > 16 * 1024) throw new Error('Runtime bootstrap is too large');
    if (input.includes('\n')) break;
  }
  const line = input.slice(0, input.indexOf('\n') >= 0 ? input.indexOf('\n') : input.length);
  const value = JSON.parse(line) as Partial<RuntimeBootstrap>;
  if (
    typeof value.token !== 'string'
    || value.token.length < 32
    || typeof value.approvalPublicKey !== 'string'
    || !value.approvalPublicKey
  ) {
    throw new Error('Runtime bootstrap credentials are invalid');
  }
  return { token: value.token, approvalPublicKey: value.approvalPublicKey };
}

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

function createConfiguredPythonSource(privateHome: string): ManagedMcpCapabilitySource | undefined {
  const pythonExecutable = process.env.YUANPU_PYTHON_MCP_EXECUTABLE;
  const pythonRoot = process.env.YUANPU_PYTHON_MCP_ROOT;
  if (!pythonExecutable || !pythonRoot) return undefined;

  const executable = resolve(pythonExecutable);
  const root = resolve(pythonRoot);
  const configuredArgs = process.env.YUANPU_PYTHON_MCP_ARGS;
  const pythonArgs = configuredArgs ? JSON.parse(configuredArgs) as unknown : ['-m', 'yuanpu_echo_mcp'];
  if (!Array.isArray(pythonArgs) || pythonArgs.some((value) => typeof value !== 'string')) {
    throw new Error('YUANPU_PYTHON_MCP_ARGS must be a JSON string array.');
  }
  return new ManagedMcpCapabilitySource({
    sourceInstanceId: 'builtin.python.echo',
    packageVersion: '0.1.0',
    command: executable,
    args: pythonArgs,
    cwd: root,
    privateHome,
    riskPolicy: {
      yuanpu_echo_text: 'R0',
      yuanpu_diagnostic_error: 'R0',
      yuanpu_wait: 'R0',
    },
    env: {
      PATH: dirname(executable),
      PYTHONPATH: join(root, 'src'),
      PYTHONUNBUFFERED: '1',
      ...(process.platform === 'win32' && process.env.SYSTEMROOT
        ? { SYSTEMROOT: process.env.SYSTEMROOT }
        : {}),
    },
  });
}

async function capabilitySmoke(): Promise<void> {
  const privateHome = await mkdtemp(join(tmpdir(), 'yuanpu-mcp-smoke-'));
  const pythonSource = createConfiguredPythonSource(privateHome);
  if (!pythonSource) {
    await rm(privateHome, { recursive: true, force: true });
    throw new Error('Python MCP smoke requires YUANPU_PYTHON_MCP_EXECUTABLE and YUANPU_PYTHON_MCP_ROOT.');
  }
  try {
    const mcp = createYuanpuMcpServer([pythonSource]);
    const search = await mcp.callTool(CAPABILITY_TOOL_NAMES.search, {});
    if (!('matches' in search) || !Array.isArray(search.matches)) {
      throw new Error('Capability search returned an invalid result.');
    }
    const matches = search.matches as Array<{ name: string; originalName: string }>;
    const match = matches.find((item) => item.originalName === 'yuanpu_echo_text');
    if (!match) throw new Error('Python echo capability was not discovered.');
    const diagnostic = matches.find((item) => item.originalName === 'yuanpu_diagnostic_error');
    if (!diagnostic) throw new Error('Python diagnostic capability was not discovered.');
    const result = await mcp.callTool(CAPABILITY_TOOL_NAMES.execute, {
      name: match.name,
      arguments: { text: 'YuanpuAgent SEA' },
    });
    const errorResult = await mcp.callTool(CAPABILITY_TOOL_NAMES.execute, {
      name: diagnostic.name,
    });
    console.log(JSON.stringify({
      tools: [CAPABILITY_TOOL_NAMES.search, CAPABILITY_TOOL_NAMES.execute],
      capability: match.name,
      result,
      errorResult,
    }));
  } finally {
    await pythonSource.close();
    await rm(privateHome, { recursive: true, force: true });
  }
}

function readConfigScope(value: unknown): PluginConfigScope {
  if (value !== 'user' && value !== 'workspace') throw new Error('插件配置作用域无效。');
  return value;
}

function readConfigInput(value: unknown): PluginConfigInput {
  if (!value || typeof value !== 'object') throw new Error('插件配置请求无效。');
  const input = value as Partial<PluginConfigInput>;
  if (
    typeof input.name !== 'string'
    || !input.name.trim()
    || !input.value
    || typeof input.value !== 'object'
    || Array.isArray(input.value)
  ) {
    throw new Error('插件名称或配置内容无效。');
  }
  return { name: input.name, scope: readConfigScope(input.scope), value: input.value };
}

async function serve(): Promise<void> {
  const portIndex = args.indexOf('--port');
  const requestedPort = portIndex >= 0 ? Number(args[portIndex + 1]) : 0;
  const { token, approvalPublicKey } = await readBootstrap();
  const approvalVerificationKey = createPublicKey({
    key: Buffer.from(approvalPublicKey, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const usedDecisionNonces = new Set<string>();

  const home = await ensureYuanpuHome(process.env.YUANPU_HOME);
  process.env.PI_CODING_AGENT_DIR = home.agentPath;
  process.env.PI_CODING_AGENT_SESSION_DIR = home.sessionsPath;
  const plugins = new PluginManager(
    home.packagesPath,
    home.agentPath,
    process.env.YUANPU_PLUGIN_REGISTRY_URL,
    home.config.workingDirectory,
    home.config.catalogUrl,
  );
  const approvals = await CapabilityApprovalStore.open(join(home.appPath, 'approvals.json'));
  const capabilitySources = [createDemoCapabilitySource()];
  const pythonSource = createConfiguredPythonSource(
    join(home.appPath, 'capabilities', 'builtin.python.echo', 'home'),
  );
  if (pythonSource) capabilitySources.push(pythonSource);
  const mcp = createYuanpuMcpServer(capabilitySources, approvals);
  const piCapabilityTools = createYuanpuCapabilityTools(mcp);
  let chatPromise: Promise<YuanpuChatSession> | undefined;
  let chatSessionId: string | undefined;
  let activePrompts = 0;
  const retiredChats = new Set<Promise<YuanpuChatSession>>();
  const disposeRetiredChats = () => {
    if (activePrompts > 0) return;
    for (const retired of retiredChats) {
      retiredChats.delete(retired);
      void retired.then((chat) => chat.dispose(), () => undefined);
    }
  };
  const resetChat = () => {
    const previous = chatPromise;
    const previousSessionId = chatSessionId;
    chatPromise = undefined;
    chatSessionId = undefined;
    if (previousSessionId) void approvals.cancelSession(previousSessionId);
    if (previous) retiredChats.add(previous);
    disposeRetiredChats();
  };
  const getChat = () => {
    if (!chatPromise) {
      chatSessionId = randomUUID();
      chatPromise = createYuanpuChatSession({
      capabilityClient: mcp,
      capabilityContext: {
        sessionId: chatSessionId,
        workspaceId: home.config.workingDirectory,
        userId: 'local-user',
      },
      agentDir: home.agentPath,
      cwd: home.config.workingDirectory,
      provider: home.config.provider,
      model: home.config.model,
      apiKey: process.env[home.config.apiKeyEnv],
      apiKeyEnv: home.config.apiKeyEnv,
      baseUrl: home.config.baseUrl,
      api: home.config.api,
      });
    }
    return chatPromise;
  };
  const inspectPlugin = async (plugin: { installPath: string }) => {
    const diagnostics = await inspectYuanpuExtensions({
      agentDir: home.agentPath,
      cwd: home.config.workingDirectory,
    });
    return diagnostics.filter((diagnostic) => diagnostic.path.startsWith(plugin.installPath));
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
        activePrompts += 1;
        try {
          const result = await (await getChat()).prompt(body.message.trim());
          response.end(JSON.stringify(result));
        } finally {
          activePrompts -= 1;
          disposeRetiredChats();
        }
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.localSkills && request.method === 'GET') {
        response.end(JSON.stringify(await inspectYuanpuSkills({
          agentDir: home.agentPath,
          cwd: home.config.workingDirectory,
        })));
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.capabilityApprovals && request.method === 'GET') {
        response.end(JSON.stringify(await approvals.listPending()));
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.capabilityApprovalDecision && request.method === 'POST') {
        const body = await readJsonBody(request) as Partial<CapabilityApprovalDecisionInput>;
        if (
          typeof body.requestId !== 'string'
          || !body.requestId.trim()
          || body.requestId.length > 200
          || (body.decision !== 'approved' && body.decision !== 'denied')
          || !Number.isSafeInteger(body.issuedAt)
          || Math.abs(Date.now() - (body.issuedAt ?? 0)) > 30_000
          || typeof body.nonce !== 'string'
          || !/^[A-Za-z0-9_-]{16,128}$/.test(body.nonce)
          || typeof body.signature !== 'string'
          || !/^[A-Za-z0-9_-]{64,256}$/.test(body.signature)
        ) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: 'Invalid capability approval decision.' }));
          return;
        }
        const unsigned = {
          requestId: body.requestId,
          decision: body.decision,
          issuedAt: body.issuedAt as number,
          nonce: body.nonce,
        };
        if (
          usedDecisionNonces.has(body.nonce)
          || !verify(
            null,
            capabilityApprovalSigningPayload(unsigned),
            approvalVerificationKey,
            Buffer.from(body.signature, 'base64url'),
          )
        ) {
          response.statusCode = 403;
          response.end(JSON.stringify({ error: 'Capability approval signature is invalid.' }));
          return;
        }
        usedDecisionNonces.add(body.nonce);
        if (usedDecisionNonces.size > 1_000) {
          const oldest = usedDecisionNonces.values().next().value as string | undefined;
          if (oldest) usedDecisionNonces.delete(oldest);
        }
        try {
          response.end(JSON.stringify(await approvals.decide(body.requestId, body.decision)));
        } catch (error) {
          response.statusCode = 409;
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.pluginSearch && request.method === 'GET') {
        response.end(JSON.stringify(await plugins.search(url.searchParams.get('q') ?? '')));
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.plugins && request.method === 'GET') {
        response.end(JSON.stringify(await plugins.list()));
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.pluginConfig && request.method === 'GET') {
        const name = url.searchParams.get('name');
        if (!name) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: '插件名称不能为空。' }));
          return;
        }
        const scope = readConfigScope(url.searchParams.get('scope'));
        response.end(JSON.stringify(await plugins.getConfig(name, scope)));
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.pluginConfigValidate && request.method === 'POST') {
        const input = readConfigInput(await readJsonBody(request));
        response.end(JSON.stringify(await plugins.validateConfig(input)));
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.pluginConfigSave && request.method === 'POST') {
        const input = readConfigInput(await readJsonBody(request));
        const document = await plugins.saveConfig(input);
        resetChat();
        response.end(JSON.stringify(document));
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.pluginConfigReset && request.method === 'POST') {
        const body = await readJsonBody(request) as { name?: unknown; scope?: unknown };
        if (typeof body.name !== 'string' || !body.name.trim()) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: '插件名称不能为空。' }));
          return;
        }
        const document = await plugins.resetConfig(body.name, readConfigScope(body.scope));
        resetChat();
        response.end(JSON.stringify(document));
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.pluginInstall && request.method === 'POST') {
        const body = await readJsonBody(request) as { source?: unknown };
        if (typeof body.source !== 'string' || !body.source.trim()) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: '插件来源不能为空。' }));
          return;
        }
        const plugin = await plugins.install(body.source.trim());
        const pluginErrors = await inspectPlugin(plugin);
        if (pluginErrors.length > 0) {
          const message = pluginErrors.map((diagnostic) => diagnostic.error).join('\n');
          await plugins.markLoadError(plugin.name, message);
          resetChat();
          response.statusCode = 422;
          response.end(JSON.stringify({
            error: `插件已安装但加载失败，已自动停用：${message}`,
          }));
          return;
        }
        resetChat();
        response.end(JSON.stringify(plugin));
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.pluginState && request.method === 'POST') {
        const body = await readJsonBody(request) as { name?: unknown; enabled?: unknown };
        if (typeof body.name !== 'string' || typeof body.enabled !== 'boolean') {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: '插件名称和启用状态无效。' }));
          return;
        }
        const plugin = await plugins.setEnabled(body.name, body.enabled);
        if (body.enabled) {
          const pluginErrors = await inspectPlugin(plugin);
          if (pluginErrors.length > 0) {
            const message = pluginErrors.map((diagnostic) => diagnostic.error).join('\n');
            await plugins.markLoadError(plugin.name, message);
            resetChat();
            response.statusCode = 422;
            response.end(JSON.stringify({
              error: `插件加载失败，已重新停用：${message}`,
            }));
            return;
          }
        }
        resetChat();
        response.end(JSON.stringify(plugin));
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.pluginUninstall && request.method === 'POST') {
        const body = await readJsonBody(request) as { name?: unknown };
        if (typeof body.name !== 'string' || !body.name.trim()) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: '插件名称不能为空。' }));
          return;
        }
        await plugins.uninstall(body.name);
        resetChat();
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      response.statusCode = 500;
      const message = error instanceof Error ? error.message : String(error);
      const missingApiKey = message.includes('No API key found');
      const safeMessage = missingApiKey
        ? `未找到 ${home.config.provider} API 密钥。请设置 ${home.config.apiKeyEnv} 后重启 YuanpuAgent。`
        : message;
      response.end(JSON.stringify({
        error: safeMessage,
        ...(missingApiKey
          ? { hint: `Check ${home.configPath} and ${home.config.apiKeyEnv}.` }
          : {}),
      }));
    }
  });
  server.on('close', () => {
    if (chatSessionId) void approvals.cancelSession(chatSessionId);
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
    resetChat();
    activePrompts = 0;
    disposeRetiredChats();
    server.close(() => {
      void pythonSource?.close().finally(() => process.exit(0));
      if (!pythonSource) process.exit(0);
    });
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
} else if (args.includes('--capability-smoke')) {
  void capabilitySmoke().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const nameIndex = args.indexOf('--name');
  const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
  console.log(greeting(name || 'world'));
}
