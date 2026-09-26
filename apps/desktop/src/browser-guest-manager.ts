import type { BrowserControlCommand, BrowserControlResult } from '@yuanpu-agent/protocol';
import { webContents as electronWebContents, type WebContents } from 'electron';

interface ManagedGuest {
  key: string;
  conversationId: string;
  windowId: number;
  webContents: WebContents;
  debuggerAttached: boolean;
  releaseTimer?: NodeJS.Timeout;
}

export interface BrowserGuestManagerOptions {
  /** Guest renderer process died; the owning window must rebuild its webview. */
  onGuestCrashed: (windowId: number, guestKey: string) => void;
  /** No guest is attached for the conversation; the renderer may auto-open one. */
  onSessionRequest: (windowId: number, conversationId: string) => void;
  /** Resolves the single main window; session requests target it. */
  getMainWindowId: () => number | undefined;
}

const CDP_IDLE_RELEASE_MS = 1_500;
const SESSION_WAIT_MS = 8_000;
const SESSION_POLL_MS = 250;
const MAX_SNAPSHOT_TEXT_CHARS = 12_000;
const MAX_SNAPSHOT_LINKS = 60;
const MAX_EVALUATE_CHARS = 8_000;

interface GuestState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

/**
 * Main-process registry of `<webview>` browser guests with a CDP-on-guest
 * control plane (trimmed port of ZCode's BrowserGuestManager). Commands are
 * addressed by Work conversation id so agent capability calls and the user's
 * browser tab operate on the same page.
 */
export class BrowserGuestManager {
  private readonly guests = new Map<string, ManagedGuest>();

  constructor(private readonly options: BrowserGuestManagerOptions) {}

  attachGuest(payload: { key: string; webContentsId: number; conversationId: string; windowId: number; hostWebContentsId: number }): { ok: boolean; error?: string } {
    if (this.guests.has(payload.key)) this.detachGuest(payload.key);
    const webContents = electronWebContents.fromId(payload.webContentsId);
    if (!webContents || webContents.isDestroyed()) return { ok: false, error: 'Guest webContents not found.' };
    if (webContents.getType() !== 'webview') return { ok: false, error: 'Only webview guests can be attached.' };
    if (webContents.hostWebContents?.id !== payload.hostWebContentsId) {
      return { ok: false, error: 'Browser guest does not belong to the requesting window.' };
    }
    const guest: ManagedGuest = {
      key: payload.key,
      conversationId: payload.conversationId,
      windowId: payload.windowId,
      webContents,
      debuggerAttached: false,
    };
    webContents.once('render-process-gone', () => {
      if (this.guests.get(payload.key) !== guest) return;
      this.releaseDebugger(guest);
      this.guests.delete(payload.key);
      this.options.onGuestCrashed(payload.windowId, payload.key);
    });
    this.guests.set(payload.key, guest);
    return { ok: true };
  }

  detachGuest(key: string): void {
    const guest = this.guests.get(key);
    if (!guest) return;
    this.releaseDebugger(guest);
    this.guests.delete(key);
  }

  detachAll(): void {
    for (const key of [...this.guests.keys()]) this.detachGuest(key);
  }

  hasGuestFor(conversationId: string): boolean {
    return this.findGuest(conversationId) !== undefined;
  }

  async execute(command: BrowserControlCommand): Promise<BrowserControlResult> {
    const guest = this.findGuest(command.conversationId);
    if (!guest) {
      const windowId = this.options.getMainWindowId();
      if (windowId !== undefined) this.options.onSessionRequest(windowId, command.conversationId);
      const appeared = await this.waitForGuest(command.conversationId);
      if (!appeared) {
        return { ok: false, method: command.method, error: '该会话尚未打开浏览器标签；请先在右侧栏打开浏览器或稍后重试。' };
      }
    }
    return await this.executeOnGuest(this.findGuest(command.conversationId)!, command);
  }

  private findGuest(conversationId: string): ManagedGuest | undefined {
    let found: ManagedGuest | undefined;
    for (const guest of this.guests.values()) {
      if (guest.conversationId === conversationId && !guest.webContents.isDestroyed()) found = guest;
    }
    return found;
  }

  private waitForGuest(conversationId: string): Promise<boolean> {
    const deadline = Date.now() + SESSION_WAIT_MS;
    return new Promise((resolve) => {
      const poll = () => {
        if (this.findGuest(conversationId)) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(poll, SESSION_POLL_MS);
      };
      poll();
    });
  }

