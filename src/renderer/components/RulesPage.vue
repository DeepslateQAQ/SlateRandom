<script setup lang="ts">
import { computed } from 'vue';
import ModeSettings from './ModeSettings.vue';
import { engine } from '../domain/engine';
import type { ClassState, Mode, RecordMode } from '../../shared/domain/model';

type EditableMode = Exclude<RecordMode, 'normal'> | 'endJump';

const props = defineProps<{
  state: ClassState;
  busy: boolean;
  saveError: string;
  recoveryRequired: boolean;
  modeError: string;
  validationRevision: number;
}>();

const emit = defineEmits<{
  toggle: [mode: EditableMode, enabled: boolean];
  chance: [mode: EditableMode, value: number];
  details: [mode: RecordMode];
  strategy: [strategy: 'auto' | 'manual'];
  manualMode: [mode: Mode];
  settings: [];
  cancelLock: [];
}>();

const blocked = computed(() => props.busy || props.recoveryRequired);

const strategyHint = computed(() => {
  if (!props.state.students.length) return '可以提前配置抽选规则；导入名单后开始抽选。';
  if (props.state.settings.strategy === 'manual') return '选定一个模式，持续使用它';
  const chances = engine.modeChances(props.state);
  return '普通 ' + chances.normal + '% · 连坐 ' + chances.direction + '% · 时间 ' + chances.time + '%（连坐锁定期间持续接力）';
});

const fairnessHint = computed(() => {
  const active = props.state.students.filter(student => student.active).length;
  if (!props.state.students.length) return '尚未配置名单。导入后启用未抽优先、近期冷却与跨会话动态均衡。';
  if (!active) return '当前同学全部暂停参与，请在名单与座位页恢复参与状态。';
  const cooldown = Math.min(props.state.settings.cooldown, Math.max(0, active - 1));
  return active === 1 ? '仅一人参与时会重复抽中；增加参与人数即可启用冷却。' :
    '本轮优先未抽过的人 · 近期 ' + cooldown + ' 轮冷却 · 长期少抽、常在后段抽到的人增权；跨会话保留统计。';
});

const lockDirection = computed(() => {
  const direction = props.state.settings.direction;
  return direction === 'auto' ? '每轮重新随机方向' : '向' + engine.DIRECTIONS[direction][2];
});

function chooseStrategy(strategy: 'auto' | 'manual'): void {
  if (!blocked.value) emit('strategy', strategy);
}

function chooseManualMode(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (!blocked.value && (value === 'normal' || value === 'direction' || value === 'time')) emit('manualMode', value);
}
</script>

<template>
  <section id="view-dashboard" class="view" aria-label="抽选模式与概率">
    <div class="page-heading">
      <div>
        <h2>抽选功能</h2>
        <p class="page-description">概率与开关立即保存，点击模式行调整附加规则。</p>
      </div>
      <button id="settingsBtn" class="btn btn-plain" :disabled="blocked" @click="emit('settings')">
        <span class="icon material-icon" aria-hidden="true">tune</span>朗读设置
      </button>
    </div>

    <div class="segmented" role="group" aria-label="策略选择">
      <button
        data-strategy="auto"
        :class="{ selected: state.settings.strategy === 'auto' }"
        :aria-pressed="state.settings.strategy === 'auto'"
        :disabled="blocked"
        @click="chooseStrategy('auto')"
      >
        <span class="icon material-icon" aria-hidden="true">shuffle</span>随机混合
      </button>
      <button
        data-strategy="manual"
        :class="{ selected: state.settings.strategy === 'manual' }"
        :aria-pressed="state.settings.strategy === 'manual'"
        :disabled="blocked"
        @click="chooseStrategy('manual')"
      >
        <span class="icon material-icon" aria-hidden="true">tune</span>指定模式
      </button>
    </div>

    <label id="manualModeField" :hidden="state.settings.strategy !== 'manual'">
      指定抽选方式
      <select id="manualModeInput" :value="state.settings.manualMode" :disabled="blocked" @change="chooseManualMode">
        <option value="normal">普通随机</option>
        <option value="direction">方向接力</option>
        <option value="time">时间学号</option>
      </select>
    </label>

    <p id="strategyHint" class="strategy-hint">{{ strategyHint }}</p>
    <ModeSettings
      :state="state"
      :busy="blocked"
      :validation-revision="validationRevision"
      @toggle="(mode, enabled) => emit('toggle', mode, enabled)"
      @chance="(mode, value) => emit('chance', mode, value)"
      @details="mode => emit('details', mode)"
    />
    <p id="normalChanceHint" class="field-hint">连坐和时间的启用概率与普通合计 100%；友尽独立前置判定，结果跳变独立末尾判定，均不计入合计。抽选模式开关控制随机混合，指定模式优先使用上方选择。</p>
    <p id="modeSettingsError" class="error-message" role="alert">{{ modeError }}</p>
    <p id="fairnessHint" class="field-hint">{{ fairnessHint }}</p>

    <div id="lockNotice" class="lock-notice" :hidden="!state.lock">
      <span id="lockLabel">
        连坐还剩 <strong class="remaining-number">{{ state.lock?.remaining ?? 0 }}</strong> 轮 · {{ lockDirection }}
      </span>
      <button id="cancelLockBtn" class="text-btn" :disabled="blocked" @click="emit('cancelLock')">
        <span class="icon material-icon" aria-hidden="true">link_off</span>结束接力
      </button>
    </div>
  </section>
</template>
