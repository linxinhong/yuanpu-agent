import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CustomModelSettings, CustomProviderSettings, ModelApi, ModelCatalog, ModelSettings, SaveModelSettingsInput } from '@yuanpu-agent/protocol';
import deepseekIcon from '../assets/provider-icons/model-provider-deepseek.png';
import kimiIcon from '../assets/provider-icons/model-provider-moonshot-kimi.png';
import minimaxIcon from '../assets/provider-icons/model-provider-minimax.png';
import alibabaIcon from '../assets/provider-icons/model-provider-alibaba-cloud.png';
import xiaomiIcon from '../assets/provider-icons/model-provider-xiaomi-mimo.png';
import openaiIcon from '../assets/provider-icons/model-provider-openai.png';
import xaiIcon from '../assets/provider-icons/model-provider-xai.png';
import zaiIcon from '../assets/provider-icons/model-provider-zai-app.png';
import openrouterIcon from '../assets/provider-icons/model-provider-openrouter-light.png';
import opencodeIcon from '../assets/provider-icons/model-provider-opencode-light.png';

type Editor = { kind: 'provider' } | { kind: 'model'; provider: CustomProviderSettings; item?: CustomModelSettings };

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadCatalog(provider?: string) {
  if (typeof window.yuanpu?.getModelCatalog !== 'function') {
    throw new Error('桌面应用需要重新启动，才能加载模型列表。');
  }
  return window.yuanpu.getModelCatalog(provider);
}

