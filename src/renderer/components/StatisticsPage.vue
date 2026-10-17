<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ClassState, RecordMode } from '../../shared/domain/model';
import { aggregateStatistics } from '../domain/statistics';
import LifetimeStats from './LifetimeStats.vue';
const props = defineProps<{ state: ClassState; busy: boolean; recoveryRequired: boolean }>();
const blocked = computed(() => props.busy || props.recoveryRequired);
const names: Record<RecordMode, string> = { normal: '普通随机', direction: '方向接力', time: '时间学号', friend: '友尽模式' };
const displayId = (id: string) => id.padStart(2, '0');
const dateText = (value: string, brief = false) => brief
  ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  : new Date(value).toLocaleString('zh-CN', { hour12: false });
const lifetime = computed(() => aggregateStatistics(props.state));
const maxDraws = computed(() => Math.max(1, ...lifetime.value.rows.map(s => s.draws)));
const minDraws = computed(() => lifetime.value.rows.length ? Math.min(...lifetime.value.rows.map(s => s.draws)) : 0);
const filter = ref<RecordMode | 'all'>('all'), page = ref(0);
const records = computed(() => props.state.history.slice().reverse().filter(r => filter.value === 'all' || r.mode === filter.value));
const pages = computed(() => Math.max(1, Math.ceil(records.value.length / 50)));
const pageRows = computed(() => records.value.slice(page.value * 50, (page.value + 1) * 50));
const recent = computed(() => props.state.history.slice(-5).reverse());
watch(filter, () => { page.value = 0; });
watch(pages, count => { page.value = Math.min(page.value, count - 1); });
</script>

<template>
  <section id="view-history" class="view" aria-label="累计统计"><p v-if="!state.students.length" class="configuration-empty-note">尚未配置名单。导入并开始抽选后，这里显示跨会话累计统计。</p>
    <dl class="metrics"><div><dt>参与抽取</dt><dd id="activeMetric">{{ lifetime.activeParticipants }}<span>人</span></dd><small id="totalMetric">名单共 {{ lifetime.participants }} 人</small></div><div><dt>累计抽取</dt><dd id="roundMetric">{{ lifetime.totalDraws }}<span>次</span></dd></div><div><dt>参与覆盖</dt><dd id="coverageMetric">{{ lifetime.participants ? Math.round(lifetime.covered / lifetime.participants * 100) : 0 }}<span>%</span></dd><small id="coverageDetail">{{ lifetime.covered }} / {{ lifetime.participants }} 人累计被抽到</small></div></dl>
    <LifetimeStats :state="state" :busy="busy" />
    <article class="card distribution-card"><div class="card-heading"><div><h2>累计抽取分布</h2><p id="distributionSummary">现有名单累计 {{ lifetime.totalDraws }} 次 · 包含全部 {{ lifetime.participants }} 位同学与暂停者 · 最少 {{ minDraws }} 次 · 最多 {{ maxDraws === 1 && !lifetime.totalDraws ? 0 : maxDraws }} 次</p></div><span class="pill fair-pill">动态均衡</span></div><div id="distribution" class="distribution">
      <div v-for="student in lifetime.rows" :key="student.id" class="distribution-item" :class="{ latest: state.lastId === student.id, inactive: !student.active }" :aria-label="`${student.name}，抽中 ${student.draws} 次`" :title="`${student.name} · ${student.draws} 次`"><span class="distribution-count">{{ student.draws }}</span><div class="distribution-track"><div class="distribution-bar" :style="{ '--bar': (student.draws / maxDraws * 100) + '%' }"></div></div><span>{{ displayId(student.id) }}</span></div>
    </div></article>
    <div class="config-section"><div class="card-heading"><h2>最近抽取 <span id="recentRounds" class="heading-count">{{ state.round }} 轮</span></h2><button id="undoBtn" class="text-btn" :disabled="blocked || !state.history.length || !state.history.at(-1)?.before"><span class="icon material-icon" aria-hidden="true">undo</span>撤销上轮</button></div><p><span id="stageMode" class="subtle-label"></span><span id="resultReason" class="result-reason"></span></p><div id="recentList">
      <div v-for="record in recent" :key="record.round" class="recent-row"><span class="student-avatar">{{ record.name.slice(0, 1) }}</span><div><div class="recent-name">{{ record.name }}</div><div class="recent-meta"><span>{{ displayId(record.studentId) }} 号</span><span>·</span><span>{{ names[record.mode] }}</span></div></div><span class="recent-time">{{ dateText(record.time, true) }}</span></div>
      <div v-if="!recent.length" class="empty-state"><span class="icon material-icon" aria-hidden="true">auto_awesome</span>{{ state.students.length ? '惊喜还在路上' : '尚未配置名单' }}<p>{{ state.students.length ? '点击开始，迎接今天的第一位同学' : '先导入同学名单，再开始抽选' }}</p></div>
    </div></div>
    <article class="card history-card"><div class="card-heading"><h2>抽取记录</h2><div class="toolbar-right"><button id="exportHistoryBtn" class="btn btn-plain" :disabled="!state.history.length || busy"><span class="icon material-icon" aria-hidden="true">download</span>导出 CSV</button><button id="resetBtn" class="btn btn-plain danger-text" :disabled="!state.round || blocked"><span class="icon material-icon" aria-hidden="true">restart_alt</span>重置本轮</button></div></div>
      <div class="history-filter"><label>筛选模式<select id="historyFilter" v-model="filter" :disabled="busy"><option value="all">全部模式</option><option value="normal">普通随机</option><option value="direction">方向接力</option><option value="time">时间学号</option><option value="friend">友尽模式</option></select></label><span id="historySummary" class="muted">重置后 {{ state.round }} 轮 · 保留 {{ state.history.length }} 条本次明细；长期统计见上方</span></div>
      <div class="table-scroll"><table><thead><tr><th>轮次</th><th>抽中同学</th><th>抽取模式</th><th>抽取时间</th><th>本轮说明</th></tr></thead><tbody id="historyTable"><tr v-for="record in pageRows" :key="record.round"><td>#{{ record.round }}</td><td><strong>{{ record.name }}</strong> <span class="muted">{{ displayId(record.studentId) }} 号</span></td><td><span class="pill neutral-pill">{{ names[record.mode] }}</span></td><td>{{ dateText(record.time) }}</td><td class="history-reason">{{ record.reason }}</td></tr><tr v-if="!pageRows.length"><td colspan="5" class="empty-state">{{ state.students.length ? '这里还没有记录，先去抽取一位同学吧。' : '尚未配置名单，请先导入名单。' }}</td></tr></tbody></table></div>
      <div class="pagination"><span id="pageInfo">第 {{ page + 1 }} / {{ pages }} 页 · 匹配 {{ records.length }} 条</span><div><button id="historyPrev" class="btn btn-plain" :disabled="busy || page === 0" @click="page--"><span class="icon material-icon" aria-hidden="true">arrow_back</span>上一页</button><button id="historyNext" class="btn btn-plain" :disabled="busy || page >= pages - 1" @click="page++"><span class="icon material-icon" aria-hidden="true">arrow_forward</span>下一页</button></div></div>
    </article>
  </section>
</template>
