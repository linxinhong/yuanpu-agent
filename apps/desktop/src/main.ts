import { join } from 'node:path';

import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { autoUpdater } from 'electron-updater';

import { RuntimeManager } from './runtime-manager.js';

let runtime: RuntimeManager;
let mainWindow: BrowserWindow | undefined;

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow
    || event.sender !== mainWindow.webContents
    || event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('Rejected IPC from an untrusted renderer frame');
  }
}

function trustedHandler(listener: (...args: any[]) => unknown) {
  return (event: IpcMainInvokeEvent, ...args: any[]) => {
    assertTrustedRenderer(event);
    return listener(...args);
  };
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 800,
    minHeight: 560,
    backgroundColor: '#0d1117',
    title: 'Yuanpu Agent',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
  });

  const rendererUrl = process.env.YUANPU_RENDERER_URL;
  if (rendererUrl) void window.loadURL(rendererUrl);
  else void window.loadFile(join(process.resourcesPath, 'app', 'index.html'));
}

app.whenReady().then(async () => {
  runtime = new RuntimeManager(
    app.getAppPath(),
    process.resourcesPath,
    app.getPath('userData'),
    app.isPackaged,
    app.getVersion(),
  );

  ipcMain.handle('runtime:info', trustedHandler(() => runtime.info()));
  ipcMain.handle('runtime:greeting', trustedHandler((name: string) => runtime.greeting(name)));
  ipcMain.handle('runtime:chat', trustedHandler((message: string) => runtime.chat(message)));
  ipcMain.handle('runtime:update', trustedHandler(() => runtime.checkForUpdate()));
  ipcMain.handle('plugins:search', trustedHandler((query: string) => runtime.searchPlugins(query)));
  ipcMain.handle('plugins:list', trustedHandler(() => runtime.listPlugins()));
  ipcMain.handle('skills:local', trustedHandler(() => runtime.listLocalSkills()));
  ipcMain.handle('plugins:install', trustedHandler((source: string) => runtime.installPlugin(source)));
  ipcMain.handle('plugins:state', trustedHandler((name: string, enabled: boolean) => (
    runtime.setPluginEnabled(name, enabled)
  )));
  ipcMain.handle('plugins:uninstall', trustedHandler((name: string) => runtime.uninstallPlugin(name)));
  ipcMain.handle('plugins:config:get', trustedHandler((name, scope) => runtime.getPluginConfig(name, scope)));
  ipcMain.handle('plugins:config:validate', trustedHandler((input) => runtime.validatePluginConfig(input)));
  ipcMain.handle('plugins:config:save', trustedHandler((input) => runtime.savePluginConfig(input)));
  ipcMain.handle('plugins:config:reset', trustedHandler((name, scope) => runtime.resetPluginConfig(name, scope)));
  ipcMain.handle('plugins:rollback', trustedHandler((name: string, version: string) => (
    runtime.rollbackPlugin(name, version)
  )));
  ipcMain.handle('capabilities:approvals:list', trustedHandler(() => runtime.listCapabilityApprovals()));
  ipcMain.handle('capabilities:approvals:decide', trustedHandler((requestId, decision) => (
    runtime.decideCapabilityApproval(requestId, decision)
  )));
  ipcMain.handle('desktop:update', trustedHandler(async () => {
    if (!app.isPackaged) throw new Error('Desktop updates are only available in packaged builds');
    await autoUpdater.checkForUpdates();
  }));

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (error) => console.error('Desktop update failed:', error.message));
  await runtime.start();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => runtime?.stop());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
