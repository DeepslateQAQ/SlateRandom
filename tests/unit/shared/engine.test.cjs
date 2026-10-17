'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const C = require('../../../src/shared/domain/engine.js');
const roster = (n = 32, cols = 8) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), name: '学生' + (i + 1), row: Math.floor(i / cols) + 1, col: i % cols + 1, active: true }));
test('退役电影风格的会话与旧备份映射普通，保持名单、公平状态和随机序列', () => {
  const original=C.createState(roster(12,4),9477);original.settings=C.settings({strategy:'manual',manualMode:'normal',friendEnabled:false,endJumpChance:0});
  for(let i=0;i<4;i++)C.draw(original,new Date('2026-10-15T08:00:00Z'));
  for(const style of ['cinema','cinematic']){
    assert.equal(C.settings({renderStyle:style}).renderStyle,'normal');
    const legacy=C.clone(original);legacy.settings.renderStyle=style;
    const restored=C.restoreState(legacy);assert.deepEqual(restored,original);
    const next=C.clone(original);assert.deepEqual(C.draw(restored,new Date('2026-10-15T08:01:00Z')),C.draw(next,new Date('2026-10-15T08:01:00Z')));
    const empty=C.createEmptyState(77);empty.settings.renderStyle=style;assert.equal(C.restoreState(empty).settings.renderStyle,'normal');
  }
  assert.equal(C.settings({renderStyle:'overview'}).renderStyle,'overview');
});
test('32 人连续抽取 20000 轮，冷却窗口不重复，次数差保持在 2 以内', () => {
  const s = C.createState(roster(), 1099); s.settings.strategy = 'manual';
  let recent = [];
  for (let i = 0; i < 20000; i++) { const r = C.draw(s); assert.ok(!recent.includes(r.studentId)); recent.push(r.studentId); recent = recent.slice(-3); }
  const counts = s.students.map(p => s.counts[p.id]);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 2);
  assert.equal(counts.reduce((a, b) => a + b), 20000); assert.equal(s.history.length, 2000);
});
test('混合模式在日期固定时仍不会频繁抽中同一学号', () => {
  const s = C.createState(roster(), 123), date = new Date(2026, 9, 9, 12, 10, 12); const recent = [];
  for (let i = 0; i < 2000; i++) { const r = C.draw(s, date); assert.ok(!recent.slice(-3).includes(r.studentId)); recent.push(r.studentId); }
  assert.ok(Math.max(...Object.values(s.counts)) - Math.min(...Object.values(s.counts)) <= 2);
});
test('方向触发后锁定三轮，修改抽取策略不影响已经开始的接力', () => {
  const s = C.createState(roster(12, 4), 1); s.lastId = '1'; Object.assign(s.settings, { strategy: 'manual', manualMode: 'direction', direction: 'right', directionMin: 3, directionMax: 3, cooldown: 1 });
  assert.equal(C.draw(s).studentId, '2'); assert.equal(s.lock.remaining, 2);
  s.settings.manualMode = 'normal'; assert.equal(C.draw(s).studentId, '3'); assert.equal(C.draw(s).studentId, '4'); assert.equal(s.lock, null);
});
test('方向接力随机持续 3～5 轮，可复现且锁定期间不重新取轮数', () => {
  const lengths = new Set(), date = new Date(2026, 9, 10, 12, 34, 56);
  for (let seed = 1; seed <= 90; seed++) {
    const s = C.createState(roster(20, 20), seed); s.lastId = '1';
    Object.assign(s.settings, { strategy: 'manual', manualMode: 'direction', direction: 'right', directionRounds: 'random', directionCooldownMin: 0, directionCooldownMax: 0, cooldown: 1 });
    const twin = C.clone(s), first = C.draw(s, date);
    assert.deepEqual(C.draw(twin, date), first);
    assert.equal(first.studentId, '2'); assert.equal(first.fallback, false);
    const rounds = s.lock.remaining + 1, lockedRng = s.rngState;
    assert.ok(rounds >= 3 && rounds <= 5); lengths.add(rounds);
    Object.assign(s.settings, { manualMode: 'normal', directionMin: 5, directionMax: 5 });
    for (let step = 2; step <= rounds; step++) {
      const r = C.draw(s, date);
      assert.equal(r.mode, 'direction'); assert.equal(r.direction, 'right');
      assert.equal(r.studentId, String(step + 1)); assert.equal(r.fallback, false);
      assert.equal(s.rngState, lockedRng);
      assert.deepEqual(s.lock, step < rounds ? { direction: 'right', remaining: rounds - step } : null);
    }
    assert.equal(C.draw(s, date).mode, 'normal');
  }
  assert.deepEqual([...lengths].sort(), [3, 4, 5]);
});
test('随机方向的撤销恢复轮数与 PRNG，备份恢复后继续同一接力', () => {
  const s = C.createState(roster(20, 20), 17), date = new Date(2026, 9, 10, 12, 34, 56);
  s.lastId = '1'; Object.assign(s.settings, { strategy: 'manual', manualMode: 'direction', direction: 'right', directionRounds: 'random', cooldown: 1 });
  const before = C.clone(s), first = C.draw(s, date), firstLock = C.clone(s.lock);
  C.undo(s); assert.equal(s.rngState, before.rngState); assert.equal(s.lastId, '1'); assert.equal(s.lock, null);
  assert.deepEqual(C.draw(s, date), first); assert.deepEqual(s.lock, firstLock);
  const restored = C.restoreState(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(restored, s);
  const next = C.draw(s, date); assert.deepEqual(C.draw(restored, date), next);
  const after = C.clone(s.lock); C.undo(restored);
  assert.deepEqual(restored.lock, firstLock); assert.equal(restored.rngState, next.before.rngState);
  assert.deepEqual(C.draw(restored, date), next); assert.deepEqual(restored.lock, after);
});
test('方向遇到边界、空座、暂停座位和冷却邻座时不穿越', () => {
  for (const scenario of ['boundary', 'hole', 'paused', 'cooling']) {
    const s = C.createState(roster(8, 4), 1); Object.assign(s.settings, { strategy: 'manual', manualMode: 'direction', direction: 'right', cooldown: 1 }); s.lastId = scenario === 'boundary' ? '4' : '1';
    if (scenario === 'hole') s.students = s.students.filter(p => p.id !== '2');
    if (scenario === 'paused') s.students.find(p => p.id === '2').active = false;
    if (scenario === 'cooling') { s.history = [{ studentId: '2' }]; s.lastId = '2'; s.lock = { direction: 'left', remaining: 2 }; s.history = [{ studentId: '1' }, { studentId: '2' }]; s.settings.cooldown = 2; s.settings.direction = 'left'; }
    const r = C.draw(s); assert.notEqual(r.mode, 'direction'); assert.equal(r.switchedFrom, 'direction'); assert.equal(r.direction, null); assert.equal(s.lock, null);
  }
});
test('暂停上一位后仅选具有公平邻座的连坐起点，末尾改选与撤销也保留有效后继', () => {
  const date = new Date(2026, 9, 11, 12, 34, 56);
  for (let seed = 1; seed <= 32; seed++) {
    const s = C.createState(roster(9, 3), Math.imul(seed, 104729) >>> 0);
    s.settings = C.settings({ strategy: 'manual', manualMode: 'time', timeSelection: 'fixed', cooldown: 1, friendEnabled: false });
    assert.equal(C.draw(s, new Date(2026, 9, 11, 12, 34, 8)).studentId, '8');
    assert.equal(C.draw(s, new Date(2026, 9, 11, 12, 34, 3)).studentId, '3');
    s.settings = C.settings({ strategy: 'manual', manualMode: 'direction', direction: 'right', directionMin: 3, directionMax: 3, cooldown: 1, friendEnabled: false, endJumpChance: 100 });
    s.students.filter(student => ['3', '6', '9'].includes(student.id)).forEach(student => student.active = false);
    const eligible = new Set(C.probabilities(s).map(item => item.student.id)), before = C.clone(s);
    assert.deepEqual([...eligible], ['1', '2', '4', '5', '7']);
    assert.equal(C.adjacent(s, s.students.find(student => student.id === '7'), 'right').id, '8');
    assert.equal(C.previewMode(s, date), 'direction'); assert.deepEqual(s, before);
    const record = C.draw(s, date, { endJump: true });
    assert.equal(record.mode, 'direction'); assert.equal(record.direction, 'right');
    assert.ok(['1', '4'].includes(record.studentId)); assert.ok(['1', '4'].includes(record.endJump.initialStudentId));
    assert.notEqual(record.studentId, record.endJump.initialStudentId);
    const origin = s.students.find(student => student.id === record.studentId);
    assert.ok(eligible.has(C.adjacent(s, origin, record.direction).id));
    assert.deepEqual(s.lock, { direction: 'right', remaining: 2 });
    C.undo(s); assert.equal(s.rngState, before.rngState); assert.deepEqual(s.cycleSeen, before.cycleSeen); assert.equal(s.lock, null);
    assert.deepEqual(C.draw(s, date, { endJump: true }), record);
  }
});
test('按本地时间特定位精确匹配学号；冷却、学号缺失和 00 先更换有效取位', () => {
  const s = C.createState(roster(), 2); Object.assign(s.settings, { strategy: 'manual', manualMode: 'time', timeSelection: 'fixed' });
  const r = C.draw(s, new Date(2026, 9, 9, 14, 28, 12)); assert.equal(r.studentId, '12'); assert.equal(r.fallback, false);
  for (const seconds of [12, 59, 0]) {
    const date = new Date(2026, 9, 9, 14, 28, seconds), eligible = new Set(C.probabilities(s).map(p => p.student.id));
    const next = C.draw(s, date);
    if (next.mode === 'time') { assert.equal(next.timeRule.replacedPositions, '5,6'); assert.equal(next.timeRule.selection, 'random'); assert.ok(eligible.has(next.studentId)); assert.equal(next.studentId, String(next.timeRule.number)); }
    else { assert.equal(next.switchedFrom, 'time'); assert.equal(next.timeRule, null); }
  }
});
test('日期、时间和组合数字支持按位置顺序取位，拒绝越界和重复取位', () => {
  const d = new Date(2026, 9, 9, 14, 28, 12);
  assert.equal(C.extractNumber(d, 'date', '5,6,7,8').picked, '1009');
  assert.equal(C.extractNumber(d, 'time', '6,5').picked, '21');
  assert.equal(C.extractNumber(d, 'datetime', '13,14').number, 12);
  assert.throws(() => C.extractNumber(d, 'time', '7')); assert.throws(() => C.extractNumber(d, 'time', '5,5')); assert.throws(() => C.extractNumber(d, 'time', 'x'));
});
test('随机日期/时间每次取连续两位，覆盖所有合法起点并且可复现', () => {
  const date = new Date(2026, 9, 9, 14, 28, 12);
  for (const source of ['date', 'time', 'datetime']) {
    const digits = C.dateDigits(date, source), starts = new Set();
    for (let seed = 1; seed <= 128; seed++) {
      const s = C.createState(roster(99), seed);
      Object.assign(s.settings, { strategy: 'manual', manualMode: 'time', timeSource: source, timeSelection: 'random', positions: '99' });
      const twin = C.clone(s), r = C.draw(s, date), rule = r.timeRule;
      assert.deepEqual(C.draw(twin, date), r);
      assert.equal(rule.source, source); assert.equal(rule.selection, 'random'); assert.equal(rule.digits, digits);
      assert.equal(rule.positions.length, 2); assert.equal(rule.positions[1], rule.positions[0] + 1);
      assert.ok(rule.positions[0] >= 1 && rule.positions[1] <= digits.length);
      assert.equal(rule.picked, digits.slice(rule.positions[0] - 1, rule.positions[1]));
      assert.equal(rule.picked.length, 2); assert.equal(rule.number, Number(rule.picked));
      starts.add(rule.positions[0]);
      assert.ok(rule.number > 0); assert.equal(r.fallback, false); assert.equal(r.studentId, String(rule.number));
    }
    assert.deepEqual([...starts].sort((a, b) => a - b), Array.from({ length: digits.length - 1 }, (_, i) => i + 1).filter(i => Number(digits.slice(i - 1, i + 1)) > 0));
  }
});
test('随机两位抽取的撤销与备份恢复保留位置、结果及后续 PRNG 序列', () => {
  const date = new Date(2026, 9, 9, 14, 28, 12);
  for (const source of ['date', 'time', 'datetime']) {
    const s = C.createState(roster(), 21);
    Object.assign(s.settings, { strategy: 'manual', manualMode: 'time', timeSource: source, timeSelection: 'random' });
    const before = C.clone(s), first = C.draw(s, date);
    C.undo(s); assert.equal(s.rngState, before.rngState); assert.equal(s.round, 0); assert.equal(s.lastId, null);
    assert.deepEqual(C.draw(s, date), first);
    const restored = C.restoreState(JSON.parse(JSON.stringify(s)));
    assert.deepEqual(restored, s);
    for (let i = 0; i < 40; i++) assert.deepEqual(C.draw(restored, date), C.draw(s, date));
    const previous = C.clone(restored.history.at(-1)); C.undo(restored);
    assert.equal(restored.rngState, previous.before.rngState);
    assert.deepEqual(C.draw(restored, date), previous);
    assert.deepEqual(restored, s);
  }
});
test('随机取位只选有效位置，末两位无对应学号时仍覆盖其他可用起点', () => {
  const date = new Date(2026, 9, 11, 14, 59, 59), starts = new Set();
  for (let seed = 1; seed <= 128; seed++) {
    const s = C.createState(roster(47), seed);
    Object.assign(s.settings, { strategy: 'manual', manualMode: 'time', timeSelection: 'random', positions: '5,6' });
    const r = C.draw(s, date);
    assert.equal(r.mode, 'time'); assert.ok(['14', '45'].includes(r.studentId));
    assert.equal(r.studentId, String(r.timeRule.number)); assert.equal(r.fallback, false);
    starts.add(r.timeRule.positions[0]);
  }
  assert.deepEqual([...starts].sort(), [1, 2]);
});
test('时间取位先排除暂停、冷却、本轮已抽中与次数过高的学生', () => {
  const date = new Date(2026, 9, 11, 14, 28, 12);
  for (let seed = 1; seed <= 64; seed++) {
    const s = C.createState(roster(47), seed);
    Object.assign(s.settings, { strategy: 'manual', manualMode: 'time', timeSelection: 'random', cooldown: 1 });
    s.students.find(p => p.id === '14').active = false; s.counts['42'] = 4;
    s.lastId = '12'; s.cycleSeen = ['12']; s.history = [{ studentId: '12' }];
    const before = C.clone(s), options = C.timeOptions(s, date);
    assert.deepEqual(options.map(o => o.student.id), ['28']);
    assert.equal(C.previewMode(s, date), 'time'); assert.deepEqual(s, before);
    const r = C.draw(s, date); assert.equal(r.studentId, '28'); assert.deepEqual(r.timeRule.positions, [3, 4]);
  }
});
test('固定取位不可用或越界时改选有效两位，保留原配置与更换原因', () => {
  for (const positions of ['5,6', '99', '5,5']) {
    const s = C.createState(roster(47), 17), date = new Date(2026, 9, 11, 14, 59, 59);
    Object.assign(s.settings, { strategy: 'manual', manualMode: 'time', timeSelection: 'fixed', positions });
    const r = C.draw(s, date);
    assert.equal(r.mode, 'time'); assert.equal(r.timeRule.selection, 'random');
    assert.equal(r.timeRule.replacedPositions, positions); assert.equal(s.settings.positions, positions);
    assert.ok(r.reason.includes('改选有效连续两位')); assert.equal(r.studentId, String(r.timeRule.number));
    assert.deepEqual(C.restoreState(C.clone(s)), s);
  }
});
test('所有时间取位均无效时实际换为可用方向模式，不保留错误时间数字', () => {
  const s = C.createState(roster(3, 3), 7), date = new Date(2026, 9, 11, 23, 59, 59);
  Object.assign(s.settings, { strategy: 'manual', manualMode: 'time', modes: ['time', 'direction'], direction: 'right', directionMin: 3, directionMax: 3, cooldown: 1 });
  s.lastId = '1'; const before = C.clone(s);
  assert.deepEqual(C.timeOptions(s, date), []); assert.equal(C.previewMode(s, date), 'direction'); assert.deepEqual(s, before);
  const r = C.draw(s, date);
  assert.equal(r.mode, 'direction'); assert.equal(r.switchedFrom, 'time'); assert.equal(r.timeRule, null);
  assert.equal(r.studentId, '2'); assert.equal(r.direction, 'right'); assert.equal(r.fallback, false);
  const restored = C.restoreState(C.clone(s)); C.undo(restored);
  assert.equal(restored.rngState, before.rngState); assert.equal(restored.lastId, '1'); assert.equal(restored.lock, null);
  assert.deepEqual(C.draw(restored, date), r);
});
test('连坐全部方向不可用时解除锁定，换为可用时间模式并支持撤销', () => {
  const s = C.createState(roster(3, 3), 8), date = new Date(2026, 9, 11, 14, 28, 2);
  Object.assign(s.settings, { strategy: 'manual', manualMode: 'normal', modes: ['direction', 'time'], direction: 'right', cooldown: 1 });
  s.lastId = '3'; s.lock = { direction: 'right', remaining: 2 };
  const before = C.clone(s), r = C.draw(s, date);
  assert.equal(r.mode, 'time'); assert.equal(r.switchedFrom, 'direction'); assert.equal(r.studentId, '2');
  assert.equal(r.direction, null); assert.equal(s.lock, null); assert.equal(r.timeRule.number, 2);
  C.undo(s); assert.deepEqual(s.lock, before.lock); assert.equal(s.rngState, before.rngState);
  assert.deepEqual(C.draw(s, date), r);
});
test('只启用无法使用的模式时以普通随机接续，不循环尝试或额外增加记录', () => {
  for (const mode of ['time', 'direction']) {
    const s = C.createState(roster(1), 9), date = new Date(2026, 9, 11, 23, 59, 59);
    Object.assign(s.settings, { modes: [mode], direction: 'up', directionChance: mode === 'direction' ? 100 : 0, timeChance: mode === 'time' ? 100 : 0 });
    const before = C.clone(s); assert.equal(C.previewMode(s, date), 'normal'); assert.deepEqual(s, before);
    const r = C.draw(s, date);
    assert.equal(r.mode, 'normal'); assert.equal(r.switchedFrom, mode); assert.equal(r.timeRule, null); assert.equal(r.direction, null);
    assert.equal(r.studentId, '1'); assert.equal(s.round, 1); assert.equal(s.history.length, 1); assert.equal(s.lock, null);
    assert.deepEqual(C.restoreState(C.clone(s)), s);
  }
});
test('随机两位模式在固定日期/时间下保持冷却与动态次数均衡', () => {
  const date = new Date(2026, 9, 9, 14, 28, 12);
  for (const source of ['date', 'time', 'datetime']) {
    const s = C.createState(roster(), 104);
    Object.assign(s.settings, { strategy: 'manual', manualMode: 'time', timeSource: source, timeSelection: 'random' });
    const recent = [];
    for (let i = 0; i < 2000; i++) {
      const r = C.draw(s, date); assert.ok(!recent.slice(-3).includes(r.studentId)); recent.push(r.studentId);
    }
    const counts = s.students.map(p => s.counts[p.id] || 0);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 2);
    assert.equal(counts.reduce((a, b) => a + b), 2000);
  }
});
test('撤销恢复次数、冷却、接力和 PRNG，重抽产生相同结果', () => {
  const s = C.createState(roster(), 3); const before = C.clone(s); const first = C.draw(s, new Date(2026, 1, 1)); C.undo(s);
  assert.equal(s.rngState, before.rngState); assert.equal(s.round, 0); assert.equal(s.counts[first.studentId], 0);
  assert.deepEqual(C.draw(s, new Date(2026, 1, 1)), first);
});
test('单人名单可重复，多人名单不会连续重复；零参与人数拒绝抽取', () => {
  const single = C.createState(roster(1), 7); for (let i = 0; i < 10; i++) assert.equal(C.draw(single).studentId, '1');
  const pair = C.createState(roster(2), 7); let last;
  for (let i = 0; i < 100; i++) { const r = C.draw(pair); assert.notEqual(r.studentId, last); last = r.studentId; }
  pair.students.forEach(p => p.active = false); assert.throws(() => C.draw(pair));
});
test('暂停的人概率为零；概率每轮归一化，并向低次数的人倾斜', () => {
  const s = C.createState(roster(6), 9); s.students[5].active = false; s.counts['1'] = 1;
  const p = C.probabilities(s); assert.ok(Math.abs(p.reduce((a, b) => a + b.probability, 0) - 1) < 1e-10);
  assert.ok(!p.some(x => x.student.id === '6')); assert.ok(p.find(x => x.student.id === '2').probability > p.find(x => x.student.id === '1').probability);
});
test('支持按行姓名、显式学号、CSV 引号、空行和手动座位；拒绝重复学号和座位', () => {
  const s = C.parseRoster('张三\n2,李四\n\n王五', 2); assert.deepEqual(s.map(x => x.id), ['1', '2', '3']); assert.equal(s[2].row, 2);
  assert.equal(C.parseRoster('学号,姓名,行,列\n1,"名字,含逗号",2,3', 8)[0].name, '名字,含逗号');
  assert.throws(() => C.parseRoster('01,张三\n1,李四')); assert.throws(() => C.parseRoster('1,张三,1,1\n2,李四,1,1'));
});
test('识别 JSON 移除全空列，缺失学号分配并提示，重复坐标拒绝导入', () => {
  const result = C.parseVision('```json\n{"cols":4,"students":[{"name":"张三","row":1,"col":1},{"id":2,"name":"李四","row":1,"col":3}],"uncertain":["请核对李四"]}\n```');
  assert.equal(result.cols, 2); assert.equal(result.students[1].col, 2); assert.equal(result.students[0].id, '1'); assert.ok(result.warnings.includes('请核对李四')); assert.ok(result.warnings.some(w => w.includes('自动编号'))); assert.ok(result.warnings.some(w => w.includes('2 个全空列')));
  assert.throws(() => C.parseVision('{"students":[{"id":1,"name":"a","row":1,"col":1},{"id":2,"name":"b","row":1,"col":1}]}'));
});
test('识别结果移除边缘与内部全空行列，保留部分有人的行列中的单个空座', () => {
  const result = C.parseVision(JSON.stringify({ rows: 5, cols: 6, students: [{ id: 1, name: '甲', row: 2, col: 2 }, { id: 2, name: '乙', row: 2, col: 4 }, { id: 3, name: '丙', row: 4, col: 2 }, { id: 4, name: '丁', row: 4, col: 5 }] }));
  assert.equal(result.cols, 3); assert.deepEqual(result.students.map(s => [s.id, s.name, s.row, s.col]), [['1', '甲', 1, 1], ['2', '乙', 1, 2], ['3', '丙', 2, 1], ['4', '丁', 2, 3]]);
  assert.ok(result.warnings.some(w => w.includes('3 个全空行和 3 个全空列')));
  const again = C.parseVision(JSON.stringify({ cols: result.cols, students: result.students })); assert.deepEqual(again.students, result.students); assert.deepEqual(again.warnings, []);
});
test('识别方向不明时提醒核对；已标准化的讲台方向不重复旋转', () => {
  const data = { cols: 2, students: [{ id: 1, name: '甲', row: 1, col: 1 }, { id: 2, name: '乙', row: 2, col: 2 }], orientation: { podiumSideInImage: 'bottom', normalized: true } };
  const aligned = C.parseVision(JSON.stringify(data)); assert.equal(aligned.students[0].row, 1); assert.equal(aligned.students[0].col, 1); assert.deepEqual(aligned.warnings, []);
  data.orientation = { podiumSideInImage: 'unknown', normalized: false }; assert.ok(C.parseVision(JSON.stringify(data)).warnings.some(w => w.includes('讲台方向')));
});
test('备份往返保存随机生成器状态和历史；拒绝非法名单和统计', () => {
  const s = C.createState(roster(), 10); for (let i = 0; i < 10; i++) C.draw(s);
  const restored = C.restoreState(JSON.parse(JSON.stringify(s))); assert.deepEqual(restored, s);
  assert.equal(C.draw(restored).studentId, C.draw(s).studentId);
  assert.throws(() => C.restoreState(Object.assign({}, s, { version: 99 })));
  assert.throws(() => C.restoreState(Object.assign({}, s, { counts: { '1': -1 } })));
});
test('随机方向在锁定期间每轮重新选邻座方向，次数递减且可撤销复现', () => {
  const s = C.createState(roster(121, 11), 123); s.lastId = '61'; s.cycleSeen = ['61']; s.counts['61'] = 1; s.round = 1;
  Object.assign(s.settings, { strategy: 'manual', manualMode: 'direction', direction: 'auto', directionMin: 5, directionMax: 5, cooldown: 1 });
  const dirs = new Set(), date = new Date(2026, 9, 11, 12, 34, 56);
  for (let i = 0; i < 5; i++) {
    const previous = s.students.find(p => p.id === s.lastId), r = C.draw(s, date); dirs.add(r.direction);
    assert.equal(r.fallback, false); assert.equal(C.adjacent(s, previous, r.direction).id, r.studentId);
    assert.deepEqual(s.lock, i < 4 ? { direction: r.direction, remaining: 4 - i } : null);
    if (i === 2) { C.undo(s); assert.deepEqual(C.draw(s, date), r); }
  }
  assert.ok(dirs.size > 1, '连坐期间应实际发生方向变化');
  assert.deepEqual(C.restoreState(JSON.parse(JSON.stringify(s))), s);
});
test('每人轮满后下一次自动清空座位标记，保留上一位位置和累计历史，撤销可恢复整轮', () => {
  const s = C.createState(roster(4, 2), 23), date = new Date(2026, 9, 11, 12, 34, 56);
  Object.assign(s.settings, { strategy: 'manual', manualMode: 'normal', cooldown: 1 });
  for (let i = 0; i < 4; i++) C.draw(s, date);
  assert.equal(new Set(s.cycleSeen).size, 4); assert.ok(Object.values(s.counts).every(n => n === 1));
  const before = C.clone(s), record = C.draw(s, date);
  assert.deepEqual(s.cycleSeen, [record.studentId]); assert.equal(record.before.lastId, before.lastId);
  assert.equal(s.round, 5); assert.equal(s.history.length, 5); assert.equal(Object.values(s.counts).reduce((a, b) => a + b), 5);
  C.undo(s); assert.deepEqual(s, before); assert.deepEqual(C.draw(s, date), record);
  const restored = C.restoreState(JSON.parse(JSON.stringify(s))); assert.deepEqual(restored, s);
  const legacy = C.clone(before); delete legacy.cycleSeen; assert.equal(C.restoreState(legacy).cycleSeen.length, 4);
});
test('手动重置清除当前周期及抽取统计，保留名单设置和PRNG状态', () => {
  const s = C.createState(roster(4, 2), 29); C.draw(s); const students = C.clone(s.students), settings = C.clone(s.settings), rngState = s.rngState;
  C.reset(s); assert.deepEqual(s.cycleSeen, []); assert.deepEqual(s.counts, {}); assert.deepEqual(s.history, []); assert.equal(s.lastId, null); assert.equal(s.round, 0);
  assert.deepEqual(s.students, students); assert.deepEqual(s.settings, settings); assert.equal(s.rngState, rngState);
});
test('模型推断两位学号时保留核对提示和多个可能候选', () => {
  const result = C.parseVision(JSON.stringify({ students: [{ id: '12', name: '张三', row: 1, col: 1, sourceId: '2026080112', idBasis: '末两位' }, { id: null, name: '李四', row: 1, col: 2, idCandidates: ['21', '12'] }] }));
  assert.equal(result.students[0].id, '12'); assert.ok(result.warnings.some(w => w.includes('2026080112') && w.includes('候选 12'))); assert.ok(result.warnings.some(w => w.includes('21、12')));
});
test('备份拒绝损坏的时间取位记录，兼容缺少来源和选择方式的旧记录', () => {
  const date = new Date(2026, 9, 9, 14, 28, 12);
  for (const source of ['date', 'time', 'datetime']) {
    const s = C.createState(roster(), 19);
    Object.assign(s.settings, { strategy: 'manual', manualMode: 'time', timeSource: source, timeSelection: 'random' });
    C.draw(s, date); assert.deepEqual(C.restoreState(C.clone(s)), s);
    const legacy = C.clone(s);
    delete legacy.history[0].timeRule.source; delete legacy.history[0].timeRule.selection;
    const restored = C.restoreState(legacy);
    assert.deepEqual(restored.history[0].timeRule, legacy.history[0].timeRule);
    assert.deepEqual(C.draw(restored, date), C.draw(s, date));
  }
  const s = C.createState(roster(), 20);
  Object.assign(s.settings, { strategy: 'manual', manualMode: 'time', timeSelection: 'fixed' }); C.draw(s, date);
  const corruptions = [
    { digits: '<img src=x>' }, { digits: '1428120' }, { digits: '14281x' },
    { positions: null }, { positions: [] }, { positions: Array(13).fill(1) },
    { positions: [5, 5] }, { positions: [0, 6] }, { positions: [5, 7] },
    { positions: [5, 5.5] }, { positions: ['5', 6] },
    { picked: '99' }, { number: 99 }, { number: '12' },
    { source: 'unknown' }, { source: 'date' }, { source: 'datetime' }
  ];
  for (const patch of corruptions) {
    const invalid = C.clone(s); Object.assign(invalid.history[0].timeRule, patch);
    assert.throws(() => C.restoreState(invalid), /备份中日期／时间/, JSON.stringify(patch));
  }
});
test('备份拒绝非法方向对象和字符串，兼容旧记录的空方向', () => {
  const s = C.createState(roster(20, 20), 19);
  s.lastId = '1'; Object.assign(s.settings, { strategy: 'manual', manualMode: 'direction', direction: 'right', cooldown: 1 });
  C.draw(s, new Date(2026, 9, 11, 9, 30, 0));
  assert.equal(s.history[0].direction, 'right'); assert.deepEqual(C.restoreState(C.clone(s)), s);
  for (const direction of ['invalid', '', 'toString', 'constructor', '__proto__', {}, { direction: 'right' }, ['right'], 1, false]) {
    const invalid = C.clone(s); invalid.history[0].direction = direction;
    assert.throws(() => C.restoreState(invalid), /备份中方向记录无效/, JSON.stringify(direction));
  }
  const legacy = C.clone(s); legacy.history[0].direction = null;
  assert.equal(C.restoreState(legacy).history[0].direction, null);
  delete legacy.history[0].direction;
  assert.equal(C.restoreState(legacy).history[0].direction, undefined);
});
test('长期先后位置让常晚抽的人增权、常早抽的人减权，四轮先验平滑单次反馈', () => {
  const s = C.createState(roster(3), 101);
  s.fairnessStats = { '1': { draws: 20, positionSum: 0, positionSamples: 20 }, '2': { draws: 20, positionSum: 10, positionSamples: 20 }, '3': { draws: 20, positionSum: 20, positionSamples: 20 } };
  const before = C.clone(s), p = C.probabilities(s);
  assert.ok(p[2].probability > p[1].probability && p[1].probability > p[0].probability);
  assert.ok(Math.abs(p.reduce((sum, item) => sum + item.probability, 0) - 1) < 1e-12);
  assert.deepEqual(s, before, '计算概率不能改动统计或消耗 PRNG');
  s.fairnessStats = { '1': { draws: 1, positionSum: 0, positionSamples: 1 }, '2': { draws: 1, positionSum: 0.5, positionSamples: 1 }, '3': { draws: 1, positionSum: 1, positionSamples: 1 } };
  const first = C.probabilities(s);
  assert.ok(first[2].probability / first[0].probability < 1.5, '单次早晚极端值不应使权重骤变');
});
test('长期次数在当前计数相同与重置后仍补偿少抽的人，同时保留本轮未抽与冷却保护', () => {
  const s = C.createState(roster(4, 2), 102);
  s.fairnessStats = { '1': { draws: 4, positionSum: 2, positionSamples: 4 }, '2': { draws: 12, positionSum: 6, positionSamples: 12 }, '3': { draws: 20, positionSum: 10, positionSamples: 20 }, '4': { draws: 12, positionSum: 6, positionSamples: 12 } };
  const p = C.probabilities(s), lifetime = C.clone(s.fairnessStats);
  assert.ok(p[0].probability > p[1].probability && p[1].probability > p[2].probability);
  s.lastId = '1'; s.cycleSeen = ['1']; s.history = [{ studentId: '1' }]; s.settings.cooldown = 1;
  assert.ok(!C.probabilities(s).some(item => item.student.id === '1'));
  C.reset(s); assert.deepEqual(s.fairnessStats, lifetime);
  assert.deepEqual(C.probabilities(s), p);
  const restored = C.restoreState(C.clone(s)); assert.deepEqual(restored, s); assert.deepEqual(C.probabilities(restored), p);
});
test('位置统计按当前参与人数归一，自动换轮从零开始，缺勤不计入已抽位置', () => {
  const s = C.createState(roster(4, 2), 103); s.settings.strategy = 'manual';
  for (let i = 0; i < 4; i++) {
    const r = C.draw(s); assert.equal(r.fairnessPosition, i / 3);
    assert.deepEqual(s.fairnessStats[r.studentId], { draws: 1, positionSum: i / 3, positionSamples: 1 });
  }
  const before = C.clone(s), next = C.draw(s);
  assert.equal(next.fairnessPosition, 0); assert.deepEqual(next.before.fairnessStats, before.fairnessStats[next.studentId]);
  C.undo(s); assert.deepEqual(s, before);
  const paused = C.createState(roster(4, 2), 104); paused.settings.strategy = 'manual';
  paused.cycleSeen = ['1', '2']; paused.students[0].active = false;
  const r = C.draw(paused); assert.equal(r.fairnessPosition, 0.5);
  const single = C.createState(roster(1), 105); assert.equal(C.draw(single).fairnessPosition, 0.5);
});
test('长期公平统计跨存储、撤销、重置保留，撤销首次记录删除统计且重抽复现', () => {
  const s = C.createState(roster(8), 106), date = new Date(2026, 9, 12, 14, 28, 12);
  s.settings.strategy = 'manual'; const first = C.draw(s, date);
  assert.equal(first.before.fairnessStats, null); C.undo(s); assert.deepEqual(s.fairnessStats, {});
  assert.deepEqual(C.draw(s, date), first);
  for (let i = 0; i < 19; i++) C.draw(s, date);
  const restored = C.restoreState(C.clone(s)); assert.deepEqual(restored, s);
  const before = C.clone(restored), next = C.draw(restored, date); C.undo(restored);
  assert.deepEqual(restored, before); assert.deepEqual(C.draw(restored, date), next);
  const lifetime = C.clone(restored.fairnessStats); C.reset(restored); assert.deepEqual(restored.fairnessStats, lifetime);
  assert.deepEqual(C.restoreState(C.clone(restored)).fairnessStats, lifetime);
});
test('长期统计独立于 2000 条历史上限，截断后恢复及撤销不丢失早期次数', () => {
  const s = C.createState(roster(8), 107); s.settings.strategy = 'manual';
  for (let i = 0; i < 2010; i++) C.draw(s);
  assert.equal(s.history.length, 2000);
  assert.equal(Object.values(s.fairnessStats).reduce((sum, value) => sum + value.draws, 0), 2010);
  assert.equal(Object.values(s.fairnessStats).reduce((sum, value) => sum + value.positionSamples, 0), 2010);
  const restored = C.restoreState(C.clone(s)); assert.deepEqual(restored, s);
  const last = restored.history.at(-1), oldStats = C.clone(last.before.fairnessStats);
  C.undo(restored); assert.deepEqual(restored.fairnessStats[last.studentId], oldStats);
  assert.equal(Object.values(restored.fairnessStats).reduce((sum, value) => sum + value.draws, 0), 2009);
});
test('旧备份迁移可靠次数而不猜测早晚位置，迁移后的历史仍可撤销并继续累计', () => {
  const s = C.createState(roster(8), 108); s.settings.strategy = 'manual';
  for (let i = 0; i < 80; i++) C.draw(s);
  const legacy = C.clone(s); delete legacy.fairnessStats;
  legacy.history.forEach(record => { delete record.fairnessPosition; delete record.before.fairnessStats; });
  const restored = C.restoreState(legacy);
  for (const student of s.students) assert.deepEqual(restored.fairnessStats[student.id], { draws: s.counts[student.id], positionSum: 0, positionSamples: 0 });
  const previous = restored.history.at(-1); C.undo(restored);
  assert.equal(restored.fairnessStats[previous.studentId].draws, legacy.counts[previous.studentId] - 1);
  assert.equal(restored.fairnessStats[previous.studentId].positionSamples, 0);
  const next = C.draw(restored); assert.equal(restored.fairnessStats[next.studentId].positionSamples, 1);
  assert.deepEqual(C.restoreState(C.clone(restored)), restored);
  delete legacy.counts['1'];
  const missingCount = C.restoreState(legacy);
  assert.equal(missingCount.fairnessStats['1'].draws, legacy.history.filter(record => record.studentId === '1').length);
});
test('长期统计与周期位置严格校验，拒绝名单外学号及损坏的撤销快照', () => {
  const s = C.createState(roster(4), 109); C.draw(s);
  const id = s.history[0].studentId;
  const invalidStats = [null, [], {}, { draws: -1, positionSum: 0, positionSamples: 0 }, { draws: 1.5, positionSum: 0, positionSamples: 0 }, { draws: '1', positionSum: 0, positionSamples: 0 }, { draws: 1, positionSum: 0, positionSamples: 2 }, { draws: 1, positionSum: -0.1, positionSamples: 1 }, { draws: 1, positionSum: 1.1, positionSamples: 1 }, { draws: 1, positionSum: Infinity, positionSamples: 1 }, { draws: 1, positionSum: 0, positionSamples: 1, arbitrary: true }];
  for (const value of invalidStats) { const invalid = C.clone(s); invalid.fairnessStats[id] = value; assert.throws(() => C.restoreState(invalid), /长期公平统计/); }
  for (const container of [null, [], 'invalid']) assert.throws(() => C.restoreState(Object.assign(C.clone(s), { fairnessStats: container })), /长期公平统计/);
  const dangling = C.clone(s); dangling.fairnessStats['99'] = { draws: 1, positionSum: 0.5, positionSamples: 1 };
  assert.throws(() => C.restoreState(dangling), /名单外学号/);
  for (const value of [-0.1, 1.1, '0.5', Infinity]) { const invalid = C.clone(s); invalid.history[0].fairnessPosition = value; assert.throws(() => C.restoreState(invalid), /周期先后位置/); }
  const snapshot = C.clone(s); snapshot.history[0].before.fairnessStats = { draws: 0, positionSum: 1, positionSamples: 1 };
  assert.throws(() => C.restoreState(snapshot), /长期公平统计/);
});
test('时间模式先按唯一学生分配权重，同学号出现两次取位不会获得双倍概率', () => {
  const date = new Date(2026, 9, 12, 14, 28, 14), hits = { '14': 0, '28': 0, '42': 0 }, positions = new Set();
  for (let seed = 1; seed <= 1500; seed++) {
    const s = C.createState(roster(47), seed); Object.assign(s.settings, { strategy: 'manual', manualMode: 'time', timeSelection: 'random' });
    const record = C.draw(s, date); assert.equal(record.mode, 'time'); hits[record.studentId]++;
    if (record.studentId === '14') positions.add(record.timeRule.positions[0]);
  }
  for (const n of Object.values(hits)) assert.ok(n > 400 && n < 600, JSON.stringify(hits));
  assert.deepEqual([...positions].sort(), [1, 5]);
});
test('时间与方向的可选候选也使用长期早晚权重，单一固定方向不额外消耗 PRNG', () => {
  const date = new Date(2026, 9, 12, 14, 28, 14), timeHits = { '14': 0, '28': 0, '42': 0 }, directionHits = { '2': 0, '4': 0, '6': 0, '8': 0 };
  for (let seed = 1; seed <= 500; seed++) {
    const t = C.createState(roster(47), seed);
    t.students.forEach(student => { t.fairnessStats[student.id] = { draws: 20, positionSum: student.id === '28' ? 20 : 0, positionSamples: 20 }; });
    Object.assign(t.settings, { strategy: 'manual', manualMode: 'time' }); timeHits[C.draw(t, date).studentId]++;
    const d = C.createState(roster(9, 3), seed); d.lastId = '5';
    d.students.forEach(student => { d.fairnessStats[student.id] = { draws: 20, positionSum: student.id === '2' ? 20 : 0, positionSamples: 20 }; });
    Object.assign(d.settings, { strategy: 'manual', manualMode: 'direction', directionMin: 3, directionMax: 3 }); directionHits[C.draw(d, date).studentId]++;
  }
  assert.ok(timeHits['28'] > timeHits['14'] && timeHits['28'] > timeHits['42'], JSON.stringify(timeHits));
  for (const id of ['4', '6', '8']) assert.ok(directionHits['2'] > directionHits[id], JSON.stringify(directionHits));
  const fixed = C.createState(roster(12, 12), 110); fixed.lastId = '1';
  Object.assign(fixed.settings, { strategy: 'manual', manualMode: 'direction', direction: 'right', directionMin: 3, directionMax: 3 });
  const seed = fixed.rngState; assert.equal(C.draw(fixed).studentId, '2'); assert.equal(fixed.rngState, seed);
});
test('连坐自定义最小最大轮数包含端点，单轮及锁定中改范围不会重置既有链', () => {
  const date = new Date(2026, 9, 12, 14, 28, 14), lengths = new Set();
  for (let seed = 1; seed <= 100; seed++) {
    const s = C.createState(roster(20, 20), seed); s.lastId = '1';
    Object.assign(s.settings, { strategy: 'manual', manualMode: 'direction', direction: 'right', directionMin: 2, directionMax: 7, directionCooldownMin: 0, directionCooldownMax: 0, cooldown: 1 });
    const before = C.clone(s), first = C.draw(s, date), length = s.lock.remaining + 1;
    assert.ok(length >= 2 && length <= 7); lengths.add(length);
    C.undo(s); assert.equal(s.rngState, before.rngState); assert.deepEqual(C.draw(s, date), first);
    Object.assign(s.settings, { directionMin: 1, directionMax: 1 });
    for (let i = 1; i < length; i++) { assert.equal(C.draw(s, date).studentId, String(i + 2)); assert.equal(s.lock?.remaining || 0, length - i - 1); }
    assert.equal(C.draw(s, date).mode, 'direction'); assert.equal(s.lock, null);
  }
  assert.deepEqual([...lengths].sort((a, b) => a - b), [2, 3, 4, 5, 6, 7]);
  const single = C.createState(roster(3, 3), 111); single.lastId = '1';
  Object.assign(single.settings, { strategy: 'manual', manualMode: 'direction', direction: 'right', directionMin: 1, directionMax: 1, directionCooldownMin: 0, directionCooldownMax: 0 });
  const seed = single.rngState; assert.equal(C.draw(single).studentId, '2'); assert.equal(single.lock, null); assert.equal(single.rngState, seed);
});
test('连坐旧设置迁移为新范围，大于十轮可跨备份续接，无效备份范围拒绝', () => {
  for (const rounds of ['random', 3, 4, 5]) {
    const s = C.createState(roster(4), 112); delete s.settings.directionMin; delete s.settings.directionMax; s.settings.directionRounds = rounds;
    const migrated = C.restoreState(s); assert.equal(migrated.settings.directionMin, rounds === 'random' ? 3 : rounds); assert.equal(migrated.settings.directionMax, rounds === 'random' ? 5 : rounds); assert.equal(migrated.settings.directionRounds, 'random');
  }
  const s = C.createState(roster(40, 20), 113); s.lastId = '1';
  Object.assign(s.settings, { strategy: 'manual', manualMode: 'direction', direction: 'right', directionMin: 15, directionMax: 15 }); C.draw(s);
  assert.equal(s.lock.remaining, 14); const restored = C.restoreState(C.clone(s)); assert.deepEqual(restored, s); assert.equal(C.draw(restored).studentId, '3'); assert.equal(restored.lock.remaining, 13);
  for (const range of [[0, 5], [3, 51], [3.5, 5], [7, 2], [null, 5], [3, undefined]]) {
    const invalid = C.clone(s); [invalid.settings.directionMin, invalid.settings.directionMax] = range;
    assert.throws(() => C.restoreState(invalid), /连坐/);
  }
  const normalized = C.settings({ directionMin: -4, directionMax: 100 }); assert.equal(normalized.directionMin, 1); assert.equal(normalized.directionMax, 50);
});

