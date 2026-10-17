<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import DesktopSettings from './DesktopSettings.vue';
import AppearancePreview from './AppearancePreview.vue';
import { BrowserFullscreenPort } from '../platform/browser';
import type { ClassState, ThemePreference } from '../../shared/domain/model';
import type { ApplicationActions } from '../application/controller.js';
import {
  ACCENT_PRESETS,
  AI_PROMPT_LIMIT,
  CUSTOM_CSS_LIMIT,
  accentContrast,
  applyAppearance,
  buildThemePrompt,
  constrainAccent,
  findExternalCssResources,
  isHexColor,
  normalizeAccent,
  parseThemeResult,
  themeLabel,
  validateCustomCss,
  type AppearanceValue,
  type ParsedTheme
} from '../application/appearance';

const props = defineProps<{
  state: ClassState;
  busy: boolean;
  recoveryRequired: boolean;
  actions?: ApplicationActions;
}>();

const desktop = Boolean(window.slateDesktop);
const fullscreenPort = new BrowserFullscreenPort();
const fullscreen = ref(fullscreenPort.active);
const fullscreenError = ref('');
const fullscreenAvailable = Boolean(document.documentElement.requestFullscreen);
const syncFullscreen = (): void => { fullscreen.value = fullscreenPort.active; };
async function toggleFullscreen(): Promise<void> {
  fullscreenError.value = '';
  try { await fullscreenPort.toggle(); syncFullscreen(); }
  catch (error: unknown) { fullscreenError.value = error instanceof Error ? error.message : '当前浏览器无法进入全屏。'; }
}

const blocked = computed(() => props.busy || props.recoveryRequired || !props.actions);
const themeOptions: { id: ThemePreference; name: string }[] = [
  { id: 'system', name: '跟随系统' },
  { id: 'light', name: '浅色' },
  { id: 'dark', name: '深色' },
  { id: 'classic', name: '经典' }
];
const AI_EXAMPLES = ['薄荷绿、浅色、圆角大一点', '午夜蓝、深色、直角', '樱花粉、经典、柔和圆角'];

const themeDraft = ref<ThemePreference>(props.state.settings.theme);
const accentDraft = ref(props.state.settings.accent);
const radiusDraft = ref(props.state.settings.radius);
const hexDraft = ref(props.state.settings.accent);
const cssDraft = ref(props.state.settings.customCss);
const cssFileInput = ref<HTMLInputElement | null>(null);
const backgroundTintDraft = ref(props.state.settings.backgroundTint);
const appearanceError = ref('');
const accentError = ref('');

const appearanceKey = computed(() => JSON.stringify([
  props.state.settings.theme, props.state.settings.accent, props.state.settings.radius,
  props.state.settings.backgroundTint
]));
const cssKey = computed(() => JSON.stringify([
  props.state.settings.customCss, props.state.settings.customCssEnabled
]));
watch(appearanceKey, () => {
  const settings = props.state.settings;
  themeDraft.value = settings.theme;
  accentDraft.value = settings.accent;
  radiusDraft.value = settings.radius;
  hexDraft.value = settings.accent;
  backgroundTintDraft.value = settings.backgroundTint;
  accentError.value = '';
}, { immediate: true });
watch(cssKey, () => { cssDraft.value = props.state.settings.customCss; }, { immediate: true });

const systemDark = ref(typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)').matches
  : true);
let mediaQuery: MediaQueryList | undefined;
const onSystemTheme = (event: MediaQueryListEvent): void => { systemDark.value = event.matches; };

const cssEnabled = computed(() => props.state.settings.customCssEnabled);

function previewAppearance(patch: Partial<AppearanceValue>): void {
  applyAppearance({
    ...props.state.settings,
    theme: themeDraft.value,
    accent: accentDraft.value,
    radius: radiusDraft.value,
    backgroundTint: backgroundTintDraft.value,
    ...patch
  });
}

function resetVisualDrafts(): void {
  const settings = props.state.settings;
  themeDraft.value = settings.theme;
  accentDraft.value = settings.accent;
  radiusDraft.value = settings.radius;
  hexDraft.value = settings.accent;
  backgroundTintDraft.value = settings.backgroundTint;
  accentError.value = '';
  applyAppearance(settings);
}

function commitAppearance(patch: Partial<AppearanceValue>): boolean {
  const ok = props.actions?.updateAppearance(patch) ?? false;
  if (!ok) {
    appearanceError.value = '保存失败，请检查本机存储。';
    resetVisualDrafts();
  } else appearanceError.value = '';
  return ok;
}

