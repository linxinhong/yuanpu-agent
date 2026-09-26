export type FontUiScale = 'compact' | 'standard' | 'large' | 'xlarge';
export type FontFamilyPreset = 'system' | 'pingfang' | 'yahei' | 'songti' | 'custom';

export interface FontPreference {
  uiScale: FontUiScale;
  contentSize: number;
  fontFamily: FontFamilyPreset;
  customFontFamily: string;
}

export const FONT_STORAGE_KEY = 'yuanpu:font:v1';

/** rem 基准 16px；界面字号档位只缩放文字，不缩放布局尺寸。 */
export const FONT_UI_SCALE_VALUES: Record<FontUiScale, string> = {
  compact: '0.9',
  standard: '1',
  large: '1.1',
  xlarge: '1.25',
};

export const FONT_CONTENT_SIZES = [13, 14, 15, 16, 17] as const;

export const FONT_FAMILY_PRESETS: Record<Exclude<FontFamilyPreset, 'custom'>, string> = {
  system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  pingfang: "'PingFang SC', 'Hiragino Sans GB', 'Source Han Sans SC', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif",
  yahei: "'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', sans-serif",
  songti: "'Songti SC', 'STSong', 'SimSun', 'Noto Serif CJK SC', serif",
};

export const FONT_PREFERENCE_DEFAULTS: FontPreference = {
  uiScale: 'standard',
  contentSize: 14,
  fontFamily: 'system',
  customFontFamily: '',
};

const FONT_FAMILY_SEGMENT = /^(?:"[^"]+"|'[^']+'|[A-Za-z0-9\u4e00-\u9fff_ -]+)$/;

/** 逐段校验自定义 font-family：丢弃引号不配对或含非法字符的段，防止污染内联声明。 */
export function sanitizeCustomFontFamily(value: string): string {
  return value
    .split(',')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && FONT_FAMILY_SEGMENT.test(segment))
    .join(', ');
}

export function normalizeFontPreference(raw: unknown): FontPreference {
  if (typeof raw !== 'object' || raw === null) return { ...FONT_PREFERENCE_DEFAULTS };
  const source = raw as Record<string, unknown>;
  const uiScale: FontUiScale =
    typeof source.uiScale === 'string' && source.uiScale in FONT_UI_SCALE_VALUES
      ? source.uiScale as FontUiScale
      : FONT_PREFERENCE_DEFAULTS.uiScale;
  const contentSize = typeof source.contentSize === 'number' && Number.isFinite(source.contentSize)
    ? Math.round(source.contentSize)
    : FONT_PREFERENCE_DEFAULTS.contentSize;
  const fontFamily: FontFamilyPreset =
    typeof source.fontFamily === 'string' && (source.fontFamily === 'custom' || source.fontFamily in FONT_FAMILY_PRESETS)
      ? source.fontFamily as FontFamilyPreset
      : FONT_PREFERENCE_DEFAULTS.fontFamily;
  const customFontFamily = typeof source.customFontFamily === 'string'
    ? sanitizeCustomFontFamily(source.customFontFamily)
    : FONT_PREFERENCE_DEFAULTS.customFontFamily;
  return {
    uiScale,
    contentSize: (FONT_CONTENT_SIZES as readonly number[]).includes(contentSize) ? contentSize : FONT_PREFERENCE_DEFAULTS.contentSize,
    fontFamily,
    customFontFamily,
  };
}

export function resolveFontFamily(preference: FontPreference): string {
  if (preference.fontFamily !== 'custom') return FONT_FAMILY_PRESETS[preference.fontFamily];
  const custom = sanitizeCustomFontFamily(preference.customFontFamily);
  return custom.length > 0 ? custom : FONT_FAMILY_PRESETS.system;
}

export function readFontPreference(): FontPreference {
  try {
    const stored = window.localStorage.getItem(FONT_STORAGE_KEY);
    return normalizeFontPreference(stored === null ? undefined : JSON.parse(stored));
  } catch {
    return { ...FONT_PREFERENCE_DEFAULTS };
  }
}

export function applyFontPreference(preference: FontPreference): void {
  const normalized = normalizeFontPreference(preference);
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--yp-font-scale-ui', FONT_UI_SCALE_VALUES[normalized.uiScale]);
  rootStyle.setProperty('--yp-font-size-content', `${normalized.contentSize}px`);
  rootStyle.setProperty('--yp-font-family', resolveFontFamily(normalized));
  try {
    window.localStorage.setItem(FONT_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // The preference still applies for this session when storage is unavailable.
  }
}
