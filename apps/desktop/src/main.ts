import { join } from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';

import { RuntimeManager } from './runtime-manager.js';

let runtime: RuntimeManager;

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

  ipcMain.handle('runtime:info', () => runtime.info());
  ipcMain.handle('runtime:greeting', (_event, name: string) => runtime.greeting(name));
  ipcMain.handle('runtime:chat', (_event, message: string) => runtime.chat(message));
  ipcMain.handle('runtime:update', () => runtime.checkForUpdate());
  ipcMain.handle('plugins:search', (_event, query: string) => runtime.searchPlugins(query));
  ipcMain.handle('plugins:list', () => runtime.listPlugins());
  ipcMain.handle('skills:local', () => runtime.listLocalSkills());
  ipcMain.handle('plugins:install', (_event, source: string) => runtime.installPlugin(source));
  ipcMain.handle('plugins:state', (_event, name: string, enabled: boolean) => (
    runtime.setPluginEnabled(name, enabled)
  ));
  ipcMain.handle('plugins:uninstall', (_event, name: string) => runtime.uninstallPlugin(name));
  ipcMain.handle('plugins:config:get', (_event, name, scope) => runtime.getPluginConfig(name, scope));
  ipcMain.handle('plugins:config:validate', (_event, input) => runtime.validatePluginConfig(input));
  ipcMain.handle('plugins:config:save', (_event, input) => runtime.savePluginConfig(input));
  ipcMain.handle('plugins:config:reset', (_event, name, scope) => runtime.resetPluginConfig(name, scope));
  ipcMain.handle('desktop:update', async () => {
    if (!app.isPackaged) throw new Error('Desktop updates are only available in packaged builds');
    await autoUpdater.checkForUpdates();
  });

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
