import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hct, argbFromHex } from '@material/material-color-utilities';
import {
  ACCENT_PRESETS,
  APPEARANCE_DEFAULT,
  AI_PROMPT_LIMIT,
  CUSTOM_CSS_LIMIT,
  accentContrast,
  applyAppearance,
  buildAppearanceTokens,
  buildThemePrompt,
  constrainAccent,
  findExternalCssResources,
  isHexColor,
  normalizeAccent,
  normalizeAppearance,
  parseThemeResult,
  resolveThemeSurfaces,
  summarizeCssResources,
  themeLabel,
  validateCustomCss
} from '../../../../src/renderer/application/appearance';



test('主题表面解析区分经典混合外观与跟随系统', () => {
  assert.deepEqual(resolveThemeSurfaces('classic', true), { stage: 'dark', settings: 'light' });
  assert.deepEqual(resolveThemeSurfaces('classic', false), { stage: 'dark', settings: 'light' });
  assert.deepEqual(resolveThemeSurfaces('light', true), { stage: 'light', settings: 'light' });
  assert.deepEqual(resolveThemeSurfaces('dark', false), { stage: 'dark', settings: 'dark' });
  assert.deepEqual(resolveThemeSurfaces('system', true), { stage: 'dark', settings: 'dark' });
  assert.deepEqual(resolveThemeSurfaces('system', false), { stage: 'light', settings: 'light' });
  assert.equal(themeLabel('classic', true), '经典');
  assert.equal(themeLabel('light', true), '浅色');
  assert.equal(themeLabel('dark', false), '深色');
  assert.equal(themeLabel('system', true), '跟随系统（当前深色）');
  assert.equal(themeLabel('system', false), '跟随系统（当前浅色）');
});

test('主题色归一化、合法性判断与对比色', () => {
  assert.equal(normalizeAccent('#ABC'), '#aabbcc');
  assert.equal(normalizeAccent(' #12ef56 '), '#12ef56');
  assert.equal(normalizeAccent('red'), '#65dc99');
  assert.equal(normalizeAccent(null), '#65dc99');
  assert.ok(isHexColor('#abc'));
  assert.ok(isHexColor('#AABBCC'));
  assert.ok(!isHexColor('#abcd'));
  assert.ok(!isHexColor('abc'));
  assert.equal(accentContrast('#000'), '#ffffff');
  assert.equal(accentContrast('#fff'), '#0b0f0c');
  assert.equal(accentContrast('#65dc99'), '#0b0f0c');
  assert.equal(accentContrast('#6366f1'), '#ffffff');
  assert.equal(accentContrast('bogus'), accentContrast('#65dc99'));
  assert.equal(normalizeAccent(ACCENT_PRESETS[0].color), '#65dc99');
});

test('自定义主题色经 HCT 约束到可读的色度与明度范围', () => {
  for (const preset of ACCENT_PRESETS) assert.equal(constrainAccent(preset.color), preset.color);
  const measure = (hex: string) => Hct.fromInt(argbFromHex(hex));
  const black = measure(constrainAccent('#000000'));
  assert.ok(black.tone >= 44 && black.tone <= 46);
  assert.notEqual(constrainAccent('#000000'), '#000000');
  const white = measure(constrainAccent('#ffffff'));
  assert.ok(white.tone >= 81 && white.tone <= 83);
  const red = measure(constrainAccent('#ff0000'));
  assert.ok(red.chroma <= 85 && red.tone >= 45 && red.tone <= 83);
  assert.notEqual(constrainAccent('#ff0000'), '#ff0000');
  const neon = measure(constrainAccent('#00ff00'));
  assert.ok(neon.tone <= 83 && neon.chroma <= 85);
  const blue = measure(constrainAccent('#0000ff'));
  assert.ok(blue.tone >= 44 && blue.tone <= 83);
  assert.equal(constrainAccent('#aabbcc'), '#aabbcc');
});

