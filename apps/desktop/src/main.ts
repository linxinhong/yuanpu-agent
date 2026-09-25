import { join } from 'node:path';

import { app, BrowserWindow, dialog, ipcMain, Notification, type IpcMainInvokeEvent } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { NotificationNavigationTarget, RuntimeRecoveryNotice } from '@yuanpu-agent/protocol';

import { RuntimeManager } from './runtime-manager.js';
import { ElectronNotificationHost, type NativeNotification } from './notification-host.js';
import { isTrustedRendererUrl, packagedRendererUrl } from './renderer-security.js';

let runtime: RuntimeManager;
let mainWindow: BrowserWindow | undefined;
let trustedRendererEntry = '';
let quitInProgress = false;
let quitAllowed = false;
let notificationHost: ElectronNotificationHost | undefined;
let pendingNotificationTarget: NotificationNavigationTarget | undefined;
let notificationsEnabled = true;
let runtimeRecoveryNotice: RuntimeRecoveryNotice | undefined;

function flushNotificationNavigation(): void {
  if (!mainWindow || mainWindow.webContents.isLoadingMainFrame() || !pendingNotificationTarget) return;
  mainWindow.webContents.send('notifications:navigate', pendingNotificationTarget);
  pendingNotificationTarget = undefined;
}

