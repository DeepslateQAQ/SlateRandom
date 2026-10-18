<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { engine } from '../domain/engine';
import type { ClassState, RecordMode, Settings } from '../../shared/domain/model';

type ControlId = RecordMode | 'endJump';
type EditableMode = Exclude<ControlId, 'normal'>;
type ChanceField = 'directionChance' | 'timeChance' | 'friendChance' | 'endJumpChance';

interface ModeDefinition {
  id: ControlId;
  name: string;
  icon: string;
  chanceField: ChanceField | null;
  chanceId: string;
  toggleId: string;
}

const props = withDefaults(defineProps<{
  state: ClassState;
  busy: boolean;
  validationRevision?: number;
  /** Prefixes every DOM id so the flow can host a second, isolated copy. */
  idPrefix?: string;
  /** The first-run flow shows probabilities and switches without detail links. */
  showDetails?: boolean;
}>(), { validationRevision: 0, idPrefix: '', showDetails: true });

const emit = defineEmits<{
  toggle: [mode: EditableMode, enabled: boolean];
  chance: [mode: EditableMode, value: number];
  details: [mode: RecordMode];
}>();

const modes: readonly ModeDefinition[] = [
  { id: 'normal', name: '普通模式', icon: 'shuffle', chanceField: null, chanceId: 'modeChance-normal', toggleId: 'modeEnabled-normal' },
  { id: 'direction', name: '连坐模式', icon: 'open_with', chanceField: 'directionChance', chanceId: 'directionChanceInput', toggleId: 'modeEnabled-direction' },
  { id: 'time', name: '时间模式', icon: 'schedule', chanceField: 'timeChance', chanceId: 'timeChanceInput', toggleId: 'modeEnabled-time' },
  { id: 'friend', name: '友尽模式', icon: 'link_off', chanceField: 'friendChance', chanceId: 'friendChanceInput', toggleId: 'friendEnabledInput' },
  { id: 'endJump', name: '结果跳变', icon: 'undo', chanceField: 'endJumpChance', chanceId: 'endJumpChanceInput', toggleId: 'endJumpEnabledInput' }
];

// The configured mix stays stable while a temporary direction cooldown is active.
// The engine still applies that cooldown when it chooses the actual next mode.
const normalChance = computed(() => engine.modeChances({ ...props.state, directionCooldownRemaining: 0 }).normal);
const draftValues = reactive<Partial<Record<EditableMode, string>>>({});
const editingMode = ref<EditableMode | null>(null);

function enabled(mode: ControlId, settings: Settings = props.state.settings): boolean {
  return mode === 'normal' || (mode === 'endJump' ? settings.endJumpEnabled : mode === 'friend' ? settings.friendEnabled : settings.modes.includes(mode));
}

function canonicalChance(mode: ModeDefinition): number {
  return mode.chanceField ? props.state.settings[mode.chanceField] : normalChance.value;
}

function displayedChance(mode: ModeDefinition): string {
  return mode.id !== 'normal' && editingMode.value === mode.id && draftValues[mode.id] !== undefined
    ? draftValues[mode.id]!
    : String(canonicalChance(mode));
}

function clearDrafts(): void {
  editingMode.value = null;
  for (const mode of ['direction', 'time', 'friend', 'endJump'] as const) delete draftValues[mode];
}

// Every validation attempt receives a revision, including a rejected edit. The
// parent remains the authority for validation, persistence, and the saved value.
watch(() => props.validationRevision, clearDrafts, { flush: 'sync' });
watch(() => props.busy, value => { if (value) clearDrafts(); });

function title(mode: ModeDefinition): string {
  if (mode.id === 'normal') return props.showDetails ? '普通抽选使用剩余概率；点击调整冷却与公平设置' : '普通抽选使用剩余概率';
  if (mode.id === 'friend') return props.showDetails ? '下一次先独立尝试友尽概率，不计入混合概率合计；点击查看友尽设置' : '友尽模式，概率与开关';
  if (mode.id === 'endJump') return '揭晓前独立尝试继续随机或回选前一个焦点；不计入混合概率合计，仍遵守公平保护';
  if (!props.showDetails) return mode.name + '，概率与开关';
  if (mode.id === 'direction' && props.state.directionCooldownRemaining > 0) {
    return '连坐冷却中，剩余 ' + props.state.directionCooldownRemaining + ' 轮；点击调整连坐设置';
  }
  return '点击查看' + mode.name + '的附加设置';
}

const detailEnabled = (mode: ControlId): mode is RecordMode => props.showDetails && mode !== 'endJump';
const idFor = (value: string): string => props.idPrefix + value;

