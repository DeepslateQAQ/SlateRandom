'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), C = require('../../../src/shared/domain/engine.js');
const roster = (n = 24, cols = 6) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), name: '学生' + (i + 1), row: Math.floor(i / cols) + 1, col: i % cols + 1 }));
const date = new Date(2026, 9, 12, 14, 28, 12);
const configured = (seed = 765, options = {}) => {
  const state = C.createState(roster(), seed);
  state.settings = C.settings(Object.assign({ strategy: 'manual', manualMode: 'direction', modes: ['normal', 'direction'], direction: 'right', directionMin: 1, directionMax: 1, directionChance: 100, timeChance: 0, cooldown: 1 }, options));
  state.lastId = '1';
  return state;
};
const enableValidDirection = state => {
  for (const previous of state.students) {
    state.lastId = previous.id;
    const eligible = new Set(C.probabilities(state).map(item => item.student.id));
    const adjacent = C.adjacent(state, previous, state.settings.direction);
    if (adjacent && eligible.has(adjacent.id)) return;
  }
  throw new Error('Fixture has no valid adjacent student');
};

test('连坐冷却默认3～5轮、范围包含端点；固定值和关闭均不消耗随机状态', () => {
  assert.equal(C.DEFAULTS.directionCooldownMin, 3); assert.equal(C.DEFAULTS.directionCooldownMax, 5);
  assert.equal(C.createState(roster()).directionCooldownRemaining, 0);
  for (const [min, max] of [[3, 5], [0, 2]]) {
    const lengths = new Set();
    for (let seed = 1; seed <= 200; seed++) {
      const state = configured(seed, { directionCooldownMin: min, directionCooldownMax: max });
      state.lock = { direction: 'right', remaining: 2 };
      const twin = C.clone(state), expected = min + Math.floor(C.random(twin) * (max - min + 1));
      assert.equal(C.endDirection(state), expected); assert.equal(state.rngState, twin.rngState); assert.equal(state.lock, null);
      lengths.add(state.directionCooldownRemaining);
    }
    assert.deepEqual([...lengths].sort((a, b) => a - b), Array.from({ length: max - min + 1 }, (_, i) => min + i));
  }
  for (const fixed of [0, 50]) {
    const state = configured(77, { directionCooldownMin: fixed, directionCooldownMax: fixed }); state.lock = { direction: 'right', remaining: 2 };
    const initialRng = state.rngState;
    assert.equal(C.endDirection(state), fixed); assert.equal(C.endDirection(state), fixed); assert.equal(state.rngState, initialRng);
  }
});

test('自然结束与单轮连坐当轮不扣冷却，后续N次成功抽取禁用连坐，第N+1次可再次进入', () => {
  for (const rounds of [1, 2]) {
    const state = configured(90, { directionMin: rounds, directionMax: rounds, directionCooldownMin: 2, directionCooldownMax: 2 });
    for (let i = 0; i < rounds; i++) {
      const record = C.draw(state, date);
      assert.equal(record.mode, 'direction');
      assert.equal(state.directionCooldownRemaining, i === rounds - 1 ? 2 : 0);
      assert.equal(record.directionCooldownStarted, i === rounds - 1 ? 2 : undefined);
    }
    assert.equal(state.lock, null);
    for (const remaining of [2, 1]) {
      enableValidDirection(state);
      assert.equal(C.previewMode(state, date), 'normal');
      const record = C.draw(state, date);
      assert.equal(record.mode, 'normal'); assert.equal(record.switchedFrom, 'direction');
      assert.match(record.reason, new RegExp('冷却，还剩 ' + remaining + ' 轮'));
      assert.equal(record.before.directionCooldownRemaining, remaining);
      assert.equal(state.directionCooldownRemaining, remaining - 1); assert.equal(record.directionCooldownStarted, undefined);
    }
    enableValidDirection(state);
    assert.equal(C.previewMode(state, date), 'direction'); assert.equal(C.draw(state, date).mode, 'direction');
  }
});

