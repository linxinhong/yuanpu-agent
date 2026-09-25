import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { CustomModelSettings, ModelApi, ModelCatalog, ModelSettings, SaveModelSettingsInput } from '@yuanpu-agent/protocol';
import type { YuanpuHome } from './index.js';

type JsonRecord = Record<string, unknown>;
type ModelsDocument = { providers: Record<string, JsonRecord> } & JsonRecord;

const modelApis: readonly ModelApi[] = [
  'openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai',
];
const providerSuggestions = ['openai', 'anthropic', 'google', 'deepseek', 'openrouter'];
const visibleCatalogProviders = new Set([
  'deepseek',
  'kimi-coding',
  'minimax', 'minimax-cn',
  'moonshotai', 'moonshotai-cn',
  'qwen-token-plan', 'qwen-token-plan-cn', 'qwen-token-plan-individual',
  'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp',
  'zai', 'zai-coding-cn',
  'openai', 'xai', 'openrouter', 'opencode', 'opencode-go',
]);
let builtinCatalog: Promise<{ runtime: ModelRuntime; models: ReturnType<ModelRuntime['getModels']> }> | undefined;

async function loadBuiltinCatalog() {
  builtinCatalog ??= ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false })
    .then((runtime) => ({ runtime, models: runtime.getModels() }));
  return builtinCatalog;
}

