export const HOTKEY_CATEGORIES = [
  { id: 'conversation', title: '会话' },
] as const;

export const HOTKEY_COMMANDS = [
  {
    id: 'conversation.interrupt',
    category: 'conversation',
    title: '中断当前会话',
    description: '停止当前会话正在执行的任务',
    defaultBinding: 'Escape',
  },
] as const;

export type HotkeyCommandId = (typeof HOTKEY_COMMANDS)[number]['id'];
export type HotkeyOverrides = Partial<Record<HotkeyCommandId, string | null>>;
export interface HotkeySettings { bindings: HotkeyOverrides }
export interface SaveHotkeyInput {
  id: HotkeyCommandId;
  /** null disables the shortcut; reset removes its override. */
  binding?: string | null;
  reset?: boolean;
}

const allowedCodes = /^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Escape|Enter|Space|Tab|Backspace|Delete|Arrow(?:Up|Down|Left|Right))$/;
const modifierOrder = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const;

export function normalizeHotkeyBinding(value: string): string {
  if (typeof value !== 'string' || value.length > 64) throw new Error('快捷键格式无效。');
  const parts = value.split('+');
  const code = parts.pop();
  const modifiers = new Set(parts);
  if (!code || !allowedCodes.test(code) || modifiers.size !== parts.length
    || parts.some((part) => !modifierOrder.includes(part as typeof modifierOrder[number]))) {
    throw new Error('快捷键格式无效。');
  }
  if (!modifiers.has('Mod') && !modifiers.has('Ctrl') && !modifiers.has('Alt')
    && code !== 'Escape' && !/^F(?:[1-9]|1[0-2])$/.test(code)) {
    throw new Error('字母、数字及编辑键需要搭配 Command、Control 或 Option。');
  }
  return [...modifierOrder.filter((part) => modifiers.has(part)), code].join('+');
}

export function effectiveHotkeyBinding(settings: HotkeySettings | undefined, id: HotkeyCommandId): string | null {
  const override = settings?.bindings[id];
  return override === undefined ? HOTKEY_COMMANDS.find((item) => item.id === id)!.defaultBinding : override;
}
