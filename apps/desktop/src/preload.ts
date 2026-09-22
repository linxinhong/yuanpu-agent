import type { DesktopBridge } from '@yuanpu-agent/protocol';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const bridge: DesktopBridge = {
  runtimeInfo: () => ipcRenderer.invoke('runtime:info'),
  greeting: (name) => ipcRenderer.invoke('runtime:greeting', name),
  chat: (message) => ipcRenderer.invoke('runtime:chat', message),
  getAgentRun: (runId) => ipcRenderer.invoke('agent:runs:get', runId),
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