function rosterMigrationHistory(seconds) {
  const state = C.createState(roster(3, 3), 7);
  state.settings = C.settings({ strategy: 'manual', manualMode: 'time', timeSource: 'time', timeSelection: 'fixed', positions: '5,6', cooldown: 1, friendEnabled: false, endJumpChance: 0 });
  for (const second of seconds) {
    const record = C.draw(state, new Date(2026, 9, 14, 12, 0, second));
    assert.equal(record.mode, 'time');
    assert.equal(record.studentId, String(second));
  }
  return state;
}

function assertMigrationUndoBlocked(state) {
  const before = C.clone(state);
  assert.throws(() => C.undo(state));
  assert.deepEqual(state, before);
}

test('移除友尽来源后保留目标累计统计，旧日志不能撤销，新抽取可精确撤回', () => {
  const state = rosterMigrationHistory([2, 3, 1]);
  state.students[0].friendTargets = ['2'];
  Object.assign(state.settings, { friendEnabled: true, friendChance: 100 });
  const friend = C.draw(state, new Date(2026, 9, 14, 12, 0, 4));
  assert.equal(friend.mode, 'friend'); assert.equal(friend.studentId, '2'); assert.equal(friend.friendSourceId, '1');
  const original = C.clone(state);
  const migrated = C.replaceStudents(state, state.students.filter(student => student.id !== '1'));
  assert.deepEqual(state, original);
  assert.equal(migrated.round, 4);
  assert.equal(migrated.counts['2'], 2); assert.equal(migrated.fairnessStats['2'].draws, 2);
  assert.deepEqual(migrated.history.map(record => record.round), [1, 2]);
  assert.ok(migrated.history.every(record => record.before === null));
  assertMigrationUndoBlocked(migrated);
  const beforeDraw = C.clone(migrated);
  C.draw(migrated, new Date(2026, 9, 14, 12, 0, 5));
  C.undo(migrated);
  assert.deepEqual(migrated, beforeDraw);
  assertMigrationUndoBlocked(migrated);
});

