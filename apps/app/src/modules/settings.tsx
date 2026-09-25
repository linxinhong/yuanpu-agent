import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ConnectionManagement } from '../management.js';
import { ModelSettingsPanel } from './model-settings.js';
import { applyThemePreference, readThemePreference, type RendererTheme } from '../shared/theme-preference.js';

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function AssistantLinkSettings({ active }: { active: boolean }) {
  const desktop = window.yuanpu;
  const query = useQuery({ queryKey: ['assistant', 'link'], queryFn: () => desktop!.getAssistantLink(), enabled: active && Boolean(desktop) });
  const contacts = useQuery({ queryKey: ['assistant', 'contacts'], queryFn: () => desktop!.listSchedulePrivateContacts(), enabled: active && Boolean(desktop) });
  const client = useQueryClient();
  const [selectedContact, setSelectedContact] = useState('');
  const [operationError, setOperationError] = useState('');
  const bind = useMutation({ mutationFn: (contactId: string) => desktop!.bindAssistantContact(contactId),
    onSuccess: () => { setOperationError(''); void client.invalidateQueries({ queryKey: ['assistant'] }); },
    onError: (error) => setOperationError(formatError(error)),
  });
  const unbind = useMutation({ mutationFn: () => desktop!.unbindAssistantContact(),
    onSuccess: () => { setOperationError(''); void client.invalidateQueries({ queryKey: ['assistant'] }); },
    onError: (error) => setOperationError(formatError(error)),
  });
  return <section className="assistant-link-settings" aria-label="助理企业微信会话绑定">
    <h2>助理会话</h2>
    <p>绑定一位已配对联系人后，桌面助理接续该私聊历史。桌面发出的消息与回复也会投递到该企业微信私聊。</p>
    {!desktop && <p>请在桌面应用中管理跨渠道会话。</p>}
    {query.isLoading && <p>正在读取绑定状态…</p>}
    {query.error && <p role="alert">{formatError(query.error)}</p>}
    {query.data?.linked ? <div className="assistant-link-row"><span>已绑定 · {query.data.connectionId} · 联系人 {query.data.contactId}</span>
      <button type="button" disabled={unbind.isPending} onClick={() => unbind.mutate()}>{unbind.isPending ? '解除中…' : '解除绑定'}</button></div>
      : desktop && <div className="assistant-link-row"><label htmlFor="assistant-contact">选择已配对联系人</label>
        <select id="assistant-contact" value={selectedContact} onChange={(event) => setSelectedContact(event.target.value)}>
          <option value="">请选择</option>
          {contacts.data?.map((contact) => <option key={contact.contactId} value={contact.contactId}>
            {contact.connectionId} · 最近消息 {new Date(contact.lastSeenAt).toLocaleString('zh-CN')}
          </option>)}
        </select><button type="button" disabled={!selectedContact || bind.isPending} onClick={() => bind.mutate(selectedContact)}>
          {bind.isPending ? '绑定中…' : '绑定助理会话'}</button></div>}
    {contacts.error && <p role="alert">联系人读取失败：{formatError(contacts.error)}</p>}
    {operationError && <p role="alert">{operationError}</p>}
    <p className="assistant-link-note">绑定时以企业微信原会话继续；桌面原会话保留，解除后恢复。正在运行的会话不能切换绑定。</p>
  </section>;
}

export function SettingsPage({ active, configRoot }: { active: boolean; configRoot: string }) {
  const [section, setSection] = useState<'general' | 'models' | 'connections'>('general');
  const [theme, setTheme] = useState<RendererTheme>(readThemePreference);
  const selectTheme = (nextTheme: RendererTheme) => {
    applyThemePreference(nextTheme);
    setTheme(nextTheme);
  };
  return <section className={`settings-page ${active ? '' : 'view-hidden'}`} aria-hidden={!active}>
    <aside className="settings-navigation"><span className="eyebrow">YUANPU / SETTINGS</span><h1>设置</h1>
      <button type="button" className={section === 'general' ? 'selected' : ''} onClick={() => setSection('general')}>通用</button>
      <button type="button" className={section === 'models' ? 'selected' : ''} onClick={() => setSection('models')}>模型</button>
      <button type="button" className={section === 'connections' ? 'selected' : ''} onClick={() => setSection('connections')}>企业微信连接</button>
    </aside>
    <div className="settings-content">
      <div className={`settings-general ${section === 'general' ? '' : 'view-hidden'}`} aria-hidden={section !== 'general'}><h2>通用</h2>
        <div className="theme-setting"><h3>界面主题</h3><p>选择界面配色。MindLink 为临时测试主题。</p>
          <div className="theme-options" role="group" aria-label="界面主题">
            <button type="button" aria-pressed={theme === 'yuanpu-light'} onClick={() => selectTheme('yuanpu-light')}>浅色</button>
            <button type="button" aria-pressed={theme === 'yuanpu-dark'} onClick={() => selectTheme('yuanpu-dark')}>深色</button>
            <button type="button" aria-pressed={theme === 'mindlink'} onClick={() => selectTheme('mindlink')}>MindLink 测试主题</button>
          </div>
        </div>
        <p>当前配置目录</p><code>{configRoot}</code>
        <p>运行状态、更新与权限仍由桌面应用和 Runtime 管理。</p></div>
      <div className={`settings-connections ${section === 'connections' ? '' : 'view-hidden'}`} aria-hidden={section !== 'connections'}>
        <AssistantLinkSettings active={active && section === 'connections'} />
        <ConnectionManagement active={active && section === 'connections'} />
      </div>
      <div className={`settings-models-view ${section === 'models' ? '' : 'view-hidden'}`} aria-hidden={section !== 'models'}>
        <ModelSettingsPanel active={active && section === 'models'} />
      </div>
    </div>
  </section>;
}