  private async executeOnGuest(guest: ManagedGuest, command: BrowserControlCommand): Promise<BrowserControlResult> {
    const { webContents } = guest;
    if (webContents.isDestroyed()) {
      return { ok: false, method: command.method, error: '浏览器标签已被关闭。' };
    }
    try {
      switch (command.method) {
        case 'navigate': {
          const url = command.url ?? '';
          if (!/^https?:\/\//i.test(url)) {
            return { ok: false, method: command.method, error: '只允许 http(s) URL。' };
          }
          await webContents.loadURL(url);
          return { ok: true, method: command.method, ...this.readState(webContents) };
        }
        case 'back':
          if (webContents.navigationHistory.canGoBack()) webContents.goBack();
          return { ok: true, method: command.method, ...this.readState(webContents) };
        case 'forward':
          if (webContents.navigationHistory.canGoForward()) webContents.goForward();
          return { ok: true, method: command.method, ...this.readState(webContents) };
        case 'reload':
          webContents.reload();
          return { ok: true, method: command.method, ...this.readState(webContents) };
        case 'screenshot': {
          const capture = await this.cdp<{ data?: string }>(guest, 'Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: command.fullPage === true,
          });
          if (!capture?.data) {
            return { ok: false, method: command.method, error: '截图失败：CDP 未返回图像数据。' };
          }
          return { ok: true, method: command.method, base64: capture.data, ...this.readState(webContents) };
        }
        case 'snapshot': {
          const snapshot = await webContents.executeJavaScript(SNAPSHOT_SCRIPT, true) as {
            title?: string; text?: string; links?: Array<{ text: string; href: string }>;
          };
          const lines = [
            `Title: ${snapshot.title ?? webContents.getTitle()}`,
            `URL: ${webContents.getURL()}`,
            '',
            'Untrusted page content:',
            (snapshot.text ?? '').slice(0, MAX_SNAPSHOT_TEXT_CHARS),
          ];
          if (snapshot.links?.length) {
            lines.push('', 'Links:');
            for (const link of snapshot.links.slice(0, MAX_SNAPSHOT_LINKS)) {
              lines.push(`- ${link.text.slice(0, 120)} (${link.href})`);
            }
          }
          return { ok: true, method: command.method, url: webContents.getURL(), title: webContents.getTitle(), text: lines.join('\n') };
        }
        case 'click': {
          await this.cdp(guest, 'Input.dispatchMouseEvent', {
            type: 'mousePressed', x: command.x, y: command.y, button: 'left', clickCount: 1,
          });
          await this.cdp(guest, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: command.x, y: command.y, button: 'left', clickCount: 1,
          });
          return { ok: true, method: command.method, ...this.readState(webContents) };
        }
        case 'type': {
          await this.cdp(guest, 'Input.insertText', { text: command.text });
          return { ok: true, method: command.method, ...this.readState(webContents) };
        }
        case 'scroll': {
          await this.cdp(guest, 'Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: command.x ?? 0,
            y: command.y ?? 0,
            deltaX: command.deltaX ?? 0,
            deltaY: command.deltaY ?? 600,
          });
          return { ok: true, method: command.method, ...this.readState(webContents) };
        }
        case 'evaluate': {
          const raw = await webContents.executeJavaScript(command.expression ?? '', true);
          const text = JSON.stringify(raw ?? null)?.slice(0, MAX_EVALUATE_CHARS) ?? 'undefined';
          return { ok: true, method: command.method, text };
        }
        default:
          return { ok: false, method: command.method, error: '未知的浏览器命令。' };
      }
    } catch (error) {
      return { ok: false, method: command.method, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private readState(webContents: WebContents): GuestState {
    return {
      url: webContents.getURL(),
      title: webContents.getTitle(),
      canGoBack: webContents.navigationHistory.canGoBack(),
      canGoForward: webContents.navigationHistory.canGoForward(),
    };
  }

  /** CDP via the guest's own debugger. Detaches after idle to dodge the
   * Electron UAF hazard when a guest is destroyed mid-DevTools-session. */
  private async cdp<T>(guest: ManagedGuest, method: string, params?: object): Promise<T> {
    if (!guest.debuggerAttached) {
      guest.webContents.debugger.attach('1.3');
      guest.debuggerAttached = true;
    }
    const result = await guest.webContents.debugger.sendCommand(method, params) as T;
    if (guest.releaseTimer) clearTimeout(guest.releaseTimer);
    guest.releaseTimer = setTimeout(() => this.releaseDebugger(guest), CDP_IDLE_RELEASE_MS);
    return result;
  }

  private releaseDebugger(guest: ManagedGuest): void {
    if (guest.releaseTimer) {
      clearTimeout(guest.releaseTimer);
      guest.releaseTimer = undefined;
    }
    if (!guest.debuggerAttached) return;
    try {
      guest.webContents.debugger.detach();
    } catch {
      // Detaching a destroyed or already-detached guest is a no-op.
    }
    guest.debuggerAttached = false;
  }
}

const SNAPSHOT_SCRIPT = `(() => {
  const visibleText = (document.body?.innerText ?? '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 12000);
  const links = [...document.querySelectorAll('a[href]')]
    .map((a) => ({ text: (a.innerText || a.href || '').trim(), href: a.href }))
    .filter((link) => link.text && link.href.startsWith('http'))
    .slice(0, 60);
  return { title: document.title, text: visibleText, links };
})()`;
