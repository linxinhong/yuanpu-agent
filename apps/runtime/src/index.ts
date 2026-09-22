import {
  createDemoCapabilitySource,
  createNotificationCapabilitySource,
  CapabilityApprovalStore,
  ManagedMcpCapabilitySource,
  createYuanpuMcpServer,
  createYuanpuCapabilityTools,
  CAPABILITY_TOOL_NAMES,
  ensureYuanpuHome,
  greeting,
  inspectYuanpuExtensions,
  inspectYuanpuSkills,
  PI_UPSTREAM_VERSION,
  PluginManager,
  CapabilityArtifactManager,
  capabilityManifestDigest,
  openYuanpuMetadataDatabase,
  PersistentAgentService,
  HostNotificationRouter,
  requestTerminalRunNotification,
  PersistentScheduler,
  validateCapabilityConfig,
  detectMcpOwnershipConflicts,
  type ArtifactTrustRoot,
  type AuthenticatedAgentCaller,
} from '@yuanpu-agent/runtime-kit';
import {
  AGENT_CONTRACT_VERSION,
  SCHEDULE_CONTRACT_VERSION,
  PROTOCOL_VERSION,
  RUNTIME_ROUTES,
  capabilityApprovalSigningPayload,
  type CapabilityPackageManifest,
  type CapabilityApprovalDecisionInput,
  type PluginConfigInput,
  type PluginConfigScope,
  type PluginConfigDocument,
  type PluginConfigValidation,
  type HostEventReceipt,
  type NotificationNavigationTarget,
  type NotificationTargetValidation,
} from '@yuanpu-agent/protocol';
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { RuntimeAgentExecutor } from './agent-runtime.js';
import { installParentProcessMonitor, type ParentProcessMonitor } from './process-lifecycle.js';
import { cleanupRuntimeResources, getDesktopNavigableRun } from './runtime-host.js';
import { closeWecomChannels, startConfiguredWecomChannels } from './wecom-channel.js';

declare const __APP_VERSION__: string;

const args = process.argv.slice(2);
const PYTHON_MCP_INITIALIZATION_TIMEOUT_MS = 15_000;
const PYTHON_CAPABILITY_DISCOVERY_TIMEOUT_MS = 20_000;
const execFileAsync = promisify(execFile);

interface RuntimeBootstrap {
  token: string;
  approvalPublicKey: string;
  parentPid: number;
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
    || !Number.isSafeInteger(value.parentPid)
    || Number(value.parentPid) <= 1
  ) {
    throw new Error('Runtime bootstrap credentials are invalid');
  }
  return {
    token: value.token,
    approvalPublicKey: value.approvalPublicKey,
    parentPid: Number(value.parentPid),
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readBoundedJsonResponse(response: Response, maximumBytes = 256 * 1024): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error(`能力 manifest 超过 ${maximumBytes} 字节限制。`);
  }
  if (!response.body) throw new Error('能力 manifest 响应为空。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error(`能力 manifest 超过 ${maximumBytes} 字节限制。`);
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')) as unknown;
}

function createConfiguredPythonSource(
  privateHome: string,
  configFile?: string,
): ManagedMcpCapabilitySource | undefined {
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
    packageVersion: process.env.YUANPU_PYTHON_MCP_VERSION ?? '0.1.0',
    command: executable,
    args: pythonArgs,
    cwd: root,
    privateHome,
    riskPolicy: {
      yuanpu_echo_text: 'R0',
      yuanpu_approved_echo: 'R2',
      yuanpu_show_message: 'R2',
      yuanpu_diagnostic_error: 'R0',
      yuanpu_wait: 'R0',
    },
    env: {
      PATH: dirname(executable),
      PYTHONPATH: join(root, 'src'),
      PYTHONUNBUFFERED: '1',
      ...(configFile ? { YUANPU_CAPABILITY_CONFIG_FILE: configFile } : {}),
      ...(process.platform === 'win32' && process.env.SYSTEMROOT
        ? { SYSTEMROOT: process.env.SYSTEMROOT }
        : {}),
    },
    initializationTimeoutMs: PYTHON_MCP_INITIALIZATION_TIMEOUT_MS,
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
    const mcp = createYuanpuMcpServer([pythonSource], undefined, {
      discoveryTimeoutMs: PYTHON_CAPABILITY_DISCOVERY_TIMEOUT_MS,
    });
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

async function capabilityLifecycleSmoke(parentPid: number): Promise<void> {
  const privateHome = await mkdtemp(join(tmpdir(), 'yuanpu-mcp-lifecycle-'));
  const pythonSource = createConfiguredPythonSource(privateHome);
  if (!pythonSource) {
    await rm(privateHome, { recursive: true, force: true });
    throw new Error('Capability lifecycle smoke requires a configured MCP executable and root.');
  }
  let parentMonitor: ParentProcessMonitor | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return;
    const forcedExit = setTimeout(() => process.exit(1), 5_000);
    forcedExit.unref();
    closing = pythonSource.close()
      .finally(() => rm(privateHome, { recursive: true, force: true }))
      .finally(() => {
        parentMonitor?.dispose();
        clearTimeout(forcedExit);
        process.exit(0);
      });
  };
  try {
    const tools = await pythonSource.list({});
    const spawnTool = tools.find((tool) => tool.name === 'yuanpu_spawn_child');
    if (!spawnTool) throw new Error('Lifecycle smoke MCP did not expose yuanpu_spawn_child.');
    const result = await pythonSource.execute({
      capabilityId: spawnTool.name,
      originalName: spawnTool.name,
      arguments: {},
    }, {});
    const descendantPid = result?.structuredContent?.pid;
    if (typeof descendantPid !== 'number') {
      throw new Error('Lifecycle smoke MCP did not report its descendant PID.');
    }
    parentMonitor = installParentProcessMonitor(parentPid, close);
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    console.log(JSON.stringify({
      event: 'ready',
      runtimePid: process.pid,
      mcpPid: pythonSource.processId,
      descendantPid,
    }));
  } catch (error) {
    await pythonSource.close().catch(() => undefined);
    await rm(privateHome, { recursive: true, force: true });
    throw error;
  }
}

