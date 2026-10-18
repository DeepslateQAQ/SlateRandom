<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppearancePreview from './AppearancePreview.vue';
import type { Settings, ThemePreference } from '../../shared/domain/model';
import type { ApplicationActions } from '../application/controller.js';
import {
  ACCENT_PRESETS,
  accentContrast,
  applyAppearance,
  constrainAccent,
  isHexColor,
  normalizeAccent,
  type AppearanceValue
} from '../application/appearance';

const props = defineProps<{
  settings: Settings;
  busy: boolean;
  actions?: ApplicationActions;
}>();

const themeOptions: { id: ThemePreference; name: string }[] = [
  { id: 'system', name: '跟随系统' },
  { id: 'light', name: '浅色' },
  { id: 'dark', name: '深色' },
  { id: 'classic', name: '经典' }
];

const themeDraft = ref<ThemePreference>(props.settings.theme);
const accentDraft = ref(props.settings.accent);
const radiusDraft = ref(props.settings.radius);
const hexDraft = ref(props.settings.accent);
const backgroundTintDraft = ref(props.settings.backgroundTint);
const error = ref('');
const accentError = ref('');

const systemDark = ref(typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)').matches
  : true);
let mediaQuery: MediaQueryList | undefined;
const onSystemTheme = (event: MediaQueryListEvent): void => { systemDark.value = event.matches; };
onMounted(() => {
  if (typeof window.matchMedia !== 'function') return;
  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', onSystemTheme);
});
onBeforeUnmount(() => { mediaQuery?.removeEventListener('change', onSystemTheme); });

const settingsKey = computed(() => JSON.stringify([
  props.settings.theme, props.settings.accent, props.settings.radius, props.settings.backgroundTint
]));

function loadDrafts(): void {
  themeDraft.value = props.settings.theme;
  accentDraft.value = props.settings.accent;
  radiusDraft.value = props.settings.radius;
  hexDraft.value = props.settings.accent;
  backgroundTintDraft.value = props.settings.backgroundTint;
  accentError.value = '';
}

watch(settingsKey, loadDrafts, { immediate: true });

const previewValue = computed(() => ({
  theme: themeDraft.value,
  accent: accentDraft.value,
  radius: radiusDraft.value,
  backgroundTint: backgroundTintDraft.value
}));

function preview(patch: Partial<AppearanceValue> = {}): void {
  applyAppearance({
    ...props.settings,
    theme: themeDraft.value,
    accent: accentDraft.value,
    radius: radiusDraft.value,
    backgroundTint: backgroundTintDraft.value,
    ...patch
  });
}

/** A rejected save keeps the stored value and shows why instead of a silent revert. */
function commit(patch: Partial<AppearanceValue>): boolean {
  const saved = props.actions?.updateAppearance(patch) ?? false;
  if (saved) { error.value = ''; return true; }
  error.value = '外观未能保存，请检查本机存储。';
  loadDrafts();
  applyAppearance(props.settings);
  return false;
}

function chooseTheme(theme: ThemePreference): void {
  if (props.busy) return;
  themeDraft.value = theme;
  preview({ theme });
  commit({ theme });
}

const swatchStyle = (color: string): Record<string, string> => ({
  '--swatch': color,
  color: accentContrast(color)
});

function chooseAccent(color: string, constrain = true): void {
  if (props.busy) return;
  const accent = constrain ? constrainAccent(color) : normalizeAccent(color);
  accentDraft.value = accent;
  hexDraft.value = accent;
  accentError.value = '';
  preview({ accent });
  commit({ accent });
}

function onAccentInput(event: Event): void {
  const accent = constrainAccent((event.target as HTMLInputElement).value);
  accentDraft.value = accent;
  hexDraft.value = accent;
  preview({ accent });
}

function onAccentChange(): void {
  if (!props.busy) commit({ accent: accentDraft.value });
}

function commitHex(): void {
  const value = hexDraft.value.trim();
  if (!isHexColor(value)) { accentError.value = '请输入 #rgb 或 #rrggbb 颜色。'; return; }
  chooseAccent(value);
}

