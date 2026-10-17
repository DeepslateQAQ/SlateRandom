'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), C = require('../../../src/shared/domain/engine.js');
const date = new Date(2026, 9, 13, 14, 28, 12);
const roster = (n = 12, cols = 4) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), name: '学生' + (i + 1), row: Math.floor(i / cols) + 1, col: i % cols + 1 }));
const configured = (seed = 71, options = {}, targets = ['2', '3']) => {
  const students = roster(); students[0].friendTargets = targets;
  const state = C.createState(students, seed);
  state.lastId = '1'; state.settings = C.settings(Object.assign({ strategy: 'manual', manualMode: 'normal', cooldown: 1, friendChance: 100, endJumpChance: 0 }, options));
  return state;
};

test('友尽概率独立于普通方式合计，旧设置默认20%，不加入普通模式列表', () => {
  assert.deepEqual(C.MODES, ['normal', 'direction', 'time']);
  assert.deepEqual(C.RECORD_MODES, ['normal', 'direction', 'time', 'friend']);
  const state = configured(71, { directionChance: 70, timeChance: 30, friendChance: 100 });
  assert.deepEqual(C.modeChances(state), { normal: 0, direction: 70, time: 30 });
  assert.equal(C.DEFAULTS.friendChance, 20);
  assert.equal(C.settings({ manualMode: 'friend', modes: ['friend'] }).manualMode, 'normal');
  assert.deepEqual(C.settings({ modes: ['friend'] }).modes, ['normal']);
  for (const friendChance of [-1, 101, 1.2, 'invalid']) assert.throws(() => C.settings({ friendChance }), /友尽触发概率/);
  const legacy = C.clone(state); delete legacy.settings.friendChance;
  assert.equal(C.restoreState(legacy).settings.friendChance, 20);
});

test('友尽开关规范布尔值，旧备份默认开启，显式关闭及已有历史均能完整恢复', () => {
  assert.equal(C.DEFAULTS.friendEnabled, true);
  assert.equal(C.settings().friendEnabled, true);
  for (const value of [false, 0, 1, 'true', 'false', null]) assert.equal(C.settings({ friendEnabled: value }).friendEnabled, false);
  assert.equal(C.settings({ friendEnabled: true }).friendEnabled, true);
  const state = configured(215, {}, ['2']); C.draw(state, date);
  const legacy = C.clone(state); delete legacy.settings.friendEnabled;
  const restoredLegacy = C.restoreState(legacy);
  assert.equal(restoredLegacy.settings.friendEnabled, true); assert.deepEqual(restoredLegacy.history, state.history);
  state.settings.friendEnabled = false;
  assert.deepEqual(C.restoreState(C.clone(state)), state);
  assert.deepEqual(state.students[0].friendTargets, ['2']); assert.equal(state.settings.friendChance, 100);
});

test('友尽关闭即使100%也完全绕过判定，与无目标的自动、手动和锁定抽选PRNG一致', () => {
  for (const scenario of ['auto', 'manual', 'locked']) {
    for (let seed = 1; seed <= 64; seed++) {
      const state = configured(seed, { friendEnabled: false, friendChance: 100, direction: 'right', endJumpChance: 30 });
      if (scenario === 'auto') state.settings.strategy = 'auto';
      if (scenario === 'locked') state.lock = { direction: 'right', remaining: 3 };
      const twin = C.clone(state); twin.settings.friendEnabled = true; twin.students.forEach(student => delete student.friendTargets);
      const before = C.clone(state), preview = C.previewMode(state, date);
      assert.notEqual(preview, 'friend'); assert.equal(preview, C.previewMode(twin, date)); assert.deepEqual(state, before);
      const actual = C.draw(state, date, { endJump: true }), baseline = C.draw(twin, date, { endJump: true });
      assert.deepEqual(actual, baseline); assert.equal(state.rngState, twin.rngState);
      assert.deepEqual(state.lock, twin.lock); assert.equal(state.directionCooldownRemaining, twin.directionCooldownRemaining);
      assert.deepEqual(state.counts, twin.counts); assert.deepEqual(state.fairnessStats, twin.fairnessStats);
      if (scenario === 'locked') { assert.equal(actual.mode, 'direction'); assert.deepEqual(state.lock, { direction: 'right', remaining: 2 }); assert.equal(state.directionCooldownRemaining, 0); }
    }
  }
});

