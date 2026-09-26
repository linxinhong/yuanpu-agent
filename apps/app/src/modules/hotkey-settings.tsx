import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  HOTKEY_CATEGORIES,
  HOTKEY_COMMANDS,
  effectiveHotkeyBinding,
  type HotkeyCommandId,
  type SaveHotkeyInput,
} from '@yuanpu-agent/protocol';
import { bindingFromKeyEvent, hotkeyLabel } from '../shared/hotkeys.js';

export function HotkeySettingsPanel({ active }: { active: boolean }) {
  const desktop = window.yuanpu;
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['settings', 'hotkeys'],
    queryFn: () => desktop!.getHotkeySettings(),
    enabled: active && Boolean(desktop),
  });
  const [recording, setRecording] = useState<HotkeyCommandId>();
  const [saving, setSaving] = useState<HotkeyCommandId>();
  const savingRef = useRef(false);
  const [error, setError] = useState('');

  async function save(input: SaveHotkeyInput) {
    if (!desktop || savingRef.current) return;
    savingRef.current = true;
    setSaving(input.id);
    setError('');
    try {
      const settings = await desktop.saveHotkeySetting(input);
      client.setQueryData(['settings', 'hotkeys'], settings);
      setRecording(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      savingRef.current = false;
      setSaving(undefined);
    }
  }

  useEffect(() => {
    if (!active || !recording) return;
    const capture = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      const binding = bindingFromKeyEvent(event);
      if (binding) void save({ id: recording, binding });
      else if (!/^(?:Meta|Control|Alt|Shift)(?:Left|Right)$/.test(event.code)) {
        setError('请按下 Esc、功能键，或带 Command / Control / Option 的组合键。');
      }
    };
    window.addEventListener('keydown', capture, true);
    return () => window.removeEventListener('keydown', capture, true);
  }, [active, recording, saving, desktop]);

  return <section className="hotkey-settings" aria-label="快捷键设置">
    <h2>快捷键</h2>
    <p>快捷键只在桌面应用窗口内生效。点击按键可重新录入，也可以禁用或恢复默认值。</p>
    {!desktop && <p>请在桌面应用中配置快捷键。</p>}
    {query.isLoading && <p>正在读取快捷键…</p>}
    {query.error && <p role="alert">读取失败：{String(query.error)}</p>}
    {error && <p className="hotkey-error" role="alert">{error}</p>}
    {HOTKEY_CATEGORIES.map((category) => {
      const commands = HOTKEY_COMMANDS.filter((command) => command.category === category.id);
      if (!commands.length) return null;
      return <section className="hotkey-category" key={category.id} aria-label={category.title}>
        <h3>{category.title}</h3>
        {commands.map((command) => {
          const binding = effectiveHotkeyBinding(query.data, command.id);
          const isRecording = recording === command.id;
          return <div className="hotkey-row" key={command.id}>
            <div className="hotkey-description"><strong>{command.title}</strong><span>{command.description}</span></div>
            <div className="hotkey-controls">
              <button type="button" className="hotkey-binding" aria-label={`修改${command.title}快捷键`}
                aria-pressed={isRecording} disabled={!desktop || Boolean(saving)}
                onClick={() => { setError(''); setRecording(isRecording ? undefined : command.id); }}>
                {isRecording ? '请按快捷键…' : hotkeyLabel(binding)}
              </button>
              <button type="button" disabled={!desktop || Boolean(saving) || binding === null}
                onClick={() => void save({ id: command.id, binding: null })}>禁用</button>
              <button type="button" disabled={!desktop || Boolean(saving) || query.data?.bindings[command.id] === undefined}
                onClick={() => void save({ id: command.id, reset: true })}>恢复默认</button>
            </div>
          </div>;
        })}
      </section>;
    })}
  </section>;
}
