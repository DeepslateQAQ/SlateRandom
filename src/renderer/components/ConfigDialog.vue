<script setup lang="ts">
import { computed } from 'vue';
import type { AppSnapshot, ConfigView } from '../application/store';
import type { ApplicationActions } from '../application/controller.js';
import GeneralPage from './GeneralPage.vue';
import RulesPage from './RulesPage.vue';
import RosterPage from './RosterPage.vue';
import DataPage from './DataPage.vue';
import HelpPage from './HelpPage.vue';
import AboutPage from './AboutPage.vue';
const props = defineProps<{ snapshot: AppSnapshot; actions?: ApplicationActions }>();
const view = computed(() => props.snapshot.view === 'history' ? 'data' : props.snapshot.view);
const pages: { id: ConfigView; name: string; icon: string }[] = [
  { id: 'general', name: '通用', icon: 'tune' },
  { id: 'dashboard', name: '功能', icon: 'shuffle' },
  { id: 'roster', name: '名单', icon: 'groups' },
  { id: 'data', name: '数据', icon: 'save' },
  { id: 'help', name: '帮助', icon: 'help_outline' },
  { id: 'about', name: '关于', icon: 'auto_awesome' }
];
</script>

<template>
  <dialog id="configDialog" class="dialog config-dialog" aria-labelledby="configTitle">
    <div class="modal-toast-wrap"><div class="toast" data-toast-host role="status" aria-live="polite" aria-atomic="true" hidden></div></div>
    <header class="config-heading"><div><h1 id="configTitle">设置</h1><p>SlateRandom 岩选</p></div>
      <button id="closeConfigBtn" class="icon-btn" data-close aria-label="关闭配置"><span class="icon material-icon" aria-hidden="true">close</span></button>
    </header>
    <nav class="navigation" aria-label="配置导航">
      <button v-for="page in pages" :key="page.id" :data-nav="page.id" :class="{ active: view === page.id }"
        :aria-current="view === page.id ? 'page' : undefined" :disabled="snapshot.busy" @click="actions?.setView(page.id)">
        <span class="icon material-icon" aria-hidden="true">{{ page.icon }}</span>{{ page.name }}
        <span v-if="page.id === 'roster'" id="navCount" class="nav-count">{{ snapshot.state.students.length }}</span>
      </button>
    </nav>
    <div class="config-content">
      <GeneralPage :hidden="view !== 'general'" :state="snapshot.state" :busy="snapshot.busy"
        :recovery-required="snapshot.recoveryRequired" :actions="actions" />
      <RulesPage :hidden="view !== 'dashboard'" :state="snapshot.state" :busy="snapshot.busy"
        :save-error="snapshot.saveError" :recovery-required="snapshot.recoveryRequired"
        :mode-error="snapshot.modeError" :validation-revision="snapshot.validationRevision"
        @toggle="(mode, enabled) => actions?.toggleMode(mode, enabled)"
        @chance="(mode, value) => actions?.changeChance(mode, value)"
        @details="mode => actions?.openSettings(mode)"
        @strategy="value => actions?.strategy(value)"
        @manual-mode="value => actions?.manualMode(value)"
        @settings="actions?.openSettings()" @cancel-lock="actions?.exitChain()" />
      <RosterPage :hidden="view !== 'roster'" :state="snapshot.state" :busy="snapshot.busy"
        :save-error="snapshot.saveError" :recovery-required="snapshot.recoveryRequired"
        :swap-mode="snapshot.swapMode" :swap-first="snapshot.swapFirst" />
      <DataPage :hidden="view !== 'data'" :state="snapshot.state" :busy="snapshot.busy"
        :save-error="snapshot.saveError" :recovery-required="snapshot.recoveryRequired" />
      <HelpPage :hidden="view !== 'help'" />
      <AboutPage :hidden="view !== 'about'" :actions="actions" :busy="snapshot.busy"
        :recovery-required="snapshot.recoveryRequired" />
    </div>
    <footer class="config-footer"><span id="saveStatus" role="status">更改自动保存</span><span>短按抽人 · 长按 500 ms 设置</span></footer>
  </dialog>
</template>