test('名单迁移遇到多个中间缺口时，仅最新缺口之后的记录可撤销', () => {
  const state = rosterMigrationHistory([2, 1, 3, 2, 1, 3]);
  const migrated = C.replaceStudents(state, state.students.filter(student => student.id !== '1'));
  assert.deepEqual(migrated.history.map(record => record.round), [1, 3, 4, 6]);
  assert.ok(migrated.history.slice(0, -1).every(record => record.before === null));
  assert.ok(migrated.history.at(-1).before);
  assert.equal(C.undo(migrated).round, 6);
  assert.equal(migrated.round, 5);
  assert.equal(migrated.counts['3'], 1); assert.equal(migrated.fairnessStats['3'].draws, 1);
  assertMigrationUndoBlocked(migrated);
});

test('移除最新抽中者后，保留的旧日志不再能覆盖迁移后的统计', () => {
  const state = rosterMigrationHistory([2, 3, 1]);
  const migrated = C.replaceStudents(state, state.students.filter(student => student.id !== '1'));
  assert.deepEqual(migrated.history.map(record => record.studentId), ['2', '3']);
  assert.equal(migrated.round, 3); assert.equal(migrated.lastId, null);
  for (const id of ['2', '3']) {
    assert.equal(migrated.counts[id], 1); assert.equal(migrated.fairnessStats[id].draws, 1);
  }
  assert.ok(migrated.history.every(record => record.before === null));
  assertMigrationUndoBlocked(migrated);
});

