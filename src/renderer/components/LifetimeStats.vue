<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ClassState, StudentId } from '../../shared/domain/model';
import { aggregateStatistics } from '../domain/statistics';
import type { StudentStatistics } from '../domain/statistics';

const props = withDefaults(defineProps<{ state: ClassState; busy?: boolean }>(), { busy: false });
const query = ref('');
const order = ref<'id' | 'draws' | 'position' | 'session'>('id');
const expanded = ref(new Set<StudentId>());
const scroller = ref<HTMLElement | null>(null);

// The stats table only needs horizontal scrolling. Without forwarding, its
// overflow-x scroll container swallows vertical wheel input instead of letting
// the settings page continue scrolling under the pointer.
function forwardVerticalWheel(event: WheelEvent): void {
  const target = scroller.value;
  if (!target || event.ctrlKey || !event.deltaY || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  if (target.scrollHeight > target.clientHeight + 1) return;
  const parent = target.closest<HTMLElement>('.config-content');
  if (!parent) return;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? parent.clientHeight : 1;
  const before = parent.scrollTop;
  if (event.deltaX) target.scrollLeft += event.deltaX * unit;
  parent.scrollTop += event.deltaY * unit;
  if (parent.scrollTop !== before) event.preventDefault();
}
onMounted(() => scroller.value?.addEventListener('wheel', forwardVerticalWheel, { passive: false }));
onBeforeUnmount(() => scroller.value?.removeEventListener('wheel', forwardVerticalWheel));
const stats = computed(() => aggregateStatistics(props.state));
const rows = computed(() => {
  const search = query.value.trim().toLocaleLowerCase('zh-CN');
  const matches = stats.value.rows.filter(row => !search || row.id.toLocaleLowerCase('zh-CN').includes(search) || row.name.toLocaleLowerCase('zh-CN').includes(search));
  const byId = (a: StudentStatistics, b: StudentStatistics) => a.id.localeCompare(b.id, 'zh-CN', { numeric: true });
  return matches.sort((a, b) => {
    if (order.value === 'draws') return b.draws - a.draws || byId(a, b);
    if (order.value === 'position') return (b.meanPosition ?? -1) - (a.meanPosition ?? -1) || byId(a, b);
    if (order.value === 'session') return b.sessionDraws - a.sessionDraws || byId(a, b);
    return byId(a, b);
  });
});
const summary = computed(() => {
  const s = stats.value;
  return `保留 ${s.positionSamples} 个出场位置样本 · 当前覆盖轮 ${s.cycleCovered} / ${s.activeParticipants} 人 · 保留 ${s.retainedRecords} 条本次明细 · 有效近期冷却窗口 ${s.cooldownWindow} 轮 · 连坐冷却剩余 ${s.directionCooldownRemaining} 轮`;
});
const average = (row: StudentStatistics) => row.meanPosition === null ? '—' : (row.meanPosition * 100).toFixed(1) + '%';

function detailsPairs(row: StudentStatistics): [string, string][] {
  return [
    ['参与状态', row.active ? '参与中' : '已暂停'],
    ['座位', `${row.row} 行 ${row.col} 列`],
    ['长期累计抽中', row.draws + ' 次'],
    ['出场位置样本', row.positionSamples + ' 次'],
    ['归一出场位置总和', String(row.positionSum)],
    ['平均归一出场位次', row.meanPosition === null ? '尚无位置样本' : String(row.meanPosition)],
    ['本次状态抽中', row.sessionDraws + ' 次'],
    ['当前覆盖轮已抽中', row.cycleSeen ? '是' : '否'],
    ['本次最后抽中轮次', row.lastSeen !== null && row.lastSeen > 0 ? '#' + row.lastSeen : '尚未抽到'],
    ['距本次上次抽中', row.roundsWaiting === null ? '—' : row.roundsWaiting + ' 轮'],
    ['近期冷却名单中', row.cooling ? '是' : '否'],
    ['普通随机候选资格', row.eligible ? '参与当前候选' : row.active ? '暂不参与当前候选' : '已暂停'],
    ['普通随机概率', row.probability * 100 + '%']
  ];
}

function toggleDetails(id: StudentId, event: Event): void {
  const node = event.currentTarget;
  if (!(node instanceof HTMLDetailsElement)) return;
  const next = new Set(expanded.value);
  if (node.open) next.add(id); else next.delete(id);
  expanded.value = next;
}
</script>

<template>
  <div id="lifetimeStatsMount" class="lifetime-stats">
    <article aria-labelledby="lifetimeStatsTitle">
      <div class="card-heading">
        <div>
          <h2 id="lifetimeStatsTitle">长期统计</h2>
          <p class="lifetime-stats-intro">累计次数与出场先后统计跨会话保留，重置抽取状态后仍可查看。</p>
        </div>
      </div>
      <dl class="lifetime-stats-metrics">
        <div><dt>累计抽取</dt><dd id="lifetimeTotalDraws">{{ stats.totalDraws.toLocaleString('zh-CN') }}<span>次</span></dd></div>
        <div><dt>累计覆盖</dt><dd id="lifetimeCovered">{{ stats.covered }}<span>/ {{ stats.participants }} 人</span></dd></div>
        <div><dt>参与抽取</dt><dd id="lifetimeActive">{{ stats.activeParticipants }}<span>/ {{ stats.participants }} 人</span></dd></div>
        <div><dt>重置后抽取</dt><dd id="lifetimeSessionRound">{{ stats.sessionRound.toLocaleString('zh-CN') }}<span>次</span></dd></div>
      </dl>
      <p id="lifetimeStoredSummary" class="lifetime-stats-summary">{{ summary }}</p>
      <div class="lifetime-stats-controls">
        <label class="lifetime-stats-search">
          <span class="icon material-icon" aria-hidden="true">search</span>
          <input id="lifetimeStatsSearch" v-model="query" type="search" autocomplete="off" placeholder="搜索姓名或学号" aria-label="搜索长期统计" :disabled="busy">
        </label>
        <label class="lifetime-stats-sort">排序
          <select id="lifetimeStatsSort" v-model="order" :disabled="busy">
            <option value="id">学号</option><option value="draws">累计次数</option>
            <option value="position">平均出场位次</option><option value="session">本次次数</option>
          </select>
        </label>
      </div>
      <p id="lifetimeStatsMatchCount" class="lifetime-stats-match" role="status" aria-live="polite">显示 {{ rows.length }} / {{ stats.participants }} 位同学</p>
      <div ref="scroller" class="lifetime-stats-scroll" tabindex="0" role="region" aria-label="所有同学的长期统计，可横向滚动">
        <table>
          <thead><tr><th scope="col">同学</th><th scope="col">累计次数</th><th scope="col">平均出场位次</th><th scope="col">本次次数</th><th scope="col">普通随机概率</th><th scope="col">明细</th></tr></thead>
          <tbody id="lifetimeStatsRows">
            <tr v-for="row in rows" :key="row.id" :data-stats-student="row.id" :class="{ 'lifetime-stats-paused': !row.active }">
              <th scope="row"><span class="lifetime-stats-student">{{ row.id.padStart(2, '0') }} <strong>{{ row.name }}</strong></span><span class="lifetime-stats-status">{{ row.active ? '参与中' : '已暂停' }}</span></th>
              <td data-stats-value="draws">{{ row.draws }}</td>
              <td data-stats-value="position" :title="row.meanPosition === null ? '没有位置样本' : String(row.meanPosition)">{{ average(row) }}<small>{{ row.positionSamples }} 个样本</small></td>
              <td data-stats-value="session">{{ row.sessionDraws }}</td>
              <td data-stats-value="probability">{{ (row.probability * 100).toFixed(2) }}%</td>
              <td>
                <details :data-stats-detail="row.id" :open="expanded.has(row.id)" @toggle="toggleDetails(row.id, $event)">
                  <summary :aria-label="row.name + '的全部统计'">查看</summary>
                  <dl class="lifetime-stats-details"><div v-for="[label, value] in detailsPairs(row)" :key="label"><dt>{{ label }}</dt><dd>{{ value }}</dd></div></dl>
                </details>
              </td>
            </tr>
            <tr v-if="!rows.length"><td colspan="6" class="lifetime-stats-empty">没有匹配的同学</td></tr>
          </tbody>
        </table>
      </div>
      <p class="lifetime-stats-note">出场位次按每轮覆盖中的先后归一化：0% 最早，100% 最晚；没有位置样本时显示「—」。普通随机概率是当前候选的实际概率，方向、时间与友尽模式另受各自规则约束。暂停同学也保留在统计中。</p>
    </article>
  </div>
</template>
