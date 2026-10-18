<script setup lang="ts">
import { computed } from 'vue';
import type { Mode } from '../../shared/domain/model';

// Shared by the settings page and the first-run flow: the segments, the manual
// mode picker and the live probability hint must stay one implementation.
const props = withDefaults(defineProps<{
  strategy: 'auto' | 'manual';
  manualMode: Mode;
  disabled?: boolean;
  /** Explains the current mix; the flow passes its own copy. */
  hint?: string;
  /** Keeps the flow ahead of the settings page in the DOM id namespace. */
  idPrefix?: string;
}>(), { disabled: false, hint: '', idPrefix: '' });

const emit = defineEmits<{
  strategy: [strategy: 'auto' | 'manual'];
  manualMode: [mode: Mode];
}>();

const fieldId = computed(() => props.idPrefix + 'manualModeField');
const inputId = computed(() => props.idPrefix + 'manualModeInput');
const hintId = computed(() => props.idPrefix + 'strategyHint');

function chooseStrategy(strategy: 'auto' | 'manual'): void {
  if (!props.disabled) emit('strategy', strategy);
}

function chooseManualMode(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (!props.disabled && (value === 'normal' || value === 'direction' || value === 'time')) emit('manualMode', value);
}
</script>

<template>
  <div class="segmented" role="group" aria-label="策略选择">
    <button
      data-strategy="auto"
      :class="{ selected: strategy === 'auto' }"
      :aria-pressed="strategy === 'auto'"
      :disabled="disabled"
      @click="chooseStrategy('auto')"
    >
      <span class="icon material-icon" aria-hidden="true">shuffle</span>随机混合
    </button>
    <button
      data-strategy="manual"
      :class="{ selected: strategy === 'manual' }"
      :aria-pressed="strategy === 'manual'"
      :disabled="disabled"
      @click="chooseStrategy('manual')"
    >
      <span class="icon material-icon" aria-hidden="true">tune</span>指定模式
    </button>
  </div>

  <label :id="fieldId" class="strategy-manual-field" :hidden="strategy !== 'manual'">
    指定抽选方式
    <select :id="inputId" :value="manualMode" :disabled="disabled" @change="chooseManualMode">
      <option value="normal">普通随机</option>
      <option value="direction">方向接力</option>
      <option value="time">时间学号</option>
    </select>
  </label>

  <p :id="hintId" class="strategy-hint">{{ hint }}</p>
</template>
