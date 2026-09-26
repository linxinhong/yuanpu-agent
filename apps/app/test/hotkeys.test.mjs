import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'tsx/esm/api';

register();
const { bindingFromKeyEvent, hotkeyLabel } = await import('../src/shared/hotkeys.ts');

const key = (code, overrides = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides });

test('Escape and platform command combinations use physical key codes', () => {
  assert.equal(bindingFromKeyEvent(key('Escape'), true), 'Escape');
  assert.equal(bindingFromKeyEvent(key('KeyK', { metaKey: true, shiftKey: true }), true), 'Mod+Shift+KeyK');
  assert.equal(bindingFromKeyEvent(key('KeyK', { ctrlKey: true }), false), 'Mod+KeyK');
  assert.equal(bindingFromKeyEvent(key('KeyK'), true), undefined);
  assert.equal(bindingFromKeyEvent(key('ShiftLeft', { shiftKey: true }), true), undefined);
  assert.equal(hotkeyLabel('Mod+Shift+KeyK', true), '⌘⇧K');
});
