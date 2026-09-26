export interface BrowserViewState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  errorMessage: string;
  isReady: boolean;
}

export function initialBrowserState(): BrowserViewState {
  return { url: '', title: '', canGoBack: false, canGoForward: false, isLoading: false, errorMessage: '', isReady: false };
}

/** Normalizes an address-bar input into a navigable URL; undefined when unusable. */
export function normalizeAddressInput(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed === 'about:blank') return trimmed;
  if (/^[\w.-]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(trimmed)) return `https://${trimmed}`;
  return undefined;
}

/** Per-conversation in-memory last URL so switching tabs or work conversations keeps the page. */
export function createBrowserMemoryStore() {
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
    forget(scopeKey: string): void {
      lastUrls.delete(scopeKey);
    },
  };
}
