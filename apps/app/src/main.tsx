import {
  StrictMode,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import type {
  CapabilityApprovalSummary,
  InstalledPlugin,
  LocalSkill,
  PluginConfigDocument,
  PluginConfigScope,
  PluginSearchResult,
  NotificationNavigationTarget,
  RuntimeRecoveryNotice,
  AgentRunRecord,
  PrivateImRunSummary,
} from '@yuanpu-agent/protocol';

import { ConnectionManagement, ScheduleManagement } from './management.js';

import './styles.css';
import './muse-theme.css';

type ToolState = { name: string; status: 'started' | 'completed' | 'failed' };
type ChatMessage = {
  id: number;
  role: 'user' | 'assistant' | 'error';
  text: string;
  tools?: ToolState[];
};
type AppView = 'chat' | 'skills' | 'connections' | 'schedules';
type ActivityEvent = {
  id: number;
  runId: string;
  title: string;
  detail?: string;
  at: string;
  tone: 'active' | 'done' | 'warning' | 'error';
};

function runStatusLabel(status: AgentRunRecord['status']): string {
  return {
    queued: '等待执行',
    running: '正在执行',
    waiting_approval: '等待授权',
    succeeded: '已完成',
    failed: '执行失败',
    cancelled: '已取消',
    interrupted: '执行中断',
    result_unknown: '结果未知',
  }[status];
}

function activityTime(at: string): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function AppIcon({ name }: { name: AppView | 'menu' | 'panel' | 'send' }) {
  const paths = {
    chat: <path d="M20 11.5c0 4.2-3.8 7.5-8.5 7.5-1.4 0-2.7-.3-3.8-.8L3 20l1.4-4.1A7.2 7.2 0 0 1 3 11.5C3 7.4 6.8 4 11.5 4S20 7.4 20 11.5Z" />,
    skills: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><path d="M17 13.5v7m-3.5-3.5h7" /></>,
    connections: <><path d="m9 15-2 2a3.2 3.2 0 0 1-4.5-4.5l4-4A3.2 3.2 0 0 1 11 8" /><path d="m15 9 2-2a3.2 3.2 0 0 1 4.5 4.5l-4 4A3.2 3.2 0 0 1 13 16" /><path d="m8.5 15.5 7-7" /></>,
    schedules: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.4 2" /></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
    panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
    send: <><path d="M12 19V5m-5 5 5-5 5 5" /></>,
  } satisfies Record<AppView | 'menu' | 'panel' | 'send', ReactNode>;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function privateImDeliveryLabel(status: PrivateImRunSummary['replyDeliveryStatus']): string {
  return {
    not_created: '无回复投递记录',
    pending: '等待投递',
    delivering: '正在投递',
    accepted: '企业微信已接收（未确认对方可见）',
    failed: '投递失败',
    unknown: '投递结果未知（不会自动重发）',
  }[status];
}
type SkillTab = 'marketplace' | 'installed' | 'local' | 'updates';

const initialMessages: ChatMessage[] = [{
  id: 1,
  role: 'assistant',
  text: '你好，我是 YuanpuAgent。你可以直接开始对话，也可以让我调用外部 MCP 能力。',
}];

const previewPlugins: PluginSearchResult[] = [
  {
    name: '@quintinshaw/pi-dynamic-workflows',
    displayName: '工作流编排',
    version: '3.12.0',
    description: '可组合的工作流、任务拆解与自动化执行能力。',
    publisher: 'quintinshaw',
    source: 'npm:@quintinshaw/pi-dynamic-workflows@3.12.0',
    components: ['agent', 'workflow', 'extension'],
    permissions: ['scripts', 'filesystem', 'background'],
  },
  {
    name: 'pi-hermes-memory',
    displayName: '长期记忆',
    version: '0.9.9',
    description: '为 Pi 提供跨会话的长期记忆、存储和检索能力。',
    publisher: 'community',
    source: 'npm:pi-hermes-memory@0.9.9',
    components: ['skill', 'extension'],
    permissions: ['filesystem', 'background'],
  },
  {
    name: 'pi-mcp-adapter',
    displayName: 'MCP 服务连接',
    version: '2.34.0',
    description: '连接外部 MCP 服务，扩展更多工具和数据源。',
    publisher: 'community',
    source: 'npm:pi-mcp-adapter@2.34.0',
    components: ['connector', 'extension'],
    permissions: ['network', 'credentials', 'background'],
  },
];

const previewInstalled: InstalledPlugin[] = [{
  name: 'pi-mcp-adapter',
  version: '2.34.0',
  description: '连接外部 MCP 服务，扩展更多工具和数据源。',
  source: 'npm:pi-mcp-adapter@2.34.0',
  installPath: '~/.yuanpu/packages/installed/pi-mcp-adapter',
  enabled: true,
  installedAt: '2026-09-21T00:00:00.000Z',
  configurable: true,
  configStatus: 'valid',
}];

function previewConfig(scope: PluginConfigScope): PluginConfigDocument {
  return {
    pluginName: 'pi-mcp-adapter',
    kind: 'mcp',
    title: 'MCP 服务',
    description: '配置外部 MCP 服务；服务器会在实际使用工具时按需连接。',
    scope,
    path: scope === 'user' ? '~/.yuanpu/agent/mcp.json' : '<workspace>/.pi/mcp.json',
    supportsWorkspace: true,
    secretPolicy: 'environment-only',
    value: {
      mcpServers: {
        'chrome-devtools': {
          command: 'npx',
          args: ['-y', 'chrome-devtools-mcp@1.6.0'],
        },
      },
    },
  };
}

function isDirectPluginSource(value: string): boolean {
  return value.startsWith('npm:')
    || value.startsWith('https://github.com/')
    || value.startsWith('git+https://github.com/');
}

function isArtifactSource(value: string): boolean {
  return value.startsWith('artifact:');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function PluginConfigPage({
  plugin,
  active,
  onBack,
  onChanged,
}: {
  plugin: InstalledPlugin;
  active: boolean;
  onBack: () => void;
  onChanged: () => Promise<void>;
}) {
  const desktop = window.yuanpu;
  const [scope, setScope] = useState<PluginConfigScope>('user');
  const [document, setDocument] = useState<PluginConfigDocument>();
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [rawDraft, setRawDraft] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  async function load(nextScope: PluginConfigScope) {
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      const next = desktop
        ? await desktop.getPluginConfig(plugin.name, nextScope)
        : previewConfig(nextScope);
      setDocument(next);
      setDraft(next.value);
      setRawDraft(JSON.stringify(next.value, null, 2));
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load(scope);
  }, [scope, plugin.name, desktop]);

  const mcpServers = asRecord(draft.mcpServers);

  function updateServer(name: string, next: Record<string, unknown>) {
    setDraft((current) => ({
      ...current,
      mcpServers: { ...asRecord(current.mcpServers), [name]: next },
    }));
    setSaved(false);
  }

  function renameServer(name: string, nextName: string) {
    if (!nextName || nextName === name || nextName in mcpServers) return;
    setDraft((current) => {
      const servers = { ...asRecord(current.mcpServers) };
      const value = servers[name];
      delete servers[name];
      servers[nextName] = value;
      return { ...current, mcpServers: servers };
    });
    setSaved(false);
  }

  function removeServer(name: string) {
    setDraft((current) => {
      const servers = { ...asRecord(current.mcpServers) };
      delete servers[name];
      return { ...current, mcpServers: servers };
    });
    setSaved(false);
  }

  function addServer() {
    let name = 'new-server';
    let index = 2;
    while (name in mcpServers) name = `new-server-${index++}`;
    updateServer(name, { command: 'npx', args: ['-y'] });
  }

  async function save() {
    if (!document) return;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      let value = draft;
      if (document.kind === 'schema') {
        const parsed = JSON.parse(rawDraft) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('技能配置必须是 JSON 对象。');
        }
        value = parsed as Record<string, unknown>;
      }
      if (desktop) {
        const input = { name: plugin.name, scope, value };
        const validation = await desktop.validatePluginConfig(input);
        if (!validation.valid) throw new Error(validation.errors.join('；'));
        const next = await desktop.savePluginConfig(input);
        setDocument(next);
        setDraft(next.value);
        setRawDraft(JSON.stringify(next.value, null, 2));
        await onChanged();
      }
      setSaved(true);
    } catch (saveError) {
      setError(formatError(saveError));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!document || !window.confirm(`重置 ${scope === 'user' ? '用户' : '当前工作区'}配置？`)) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = desktop
        ? await desktop.resetPluginConfig(plugin.name, scope)
        : previewConfig(scope);
      setDocument(next);
      setDraft(next.value);
      setRawDraft(JSON.stringify(next.value, null, 2));
      setSaved(true);
      await onChanged();
    } catch (resetError) {
      setError(formatError(resetError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`plugin-panel plugin-config-panel ${active ? '' : 'view-hidden'}`} aria-hidden={!active}>
      <header className="config-topbar">
        <button type="button" className="back-button" onClick={onBack}>← 返回技能列表</button>
      </header>
      <div className="config-layout">
        <aside className="config-plugin-summary">
          <div className="installed-title">
            <h1>{plugin.name}</h1>
            <span className={plugin.enabled ? 'enabled' : 'disabled'}>{plugin.enabled ? '已启用' : '已停用'}</span>
          </div>
          <p>{plugin.description}</p>
          <dl>
            <div><dt>版本</dt><dd>v{plugin.version}</dd></div>
            <div><dt>来源</dt><dd>{plugin.source.startsWith('npm:') ? 'npm' : 'Git'}</dd></div>
            <div><dt>配置状态</dt><dd>{plugin.configStatus === 'invalid' ? '需要修复' : '有效'}</dd></div>
          </dl>
          <p className="config-summary-note">配置独立于安装目录保存，升级技能时不会丢失。</p>
        </aside>

        <div className="config-editor">
          <header className="config-editor-header">
            <div>
              <h2>{document?.title ?? '技能配置'}</h2>
              <p>{document?.description ?? '正在读取配置…'}</p>
              {document && <code title={document.path}>{document.path}</code>}
            </div>
            <div className="scope-switch" role="group" aria-label="配置作用域">
              <button type="button" className={scope === 'user' ? 'active' : ''} onClick={() => setScope('user')}>用户</button>
              <button
                type="button"
                className={scope === 'workspace' ? 'active' : ''}
                disabled={!document?.supportsWorkspace}
                onClick={() => setScope('workspace')}
              >当前工作区</button>
            </div>
          </header>

          <div className="secret-notice">
            <span aria-hidden="true">◆</span>
            API Key、Token 等敏感值必须写成环境变量引用，例如 <code>{'${MCP_API_KEY}'}</code>。
          </div>

          {error && <div className="plugin-error" role="alert">{error}</div>}
          {saved && <div className="config-success" role="status">配置已保存，将在下一次对话中生效。</div>}

          <div className="config-editor-body">
            {document?.kind === 'mcp' && Object.entries(mcpServers).map(([name, value]) => {
              const server = asRecord(value);
              const http = typeof server.url === 'string';
              const args = Array.isArray(server.args) ? server.args.filter((item) => typeof item === 'string') as string[] : [];
              return (
                <article className="mcp-server-card" key={name}>
                  <div className="mcp-server-title">
                    <input aria-label="MCP 服务名称" defaultValue={name} onBlur={(event) => renameServer(name, event.target.value.trim())} />
                    <span>{http ? 'http' : 'stdio'}</span>
                    <label><input type="checkbox" checked={server.disabled !== true} onChange={(event) => updateServer(name, { ...server, disabled: !event.target.checked })} /> 启用</label>
                    <button type="button" className="icon-danger" aria-label={`删除 ${name}`} onClick={() => removeServer(name)}>×</button>
                  </div>
                  <div className="transport-switch">
                    <button type="button" className={!http ? 'active' : ''} onClick={() => {
                      const next: Record<string, unknown> = { ...server, command: typeof server.command === 'string' ? server.command : 'npx' };
                      delete next.url;
                      updateServer(name, next);
                    }}>本地命令</button>
                    <button type="button" className={http ? 'active' : ''} onClick={() => {
                      const next: Record<string, unknown> = { ...server, url: typeof server.url === 'string' ? server.url : 'https://' };
                      delete next.command;
                      delete next.args;
                      updateServer(name, next);
                    }}>HTTP</button>
                  </div>
                  {http ? (
                    <label className="config-field"><span>服务地址</span><input value={String(server.url ?? '')} onChange={(event) => updateServer(name, { ...server, url: event.target.value })} /></label>
                  ) : (
                    <>
                      <label className="config-field"><span>命令</span><input value={String(server.command ?? '')} onChange={(event) => updateServer(name, { ...server, command: event.target.value })} /></label>
                      <label className="config-field"><span>参数</span><textarea value={args.join('\n')} onChange={(event) => updateServer(name, { ...server, args: event.target.value.split('\n').filter(Boolean) })} placeholder="每行一个参数" /></label>
                    </>
                  )}
                </article>
              );
            })}

            {document?.kind === 'mcp' && (
              <button type="button" className="add-server-button" onClick={addServer}>＋ 添加 MCP 服务</button>
            )}

            {document?.kind === 'schema' && (
              <label className="raw-config-field">
                <span>JSON 配置</span>
                <textarea value={rawDraft} onChange={(event) => { setRawDraft(event.target.value); setSaved(false); }} spellCheck={false} />
              </label>
            )}

            {!document && !error && <div className="plugin-empty">正在读取技能配置…</div>}
          </div>

          <footer className="config-actions">
            <span>保存后将在下一次对话中生效</span>
            <div>
              <button type="button" onClick={() => void reset()} disabled={busy || !document}>重置</button>
              <button type="button" className="primary" onClick={() => void save()} disabled={busy || !document}>{busy ? '处理中…' : '保存并应用'}</button>
            </div>
          </footer>
        </div>
      </div>
    </section>
  );
}

const componentLabels: Record<NonNullable<PluginSearchResult['components']>[number], string> = {
  skill: '使用指南',
  agent: '专家角色',
  workflow: '工作流',
  extension: '运行扩展',
  prompt: '提示模板',
  theme: '界面主题',
  connector: '服务连接',
};

const permissionLabels: Record<NonNullable<PluginSearchResult['permissions']>[number], string> = {
  instructions: '包含指令',
  scripts: '可执行脚本',
  filesystem: '访问本地文件',
  network: '访问网络',
  credentials: '需要密钥',
  notifications: '显示系统弹窗',
  background: '后台运行',
};

function SkillPage({ active }: { active: boolean }) {
  const desktop = window.yuanpu;
  const [tab, setTab] = useState<SkillTab>('marketplace');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PluginSearchResult[]>(desktop ? [] : previewPlugins);
  const [installed, setInstalled] = useState<InstalledPlugin[]>(desktop ? [] : previewInstalled);
  const [localSkills, setLocalSkills] = useState<LocalSkill[]>([]);
  const [localDiagnostics, setLocalDiagnostics] = useState<Array<{ path: string; message: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [editingPlugin, setEditingPlugin] = useState<InstalledPlugin>();
  const [trustCandidate, setTrustCandidate] = useState<PluginSearchResult>();
  const [installFailures, setInstallFailures] = useState<Record<string, string>>({});

  const installedByName = useMemo(
    () => new Map(installed.map((plugin) => [plugin.name, plugin])),
    [installed],
  );

  const installedFor = (candidate: PluginSearchResult) => (
    installedByName.get(candidate.id ?? candidate.name) ?? installedByName.get(candidate.name)
  );

  async function refreshInstalled() {
    if (!desktop) return;
    setInstalled(await desktop.listPlugins());
  }

  async function refreshLocalSkills() {
    if (!desktop) return;
    const result = await desktop.listLocalSkills();
    setLocalSkills(result.skills);
    setLocalDiagnostics(result.diagnostics);
  }

  async function search(term = query) {
    setError(undefined);
    if (!desktop) {
      const normalized = term.trim().toLowerCase();
      setResults(previewPlugins.filter((plugin) => (
        !normalized
        || plugin.name.toLowerCase().includes(normalized)
        || plugin.displayName?.toLowerCase().includes(normalized)
        || plugin.description.toLowerCase().includes(normalized)
      )));
      return;
    }
    setSearching(true);
    try {
      setResults(await desktop.searchPlugins(term.trim()));
    } catch (searchError) {
      setError(formatError(searchError));
    } finally {
      setSearching(false);
    }
  }

  useEffect(() => {
    if (!desktop) return;
    void Promise.all([search(''), refreshInstalled(), refreshLocalSkills()]).catch((loadError) => {
      setError(formatError(loadError));
    });
  }, [desktop, active]);

  async function install(candidate: PluginSearchResult) {
    const source = candidate.source;
    if (!desktop) {
      setError('浏览器预览模式不会执行技能安装。请通过 Electron 启动 YuanpuAgent。');
      return;
    }
    setTrustCandidate(undefined);
    setPending(source);
    setError(undefined);
    const legacyAdapter = installedByName.get('pi-mcp-adapter');
    let legacyDisabled = false;
    try {
      if (isArtifactSource(source) && !candidate.artifactManifestDigest) {
        throw new Error('能力清单快照缺失，请重新搜索并确认权限。');
      }
      if (isArtifactSource(source) && legacyAdapter?.enabled) {
        const conflicts = await desktop.listMcpOwnershipConflicts(
          source,
          candidate.artifactManifestDigest!,
        );
        if (conflicts.length > 0) {
          const names = conflicts.map((conflict) => conflict.name).join('、');
          const useYuanpu = window.confirm(
            `检测到旧 pi-mcp-adapter 正在托管同名连接：${names}。\n\n选择“确定”将停用旧适配器并由 Yuanpu 托管；旧配置会完整保留，但旧适配器中的其他连接也会暂停。选择“取消”则保持旧适配器且不安装。`,
          );
          if (!useYuanpu) return;
          await desktop.setPluginEnabled(legacyAdapter.name, false);
          legacyDisabled = true;
        }
      }
      await desktop.installPlugin(source, candidate.artifactManifestDigest);
      await refreshInstalled();
      setInstallFailures((current) => {
        const next = { ...current };
        delete next[source];
        return next;
      });
      setTab('installed');
    } catch (installError) {
      const message = formatError(installError);
      if (legacyDisabled && legacyAdapter) {
        await desktop.setPluginEnabled(legacyAdapter.name, true).catch(() => undefined);
      }
      setError(message);
      setInstallFailures((current) => ({ ...current, [source]: message }));
      if (message.includes('能力清单已变化')) {
        const refreshed = await desktop.searchPlugins(query.trim()).catch(() => undefined);
        if (refreshed) setResults(refreshed);
      }
      const current = await desktop.listPlugins().catch(() => []);
      setInstalled(current);
    } finally {
      setPending(undefined);
    }
  }

  async function submitSearch(event: FormEvent) {
    event.preventDefault();
    const term = query.trim();
    if (isDirectPluginSource(term)) {
      setTrustCandidate({
        name: term,
        version: '固定来源',
        description: '手动输入的固定版本插件来源。',
        source: term,
      });
      return;
    }
    await search(term);
  }

  async function setEnabled(plugin: InstalledPlugin, enabled: boolean) {
    if (!desktop) return;
    setPending(plugin.name);
    setError(undefined);
    try {
      await desktop.setPluginEnabled(plugin.name, enabled);
      await refreshInstalled();
    } catch (stateError) {
      setError(formatError(stateError));
    } finally {
      setPending(undefined);
    }
  }

  async function uninstall(plugin: InstalledPlugin) {
    if (!desktop || !window.confirm(`卸载 ${plugin.name}？\n\n能力包会被删除，但不会删除 ~/.yuanpu/agent/skills 中的本地技能。`)) return;
    setPending(plugin.name);
    setError(undefined);
    try {
      await desktop.uninstallPlugin(plugin.name);
      await refreshInstalled();
    } catch (uninstallError) {
      setError(formatError(uninstallError));
    } finally {
      setPending(undefined);
    }
  }

  async function rollback(plugin: InstalledPlugin, version: string) {
    if (!desktop || pending) return;
    setPending(plugin.name);
    setError(undefined);
    try {
      await desktop.rollbackPlugin(plugin.name, version);
      await refreshInstalled();
    } catch (rollbackError) {
      setError(`回滚失败，仍在使用 v${plugin.activeVersion ?? plugin.version}：${formatError(rollbackError)}`);
    } finally {
      setPending(undefined);
    }
  }

  if (editingPlugin) {
    return (
      <PluginConfigPage
        plugin={editingPlugin}
        active={active}
        onBack={() => setEditingPlugin(undefined)}
        onChanged={async () => {
          await refreshInstalled();
          if (desktop) {
            const current = await desktop.listPlugins();
            const updated = current.find((item) => item.name === editingPlugin.name);
            if (updated) setEditingPlugin(updated);
          }
        }}
      />
    );
  }

  return (
    <section className={`plugin-panel ${active ? '' : 'view-hidden'}`} aria-hidden={!active}>
      <header className="plugin-header">
        <div>
          <h1>技能</h1>
          <p>为 YuanpuAgent 添加工作能力</p>
        </div>
        <span>已安装 {installed.length}</span>
      </header>

      <div className="plugin-content">
        <form className="plugin-search" onSubmit={(event) => void submitSearch(event)}>
          <span className="search-icon" aria-hidden="true" />
          <input
            aria-label="搜索技能"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索技能、服务或工作场景"
          />
          <button type="submit" disabled={searching || Boolean(pending)}>
            {searching ? '搜索中…' : isDirectPluginSource(query.trim()) ? '安装来源' : '搜索'}
          </button>
        </form>

        <div className="plugin-tabs" role="tablist" aria-label="技能视图">
          <button type="button" role="tab" aria-selected={tab === 'marketplace'} onClick={() => setTab('marketplace')}>
            技能市场
          </button>
          <button type="button" role="tab" aria-selected={tab === 'installed'} onClick={() => setTab('installed')}>
            已安装
          </button>
          <button type="button" role="tab" aria-selected={tab === 'local'} onClick={() => setTab('local')}>
            本地技能
          </button>
          <button type="button" role="tab" aria-selected={tab === 'updates'} onClick={() => setTab('updates')}>
            更新
          </button>
        </div>

        <div className="security-notice">
          <span aria-hidden="true">!</span>
          技能可能包含操作指令、运行扩展、工作流或外部服务连接。安装前请查看权限并确认来源可信。
        </div>

        {error && <div className="plugin-error" role="alert">{error}</div>}

        <div className="plugin-list">
          {tab === 'marketplace' && results.map((plugin) => {
            const current = installedFor(plugin);
            const isPending = pending === plugin.source;
            return (
              <article className="plugin-card" key={`${plugin.name}@${plugin.version}`}>
                <div className="plugin-card-main">
                  <h2>{plugin.displayName ?? plugin.name}</h2>
                  <p>{plugin.description}</p>
                  <div className="plugin-meta">
                    <span>v{plugin.version}</span>
                    {plugin.publisher && <span>by {plugin.publisher}</span>}
                    <span title={plugin.name}>{plugin.name}</span>
                  </div>
                  <div className="skill-badges">
                    {plugin.components?.map((component) => (
                      <span className="component-badge" key={component}>{componentLabels[component]}</span>
                    ))}
                    {plugin.permissions?.map((permission) => (
                      <span className="permission-badge" key={permission}>{permissionLabels[permission]}</span>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  className="install-button"
                  disabled={Boolean(pending) || current?.version === plugin.version}
                  onClick={() => setTrustCandidate(plugin)}
                >
                  {isPending ? '安装中…' : current?.version === plugin.version ? '已安装' : current ? '更新' : '安装'}
                </button>
                {installFailures[plugin.source] && (
                  <div className="install-recovery" role="alert">
                    <span>更新失败，仍在使用 v{current?.activeVersion ?? current?.version ?? '—'}</span>
                    <button type="button" disabled={Boolean(pending)} onClick={() => setTrustCandidate(plugin)}>重试</button>
                  </div>
                )}
              </article>
            );
          })}

          {tab === 'installed' && installed.map((plugin) => (
            <article className="plugin-card installed" key={plugin.name}>
              <div className="plugin-card-main">
                <div className="installed-title">
                  <h2>{plugin.name}</h2>
                  <span className={plugin.enabled ? 'enabled' : 'disabled'}>
                    {plugin.enabled ? '已启用' : '已停用'}
                  </span>
                </div>
                <p>{plugin.description}</p>
                {plugin.loadError && <div className="plugin-load-error">加载失败：{plugin.loadError}</div>}
                <div className="plugin-meta">
                  <span>v{plugin.version}</span>
                  <span title={plugin.source}>{plugin.source.startsWith('npm:') ? 'npm' : plugin.kind === 'python-mcp' ? '能力制品' : 'Git'}</span>
                </div>
              </div>
              <div className="plugin-actions">
                {plugin.configurable && (
                  <button type="button" disabled={Boolean(pending)} onClick={() => setEditingPlugin(plugin)}>
                    配置
                  </button>
                )}
                {plugin.kind !== 'python-mcp' && (
                  <button type="button" disabled={Boolean(pending)} onClick={() => void setEnabled(plugin, !plugin.enabled)}>
                    {pending === plugin.name ? '处理中…' : plugin.enabled ? '停用' : '启用'}
                  </button>
                )}
                {plugin.kind === 'python-mcp' && plugin.availableVersions
                  ?.filter((version) => version !== plugin.activeVersion)
                  .map((version) => (
                    <button type="button" disabled={Boolean(pending)} key={version} onClick={() => void rollback(plugin, version)}>
                      回滚到 v{version}
                    </button>
                  ))}
                {plugin.kind !== 'python-mcp' && (
                  <button type="button" className="danger" disabled={Boolean(pending)} onClick={() => void uninstall(plugin)}>
                    卸载
                  </button>
                )}
              </div>
            </article>
          ))}

          {tab === 'local' && localSkills.map((skill) => (
            <article className="plugin-card installed" key={skill.filePath}>
              <div className="plugin-card-main">
                <div className="installed-title">
                  <h2>{skill.name}</h2>
                  <span className="enabled">已加载</span>
                </div>
                <p>{skill.description}</p>
                <div className="plugin-meta">
                  <span title={skill.filePath}>本地 SKILL.md</span>
                  {skill.disableModelInvocation && <span>仅手动调用</span>}
                </div>
              </div>
            </article>
          ))}

          {tab === 'local' && localDiagnostics.map((diagnostic) => (
            <div className="plugin-error" role="alert" key={`${diagnostic.path}:${diagnostic.message}`}>
              {diagnostic.path ? `${diagnostic.path}：` : ''}{diagnostic.message}
            </div>
          ))}

          {tab === 'local' && localSkills.length === 0 && localDiagnostics.length === 0 && (
            <div className="plugin-empty skill-directory-empty">
              <strong>还没有本地技能</strong>
              <code>~/.yuanpu/agent/skills</code>
              <span>将包含 SKILL.md 的技能目录放到这里，刷新页面或下次启动后自动加载。</span>
            </div>
          )}

          {tab === 'updates' && results.filter((plugin) => {
            const current = installedFor(plugin);
            return current && current.version !== plugin.version;
          }).map((plugin) => {
            const current = installedFor(plugin)!;
            return (
              <article className="plugin-card" key={`update:${plugin.id ?? plugin.name}@${plugin.version}`}>
                <div className="plugin-card-main">
                  <h2>{plugin.displayName ?? plugin.name}</h2>
                  <p>{plugin.description}</p>
                  <div className="plugin-meta">
                    <span>当前 v{current.activeVersion ?? current.version}</span>
                    <span>可更新至 v{plugin.version}</span>
                  </div>
                </div>
                <button type="button" className="install-button" disabled={Boolean(pending)} onClick={() => setTrustCandidate(plugin)}>
                  {pending === plugin.source ? '更新中…' : '更新'}
                </button>
                {installFailures[plugin.source] && (
                  <div className="install-recovery" role="alert">
                    <span>更新失败，仍在使用 v{current.activeVersion ?? current.version}</span>
                    <button type="button" disabled={Boolean(pending)} onClick={() => setTrustCandidate(plugin)}>重试</button>
                  </div>
                )}
              </article>
            );
          })}

          {tab === 'updates' && results.every((plugin) => {
            const current = installedFor(plugin);
            return !current || current.version === plugin.version;
          }) && (
            <div className="plugin-empty">当前没有待更新的技能。能力包更新会保留独立配置。</div>
          )}

          {tab === 'marketplace' && !searching && results.length === 0 && (
            <div className="plugin-empty">没有找到匹配的技能。也可以输入固定版本的 npm 或 Git 来源。</div>
          )}
          {tab === 'installed' && installed.length === 0 && (
            <div className="plugin-empty">还没有安装技能。前往“技能市场”搜索工作能力。</div>
          )}
        </div>
      </div>
      {trustCandidate && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setTrustCandidate(undefined)}>
          <section className="trust-dialog" role="dialog" aria-modal="true" aria-labelledby="trust-title" onMouseDown={(event) => event.stopPropagation()}>
            <span className="dialog-kicker">安装确认</span>
            <h2 id="trust-title">信任并安装 {trustCandidate.displayName ?? trustCandidate.name}？</h2>
            <p>{trustCandidate.description}</p>
            <dl>
              <div><dt>版本</dt><dd>{trustCandidate.version}</dd></div>
              <div><dt>来源</dt><dd>{trustCandidate.source}</dd></div>
              <div><dt>发布者</dt><dd>{trustCandidate.publisher ?? '未知发布者'}</dd></div>
              {trustCandidate.artifactManifestDigest && (
                <div><dt>清单摘要</dt><dd>{trustCandidate.artifactManifestDigest.slice(0, 16)}…</dd></div>
              )}
            </dl>
            <div className="skill-badges">
              {trustCandidate.permissions?.map((permission) => (
                <span className="permission-badge" key={permission}>{permissionLabels[permission]}</span>
              ))}
            </div>
            {isArtifactSource(trustCandidate.source) && (
              <p className="trust-boundary">此能力在独立进程中运行，不会作为 Pi extension 加载；安装仍会验证签名、平台、哈希和兼容版本。</p>
            )}
            <footer>
              <button type="button" onClick={() => setTrustCandidate(undefined)}>取消</button>
              <button type="button" className="primary" onClick={() => void install(trustCandidate)}>信任并安装</button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}

function ChatPanel({
  active,
  navigationTarget,
  onReturnToSchedules,
  scheduleOrigin,
}: {
  active: boolean;
  navigationTarget?: NotificationNavigationTarget;
  onReturnToSchedules: () => void;
  scheduleOrigin: boolean;
}) {
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [runtime, setRuntime] = useState({ connected: false, piVersion: '—' });
  const [approvals, setApprovals] = useState<CapabilityApprovalSummary[]>([]);
  const [approvalBusy, setApprovalBusy] = useState<string>();
  const [readyApprovals, setReadyApprovals] = useState<Set<string>>(new Set());
  const resolvedApprovals = useRef(new Set<string>());
  const [locationRetry, setLocationRetry] = useState(0);
  const [locatedRun, setLocatedRun] = useState<AgentRunRecord | 'loading' | 'error'>();
  const [privateImSummary, setPrivateImSummary] = useState<PrivateImRunSummary | 'loading'>();
  const [activeRunId, setActiveRunId] = useState<string>();
  const [activeRunStatus, setActiveRunStatus] = useState<AgentRunRecord['status']>();
  const [cancelBusy, setCancelBusy] = useState(false);
  const [activityOpen, setActivityOpen] = useState(() => window.innerWidth > 1100);
  const [activityTab, setActivityTab] = useState<'activity' | 'run'>('activity');
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const [lastRun, setLastRun] = useState<AgentRunRecord>();
  const [runRecovery, setRunRecovery] = useState<{ runId: string; text: string }>();
  const [bridgeError, setBridgeError] = useState(false);
  const sending = useRef(false);
  const settledRuns = useRef(new Map<string, AgentRunRecord>());
  const activityDialog = useRef<HTMLDialogElement>(null);
  const activityToggle = useRef<HTMLButtonElement>(null);
  const restoreActivityFocus = useRef(false);
  const nextActivityId = useRef(1);
  const nextId = useRef(2);
  const conversation = useRef<HTMLDivElement>(null);
  const desktop = window.yuanpu;

  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 1100px)');
    const compact = window.matchMedia('(max-width: 780px)');
    const handleWidthChange = (event: MediaQueryListEvent) => {
      if (event.matches) setActivityOpen(false);
    };
    narrow.addEventListener('change', handleWidthChange);
    compact.addEventListener('change', handleWidthChange);
    return () => {
      narrow.removeEventListener('change', handleWidthChange);
      compact.removeEventListener('change', handleWidthChange);
    };
  }, []);

  useEffect(() => {
    const dialog = activityDialog.current;
    if (activityOpen && active && dialog) {
      if (window.matchMedia('(max-width: 1100px)').matches) dialog.showModal();
      else dialog.open = true;
      return () => dialog.close();
    }
    if (!activityOpen && active && restoreActivityFocus.current) {
      activityToggle.current?.focus();
      restoreActivityFocus.current = false;
    }
  }, [activityOpen, active]);

  function recordActivity(runId: string, title: string, tone: ActivityEvent['tone'], detail?: string, at = new Date().toISOString()) {
    const event = { id: nextActivityId.current++, runId, title, tone, detail, at };
    setActivityEvents((current) => [...current, event]);
  }

  async function refreshApprovals() {
    if (!desktop) return [];
    const pendingApprovals = await desktop.listCapabilityApprovals();
    const ready = await Promise.all(pendingApprovals.map(async (approval) => {
      if (!approval.runId) return approval.requestId;
      const run = await desktop.getAgentRun(approval.runId);
      return run.status === 'waiting_approval' && run.pendingApproval?.approvalRequestId === approval.requestId
        ? approval.requestId : undefined;
    }));
    setBridgeError(false);
    setReadyApprovals(new Set(ready.filter((id): id is string => Boolean(id))));
    setApprovals(pendingApprovals.filter((approval) => !resolvedApprovals.current.has(approval.requestId)));
    return pendingApprovals;
  }

  useEffect(() => {
    if (!desktop) return;
    void desktop.runtimeInfo()
      .then((info) => setRuntime({ connected: true, piVersion: info.piVersion }))
      .catch(() => setRuntime((current) => ({ ...current, connected: false })));
  }, [desktop]);

  useEffect(() => {
    if (!desktop || !active) return;
    const refresh = () => void refreshApprovals().catch(() => setBridgeError(true));
    refresh();
    const timer = window.setInterval(refresh, 1_500);
    return () => window.clearInterval(timer);
  }, [desktop, active]);

  useEffect(() => {
    const runId = navigationTarget?.runId;
    if (!desktop || !runId) {
      setLocatedRun(undefined);
      setPrivateImSummary(undefined);
      return;
    }
    let cancelled = false;
    setLocatedRun('loading');
    setPrivateImSummary('loading');
    void desktop.getAgentRun(runId).then(
      (run) => { if (!cancelled) setLocatedRun(run); },
      () => { if (!cancelled) setLocatedRun('error'); },
    );
    void desktop.getPrivateImRunSummary(runId).then(
      (summary) => { if (!cancelled) setPrivateImSummary(summary); },
      () => { if (!cancelled) setPrivateImSummary(undefined); },
    );
    return () => { cancelled = true; };
  }, [desktop, navigationTarget?.runId, locationRetry]);

  useEffect(() => {
    if (!desktop || !active || !navigationTarget?.runId || !locatedRun || typeof locatedRun === 'string') return;
    if (['succeeded', 'failed', 'cancelled', 'interrupted', 'result_unknown'].includes(locatedRun.status)) return;
    let stale = false;
    const timer = window.setInterval(() => {
      void desktop.getAgentRun(navigationTarget.runId!).then((run) => {
        if (!stale) setLocatedRun(settledRuns.current.get(run.runId) ?? run);
      }).catch(() => { if (!stale) setLocatedRun('error'); });
    }, 1_200);
    return () => { stale = true; window.clearInterval(timer); };
  }, [desktop, active, navigationTarget?.runId, locatedRun]);

  useEffect(() => {
    if (!desktop || !active || !navigationTarget?.runId || !privateImSummary || privateImSummary === 'loading') return;
    if (!['not_created', 'pending', 'delivering'].includes(privateImSummary.replyDeliveryStatus)) return;
    const timer = window.setInterval(() => {
      void desktop.getPrivateImRunSummary(navigationTarget.runId!).then(setPrivateImSummary).catch(() => undefined);
    }, 1_200);
    return () => window.clearInterval(timer);
  }, [desktop, active, navigationTarget?.runId, privateImSummary]);

  useEffect(() => {
    conversation.current?.scrollTo({ top: conversation.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  useEffect(() => {
    if (navigationTarget?.runId && locatedRun && typeof locatedRun !== 'string') {
      conversation.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [navigationTarget?.runId, locatedRun]);

  async function observeRun(runId: string, text: string) {
    if (!desktop) return;
    let lastSeenStatus: AgentRunRecord['status'] | undefined;
    try {
      while (true) {
        const fetched = await desktop.getAgentRun(runId);
        const run = settledRuns.current.get(runId) ?? fetched;
        const terminal = ['succeeded', 'failed', 'cancelled', 'interrupted', 'result_unknown'].includes(run.status);
        if (terminal) settledRuns.current.set(runId, run);
        setLastRun(run);
        setActiveRunStatus(run.status);
        if (run.status !== lastSeenStatus) {
          const tone: ActivityEvent['tone'] = run.status === 'succeeded' ? 'done'
            : ['failed', 'interrupted', 'result_unknown'].includes(run.status) ? 'error'
              : ['waiting_approval', 'cancelled'].includes(run.status) ? 'warning' : 'active';
          recordActivity(run.runId, runStatusLabel(run.status), tone, run.failure?.message, run.updatedAt);
          lastSeenStatus = run.status;
        }
        if (terminal) {
          run.output?.tools.forEach((tool) => recordActivity(run.runId,
            tool.status === 'completed' ? '工具调用完成' : '工具调用失败',
            tool.status === 'completed' ? 'done' : 'error', tool.name, run.updatedAt));
          setMessages((current) => [...current, {
            id: nextId.current++, role: run.status === 'succeeded' ? 'assistant' : 'error',
            text: run.status === 'succeeded' ? run.output?.message ?? '任务已完成；可在运行记录中查看结果。'
              : run.failure?.message ?? `任务结束：${runStatusLabel(run.status)}`,
            tools: run.output?.tools.map((tool) => ({ name: tool.name, status: tool.status })),
          }]);
          if (run.status !== 'succeeded') setInput((current) => current || text);
          setRunRecovery(undefined);
          setActiveRunId(undefined);
          setActiveRunStatus(undefined);
          return;
        }
        await new Promise((resolveWait) => window.setTimeout(resolveWait, 900));
      }
    } catch (error) {
      // The accepted run may still be executing. Resume observation, never resubmit it.
      setRunRecovery({ runId, text });
      recordActivity(runId, '状态获取失败', 'error', formatError(error));
    }
  }

  async function resumeRun() {
    if (!runRecovery || sending.current) return;
    sending.current = true;
    setBusy(true);
    try { await observeRun(runRecovery.runId, runRecovery.text); }
    finally { sending.current = false; setBusy(false); }
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending.current || runRecovery) return;
    sending.current = true;
    setMessages((current) => [...current, { id: nextId.current++, role: 'user', text }]);
    setInput('');
    setBusy(true);
    setLastRun(undefined);
    setActiveRunStatus(undefined);
    try {
      if (!desktop) {
        setMessages((current) => [...current, { id: nextId.current++, role: 'assistant',
          text: '这是浏览器预览回复。通过 Electron 启动后，消息会交给 Pi coding-agent。' }]);
      } else {
        const receipt = await desktop.submitDesktopMessage(text);
        setActiveRunId(receipt.runId);
        setActiveRunStatus(receipt.status);
        recordActivity(receipt.runId, '已提交任务', 'done');
        await observeRun(receipt.runId, text);
      }
    } catch (error) {
      setMessages((current) => [...current, { id: nextId.current++, role: 'error', text: formatError(error) }]);
      recordActivity('submission', '提交失败', 'error', formatError(error));
      setInput((current) => current || text);
    } finally {
      sending.current = false;
      setBusy(false);
      void refreshApprovals().catch(() => setBridgeError(true));
    }
  }

  async function cancelRun(runId: string) {
    if (!desktop || cancelBusy || !window.confirm('取消这个正在执行的任务？已经发生的外部操作无法撤销。')) return;
    setCancelBusy(true);
    try {
      const receipt = await desktop.cancelAgentRun(runId);
      if (receipt.result === 'not_found') throw new Error('任务不可用或无权取消。');
      const run = await desktop.getAgentRun(runId);
      if (['succeeded', 'failed', 'cancelled', 'interrupted', 'result_unknown'].includes(run.status)) {
        settledRuns.current.set(runId, run);
      }
      if (navigationTarget?.runId === runId) setLocatedRun(run);
      if (runRecovery?.runId === runId) await resumeRun();
    } catch (error) {
      setMessages((current) => [...current, { id: nextId.current++, role: 'error', text: `取消失败：${formatError(error)}` }]);
    } finally {
      setCancelBusy(false);
    }
  }

  async function decideApproval(
    approval: CapabilityApprovalSummary,
    decision: 'approved' | 'denied',
  ) {
    if (!desktop || approvalBusy || !readyApprovals.has(approval.requestId)) return;
    setApprovalBusy(approval.requestId);
    try {
      const result = await desktop.decideCapabilityApproval(approval.requestId, decision);
      resolvedApprovals.current.add(approval.requestId);
      setApprovals((current) => current.filter((item) => item.requestId !== approval.requestId));
      if (approval.runId && [activeRunId, lastRun?.runId, navigationTarget?.runId].includes(approval.runId)) {
        recordActivity(approval.runId, decision === 'approved' ? '已允许一次' : '已拒绝授权', decision === 'approved' ? 'done' : 'warning', approval.capabilityId);
      }
      if (decision === 'denied') {
        setMessages((current) => [...current, {
          id: nextId.current++,
          role: 'assistant',
          text: `已拒绝能力 ${approval.capabilityId} 的本次调用，没有执行外部操作。`,
        }]);
        return;
      }
      if (approval.runId === activeRunId) {
        await refreshApprovals();
        return;
      }
      setMessages((current) => [...current, {
        id: nextId.current++,
        role: 'assistant',
        text: result.message ?? `能力 ${approval.capabilityId} 已执行。`,
      }]);
      await refreshApprovals();
    } catch (error) {
      setMessages((current) => [...current, {
        id: nextId.current++,
        role: 'error',
        text: `审批处理失败：${formatError(error)}`,
      }]);
    } finally {
      setApprovalBusy(undefined);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      void sendMessage();
    }
  }

  const visibleRun = navigationTarget?.runId
    ? (locatedRun && typeof locatedRun !== 'string' ? locatedRun : undefined)
    : lastRun;
  const currentStatus = visibleRun?.status ?? (navigationTarget?.runId ? undefined : activeRunStatus);
  const visibleEvents = navigationTarget?.runId
    ? activityEvents.filter((event) => event.runId === navigationTarget.runId)
    : activityEvents;

  return (
    <section className={`chat-panel ${activityOpen ? 'activity-open' : 'activity-closed'} ${active ? '' : 'view-hidden'}`} aria-hidden={!active}>
      <div className="chat-main">
        <header className="chat-header">
          <div className="chat-heading">
            <span className="chat-title-pill"><AppIcon name="menu" />聊天</span>
            <div className="runtime-state">
              <span className={`status-dot ${runtime.connected ? 'online' : ''}`} />
              <div>
                <strong>{bridgeError ? 'Runtime 连接中断' : runtime.connected ? '本地 Runtime 已连接' : desktop ? '正在连接 Runtime' : '浏览器预览模式'}</strong>
                <span>{runtime.connected ? '由本地助手调用已配置模型' : 'Electron 中启用真实 Pi 对话'}</span>
              </div>
            </div>
          </div>
          <div className="runtime-meta">
            <span>Pi {runtime.piVersion}</span>
            <span className="mcp-count">2 个 MCP 元工具</span>
            {navigationTarget && (
              <span role="status">
                {locatedRun === 'loading' || (locatedRun === 'error' && privateImSummary === 'loading')
                  ? '正在加载任务记录…'
                  : privateImSummary && privateImSummary !== 'loading'
                    ? `企业微信 · ${privateImSummary.runStatus} · ${privateImDeliveryLabel(privateImSummary.replyDeliveryStatus)}`
                  : locatedRun === 'error'
                    ? '任务记录不可用'
                    : locatedRun
                      ? `${locatedRun.owner.entryPoint === 'scheduler' ? '定时任务' : locatedRun.owner.entryPoint === 'im' ? '企业微信' : '桌面'} · ${locatedRun.status} · 会话 ${locatedRun.context.conversation.conversationId}`
                      : `已定位会话 ${navigationTarget.conversationId}`}
              </span>
            )}
            {locatedRun === 'error' && <button type="button" className="runtime-link" onClick={() => setLocationRetry((value) => value + 1)}>重新获取任务</button>}
            {scheduleOrigin && <button type="button" className="runtime-link" onClick={onReturnToSchedules}>返回定时任务</button>}
            {locatedRun && typeof locatedRun !== 'string' && ['queued', 'running', 'waiting_approval'].includes(locatedRun.status) && locatedRun.owner.entryPoint !== 'im' && (
              <button type="button" className="runtime-link" disabled={cancelBusy} onClick={() => void cancelRun(locatedRun.runId)}>取消运行</button>
            )}
            <button ref={activityToggle} hidden={activityOpen} type="button" className="panel-toggle" aria-label="打开会话动态" onClick={() => { restoreActivityFocus.current = true; setActivityOpen(true); }}><AppIcon name="panel" /></button>
          </div>
        </header>

        <div className="conversation" ref={conversation} aria-live="polite">
          <div className="conversation-inner">
            {locatedRun && typeof locatedRun !== 'string' && (
              <article className="located-run-card">
                <div className="approval-heading"><span>运行详情</span><strong>{locatedRun.owner.entryPoint === 'scheduler' ? '定时任务' : locatedRun.owner.entryPoint === 'im' ? '企业微信会话' : '桌面对话'}</strong></div>
                <dl>
                  <div><dt>运行状态</dt><dd>{locatedRun.status}</dd></div>
                  {locatedRun.owner.entryPoint === 'im' && <div><dt>回复投递</dt><dd>{privateImSummary && privateImSummary !== 'loading' ? privateImDeliveryLabel(privateImSummary.replyDeliveryStatus) : '状态暂不可用'}</dd></div>}
                  <div><dt>会话</dt><dd>{locatedRun.context.conversation.conversationId}</dd></div>
                  <div><dt>工作区</dt><dd>{locatedRun.context.workspaceId}</dd></div>
                </dl>
                {locatedRun.output?.message && <p>{locatedRun.output.message}</p>}
                {locatedRun.failure && <p role="alert">{locatedRun.failure.message}</p>}
                {scheduleOrigin && <button type="button" className="runtime-link" onClick={onReturnToSchedules}>返回关联定时任务</button>}
              </article>
            )}
            {locatedRun === 'error' && privateImSummary && privateImSummary !== 'loading' && (
              <article className="located-run-card">
                <div className="approval-heading"><span>运行详情</span><strong>企业微信私聊</strong></div>
                <dl>
                  <div><dt>运行状态</dt><dd>{privateImSummary.runStatus}</dd></div>
                  <div><dt>回复投递</dt><dd>{privateImDeliveryLabel(privateImSummary.replyDeliveryStatus)}</dd></div>
                </dl>
              </article>
            )}
            {messages.map((message) => (
              <article key={message.id} className={`message ${message.role}`}>
                <div className="message-label">
                  {message.role === 'user' ? '你' : message.role === 'error' ? '运行错误' : 'YuanpuAgent'}
                </div>
                <div className="message-body">
                  <p>{message.text}</p>
                  {message.tools?.map((tool) => (
                    <div className={`tool-event ${tool.status}`} key={`${message.id}-${tool.name}`}>
                      <span className="tool-check">{tool.status === 'completed' ? '✓' : '!'}</span>
                      <span>调用 MCP</span><code>{tool.name}</code>
                      <small>{tool.status === 'completed' ? '已完成' : '失败'}</small>
                    </div>
                  ))}
                </div>
              </article>
            ))}
            {approvals.map((approval) => (
              <article className="approval-card" key={approval.requestId}>
                <div className="approval-heading">
                  <span>待确认</span>
                  <strong>外部能力请求一次性授权</strong>
                </div>
                <dl>
                  <div><dt>能力</dt><dd>{approval.capabilityId}</dd></div>
                  <div><dt>来源</dt><dd>{approval.sourceInstanceId}</dd></div>
                  <div><dt>版本</dt><dd>{approval.packageVersion ?? '未声明'}</dd></div>
                  <div><dt>参数摘要</dt><dd><code>{approval.argumentsDigest.slice(0, 16)}…</code></dd></div>
                </dl>
                <p>允许只对当前会话、当前参数和当前版本生效一次；刷新或重放不会复用。</p>
                <div className="approval-actions">
                  <button type="button" disabled={Boolean(approvalBusy) || !readyApprovals.has(approval.requestId)} onClick={() => void decideApproval(approval, 'denied')}>拒绝</button>
                  <button type="button" className="primary" disabled={Boolean(approvalBusy) || !readyApprovals.has(approval.requestId)} onClick={() => void decideApproval(approval, 'approved')}>
                    {approvalBusy === approval.requestId ? '处理中…' : !readyApprovals.has(approval.requestId) ? '正在准备授权…' : '允许一次'}
                  </button>
                </div>
              </article>
            ))}
            {busy && (
              <article className="message assistant pending">
                <div className="message-label">YuanpuAgent</div>
                <div className="thinking"><span /><span /><span /> {activeRunStatus === 'waiting_approval' ? '等待授权' : 'Pi 正在处理'}{activeRunId && <button type="button" className="runtime-link" disabled={cancelBusy} onClick={() => void cancelRun(activeRunId)}>取消任务</button>}</div>
              </article>
            )}
          </div>
        </div>

        <div className="composer-wrap">
          {bridgeError && <p role="status">暂时无法读取授权状态，正在重连…</p>}
          {runRecovery && <div className="run-recovery" role="alert">
            <span>无法获取任务状态。任务可能仍在执行，请恢复查看后再发送。</span>
            <button type="button" disabled={busy} onClick={() => void resumeRun()}>重新获取状态</button>
            <button type="button" disabled={cancelBusy || busy} onClick={() => void cancelRun(runRecovery.runId)}>取消任务</button>
          </div>}
          <div className="composer">
            <textarea
              aria-label="消息"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="向 YuanpuAgent 发送消息…"
              rows={1}
            />
            <button type="button" onClick={() => void sendMessage()} disabled={!input.trim() || busy || Boolean(runRecovery)} aria-label="发送消息"><AppIcon name="send" /></button>
          </div>
          <p>Enter 发送 · Shift + Enter 换行 · 配置模型与密钥后即可开始</p>
        </div>
      </div>
      {activityOpen && (
        <dialog ref={activityDialog} className="activity-panel" aria-label="当前会话动态" onCancel={() => setActivityOpen(false)}>
          <button type="button" className="activity-close" aria-label="收起会话动态" onClick={() => { restoreActivityFocus.current = true; setActivityOpen(false); }}>×</button>
          <div className="assistant-profile">
            <div className="assistant-avatar" aria-hidden="true">源</div>
            <strong>Yuanpu Agent</strong>
            <span>你的本地工作助手</span>
          </div>
          <div className="activity-tabs" role="group" aria-label="会话信息">
            <button type="button" aria-pressed={activityTab === 'activity'} onClick={() => setActivityTab('activity')}>动态</button>
            <button type="button" aria-pressed={activityTab === 'run'} onClick={() => setActivityTab('run')}>运行</button>
          </div>
          {activityTab === 'activity' ? (
            <div className="activity-content">
              <div className="activity-section-heading">
                <h2>当前会话</h2>
                <span>{currentStatus ? runStatusLabel(currentStatus) : '等待新任务'}</span>
              </div>
              {visibleRun && <div className={`activity-current ${visibleRun.status}`}>
                <span className="activity-current-dot" />
                <div><strong>{runStatusLabel(visibleRun.status)}</strong><small>{visibleRun.owner.entryPoint === 'scheduler' ? '定时任务' : visibleRun.owner.entryPoint === 'im' ? '企业微信任务' : '桌面对话任务'}</small></div>
                <time>{activityTime(visibleRun.updatedAt)}</time>
              </div>}
              <h3>活动记录</h3>
              {visibleEvents.length > 0 ? (
                <ol className="activity-list">
                  {[...visibleEvents].reverse().map((event) => <li className={`activity-item ${event.tone}`} key={event.id}>
                    <span className="activity-symbol" aria-hidden="true">{event.tone === 'done' ? '✓' : event.tone === 'error' ? '!' : event.tone === 'warning' ? '·' : '••'}</span>
                    <div><strong>{event.title}</strong>{event.detail && <small>{event.detail}</small>}<time>{activityTime(event.at)}</time></div>
                  </li>)}
                </ol>
              ) : visibleRun ? (
                <div className="activity-empty"><strong>{runStatusLabel(visibleRun.status)}</strong><span>该任务的详细过程暂无记录。</span></div>
              ) : (
                <div className="activity-empty"><strong>还没有运行记录</strong><span>发送消息后，当前会话的任务状态会显示在这里。</span></div>
              )}
            </div>
          ) : (
            <div className="activity-content">
              <h2>最近一次运行</h2>
              {visibleRun ? <dl className="activity-run-facts">
                <div><dt>状态</dt><dd>{runStatusLabel(visibleRun.status)}</dd></div>
                <div><dt>来源</dt><dd>{visibleRun.owner.entryPoint === 'scheduler' ? '定时任务' : visibleRun.owner.entryPoint === 'im' ? '企业微信' : '桌面'}</dd></div>
                <div><dt>开始</dt><dd>{new Date(visibleRun.createdAt).toLocaleString('zh-CN')}</dd></div>
                <div><dt>更新</dt><dd>{new Date(visibleRun.updatedAt).toLocaleString('zh-CN')}</dd></div>
                <div><dt>运行 ID</dt><dd><code>{visibleRun.runId}</code></dd></div>
              </dl> : <div className="activity-empty"><strong>还没有运行记录</strong><span>任务提交后可在这里查看状态与时间。</span></div>}
            </div>
          )}
        </dialog>
      )}
    </section>
  );
}

function App() {
  const [view, setView] = useState<AppView>('chat');
  const [configRoot, setConfigRoot] = useState('~/.yuanpu');
  const [notificationTarget, setNotificationTarget] = useState<NotificationNavigationTarget>();
  const [selectedScheduleId, setSelectedScheduleId] = useState<string>();
  const [runtimeRecoveryNotice, setRuntimeRecoveryNotice] = useState<RuntimeRecoveryNotice>();

  useEffect(() => {
    void window.yuanpu?.runtimeInfo()
      .then((info) => setConfigRoot(info.configRoot))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void window.yuanpu?.runtimeRecoveryNotice()
      .then(setRuntimeRecoveryNotice)
      .catch(() => undefined);
  }, []);

  useEffect(() => window.yuanpu?.onNotificationNavigation((target) => {
    setNotificationTarget(target);
    setSelectedScheduleId(undefined);
    setView('chat');
  }), []);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="window-controls-space" aria-hidden="true">
          {!window.yuanpu && <div className="window-controls-preview"><span /><span /><span /></div>}
        </div>
        <div className="brand">
          <div className="brand-mark">源</div>
        </div>

        <nav className="sidebar-nav" aria-label="主导航">
          <button
            className={`nav-item ${view === 'chat' ? 'active' : ''}`}
            type="button"
            aria-label="聊天"
            aria-current={view === 'chat' ? 'page' : undefined}
            onClick={() => setView('chat')}
          >
            <AppIcon name="chat" /><span className="nav-label">聊天</span>
          </button>
          <button
            className={`nav-item ${view === 'skills' ? 'active' : ''}`}
            type="button"
            aria-label="技能"
            aria-current={view === 'skills' ? 'page' : undefined}
            onClick={() => setView('skills')}
          >
            <AppIcon name="skills" /><span className="nav-label">技能</span>
          </button>
          <button
            className={`nav-item ${view === 'connections' ? 'active' : ''}`}
            type="button"
            aria-label="连接"
            aria-current={view === 'connections' ? 'page' : undefined}
            onClick={() => setView('connections')}
          >
            <AppIcon name="connections" /><span className="nav-label">连接</span>
          </button>
          <button
            className={`nav-item ${view === 'schedules' ? 'active' : ''}`}
            type="button"
            aria-label="定时任务"
            aria-current={view === 'schedules' ? 'page' : undefined}
            onClick={() => setView('schedules')}
          >
            <AppIcon name="schedules" /><span className="nav-label">定时任务</span>
          </button>
        </nav>

        <div className="sidebar-footer" role="note" title={`配置目录：${configRoot}`} aria-label={`配置目录：${configRoot}`} />
      </aside>

      {runtimeRecoveryNotice && (
        <div className="runtime-recovery-notice" role="alert">
          <div>
            <strong>{runtimeRecoveryNotice.kind === 'incompatible_protocol' ? 'Runtime 协议不兼容' : 'Runtime 更新失败'}</strong>
            <span>已恢复上一版本，当前 App 可继续使用。请检查更新后再重试。</span>
          </div>
          <button type="button" aria-label="关闭 Runtime 更新提示" onClick={() => setRuntimeRecoveryNotice(undefined)}>关闭</button>
        </div>
      )}

      <ChatPanel active={view === 'chat'} navigationTarget={notificationTarget} scheduleOrigin={Boolean(selectedScheduleId)} onReturnToSchedules={() => setView('schedules')} />
      <SkillPage active={view === 'skills'} />
      <ConnectionManagement active={view === 'connections'} />
      <ScheduleManagement
        active={view === 'schedules'}
        requestedScheduleId={selectedScheduleId}
        onOpenRun={(runId, conversationId, scheduleId) => {
          setSelectedScheduleId(scheduleId);
          setNotificationTarget({ runId, conversationId });
          setView('chat');
        }}
      />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