function ModelEditor({ editor, onClose, onSaved }: {
  editor: Editor;
  onClose(): void;
  onSaved(settings: ModelSettings, provider: string): void;
}) {
  const item = editor.kind === 'model' ? editor.item : undefined;
  const [providerId, setProviderId] = useState('');
  const [providerName, setProviderName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [api, setApi] = useState<ModelApi>('openai-completions');
  const [apiKeyEnv, setApiKeyEnv] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelId, setModelId] = useState(item?.model ?? '');
  const [contextWindow, setContextWindow] = useState(String(item?.contextWindow ?? 128_000));
  const [maxTokens, setMaxTokens] = useState(String(item?.maxTokens ?? 16_384));
  const [imageInput, setImageInput] = useState(item?.inputTypes.includes('image') ?? false);
  const [reasoning, setReasoning] = useState(item?.reasoning ?? false);
  const [thinkingMap, setThinkingMap] = useState(item?.thinkingLevelMap ? JSON.stringify(item.thinkingLevelMap, null, 2) : '');
  const [validationError, setValidationError] = useState('');
  const save = useMutation({ mutationFn: (input: SaveModelSettingsInput) => window.yuanpu!.saveModelSettings(input),
    onSuccess: (result, input) => onSaved(result, input.provider),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setValidationError('');
    if (editor.kind === 'provider') {
      save.mutate({ provider: providerId, providerName, model: '', baseUrl, api, apiKeyEnv,
        activate: false, ...(apiKey ? { apiKey } : {}),
      });
      return;
    }
    const context = Number(contextWindow);
    const output = Number(maxTokens);
    if (!Number.isSafeInteger(context) || context < 1 || !Number.isSafeInteger(output) || output < 1) {
      setValidationError('上下文窗口和最大输出 Token 必须是正整数。');
      return;
    }
    let thinkingLevelMap: SaveModelSettingsInput['thinkingLevelMap'];
    if (thinkingMap.trim()) {
      try {
        const parsed: unknown = JSON.parse(thinkingMap);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
        thinkingLevelMap = parsed as SaveModelSettingsInput['thinkingLevelMap'];
      } catch { setValidationError('推理等级映射必须是 JSON 对象。'); return; }
    } else if (item?.thinkingLevelMap) thinkingLevelMap = {};
    save.mutate({ provider: editor.provider.id, model: modelId, baseUrl: editor.provider.baseUrl,
      api: editor.provider.api, apiKeyEnv: editor.provider.apiKeyEnv, activate: false,
      contextWindow: context, maxTokens: output, reasoning,
      inputTypes: imageInput ? ['text', 'image'] : ['text'],
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    });
  };
  const title = editor.kind === 'provider' ? '创建自定义供应商' : item ? '编辑模型' : '添加模型';
  return <div className="model-editor-backdrop">
    <section className="model-editor" role="dialog" aria-modal="true" aria-label={title}>
      <div className="model-editor-header"><h2>{title}</h2><button type="button" className="model-editor-close" aria-label="关闭" onClick={onClose}>×</button></div>
      <form onSubmit={submit}>
        <div className="model-editor-fields">
          {editor.kind === 'provider' ? <>
            <label>供应商 ID <input value={providerId} onChange={(event) => setProviderId(event.target.value)} placeholder="例如 my-provider" maxLength={80} required spellCheck={false} /></label>
            <label>中文名称 <span className="model-editor-quiet">可选</span><input value={providerName} onChange={(event) => setProviderName(event.target.value)} placeholder="例如 自定义模型服务" maxLength={80} /></label>
            <label>Base URL <input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" required spellCheck={false} /></label>
            <label>API 格式 <select value={api} onChange={(event) => setApi(event.target.value as ModelApi)}>{supportedApis.map((value) => <option key={value} value={value}>{apiLabels[value]}</option>)}</select></label>
            <label>API Key <span className="model-editor-quiet">可留空，改用环境变量</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="输入 API Key" autoComplete="new-password" /></label>
            <label>密钥环境变量 <span className="model-editor-quiet">可选</span><input value={apiKeyEnv} onChange={(event) => setApiKeyEnv(event.target.value)} placeholder="例如 PROVIDER_API_KEY" spellCheck={false} /></label>
          </> : <>
            <label>模型 ID <input value={modelId} onChange={(event) => setModelId(event.target.value)} readOnly={Boolean(item)} placeholder="模型 ID" required maxLength={200} spellCheck={false} /></label>
            <label>上下文窗口 <input type="number" min="1" step="1" value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} required /></label>
            <label>最大输出 Token <input type="number" min="1" step="1" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} required /></label>
            <details className="model-editor-advanced" open><summary>高级配置</summary>
              <div className="model-editor-advanced-body"><div><strong>输入类型</strong><div className="model-editor-options"><span className="model-editor-fixed-option">✓ 文本</span>
                <label><input type="checkbox" checked={imageInput} onChange={(event) => setImageInput(event.target.checked)} /> 图片</label></div></div>
                <div><strong>模型能力</strong><div className="model-editor-options"><label><input type="checkbox" checked={reasoning} onChange={(event) => setReasoning(event.target.checked)} /> 推理</label></div></div>
                {reasoning && <label>推理等级映射 <span className="model-editor-quiet">可选，JSON 对象</span><textarea value={thinkingMap} onChange={(event) => setThinkingMap(event.target.value)} placeholder={'{"off": false, "high": true}'} spellCheck={false} /></label>}
              </div>
            </details>
          </>}
        </div>
        {validationError && <p className="model-editor-error" role="alert">{validationError}</p>}
        {save.error && <p className="model-editor-error" role="alert">保存失败：{formatError(save.error)}</p>}
        <div className="model-editor-actions"><button type="button" onClick={onClose}>取消</button>
          <button type="submit" disabled={save.isPending || (editor.kind === 'provider' ? !providerId.trim() || !baseUrl.trim() : !modelId.trim())}>{save.isPending ? '保存中…' : '保存'}</button></div>
      </form>
    </section>
  </div>;
}

const supportedApis: ModelApi[] = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];
const apiLabels: Record<ModelApi, string> = {
  'openai-completions': 'OpenAI Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'google-generative-ai': 'Google Generative AI',
};

function isModelApi(value: string): value is ModelApi {
  return supportedApis.some((api) => api === value);
}