test('关闭后保留友尽概率和目标，恢复备份后重新开启立即使用原有目标', () => {
  const state = configured(376, { friendEnabled: false, friendChance: 100 }, ['4']);
  const restored = C.restoreState(C.clone(state));
  assert.equal(C.previewMode(restored, date), 'normal');
  C.draw(restored, date); C.undo(restored);
  assert.equal(restored.lastId, '1'); assert.equal(restored.settings.friendEnabled, false);
  assert.deepEqual(restored.students[0].friendTargets, ['4']); assert.equal(restored.settings.friendChance, 100);
  restored.settings = C.settings(Object.assign({}, restored.settings, { friendEnabled: true }));
  assert.equal(C.previewMode(restored, date), 'friend');
  const record = C.draw(restored, date);
  assert.equal(record.mode, 'friend'); assert.equal(record.friendSourceId, '1'); assert.equal(record.studentId, '4');
  assert.deepEqual(record.friendTargetIds, ['4']); assert.deepEqual(C.restoreState(C.clone(restored)), restored);
});

test('友尽目标两遍规范化保留后向引用，拒绝自己、重复、名单外与格式错误目标', () => {
  const raw = roster(4); raw[0].friendTargets = [' 004 ', 2]; raw[1].friendTargets = [];
  const students = C.normalizeStudents(raw);
  assert.deepEqual(students[0].friendTargets, ['4', '2']); assert.ok(!Object.hasOwn(students[1], 'friendTargets'));
  assert.deepEqual(C.parseVision(JSON.stringify({ students: raw })).students[0].friendTargets, ['4', '2']);
  for (const [targets, message] of [[['1'], /自己/], [['02', '2'], /重复/], [['5'], /名单外/], [null, /学号数组/], ['2', /学号数组/], [[{}], /无效/], [[0], /无效/], [['1e1'], /无效/]]) {
    const bad = roster(4); bad[0].friendTargets = targets;
    assert.throws(() => C.createState(bad), message);
  }
  assert.deepEqual(C.normalizeStudents(roster(4)), roster(4).map(student => Object.assign({}, student, { active: true })));
});

test('0%、无前一个人和无有效目标均不额外消耗PRNG；100%单一目标也不消耗判定随机数', () => {
  for (const scenario of ['zero', 'initial', 'blocked', 'missing']) {
    const state = configured();
    if (scenario === 'zero') state.settings.friendChance = 0;
    if (scenario === 'initial') state.lastId = null;
    if (scenario === 'blocked') { state.cycleSeen = ['2', '3']; state.counts = { '2': 1, '3': 1 }; }
    if (scenario === 'missing') delete state.students[0].friendTargets;
    const twin = C.clone(state); twin.students.forEach(student => delete student.friendTargets);
    const record = C.draw(state, date), baseline = C.draw(twin, date);
    assert.equal(record.mode, baseline.mode); assert.equal(record.studentId, baseline.studentId); assert.equal(state.rngState, twin.rngState);
  }
  const state = configured(103, {}, ['2']), before = state.rngState;
  assert.equal(C.previewMode(state, date), 'friend'); assert.equal(state.rngState, before);
  const record = C.draw(state, date);
  assert.equal(record.studentId, '2'); assert.equal(record.mode, 'friend'); assert.equal(state.rngState, before);
  assert.deepEqual(record.friendTargetIds, ['2']); assert.equal(record.friendSourceId, '1');
});

test('友尽先判定，失败继续自动普通概率或原有连坐锁定，成功覆盖手动方式和锁定', () => {
  const students = roster(47, 8); students[0].friendTargets = ['2', '3'];
  const state = C.createState(students, 1); state.lastId = '1';
  state.settings = C.settings({ friendChance: 40, directionChance: 20, timeChance: 30 });
  const observed = { friend: 0, normal: 0, direction: 0, time: 0 };
  for (let i = 1; i <= 10000; i++) { state.rngState = Math.imul(i, 3761) >>> 0; const rng = state.rngState; observed[C.previewMode(state, date)]++; assert.equal(state.rngState, rng); }
  for (const [mode, chance] of Object.entries({ friend: .4, normal: .3, direction: .12, time: .18 })) assert.ok(Math.abs(observed[mode] / 10000 - chance) < .025, mode + ': ' + observed[mode]);
  let failedSeed;
  for (let seed = 1; seed < 100; seed++) { const probe = { rngState: seed }; if (C.random(probe) >= .4) { failedSeed = seed; break; } }
  const locked = configured(failedSeed, { friendChance: 40, manualMode: 'time', direction: 'right' }); locked.lock = { direction: 'right', remaining: 3 };
  const expected = C.clone(locked); C.random(expected); expected.settings.friendChance = 0;
  const actual = C.draw(locked, date), normalLock = C.draw(expected, date);
  assert.equal(actual.mode, 'direction'); assert.equal(actual.studentId, normalLock.studentId); assert.equal(locked.rngState, expected.rngState); assert.deepEqual(locked.lock, normalLock.before.lock && { direction: 'right', remaining: 2 });
  const success = configured(37, { manualMode: 'time', friendChance: 100 }, ['4']); success.lock = { direction: 'right', remaining: 3 };
  assert.equal(C.draw(success, date).mode, 'friend'); assert.equal(success.lock, null);
});

