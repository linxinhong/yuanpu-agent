import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureYuanpuHome, getHotkeySettings, saveHotkeySetting } from '../dist/index.mjs';

test('hotkeys persist in app config without changing the active model', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-hotkeys-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = await ensureYuanpuHome(root);
  const initial = JSON.parse(await readFile(home.configPath, 'utf8'));

  assert.deepEqual((await getHotkeySettings(home)).bindings, {});
  await saveHotkeySetting(home, { id: 'conversation.interrupt', binding: 'Mod+KeyK' });
  const stored = JSON.parse(await readFile(home.configPath, 'utf8'));
  assert.equal(stored.hotkeys['conversation.interrupt'], 'Mod+KeyK');
  assert.equal(stored.provider, initial.provider);
  assert.equal(stored.model, initial.model);
  assert.equal((await getHotkeySettings(await ensureYuanpuHome(root))).bindings['conversation.interrupt'], 'Mod+KeyK');

  await saveHotkeySetting(home, { id: 'conversation.interrupt', binding: null });
  assert.equal((await getHotkeySettings(home)).bindings['conversation.interrupt'], null);
  await saveHotkeySetting(home, { id: 'conversation.interrupt', reset: true });
  assert.deepEqual((await getHotkeySettings(home)).bindings, {});
});

test('invalid hotkeys do not change config', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'yuanpu-hotkeys-invalid-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = await ensureYuanpuHome(root);
  const before = await readFile(home.configPath, 'utf8');
  await assert.rejects(saveHotkeySetting(home, { id: 'unknown', binding: 'Escape' }), /未知快捷键/);
  await assert.rejects(saveHotkeySetting(home, { id: 'conversation.interrupt', binding: 'KeyA' }), /需要搭配/);
  await assert.rejects(saveHotkeySetting(home, { id: 'conversation.interrupt', binding: 'Mod+Mod+KeyA' }), /格式无效/);
  assert.equal(await readFile(home.configPath, 'utf8'), before);

  const config = JSON.parse(before);
  await writeFile(home.configPath, JSON.stringify({ ...config, hotkeys: { 'conversation.interrupt': null } }));
  assert.equal((await getHotkeySettings(home)).bindings['conversation.interrupt'], null);
});