function sqliteSmoke(path: string | undefined): void {
  if (!path) throw new Error('--sqlite-smoke requires an explicit database path.');
  const database = openYuanpuMetadataDatabase(resolve(path));
  const count = database.incrementMetadataCounter('native-sea-open-count');
  const schemaVersion = database.schemaVersion;
  const driver = database.driver;
  database.close();

  const reopened = openYuanpuMetadataDatabase(resolve(path));
  const persistedCount = Number.parseInt(reopened.getMetadata('native-sea-open-count') ?? '', 10);
  reopened.close();
  if (persistedCount !== count) throw new Error('SQLite value did not survive close and reopen.');
  console.log(JSON.stringify({ driver, schemaVersion, persistedCount }));
}

async function schedulerSmoke(path: string | undefined): Promise<void> {
  if (!path) throw new Error('--scheduler-smoke requires an explicit database path.');
  const now = new Date('2026-09-22T00:00:00.000Z');
  const database = openYuanpuMetadataDatabase(resolve(path));
  const caller: AuthenticatedAgentCaller = {
    entryPoint: 'scheduler',
    identity: {
      kind: 'scheduler',
      subjectId: 'native-smoke',
      authorityId: 'native-runtime',
      authenticatedBy: 'scheduler',
    },
    authorizeWorkspace: (workspaceId) => workspaceId === '/native-smoke',
    authorizeConversation: (conversation) => conversation.namespace === 'scheduler',
    authorizeDelivery: (delivery) => delivery.kind === 'none',
  };
  const agent = await PersistentAgentService.open({
    store: database.agentRuns,
    executor: {
      async execute(input) {
        return { kind: 'completed', output: { message: input.input, tools: [] } };
      },
    },
    now: () => now,
  });
  const scheduler = await PersistentScheduler.open({
    store: database.schedules,
    agent,
    caller,
    authorizeWorkspace: caller.authorizeWorkspace,
    authorizeDelivery: caller.authorizeDelivery,
    now: () => now,
    scanIntervalMs: 60_000,
  });
  const schedule = scheduler.create({
    contractVersion: SCHEDULE_CONTRACT_VERSION,
    name: 'Native scheduler smoke',
    prompt: 'SEA scheduler persisted output',
    workspaceId: '/native-smoke',
    timing: { kind: 'once', at: now.toISOString() },
    timeZone: 'UTC',
    delivery: { kind: 'none' },
  });
  await scheduler.tick();
  await agent.waitForIdle();
  await scheduler.tick();
  await scheduler.close();
  await agent.close();
  database.close();

  const reopened = openYuanpuMetadataDatabase(resolve(path));
  const history = reopened.schedules.history(schedule.scheduleId, 10);
  const schemaVersion = reopened.schemaVersion;
  reopened.close();
  const result = history[0];
  if (history.length !== 1 || result?.runStatus !== 'succeeded' || !result.output) {
    throw new Error('Scheduled run did not survive SQLite close and reopen.');
  }
  console.log(JSON.stringify({
    schemaVersion,
    historyCount: history.length,
    runStatus: result.runStatus,
    output: result.output.message,
    deliveryStatus: result.deliveryStatus,
  }));
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
  const { token, approvalPublicKey, parentPid } = await readBootstrap();
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
    process.env.YUANPU_CATALOG_URL ?? home.config.catalogUrl,
  );
  let artifacts: CapabilityArtifactManager | undefined;
  const trustRootFile = process.env.YUANPU_CAPABILITY_TRUST_ROOT_FILE;
  if (trustRootFile) {
    const trustRoot = JSON.parse(await readFile(resolve(trustRootFile), 'utf8')) as ArtifactTrustRoot;
    artifacts = new CapabilityArtifactManager(home.packagesPath, {
      runtimeVersion: __APP_VERSION__,
      trustRoots: [trustRoot],
    });
    const active = await artifacts.active('builtin.python.echo');
    if (active) {
      process.env.YUANPU_PYTHON_MCP_EXECUTABLE = active.entrypoint;
      process.env.YUANPU_PYTHON_MCP_ROOT = active.installPath;
      process.env.YUANPU_PYTHON_MCP_ARGS = '[]';
      process.env.YUANPU_PYTHON_MCP_VERSION = active.version;
    } else {
      const bundledManifest = JSON.parse(
        await readFile(join(dirname(resolve(trustRootFile)), 'manifest.json'), 'utf8'),
      ) as { version?: unknown };
      if (typeof bundledManifest.version !== 'string') {
        throw new Error('Bundled capability manifest version is invalid.');
      }
      process.env.YUANPU_PYTHON_MCP_VERSION = bundledManifest.version;
    }
  }
  const approvals = await CapabilityApprovalStore.open(join(home.appPath, 'approvals.json'));
  const pythonConfigFile = join(home.packagesPath, 'config', 'builtin.python.echo', 'user.json');
  const fetchArtifactManifest = async (source: string) => {
    if (!artifacts) throw new Error('当前宿主没有配置能力制品信任根。');
    if (!source.startsWith('artifact:')) throw new Error('能力来源无效。');
    const manifestUrl = source.slice('artifact:'.length);
    const parsedManifestUrl = new URL(manifestUrl);
    if (!['https:', 'http:'].includes(parsedManifestUrl.protocol)) {
      throw new Error('能力 manifest 必须使用 HTTP(S) 地址。');
    }
    const response = await fetch(parsedManifestUrl, {
      headers: { accept: 'application/json', 'user-agent': `YuanpuAgent/${__APP_VERSION__}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`能力 manifest 下载失败：HTTP ${response.status}`);
    const manifest = await readBoundedJsonResponse(response) as CapabilityPackageManifest;
    const inspected = artifacts.inspectManifest(manifest);
    const digest = capabilityManifestDigest(inspected);
    return { manifest: inspected, manifestUrl: response.url, digest };
  };
  const assertExpectedManifest = (actual: string, expected: unknown) => {
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || actual !== expected) {
      throw new Error('能力清单已变化，请重新查看权限并确认安装。');
    }
  };
  const artifactConfigValidation = (
    schema: Record<string, unknown>,
    value: Record<string, unknown>,
  ): PluginConfigValidation => {
    return validateCapabilityConfig(schema, value);
  };
  const readArtifactConfig = async (schema?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try {
      const value = JSON.parse(await readFile(pythonConfigFile, 'utf8')) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('能力配置必须是对象。');
      return value as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const defaultValue = schema?.default;
        return defaultValue && typeof defaultValue === 'object' && !Array.isArray(defaultValue)
          ? structuredClone(defaultValue as Record<string, unknown>)
          : {};
      }
      throw error;
    }
  };
  const artifactConfigDocument = async (scope: PluginConfigScope): Promise<PluginConfigDocument> => {
    if (scope !== 'user') throw new Error('Python 能力仅支持用户级配置。');
    const active = await artifacts?.active('builtin.python.echo');
    if (!active?.configSchema) throw new Error('当前能力版本未声明可管理配置。');
    return {
      pluginName: 'builtin.python.echo',
      kind: 'schema',
      title: 'Python 示例能力',
      description: '配置 echo 输出前缀；配置独立于版本目录，更新和回滚不会删除。',
      scope,
      path: pythonConfigFile,
      value: await readArtifactConfig(active.configSchema),
      schema: active.configSchema,
      supportsWorkspace: false,
      secretPolicy: 'environment-only',
    };
  };
  const notificationRouter = new HostNotificationRouter();
  const notificationSource = createNotificationCapabilitySource(notificationRouter);
  const capabilitySources = [createDemoCapabilitySource(), notificationSource];
  let pythonSource = createConfiguredPythonSource(
    join(home.appPath, 'capabilities', 'builtin.python.echo', 'home'),
    pythonConfigFile,
  );
  if (pythonSource) capabilitySources.push(pythonSource);
  let mcp = createYuanpuMcpServer(capabilitySources, approvals, {
    discoveryTimeoutMs: PYTHON_CAPABILITY_DISCOVERY_TIMEOUT_MS,
  });
  const piCapabilityTools = createYuanpuCapabilityTools(mcp);
  const metadata = openYuanpuMetadataDatabase(join(home.workflowsPath, 'automation.sqlite'));
  const agentExecutor = new RuntimeAgentExecutor({
    getCapabilityClient: () => mcp,
    approvals,
    sessionsPath: home.sessionsPath,
    chat: {
      agentDir: home.agentPath,
      cwd: home.config.workingDirectory,
      provider: home.config.provider,
      model: home.config.model,
      apiKey: process.env[home.config.apiKeyEnv],
      apiKeyEnv: home.config.apiKeyEnv,
      baseUrl: home.config.baseUrl,
      api: home.config.api,
    },
  });
  const agentService = await PersistentAgentService.open({
    store: metadata.agentRuns,
    executor: agentExecutor,
    approvals,
    maximumConcurrentRuns: 4,
    maximumQueuedRuns: 100,
    onRunStateChanged: (run) => {
      const receipt = requestTerminalRunNotification(notificationRouter, run);
      void receipt?.catch((error) => {
        console.error('Terminal run notification failed:', error instanceof Error ? error.message : String(error));
      });
    },
  });
  const desktopCaller: AuthenticatedAgentCaller = {
    entryPoint: 'desktop',
    identity: {
      kind: 'local_user',
      subjectId: 'local-user',
      authorityId: 'local-desktop',
      authenticatedBy: 'electron',
    },
    authorizeWorkspace: (workspaceId) => workspaceId === home.config.workingDirectory,
    authorizeConversation: (conversation) => conversation.namespace === 'desktop',
    authorizeDelivery: (delivery) => delivery.kind === 'desktop' || delivery.kind === 'none',
  };
  const schedulerCaller: AuthenticatedAgentCaller = {
    entryPoint: 'scheduler',
    identity: {
      kind: 'scheduler',
      subjectId: 'local-scheduler',
      authorityId: 'local-runtime',
      authenticatedBy: 'scheduler',
    },
    authorizeWorkspace: (workspaceId) => workspaceId === home.config.workingDirectory,
    authorizeConversation: (conversation) => conversation.namespace === 'scheduler',
    authorizeDelivery: (delivery) => delivery.kind === 'desktop' || delivery.kind === 'none',
  };
  const wecomChannels = await startConfiguredWecomChannels({
    appPath: home.appPath,
    workspaceId: home.config.workingDirectory,
    store: metadata.channels,
    agent: agentService,
    log: (record) => {
      const message = `[wecom] ${record.event}`;
      if (record.level === 'error') console.error(message);
      else if (record.level === 'warn') console.warn(message);
      else if (record.level === 'info') console.info(message);
    },
  });
  const scheduler = await PersistentScheduler.open({
    store: metadata.schedules,
    agent: agentService,
    caller: schedulerCaller,
    authorizeWorkspace: schedulerCaller.authorizeWorkspace,
    authorizeDelivery: schedulerCaller.authorizeDelivery,
  });
  const activatePythonArtifact = async (entrypoint: string, installPath: string, version: string) => {
    const previousSource = pythonSource;
    process.env.YUANPU_PYTHON_MCP_EXECUTABLE = entrypoint;
    process.env.YUANPU_PYTHON_MCP_ROOT = installPath;
    process.env.YUANPU_PYTHON_MCP_ARGS = '[]';
    process.env.YUANPU_PYTHON_MCP_VERSION = version;
    pythonSource = createConfiguredPythonSource(
      join(home.appPath, 'capabilities', 'builtin.python.echo', 'home'),
      pythonConfigFile,
    );
    mcp = createYuanpuMcpServer(
      [createDemoCapabilitySource(), notificationSource, ...(pythonSource ? [pythonSource] : [])],
      approvals,
      { discoveryTimeoutMs: PYTHON_CAPABILITY_DISCOVERY_TIMEOUT_MS },
    );
    agentExecutor.reset();
    await previousSource?.close();
  };
  const inspectPlugin = async (plugin: { installPath: string }) => {
    const diagnostics = await inspectYuanpuExtensions({
      agentDir: home.agentPath,
      cwd: home.config.workingDirectory,
    });
    return diagnostics.filter((diagnostic) => diagnostic.path.startsWith(plugin.installPath));
  };
  const waitForDesktopRun = async (runId: string) => {
    for await (const run of agentService.subscribe(desktopCaller, runId)) {
      if (run.status === 'succeeded') {
        if (!run.output) throw new Error('Agent run completed without a live output.');
        return run.output;
      }
      if (
        run.status === 'failed'
        || run.status === 'cancelled'
        || run.status === 'interrupted'
        || run.status === 'result_unknown'
      ) {
        throw new Error(run.failure?.message ?? `Agent run ended with status ${run.status}.`);
      }
      if (run.status === 'waiting_approval') {
        if (run.output) return run.output;
        throw new Error(`Agent run is waiting for approval ${run.pendingApproval?.approvalRequestId ?? ''}.`);
      }
    }
    throw new Error('Agent run is not available to the desktop caller.');
  };

  let shuttingDown = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.setHeader('content-type', 'application/json; charset=utf-8');

    if (shuttingDown) {
      response.statusCode = 503;
      response.setHeader('connection', 'close');
      response.end(JSON.stringify({ error: 'Runtime is shutting down.' }));
      return;
    }

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
            notificationsEnabled: home.config.notifications?.enabled ?? true,
          }),
        );
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.hostEvents && request.method === 'GET') {
        response.statusCode = 200;
        response.setHeader('content-type', 'text/event-stream; charset=utf-8');
        response.setHeader('cache-control', 'no-cache, no-transform');
        response.setHeader('connection', 'keep-alive');
        response.flushHeaders();
        response.write(': connected\n\n');
        const lastEventId = typeof request.headers['last-event-id'] === 'string'
          ? request.headers['last-event-id']
          : undefined;
        const unsubscribe = notificationRouter.subscribe(lastEventId, (event) => {
          response.write(`id: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`);
        });
        response.once('close', unsubscribe);
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.hostEventReceipts && request.method === 'POST') {
        const rawBody = await readJsonBody(request);
        if (!isRecord(rawBody)) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: 'Invalid host event receipt.' }));
          return;
        }
        const body = rawBody as Partial<HostEventReceipt>;
        const notification = body.notification;
        if (
          typeof body.eventId !== 'string'
          || body.eventId.length < 1
          || body.eventId.length > 200
          || !['accepted', 'duplicate', 'unsupported', 'rejected'].includes(body.status ?? '')
          || (body.message !== undefined && (
            typeof body.message !== 'string' || body.message.length > 1_000
          ))
          || (notification !== undefined && (
            !isRecord(notification)
            || typeof notification.requestId !== 'string'
            || notification.requestId.length < 1
            || notification.requestId.length > 200
            || !['submitted', 'suppressed', 'unavailable', 'failed'].includes(notification.status)
            || notification.userVisibility !== 'unknown'
            || (notification.message !== undefined && (
              typeof notification.message !== 'string' || notification.message.length > 1_000
            ))
          ))
        ) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: 'Invalid host event receipt.' }));
          return;
        }
        const acknowledged = notificationRouter.acknowledge(body as HostEventReceipt);
        response.statusCode = acknowledged ? 200 : 404;
        response.end(JSON.stringify({ acknowledged }));
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.notificationTargetValidation && request.method === 'POST') {
        const rawBody = await readJsonBody(request);
        if (!isRecord(rawBody)
          || (rawBody.conversationId !== undefined && (
            typeof rawBody.conversationId !== 'string'
            || rawBody.conversationId.length < 1
            || rawBody.conversationId.length > 512
          ))
          || (rawBody.runId !== undefined && (
            typeof rawBody.runId !== 'string'
            || rawBody.runId.length < 1
            || rawBody.runId.length > 200
          ))) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: 'Invalid notification navigation target.' }));
          return;
        }
        const body = rawBody as NotificationNavigationTarget;
        const requestedConversationId = typeof body.conversationId === 'string'
          ? body.conversationId
          : undefined;
        const requestedRunId = typeof body.runId === 'string'
          ? body.runId
          : undefined;
        let result: NotificationTargetValidation;
        if (requestedRunId) {
          const run = await getDesktopNavigableRun(
            agentService,
            requestedRunId,
            desktopCaller,
            schedulerCaller,
          );
          const conversationId = run?.context.conversation.conversationId;
          result = run && conversationId && (!requestedConversationId || requestedConversationId === conversationId)
            ? { valid: true, target: { conversationId, runId: run.runId } }
            : { valid: false, message: 'The notification target is not owned by this desktop user.' };
        } else if (requestedConversationId === 'default') {
          result = { valid: true, target: { conversationId: 'default' } };
        } else {
          result = { valid: false, message: 'The notification target does not identify a known conversation or run.' };
        }
        response.end(JSON.stringify(result));
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
        const submission = await agentService.submit(desktopCaller, {
          contractVersion: AGENT_CONTRACT_VERSION,
          entryPoint: 'desktop',
          identity: desktopCaller.identity,
          workspaceId: home.config.workingDirectory,
          conversation: { namespace: 'desktop', conversationId: 'default' },
          input: { type: 'text', text: body.message.trim() },
          idempotencyKey: randomUUID(),
          delivery: { kind: 'desktop' },
        });
        if (!submission.accepted) throw new Error(submission.message);
        response.end(JSON.stringify(await waitForDesktopRun(submission.runId)));
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.agentRuns && request.method === 'POST') {
        const submission = await agentService.submit(desktopCaller, await readJsonBody(request));
        if (!submission.accepted) {
          response.statusCode = submission.code === 'queue_full'
            ? 429
            : submission.code === 'forbidden' || submission.code === 'identity_mismatch'
              ? 403
              : submission.code === 'idempotency_conflict'
                ? 409
                : 400;
        }
        response.end(JSON.stringify(submission));
        return;
      }

      const agentRunPath = url.pathname.startsWith(`${RUNTIME_ROUTES.agentRuns}/`)
        ? url.pathname.slice(RUNTIME_ROUTES.agentRuns.length + 1).split('/')
        : undefined;
      if (agentRunPath?.length === 1 && request.method === 'GET') {
        const run = await getDesktopNavigableRun(
          agentService,
          decodeURIComponent(agentRunPath[0]!),
          desktopCaller,
          schedulerCaller,
        );
        response.statusCode = run ? 200 : 404;
        response.end(JSON.stringify(run ?? { error: 'Agent run not found.' }));
        return;
      }
      if (agentRunPath?.length === 2 && agentRunPath[1] === 'cancel' && request.method === 'POST') {
        const receipt = await agentService.cancel(
          desktopCaller,
          decodeURIComponent(agentRunPath[0]!),
        );
        response.statusCode = receipt.result === 'not_found' ? 404 : 200;
        response.end(JSON.stringify(receipt));
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.schedules && request.method === 'GET') {
        response.end(JSON.stringify(scheduler.list()));
        return;
      }
      if (url.pathname === RUNTIME_ROUTES.schedules && request.method === 'POST') {
        try {
          const schedule = scheduler.create(await readJsonBody(request));
          response.statusCode = 201;
          response.end(JSON.stringify(schedule));
        } catch (error) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }
      const schedulePath = url.pathname.startsWith(`${RUNTIME_ROUTES.schedules}/`)
        ? url.pathname.slice(RUNTIME_ROUTES.schedules.length + 1).split('/')
        : undefined;
      if (schedulePath?.length === 1 && request.method === 'GET') {
        const schedule = scheduler.get(decodeURIComponent(schedulePath[0]!));
        response.statusCode = schedule ? 200 : 404;
        response.end(JSON.stringify(schedule ?? { error: 'Schedule not found.' }));
        return;
      }
      if (schedulePath?.length === 1 && request.method === 'PUT') {
        const scheduleId = decodeURIComponent(schedulePath[0]!);
        if (!scheduler.get(scheduleId)) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: 'Schedule not found.' }));
          return;
        }
        try {
          response.end(JSON.stringify(scheduler.update(scheduleId, await readJsonBody(request))));
        } catch (error) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }
      if (
        schedulePath?.length === 2
        && (schedulePath[1] === 'enable' || schedulePath[1] === 'disable')
        && request.method === 'POST'
      ) {
        const scheduleId = decodeURIComponent(schedulePath[0]!);
        if (!scheduler.get(scheduleId)) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: 'Schedule not found.' }));
          return;
        }
        response.end(JSON.stringify(scheduler.setEnabled(scheduleId, schedulePath[1] === 'enable')));
        return;
      }
      if (schedulePath?.length === 2 && schedulePath[1] === 'history' && request.method === 'GET') {
        const scheduleId = decodeURIComponent(schedulePath[0]!);
        if (!scheduler.get(scheduleId)) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: 'Schedule not found.' }));
          return;
        }
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
        try {
          response.end(JSON.stringify(scheduler.history(scheduleId, limit)));
        } catch (error) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
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
        const execution = approvals.executionFor(body.requestId);
        let approvalSignal: AbortSignal | undefined;
        try {
          if (!execution) throw new Error('Approved capability execution is no longer available.');
          if (execution.runId) {
            approvalSignal = await agentService.beginApproval(execution.runId, body.requestId, {
              executeCapability: body.decision === 'approved',
            });
          }
          await approvals.decide(body.requestId, body.decision);
          if (body.decision === 'denied') {
            if (execution.runId && approvalSignal) {
              agentService.failApproval(
                execution.runId,
                body.requestId,
                approvalSignal,
                'Capability approval was denied by the desktop user.',
              );
            }
            response.end(JSON.stringify({ requestId: body.requestId, status: 'denied' }));
            return;
          }
          const result = await mcp.execute({
            name: execution.capabilityId,
            arguments: execution.arguments,
            approvalRequestId: execution.requestId,
          }, {
            runId: execution.runId,
            sessionId: execution.sessionId,
            workspaceId: execution.workspaceId,
            signal: approvalSignal,
          });
          const message = result.content
            .filter((block): block is Extract<(typeof result.content)[number], { type: 'text' }> => block.type === 'text')
            .map((block) => block.text)
            .join('\n') || JSON.stringify(result.structuredContent ?? {});
          if (execution.runId) {
            if (result.isError) {
              agentService.failApproval(execution.runId, body.requestId, approvalSignal!, message);
            } else {
              agentService.completeApproval(
                execution.runId,
                body.requestId,
                approvalSignal!,
                {
                  message,
                  tools: [{ name: execution.capabilityId, status: 'completed' }],
                },
              );
            }
          }
          response.end(JSON.stringify({ requestId: body.requestId, status: 'completed', message }));
        } catch (error) {
          if (execution?.runId && approvalSignal) {
            try {
              agentService.failApproval(
                execution.runId,
                body.requestId,
                approvalSignal,
                error instanceof Error ? error.message : String(error),
              );
            } catch {
              // The run may already be terminal (for example, after a denied decision).
            }
          }
          response.statusCode = 409;
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.pluginSearch && request.method === 'GET') {
        const results = await plugins.search(url.searchParams.get('q') ?? '');
        const hydrated = await Promise.all(results.map(async (item) => {
          if (!item.source.startsWith('artifact:')) return item;
          const { manifest, digest } = await fetchArtifactManifest(item.source);
          if (item.id && item.id !== manifest.id) throw new Error('Catalog capability id does not match its signed manifest.');
          return {
            ...item,
            id: manifest.id,
            version: manifest.version,
            permissions: manifest.permissions,
            artifactManifestDigest: digest,
          };
        }));
        response.end(JSON.stringify(hydrated));
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.pluginMcpConflicts && request.method === 'GET') {
        const source = url.searchParams.get('source');
        const expectedDigest = url.searchParams.get('manifestDigest');
        if (!source) throw new Error('能力来源不能为空。');
        const { manifest, digest } = await fetchArtifactManifest(source);
        assertExpectedManifest(digest, expectedDigest);
        response.end(JSON.stringify(await detectMcpOwnershipConflicts({
          yuanpuConnections: manifest.connections ?? [],
          agentRoot: home.agentPath,
          workspaceRoot: home.config.workingDirectory,
        })));
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.plugins && request.method === 'GET') {
        const installed = await plugins.list();
        const installedArtifacts = artifacts
          ? await Promise.all((await artifacts.list()).map(async (item) => {
            const active = item.versions[item.activeVersion]!;
            return {
              name: item.id,
              version: active.version,
              description: '自包含 Python MCP 能力包',
              source: active.manifestUrl ? `artifact:${active.manifestUrl}` : `artifact:${item.id}`,
              installPath: active.installPath,
              enabled: true,
              installedAt: active.installedAt,
              configurable: Boolean(active.configSchema),
              configStatus: active.configSchema
                ? artifactConfigValidation(
                    active.configSchema,
                    await readArtifactConfig(active.configSchema),
                  ).valid ? 'valid' as const : 'invalid' as const
                : 'unsupported' as const,
              kind: 'python-mcp' as const,
              activeVersion: item.activeVersion,
              availableVersions: Object.keys(item.versions).sort((left, right) => right.localeCompare(left)),
            };
          }))
          : [];
        response.end(JSON.stringify([...installed, ...installedArtifacts]));
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
        response.end(JSON.stringify(name === 'builtin.python.echo'
          ? await artifactConfigDocument(scope)
          : await plugins.getConfig(name, scope)));
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.pluginConfigValidate && request.method === 'POST') {
        const input = readConfigInput(await readJsonBody(request));
        let validation: PluginConfigValidation;
        if (input.name === 'builtin.python.echo') {
          const active = await artifacts?.active(input.name);
          validation = input.scope !== 'user'
            ? { valid: false, errors: ['Python 能力仅支持用户级配置。'] }
            : active?.configSchema
              ? artifactConfigValidation(active.configSchema, input.value)
              : { valid: false, errors: ['当前能力版本未声明可管理配置。'] };
        } else {
          validation = await plugins.validateConfig(input);
        }
        response.end(JSON.stringify(validation));
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.pluginConfigSave && request.method === 'POST') {
        const input = readConfigInput(await readJsonBody(request));
        let document: PluginConfigDocument;
        if (input.name === 'builtin.python.echo') {
          if (input.scope !== 'user') throw new Error('Python 能力仅支持用户级配置。');
          const active = await artifacts?.active(input.name);
          if (!active?.configSchema) throw new Error('当前能力版本未声明可管理配置。');
          const validation = artifactConfigValidation(active.configSchema, input.value);
          if (!validation.valid) throw new Error(`能力配置无效：${validation.errors.join('；')}`);
          await mkdir(dirname(pythonConfigFile), { recursive: true });
          const temporary = `${pythonConfigFile}.${randomUUID()}.tmp`;
          await writeFile(temporary, `${JSON.stringify(input.value, null, 2)}\n`, { mode: 0o600 });
          await rename(temporary, pythonConfigFile);
          document = await artifactConfigDocument(input.scope);
        } else {
          document = await plugins.saveConfig(input);
          agentExecutor.reset();
        }
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
        const scope = readConfigScope(body.scope);
        const document = body.name === 'builtin.python.echo'
          ? (await rm(pythonConfigFile, { force: true }), await artifactConfigDocument(scope))
          : await plugins.resetConfig(body.name, scope);
        if (body.name !== 'builtin.python.echo') agentExecutor.reset();
        response.end(JSON.stringify(document));
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.pluginInstall && request.method === 'POST') {
        const body = await readJsonBody(request) as { source?: unknown; artifactManifestDigest?: unknown };
        if (typeof body.source !== 'string' || !body.source.trim()) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: '插件来源不能为空。' }));
          return;
        }
        const source = body.source.trim();
        if (source.startsWith('artifact:')) {
          if (!artifacts) throw new Error('当前宿主没有配置能力制品信任根。');
          const { manifest, manifestUrl, digest } = await fetchArtifactManifest(source);
          assertExpectedManifest(digest, body.artifactManifestDigest);
          const installed = await artifacts.install(manifest, {
            manifestUrl,
            healthCheck: async (entrypoint, installPath) => {
              const { stdout } = await execFileAsync(entrypoint, ['--version'], {
                cwd: installPath,
                timeout: 20_000,
                env: {
                  PATH: dirname(entrypoint),
                  ...(process.platform === 'win32' && process.env.SYSTEMROOT
                    ? { SYSTEMROOT: process.env.SYSTEMROOT }
                    : {}),
                },
              });
              if (stdout.trim().replace(/^v/, '') !== manifest.version) {
                throw new Error(`能力健康检查版本不匹配：${stdout.trim()}`);
              }
            },
          });
          await activatePythonArtifact(installed.entrypoint, installed.installPath, installed.version);
          const installedItem = (await artifacts.list()).find((item) => item.id === manifest.id);
          response.end(JSON.stringify({
            name: manifest.id,
            version: manifest.version,
            description: '自包含 Python MCP 能力包',
            source,
            installPath: installed.installPath,
            enabled: true,
            installedAt: installed.installedAt,
            configurable: Boolean(manifest.configSchema),
            configStatus: manifest.configSchema ? 'optional' : 'unsupported',
            kind: 'python-mcp',
            activeVersion: installed.version,
            availableVersions: installedItem
              ? Object.keys(installedItem.versions).sort((left, right) => right.localeCompare(left))
              : [installed.version],
          }));
          return;
        }
        const plugin = await plugins.install(source);
        const pluginErrors = await inspectPlugin(plugin);
        if (pluginErrors.length > 0) {
          const message = pluginErrors.map((diagnostic) => diagnostic.error).join('\n');
          await plugins.markLoadError(plugin.name, message);
          agentExecutor.reset();
          response.statusCode = 422;
          response.end(JSON.stringify({
            error: `插件已安装但加载失败，已自动停用：${message}`,
          }));
          return;
        }
        agentExecutor.reset();
        response.end(JSON.stringify(plugin));
        return;
      }

      if (url.pathname === RUNTIME_ROUTES.pluginRollback && request.method === 'POST') {
        if (!artifacts) throw new Error('当前宿主没有配置能力制品信任根。');
        const body = await readJsonBody(request) as { name?: unknown; version?: unknown };
        if (typeof body.name !== 'string' || typeof body.version !== 'string') {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: '能力名称和回滚版本不能为空。' }));
          return;
        }
        const active = await artifacts.rollback(body.name, body.version);
        await activatePythonArtifact(active.entrypoint, active.installPath, active.version);
        const item = (await artifacts.list()).find((candidate) => candidate.id === body.name)!;
        response.end(JSON.stringify({
          name: item.id,
          version: active.version,
          description: '自包含 Python MCP 能力包',
          source: active.manifestUrl ? `artifact:${active.manifestUrl}` : `artifact:${item.id}`,
          installPath: active.installPath,
          enabled: true,
          installedAt: active.installedAt,
          configurable: Boolean(active.configSchema),
          configStatus: active.configSchema
            ? artifactConfigValidation(
                active.configSchema,
                await readArtifactConfig(active.configSchema),
              ).valid ? 'valid' : 'invalid'
            : 'unsupported',
          kind: 'python-mcp',
          activeVersion: active.version,
          availableVersions: Object.keys(item.versions).sort((left, right) => right.localeCompare(left)),
        }));
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
            agentExecutor.reset();
            response.statusCode = 422;
            response.end(JSON.stringify({
              error: `插件加载失败，已重新停用：${message}`,
            }));
            return;
          }
        }
        agentExecutor.reset();
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
        agentExecutor.reset();
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
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    cleanupPromise ??= cleanupRuntimeResources({
      closeChannels: () => closeWecomChannels(wecomChannels),
      closeScheduler: () => scheduler.close(),
      closeNotificationRouter: () => notificationRouter.close(),
      closeAgentService: () => agentService.close(),
      ...(pythonSource ? { closePythonSource: () => pythonSource!.close() } : {}),
      closeMetadata: () => metadata.close(),
    });
    return cleanupPromise;
  };
  server.on('close', () => {
    void cleanup().catch((error) => console.error(error));
  });

  let parentMonitor: ParentProcessMonitor | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shuttingDown = true;
    notificationRouter.close();
    if (shutdownPromise) return;
    const forcedExit = setTimeout(() => process.exit(1), 7_500);
    shutdownPromise = (async () => {
      parentMonitor?.dispose();
      const managedCleanup = cleanup().then(
        () => ({ status: 'fulfilled' as const }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      );
      let drained = false;
      const closeServer = new Promise<void>((resolveClose) => {
        try {
          server.close(() => {
            drained = true;
            resolveClose();
          });
        } catch {
          drained = true;
          resolveClose();
        }
      });
      const drainTimeout = new Promise<void>((resolveTimeout) => {
        const timeout = setTimeout(resolveTimeout, 5_000);
        timeout.unref();
      });
      await Promise.race([closeServer, drainTimeout]);
      if (!drained) server.closeAllConnections();
      const cleanupTimeout = new Promise<{ status: 'timed-out' }>((resolveTimeout) => {
        const timeout = setTimeout(() => resolveTimeout({ status: 'timed-out' }), 2_000);
        timeout.unref();
      });
      const cleanupResult = await Promise.race([managedCleanup, cleanupTimeout]);
      if (cleanupResult.status === 'rejected') throw cleanupResult.reason;
      if (cleanupResult.status === 'timed-out') {
        throw new Error('Runtime cleanup timed out.');
      }
    })();
    void shutdownPromise.then(
      () => {
        clearTimeout(forcedExit);
        process.exit(0);
      },
      (error) => {
        console.error(error);
        clearTimeout(forcedExit);
        process.exit(1);
      },
    );
  };

  parentMonitor = installParentProcessMonitor(parentPid, shutdown);
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
        notificationsEnabled: home.config.notifications?.enabled ?? true,
      }),
    );
  });
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
} else if (args.includes('--capability-lifecycle-smoke')) {
  const parentPidIndex = args.indexOf('--parent-pid');
  const parentPid = Number(args[parentPidIndex + 1]);
  void capabilityLifecycleSmoke(parentPid).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else if (args.includes('--sqlite-smoke')) {
  try {
    const pathIndex = args.indexOf('--sqlite-smoke');
    sqliteSmoke(args[pathIndex + 1]);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
} else if (args.includes('--scheduler-smoke')) {
  const pathIndex = args.indexOf('--scheduler-smoke');
  void schedulerSmoke(args[pathIndex + 1]).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const nameIndex = args.indexOf('--name');
  const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
  console.log(greeting(name || 'world'));
}