function toggleBackgroundTint(event: Event): void {
  if (props.busy) return;
  const enabled = (event.target as HTMLInputElement).checked;
  backgroundTintDraft.value = enabled;
  preview({ backgroundTint: enabled });
  commit({ backgroundTint: enabled });
}

function onRadiusInput(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value);
  radiusDraft.value = Number.isFinite(raw) ? Math.max(0, Math.min(16, Math.round(raw))) : props.settings.radius;
  preview({ radius: radiusDraft.value });
}

function commitRadius(): void {
  if (props.busy) return;
  commit({ radius: radiusDraft.value });
}

// Leaving the step drops any preview that never reached the store.
onBeforeUnmount(() => applyAppearance(props.settings));
</script>

<template>
  <div class="onboarding-appearance">
    <AppearancePreview id="onboardingAppearancePreview" :settings="previewValue" :system-dark="systemDark" />

    <div class="appearance-theme-picker" role="group" aria-label="明暗主题">
      <button v-for="option in themeOptions" :key="option.id" type="button"
        :data-appearance-theme="option.id" :data-onboarding-theme="option.id"
        :aria-pressed="themeDraft === option.id" :disabled="busy" @click="chooseTheme(option.id)">
        <span class="theme-option-mark" aria-hidden="true"></span>{{ option.name }}
      </button>
    </div>

    <div class="appearance-field">
      <span class="appearance-field-label">主题色种子</span>
      <div class="appearance-swatches" role="group" aria-label="主题色种子预设">
        <button v-for="preset in ACCENT_PRESETS" :key="preset.id" type="button" class="appearance-swatch"
          :data-onboarding-accent="preset.id" :style="swatchStyle(preset.color)" :aria-label="preset.name"
          :aria-pressed="accentDraft === preset.color" :disabled="busy" @click="chooseAccent(preset.color, false)">
          <span v-if="accentDraft === preset.color" class="icon material-icon" aria-hidden="true">check</span>
        </button>
        <label class="appearance-custom-color" title="自定义主题色种子">
          <input type="color" :value="accentDraft" aria-label="自定义主题色种子" :disabled="busy"
            @input="onAccentInput" @change="onAccentChange">
          <span class="appearance-custom-dot" aria-hidden="true"></span>
        </label>
        <input id="onboardingAccentHex" v-model="hexDraft" class="appearance-hex" type="text" maxlength="7" spellcheck="false"
          autocomplete="off" aria-label="自定义主题色种子十六进制值" :disabled="busy"
          @change="commitHex" @keydown.enter.prevent="commitHex">
      </div>
      <p class="appearance-hint">自定义颜色会自动调到更适合界面的饱和度与亮度。</p>
      <p v-if="accentError" class="appearance-error" role="alert">{{ accentError }}</p>
    </div>

    <label class="desktop-setting-row appearance-toggle">
      <span><strong>背景颜色扩散</strong><small>让主题色种子在舞台背景上轻轻铺开。</small></span>
      <input id="onboardingBackgroundTintInput" type="checkbox" class="rect-switch" role="switch"
        aria-label="背景颜色扩散" :checked="backgroundTintDraft" :disabled="busy" @change="toggleBackgroundTint">
    </label>

    <label class="appearance-slider" for="onboardingRadiusInput">
      <span>圆角尺寸</span>
      <input id="onboardingRadiusInput" type="range" min="0" max="16" step="1" :value="radiusDraft"
        aria-describedby="onboardingRadiusHint" :disabled="busy"
        @input="onRadiusInput" @change="commitRadius" @blur="commitRadius" @keydown.enter.prevent="commitRadius">
      <output>{{ radiusDraft }} px</output>
    </label>
    <p id="onboardingRadiusHint" class="appearance-hint">0 为直角，16 最圆润。</p>
    <p v-if="error" id="onboardingAppearanceError" class="appearance-error" role="alert">{{ error }}</p>
  </div>
</template>
