import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { deleteModelSettings, ensureYuanpuHome, getModelCatalog, getModelSettings, saveModelSettings } from '../dist/index.mjs';

test('model settings migrate a legacy custom endpoint and preserve unrelated credentials', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-model-settings-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = await ensureYuanpuHome(root);
  home.config = {
    ...home.config, provider: 'custom', model: 'old-model', apiKeyEnv: 'OLD_KEY',
    baseUrl: 'https://legacy.example/v1', api: 'openai-completions',
  };
  await writeFile(home.configPath, JSON.stringify(home.config));
  await writeFile(join(home.agentPath, 'auth.json'), JSON.stringify({
    other: { type: 'api_key', key: 'keep-me' },
  }));

  const migrated = await ensureYuanpuHome(root);
  assert.equal((await getModelSettings(migrated)).baseUrl, 'https://legacy.example/v1');
  await assert.rejects(access(join(home.agentPath, 'auth.json')), { code: 'ENOENT' });
  const saved = await saveModelSettings(home, {
    provider: 'custom', model: 'new-model', baseUrl: 'https://api.example/v1',
    api: 'openai-completions', apiKeyEnv: 'CUSTOM_KEY', apiKey: 'secret-value', providerName: '自定义服务',
  });
  assert.equal(saved.provider, 'custom');
  assert.equal(saved.model, 'new-model');
  assert.equal(saved.credential, 'api_key');
  assert.equal(saved.providerNames.custom, '自定义服务');
  assert.equal(JSON.stringify(saved).includes('secret-value'), false);
  const config = JSON.parse(await readFile(home.configPath, 'utf8'));
  const models = JSON.parse(await readFile(join(home.appPath, 'models.json'), 'utf8'));
  const auth = JSON.parse(await readFile(join(home.appPath, 'auth.json'), 'utf8'));
  assert.equal(config.baseUrl, undefined);
  assert.equal(config.apiKeyEnv, undefined);
  assert.equal(config.provider, 'custom');
  assert.equal(config.model, 'new-model');
  assert.equal(models.providers.custom.baseUrl, 'https://api.example/v1');
  assert.equal(models.providers.custom.name, '自定义服务');
  assert.ok(models.providers.custom.models.some((entry) => entry.id === 'new-model'));
  assert.equal(auth.custom.key, 'secret-value');
  assert.equal(auth.other.key, 'keep-me');

  const cleared = await saveModelSettings(home, {
    provider: 'custom', model: 'new-model', baseUrl: 'https://api.example/v1',
    api: 'openai-completions', apiKeyEnv: 'CUSTOM_KEY', removeApiKey: true,
  });
  assert.equal(cleared.credential, 'none');
  assert.equal(cleared.providerNames.custom, '自定义服务');
  assert.equal(JSON.parse(await readFile(join(home.appPath, 'auth.json'), 'utf8')).other.key, 'keep-me');
});

test('invalid model settings do not replace selected configuration', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-model-invalid-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = await ensureYuanpuHome(root);
  await assert.rejects(saveModelSettings(home, {
    provider: 'unknown-provider', model: 'missing', baseUrl: '',
    api: 'openai-completions', apiKeyEnv: '',
  }), /找不到模型/);
  assert.equal(JSON.parse(await readFile(home.configPath, 'utf8')).provider, 'openai');
});

test('a custom provider is saved before its models and model metadata stays at model level', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-provider-first-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = await ensureYuanpuHome(root);
  const provider = await saveModelSettings(home, {
    provider: 'demo', providerName: '演示服务', model: '', baseUrl: 'https://example.test/v1',
    api: 'openai-completions', apiKeyEnv: '', activate: false, apiKey: 'fixture-only',
  });
  assert.deepEqual([provider.provider, provider.model], ['openai', 'gpt-5.6-luna']);
  assert.equal(provider.customProviders.find((entry) => entry.id === 'demo')?.name, '演示服务');
  assert.equal(provider.customModels.some((entry) => entry.provider === 'demo'), false);
  assert.equal(provider.providerCredentials.demo, 'api_key');

  const saved = await saveModelSettings(home, {
    provider: 'demo', model: 'demo-model', baseUrl: 'https://example.test/v1',
    api: 'openai-completions', apiKeyEnv: '', activate: false,
    contextWindow: 64_000, maxTokens: 8_000, inputTypes: ['text', 'image'], reasoning: true,
  });
  const model = saved.customModels.find((entry) => entry.provider === 'demo' && entry.model === 'demo-model');
  assert.equal(model?.contextWindow, 64_000);
  assert.equal(model?.maxTokens, 8_000);
  assert.deepEqual(model?.inputTypes, ['text', 'image']);
  assert.equal(model?.reasoning, true);
  const document = JSON.parse(await readFile(join(home.appPath, 'models.json'), 'utf8'));
  assert.equal(document.providers.demo.name, '演示服务');
  assert.equal(document.providers.demo.models[0].contextWindow, 64_000);
  assert.equal(document.providers.demo.models[0].maxTokens, 8_000);
  assert.equal(document.providers.demo.baseUrl, 'https://example.test/v1');
});

