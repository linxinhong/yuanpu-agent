const { app, Notification } = require('electron');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const userData = mkdtempSync(join(tmpdir(), 'yuanpu-task-019-notification-'));
app.setPath('userData', userData);
let finished = false;
function finish(status) {
  if (finished) return;
  finished = true;
  process.stdout.write(`${JSON.stringify({ supported: Notification.isSupported(), status })}\n`);
  app.quit();
}

app.whenReady().then(() => {
  if (!Notification.isSupported()) return finish('unsupported');
  const notification = new Notification({
    title: 'Yuanpu TASK-019 通知测试',
    body: '这是一次本机通知显示诊断。',
  });
  notification.once('show', () => finish('show_event'));
  notification.once('failed', () => finish('failed_event'));
  notification.show();
  setTimeout(() => finish('timeout'), 5_000).unref();
}).catch(() => finish('app_error'));

app.on('will-quit', () => {
  rmSync(userData, { recursive: true, force: true });
});
