import type { DesktopBridge } from '@yuanpu-agent/protocol';
import { contextBridge, ipcRenderer } from 'electron';

const bridge: DesktopBridge = {
  runtimeInfo: () => ipcRenderer.invoke('runtime:info'),
  greeting: (name) => ipcRenderer.invoke('runtime:greeting', name),
  checkRuntimeUpdate: () => ipcRenderer.invoke('runtime:update'),
  checkDesktopUpdate: () => ipcRenderer.invoke('desktop:update'),
};

contextBridge.exposeInMainWorld('yuanpu', bridge);
