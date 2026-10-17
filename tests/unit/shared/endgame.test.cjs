'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), C = require('../../../src/shared/domain/engine.js');
const roster = (n = 32, cols = 8) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), name: '学生' + (i + 1), row: Math.floor(i / cols) + 1, col: i % cols + 1 }));
const date = new Date(2026, 9, 12, 14, 28, 12);
test('结果跳变开关默认开启并跨备份保留，关闭时保留概率且不影响混合分配', () => {
  assert.equal(C.DEFAULTS.endJumpEnabled, true); assert.equal(C.settings().endJumpEnabled, true);
  const state = C.createState(roster()); state.settings = C.settings({ endJumpEnabled: false, endJumpChance: 87, directionChance: 20, timeChance: 30 });
  assert.deepEqual(C.modeChances(state), { normal: 50, direction: 20, time: 30 });
  const restored = C.restoreState(C.clone(state)); assert.equal(restored.settings.endJumpEnabled, false); assert.equal(restored.settings.endJumpChance, 87);
  delete restored.settings.endJumpEnabled;
  assert.equal(C.restoreState(restored).settings.endJumpEnabled, true);
  for (const value of [false, 0, 1, 'true', 'false', null]) assert.equal(C.settings({ endJumpEnabled: value }).endJumpEnabled, false);
});
test('关闭结果跳变在普通、方向和时间抽取中等同未请求末尾改选，不额外消费随机数或统计', () => {
  for (const mode of ['normal', 'direction', 'time']) {
    const state = C.createState(roster(47), 765);
    state.settings = C.settings({ strategy: 'manual', manualMode: mode, endJumpEnabled: false, endJumpChance: 100, friendEnabled: false, timeSource: 'time' });
    if (mode === 'direction') state.lastId = '19';
    const baseline = C.clone(state); baseline.settings.endJumpEnabled = true;
    const record = C.draw(state, date, { endJump: true }), expected = C.draw(baseline, date, { endJump: false });
    assert.deepEqual(record, expected); assert.equal(record.endJump, undefined);
    assert.equal(state.settings.endJumpChance, 100); assert.equal(state.rngState, baseline.rngState);
    assert.deepEqual(state.counts, baseline.counts); assert.deepEqual(state.fairnessStats, baseline.fairnessStats);
  }
});
test('自动模式按连坐20%、时间30%、普通50%触发，预检不消耗真实随机状态', () => {
  const s = C.createState(roster()); s.settings = C.settings({ directionChance: 20, timeChance: 30 });
  const result = { normal: 0, direction: 0, time: 0 };
  for (let i = 1; i <= 16000; i++) { s.rngState = (i * 3761) >>> 0; const before = s.rngState; result[C.previewMode(s, date)]++; assert.equal(s.rngState, before); }
  for (const [mode, expected] of Object.entries({ normal: .5, direction: .2, time: .3 })) assert.ok(Math.abs(result[mode] / 16000 - expected) < .02, mode);
});
test('禁用方式的概率归还普通，零概率不触发，新设置和旧备份均可恢复', () => {
  const s = C.createState(roster()); s.settings = C.settings({ modes: ['time'], directionChance: 20, timeChance: 30 });
  assert.deepEqual(C.modeChances(s), { normal: 70, direction: 0, time: 30 });
  s.settings = C.settings({ directionChance: 0, timeChance: 0 });
  for (let i = 1; i <= 100; i++) { s.rngState = i; assert.equal(C.previewMode(s, date), 'normal'); }
  const saved = C.clone(s); delete saved.settings.directionChance; delete saved.settings.timeChance; delete saved.settings.endJumpChance;
  const old = C.restoreState(saved); assert.equal(old.settings.directionChance, 33); assert.equal(old.settings.timeChance, 33); assert.equal(old.settings.endJumpChance, 30);
  assert.deepEqual(C.restoreState(C.clone(s)), s);
});
test('概率越界或合计大于100被拒绝，100%不可用方式只回退一次', () => {
  for (const settings of [{ directionChance: 70, timeChance: 40 }, { directionChance: -1 }, { timeChance: 101 }, { endJumpChance: 101 }]) assert.throws(() => C.settings(settings), /概率/);
  const s = C.createState(roster(1)); s.settings = C.settings({ directionChance: 0, timeChance: 100 });
  const r = C.draw(s, new Date(2026, 9, 12, 23, 59, 59), { endJump: true }); assert.equal(r.mode, 'normal'); assert.equal(r.switchedFrom, 'time'); assert.equal(s.round, 1); assert.equal(s.history.length, 1);
});
test('连坐锁定时概率修改不会提前终止，锁定结束后使用普通剩余概率', () => {
  const s = C.createState(roster(12, 4), 8); s.lastId = '1'; s.settings = C.settings({ strategy: 'manual', manualMode: 'direction', direction: 'right', directionMin: 2, directionMax: 2 });
  C.draw(s, date); s.settings.strategy = 'auto'; s.settings.directionChance = 0; s.settings.timeChance = 0;
  assert.equal(C.draw(s, date).mode, 'direction'); assert.equal(s.lock, null); assert.equal(C.draw(s, date).mode, 'normal');
});
test('普通末尾确实改选真实学生，回选匹配最后一个动画焦点且只有最终人计入统计', () => {
  const kinds = new Set();
  for (let seed = 1; seed <= 150; seed++) {
    const s = C.createState(roster(16), seed); s.settings = C.settings({ strategy: 'manual', manualMode: 'normal', endJumpChance: 100 });
    const r = C.draw(s, date, { endJump: true }); kinds.add(r.endJump.kind);
    assert.notEqual(r.studentId, r.endJump.initialStudentId); assert.equal(s.round, 1); assert.equal(s.history.length, 1);
    assert.equal(s.counts[r.studentId], 1); assert.equal(s.counts[r.endJump.initialStudentId], undefined);
    assert.deepEqual(s.cycleSeen, [r.studentId]); assert.equal(Object.values(s.fairnessStats).reduce((n, stats) => n + stats.draws, 0), 1);
    if (r.endJump.kind === 'back') assert.equal(r.studentId, r.animationOrder.at(-1));
  }
  assert.equal(kinds.size, 2);
});
test('方向末尾只能改选未抽且未冷却的实际相邻座位，最终方向与锁定记录同步', () => {
  const kinds = new Set();
  for (let seed = 1; seed <= 100; seed++) {
    const s = C.createState(roster(9, 3), seed); s.settings = C.settings({ strategy: 'manual', manualMode: 'direction', directionMin: 5, directionMax: 5, cooldown: 1, endJumpChance: 100 });
    s.lastId = '5'; s.round = 2; s.counts = { '5': 1, '2': 1 }; s.lastSeen = { '5': 2, '2': 1 }; s.cycleSeen = ['2', '5'];
    const eligible = new Set(C.probabilities(s).map(p => p.student.id)), r = C.draw(s, date, { endJump: true }); kinds.add(r.endJump.kind);
    assert.ok(eligible.has(r.studentId)); assert.notEqual(r.studentId, '2'); assert.notEqual(r.studentId, r.endJump.initialStudentId);
    assert.equal(C.adjacent(s, s.students.find(p => p.id === '5'), r.direction).id, r.studentId); assert.equal(s.lock.direction, r.direction); assert.equal(s.lock.remaining, 4);
    assert.equal(s.round, 3); assert.equal(Object.values(s.counts).reduce((n, count) => n + count, 0), 3);
  }
  assert.equal(kinds.size, 2);
});
test('时间末尾仅在有效取位对应的人中改选，最终数字快照匹配真实学号', () => {
  for (let seed = 1; seed <= 80; seed++) {
    const s = C.createState(roster(47), seed); s.settings = C.settings({ strategy: 'manual', manualMode: 'time', timeSource: 'time', endJumpChance: 100 });
    const eligible = new Set(C.timeOptions(s, date).map(p => p.student.id)), r = C.draw(s, date, { endJump: true });
    assert.equal(r.mode, 'time'); assert.notEqual(r.studentId, r.endJump.initialStudentId); assert.ok(eligible.has(r.studentId));
    assert.equal(Number(r.studentId), r.timeRule.number); assert.equal(r.timeRule.digits, '142812'); assert.equal(r.endJump.initialTimeRule.digits, r.timeRule.digits);
    assert.equal(r.timeRule.picked, r.timeRule.positions.map(p => r.timeRule.digits[p - 1]).join('')); assert.equal(s.history.length, 1);
  }
});
test('末尾改选可跨备份并精确撤销重抽，0%与单一候选不会产生改选记录', () => {
  const s = C.createState(roster(), 765); s.settings = C.settings({ strategy: 'manual', endJumpChance: 100 });
  const before = C.clone(s), first = C.draw(s, date, { endJump: true });
  const restored = C.restoreState(C.clone(s)); assert.deepEqual(restored.history.at(-1), first);
  C.undo(restored); assert.equal(restored.rngState, before.rngState); assert.deepEqual(restored.fairnessStats, before.fairnessStats); assert.deepEqual(C.draw(restored, date, { endJump: true }), first);
  const single = C.createState(roster(1), 777); assert.equal(C.draw(single, date, { endJump: true }).endJump, undefined);
  const zero = C.createState(roster(), 888); zero.settings.endJumpChance = 0; assert.equal(C.draw(zero, date, { endJump: true }).endJump, undefined);
});
test('100%末尾改选尝试仍保持长期次数和先后位置权重，不反转两位候选人的概率', () => {
  const initial = C.createState(roster(2), 1);
  initial.settings = C.settings({ strategy: 'manual', manualMode: 'normal', endJumpChance: 100 });
  initial.fairnessStats = { '1': { draws: 12, positionSum: 9, positionSamples: 12 }, '2': { draws: 20, positionSum: 3, positionSamples: 20 } };
  const expected = C.probabilities(initial).find(item => item.student.id === '1').probability;
  assert.ok(expected > .7, '较少且较晚抽中的学生应得到显著更高的初始权重');
  let selected = 0, changed = 0, unchanged = 0;
  for (let i = 1; i <= 14000; i++) {
    const s = C.clone(initial); s.rngState = Math.imul(i, 104729) >>> 0;
    const record = C.draw(s, date, { endJump: true });
    selected += record.studentId === '1'; changed += !!record.endJump; unchanged += !record.endJump;
    assert.equal(s.history.length, 1); assert.equal(s.round, 1);
    assert.equal(s.fairnessStats['1'].draws + s.fairnessStats['2'].draws, 33);
  }
  assert.ok(changed > 0 && unchanged > 0, '公平保护保留部分原结果，仍允许真实改选');
  assert.ok(Math.abs(selected / 14000 - expected) < .025, `最终概率 ${selected / 14000} 应保持初始权重 ${expected}`);
});
