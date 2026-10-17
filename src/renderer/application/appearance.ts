import { Hct, argbFromHex, hexFromArgb } from '@material/material-color-utilities';
import type { Settings, ThemePreference } from '../../shared/domain/model';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['classic', 'light', 'dark', 'system'];
export const CUSTOM_CSS_LIMIT = 16384;
export const AI_PROMPT_LIMIT = 500;
export const APPEARANCE_MIRROR_KEY = 'slate-appearance:v1';

export const ACCENT_PRESETS: readonly { id: string; name: string; color: string }[] = [
  { id: 'green', name: '苔绿', color: '#65dc99' },
  { id: 'teal', name: '青碧', color: '#2dd4bf' },
  { id: 'sky', name: '天蓝', color: '#38bdf8' },
  { id: 'indigo', name: '靛蓝', color: '#6366f1' },
  { id: 'violet', name: '藤紫', color: '#a855f7' },
  { id: 'pink', name: '玫瑰', color: '#f472b6' },
  { id: 'coral', name: '珊瑚', color: '#fb7185' },
  { id: 'amber', name: '琥珀', color: '#f59e0b' },
  { id: 'lemon', name: '柠黄', color: '#eab308' },
  { id: 'graphite', name: '石墨', color: '#94a3b8' }
];

export type AppearanceValue = Pick<Settings, 'theme' | 'accent' | 'radius' | 'customCss' | 'customCssEnabled' | 'backgroundTint'>;

export const APPEARANCE_DEFAULT: AppearanceValue = {
  theme: 'system', accent: '#65dc99', radius: 8, customCss: '', customCssEnabled: false, backgroundTint: false
};

const DEFAULT_ACCENT = '#65dc99';
const HEX_SHORT = /^#[0-9a-f]{3}$/;
const HEX_LONG = /^#[0-9a-f]{6}$/;

export function isHexColor(value: unknown): boolean {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return HEX_SHORT.test(text) || HEX_LONG.test(text);
}

export function normalizeAccent(value: unknown): string {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (HEX_SHORT.test(text)) return '#' + text[1] + text[1] + text[2] + text[2] + text[3] + text[3];
  return HEX_LONG.test(text) ? text : DEFAULT_ACCENT;
}

/** Keep custom accents readable and tasteful without changing any preset. */
export function constrainAccent(value: unknown): string {
  const accent = normalizeAccent(value);
  const hct = Hct.fromInt(argbFromHex(accent));
  if (hct.tone >= 45 && hct.tone <= 82 && hct.chroma <= 84) return accent;
  return hexFromArgb(Hct.from(hct.hue, Math.min(hct.chroma, 84), Math.min(82, Math.max(45, hct.tone))).toInt());
}

function backgroundTintColor(accent: string, stage: 'light' | 'dark'): string {
  const source = Hct.fromInt(argbFromHex(normalizeAccent(accent)));
  const dark = stage === 'dark';
  const chroma = Math.min(source.chroma * (dark ? .18 : .09), dark ? 10 : 7);
  return hexFromArgb(Hct.from(source.hue, chroma, dark ? 7 : 95).toInt());
}

function settingsTintColor(accent: string, theme: 'light' | 'dark'): string {
  const source = Hct.fromInt(argbFromHex(normalizeAccent(accent)));
  const dark = theme === 'dark';
  const chroma = Math.min(source.chroma * (dark ? .12 : .06), dark ? 6 : 4);
  return hexFromArgb(Hct.from(source.hue, chroma, dark ? 9 : 97).toInt());
}

export function normalizeAppearance(value: unknown): AppearanceValue {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const theme = THEME_PREFERENCES.includes(source.theme as ThemePreference)
    ? source.theme as ThemePreference
    : APPEARANCE_DEFAULT.theme;
  const rawRadius = source.radius;
  const numericRadius = Number(rawRadius);
  const radius = rawRadius == null || rawRadius === '' || !Number.isFinite(numericRadius)
    ? APPEARANCE_DEFAULT.radius
    : Math.max(0, Math.min(16, Math.round(numericRadius)));
  const customCss = typeof source.customCss === 'string'
    ? source.customCss.replace(/\u0000/g, '').slice(0, CUSTOM_CSS_LIMIT)
    : '';
  return {
    theme,
    accent: normalizeAccent(source.accent),
    radius,
    customCss,
    customCssEnabled: source.customCssEnabled === true,
    backgroundTint: source.backgroundTint === true
  };
}

/** WCAG relative luminance drives the readable foreground for an accent fill. */
function relativeLuminance(hex: string): number {
  const expand = (index: number) => parseInt(hex.slice(index, index + 2), 16) / 255;
  const linear = (channel: number) => channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
  return 0.2126 * linear(expand(1)) + 0.7152 * linear(expand(3)) + 0.0722 * linear(expand(5));
}