test('built-in Pi catalog supplies model defaults and saves only the selection and credential', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-model-catalog-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = await ensureYuanpuHome(root);
  const catalog = await getModelCatalog('deepseek');
  assert.ok(catalog.providers.some((provider) => provider.id === 'deepseek'));
  for (const allowed of ['openai', 'xai', 'openrouter', 'opencode', 'opencode-go']) {
    assert.ok(catalog.providers.some((provider) => provider.id === allowed), allowed);
  }
  for (const hidden of ['ant-ling', 'anthropic', 'google', 'meta', 'together']) {
    assert.equal(catalog.providers.some((provider) => provider.id === hidden), false, hidden);
  }
  assert.ok(catalog.models.length > 0);
  const selected = catalog.models[0];
  assert.ok(selected.baseUrl.startsWith('https://'));

  const saved = await saveModelSettings(home, {
    provider: 'deepseek', model: selected.id, baseUrl: '',
    api: 'openai-completions', apiKeyEnv: '', apiKey: 'test-only-key',
  });
  assert.equal(saved.provider, 'deepseek');
  assert.equal(saved.credential, 'api_key');
  assert.ok(saved.customModels.some((entry) => entry.source === 'catalog' && entry.model === selected.id));
  assert.equal(JSON.stringify(saved).includes('test-only-key'), false);
  const config = JSON.parse(await readFile(home.configPath, 'utf8'));
  assert.equal(config.modelSelections, undefined);
  assert.equal(config.baseUrl, undefined);
  await assert.rejects(access(join(home.appPath, 'models.json')), { code: 'ENOENT' });
  const auth = JSON.parse(await readFile(join(home.appPath, 'auth.json'), 'utf8'));
  assert.equal(auth.deepseek.key, 'test-only-key');

  await saveModelSettings(home, {
    provider: 'openai', model: 'gpt-5.6-luna', baseUrl: '',
    api: 'openai-completions', apiKeyEnv: '',
  });
  assert.equal((await getModelSettings(home)).customModels.some((entry) => entry.provider === 'deepseek'), false);
  await assert.rejects(deleteModelSettings(home, 'deepseek', selected.id), /自定义模型不存在/);
  assert.equal(JSON.parse(await readFile(join(home.appPath, 'auth.json'), 'utf8')).deepseek.key, 'test-only-key');
});

test('the last API key can be removed while keeping the selected model', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-last-api-key-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = await ensureYuanpuHome(root);
  const model = (await getModelCatalog('deepseek')).models[0].id;
  await saveModelSettings(home, {
    provider: 'deepseek', model, baseUrl: '', api: 'openai-completions', apiKeyEnv: '', apiKey: 'fixture-only',
  });
  const saved = await saveModelSettings(home, {
    provider: 'deepseek', model, baseUrl: '', api: 'openai-completions', apiKeyEnv: '', removeApiKey: true,
  });
  assert.equal(saved.credential, 'none');
  assert.equal(saved.model, model);
  assert.deepEqual(JSON.parse(await readFile(join(home.appPath, 'auth.json'), 'utf8')), {});
});

test('deleting the active final custom model removes its API key and selects a fallback', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-last-custom-model-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = await ensureYuanpuHome(root);
  await saveModelSettings(home, {
    provider: 'only-custom', model: 'only-model', baseUrl: 'https://example.test/v1',
    api: 'openai-completions', apiKeyEnv: '', apiKey: 'fixture-only',
  });
  const after = await deleteModelSettings(home, 'only-custom', 'only-model');
  assert.deepEqual([after.provider, after.model], ['openai', 'gpt-5.6-luna']);
  assert.equal(after.customModels.some((entry) => entry.provider === 'only-custom'), false);
  assert.deepEqual(JSON.parse(await readFile(join(home.appPath, 'auth.json'), 'utf8')), {});
  assert.deepEqual(JSON.parse(await readFile(join(home.appPath, 'models.json'), 'utf8')).providers, {});
});