test('纯改学号不设撤销边界，逐轮撤销与先撤销再迁移一致', () => {
  const state = rosterMigrationHistory([2, 3, 1]);
  const students = state.students.map(student => Object.assign({}, student, { id: String(Number(student.id) + 10) }));
  const migrated = C.replaceStudents(state, students, { '1': '11', '2': '12', '3': '13' });
  assert.deepEqual(migrated.history.map(record => record.studentId), ['12', '13', '11']);
  assert.ok(migrated.history.every(record => record.before));
  for (let i = 0; i < 3; i++) {
    C.undo(state); C.undo(migrated);
    assert.deepEqual(migrated, C.replaceStudents(state, students));
  }
  assert.equal(C.undo(migrated), null);
});

test('外观设置归一化：主题、主题色、圆角与自定义 CSS', () => {
  for (const theme of ['classic', 'light', 'dark', 'system']) assert.equal(C.settings({ theme }).theme, theme);
  for (const theme of ['sepia', '', null, 42, undefined]) assert.equal(C.settings({ theme }).theme, 'system');
  assert.equal(C.settings({ accent: '#ABC' }).accent, '#aabbcc');
  assert.equal(C.settings({ accent: ' #12EF56 ' }).accent, '#12ef56');
  for (const accent of ['red', '#12', '#12345', '#gggggg', '', null]) assert.equal(C.settings({ accent }).accent, '#65dc99');
  const radius = value => C.settings({ radius: value }).radius;
  assert.equal(radius(-5), 0); assert.equal(radius(0), 0); assert.equal(radius(8), 8);
  assert.equal(radius(16), 16); assert.equal(radius(25), 16); assert.equal(radius(7.6), 8);
  for (const value of [null, '', undefined, 'x', NaN]) assert.equal(radius(value), 8);
  assert.equal(C.settings({ customCss: 'a\u0000b' }).customCss, 'ab');
  assert.equal(C.settings({ customCss: 'x'.repeat(16385) }).customCss.length, 16384);
  assert.equal(C.settings({ customCss: 42 }).customCss, '');
  assert.equal(C.settings({ customCssEnabled: true }).customCssEnabled, true);
  assert.equal(C.settings({ customCssEnabled: 'true' }).customCssEnabled, false);
  assert.equal(C.settings({ backgroundTint: true }).backgroundTint, true);
  for (const value of [false, 'true', 1, null]) assert.equal(C.settings({ backgroundTint: value }).backgroundTint, false);
});

