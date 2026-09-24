import type { ReactNode } from 'react';
import type { NotificationNavigationTarget } from '@yuanpu-agent/protocol';
import { ScheduleManagement } from '../management.js';
import { createUiRegistry, type UiDestination } from '../ui-registry.js';
import { ChatPanel } from '../modules/chat.js';
import { SkillPage } from '../modules/skills.js';
import { KnowledgePage } from '../modules/knowledge.js';
import { SettingsPage } from '../modules/settings.js';

type AppView = UiDestination;

interface PageContext {
  active: boolean;
  configRoot: string;
  notificationTarget?: NotificationNavigationTarget;
  selectedScheduleId?: string;
  openScheduledRun: (runId: string, conversationId: string, scheduleId: string) => void;
  navigate: (view: AppView) => void;
}

export const uiRegistry = createUiRegistry<(context: PageContext) => ReactNode>();
uiRegistry.register({ id: 'work', label: '工作', order: 10, render: ({ active, notificationTarget, selectedScheduleId, navigate }) =>
  <ChatPanel active={active} surface="work" navigationTarget={notificationTarget} scheduleOrigin={Boolean(selectedScheduleId)} onReturnToSchedules={() => navigate('schedules')} /> });
uiRegistry.register({ id: 'assistant', label: '助理', order: 20, render: ({ active }) =>
  <ChatPanel active={active} surface="assistant" scheduleOrigin={false} onReturnToSchedules={() => undefined} /> });
uiRegistry.register({ id: 'skills', label: '技能', order: 30, render: ({ active }) => <SkillPage active={active} /> });
uiRegistry.register({ id: 'schedules', label: '定时任务', order: 40, render: ({ active, selectedScheduleId, openScheduledRun }) =>
  <ScheduleManagement active={active} requestedScheduleId={selectedScheduleId} onOpenRun={openScheduledRun} /> });
uiRegistry.register({ id: 'knowledge', label: '知识库', order: 50, render: ({ active }) => <KnowledgePage active={active} /> });
uiRegistry.register({ id: 'settings', label: '设置', order: 60, render: ({ active, configRoot }) => <SettingsPage active={active} configRoot={configRoot} /> });
