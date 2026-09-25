import type { DesktopBridge } from '@yuanpu-agent/protocol';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const bridge: DesktopBridge = {
  runtimeInfo: () => ipcRenderer.invoke('runtime:info'),
  getModelSettings: () => ipcRenderer.invoke('settings:models:get'),
  getModelCatalog: (provider) => ipcRenderer.invoke('settings:models:catalog', provider),
  saveModelSettings: (input) => ipcRenderer.invoke('settings:models:save', input),
  deleteModelSettings: (provider, model) => ipcRenderer.invoke('settings:models:delete', provider, model),
  runtimeRecoveryNotice: () => ipcRenderer.invoke('runtime:recovery-notice'),
  greeting: (name) => ipcRenderer.invoke('runtime:greeting', name),
  chat: (message) => ipcRenderer.invoke('runtime:chat', message),
  submitDesktopMessage: (message, surface) => ipcRenderer.invoke('runtime:chat:submit', message, surface),
  getDesktopTranscript: (surface) => ipcRenderer.invoke('desktop:transcript', surface),
  getAssistantLink: () => ipcRenderer.invoke('assistant:link:get'),
  bindAssistantContact: (contactId) => ipcRenderer.invoke('assistant:link:bind', contactId),
  unbindAssistantContact: () => ipcRenderer.invoke('assistant:link:unbind'),
  listAssistantMirrors: (runId) => ipcRenderer.invoke('assistant:mirrors:list', runId),
  retryAssistantMirror: (mirrorId) => ipcRenderer.invoke('assistant:mirrors:retry', mirrorId),
  getAgentRun: (runId) => ipcRenderer.invoke('agent:runs:get', runId),
  getPrivateImRunSummary: (runId) => ipcRenderer.invoke('im:private-runs:summary', runId),
  cancelAgentRun: (runId) => ipcRenderer.invoke('agent:runs:cancel', runId),
  listSchedules: () => ipcRenderer.invoke('schedules:list'),
  createSchedule: (input) => ipcRenderer.invoke('schedules:create', input),
  previewSchedule: (input) => ipcRenderer.invoke('schedules:preview', input),
  updateSchedule: (scheduleId, input) => ipcRenderer.invoke('schedules:update', scheduleId, input),
  setScheduleEnabled: (scheduleId, enabled) => ipcRenderer.invoke('schedules:enabled', scheduleId, enabled),
  getScheduleHistory: (scheduleId, limit) => ipcRenderer.invoke('schedules:history', scheduleId, limit),
  listSchedulePrivateContacts: () => ipcRenderer.invoke('schedules:contacts:list'),
  bindSchedulePrivateContact: (contactId) => ipcRenderer.invoke('schedules:contacts:bind', contactId),
  revokeSchedulePrivateTarget: (routeId) => ipcRenderer.invoke('schedules:targets:revoke', routeId),
  listWecomConnections: () => ipcRenderer.invoke('connections:wecom:list'),
  testWecomConnection: (connectionId) => ipcRenderer.invoke('connections:wecom:test', connectionId),
  saveWecomConnection: (input) => ipcRenderer.invoke('connections:wecom:save', input),
  checkRuntimeUpdate: () => ipcRenderer.invoke('runtime:update'),
  checkDesktopUpdate: () => ipcRenderer.invoke('desktop:update'),
  searchPlugins: (query) => ipcRenderer.invoke('plugins:search', query),
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  listLocalSkills: () => ipcRenderer.invoke('skills:local'),
  installPlugin: (source, artifactManifestDigest) => (
    ipcRenderer.invoke('plugins:install', source, artifactManifestDigest)
  ),
  setPluginEnabled: (name, enabled) => ipcRenderer.invoke('plugins:state', name, enabled),
  uninstallPlugin: (name) => ipcRenderer.invoke('plugins:uninstall', name),
  getPluginConfig: (name, scope) => ipcRenderer.invoke('plugins:config:get', name, scope),
  validatePluginConfig: (input) => ipcRenderer.invoke('plugins:config:validate', input),
  savePluginConfig: (input) => ipcRenderer.invoke('plugins:config:save', input),
  resetPluginConfig: (name, scope) => ipcRenderer.invoke('plugins:config:reset', name, scope),
  rollbackPlugin: (name, version) => ipcRenderer.invoke('plugins:rollback', name, version),
  listMcpOwnershipConflicts: (source, artifactManifestDigest) => (
    ipcRenderer.invoke('plugins:mcp-conflicts', source, artifactManifestDigest)
  ),
  listCapabilityApprovals: () => ipcRenderer.invoke('capabilities:approvals:list'),
  decideCapabilityApproval: (requestId, decision) => (
    ipcRenderer.invoke('capabilities:approvals:decide', requestId, decision)
  ),
  onNotificationNavigation: (listener) => {
    const handler = (_event: IpcRendererEvent, target: Parameters<typeof listener>[0]) => listener(target);
    ipcRenderer.on('notifications:navigate', handler);
    return () => ipcRenderer.removeListener('notifications:navigate', handler);
  },
};

contextBridge.exposeInMainWorld('yuanpu', bridge);
