export type RendererTheme = 'yuanpu-light' | 'yuanpu-dark' | 'mindlink';

const storageKey = 'yuanpu:theme:v1';

export function readThemePreference(): RendererTheme {
  try {
    const stored = window.localStorage.getItem(storageKey);
    return stored === 'mindlink' || stored === 'yuanpu-dark' ? stored : 'yuanpu-light';
  } catch {
    return 'yuanpu-light';
  }
}

export function applyThemePreference(theme: RendererTheme): void {
  document.documentElement.dataset.yuanpuTheme = theme;
  try {
    window.localStorage.setItem(storageKey, theme);
  } catch {
    // The theme still applies for this session when storage is unavailable.
  }
}