export async function getModelCatalog(provider?: string): Promise<ModelCatalog> {
  const catalog = await loadBuiltinCatalog();
  const groups = new Map<string, number>();
  for (const model of catalog.models) {
    if (!visibleCatalogProviders.has(model.provider)) continue;
    groups.set(model.provider, (groups.get(model.provider) ?? 0) + 1);
  }
  return {
    providers: [...groups].map(([id, modelCount]) => ({
      id, name: catalog.runtime.getProvider(id)?.name ?? id, modelCount,
    })).sort((a, b) => a.name.localeCompare(b.name)),
    models: provider && groups.has(provider) ? catalog.models.filter((model) => model.provider === provider).map((model) => ({
      id: model.id, name: model.name, api: model.api, baseUrl: model.baseUrl,
    })).sort((a, b) => a.name.localeCompare(b.name)) : [],
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readModels(path: string): Promise<ModelsDocument> {
  const value = await readJson(path);
  if (value === undefined) return { providers: {} };
  if (!isRecord(value) || !isRecord(value.providers)
    || Object.values(value.providers).some((provider) => !isRecord(provider))) {
    throw new Error('models.json 格式无效，请先修复该文件。');
  }
  return value as ModelsDocument;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function modelsPath(home: YuanpuHome): string {
  return join(home.appPath, 'models.json');
}

function authPath(home: YuanpuHome): string {
  return join(home.appPath, 'auth.json');
}

export async function getModelSettings(home: YuanpuHome): Promise<ModelSettings> {
  const models = await readModels(modelsPath(home));
  const credentials = await readJson(authPath(home));
  if (credentials !== undefined && !isRecord(credentials)) throw new Error('auth.json 格式无效，请先修复该文件。');
  const providerCredentials = Object.fromEntries(Object.entries(isRecord(credentials) ? credentials : {}).map(([id, entry]) => [
    id, isRecord(entry) && entry.type === 'oauth' ? 'oauth' : isRecord(entry) && entry.type === 'api_key' ? 'api_key' : 'none',
  ])) as ModelSettings['providerCredentials'];
  const providerNames = Object.fromEntries(Object.entries(models.providers).flatMap(([id, definition]) => (
    typeof definition.name === 'string' && definition.name.trim() ? [[id, definition.name.trim()]] : []
  )));
  const customProviders = Object.entries(models.providers).flatMap(([id, definition]) => {
    if (typeof definition.baseUrl !== 'string' || !definition.baseUrl) return [];
    return [{
      id,
      name: typeof definition.name === 'string' ? definition.name : '',
      baseUrl: definition.baseUrl,
      api: modelApis.includes(definition.api as ModelApi) ? definition.api as ModelApi : 'openai-completions' as const,
      apiKeyEnv: typeof definition.apiKey === 'string' && /^\$[A-Z_][A-Z0-9_]*$/.test(definition.apiKey)
        ? definition.apiKey.slice(1) : '',
      credential: providerCredentials[id] ?? 'none',
    }];
  });
  const credential = isRecord(credentials) ? credentials[home.config.provider] : undefined;
  const selectedProvider = models.providers[home.config.provider];
  const configuredModels = Array.isArray(selectedProvider?.models) ? selectedProvider.models : [];
  const customModels: CustomModelSettings[] = Object.entries(models.providers).flatMap(([providerId, definition]) => {
    const entries = Array.isArray(definition.models) ? definition.models : [];
    return entries.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.id !== 'string') return [];
      const endpoint = typeof entry.baseUrl === 'string' ? entry.baseUrl
        : typeof definition.baseUrl === 'string' ? definition.baseUrl : '';
      if (!endpoint) return [];
      const providerCredential = isRecord(credentials) ? credentials[providerId] : undefined;
      const keyReference = typeof definition.apiKey === 'string' ? definition.apiKey : '';
      return [{
        provider: providerId,
        model: entry.id,
        name: typeof entry.name === 'string' ? entry.name : entry.id,
        baseUrl: endpoint,
        api: modelApis.includes(definition.api as ModelApi) ? definition.api as ModelApi : 'openai-completions',
        apiKeyEnv: /^\$[A-Z_][A-Z0-9_]*$/.test(keyReference) ? keyReference.slice(1) : '',
        contextWindow: typeof entry.contextWindow === 'number' ? entry.contextWindow : 128_000,
        maxTokens: typeof entry.maxTokens === 'number' ? entry.maxTokens : 16_384,
        reasoning: entry.reasoning === true,
        inputTypes: Array.isArray(entry.input) && entry.input.includes('image') ? ['text', 'image'] : ['text'],
        ...(isRecord(entry.thinkingLevelMap) ? { thinkingLevelMap: entry.thinkingLevelMap as CustomModelSettings['thinkingLevelMap'] } : {}),
        credential: isRecord(providerCredential) && providerCredential.type === 'oauth' ? 'oauth'
          : isRecord(providerCredential) && providerCredential.type === 'api_key' ? 'api_key' : 'none',
        active: home.config.provider === providerId && home.config.model === entry.id,
        source: 'custom',
      } satisfies CustomModelSettings];
    });
  });
  if (!customModels.some((entry) => entry.active)) {
    customModels.push({
      provider: home.config.provider, model: home.config.model, name: home.config.model,
      baseUrl: '', api: 'openai-completions', apiKeyEnv: '',
      contextWindow: 128_000, maxTokens: 16_384, reasoning: false, inputTypes: ['text'],
      credential: isRecord(credential) && credential.type === 'oauth' ? 'oauth'
        : isRecord(credential) && credential.type === 'api_key' ? 'api_key' : 'none',
      active: true,
      source: 'catalog',
    });
  }
  return {
    provider: home.config.provider,
    model: home.config.model,
    baseUrl: typeof selectedProvider?.baseUrl === 'string' ? selectedProvider.baseUrl : '',
    api: modelApis.includes(selectedProvider?.api as ModelApi)
      ? selectedProvider?.api as ModelApi : 'openai-completions',
    apiKeyEnv: typeof selectedProvider?.apiKey === 'string' && /^\$[A-Z_][A-Z0-9_]*$/.test(selectedProvider.apiKey)
      ? selectedProvider.apiKey.slice(1) : '',
    credential: isRecord(credential) && credential.type === 'oauth' ? 'oauth'
      : isRecord(credential) && credential.type === 'api_key' ? 'api_key' : 'none',
    providerSuggestions: [...new Set([...providerSuggestions, home.config.provider, ...Object.keys(models.providers)])].sort(),
    modelSuggestions: [...new Set(configuredModels.flatMap((model) => (
      isRecord(model) && typeof model.id === 'string' ? [model.id] : []
    )))],
    customModels,
    customProviders,
    providerCredentials,
    providerNames,
  };
}

