import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import {
  HOTKEY_COMMANDS,
  effectiveHotkeyBinding,
  normalizeHotkeyBinding,
  type HotkeyOverrides,
  type HotkeySettings,
  type SaveHotkeyInput,
} from '@yuanpu-agent/protocol';
import type { YuanpuConfig, YuanpuHome } from './index.js';

function readBindings(config: YuanpuConfig): HotkeyOverrides {
  const bindings = config.hotkeys ?? {};
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) throw new Error('快捷键配置格式无效。');
  const knownIds = new Set<string>(HOTKEY_COMMANDS.map((command) => command.id));
  const result: HotkeyOverrides = {};
  for (const [id, binding] of Object.entries(bindings)) {
    if (!knownIds.has(id)) continue;
    result[id as keyof HotkeyOverrides] = binding === null ? null : normalizeHotkeyBinding(binding);
  }
  return result;
}

async function readConfig(home: YuanpuHome): Promise<YuanpuConfig> {
  const value = JSON.parse(await readFile(home.configPath, 'utf8')) as YuanpuConfig;
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) throw new Error('应用配置格式无效，请先修复 config.json。');
  return value;
}

export async function getHotkeySettings(home: YuanpuHome): Promise<HotkeySettings> {
  return { bindings: readBindings(await readConfig(home)) };
}

export async function saveHotkeySetting(home: YuanpuHome, input: SaveHotkeyInput): Promise<HotkeySettings> {
  if (!input || !HOTKEY_COMMANDS.some((command) => command.id === input.id)) throw new Error('未知快捷键。');
  if (input.reset !== true && input.binding === undefined) throw new Error('请选择快捷键或禁用。');
  const config = await readConfig(home);
  const bindings = readBindings(config);
  if (input.reset === true) delete bindings[input.id];
  else bindings[input.id] = input.binding === null ? null : normalizeHotkeyBinding(input.binding!);

  const effective = { bindings };
  const values = HOTKEY_COMMANDS.map((command) => effectiveHotkeyBinding(effective, command.id));
  const active = values.filter((value): value is string => value !== null);
  if (new Set(active).size !== active.length) throw new Error('这个快捷键已被其他操作使用。');

  // Keep bindings for commands registered by a newer app or an extension.
  const persistedBindings = { ...config.hotkeys, ...bindings };
  if (input.reset === true) delete persistedBindings[input.id];
  const nextConfig: YuanpuConfig = { ...config, hotkeys: persistedBindings };
  const temporary = `${home.configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(nextConfig, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, home.configPath);
  } finally {
    await rm(temporary, { force: true });
  }
  home.config = nextConfig;
  return effective;
}
