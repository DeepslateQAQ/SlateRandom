<script setup lang="ts">
import { computed } from 'vue';
import ModeSettings from './ModeSettings.vue';
import StrategyPicker from './StrategyPicker.vue';
import { engine } from '../domain/engine';
import type { ClassState, Mode, RecordMode } from '../../shared/domain/model';

type EditableMode = Exclude<RecordMode, 'normal'> | 'endJump';

const props = defineProps<{
  state: ClassState;
  busy: boolean;
  modeError: string;
  validationRevision: number;
}>();

const emit = defineEmits<{
  toggle: [mode: EditableMode, enabled: boolean];
  chance: [mode: EditableMode, value: number];
  strategy: [strategy: 'auto' | 'manual'];
  manualMode: [mode: Mode];
}>();

const strategyHint = computed(() => {
  if (props.state.settings.strategy === 'manual') return '选定一个模式，持续使用它';
  const chances = engine.modeChances(props.state);
  return '普通 ' + chances.normal + '% · 连坐 ' + chances.direction + '% · 时间 ' + chances.time + '%（连坐锁定期间持续接力）';
});
</script>

<template>
  <div class="onboarding-probability">
    <StrategyPicker id-prefix="onboarding-" :strategy="state.settings.strategy" :manual-mode="state.settings.manualMode"
      :disabled="busy" :hint="strategyHint"
      @strategy="value => emit('strategy', value)" @manual-mode="value => emit('manualMode', value)" />
    <ModeSettings :state="state" :busy="busy" :validation-revision="validationRevision" id-prefix="onboarding-"
      :show-details="false"
      @toggle="(mode, enabled) => emit('toggle', mode, enabled)"
      @chance="(mode, value) => emit('chance', mode, value)" />
    <p class="field-hint">连坐和时间的概率与普通合计 100%；友尽在前置、结果跳变在末尾各自判定。冷却与更多细节在设置里调整。</p>
    <p v-if="modeError" id="onboardingModeError" class="error-message" role="alert">{{ modeError }}</p>
  </div>
</template>