function providerIconSource(id: string): string | undefined {
  if (id === 'deepseek') return deepseekIcon;
  if (id === 'kimi-coding' || id.startsWith('moonshotai')) return kimiIcon;
  if (id.startsWith('minimax')) return minimaxIcon;
  if (id.startsWith('qwen-')) return alibabaIcon;
  if (id.startsWith('xiaomi')) return xiaomiIcon;
  if (id === 'openai') return openaiIcon;
  if (id === 'xai') return xaiIcon;
  if (id.startsWith('zai')) return zaiIcon;
  if (id === 'openrouter') return openrouterIcon;
  if (id.startsWith('opencode')) return opencodeIcon;
  return undefined;
}

function providerChineseName(id: string, settings?: ModelSettings): string {
  const configured = settings?.providerNames?.[id];
  if (configured) return configured;
  if (id === 'deepseek') return '深度求索';
  if (id === 'kimi-coding' || id.startsWith('moonshotai')) return '月之暗面';
  if (id.startsWith('minimax')) return '稀宇科技';
  if (id.startsWith('qwen-')) return '阿里云百炼';
  if (id.startsWith('xiaomi')) return '小米 MiMo';
  if (id.startsWith('zai')) return '智谱';
  return '';
}

function ProviderIcon({ id }: { id: string }) {
  const source = providerIconSource(id);
  return source ? <img className="model-provider-logo" src={source} alt="" aria-hidden="true" />
    : <span className="model-provider-logo model-provider-logo-fallback" aria-hidden="true">{id.slice(0, 1).toUpperCase()}</span>;
}

function ProviderPicker({ providers, onSelect, onCustom, onBack }: {
  providers: ModelCatalog['providers'];
  onSelect(provider: string): void;
  onCustom(): void;
  onBack(): void;
}) {
  return <div className="model-provider-picker">
    <div className="model-provider-picker-title"><button type="button" onClick={onBack} aria-label="返回供应商详情">←</button><h3>添加供应商</h3></div>
    <div className="model-provider-picker-grid"><button type="button" onClick={onCustom}>
      <span className="model-provider-card-icon custom" aria-hidden="true">＋</span><span>创建自定义供应商</span><span className="model-provider-card-arrow" aria-hidden="true">›</span>
    </button></div>
    <h4>模型目录</h4><div className="model-provider-picker-grid">
      {providers.map((item) => <button key={item.id} type="button" onClick={() => onSelect(item.id)}>
        <ProviderIcon id={item.id} />
        <span className="model-provider-card-name"><strong>{providerChineseName(item.id) || item.name}</strong>{providerChineseName(item.id) && <small>{item.name}</small>}</span>
        <span className="model-provider-card-arrow" aria-hidden="true">›</span>
      </button>)}
    </div>
  </div>;
}