export async function deleteModelSettings(home: YuanpuHome, provider: string, model: string): Promise<ModelSettings> {
  if (typeof provider !== 'string' || typeof model !== 'string') throw new Error('模型标识无效。');
  const models = await readModels(modelsPath(home));
  const definition = models.providers[provider];
  const entries = Array.isArray(definition?.models) ? definition.models : [];
  const isCustom = entries.some((entry) => isRecord(entry) && entry.id === model);
  if (!isCustom) throw new Error('自定义模型不存在。');
  const remaining = entries.filter((entry) => !isRecord(entry) || entry.id !== model);
  const removingProvider = remaining.length === 0;
  if (home.config.provider === provider && home.config.model === model) {
    const nextModel = remaining.find((entry) => isRecord(entry) && typeof entry.id === 'string');
    const alternative = Object.entries(models.providers).flatMap(([id, candidate]) => (
      id === provider ? [] : (Array.isArray(candidate.models) ? candidate.models : [])
        .filter((entry): entry is JsonRecord => isRecord(entry) && typeof entry.id === 'string')
        .map((entry) => ({ provider: id, model: entry.id as string }))
    ))[0];
    const selection = isRecord(nextModel)
      ? { provider, model: nextModel.id as string }
      : alternative ?? { provider: 'openai', model: 'gpt-5.6-luna' };
    const nextConfig = { ...home.config, ...selection };
    await writeJson(home.configPath, nextConfig);
    home.config = nextConfig;
  }
  if (removingProvider) {
    const credentials = await readJson(authPath(home));
    if (credentials !== undefined && !isRecord(credentials)) throw new Error('auth.json 格式无效，请先修复该文件。');
    const stored = isRecord(credentials) ? credentials[provider] : undefined;
    if (isRecord(stored) && stored.type === 'api_key') {
      const runtime = await ModelRuntime.create({
        authPath: authPath(home), modelsPath: modelsPath(home),
        modelsStorePath: join(home.agentPath, 'models-store.json'), allowModelNetwork: false,
      });
      await runtime.logout(provider);
    }
  }
  if (remaining.length) models.providers[provider] = { ...definition, models: remaining };
  else delete models.providers[provider];
  await writeJson(modelsPath(home), models);
  return getModelSettings(home);
}