function chooseTheme(theme: ThemePreference): void {
  themeDraft.value = theme;
  previewAppearance({ theme });
  commitAppearance({ theme });
}

const swatchStyle = (color: string): Record<string, string> => ({
  '--swatch': color,
  color: accentContrast(color)
});

function chooseAccent(color: string, constrain = true): void {
  const accent = constrain ? constrainAccent(color) : normalizeAccent(color);
  accentDraft.value = accent;
  hexDraft.value = accent;
  accentError.value = '';
  previewAppearance({ accent });
  commitAppearance({ accent });
}

function onAccentInput(event: Event): void {
  const accent = constrainAccent((event.target as HTMLInputElement).value);
  accentDraft.value = accent;
  hexDraft.value = accent;
  previewAppearance({ accent });
}

function onAccentChange(): void {
  commitAppearance({ accent: accentDraft.value });
}

function commitHex(): void {
  const value = hexDraft.value.trim();
  if (!isHexColor(value)) {
    accentError.value = '请输入 #rgb 或 #rrggbb 颜色。';
    return;
  }
  chooseAccent(value);
}

function toggleBackgroundTint(event: Event): void {
  const enabled = (event.target as HTMLInputElement).checked;
  backgroundTintDraft.value = enabled;
  previewAppearance({ backgroundTint: enabled });
  commitAppearance({ backgroundTint: enabled });
}

function onRadiusInput(event: Event): void {
  const value = Math.max(0, Math.min(16, Math.round(Number((event.target as HTMLInputElement).value))));
  radiusDraft.value = Number.isFinite(value) ? value : props.state.settings.radius;
  previewAppearance({ radius: radiusDraft.value });
}

function commitRadius(): void {
  commitAppearance({ radius: radiusDraft.value });
}

const aiPrompt = ref('');
const aiBusy = ref(false);
const aiError = ref('');
const aiStatus = ref('');
const aiResult = ref<ParsedTheme | null>(null);
const aiConfirm = ref(false);
let aiController: AbortController | undefined;
const aiExternal = computed(() => aiResult.value?.css ? findExternalCssResources(aiResult.value.css) : []);

async function openProviders(): Promise<void> {
  aiError.value = '';
  try {
    if (!window.VisionProviders?.open) throw new Error('AI 服务尚未就绪，请稍后重试。');
    await window.VisionProviders.open();
  } catch (error: unknown) {
    aiError.value = error instanceof Error ? error.message : '无法打开 AI 服务设置。';
  }
}

async function generateTheme(): Promise<void> {
  const prompt = aiPrompt.value.trim();
  if (!prompt || aiBusy.value || blocked.value || !window.VisionProviders?.completeTheme) return;
  aiBusy.value = true;
  aiError.value = '';
  aiStatus.value = '';
  aiResult.value = null;
  aiConfirm.value = false;
  aiController = new AbortController();
  try {
    const raw = await window.VisionProviders.completeTheme(
      buildThemePrompt(prompt, {
        theme: props.state.settings.theme,
        accent: props.state.settings.accent,
        radius: props.state.settings.radius
      }, systemDark.value ? 'dark' : 'light'),
      { signal: aiController.signal, timeoutMs: 60000 }
    );
    aiResult.value = parseThemeResult(raw);
  } catch (error: unknown) {
    if ((error as Error)?.name !== 'AbortError') {
      aiError.value = error instanceof Error ? error.message : '主题生成失败，请重试。';
    }
  } finally {
    aiBusy.value = false;
    aiController = undefined;
  }
}

function cancelAi(): void {
  aiController?.abort();
}

function applyAiTheme(): void {
  const result = aiResult.value;
  if (!result) return;
  let css = '';
  try { css = validateCustomCss(result.css); }
  catch (error: unknown) {
    aiError.value = error instanceof Error ? error.message : '生成的 CSS 无效。';
    return;
  }
  const patch: Partial<AppearanceValue> = {
    theme: result.theme, accent: result.accent, radius: result.radius
  };
  if (css) Object.assign(patch, { customCss: css, customCssEnabled: true });
  if (commitAppearance(patch)) {
    aiResult.value = null;
    aiConfirm.value = false;
    aiError.value = '';
    aiStatus.value = '已应用 AI 主题';
  }
}

function startApplyAi(): void {
  if (!aiResult.value) return;
  if (aiExternal.value.length && !aiConfirm.value) {
    aiConfirm.value = true;
    return;
  }
  applyAiTheme();
}