test('背景颜色扩散按 HCT 生成舞台与设置画布', () => {
  const value = { ...APPEARANCE_DEFAULT, accent: '#65dc99', backgroundTint: true };
  const classic = buildAppearanceTokens(value, 'dark', 'light');
  const dark = buildAppearanceTokens(value, 'dark', 'dark');
  const light = buildAppearanceTokens(value, 'light', 'light');
  for (const token of [classic, dark, light]) {
    assert.match(token, /--stage-canvas:#[0-9a-f]{6}/);
    assert.match(token, /--ball-shell:#[0-9a-f]{6}/);
    assert.match(token, /--ball-border:#[0-9a-f]{6}/);
    assert.match(token, /--settings-canvas:#[0-9a-f]{6}/);
  }
  const stageHex = (token: string) => token.match(/--stage-canvas:(#[0-9a-f]{6})/)![1];
  const settingsHex = (token: string) => token.match(/--settings-canvas:(#[0-9a-f]{6})/)![1];
  const darkStage = Hct.fromInt(argbFromHex(stageHex(dark))), lightStage = Hct.fromInt(argbFromHex(stageHex(light)));
  assert.ok(darkStage.tone >= 6 && darkStage.tone <= 8 && darkStage.chroma <= 11);
  assert.ok(lightStage.tone >= 94 && lightStage.tone <= 96 && lightStage.chroma <= 7);
  const classicSettings = Hct.fromInt(argbFromHex(settingsHex(classic)));
  const darkSettings = Hct.fromInt(argbFromHex(settingsHex(dark)));
  const lightSettings = Hct.fromInt(argbFromHex(settingsHex(light)));
  assert.ok(classicSettings.tone >= 96 && classicSettings.tone <= 98 && classicSettings.chroma <= 5);
  assert.ok(darkSettings.tone >= 8 && darkSettings.tone <= 10 && darkSettings.chroma <= 7);
  assert.ok(lightSettings.tone >= 96 && lightSettings.tone <= 98 && lightSettings.chroma <= 5);
  assert.ok(!buildAppearanceTokens(APPEARANCE_DEFAULT, 'dark', 'light').includes('--stage-canvas'));
});

test('外观归一化保留 0 半径并清理自定义 CSS', () => {
  assert.deepEqual(normalizeAppearance(null), APPEARANCE_DEFAULT);
  assert.deepEqual(normalizeAppearance({}), APPEARANCE_DEFAULT);
  assert.equal(normalizeAppearance({ theme: 'sepia' }).theme, 'system');
  assert.equal(normalizeAppearance({ theme: 'dark' }).theme, 'dark');
  assert.equal(normalizeAppearance({ radius: 0 }).radius, 0);
  assert.equal(normalizeAppearance({ radius: '0' }).radius, 0);
  assert.equal(normalizeAppearance({ radius: -3 }).radius, 0);
  assert.equal(normalizeAppearance({ radius: 99 }).radius, 16);
  assert.equal(normalizeAppearance({ radius: 7.6 }).radius, 8);
  assert.equal(normalizeAppearance({ radius: '' }).radius, 8);
  assert.equal(normalizeAppearance({ radius: 'x' }).radius, 8);
  assert.equal(normalizeAppearance({ customCss: 'a\u0000b' }).customCss, 'ab');
  assert.equal(normalizeAppearance({ customCss: 'x'.repeat(CUSTOM_CSS_LIMIT + 5) }).customCss.length, CUSTOM_CSS_LIMIT);
  assert.equal(normalizeAppearance({ customCss: 12 }).customCss, '');
  assert.equal(normalizeAppearance({ customCssEnabled: true }).customCssEnabled, true);
  assert.equal(normalizeAppearance({ customCssEnabled: 'true' }).customCssEnabled, false);
  assert.equal(normalizeAppearance({ backgroundTint: true }).backgroundTint, true);
  assert.equal(normalizeAppearance({ backgroundTint: 'true' }).backgroundTint, false);
  assert.equal(normalizeAppearance({}).backgroundTint, false);
});

test('扫描外部 CSS 资源与摘要', () => {
  const css = [
    '@import url(https://example.com/a.css);',
    '@import "b.css";',
    '.one{background:url(data:image/png;base64,AAA)}',
    '.two{background:URL( \'../img/c.png\' )}',
    '.three{background:url(#grad)}',
    '.four{background:url(blob:https://example.com/x)}',
    '.five{background:url(about:blank)}',
    '.six{background:url(https://example.com/a.css)}'
  ].join('\n');
  assert.deepEqual(findExternalCssResources(css), [
    'https://example.com/a.css',
    'b.css',
    '../img/c.png'
  ]);
  assert.deepEqual(findExternalCssResources('@import; .x{background:url(data:image/png;base64,AA)}'), ['@import']);
  assert.deepEqual(findExternalCssResources(''), []);
  assert.equal(summarizeCssResources(['a', 'b', 'c']), 'a、b、c');
  assert.equal(summarizeCssResources(['a', 'b', 'c', 'd', 'e']), 'a、b、c 等 2 项');
  const long = 'x'.repeat(61);
  assert.equal(summarizeCssResources([long]), 'x'.repeat(60) + '…');
});

test('自定义 CSS 校验边界与 NUL 清理', () => {
  assert.equal(validateCustomCss(''), '');
  assert.equal(validateCustomCss('  .x{color:red}  '), '.x{color:red}');
  assert.equal(validateCustomCss('a\u0000b'), 'ab');
  assert.equal(validateCustomCss('x'.repeat(CUSTOM_CSS_LIMIT)).length, CUSTOM_CSS_LIMIT);
  assert.throws(
    () => validateCustomCss('x'.repeat(CUSTOM_CSS_LIMIT + 1)),
    /自定义 CSS 不能超过 16384 个字符。/
  );
  const nullable: unknown = null;
  assert.equal(validateCustomCss(nullable as string), '');
});

test('外观 token 文本包含主题色、对比色与圆角', () => {
  assert.equal(
    buildAppearanceTokens({ theme: 'dark', accent: '#6366f1', radius: 0, customCss: '', customCssEnabled: false, backgroundTint: false }),
    ':root{--color-accent:#6366f1;--accent-contrast:#ffffff;--radius-ui:0px}'
  );
  assert.equal(
    buildAppearanceTokens(APPEARANCE_DEFAULT),
    ':root{--color-accent:#65dc99;--accent-contrast:#0b0f0c;--radius-ui:8px}'
  );
});

test('AI 提示词包含当前配置并截断描述', () => {
  const prompt = buildThemePrompt(
    '薄荷绿、浅色、圆角大一点',
    { theme: 'classic', accent: '#65dc99', radius: 8 },
    'light'
  );
  assert.match(prompt, /只输出一个 JSON 对象/);
  assert.match(prompt, /theme=classic/);
  assert.match(prompt, /accent=#65dc99/);
  assert.match(prompt, /radius=8/);
  assert.match(prompt, /实际明暗=light/);
  assert.ok(prompt.includes(JSON.stringify('薄荷绿、浅色、圆角大一点')));
  const long = buildThemePrompt('a'.repeat(AI_PROMPT_LIMIT + 50),
    { theme: 'system', accent: '#65dc99', radius: 8 }, 'dark');
  assert.ok(long.includes(JSON.stringify('a'.repeat(AI_PROMPT_LIMIT))));
  assert.ok(!long.includes('a'.repeat(AI_PROMPT_LIMIT + 1)));
});

test('解析 AI 主题结果容忍围栏与说明，并处理 CSS 花括号', () => {
  assert.deepEqual(parseThemeResult('{"theme":"dark","accent":"#6366f1","radius":14}'), {
    theme: 'dark', accent: '#6366f1', radius: 14, css: ''
  });
  const fenced = '这是结果：\n```json\n{"theme":"light","accent":"#ABC","radius":"9.6","css":".a{color:red} .b{background:url(https://example.com/a.png)}"}\n```\n完成';
  assert.deepEqual(parseThemeResult(fenced), {
    theme: 'light', accent: '#aabbcc', radius: 10, css: '.a{color:red} .b{background:url(https://example.com/a.png)}'
  });
  assert.equal(parseThemeResult('{"theme":"classic","accent":"#111","radius":0}').radius, 0);
  assert.equal(parseThemeResult('{"theme":"classic","accent":"#111","radius":99}').radius, 16);
  assert.notEqual(parseThemeResult('{"theme":"dark","accent":"#ff0000","radius":4}').accent, '#ff0000');
  assert.throws(() => parseThemeResult(''), /AI 没有返回可识别的主题 JSON/);
  assert.throws(() => parseThemeResult('没有 JSON'), /AI 没有返回可识别的主题 JSON/);
  assert.throws(() => parseThemeResult('{oops}'), /AI 返回的主题不是有效的 JSON/);
  assert.throws(() => parseThemeResult('{"theme":"sepia","accent":"#111","radius":4}'), /主题偏好无效/);
  assert.throws(() => parseThemeResult('{"theme":"dark","accent":"red","radius":4}'), /主题色无效/);
  assert.throws(() => parseThemeResult('{"theme":"dark","accent":"#111","radius":"x"}'), /圆角无效/);
  assert.throws(() => parseThemeResult('{"theme":"dark","accent":"#111"}'), /圆角无效/);
  assert.throws(
    () => parseThemeResult(JSON.stringify({ theme: 'dark', accent: '#111', radius: 4, css: 'x'.repeat(CUSTOM_CSS_LIMIT + 1) })),
    /自定义 CSS 不能超过/
  );
  assert.equal(parseThemeResult('{"theme":"dark","accent":"#111","radius":4,"css":12}').css, '');
});

class FakeStyle {
  id = '';
  textContent = '';
}
class FakeHead {
  readonly children: FakeStyle[] = [];
  constructor(private readonly doc: FakeDocument) {}
  append(...nodes: FakeStyle[]) {
    for (const node of nodes) {
      const current = this.children.indexOf(node);
      if (current >= 0) this.children.splice(current, 1);
      this.children.push(node);
      if (node.id) this.doc.nodes.set(node.id, node);
    }
  }
}
class FakeDocument {
  readonly nodes = new Map<string, FakeStyle>();
  readonly head = new FakeHead(this);
  readonly documentElement = { dataset: {} as Record<string, string> };
  getElementById(id: string) { return this.nodes.get(id) ?? null; }
  createElement() { return new FakeStyle(); }
}

const fakeDocument = () => new FakeDocument();

test('应用外观写入数据集、样式顺序并遵守自定义 CSS 开关', () => {
  const doc = fakeDocument();
  applyAppearance(
    { theme: 'light', accent: '#6366f1', radius: 5, customCss: '.x{color:red}', customCssEnabled: true },
    { document: doc as unknown as Document, systemPrefersDark: true, mirror: false }
  );
  assert.deepEqual(doc.documentElement.dataset, {
    stageTheme: 'light', settingsTheme: 'light', themePreference: 'light', backgroundTint: 'false'
  });
  const tokens = doc.nodes.get('slate-appearance-tokens')!;
  const custom = doc.nodes.get('slate-appearance-custom-css')!;
  assert.equal(tokens.textContent, ':root{--color-accent:#6366f1;--accent-contrast:#ffffff;--radius-ui:5px}');
  assert.equal(custom.textContent, '.x{color:red}');
  assert.deepEqual(doc.head.children.map(node => node.id), ['slate-appearance-tokens', 'slate-appearance-custom-css']);

  applyAppearance(
    { theme: 'system', accent: '#65dc99', radius: 0, customCss: '.x{color:red}', customCssEnabled: false, backgroundTint: true },
    { document: doc as unknown as Document, systemPrefersDark: true, mirror: false }
  );
  assert.deepEqual(doc.documentElement.dataset, {
    stageTheme: 'dark', settingsTheme: 'dark', themePreference: 'system', backgroundTint: 'true'
  });
  assert.equal(custom.textContent, '');
  assert.deepEqual(doc.head.children.map(node => node.id), ['slate-appearance-tokens', 'slate-appearance-custom-css']);
});

test('关闭镜像时不写 storage，开启时防抖写入可读镜像', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = fakeDocument();
  const writes: string[] = [];
  const storage = {
    getItem: () => null,
    setItem: (_key: string, value: string) => { writes.push(value); }
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  try {
    applyAppearance(
      { theme: 'dark', accent: '#111', radius: 4, customCss: '', customCssEnabled: false },
      { document: doc as unknown as Document, systemPrefersDark: false, mirror: false }
    );
    t.mock.timers.tick(220);
    assert.equal(writes.length, 0);
    applyAppearance(
      { theme: 'dark', accent: '#111', radius: 4, customCss: '', customCssEnabled: false },
      { document: doc as unknown as Document, systemPrefersDark: false }
    );
    t.mock.timers.tick(220);
    assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(writes[0]), {
      theme: 'dark', accent: '#111111', radius: 4, customCss: '', customCssEnabled: false, backgroundTint: false
    });
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as Record<string, unknown>).localStorage;
  }
});