export async function saveModelSettings(home: YuanpuHome, input: SaveModelSettingsInput): Promise<ModelSettings> {
  const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const apiKeyEnv = typeof input.apiKeyEnv === 'string' ? input.apiKeyEnv.trim() : '';
  const providerName = typeof input.providerName === 'string' ? input.providerName.trim() : undefined;
  const providerOnly = !model && Boolean(baseUrl) && input.activate === false;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(provider)) throw new Error('服务商标识只能包含字母、数字、点、下划线和短横线。');
  if ((!model && !providerOnly) || model.length > 200) throw new Error('请输入有效的模型 ID。');
  if (!modelApis.includes(input.api)) throw new Error('模型协议不受支持。');
  if (apiKeyEnv && !/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv)) throw new Error('环境变量名格式无效。');
  if (providerName !== undefined && providerName.length > 80) throw new Error('供应商中文名称不能超过 80 个字符。');
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 16_384)) {
    throw new Error('API Key 不能为空且不能超过 16384 字符。');
  }
  if (input.apiKey && input.removeApiKey) throw new Error('不能同时设置和删除 API Key。');
  if (input.contextWindow !== undefined && (!Number.isSafeInteger(input.contextWindow) || input.contextWindow < 1)) throw new Error('上下文窗口必须是正整数。');
  if (input.maxTokens !== undefined && (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1)) throw new Error('最大输出 Token 必须是正整数。');
  if (input.inputTypes !== undefined && (!Array.isArray(input.inputTypes) || !input.inputTypes.includes('text')
    || input.inputTypes.some((type) => type !== 'text' && type !== 'image'))) throw new Error('当前只支持文本和图片输入。');
  if (input.reasoning !== undefined && typeof input.reasoning !== 'boolean') throw new Error('推理能力配置无效。');
  if (input.thinkingLevelMap !== undefined && !isRecord(input.thinkingLevelMap)) throw new Error('推理等级映射格式无效。');
  if (baseUrl) {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new Error('服务商地址不是有效 URL。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('服务商地址必须为 HTTP(S) URL，且不能包含账户或密码。');
    }
  }

  const models = await readModels(modelsPath(home));
  const existing = models.providers[provider];
  if (baseUrl) {
    const entries = Array.isArray(existing?.models) ? [...existing.models] : [];
    if (model) {
      const index = entries.findIndex((entry) => isRecord(entry) && entry.id === model);
      const previous = index >= 0 && isRecord(entries[index]) ? entries[index] : {};
      const next = {
        ...previous,
        id: model,
        name: typeof previous.name === 'string' ? previous.name : model,
        reasoning: input.reasoning ?? previous.reasoning ?? false,
        input: input.inputTypes ?? previous.input ?? ['text'],
        contextWindow: input.contextWindow ?? previous.contextWindow ?? 128_000,
        maxTokens: input.maxTokens ?? previous.maxTokens ?? 16_384,
        ...(input.thinkingLevelMap !== undefined ? { thinkingLevelMap: input.thinkingLevelMap } : {}),
      };
      if (index >= 0) entries[index] = next;
      else entries.push(next);
    }
    models.providers[provider] = {
      ...existing,
      ...(providerName !== undefined ? { name: providerName } : {}),
      baseUrl,
      api: input.api,
      ...(apiKeyEnv && !existing?.apiKey
        ? { apiKey: `$${apiKeyEnv}` } : {}),
      models: entries,
    };
  }

  const candidatePath = `${modelsPath(home)}.${randomUUID()}.validation`;
  let runtime: ModelRuntime;
  try {
    await writeFile(candidatePath, JSON.stringify(models), { mode: 0o600, flag: 'wx' });
    runtime = await ModelRuntime.create({
      authPath: authPath(home), modelsPath: candidatePath,
      modelsStorePath: join(home.agentPath, 'models-store.json'), allowModelNetwork: false,
    });
    if (runtime.getError()) throw new Error(`模型配置无效：${runtime.getError()}`);
    if (!providerOnly && !runtime.getModel(provider, model)) throw new Error(`找不到模型 ${provider}/${model}。请填写服务商地址以添加自定义模型。`);
  } finally {
    await rm(candidatePath, { force: true });
  }

  const currentCredential = await readJson(authPath(home));
  if (currentCredential !== undefined && !isRecord(currentCredential)) throw new Error('auth.json 格式无效，请先修复该文件。');
  const stored = isRecord(currentCredential) ? currentCredential[provider] : undefined;
  if ((input.apiKey || input.removeApiKey) && isRecord(stored) && stored.type === 'oauth') {
    throw new Error('当前服务商使用 OAuth；请先在 Pi 中解除 OAuth 登录。');
  }

  if (baseUrl) await writeJson(modelsPath(home), models);
  if (input.apiKey || input.removeApiKey) {
    // Pi's credential store locks auth.json and preserves unrelated API key and OAuth entries.
    if (input.removeApiKey) await runtime.logout(provider);
    else await runtime.login(provider, 'api_key', {
      prompt: async (prompt) => {
        if (prompt.type !== 'secret') throw new Error('此服务商的 API Key 配置需要额外输入；请通过 Pi 登录流程完成。');
        return input.apiKey!.trim();
      },
      notify: () => undefined,
    });
  }
  if (input.activate !== false || !baseUrl) {
    const config = await readJson(home.configPath);
    if (!isRecord(config)) throw new Error('应用配置格式无效，请先修复 config.json。');
    const nextConfig: JsonRecord = { ...config };
    if (input.activate !== false) {
      nextConfig.provider = provider;
      nextConfig.model = model;
    }
    delete nextConfig.baseUrl;
    delete nextConfig.api;
    delete nextConfig.apiKeyEnv;
    delete nextConfig.modelSelections;
    await writeJson(home.configPath, nextConfig);
    home.config = nextConfig as unknown as YuanpuHome['config'];
  }
  return getModelSettings(home);
}