function ProviderDetails({ provider, settings, onSettings, onEdit, onError, onNotice, onBack }: {
  provider: string;
  settings: ModelSettings;
  onSettings(result: ModelSettings): void;
  onEdit(editor: Editor): void;
  onError(message: string): void;
  onNotice(message: string): void;
  onBack?(): void;
}) {
  const custom = settings.customModels.filter((item) => item.provider === provider && item.source === 'custom');
  const customProvider = settings.customProviders?.find((item) => item.id === provider);
  const isCustom = Boolean(customProvider);
  const catalog = useQuery({ queryKey: ['settings', 'model-catalog', provider], queryFn: () => loadCatalog(provider), enabled: !isCustom });
  const providerEnglishName = isCustom ? provider : catalog.data?.providers.find((item) => item.id === provider)?.name ?? provider;
  const catalogModels = (catalog.data?.models ?? []).map((entry) => ({
    provider, model: entry.id, name: entry.name, baseUrl: '', api: entry.api,
    apiKeyEnv: '', credential: settings.providerCredentials?.[provider] ?? 'none',
    active: settings.provider === provider && settings.model === entry.id,
    source: 'catalog' as const,
  }));
  const models = isCustom ? custom : catalogModels;
  const first = models[0];
  const endpoint = isCustom ? customProvider?.baseUrl ?? '' : catalog.data?.models[0]?.baseUrl || '';
  const modelApi = isCustom ? customProvider?.api ?? 'openai-completions' : catalog.data?.models[0]?.api ?? 'openai-completions';
  const credential = settings.providerCredentials?.[provider] ?? (provider === settings.provider ? settings.credential : 'none');
  const [baseUrl, setBaseUrl] = useState(endpoint);
  const [providerName, setProviderName] = useState(settings.providerNames?.[provider] ?? '');
  const [api, setApi] = useState<ModelApi>(isModelApi(modelApi) ? modelApi : 'openai-completions');
  const [apiKey, setApiKey] = useState('');
  const [removeApiKey, setRemoveApiKey] = useState(false);
  const [search, setSearch] = useState('');
  const [showKey, setShowKey] = useState(false);
  const saveProvider = useMutation({ mutationFn: (input: SaveModelSettingsInput) => window.yuanpu!.saveModelSettings(input),
    onSuccess: (result) => { onSettings(result); setApiKey(''); setRemoveApiKey(false); onError(''); onNotice('供应商配置已保存'); },
    onError: (error) => onError(formatError(error)),
  });
  const activate = useMutation({ mutationFn: (item: typeof models[number]) => window.yuanpu!.saveModelSettings({
    provider, model: item.model, baseUrl: isCustom ? baseUrl : '', api: isCustom ? api : item.api as ModelApi,
    apiKeyEnv: isCustom ? customProvider?.apiKeyEnv ?? '' : '',
  }), onSuccess: (result) => { onSettings(result); onError(''); onNotice('已切换，下一条消息生效'); },
    onError: (error) => onError(formatError(error)),
  });
  const remove = useMutation({ mutationFn: (item: CustomModelSettings) => window.yuanpu!.deleteModelSettings(provider, item.model),
    onSuccess: (result) => { onSettings(result); onError(''); onNotice('模型已删除'); },
    onError: (error) => onError(formatError(error)),
  });
  const dirty = (isCustom && (baseUrl !== endpoint || api !== modelApi || providerName !== (settings.providerNames?.[provider] ?? ''))) || Boolean(apiKey || removeApiKey);
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if ((!isCustom && !first) || !isModelApi(isCustom ? api : first!.api)) return;
    saveProvider.mutate({ provider, model: isCustom ? '' : first!.model, baseUrl: isCustom ? baseUrl : '',
      api: isCustom ? api : first!.api as ModelApi, apiKeyEnv: isCustom ? customProvider?.apiKeyEnv ?? '' : '', activate: false,
      ...(isCustom ? { providerName } : {}),
      ...(apiKey ? { apiKey } : {}), ...(removeApiKey ? { removeApiKey: true } : {}),
    });
  };
  const filtered = models.filter((item) => `${item.name} ${item.model}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="model-provider-detail">
    {onBack && <button type="button" className="model-provider-back" onClick={onBack}>← 返回供应商目录</button>}
    <div className="model-provider-title"><ProviderIcon id={provider} /><div><h3>{providerChineseName(provider, settings) || providerEnglishName}</h3><p>{providerChineseName(provider, settings) ? providerEnglishName : (isCustom ? '自定义供应商' : '模型目录')}</p></div>
      {settings.provider === provider && <span className="model-provider-current">当前使用</span>}</div>
    <form className="model-provider-form" onSubmit={save}>
      {isCustom && <label>中文名称 <input value={providerName} onChange={(event) => setProviderName(event.target.value)} maxLength={80} placeholder="可选" /></label>}
      <label>Base URL <input value={isCustom ? baseUrl : endpoint} onChange={(event) => setBaseUrl(event.target.value)} readOnly={!isCustom}
        placeholder={catalog.isLoading ? '正在读取…' : '暂无接口地址'} spellCheck={false} /></label>
      <label>API 格式 <select value={isCustom ? api : isModelApi(modelApi) ? modelApi : 'openai-completions'} onChange={(event) => setApi(event.target.value as ModelApi)} disabled={!isCustom}>
        {supportedApis.map((value) => <option key={value} value={value}>{apiLabels[value]}</option>)}</select></label>
      <label>API Key <span className="model-provider-key-field"><input type={showKey ? 'text' : 'password'} value={apiKey}
        onChange={(event) => { setApiKey(event.target.value); setRemoveApiKey(false); }} disabled={credential === 'oauth' || removeApiKey}
        placeholder={credential === 'api_key' ? '已保存；输入新 Key 可替换' : credential === 'oauth' ? 'OAuth 已连接' : '输入 API Key，或使用环境变量'} autoComplete="new-password" />
        <button type="button" onClick={() => setShowKey((value) => !value)} disabled={!apiKey} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} title={showKey ? '隐藏 API Key' : '显示 API Key'}>{showKey ? '隐藏' : '显示'}</button></span></label>
      <div className="model-provider-form-footer">
        {credential === 'api_key' && <label className="model-provider-remove-key"><input type="checkbox" checked={removeApiKey} onChange={(event) => { setRemoveApiKey(event.target.checked); setApiKey(''); }} />清除已保存的 API Key</label>}
        <button type="submit" disabled={!dirty || saveProvider.isPending || (!isCustom && !first) || (isCustom && !baseUrl.trim())}>{saveProvider.isPending ? '保存中…' : '保存配置'}</button>
      </div>
    </form>
    <div className="model-provider-models-heading"><div><h4>模型列表</h4><p>{isCustom ? '此供应商的自定义模型' : '从目录选择当前使用的模型'}</p></div>
      {customProvider && <button type="button" onClick={() => onEdit({ kind: 'model', provider: customProvider })}>＋ 添加模型</button>}</div>
    {models.length > 8 && <input className="model-provider-search" aria-label="搜索模型" placeholder="搜索模型" value={search} onChange={(event) => setSearch(event.target.value)} />}
    {catalog.isLoading && !isCustom && <p>正在读取模型目录…</p>}
    {catalog.error && !isCustom && <p role="alert">模型目录读取失败：{formatError(catalog.error)}</p>}
    <div className="model-provider-model-list">
      {filtered.map((item) => <div className="model-provider-model-row" key={item.model}>
        <ProviderIcon id={provider} /><div className="model-provider-model-name"><strong>{item.name}</strong>{item.model !== item.name && <span>{item.model}</span>}</div>
        {item.active && <span className="model-provider-active">当前使用</span>}
        {customProvider && <button type="button" title="编辑模型" aria-label={`编辑 ${item.name}`} onClick={() => onEdit({ kind: 'model', provider: customProvider, item: item as CustomModelSettings })}>编辑</button>}
        {!item.active && <button type="button" title="设为当前" disabled={activate.isPending || !isModelApi(item.api)} onClick={() => activate.mutate(item)}>设为当前</button>}
        {isCustom && <button type="button" title="删除模型" aria-label={`删除 ${item.name}`} disabled={remove.isPending} onClick={() => {
          const keyNote = item.credential === 'api_key' && custom.length === 1 ? '已保存的 API Key 也会删除。' : '';
          if (window.confirm(`删除模型 ${item.name}？${keyNote}`)) remove.mutate(item as CustomModelSettings);
        }}>删除</button>}
      </div>)}
      {!catalog.isLoading && filtered.length === 0 && <p className="model-provider-empty">{search ? '没有匹配的模型' : '这里还没有模型'}</p>}
    </div>
  </div>;
}

export function ModelSettingsPanel({ active }: { active: boolean }) {
  const desktop = window.yuanpu;
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['settings', 'models'], queryFn: () => desktop!.getModelSettings(), enabled: active && Boolean(desktop) });
  const catalog = useQuery({ queryKey: ['settings', 'model-catalog', 'providers'], queryFn: () => loadCatalog(), enabled: active && Boolean(desktop) });
  const [selected, setSelected] = useState('');
  const [addingProvider, setAddingProvider] = useState(false);
  const [fromPicker, setFromPicker] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [operationError, setOperationError] = useState('');
  const [notice, setNotice] = useState('');
  const settings = query.data;
  const customProviders = settings?.customProviders?.map((item) => item.id) ?? [];
  const catalogProviders = (catalog.data?.providers ?? []).filter((entry) => (
    entry.id === settings?.provider || settings?.providerCredentials?.[entry.id] === 'api_key' || settings?.providerCredentials?.[entry.id] === 'oauth'
  ));
  const provider = selected && (customProviders.includes(selected) || catalog.data?.providers.some((item) => item.id === selected))
    ? selected : settings?.provider ?? '';
  return <section className="settings-models" aria-label="模型设置">
    <header className="model-settings-header"><h2>模型设置</h2><div className="model-settings-subhead"><p>管理模型供应商，配置后可在工作中选择使用。</p>
      <div><button type="button" aria-label="刷新模型设置" title="刷新模型设置" onClick={() => { void client.invalidateQueries({ queryKey: ['settings', 'models'] }); void client.invalidateQueries({ queryKey: ['settings', 'model-catalog'] }); }}>↻</button>
        <button type="button" className="model-add-provider" onClick={() => setAddingProvider(true)}>＋ 添加供应商</button></div></div></header>
    {!desktop && <p role="alert">请在桌面应用中配置模型。</p>}
    {query.isLoading && <p>正在读取模型设置…</p>}
    {query.error && <p role="alert">读取失败：{formatError(query.error)}</p>}
    {settings && <div className="model-provider-layout">
      <nav className="model-provider-nav" aria-label="供应商">
        <span className="model-provider-nav-label">已添加供应商</span>
        {catalogProviders.map((item) => <button type="button" key={item.id} className={provider === item.id ? 'selected' : ''} onClick={() => { setSelected(item.id); setAddingProvider(false); setFromPicker(false); }}>
          <ProviderIcon id={item.id} /><span className="model-provider-nav-name"><strong>{providerChineseName(item.id, settings) || item.name}</strong>{providerChineseName(item.id, settings) && <small>{item.name}</small>}</span>
          <i className={settings.providerCredentials?.[item.id] === 'api_key' || settings.providerCredentials?.[item.id] === 'oauth' ? 'configured' : ''} aria-hidden="true" /></button>)}
        {catalog.error && <p role="alert">目录读取失败：{formatError(catalog.error)}</p>}
        <span className="model-provider-nav-label">自定义供应商</span>
        {customProviders.map((id) => <button type="button" key={id} className={provider === id ? 'selected' : ''} onClick={() => { setSelected(id); setAddingProvider(false); setFromPicker(false); }}>
          <ProviderIcon id={id} /><span className="model-provider-nav-name"><strong>{providerChineseName(id, settings) || id}</strong>{providerChineseName(id, settings) && <small>{id}</small>}</span>
          <i className={settings.providerCredentials?.[id] === 'api_key' || settings.providerCredentials?.[id] === 'oauth' ? 'configured' : ''} aria-hidden="true" /></button>)}
        {customProviders.length === 0 && <p>还没有自定义供应商</p>}
      </nav>
      {addingProvider ? <ProviderPicker providers={catalog.data?.providers ?? []} onSelect={(id) => { setSelected(id); setAddingProvider(false); setFromPicker(true); }}
        onCustom={() => setEditor({ kind: 'provider' })} onBack={() => { setAddingProvider(false); setFromPicker(false); }} />
        : provider ? <ProviderDetails key={provider} provider={provider} settings={settings} onSettings={(result) => client.setQueryData(['settings', 'models'], result)}
        onEdit={setEditor} onError={setOperationError} onNotice={setNotice} onBack={fromPicker ? () => setAddingProvider(true) : undefined} /> : <p className="model-provider-empty">请选择或添加供应商</p>}
    </div>}
    {operationError && <p role="alert" className="model-operation-error">{operationError}</p>}
    {notice && <p role="status" className="model-operation-notice">{notice}</p>}
    {editor && <ModelEditor editor={editor} onClose={() => setEditor(null)} onSaved={(result, savedProvider) => {
      client.setQueryData(['settings', 'models'], result);
      setSelected(savedProvider);
      setAddingProvider(false);
      setFromPicker(false);
      setEditor(null); setOperationError(''); setNotice('已保存，下一条消息生效');
    }} />}
  </section>;
}
