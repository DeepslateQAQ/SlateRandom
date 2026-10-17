<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ClassState } from '../../shared/domain/model';
import StatisticsPage from './StatisticsPage.vue';

const props = defineProps<{ state: ClassState; busy: boolean; saveError: string; recoveryRequired: boolean }>();
const blocked = computed(() => props.busy || props.recoveryRequired);
const includeSecrets = ref(false);
const desktop = Boolean(window.slateDesktop);
</script>

<template>
  <section id="view-data" class="view" aria-label="数据与备份">
    <div class="page-heading"><div><h2>数据</h2><p class="page-description">独立迁移设置与名单，或保留全部数据继续使用。</p></div></div>
    <p id="saveErrorMessage" v-show="saveError" class="error-message" role="alert">{{ saveError }}</p>
    <p id="recoveryRequiredNotice" v-show="recoveryRequired" class="field-hint" role="status">请先使用「恢复全部」修复数据，再继续抽选或修改。现在仍可查看、导出名单与记录。</p>

    <article class="data-location" aria-labelledby="dataLocationTitle">
      <span class="icon material-icon" aria-hidden="true">save</span>
      <div><h3 id="dataLocationTitle">{{ desktop ? '便携数据目录' : '浏览器数据' }}</h3>
        <p id="dataDirectoryText" class="data-directory-text">{{ desktop ? '正在读取程序运行目录…' : '当前数据保存在此浏览器。移动 HTML 文件时，请通过全部备份迁移数据。' }}</p>
        <p class="field-hint">{{ desktop ? '移动整个程序目录，即可一并带走名单、设置和抽取记录。' : '浏览器版本同样支持单独导出名单、设置与全部备份。' }}</p>
      </div>
    </article>

    <div class="backup-sections">
      <article class="backup-row" aria-labelledby="settingsBackupTitle"><div class="backup-copy"><h3 id="settingsBackupTitle">设置</h3><p>外观、抽选规则、概率、朗读与提供商配置，以 JSON 导出。</p></div>
        <div class="backup-actions"><button id="exportSettingsBtn" type="button" class="btn btn-plain" :disabled="blocked"><span class="icon material-icon" aria-hidden="true">download</span>导出设置</button><button id="importSettingsBtn" type="button" class="btn btn-plain" :disabled="blocked"><span class="icon material-icon" aria-hidden="true">upload</span>导入设置</button></div>
        <input id="settingsBackupFile" type="file" accept=".json,application/json" class="sr-only" tabindex="-1" :disabled="blocked">
      </article>
      <article class="backup-row" aria-labelledby="rosterBackupTitle"><div class="backup-copy"><h3 id="rosterBackupTitle">名单</h3><p>班级、姓名、学号、座位与友尽目标，以 JSON 导出；累计统计单独保留。</p></div>
        <div class="backup-actions"><button id="exportRosterBtn" type="button" class="btn btn-plain" :disabled="busy || !state.students.length"><span class="icon material-icon" aria-hidden="true">download</span>导出名单</button><button id="importRosterBtn" type="button" class="btn btn-plain" :disabled="blocked"><span class="icon material-icon" aria-hidden="true">upload</span>导入名单</button></div>
        <input id="rosterBackupFile" type="file" accept=".json,application/json" class="sr-only" tabindex="-1" :disabled="blocked">
      </article>
      <article class="backup-row backup-row-all" aria-labelledby="allBackupTitle"><div class="backup-copy"><h3 id="allBackupTitle">全部数据</h3><p>同时备份名单、设置、累计公平统计与抽取进度，可在另一台设备恢复继续使用。</p></div>
        <div class="backup-actions"><button id="backupBtn" type="button" class="btn btn-primary" :disabled="blocked"><span class="icon material-icon" aria-hidden="true">download</span>导出全部</button><button id="restoreBackupBtn" type="button" class="btn btn-plain" :disabled="busy"><span class="icon material-icon" aria-hidden="true">upload</span>恢复全部</button></div>
        <input id="backupFile" type="file" accept=".slate,.slatebackup,.json,application/json,application/octet-stream" class="sr-only" tabindex="-1" :disabled="busy">
      </article>
      <article class="backup-row backup-row-analysis" aria-labelledby="analysisTitle"><div class="backup-copy"><h3 id="analysisTitle">分析报告</h3><p>导出运行环境、匿名化名单统计与抽取记录，便于在 Issue 中排查问题。不包含姓名、学号、班级、密钥或备份凭据；学生仅以匿名键出现。</p></div>
        <div class="backup-actions"><button id="exportAnalysisBtn" type="button" class="btn btn-plain" :disabled="busy"><span class="icon material-icon" aria-hidden="true">download</span>导出分析数据</button></div>
      </article>
    </div>

    <label class="data-secret-row"><span><strong>备份中包含 API 密钥</strong><small>默认不包含。需要迁移识别或朗读服务密钥时再开启。包含密钥的备份不受密码保护，请勿公开分享。</small></span><input id="includeSecretsToggle" v-model="includeSecrets" type="checkbox" class="rect-switch" role="switch" aria-label="备份中包含 API 密钥" :disabled="blocked"></label>
    <p id="backupDataStatus" class="field-hint backup-data-status" role="status" aria-live="polite">导入前会核对格式与数据；全部恢复将替换现有数据。</p>

    <div class="data-statistics-heading"><h2>累计统计与记录</h2><p class="page-description">包括跨会话保存的抽中次数、出场先后与近期抽取明细。</p></div>
    <StatisticsPage :state="state" :busy="busy" :recovery-required="recoveryRequired" />
  </section>
</template>