function focusMainWindow(): void {
  if (!mainWindow) createWindow();
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow
    || event.sender !== mainWindow.webContents
    || event.senderFrame !== mainWindow.webContents.mainFrame
    || !isTrustedRendererUrl(event.senderFrame.url, trustedRendererEntry)
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
    backgroundColor: '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    title: 'Yuanpu Agent',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  window.webContents.on('did-finish-load', flushNotificationNavigation);
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl, trustedRendererEntry)) event.preventDefault();
  });

  if (!app.isPackaged && process.env.YUANPU_RENDERER_URL) {
    trustedRendererEntry = process.env.YUANPU_RENDERER_URL;
    void window.loadURL(trustedRendererEntry);
  } else {
    const rendererFile = join(process.resourcesPath, 'app', 'index.html');
    trustedRendererEntry = packagedRendererUrl(rendererFile);
    void window.loadFile(rendererFile);
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

if (hasSingleInstanceLock) void app.whenReady().then(async () => {
  runtime = new RuntimeManager(
    app.getAppPath(),
    process.resourcesPath,
    app.getPath('userData'),
    app.isPackaged,
    app.getVersion(),
    {
      onUpdateRecovery: (kind) => { runtimeRecoveryNotice = { kind }; },
    },
  );

  ipcMain.handle('runtime:info', trustedHandler(() => runtime.info()));
  ipcMain.handle('settings:models:get', trustedHandler(() => runtime.getModelSettings()));
  ipcMain.handle('settings:models:catalog', trustedHandler((provider) => runtime.getModelCatalog(provider)));
  ipcMain.handle('settings:models:save', trustedHandler((input) => runtime.saveModelSettings(input)));
  ipcMain.handle('settings:models:delete', trustedHandler((provider, model) => runtime.deleteModelSettings(provider, model)));
  ipcMain.handle('runtime:recovery-notice', trustedHandler(() => runtimeRecoveryNotice));
  ipcMain.handle('runtime:greeting', trustedHandler((name: string) => runtime.greeting(name)));
  ipcMain.handle('runtime:chat', trustedHandler((message: string) => runtime.chat(message)));
  ipcMain.handle('runtime:chat:submit', trustedHandler((message: string, surface?: 'work' | 'assistant') => runtime.submitDesktopMessage(message, surface)));
  ipcMain.handle('desktop:transcript', trustedHandler((surface: 'work' | 'assistant' | 'assistantArchive') => runtime.getDesktopTranscript(surface)));
  ipcMain.handle('assistant:link:get', trustedHandler(() => runtime.getAssistantLink()));
  ipcMain.handle('assistant:link:bind', trustedHandler((contactId: string) => runtime.bindAssistantContact(contactId)));
  ipcMain.handle('assistant:link:unbind', trustedHandler(() => runtime.unbindAssistantContact()));
  ipcMain.handle('assistant:mirrors:list', trustedHandler((runId: string) => runtime.listAssistantMirrors(runId)));
  ipcMain.handle('assistant:mirrors:retry', trustedHandler((mirrorId: string) => runtime.retryAssistantMirror(mirrorId)));
  ipcMain.handle('agent:runs:get', trustedHandler((runId: string) => runtime.getAgentRun(runId)));
  ipcMain.handle('im:private-runs:summary', trustedHandler((runId: string) => runtime.getPrivateImRunSummary(runId)));
  ipcMain.handle('agent:runs:cancel', trustedHandler((runId: string) => runtime.cancelAgentRun(runId)));
  ipcMain.handle('schedules:list', trustedHandler(() => runtime.listSchedules()));
  ipcMain.handle('schedules:create', trustedHandler((input) => runtime.createSchedule(input)));
  ipcMain.handle('schedules:preview', trustedHandler((input) => runtime.previewSchedule(input)));
  ipcMain.handle('schedules:update', trustedHandler((scheduleId, input) => runtime.updateSchedule(scheduleId, input)));
  ipcMain.handle('schedules:enabled', trustedHandler((scheduleId, enabled) => (
    runtime.setScheduleEnabled(scheduleId, enabled)
  )));
  ipcMain.handle('schedules:history', trustedHandler((scheduleId, limit) => (
    runtime.getScheduleHistory(scheduleId, limit)
  )));
  ipcMain.handle('schedules:contacts:list', trustedHandler(() => runtime.listSchedulePrivateContacts()));
  ipcMain.handle('schedules:contacts:bind', trustedHandler((contactId) => runtime.bindSchedulePrivateContact(contactId)));
  ipcMain.handle('schedules:targets:revoke', trustedHandler((routeId) => (
    runtime.revokeSchedulePrivateTarget(routeId)
  )));
  ipcMain.handle('connections:wecom:list', trustedHandler(() => runtime.listWecomConnections()));
  ipcMain.handle('connections:wecom:test', trustedHandler((connectionId) => runtime.testWecomConnection(connectionId)));
  ipcMain.handle('connections:wecom:save', trustedHandler((input) => runtime.saveWecomConnection(input)));
  ipcMain.handle('runtime:update', trustedHandler(() => runtime.checkForUpdate()));
  ipcMain.handle('plugins:search', trustedHandler((query: string) => runtime.searchPlugins(query)));
  ipcMain.handle('plugins:list', trustedHandler(() => runtime.listPlugins()));
  ipcMain.handle('skills:local', trustedHandler(() => runtime.listLocalSkills()));
  ipcMain.handle('plugins:install', trustedHandler((source: string, artifactManifestDigest?: string) => (
    runtime.installPlugin(source, artifactManifestDigest)
  )));
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
  ipcMain.handle('plugins:mcp-conflicts', trustedHandler((source: string, artifactManifestDigest: string) => (
    runtime.listMcpOwnershipConflicts(source, artifactManifestDigest)
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
  const runtimeInfo = await runtime.start();
  notificationsEnabled = runtimeInfo.notificationsEnabled ?? true;
  notificationHost = new ElectronNotificationHost({
    platform: {
      isSupported: () => Notification.isSupported(),
      // Electron has no cross-platform built-in permission query. A native `failed`
      // event is still reported precisely; injected adapters cover known denial states.
      permissionState: () => 'unknown',
      create: (options) => new Notification(options) as unknown as NativeNotification,
    },
    enabled: () => notificationsEnabled && process.env.YUANPU_NOTIFICATIONS_ENABLED !== '0',
    validateTarget: (target) => runtime.validateNotificationTarget(target),
    focus: focusMainWindow,
    navigate: (target) => {
      pendingNotificationTarget = target;
      focusMainWindow();
      flushNotificationNavigation();
    },
    onError: (error) => console.error('Notification activation failed:', error.message),
  });
  runtime.connectHostEvents((event) => notificationHost!.handle(event));
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Yuanpu Runtime startup failed:', message);
  dialog.showErrorBox('Yuanpu Runtime 无法启动', message);
  app.quit();
});

app.on('before-quit', (event) => {
  if (quitAllowed) return;
  event.preventDefault();
  if (quitInProgress) return;
  quitInProgress = true;
  notificationHost?.stop();
  void Promise.resolve(runtime?.stop()).finally(() => {
    quitAllowed = true;
    app.quit();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
