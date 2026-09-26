import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

interface WebviewTagElement extends HTMLElement {
  getWebContentsId(): number;
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  isLoading(): boolean;
  getURL(): string;
  getTitle(): string;
}

import type { ViewerBrowserHost } from '../host/browser-host.js';
import { initialBrowserState, normalizeAddressInput, type BrowserViewState } from './browser-state.js';
import { BrowserToolbar } from './browser-toolbar.js';

const WebView = 'webview' as unknown as React.FC<Record<string, unknown>>;

const BROWSER_PARTITION = 'persist:yuanpu-embedded-browser';

/** Per-conversation last URL, kept in memory for the lifetime of the app. */
const memory = (() => {
  const lastUrls = new Map<string, string>();
  return {
    remember(scopeKey: string, url: string): void {
      if (!url || url === 'about:blank') return;
      lastUrls.set(scopeKey, url);
      while (lastUrls.size > 50) lastUrls.delete(lastUrls.keys().next().value!);
    },
    recall(scopeKey: string): string | undefined {
      return lastUrls.get(scopeKey);
    },
  };
})();

/**
 * Embedded browser view over an Electron `<webview>` guest (pixels composed
 * inside the panel DOM). Human controls drive the webview directly; the guest
 * registers with the main-process guest manager on attach so agent browser
 * commands land on this same session.
 */
export function BrowserView({ host, scopeKey, hidden, onTitleChange }: {
  host: ViewerBrowserHost;
  /** Opaque identity of the owning scope (the Work conversation id). */
  scopeKey: string;
  hidden?: boolean;
  onTitleChange?: (title: string) => void;
}) {
  const webviewRef = useRef<WebviewTagElement | null>(null);
  const pendingUrl = useRef<string | undefined>(memory.recall(scopeKey));
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<BrowserViewState>(initialBrowserState);
  const guestKey = `browser:${scopeKey}`;

  const navigate = useCallback((url: string) => {
    const webview = webviewRef.current;
    memory.remember(scopeKey, url);
    setState((current) => ({ ...current, url, isLoading: Boolean(webview), errorMessage: '' }));
    if (webview && state.isReady) void webview.loadURL(url).catch(() => undefined);
    else pendingUrl.current = url;
  }, [scopeKey, state.isReady]);

  // Register the guest with the main-process manager as soon as it attaches,
  // and mirror webview events into local state.
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    let disposed = false;
    const updateState = () => {
      if (disposed) return;
      setState((current) => {
        const title = webview.getTitle();
        if (title && title !== current.title) onTitleChange?.(title);
        return {
          ...current,
          url: webview.getURL() || current.url,
          title,
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward(),
        isLoading: webview.isLoading(),
          errorMessage: current.errorMessage,
          isReady: true,
        };
      });
    };
    const handleAttach = () => {
      void host.attachGuest({ key: guestKey, webContentsId: webview.getWebContentsId(), conversationId: scopeKey })
        .catch(() => undefined);
    };
    const handleDomReady = () => {
      updateState();
      if (pendingUrl.current) {
        const url = pendingUrl.current;
        pendingUrl.current = undefined;
        void webview.loadURL(url).catch(() => undefined);
      }
    };
    const handleFail = (event: CustomEvent<{ errorCode: number; errorDescription: string }>) => {
      if (disposed || event.detail.errorCode === -3) return;
      setState((current) => ({ ...current, isLoading: false, errorMessage: event.detail.errorDescription || '页面加载失败。' }));
    };
    const handleGone = () => {
      if (disposed) return;
      void host.detachGuest(guestKey).catch(() => undefined);
      setState((current) => ({ ...initialBrowserState(), url: current.url }));
      setGeneration((value) => value + 1);
    };
    webview.addEventListener('did-attach', handleAttach);
    webview.addEventListener('dom-ready', handleDomReady);
    webview.addEventListener('did-start-loading', updateState);
    webview.addEventListener('did-stop-loading', updateState);
    webview.addEventListener('did-navigate', updateState);
    webview.addEventListener('did-navigate-in-page', updateState);
    webview.addEventListener('page-title-updated', updateState);
    webview.addEventListener('did-fail-load', handleFail as EventListener);
    webview.addEventListener('render-process-gone', handleGone);
    return () => {
      disposed = true;
      webview.removeEventListener('did-attach', handleAttach);
      webview.removeEventListener('dom-ready', handleDomReady);
      webview.removeEventListener('did-start-loading', updateState);
      webview.removeEventListener('did-stop-loading', updateState);
      webview.removeEventListener('did-navigate', updateState);
      webview.removeEventListener('did-navigate-in-page', updateState);
      webview.removeEventListener('page-title-updated', updateState);
      webview.removeEventListener('did-fail-load', handleFail as EventListener);
      webview.removeEventListener('render-process-gone', handleGone);
    };
    // onTitleChange is stable enough at this usage site; re-subscribing on its
    // identity would tear down guest listeners on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, guestKey, host, scopeKey]);

  // Detach before the webview node goes away so main-side CDP never outlives it.
  useEffect(() => () => {
    void host.detachGuest(guestKey).catch(() => undefined);
  }, [host, guestKey]);

  return <div className={hidden ? 'browser-view hidden' : 'browser-view'} aria-hidden={hidden || undefined}>
    <BrowserToolbar state={state} onNavigate={navigate}
      onBack={() => webviewRef.current?.goBack()}
      onForward={() => webviewRef.current?.goForward()}
      onReload={() => state.isLoading ? webviewRef.current?.stop() : webviewRef.current?.reload()}
      onOpenExternal={(url) => void host.openInSystemBrowser(url)} />
    <div className="browser-viewport">
      <WebView key={`webview:${generation}`} ref={webviewRef as never}
        src={memory.recall(scopeKey) ?? 'about:blank'}
        partition={BROWSER_PARTITION}
        allowpopups=""
        style={{ backgroundColor: '#ffffff' } as CSSProperties}
        className="browser-guest" />
      {state.errorMessage && <p className="file-preview-error browser-error" role="alert">{state.errorMessage}</p>}
      {state.url === '' && !state.isLoading && <p className="file-preview-loading browser-empty">在地址栏输入网址开始浏览。</p>}
    </div>
  </div>;
}