function openDetails(mode: ControlId): void {
  if (!props.busy && detailEnabled(mode)) emit('details', mode);
}

function rowClick(mode: ControlId, event: MouseEvent): void {
  if (event.target instanceof Element && event.target.closest('[data-mode-control]')) return;
  openDetails(mode);
}

function rowKeyDown(mode: ControlId, event: KeyboardEvent): void {
  if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation();
  if (!event.repeat) openDetails(mode);
}

function toggleMode(mode: ControlId, event: Event): void {
  if (props.busy || mode === 'normal') return;
  emit('toggle', mode, (event.target as HTMLInputElement).checked);
}

function editChance(mode: ControlId, event: Event): void {
  if (props.busy || mode === 'normal' || !enabled(mode)) return;
  editingMode.value = mode;
  draftValues[mode] = (event.target as HTMLInputElement).value;
}

function commitChance(mode: ControlId, event: Event): void {
  if (props.busy || mode === 'normal' || !enabled(mode)) return;
  const input = event.target as HTMLInputElement;
  editingMode.value = null;
  delete draftValues[mode];
  // valueAsNumber deliberately keeps empty and invalid input as NaN, so the
  // domain validator can reject it instead of silently converting it to 0%.
  emit('chance', mode, input.valueAsNumber);
}

function finishEdit(mode: ControlId): void {
  if (mode === 'normal') return;
  delete draftValues[mode];
  if (editingMode.value === mode) editingMode.value = null;
}
</script>

<template>
  <div :id="idFor('modeOptions')" class="mode-settings" :class="{ 'has-compact-rows': !showDetails }" aria-label="抽选模式、触发概率与开关" :aria-busy="busy">
    <div
      v-for="mode in modes"
      :key="mode.id"
      class="mode-setting-row"
      :class="{ selected: enabled(mode.id), 'has-no-details': !detailEnabled(mode.id), 'is-manual-selected': state.settings.strategy === 'manual' && state.settings.manualMode === mode.id }"
      :data-mode-row="mode.id"
      :data-enabled="enabled(mode.id)"
      role="group"
      :aria-label="mode.name + (mode.id === 'endJump' ? '，独立末尾概率与开关' : showDetails ? '，概率与开关，点击查看附加设置' : '，概率与开关')"
      :aria-disabled="busy"
      :tabindex="busy || !detailEnabled(mode.id) ? -1 : 0"
      :title="title(mode)"
      @click="rowClick(mode.id, $event)"
      @keydown="rowKeyDown(mode.id, $event)"
    >
      <span class="mode-setting-heading">
        <span class="icon material-icon" aria-hidden="true">{{ mode.icon }}</span>
        <span class="mode-setting-name">{{ mode.name }}</span>
      </span>

      <label class="mode-setting-probability" data-mode-control="chance" @click.stop @keydown.stop>
        <input
          :id="idFor(mode.chanceId)"
          :data-mode-chance="mode.id"
          :data-editing="mode.id !== 'normal' && editingMode === mode.id ? 'true' : undefined"
          type="number"
          min="0"
          max="100"
          step="1"
          inputmode="numeric"
          autocomplete="off"
          :value="displayedChance(mode)"
          :aria-label="mode.name + (mode.id === 'friend' ? '独立前置概率' : '触发概率') + '，百分比'"
          :aria-readonly="mode.id === 'normal' ? 'true' : undefined"
          :readonly="mode.id === 'normal'"
          :disabled="busy || (mode.id !== 'normal' && !enabled(mode.id))"
          @input="editChance(mode.id, $event)"
          @change.stop="commitChance(mode.id, $event)"
          @blur="finishEdit(mode.id)"
        >
        <span class="mode-setting-percent" aria-hidden="true">%</span>
      </label>

      <label class="mode-setting-switch" data-mode-control="toggle" @click.stop @keydown.stop>
        <input
          :id="idFor(mode.toggleId)"
          :data-mode-enabled="mode.id"
          type="checkbox"
          class="rect-switch"
          role="switch"
          :aria-label="'启用' + mode.name"
          :aria-controls="idFor(mode.chanceId)"
          :checked="enabled(mode.id)"
          :disabled="busy || mode.id === 'normal'"
          @change.stop="toggleMode(mode.id, $event)"
        >
      </label>

      <button
        v-if="detailEnabled(mode.id)"
        :id="idFor('modeDetails-' + mode.id)"
        type="button"
        class="mode-setting-details"
        data-mode-control="details"
        :aria-label="mode.name + '附加设置'"
        :disabled="busy"
        @click.stop="openDetails(mode.id)"
      >
        <span class="icon material-icon" aria-hidden="true">arrow_forward</span>
      </button>
    </div>
  </div>
</template>
