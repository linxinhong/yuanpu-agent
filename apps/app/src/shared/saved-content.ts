export type SavedContentKind = 'memory' | 'knowledge';

export type SavedContent = {
  id: string;
  kind: SavedContentKind;
  surface: 'work' | 'assistant';
  text: string;
  savedAt: string;
};
type LegacySavedContent = Omit<SavedContent, 'kind'> & { kind: SavedContentKind | 'record' };

const storageKey = 'yuanpu:saved-content:v1';
export const savedContentEvent = 'yuanpu:saved-content-changed';

export function readSavedContent(): SavedContent[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is LegacySavedContent => Boolean(item)
      && typeof item.id === 'string'
      && (item.kind === 'memory' || item.kind === 'record' || item.kind === 'knowledge')
      && (item.surface === 'work' || item.surface === 'assistant')
      && typeof item.text === 'string'
      && typeof item.savedAt === 'string').map((item) => ({ ...item, kind: item.kind === 'record' ? 'memory' : item.kind }));
  } catch { return []; }
}

export function isSavedContent(kind: SavedContentKind, surface: SavedContent['surface'], text: string): boolean {
  return readSavedContent().some((item) => item.kind === kind && item.surface === surface && item.text === text);
}

export function saveContent(kind: SavedContentKind, surface: SavedContent['surface'], text: string): void {
  if (!text.trim()) throw new Error('空回复不能保存。');
  const current = readSavedContent();
  if (current.some((item) => item.kind === kind && item.surface === surface && item.text === text)) return;
  const next: SavedContent[] = [{ id: crypto.randomUUID(), kind, surface, text, savedAt: new Date().toISOString() }, ...current];
  window.localStorage.setItem(storageKey, JSON.stringify(next));
  window.dispatchEvent(new Event(savedContentEvent));
}

export function removeSavedContent(id: string): void {
  const current = readSavedContent();
  window.localStorage.setItem(storageKey, JSON.stringify(current.filter((item) => item.id !== id)));
  window.dispatchEvent(new Event(savedContentEvent));
}