export function accentContrast(accent: string): string {
  // Mid-tone saturated accents (靛蓝/藤紫) keep white text; only genuinely bright
  // accents switch to dark ink. 0.3 also keeps the CSS preview readable at a glance.
  return relativeLuminance(normalizeAccent(accent)) > 0.3 ? '#0b0f0c' : '#ffffff';
}

export function resolveThemeSurfaces(theme: ThemePreference, systemPrefersDark: boolean):
  { stage: 'light' | 'dark'; settings: 'light' | 'dark' } {
  if (theme === 'classic') return { stage: 'dark', settings: 'light' };
  if (theme === 'light') return { stage: 'light', settings: 'light' };
  if (theme === 'dark') return { stage: 'dark', settings: 'dark' };
  const surface = systemPrefersDark ? 'dark' : 'light';
  return { stage: surface, settings: surface };
}

export function themeLabel(theme: ThemePreference, systemPrefersDark: boolean): string {
  if (theme === 'classic') return '经典';
  if (theme === 'light') return '浅色';
  if (theme === 'dark') return '深色';
  return '跟随系统（当前' + (systemPrefersDark ? '深色' : '浅色') + '）';
}

export function buildAppearanceTokens(value: AppearanceValue, stage: 'light' | 'dark' = 'dark',
  settingsStage: 'light' | 'dark' = stage): string {
  const appearance = normalizeAppearance(value);
  let tint = '';
  if (appearance.backgroundTint) {
    const stageTint = backgroundTintColor(appearance.accent, stage);
    tint = ';--stage-canvas:' + stageTint
      + ';--ball-shell:' + stageTint
      + ';--ball-border:' + stageTint
      + ';--settings-canvas:' + settingsTintColor(appearance.accent, settingsStage);
  }
  return ':root{--color-accent:' + appearance.accent
    + ';--accent-contrast:' + accentContrast(appearance.accent)
    + ';--radius-ui:' + appearance.radius + 'px'
    + tint
    + '}';
}

export interface AppearanceOptions {
  root?: HTMLElement;
  document?: Document;
  systemPrefersDark?: boolean;
  mirror?: boolean;
}

const TOKEN_STYLE_ID = 'slate-appearance-tokens';
const CUSTOM_STYLE_ID = 'slate-appearance-custom-css';

let lastAppearance: AppearanceValue | null = null;
let lastOptions: AppearanceOptions | undefined;
let mediaQueryList: MediaQueryList | null = null;
let mirrorTimer: number | NodeJS.Timeout | undefined;

function systemPrefersDark(): boolean {
  try {
    return typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia('(prefers-color-scheme: dark)').matches
      : true;
  } catch {
    return true;
  }
}

function ensureMediaListener(): void {
  if (mediaQueryList || typeof globalThis.matchMedia !== 'function') return;
  try {
    mediaQueryList = globalThis.matchMedia('(prefers-color-scheme: dark)');
    mediaQueryList.addEventListener('change', event => {
      if (!lastAppearance || lastAppearance.theme !== 'system') return;
      applyAppearance(lastAppearance, { ...lastOptions, systemPrefersDark: event.matches });
    });
  } catch {
    mediaQueryList = null;
  }
}

function styleElement(doc: Document, id: string): HTMLStyleElement {
  const existing = doc.getElementById(id);
  if (existing) return existing as HTMLStyleElement;
  const created = doc.createElement('style');
  created.id = id;
  return created;
}

function scheduleMirror(value: AppearanceValue): void {
  try {
    clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(() => {
      try {
        globalThis.localStorage?.setItem(APPEARANCE_MIRROR_KEY, JSON.stringify(value));
      } catch {
        // Private mode or a non-browser host: the mirror is only a cache.
      }
    }, 180);
  } catch {
    // Timers unavailable: skip the mirror instead of breaking the main window.
  }
}

export function applyAppearance(value: unknown, options?: AppearanceOptions): void {
  const appearance = normalizeAppearance(value);
  const doc = options?.document ?? document;
  const root = options?.root ?? doc.documentElement;
  if (!doc.head || !root) return;
  const prefersDark = options?.systemPrefersDark ?? systemPrefersDark();
  const surfaces = resolveThemeSurfaces(appearance.theme, prefersDark);

  root.dataset.stageTheme = surfaces.stage;
  root.dataset.settingsTheme = surfaces.settings;
  root.dataset.themePreference = appearance.theme;
  root.dataset.backgroundTint = String(appearance.backgroundTint);

  const tokens = styleElement(doc, TOKEN_STYLE_ID);
  const custom = styleElement(doc, CUSTOM_STYLE_ID);
  const tokenText = buildAppearanceTokens(appearance, surfaces.stage, surfaces.settings);
  if (tokens.textContent !== tokenText) tokens.textContent = tokenText;
  const customText = appearance.customCssEnabled ? appearance.customCss : '';
  // Avoid re-parsing a large user stylesheet on every radius slider tick.
  if (custom.textContent !== customText) custom.textContent = customText;
  // Tokens first, user CSS last: custom rules must always win.
  doc.head.append(tokens, custom);

  lastAppearance = appearance;
  lastOptions = options;
  ensureMediaListener();
  if (options?.mirror !== false) scheduleMirror(appearance);
}