test('友尽目标仍受未抽优先、个人冷却、暂停和长期公平权重约束，没有可用目标则正常抽取', () => {
  const state = configured(66, { cooldown: 3 }, ['2', '3', '4', '5', '6']);
  state.students.find(student => student.id === '6').active = false;
  state.round = 4; state.counts = { '1': 1, '2': 1, '3': 1, '4': 1 }; state.cycleSeen = ['1', '2', '3', '4'];
  state.history = [{ studentId: '2' }, { studentId: '3' }, { studentId: '1' }];
  assert.deepEqual(C.friendOptions(state).candidates.map(student => student.id), ['5']);
  assert.equal(C.friendOptions(state).source.id, '1'); assert.equal(C.draw(state, date).studentId, '5');
  const unavailable = configured(52); unavailable.cycleSeen = ['2', '3']; unavailable.counts = { '2': 1, '3': 1 };
  assert.equal(C.friendOptions(unavailable).candidates.length, 0); assert.equal(C.draw(unavailable, date).mode, 'normal');
  const weighted = configured(1); weighted.fairnessStats = { '2': { draws: 12, positionSum: 9, positionSamples: 12 }, '3': { draws: 20, positionSum: 3, positionSamples: 20 } };
  const distribution = C.probabilities(weighted), p2 = distribution.find(item => item.student.id === '2').probability, p3 = distribution.find(item => item.student.id === '3').probability, expected = p2 / (p2 + p3);
  assert.ok(expected > .7); let picked = 0;
  for (let i = 1; i <= 6000; i++) { const sample = C.clone(weighted); sample.rngState = Math.imul(i, 104729) >>> 0; picked += C.draw(sample, date).studentId === '2'; }
  assert.ok(Math.abs(picked / 6000 - expected) < .025, '目标内部保留相对公平权重');
});

test('预检不改变状态，友尽可持久化、完整撤销重抽，并按新选中同学继续或在全轮后衔接', () => {
  const state = configured(125, {}, ['2']); state.students[1].friendTargets = ['3'];
  const before = C.clone(state); assert.equal(C.previewMode(state, date), 'friend'); assert.deepEqual(state, before);
  const first = C.draw(state, date), restored = C.restoreState(C.clone(state)); assert.deepEqual(restored, state);
  C.undo(restored);
  for (const key of ['rngState', 'lastId', 'round', 'lock', 'directionCooldownRemaining', 'fairnessStats', 'cycleSeen']) assert.deepEqual(restored[key], before[key], key);
  assert.deepEqual(C.draw(restored, date), first); assert.equal(C.draw(restored, date).friendSourceId, '2'); assert.equal(restored.lastId, '3');
  assert.equal(C.draw(restored, date).mode, 'normal');
  const full = C.createState(roster(4), 231); full.students[3].friendTargets = ['1']; full.lastId = '4'; full.round = 4;
  full.settings = C.settings({ friendChance: 100, cooldown: 1 }); full.counts = { '1': 1, '2': 1, '3': 1, '4': 1 }; full.cycleSeen = ['1', '2', '3', '4'];
  const record = C.draw(full, date); assert.equal(record.mode, 'friend'); assert.equal(record.friendSourceId, '4'); assert.equal(record.studentId, '1'); assert.deepEqual(full.cycleSeen, ['1']);
});

