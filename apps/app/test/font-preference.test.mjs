import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'tsx/esm/api';

register();
const {
  normalizeFontPreference,
  sanitizeCustomFontFamily,
  resolveFontFamily,
  FONT_PREFERENCE_DEFAULTS,
  FONT_FAMILY_PRESETS,
} = await import('../src/shared/font-preference.ts');

test('normalize falls back to defaults for invalid, out-of-range, or missing fields', () => {
  assert.deepEqual(normalizeFontPreference(undefined), FONT_PREFERENCE_DEFAULTS);
  assert.deepEqual(normalizeFontPreference(null), FONT_PREFERENCE_DEFAULTS);
  assert.deepEqual(normalizeFontPreference('nope'), FONT_PREFERENCE_DEFAULTS);
  assert.deepEqual(normalizeFontPreference({ uiScale: 'huge', contentSize: 99, fontFamily: 'unknown' }), FONT_PREFERENCE_DEFAULTS);
  assert.equal(normalizeFontPreference({ uiScale: 'xlarge' }).uiScale, 'xlarge');
  assert.equal(normalizeFontPreference({ fontFamily: 'songti' }).fontFamily, 'songti');
});

test('normalize rounds content size into the supported steps', () => {
  assert.equal(normalizeFontPreference({ contentSize: 15.6 }).contentSize, 16);
  assert.equal(normalizeFontPreference({ contentSize: 12 }).contentSize, FONT_PREFERENCE_DEFAULTS.contentSize);
  assert.equal(normalizeFontPreference({ contentSize: 18 }).contentSize, FONT_PREFERENCE_DEFAULTS.contentSize);
  assert.equal(normalizeFontPreference({ contentSize: Number.NaN }).contentSize, FONT_PREFERENCE_DEFAULTS.contentSize);
});

test('sanitize keeps valid font segments and drops malformed ones', () => {
  assert.equal(sanitizeCustomFontFamily(" 'PingFang SC' , sans-serif , "), "'PingFang SC', sans-serif");
  assert.equal(sanitizeCustomFontFamily('微软雅黑, monospace'), '微软雅黑, monospace');
  assert.equal(sanitizeCustomFontFamily('a"b, serif'), 'serif');
  assert.equal(sanitizeCustomFontFamily('bad{css}'), '');
  assert.equal(sanitizeCustomFontFamily(''), '');
});

test('resolveFontFamily falls back to the system stack for unusable custom values', () => {
  assert.equal(resolveFontFamily({ ...FONT_PREFERENCE_DEFAULTS, fontFamily: 'pingfang' }), FONT_FAMILY_PRESETS.pingfang);
  assert.equal(resolveFontFamily({ ...FONT_PREFERENCE_DEFAULTS, fontFamily: 'custom', customFontFamily: 'Georgia, serif' }), 'Georgia, serif');
  assert.equal(resolveFontFamily({ ...FONT_PREFERENCE_DEFAULTS, fontFamily: 'custom', customFontFamily: '' }), FONT_FAMILY_PRESETS.system);
  assert.equal(resolveFontFamily({ ...FONT_PREFERENCE_DEFAULTS, fontFamily: 'custom', customFontFamily: 'bad{css}' }), FONT_FAMILY_PRESETS.system);
});
