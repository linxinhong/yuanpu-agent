import type { DesktopBridge } from '@yuanpu-agent/protocol';
import { contextBridge, ipcRenderer } from 'electron';

const bridge: DesktopBridge = {
  runtimeInfo: () => ipcRenderer.invoke('runtime:info'),
  greeting: (name) => ipcRenderer.invoke('runtime:greeting', name),
  chat: (message) => ipcRenderer.invoke('runtime:chat', message),
  checkRuntimeUpdate: () => ipcRenderer.invoke('runtime:update'),
  checkDesktopUpdate: () => ipcRenderer.invoke('desktop:update'),
  searchPlugins: (query) => ipcRenderer.invoke('plugins:search', query),
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  listLocalSkills: () => ipcRenderer.invoke('skills:local'),
  installPlugin: (source) => ipcRenderer.invoke('plugins:install', source),
  setPluginEnabled: (name, enabled) => ipcRenderer.invoke('plugins:state', name, enabled),
  uninstallPlugin: (name) => ipcRenderer.invoke('plugins:uninstall', name),
  getPluginConfig: (name, scope) => ipcRenderer.invoke('plugins:config:get', name, scope),
  validatePluginConfig: (input) => ipcRenderer.invoke('plugins:config:validate', input),
  savePluginConfig: (input) => ipcRenderer.invoke('plugins:config:save', input),
  resetPluginConfig: (name, scope) => ipcRenderer.invoke('plugins:config:reset', name, scope),
  rollbackPlugin: (name, version) => ipcRenderer.invoke('plugins:rollback', name, version),
  listCapabilityApprovals: () => ipcRenderer.invoke('capabilities:approvals:list'),
  decideCapabilityApproval: (requestId, decision) => (
    ipcRenderer.invoke('capabilities:approvals:decide', requestId, decision)
  ),
};

contextBridge.exposeInMainWorld('yuanpu', bridge);