test('外观设置随状态创建、备份恢复往返，旧状态得到默认值', () => {
  const state = C.createState(roster(4, 4), 5);
  assert.deepEqual(
    { theme: state.settings.theme, accent: state.settings.accent, radius: state.settings.radius, customCss: state.settings.customCss, customCssEnabled: state.settings.customCssEnabled, backgroundTint: state.settings.backgroundTint },
    { theme: 'system', accent: '#65dc99', radius: 8, customCss: '', customCssEnabled: false, backgroundTint: false }
  );
  Object.assign(state.settings, { theme: 'dark', accent: '#aabbcc', radius: 0, customCss: ':root{--x:1}', customCssEnabled: true, backgroundTint: true });
  const restored = C.restoreState(C.clone(state));
  assert.deepEqual(restored.settings, state.settings);
  const legacy = C.clone(state);
  delete legacy.settings.theme; delete legacy.settings.accent; delete legacy.settings.radius;
  delete legacy.settings.customCss; delete legacy.settings.customCssEnabled; delete legacy.settings.backgroundTint;
  const upgraded = C.restoreState(legacy).settings;
  assert.equal(upgraded.theme, 'system'); assert.equal(upgraded.accent, '#65dc99');
  assert.equal(upgraded.radius, 8); assert.equal(upgraded.customCss, ''); assert.equal(upgraded.customCssEnabled, false);
  assert.equal(upgraded.backgroundTint, false);
});

test('缺口之后的连续尾部按原顺序保留并逐轮撤销，但不能越过缺口', () => {
  const state = rosterMigrationHistory([2, 3, 1, 2, 3]);
  const migrated = C.replaceStudents(state, state.students.filter(student => student.id !== '1'));
  assert.deepEqual(migrated.history.map(record => record.round), [1, 2, 4, 5]);
  assert.ok(migrated.history.slice(0, 2).every(record => record.before === null));
  assert.ok(migrated.history.slice(2).every(record => record.before));
  assert.equal(C.undo(migrated).round, 5);
  assert.equal(migrated.round, 4);
  assert.equal(migrated.counts['3'], 1); assert.equal(migrated.fairnessStats['3'].draws, 1);
  assert.equal(C.undo(migrated).round, 4);
  assert.equal(migrated.round, 3);
  assert.equal(migrated.counts['2'], 1); assert.equal(migrated.fairnessStats['2'].draws, 1);
  assertMigrationUndoBlocked(migrated);
});