test('冷却期间auto/manual100%方向均受保护，异常锁定也不能绕过或重新取冷却', () => {
  for (const strategy of ['auto', 'manual']) for (const anomalousLock of [false, true]) {
    const state = configured(180, { strategy, directionCooldownMin: 5, directionCooldownMax: 5 });
    state.directionCooldownRemaining = 2;
    if (anomalousLock) state.lock = { direction: 'right', remaining: 3 };
    assert.deepEqual(C.modeChances(state), { normal: 100, direction: 0, time: 0 });
    const initialRng = state.rngState;
    assert.equal(C.previewMode(state, date), 'normal'); assert.equal(state.rngState, initialRng);
    const record = C.draw(state, date);
    assert.equal(record.mode, 'normal'); assert.equal(state.lock, null); assert.equal(state.directionCooldownRemaining, 1);
    assert.equal(record.directionCooldownStarted, undefined);
    if (strategy === 'manual' || anomalousLock) assert.match(record.reason, /连坐仍在冷却，还剩 2 轮/);
  }
  const state = configured(); state.directionCooldownRemaining = 3;
  state.settings.directionChance = 40; state.settings.timeChance = 35; state.settings.modes = ['normal', 'direction', 'time'];
  assert.deepEqual(C.modeChances(state), { normal: 65, direction: 0, time: 35 });
  state.students.forEach(student => { student.active = false; });
  const before = C.clone(state);
  assert.throws(() => C.draw(state, date), /没有可参与/); assert.deepEqual(state, before);
});

test('接力无邻座结束与手动退出各启动一次冷却，退出幂等且不重置既有冷却', () => {
  const state = configured(420, { directionCooldownMin: 3, directionCooldownMax: 3 });
  state.lastId = '6'; state.lock = { direction: 'right', remaining: 2 };
  const record = C.draw(state, date);
  assert.equal(record.mode, 'normal'); assert.equal(record.switchedFrom, 'direction');
  assert.equal(record.directionCooldownStarted, 3); assert.equal(state.directionCooldownRemaining, 3);
  assert.match(record.reason, /没有符合方向/); assert.match(record.reason, /进入 3 轮冷却/);
  const rng = state.rngState;
  assert.equal(C.endDirection(state), 3); assert.equal(state.rngState, rng);
  state.lock = { direction: 'right', remaining: 2 };
  assert.equal(C.endDirection(state), 3); assert.equal(state.rngState, rng); assert.equal(state.lock, null);
  const manual = configured(510); manual.lock = { direction: 'right', remaining: 2 };
  const twin = C.clone(manual), expected = 3 + Math.floor(C.random(twin) * 3);
  assert.equal(C.endDirection(manual), expected); assert.equal(manual.rngState, twin.rngState);
  assert.equal(C.endDirection(manual), expected); assert.equal(manual.rngState, twin.rngState);
});

test('冷却持久化后按相同序列继续，旧备份/旧撤销快照迁移为零且保留新默认范围', () => {
  const state = configured(230); C.draw(state, date);
  const restored = C.restoreState(C.clone(state)); assert.deepEqual(restored, state);
  assert.deepEqual(C.draw(restored, date), C.draw(state, date)); assert.deepEqual(restored, state);
  const legacy = C.clone(state);
  delete legacy.directionCooldownRemaining; delete legacy.settings.directionCooldownMin; delete legacy.settings.directionCooldownMax;
  legacy.history.forEach(record => { delete record.before.directionCooldownRemaining; delete record.directionCooldownStarted; });
  const migrated = C.restoreState(legacy);
  assert.equal(migrated.directionCooldownRemaining, 0);
  assert.equal(migrated.settings.directionCooldownMin, 3); assert.equal(migrated.settings.directionCooldownMax, 5);
  migrated.history.forEach(record => assert.equal(record.before.directionCooldownRemaining, 0));
  C.undo(migrated); assert.equal(migrated.directionCooldownRemaining, 0);
  delete migrated.history.at(-1).before.directionCooldownRemaining;
  C.undo(migrated); assert.equal(migrated.directionCooldownRemaining, 0);
});