const cssError = ref('');
const cssStatus = ref('');
const cssConfirm = ref(false);
const cssPendingCss = ref('');
const cssPendingExternal = ref<string[]>([]);

function saveCss(): void {
  let css = '';
  try { css = validateCustomCss(cssDraft.value); }
  catch (error: unknown) {
    cssError.value = error instanceof Error ? error.message : '自定义 CSS 无效。';
    return;
  }
  cssError.value = '';
  cssStatus.value = '';
  cssConfirm.value = false;
  const external = css ? findExternalCssResources(css) : [];
  if (external.length) {
    cssPendingCss.value = css;
    cssPendingExternal.value = external;
    cssConfirm.value = true;
    return;
  }
  commitCss(css);
}

function commitCss(css: string): void {
  if (commitAppearance({ customCss: css, customCssEnabled: Boolean(css) })) {
    cssDraft.value = css;
    cssConfirm.value = false;
    cssPendingCss.value = '';
    cssPendingExternal.value = [];
    cssStatus.value = css ? '已保存并应用自定义 CSS。' : '已清空自定义 CSS。';
  }
}

function confirmCss(): void {
  commitCss(cssPendingCss.value);
}

function cancelCssConfirm(): void {
  cssConfirm.value = false;
  cssPendingCss.value = '';
  cssPendingExternal.value = [];
}

function disableCss(): void {
  if (commitAppearance({ customCssEnabled: false })) cssStatus.value = '已停用，文本会保留。';
}

function clearCss(): void {
  cssDraft.value = '';
  cssError.value = '';
  cssStatus.value = '';
  cssConfirm.value = false;
  cssPendingCss.value = '';
  cssPendingExternal.value = [];
  commitAppearance({ customCss: '', customCssEnabled: false });
}

async function importCssFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  cssError.value = '';
  try {
    if (file.size > CUSTOM_CSS_LIMIT * 4) throw new Error('CSS 文件过大，请选择 16384 个字符以内的片段。');
    const text = await file.text();
    if (text.length > CUSTOM_CSS_LIMIT) throw new Error('自定义 CSS 最多 ' + CUSTOM_CSS_LIMIT + ' 个字符。');
    cssDraft.value = text;
    cssStatus.value = '已读入文件，确认后保存并应用。';
    cssConfirm.value = false;
  } catch (error: unknown) {
    cssError.value = error instanceof Error ? error.message : '无法读取 CSS 文件。';
  } finally {
    input.value = '';
  }
}

onMounted(() => {
  document.addEventListener('fullscreenchange', syncFullscreen);
  if (typeof window.matchMedia === 'function') {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', onSystemTheme);
  }
});
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', syncFullscreen);
  mediaQuery?.removeEventListener('change', onSystemTheme);
  aiController?.abort();
});
</script>

