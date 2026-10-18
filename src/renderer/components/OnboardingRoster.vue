<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ClassState } from '../../shared/domain/model';
import type { ApplicationActions } from '../application/controller.js';

const props = defineProps<{
  state: ClassState;
  busy: boolean;
  actions?: ApplicationActions;
}>();

const count = computed(() => props.state.students.length);
const summary = computed(() => count.value
  ? '已导入 ' + count.value + ' 位同学 · ' + props.state.className
  : '还没有名单，导入后就能开始抽人。');

const backupInput = ref<HTMLInputElement | null>(null);

function pickBackup(): void {
  if (props.busy) return;
  backupInput.value?.click();
}

function onBackupFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) void props.actions?.restoreRosterFile(file);
}
</script>

<template>
  <div class="onboarding-roster">
    <p id="onboardingRosterStatus" class="onboarding-status" role="status" :data-imported="count > 0">{{ summary }}</p>
    <div class="onboarding-actions-row">
      <button id="onboardingImportRosterBtn" type="button" class="btn btn-primary" :disabled="busy"
        @click="actions?.openRosterImport()">
        <span class="icon material-icon" aria-hidden="true">upload</span>导入名单
      </button>
      <button id="onboardingImportRosterBackupBtn" type="button" class="btn btn-plain" :disabled="busy"
        @click="pickBackup">
        <span class="icon material-icon" aria-hidden="true">save</span>导入名单备份
      </button>
      <input id="onboardingRosterBackupFile" ref="backupInput" type="file" hidden
        accept=".json,application/json" @change="onBackupFile">
    </div>
    <p class="field-hint">粘贴整段名单、导入 Excel 或 CSV、识别座位表图片都行。导出过名单备份的，直接选备份文件，座位与班级名会原样恢复。</p>
  </div>
</template>
