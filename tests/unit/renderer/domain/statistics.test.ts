import test from 'node:test';
import assert from 'node:assert/strict';
import canonicalEngine from '../../../../src/shared/domain/engine.js';
import engine from '../../../../src/renderer/domain/engine';
import { aggregateStatistics } from '../../../../src/renderer/domain/statistics';
import type { ClassState } from '../../../../src/shared/domain/model';

function configured(size = 8): ClassState {
  const students = Array.from({ length: size }, (_, index) => ({ id: String(index + 1), name: '学生' + (index + 1), row: Math.floor(index / 4) + 1, col: index % 4 + 1 }));
  const state = engine.createState(students, 617);
  Object.assign(state.settings, { strategy: 'manual', manualMode: 'normal', endJumpChance: 0, friendEnabled: false });
  return state;
}

test('ESM 类型边界引用同一个核心，保存并恢复后抽选与撤销结果相同', () => {
  assert.equal(engine, canonicalEngine);
  const state = configured();
  const date = new Date(2026, 9, 14, 12, 34, 56);
  for (let count = 0; count < 11; count++) engine.draw(state, date);
  const restored = engine.restoreState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(engine.draw(restored, date), engine.draw(state, date));
  engine.undo(restored); engine.undo(state);
  assert.deepEqual(restored, state);
});

test('Vue 统计来源区分跨会话累计与本次状态，重置后不会丢失位置观察', () => {
  const state = configured();
  for (let count = 0; count < 11; count++) engine.draw(state);
  const retained = engine.clone(state.fairnessStats);
  engine.reset(state);
  assert.deepEqual(state.fairnessStats, retained);
  for (let count = 0; count < 3; count++) engine.draw(state);
  const before = engine.clone(state), stats = aggregateStatistics(state);
  assert.equal(stats.totalDraws, 14); assert.equal(stats.positionSamples, 14);
  assert.equal(stats.sessionRound, 3); assert.equal(stats.sessionDraws, 3); assert.equal(stats.retainedRecords, 3);
  assert.equal(stats.covered, 8); assert.equal(stats.cycleCovered, 3);
  assert.deepEqual(state, before);
  const probability = new Map(engine.probabilities(state).map(item => [item.student.id, item.probability]));
  assert.ok(stats.rows.every(row => row.probability === (probability.get(row.id) ?? 0)));
});

test('暂停者与超过2000条日志的长期统计仍展示，保留上次座位的冷却不编造轮次', () => {
  const state = configured(4);
  for (let count = 0; count < 2003; count++) engine.draw(state);
  const student = state.students[0]; assert.ok(student); student.active = false;
  const stats = aggregateStatistics(state), row = stats.rows.find(item => item.id === student.id);
  assert.ok(row); assert.equal(stats.totalDraws, 2003); assert.equal(stats.retainedRecords, 2000);
  assert.equal(stats.participants, 4); assert.equal(stats.activeParticipants, 3);
  assert.equal(row.active, false); assert.equal(row.probability, 0); assert.equal(row.eligible, false);
  const previous = state.lastId; engine.reset(state); state.lastId = previous;
  const previousRow = aggregateStatistics(state).rows.find(item => item.id === previous);
  assert.ok(previousRow); assert.equal(previousRow.cooling, true); assert.equal(previousRow.roundsWaiting, null);
});

test('未知旧位置不生成观察样本，迁移统计的次数与旧备份已知总量一致', () => {
  const state = configured();
  for (let count = 0; count < 9; count++) engine.draw(state);
  const legacy: Record<string, unknown> = { ...engine.clone(state) };
  delete legacy.fairnessStats;
  const migrated = engine.restoreState(legacy), stats = aggregateStatistics(migrated);
  assert.equal(stats.totalDraws, 9); assert.equal(stats.positionSamples, 0);
  assert.ok(stats.rows.every(row => row.meanPosition === null));
});