<template>
  <section id="view-general" class="view" aria-label="通用设置">
    <div class="page-heading"><div><h2>通用</h2><p class="page-description">{{ desktop ? '外观、程序启动、窗口与系统权限' : '外观、浏览器本地存储与画面偏好' }}</p></div></div>

    <section id="appearanceSection" class="appearance-section" aria-labelledby="appearanceTitle">
      <h3 id="appearanceTitle">外观</h3>
      <p class="appearance-intro">调整界面圆角、主题色种子和明暗主题，改动会即时预览并自动保存。</p>

      <AppearancePreview :settings="{ theme: themeDraft, accent: accentDraft, radius: radiusDraft }" :system-dark="systemDark" />

      <div class="appearance-theme-picker" role="group" aria-label="明暗主题">
        <button v-for="option in themeOptions" :key="option.id" type="button" :data-appearance-theme="option.id"
          :aria-pressed="themeDraft === option.id" :disabled="blocked" @click="chooseTheme(option.id)">
          <span class="theme-option-mark" aria-hidden="true"></span>{{ option.name }}
        </button>
      </div>

      <div class="appearance-field">
        <span class="appearance-field-label">主题色种子</span>
        <div class="appearance-swatches" role="group" aria-label="主题色种子预设">
          <button v-for="preset in ACCENT_PRESETS" :key="preset.id" type="button" class="appearance-swatch"
            :data-appearance-accent="preset.id" :style="swatchStyle(preset.color)" :aria-label="preset.name"
            :aria-pressed="accentDraft === preset.color" :disabled="blocked" @click="chooseAccent(preset.color, false)">
            <span v-if="accentDraft === preset.color" class="icon material-icon" aria-hidden="true">check</span>
          </button>
          <label class="appearance-custom-color" title="自定义主题色种子">
            <input type="color" :value="accentDraft" aria-label="自定义主题色种子" :disabled="blocked"
              @input="onAccentInput" @change="onAccentChange">
            <span class="appearance-custom-dot" aria-hidden="true"></span>
          </label>
          <input id="appearanceAccentHex" v-model="hexDraft" class="appearance-hex" type="text" maxlength="7" spellcheck="false"
            autocomplete="off" aria-label="自定义主题色种子十六进制值" :disabled="blocked"
            @change="commitHex" @keydown.enter.prevent="commitHex">
        </div>
        <p class="appearance-hint">自定义颜色会自动调到更适合界面的饱和度与亮度。当前主题色 {{ accentDraft }} · 文字对比色 {{ accentContrast(accentDraft) }}</p>
        <p v-if="accentError" class="appearance-error" role="alert">{{ accentError }}</p>
      </div>

      <label class="desktop-setting-row appearance-toggle">
        <span><strong>背景颜色扩散</strong><small>让主题色种子在舞台背景上轻轻铺开。</small></span>
        <input id="appearanceBackgroundTint" type="checkbox" class="rect-switch" role="switch"
          aria-label="背景颜色扩散" :checked="backgroundTintDraft" :disabled="blocked" @change="toggleBackgroundTint">
      </label>

      <label class="appearance-slider" for="appearanceRadius">
        <span>圆角尺寸</span>
        <input id="appearanceRadius" type="range" min="0" max="16" step="1" :value="radiusDraft"
          aria-describedby="appearanceRadiusHint" :disabled="blocked"
          @input="onRadiusInput" @change="commitRadius" @blur="commitRadius" @keydown.enter.prevent="commitRadius">
        <output>{{ radiusDraft }} px</output>
      </label>
      <p id="appearanceRadiusHint" class="appearance-hint">0 为直角，16 最圆润；按钮、座位和对话框会按不同比例跟随，内层圆角自动收窄。</p>
      <p v-if="appearanceError" class="appearance-error" role="alert">{{ appearanceError }}</p>

      <div class="appearance-subsection appearance-ai">
        <div class="appearance-subsection-heading">
          <h4>AI 生成主题</h4>
          <button id="appearanceProviderBtn" type="button" class="text-btn" :disabled="blocked" @click="openProviders">配置 AI 服务</button>
        </div>
        <p class="appearance-privacy">只发送你的文字描述；名单、座位和统计留在这台设备上。</p>
        <div class="appearance-ai-chips">
          <button v-for="example in AI_EXAMPLES" :key="example" type="button" @click="aiPrompt = example">{{ example }}</button>
        </div>
        <textarea id="appearanceAiPrompt" v-model="aiPrompt" :maxlength="AI_PROMPT_LIMIT" rows="3"
          placeholder="例如：海盐薄荷，圆润一些，适合投影" :disabled="blocked || aiBusy"></textarea>
        <div class="appearance-ai-actions">
          <button id="appearanceAiGenerate" type="button" class="btn btn-primary"
            :disabled="blocked || aiBusy || !aiPrompt.trim()" @click="generateTheme">生成主题</button>
          <button v-if="aiBusy" type="button" class="btn" @click="cancelAi">取消</button>
          <span class="appearance-status" role="status">{{ aiBusy ? '正在生成…' : aiStatus }}</span>
        </div>
        <p v-if="aiError" class="appearance-error" role="alert">{{ aiError }}</p>

        <div v-if="aiResult" id="appearanceAiResult" class="appearance-ai-result">
          <p><strong>{{ themeLabel(aiResult.theme, systemDark) }}</strong> · 圆角 {{ aiResult.radius }} px</p>
          <div class="appearance-ai-swatches">
            <i class="appearance-ai-swatch" :style="{ background: aiResult.accent }"></i>
            <code>{{ aiResult.accent }}</code>
            <span>文字对比色 {{ accentContrast(aiResult.accent) }}</span>
          </div>
          <p v-if="!aiResult.css" class="appearance-hint">这次没有生成 CSS，现有自定义 CSS 会继续使用。</p>
          <p v-else-if="cssEnabled" class="appearance-hint">应用后会替换当前自定义 CSS。</p>
          <details v-if="aiResult.css">
            <summary>查看生成的 CSS（{{ aiResult.css.length }} 字符）</summary>
            <pre>{{ aiResult.css }}</pre>
          </details>
          <div v-if="aiExternal.length" class="appearance-warning">
            <p>这段 CSS 会加载外部资源，可能向对应服务器发送请求。仅在信任来源时继续。</p>
            <ul><li v-for="resource in aiExternal.slice(0, 5)" :key="resource">{{ resource }}</li></ul>
            <p v-if="aiExternal.length > 5">等 {{ aiExternal.length }} 项</p>
            <div v-if="aiConfirm" class="appearance-warning-actions">
              <button type="button" class="btn" @click="aiConfirm = false">取消</button>
              <button type="button" class="btn btn-primary" @click="applyAiTheme">仍然应用</button>
            </div>
          </div>
          <button type="button" class="btn btn-primary" :disabled="blocked" @click="startApplyAi">应用此主题</button>
        </div>
      </div>

      <div class="appearance-subsection appearance-css">
        <div class="appearance-subsection-heading">
          <h4>自定义 CSS</h4>
          <span class="appearance-css-count">{{ cssDraft.length }} / {{ CUSTOM_CSS_LIMIT }}</span>
        </div>
        <p class="appearance-hint">支持选择器、变量、渐变和动画。CSS 会在最后加载，可以细调外观；含有外部资源的片段会在保存或恢复备份前再次确认。</p>
        <textarea id="appearanceCss" v-model="cssDraft" rows="8" :maxlength="CUSTOM_CSS_LIMIT" spellcheck="false"
          placeholder=":root { --accent-edge: #ffb86b; }" :disabled="blocked"></textarea>
        <div class="appearance-css-actions">
          <button id="appearanceCssSave" type="button" class="btn btn-primary" :disabled="blocked" @click="saveCss">保存并应用</button>
          <button v-if="cssEnabled" type="button" class="btn" :disabled="blocked" @click="disableCss">停用</button>
          <button id="appearanceCssClear" type="button" class="btn" :disabled="blocked" @click="clearCss">清空</button>
          <button id="appearanceCssImport" type="button" class="btn" :disabled="blocked" @click="cssFileInput?.click()">从文件导入</button>
          <input id="appearanceCssFile" ref="cssFileInput" type="file" accept=".css,text/css" class="sr-only" tabindex="-1" :disabled="blocked" @change="importCssFile">
          <span class="appearance-status" role="status">{{ cssStatus }}</span>
        </div>
        <p v-if="cssError" class="appearance-error" role="alert">{{ cssError }}</p>
        <div v-if="cssConfirm" id="appearanceCssWarning" class="appearance-warning">
          <p>这段 CSS 会加载外部资源，可能向对应服务器发送请求。仅在信任来源时继续。</p>
          <ul><li v-for="resource in cssPendingExternal.slice(0, 5)" :key="resource">{{ resource }}</li></ul>
          <p v-if="cssPendingExternal.length > 5">等 {{ cssPendingExternal.length }} 项</p>
          <div class="appearance-warning-actions">
            <button type="button" class="btn" @click="cancelCssConfirm">取消</button>
            <button type="button" class="btn btn-primary" @click="confirmCss">仍然应用</button>
          </div>
        </div>
      </div>
    </section>

    <DesktopSettings />
    <div v-if="!desktop" class="settings-info-block">
      <span class="icon material-icon" aria-hidden="true">preview</span>
      <div><h3>SlateRandom 岩选 <span class="edition-badge">LITE</span></h3><p>当前为可离线使用的浏览器版本。名单与设置自动保存在此浏览器，跨设备使用时可在「数据」页面导出或恢复全部备份。</p></div>
    </div>
    <label v-if="!desktop" class="desktop-setting-row"><span><strong>全屏显示</strong><small>使用完整屏幕显示抽选画面，可按 Esc 退出。</small></span><input id="liteFullscreenInput" type="checkbox" class="rect-switch" role="switch" aria-label="全屏显示" :checked="fullscreen" :disabled="!fullscreenAvailable" @change="toggleFullscreen"></label>
    <p v-if="fullscreenError" class="error-message" role="alert">{{ fullscreenError }}</p>
    <article class="settings-info-section"><h3>{{ desktop ? '窗口操作' : '画面与操作' }}</h3>
      <p v-if="desktop">点击悬浮球打开主界面，左下角红色关闭按钮收回主界面。拖动悬浮球靠近屏幕左右边缘即可吸附；按住 3 秒后确认可退出程序。</p>
      <p>点击右下角「全览」按钮显示全部座位，再次点击返回普通视图；按钮亮起表示已开启全览。</p>
      <p class="field-hint">抽选模式、动画和朗读在「功能」页面配置；名单导入与座位编辑在「名单」页面管理。</p>
    </article>
  </section>
</template>
