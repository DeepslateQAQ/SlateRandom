<script setup lang="ts">
import { computed } from 'vue';
import type { DesktopDraft, DesktopState } from '../desktop/types';
import { elevationChoiceDraft, selectedElevation, type ElevationChoice } from '../application/onboarding';

const props = defineProps<{
  state: DesktopState | null;
  draft: DesktopDraft | null;
  pending: boolean;
  error: string;
  busy: boolean;
}>();

const emit = defineEmits<{
  autostart: [enabled: boolean];
  draft: [patch: Partial<DesktopDraft>];
}>();

const disabled = computed(() => props.pending || props.busy || !props.state || !props.draft);
const autostart = computed(() => props.state?.settings.autostart ?? false);
const alternateMethod = computed<'compatibility' | 'task'>(() => autostart.value ? 'task' : 'compatibility');

/** Mirrors the settings page: the stored autostart decides which method applies. */
const selectedMethod = computed<ElevationChoice>(() => props.draft
  ? selectedElevation(props.draft, autostart.value)
  : 'disabled');

const elevationHint = computed(() => {
  const method = selectedMethod.value;
  if (method === 'disabled') return '以普通权限运行';
  if (autostart.value) return method === 'task' ? '通过计划任务登录自启' : '登录后申请 UAC 授权';
  return method === 'compatibility' ? '使用 Windows 兼容性设置' : '启动时申请 UAC 授权';
});

const draftUac = computed(() => props.draft?.uac === true);
const draftUiAccess = computed(() => props.draft?.uiAccess === true);

function changeAutostart(event: Event): void {
  const input = event.target as HTMLInputElement;
  const enabled = input.checked;
  // Keep the native control honest until the bridge answers.
  input.checked = autostart.value;
  if (disabled.value) return;
  emit('autostart', enabled);
}

function changeElevation(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (disabled.value) return;
  const patch = elevationChoiceDraft(input.value as ElevationChoice, autostart.value);
  if (patch) emit('draft', patch);
}

function changeUiAccess(event: Event): void {
  if (disabled.value) return;
  emit('draft', { uiAccess: (event.target as HTMLInputElement).checked });
}
</script>

<template>
  <div class="onboarding-desktop">
    <label class="desktop-setting-row">
      <span><strong>开机自启</strong><small>登录 Windows 时自动启动 SlateRandom</small></span>
      <input id="onboardingAutostartInput" type="checkbox" class="rect-switch" role="switch" aria-label="开机自启"
        :checked="autostart" :disabled="disabled" @change="changeAutostart">
    </label>

    <div class="desktop-setting-row desktop-elevation-method">
      <span><strong id="onboardingElevationLabel">提权方式</strong><small id="onboardingElevationHint">{{ elevationHint }}</small></span>
      <fieldset id="onboardingElevationMethod" class="elevation-mode-picker" aria-labelledby="onboardingElevationLabel"
        aria-describedby="onboardingElevationHint" :disabled="disabled">
        <label class="elevation-mode-option">
          <input type="radio" name="onboardingElevationMethod" value="disabled" :checked="selectedMethod === 'disabled'" @change="changeElevation">
          <span>禁用</span>
        </label>
        <label class="elevation-mode-option">
          <input type="radio" name="onboardingElevationMethod" value="uac" :checked="selectedMethod === 'uac'" @change="changeElevation">
          <span>UAC</span>
        </label>
        <label class="elevation-mode-option">
          <input type="radio" name="onboardingElevationMethod" :value="alternateMethod" :checked="selectedMethod === alternateMethod" @change="changeElevation">
          <span>{{ autostart ? '计划任务' : '兼容性' }}</span>
        </label>
      </fieldset>
    </div>
    <p v-if="selectedMethod === 'compatibility'" class="field-hint">右键 SlateRandom.exe → 属性 → 兼容性，勾选「以管理员身份运行此程序」。</p>

    <label class="desktop-setting-row">
      <span><strong>UIAccess 全局置顶</strong><small>{{ draftUac ? '自动申请 UIAccess 令牌，兼容性模式同样需要程序授权' : '选择提权方式后可启用' }}</small></span>
      <input id="onboardingUiAccessInput" type="checkbox" class="rect-switch" role="switch" aria-label="UIAccess 全局置顶"
        :checked="draftUiAccess" :disabled="disabled || !draftUac" @change="changeUiAccess">
    </label>

    <p id="onboardingDesktopStatus" class="field-hint desktop-runtime-status" role="status">
      <span v-if="pending">正在应用桌面设置…</span>
      <span v-else-if="state">{{ state.runtime.status }}<span v-if="state.runtime.requiresRestart"> · 完成引导后生效</span></span>
      <span v-else>正在读取桌面设置…</span>
    </p>
    <p v-if="error || state?.runtime.error" id="onboardingDesktopError" class="error-message" role="alert">{{ error || state?.runtime.error }}</p>
  </div>
</template>
