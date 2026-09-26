import { normalizeHotkeyBinding } from '@yuanpu-agent/protocol';

export interface HotkeyKeyEvent {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function isMacHotkeyPlatform(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

export function bindingFromKeyEvent(event: HotkeyKeyEvent, mac = isMacHotkeyPlatform()): string | undefined {
  if (/^(?:Meta|Control|Alt|Shift)(?:Left|Right)$/.test(event.code)) return undefined;
  const modifiers: string[] = [];
  if (mac ? event.metaKey : event.ctrlKey) modifiers.push('Mod');
  if (mac ? event.ctrlKey : event.metaKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  try { return normalizeHotkeyBinding([...modifiers, event.code].join('+')); }
  catch { return undefined; }
}

export function hotkeyLabel(binding: string | null, mac = isMacHotkeyPlatform()): string {
  if (binding === null) return '未设置';
  const labels: Record<string, string> = {
    Mod: mac ? '⌘' : 'Ctrl', Ctrl: mac ? '⌃' : 'Meta', Alt: mac ? '⌥' : 'Alt', Shift: '⇧',
    Escape: 'Esc', Space: '空格', Enter: '↵', Tab: 'Tab', Backspace: '⌫', Delete: 'Delete',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  };
  return binding.split('+').map((part) => labels[part] ?? part.replace(/^Key/, '').replace(/^Digit/, '')).join(mac ? '' : ' + ');
}