test('自然结束和无邻座结束的撤销均恢复冷却/接力/PRNG，重抽得到同一冷却值', () => {
  for (const fallback of [false, true]) {
    const state = configured(765, { directionCooldownMin: 1, directionCooldownMax: 5 });
    if (fallback) { state.lastId = '6'; state.lock = { direction: 'right', remaining: 2 }; }
    const before = C.clone(state), record = C.draw(state, date), postRng = state.rngState;
    assert.ok(record.directionCooldownStarted >= 1 && record.directionCooldownStarted <= 5);
    C.undo(state);
    assert.equal(state.directionCooldownRemaining, 0); assert.equal(state.rngState, before.rngState); assert.deepEqual(state.lock, before.lock);
    assert.deepEqual(C.draw(state, date), record); assert.equal(state.rngState, postRng);
  }
  const state = configured(876); state.directionCooldownRemaining = 2;
  const record = C.draw(state, date); assert.equal(state.directionCooldownRemaining, 1);
  C.undo(state); assert.equal(state.directionCooldownRemaining, 2); assert.equal(state.rngState, record.before.rngState);
  assert.deepEqual(C.draw(state, date), record);
});

test('重置清除连坐冷却并保留长期公平统计，0～0关闭冷却且不额外消耗PRNG', () => {
  const state = configured(890); C.draw(state, date);
  assert.ok(state.directionCooldownRemaining > 0);
  const fairness = C.clone(state.fairnessStats), rng = state.rngState;
  C.reset(state); assert.equal(state.directionCooldownRemaining, 0); assert.equal(state.lock, null);
  assert.deepEqual(state.fairnessStats, fairness); assert.equal(state.rngState, rng);
  const off = configured(910, { directionCooldownMin: 0, directionCooldownMax: 0 });
  const initialRng = off.rngState;
  const first = C.draw(off, date), second = C.draw(off, date);
  assert.equal(first.mode, 'direction'); assert.equal(second.mode, 'direction');
  assert.equal(first.directionCooldownStarted, 0); assert.equal(second.directionCooldownStarted, 0);
  assert.equal(off.directionCooldownRemaining, 0); assert.equal(off.rngState, initialRng);
});

test('冷却设置与备份拒绝非整数/越界/颠倒范围，以及当前和历史锁定冷却冲突', () => {
  for (const options of [{ directionCooldownMin: -1 }, { directionCooldownMax: 51 }, { directionCooldownMin: 1.5 }, { directionCooldownMax: NaN }, { directionCooldownMin: 6, directionCooldownMax: 2 }]) assert.throws(() => C.settings(options), /连坐.*冷却/);
  const state = configured(934, { directionCooldownMin: 1, directionCooldownMax: 1 }); C.draw(state, date);
  for (const remaining of [-1, 51, 1.5, 'wrong', '2', null, undefined]) {
    const top = C.clone(state); top.directionCooldownRemaining = remaining;
    assert.throws(() => C.restoreState(top), /冷却/);
    const history = C.clone(state); history.history[0].before.directionCooldownRemaining = remaining;
    assert.throws(() => C.restoreState(history), /冷却/);
    const record = C.clone(state); record.history[0].directionCooldownStarted = remaining;
    assert.throws(() => C.restoreState(record), /冷却/);
  }
  const conflict = C.clone(state); conflict.lock = { direction: 'right', remaining: 1 };
  assert.throws(() => C.restoreState(conflict), /锁定与冷却状态冲突/);
  const oldConflict = C.clone(state); oldConflict.history[0].before.lock = { direction: 'right', remaining: 1 }; oldConflict.history[0].before.directionCooldownRemaining = 1;
  assert.throws(() => C.restoreState(oldConflict), /历史连坐锁定与冷却状态冲突/);
  assert.deepEqual(C.restoreState(C.clone(state)), state);
});
