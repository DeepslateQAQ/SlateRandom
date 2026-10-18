<script setup lang="ts">
import { computed } from 'vue';
import type { Settings } from '../../shared/domain/model';
import { themeLabel } from '../application/appearance';

const props = defineProps<{
  settings: Pick<Settings, 'theme' | 'accent' | 'radius'>;
  systemDark: boolean;
  /** Callers that render a second preview (the first-run flow) pass their own id. */
  id?: string;
}>();
const previewId = computed(() => props.id || 'appearancePreview');

const caption = computed(() => '外观预览：' + themeLabel(props.settings.theme, props.systemDark)
  + ' · ' + props.settings.accent + ' · 圆角 ' + props.settings.radius + ' px');
</script>

<template>
  <figure :id="previewId" class="appearance-preview">
    <div class="appearance-preview-grid" aria-hidden="true">
      <div class="appearance-preview-cell">
        <div class="appearance-preview-panel appearance-preview-stage">
          <i class="preview-seat"></i><i class="preview-seat"></i>
          <i class="preview-seat current"></i><i class="preview-seat"></i>
          <i class="preview-action"></i>
        </div>
        <span class="appearance-preview-label">主界面</span>
      </div>
      <div class="appearance-preview-cell">
        <div class="appearance-preview-panel appearance-preview-settings">
          <i class="preview-settings-title"></i>
          <i class="preview-settings-row"></i><i class="preview-settings-row short"></i>
          <i class="preview-settings-controls"><i class="preview-switch"></i><i class="preview-primary"></i><i class="preview-accent-bar"></i></i>
        </div>
        <span class="appearance-preview-label">设置</span>
      </div>
      <div class="appearance-preview-cell">
        <div class="appearance-preview-panel appearance-preview-ball">
          <i class="preview-ball"><i></i></i>
        </div>
        <span class="appearance-preview-label">悬浮球</span>
      </div>
    </div>
    <figcaption class="appearance-preview-caption">{{ caption }}</figcaption>
  </figure>
</template>