export function readAppearanceMirror(storage?: Storage): AppearanceValue | null {
  try {
    const target = storage ?? globalThis.localStorage;
    if (!target) return null;
    const raw = target.getItem(APPEARANCE_MIRROR_KEY);
    if (!raw) return null;
    return normalizeAppearance(JSON.parse(raw));
  } catch {
    return null;
  }
}

const IMPORT_PATTERN = /@import\s*(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^"')\s;]+))?/gi;
const URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/gi;

export function findExternalCssResources(css: string): string[] {
  const text = typeof css === 'string' ? css : '';
  const found: string[] = [];
  const seen = new Set<string>();
  const record = (raw: string | null | undefined) => {
    const target = String(raw == null ? '' : raw).trim();
    const value = target || '@import';
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(value);
  };
  for (const match of text.matchAll(IMPORT_PATTERN)) {
    record(match[1] ?? match[2] ?? match[3]);
  }
  for (const match of text.matchAll(URL_PATTERN)) {
    const target = String(match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!target || /^(?:data:|#|blob:|about:)/i.test(target)) continue;
    record(target);
  }
  return found;
}

export function summarizeCssResources(resources: string[]): string {
  const shown = resources.slice(0, 3).map(resource => resource.length > 60
    ? resource.slice(0, 60) + '…'
    : resource);
  const rest = resources.length - shown.length;
  return shown.join('、') + (rest > 0 ? ' 等 ' + rest + ' 项' : '');
}

export function validateCustomCss(css: string): string {
  const text = typeof css === 'string' ? css.replace(/\u0000/g, '').trim() : '';
  if (text.length > CUSTOM_CSS_LIMIT) {
    throw new Error('自定义 CSS 不能超过 ' + CUSTOM_CSS_LIMIT + ' 个字符。');
  }
  return text;
}

export interface ParsedTheme {
  theme: ThemePreference;
  accent: string;
  radius: number;
  css: string;
}

function extractFirstJsonObject(text: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') {
      if (depth === 0) start = index;
      depth++;
    } else if (character === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

export function buildThemePrompt(
  description: string,
  current: Pick<AppearanceValue, 'theme' | 'accent' | 'radius'>,
  resolvedTheme: 'light' | 'dark'
): string {
  const trimmed = (typeof description === 'string' ? description.replace(/\u0000/g, '').trim() : '')
    .slice(0, AI_PROMPT_LIMIT);
  return [
    '你是应用主题配置助手。根据用户描述生成一份主题配置，只输出一个 JSON 对象，不要 Markdown、代码围栏或解释。',
    '',
    '字段要求：',
    '- "theme": "classic" | "light" | "dark" | "system" 之一。classic 表示深色主界面配浅色设置，light / dark 表示整体明暗，system 表示跟随系统。',
    '- "accent": 不透明的 6 位十六进制颜色，例如 "#65dc99"。',
    '- "radius": 0 到 16 的整数。',
    '- "css": 可选 CSS 片段字符串，建议不超过 4000 字符；优先使用颜色、渐变、圆角和阴影，避免 @import 和外部 url()。',
    '',
    '当前配置：theme=' + current.theme + '; accent=' + current.accent
      + '; radius=' + current.radius + '; 实际明暗=' + resolvedTheme + '。',
    '用户描述（JSON 字符串）：' + JSON.stringify(trimmed)
  ].join('\n');
}

export function parseThemeResult(content: string): ParsedTheme {
  const text = typeof content === 'string' ? content : '';
  const source = extractFirstJsonObject(text);
  if (!source) throw new Error('AI 没有返回可识别的主题 JSON，请重试。');
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error('AI 返回的主题不是有效的 JSON，请重试。');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('AI 没有返回可识别的主题 JSON，请重试。');
  }
  const data = raw as Record<string, unknown>;
  if (!THEME_PREFERENCES.includes(data.theme as ThemePreference)) {
    throw new Error('AI 返回的主题偏好无效，请重试。');
  }
  if (!isHexColor(data.accent)) throw new Error('AI 返回的主题色无效，请重试。');
  const numericRadius = Number(data.radius);
  if (data.radius == null || data.radius === '' || !Number.isFinite(numericRadius)) {
    throw new Error('AI 返回的圆角无效，请重试。');
  }
  const css = data.css == null ? '' : typeof data.css === 'string' ? validateCustomCss(data.css) : '';
  return {
    theme: data.theme as ThemePreference,
    accent: constrainAccent(data.accent),
    radius: Math.max(0, Math.min(16, Math.round(numericRadius))),
    css
  };
}
