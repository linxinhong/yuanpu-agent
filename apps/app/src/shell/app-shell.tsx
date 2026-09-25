import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { NotificationNavigationTarget, RuntimeRecoveryNotice } from '@yuanpu-agent/protocol';
import type { UiDestination } from '../ui-registry.js';
import { AppIcon } from '../shared/app-icon.js';
import { AvatarMark } from '../shared/avatar-mark.js';
import { BrandShowcase } from '../shared/brand-showcase.js';

import { uiRegistry } from '../composition/catalog.js';

type AppView = UiDestination;

export function App() {
  const location = useLocation();
  const routerNavigate = useNavigate();
  const destinations = useSyncExternalStore(uiRegistry.subscribe, uiRegistry.getSnapshot);
  const routeId = location.pathname.slice(1).split('/')[0];
  const view: AppView = destinations.some((entry) => entry.id === routeId) ? routeId as AppView : 'work';
  const setView = (destination: AppView) => routerNavigate(`/${destination}`);
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
    routerNavigate('/work');
  }), [routerNavigate]);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="window-controls-space" aria-hidden="true">
          {!window.yuanpu && <div className="window-controls-preview"><span /><span /><span /></div>}
        </div>
        <nav className="sidebar-nav" aria-label="主导航">{destinations.filter((entry) => entry.id !== 'settings').map((entry) =>
          <button key={entry.id} className={`nav-item ${view === entry.id ? 'active' : ''}`} type="button"
            title={entry.label} aria-label={entry.label} aria-current={view === entry.id ? 'page' : undefined} onClick={() => setView(entry.id)}>
            <AppIcon name={entry.id} /><span className="nav-label">{entry.label}</span>
          </button>)}</nav>

        <div className="sidebar-bottom">
          <BrandShowcase variant="yuanpu" />
          <button className={`sidebar-footer settings-trigger ${view === 'settings' ? 'active' : ''}`} type="button"
            title="设置" aria-label="设置" onClick={() => setView('settings')}><AppIcon name="settings" /></button>
          <div className="profile-avatar" role="img" aria-label="Yuanpu Agent 头像"><AvatarMark /></div>
        </div>
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

      {destinations.map((entry) => <div className={`page-host ${view === entry.id ? '' : 'view-hidden'}`} key={entry.id}>
        {entry.render({
          active: view === entry.id,
          configRoot,
          notificationTarget,
          selectedScheduleId,
          navigate: setView,
          openScheduledRun: (runId, conversationId, scheduleId) => {
            setSelectedScheduleId(scheduleId);
            setNotificationTarget({ runId, conversationId });
            setView('work');
          },
        })}
      </div>)}
      <aside className="brand-rail" aria-label="品牌"><BrandShowcase variant="mindlink" /></aside>
    </main>
  );
}
