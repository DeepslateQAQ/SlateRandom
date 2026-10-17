<script setup lang="ts">
import { computed, ref } from 'vue';
import engine from '../domain/engine';
import type { ClassState } from '../../shared/domain/model';
import '../styles/empty-roster.css';
const props = defineProps<{
  state: ClassState;
  busy: boolean;
  saveError: string;
  recoveryRequired: boolean;
  swapMode: boolean;
  swapFirst: string | null;
}>();
const blocked = computed(() => props.busy || props.recoveryRequired);
const search = ref('');
const empty = computed(() => !props.state.students.length);
const displayId = (id: string) => id.padStart(2, '0');
const probability = computed(() => new Map(engine.probabilities(props.state).map(p => [p.student.id, p.probability])));
const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  return props.state.students.filter(s => s.name.toLowerCase().includes(query) || s.id.includes(query));
});
const cols = computed(() => Math.max(1, props.state.cols, ...props.state.students.map(s => s.col)));
const seats = computed(() => {
  if (empty.value) return [];
  const map = new Map(props.state.students.map(s => [s.row + ':' + s.col, s]));
  const rows = Math.max(1, props.state.seatRows || 0, ...props.state.students.map(s => s.row));
  return Array.from({ length: rows * cols.value }, (_, index) => {
    const row = Math.floor(index / cols.value) + 1, col = index % cols.value + 1;
    return { key: row + ':' + col, row, col, student: map.get(row + ':' + col) };
  });
});
const swapHint = computed(() => empty.value ? '先导入名单，再配置座位与友尽目标。' : props.swapMode ? props.swapFirst
  ? '已经选中第一位同学，再点击另一位同学即可交换。点击已选座位可以取消。'
  : '交换座位已开启：依次点击两位同学，触屏和键盘均可操作。'
  : '点击座位显示设置／友尽；友尽目标可红色多选后保存。空座会保留在布局中。');
</script>

<template>
  <section id="view-roster" class="view" aria-label="名单与座位">
    <div class="config-class"><button id="classBtn" class="class-chip" :disabled="blocked"><span class="icon material-icon" aria-hidden="true">school</span><span id="classLabel">{{ state.className }}</span><span id="demoTag" class="demo-tag" :hidden="!state.demo">演示</span></button><div class="toolbar-right"><button class="btn" data-import :disabled="blocked"><span class="icon material-icon" aria-hidden="true">upload</span>导入名单</button><button id="fullscreenBtn" class="icon-btn" aria-label="进入或退出全屏" :disabled="busy"><span class="icon material-icon" aria-hidden="true">fullscreen</span></button></div></div>
    <p class="page-description">班级、导入、个人配置与座位布局</p>
    <div class="roster-toolbar"><div class="segmented roster-segment"><button id="seatViewBtn" :disabled="busy || empty" class="selected" aria-pressed="true"><span class="icon material-icon" aria-hidden="true">grid_view</span>座位布局</button><button id="listViewBtn" :disabled="busy || empty" aria-pressed="false"><span class="icon material-icon" aria-hidden="true">list</span>名单列表</button></div><div class="toolbar-right"><button id="swapBtn" :disabled="blocked || empty" class="btn btn-plain" :class="{ 'btn-primary': swapMode }" :aria-pressed="swapMode"><span class="icon material-icon" aria-hidden="true">shuffle</span>交换座位</button><button id="reflowBtn" :disabled="blocked || empty" class="btn btn-plain"><span class="icon material-icon" aria-hidden="true">grid_view</span>重新排座</button></div></div>
    <p id="swapHint" class="inline-hint">{{ swapHint }}</p>
    <article class="card roster-card"><div v-if="empty" id="rosterEmptyState" class="roster-empty-state"><span class="material-icon" aria-hidden="true">groups</span><h3>尚未配置名单</h3><p>导入按行名单、座位图或 CSV、XLS、XLSX 学号表。名单没有座位且无法匹配已有布局时，程序会先询问教室的行列尺寸。</p><button type="button" class="btn btn-primary" data-import :disabled="blocked"><span class="icon material-icon" aria-hidden="true">upload</span>导入名单</button></div><div id="rosterMap" :hidden="empty"><p id="seatCountLabel" class="field-hint">{{ empty ? '尚未配置名单' : state.students.length + ' 位同学' }}</p><div class="seat-scroll"><div class="podium">讲　台</div><div id="rosterSeats" class="seat-grid large-seats" :style="{ '--cols': cols }">
      <template v-for="seat in seats" :key="seat.key">
        <button v-if="seat.student" class="seat" :class="{ paused: !seat.student.active, current: seat.student.active && state.lastId === seat.student.id, seen: seat.student.active && state.lastId !== seat.student.id && state.cycleSeen.includes(seat.student.id), 'swap-selected': swapFirst === seat.student.id }"
          :data-student="seat.student.id" :disabled="blocked"
          :aria-label="`${displayId(seat.student.id)}号 ${seat.student.name}，第${seat.row}行第${seat.col}列，已抽${state.counts[seat.student.id] || 0}次，${seat.student.active ? '参与抽取' : '暂停参与'}`">
          <span class="seat-name">{{ seat.student.name }}</span><span class="seat-id">{{ displayId(seat.student.id) }}</span>
        </button>
        <div v-else class="seat empty" :aria-label="`第 ${seat.row} 行第 ${seat.col} 列为空座`">空座</div>
      </template>
    </div></div></div>
    <div id="rosterList" hidden><label class="search-box"><span class="icon material-icon" aria-hidden="true">search</span><input id="rosterSearch" v-model="search" type="search" placeholder="搜索姓名或学号" aria-label="搜索名单" :disabled="busy"></label><div class="table-scroll"><table><thead><tr><th>学号</th><th>姓名</th><th>座位</th><th>累计次数</th><th>随机模式概率</th><th>参与状态</th><th></th></tr></thead><tbody id="rosterTable">
      <tr v-for="student in filtered" :key="student.id"><td>{{ displayId(student.id) }}</td><td>{{ student.name }}</td><td>{{ student.row }} 行 {{ student.col }} 列</td><td>{{ state.fairnessStats[student.id]?.draws ?? state.counts[student.id] ?? 0 }} 次</td><td>{{ student.active ? ((probability.get(student.id) || 0) * 100).toFixed(1) + '%' : '—' }}</td><td><button :data-toggle-student="student.id" class="state-btn" :class="{ off: !student.active }" :disabled="blocked" :aria-label="(student.active ? '暂停' : '恢复') + student.name + '参与抽取'">{{ student.active ? '参与中' : '已暂停' }}</button></td><td><button :data-student="student.id" class="text-btn" :disabled="blocked">编辑</button></td></tr>
      <tr v-if="!filtered.length"><td colspan="7" class="empty-state">{{ empty ? '尚未配置名单，请先导入' : '没有匹配的同学' }}</td></tr>
    </tbody></table></div><p class="table-note">这里显示普通随机模式的实时概率；方向与时间模式还会受邻座和学号规则约束。</p></div></article>
    <div class="bottom-hint"><span class="icon material-icon" aria-hidden="true">lock</span>名单与抽取记录自动保存在本地。前往「数据」页面，可单独导出名单或备份全部数据。</div>
  </section>
</template>