test('友尽中止现有连坐时只启动一次随机冷却，冷却期间友尽照常判定并逐轮扣减，重置保留公平统计', () => {
  const state = configured(217, { directionCooldownMin: 2, directionCooldownMax: 4 }, ['4']); state.lock = { direction: 'right', remaining: 3 };
  const before = C.clone(state), rng = C.clone(state), expected = 2 + Math.floor(C.random(rng) * 3);
  const record = C.draw(state, date);
  assert.equal(record.mode, 'friend'); assert.equal(record.directionCooldownStarted, expected); assert.equal(state.directionCooldownRemaining, expected); assert.equal(state.rngState, rng.rngState); assert.equal(state.lock, null);
  C.undo(state); assert.deepEqual(state.lock, before.lock); assert.equal(state.directionCooldownRemaining, 0); assert.equal(state.rngState, before.rngState); assert.deepEqual(C.draw(state, date), record);
  state.students[3].friendTargets = ['5']; const next = C.draw(state, date);
  assert.equal(next.mode, 'friend'); assert.equal(next.friendSourceId, '4'); assert.equal(next.directionCooldownStarted, undefined); assert.equal(state.directionCooldownRemaining, expected - 1);
  const stats = C.clone(state.fairnessStats); C.reset(state); assert.deepEqual(state.fairnessStats, stats); assert.equal(state.directionCooldownRemaining, 0); assert.equal(state.lastId, null);
});

test('友尽末尾只在目标快照内真实改选，回选顺序匹配最终人且只更新一人的统计', () => {
  const kinds = new Set();
  for (let seed = 1; seed <= 120; seed++) {
    const state = configured(seed, { endJumpChance: 100 }, ['2', '3', '4']), record = C.draw(state, date, { endJump: true });
    assert.equal(record.mode, 'friend'); assert.deepEqual(record.friendTargetIds, ['2', '3', '4']); assert.ok(record.endJump); kinds.add(record.endJump.kind);
    for (const id of [record.studentId, record.endJump.initialStudentId].concat(record.animationOrder || [])) assert.ok(record.friendTargetIds.includes(id));
    assert.notEqual(record.studentId, record.endJump.initialStudentId);
    if (record.endJump.kind === 'back') assert.equal(record.studentId, record.animationOrder.at(-1));
    assert.equal(state.round, 1); assert.equal(state.history.length, 1); assert.deepEqual(Object.keys(state.counts), [record.studentId]); assert.deepEqual(Object.keys(state.fairnessStats), [record.studentId]); assert.deepEqual(state.cycleSeen, [record.studentId]);
    assert.deepEqual(C.restoreState(C.clone(state)), state);
  }
  assert.equal(kinds.size, 2);
  const weighted = configured(1, { endJumpChance: 100 }); weighted.fairnessStats = { '2': { draws: 12, positionSum: 9, positionSamples: 12 }, '3': { draws: 20, positionSum: 3, positionSamples: 20 } };
  const distribution = C.probabilities(weighted), weights = distribution.filter(item => ['2', '3'].includes(item.student.id));
  const expected = weights.find(item => item.student.id === '2').probability / weights.reduce((sum, item) => sum + item.probability, 0);
  let chosen = 0, changed = 0;
  for (let i = 1; i <= 6000; i++) { const sample = C.clone(weighted); sample.rngState = Math.imul(i, 104729) >>> 0; const record = C.draw(sample, date, { endJump: true }); chosen += record.studentId === '2'; changed += !!record.endJump; }
  assert.ok(changed > 0 && changed < 6000); assert.ok(Math.abs(chosen / 6000 - expected) < .03);
});

test('友尽备份验证历史快照而不依赖当前目标设置，拒绝伪造来源、目标与越界动画记录', () => {
  const state = configured(304, { endJumpChance: 100 }); C.draw(state, date, { endJump: true });
  delete state.students[0].friendTargets; state.students[0].active = false;
  assert.deepEqual(C.restoreState(C.clone(state)), state);
  for (const mutate of [record => record.friendSourceId = '99', record => record.friendSourceId = record.studentId, record => record.friendTargetIds = [], record => record.friendTargetIds = ['2', '2'], record => record.friendTargetIds = ['2', '99'], record => record.friendTargetIds = ['4'], record => record.animationOrder = Array(7).fill('4'), record => record.endJump.initialStudentId = '4', record => record.before.lastId = '4', record => record.mode = 'normal']) {
    const bad = C.clone(state); mutate(bad.history[0]); assert.throws(() => C.restoreState(bad), /友尽/);
  }
  const invalidDate = configured(), original = C.clone(invalidDate);
  assert.throws(() => C.draw(invalidDate, new Date(NaN)), /日期或时间无效/); assert.deepEqual(invalidDate, original);
  assert.throws(() => C.previewMode(invalidDate, new Date(NaN)), /日期或时间无效/); assert.deepEqual(invalidDate, original);
});
