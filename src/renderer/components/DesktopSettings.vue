<script setup lang="ts">
import { computed } from 'vue';
import { useDesktopState, updateDesktopSettings } from '../desktop/state';
import type { DesktopSettings } from '../desktop/types';

const available = Boolean(window.slateDesktop);
const { state, pending, error } = useDesktopState();
const startup = computed(() => state.value?.settings.autostart ?? false);
const alternateMethod = computed(() => startup.value ? 'task' : 'compatibility');
const selectedMethod = computed(() => {
  const settings = state.value?.settings;
  return !settings?.uac ? 'disabled' : settings.autostart ? settings.autostartElevation : settings.manualElevation;
});

async function toggle(key: 'autostart' | 'uiAccess' | 'showFloatingBall' | 'drawOnBallClick' | 'externalDrawProtocols' | 'slaterandomProtocol', event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  await updateDesktopSettings({ [key]: input.checked });
  input.checked = state.value?.settings[key] ?? false;
}
async function changeElevation(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const picker = input.closest('fieldset');
  const value = input.value;
  const hadFocus = document.activeElement === input;
  let patch: Partial<DesktopSettings>;
  if (value === 'disabled') patch = { uac: false, uiAccess: false };
  else if (startup.value && (value === 'uac' || value === 'task')) patch = { uac: true, autostartElevation: value };
  else if (!startup.value && (value === 'uac' || value === 'compatibility')) patch = { uac: true, manualElevation: value };
  else return;
  await updateDesktopSettings(patch);
  // A rejected save may retain the same reactive value; restore native selection too.
  picker?.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach(radio => {
    radio.checked = radio.value === selectedMethod.value;
  });
  if (hadFocus && (document.activeElement === document.body || document.activeElement === input)) {
    picker?.querySelector<HTMLInputElement>('input:checked')?.focus({ preventScroll: true });
  }
}
</script>

<template>
  <section v-if="available" id="desktopSettings" class="desktop-settings" aria-labelledby="desktopSettingsTitle">
    <div class="desktop-settings-heading"><h3 id="desktopSettingsTitle">桌面通用设置</h3><span>SlateRandom 岩选</span></div>
    <label class="desktop-setting-row"><span><strong>显示悬浮球</strong><small>关闭后启动时直接打开主界面</small></span>
      <input id="desktopShowBallInput" type="checkbox" class="rect-switch" role="switch" aria-label="显示悬浮球"
        :checked="state?.settings.showFloatingBall ?? true" :disabled="pending || !state" @change="toggle('showFloatingBall', $event)"></label>
    <label class="desktop-setting-row"><span><strong>单击悬浮球立即抽选</strong><small>打开主界面后自动抽一位；拖动和长按不受影响，外部点名也跟随此开关。</small></span>
      <input id="desktopDrawOnBallClickInput" type="checkbox" class="rect-switch" role="switch" aria-label="单击悬浮球立即抽选"
        :checked="state?.settings.drawOnBallClick ?? false" :disabled="pending || !state" @change="toggle('drawOnBallClick', $event)"></label>
    <label class="desktop-setting-row"><span><strong>外部点名协议</strong><small>允许 ICC-CE 等应用通过 secrandom:// 和 namepicker:// 调用岩选；启用时临时接管，关闭后恢复原关联。</small></span>
      <input id="desktopExternalProtocolsInput" type="checkbox" class="rect-switch" role="switch" aria-label="外部点名协议"
        :checked="state?.settings.externalDrawProtocols ?? false" :disabled="pending || !state" @change="toggle('externalDrawProtocols', $event)"></label>
    <label class="desktop-setting-row"><span><strong>SlateRandom 协议</strong><small>允许通过 slaterandom:// 控制主界面、设置、悬浮球、立刻抽选和导入备份；关闭后恢复原关联。</small></span>
      <input id="desktopSlateRandomProtocolInput" type="checkbox" class="rect-switch" role="switch" aria-label="SlateRandom 协议"
        :checked="state?.settings.slaterandomProtocol ?? true" :disabled="pending || !state" @change="toggle('slaterandomProtocol', $event)"></label>
    <label class="desktop-setting-row"><span><strong>开机自启</strong><small>登录 Windows 时自动启动 SlateRandom</small></span>
      <input id="desktopAutostartInput" type="checkbox" class="rect-switch" role="switch" aria-label="开机自启"
        :checked="state?.settings.autostart ?? false" :disabled="pending || !state" @change="toggle('autostart', $event)"></label>
    <div class="desktop-setting-row desktop-elevation-method"><span><strong id="desktopElevationLabel">提权方式</strong><small id="desktopElevationHint">{{ selectedMethod === 'disabled' ? '以普通权限运行' : startup ? selectedMethod === 'task' ? '通过计划任务登录自启' : '登录后申请 UAC 授权' : selectedMethod === 'compatibility' ? '使用 Windows 兼容性设置' : '启动时申请 UAC 授权' }}</small></span>
      <fieldset id="desktopElevationMethod" class="elevation-mode-picker" aria-labelledby="desktopElevationLabel" aria-describedby="desktopElevationHint" :disabled="pending || !state">
        <label class="elevation-mode-option"><input type="radio" name="elevationMethod" value="disabled" :checked="selectedMethod === 'disabled'" @change="changeElevation"><span>禁用</span></label>
        <label class="elevation-mode-option"><input type="radio" name="elevationMethod" value="uac" :checked="selectedMethod === 'uac'" @change="changeElevation"><span>UAC</span></label>
        <label class="elevation-mode-option"><input type="radio" name="elevationMethod" :value="alternateMethod" :checked="selectedMethod === alternateMethod" @change="changeElevation"><span>{{ startup ? '计划任务' : '兼容性' }}</span></label>
      </fieldset></div>
    <p v-if="selectedMethod === 'compatibility'" class="field-hint">右键 SlateRandom.exe → 属性 → 兼容性，勾选「以管理员身份运行此程序」。</p>
    <label class="desktop-setting-row"><span><strong>UIAccess 全局置顶</strong><small>{{ state?.settings.uac ? '自动申请 UIAccess 令牌；兼容性模式下也需程序申请授权' : '选择提权方式后可启用' }}</small></span>
      <input id="desktopUiAccessInput" type="checkbox" class="rect-switch" role="switch" aria-label="UIAccess 全局置顶"
        :checked="state?.settings.uiAccess ?? false" :disabled="pending || !state?.settings.uac" @change="toggle('uiAccess', $event)"></label>
    <p id="desktopRuntimeStatus" class="field-hint desktop-runtime-status" role="status">
      <span v-if="pending">正在应用桌面设置…</span>
      <span v-else-if="state">{{ state.runtime.status }}<span v-if="state.runtime.requiresRestart"> · 重启后生效</span></span>
      <span v-else>正在读取桌面设置…</span>
    </p>
    <p v-if="error || state?.runtime.error" id="desktopSettingsError" class="error-message" role="alert">{{ error || state?.runtime.error }}</p>
  </section>
</template>
