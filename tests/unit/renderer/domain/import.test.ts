import assert from 'node:assert/strict';
import { test } from 'node:test';
import engine from '../../../../src/renderer/domain/engine';
import { completeImportLayout, parseImportJson, prepareImport, prepareTextImport } from '../../../../src/renderer/domain/import';
import type { ReadyImportPlan } from '../../../../src/renderer/domain/import';
import type { ClassState, Student } from '../../../../src/shared/domain/model';

function configured(size = 8): ClassState {
  const students = Array.from({ length: size }, (_, index) => ({ id: String(index + 11), name: '学生' + (index + 1), row: Math.floor(index / 4) + 1, col: index % 4 + 1 }));
  const state = engine.createState(students, 6183);
  Object.assign(state.settings, { strategy: 'manual', manualMode: 'normal', friendEnabled: false, cooldown: 1, endJumpChance: 0 });
  return state;
}
function ready(plan: ReturnType<typeof prepareImport>): ReadyImportPlan {
  assert.equal(plan.kind, 'ready');
  if (plan.kind !== 'ready') throw new Error('Expected seat preview.');
  return plan;
}
const mapped = <T>(source: Partial<Record<string, T>>, mapping: Record<string, string>) => Object.fromEntries(Object.entries(source).map(([id, value]) => [mapping[id], value]));

test('missing model IDs are assigned in seat order, with empty seats consuming no IDs', () => {
  const plan = ready(prepareImport({ students: [
    { name: '丙', row: 2, col: 3 }, { name: '甲', row: 1, col: 1 },
    { name: '丁', id: '02', row: 2, col: 1 }, { name: '乙', row: 1, col: 3 }
  ] }, configured()));
  assert.deepEqual(Object.fromEntries(plan.students.map(student => [student.name, student.id])), { 丙: '4', 甲: '1', 丁: '2', 乙: '3' });
  assert.equal(plan.students.find(student => student.name === '甲')?.idSource, 'auto');
  assert.equal(plan.students.find(student => student.name === '丁')?.idSource, 'provided');
});

test('confirmed legacy IDs are retained by name, while explicit new IDs win', () => {
  const state = configured();
  const plan = ready(prepareImport({ students: state.students.map((student, index) => ({ name: student.name, ...(index === 0 ? { id: '61' } : {}) })) }, state));
  assert.equal(plan.students[0]?.id, '61');
  assert.equal(plan.students[1]?.id, '12');
  assert.deepEqual(plan.students.map(student => [student.row, student.col]), state.students.map(student => [student.row, student.col]));
  assert.equal(plan.identityMap['11'], '61');
  assert.ok(plan.warnings.some(warning => warning.includes('沿用')));
});

test('old automatic IDs are not treated as actual student numbers', () => {
  const state = configured(3);
  state.students.forEach(student => { student.idSource = 'auto'; });
  const plan = ready(prepareImport({ students: [...state.students].reverse().map(student => ({ name: student.name, row: student.row, col: student.col })) }, state));
  assert.deepEqual(Object.fromEntries(plan.students.map(student => [student.name, student.id])), { 学生3: '3', 学生2: '2', 学生1: '1' });
  assert.equal(plan.identityMap['11'], '1');
  assert.ok(plan.students.every(student => student.idSource === 'auto'));
});

test('a names-and-IDs update retains seats and cross-session draw/undo statistics', () => {
  const state = configured();
  for (let index = 0; index < 14; index++) engine.draw(state);
  const original = engine.clone(state);
  const plan = ready(prepareImport({ students: state.students.map((student, index) => ({ name: student.name, id: index + 101 })) }, state));
  const next = engine.replaceStudents(state, plan.students, plan.identityMap);
  assert.deepEqual(state, original);
  assert.equal(next.rngState, state.rngState); assert.equal(next.round, state.round);
  assert.deepEqual(next.fairnessStats, mapped(state.fairnessStats, plan.identityMap));
  assert.deepEqual(next.counts, mapped(state.counts, plan.identityMap));
  assert.deepEqual(next.lastSeen, mapped(state.lastSeen, plan.identityMap));
  assert.deepEqual(next.cycleSeen, state.cycleSeen.map(id => plan.identityMap[id]));
  assert.equal(next.lastId, plan.identityMap[state.lastId!]);
  assert.deepEqual(engine.restoreState(engine.clone(next)), next);
  engine.undo(next); engine.undo(original);
  assert.equal(next.rngState, original.rngState);
  assert.deepEqual(next.fairnessStats, mapped(original.fairnessStats, plan.identityMap));
});

test('an unmatched roster requests dimensions and is arranged by numeric ID', () => {
  const plan = prepareImport({ students: [{ name: '甲', id: '21' }, { name: '乙', id: '3' }, { name: '丙', id: '12' }] }, configured());
  assert.equal(plan.kind, 'layout'); if (plan.kind !== 'layout') return;
  const result = completeImportLayout(plan, { rows: 2, cols: 2 });
  assert.deepEqual(result.students.map(student => [student.id, student.row, student.col]), [['3', 1, 1], ['12', 1, 2], ['21', 2, 1]]);
  assert.equal(result.rows, 2); assert.equal(result.cols, 2);
});

test('explicit empty trailing seat rows survive backups and roster updates without changing legacy shapes', () => {
  const empty = engine.createEmptyState(123);
  assert.equal(Object.hasOwn(empty, 'seatRows'), false);
  const plan = prepareImport({ students: Array.from({ length: 4 }, (_, index) => ({ name: '新同学' + index, id: index + 1 })) }, empty);
  assert.equal(plan.kind, 'layout'); if (plan.kind !== 'layout') return;
  const layout = completeImportLayout(plan, { rows: 3, cols: 2 });
  const state = engine.createState(layout.students, 123);
  assert.equal(Object.hasOwn(engine.restoreState(state), 'seatRows'), false);
  state.cols = layout.cols; state.seatRows = layout.rows;
  const restored = engine.restoreState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored, state);
  assert.equal(restored.seatRows, 3);
  const matched = ready(prepareImport({ students: restored.students.map(student => ({ name: student.name, id: student.id })) }, restored));
  assert.equal(matched.rows, 3);
  assert.equal(engine.replaceStudents(restored, matched.students).seatRows, 3);
  const moved = restored.students.map((student, index) => index ? student : { ...student, row: 4 });
  assert.equal(engine.replaceStudents(restored, moved).seatRows, 4);
  for (const seatRows of [0, 1, 1.5, 51, null, undefined]) {
    assert.throws(() => engine.restoreState({ ...state, seatRows }), /座位行数/);
  }
  assert.equal(engine.restoreState({ ...empty, seatRows: 3 }).seatRows, 3);
  assert.throws(() => engine.restoreState({ ...empty, seatRows: 0 }), /座位行数/);
  assert.equal(Number.isFinite(engine.replaceStudents(empty, layout.students).cols), true);
});

test('insufficient dimensions and malformed coordinates never mutate class data', () => {
  const state = configured(), original = engine.clone(state);
  const plan = prepareImport({ students: [{ name: '甲', id: 1 }, { name: '乙', id: 2 }, { name: '丙', id: 3 }] }, state);
  assert.equal(plan.kind, 'layout'); if (plan.kind !== 'layout') return;
  assert.throws(() => completeImportLayout(plan, { rows: 1, cols: 2 }), /容量/);
  assert.throws(() => completeImportLayout(plan, { rows: 0, cols: 8 }), /行数/);
  assert.throws(() => prepareImport({ students: [{ name: '甲', id: 1, row: 1 }] }, state), /不完整/);
  assert.deepEqual(state, original);
});

test('duplicate names without confirmed IDs are flagged instead of guessed into old seats', () => {
  const state = configured(2);
  state.students.forEach(student => { student.name = '同名'; });
  const plan = prepareImport({ students: [{ name: '同名' }, { name: '同名' }] }, state);
  assert.equal(plan.kind, 'layout');
  assert.deepEqual(plan.identityMap, {});
  assert.ok(plan.warnings.some(warning => warning.includes('重名')));
});

test('duplicate normalized IDs and invasion of an omitted confirmed ID are rejected', () => {
  const state = configured();
  assert.throws(() => prepareImport({ students: [{ name: '甲', id: '01' }, { name: '乙', id: 1 }] }, state), /重复/);
  assert.throws(() => prepareImport({ students: [{ name: state.students[1]!.name, id: state.students[0]!.id }] }, state), /已属于/);
});

test('seat recognition retains podium warnings and removes only wholly empty axes', () => {
  const plan = ready(prepareImport(parseImportJson('```json\n' + JSON.stringify({ rows: 5, cols: 6,
    orientation: { normalized: false, podiumSideInImage: 'unknown' }, students: [
      { name: '甲', row: 2, col: 2 }, { name: '乙', row: 2, col: 4 }, { name: '丙', row: 4, col: 2 }, { name: '丁', row: 4, col: 5 }
    ] }) + '\n```'), configured()));
  assert.deepEqual(plan.students.map(student => [student.id, student.row, student.col]), [['1', 1, 1], ['2', 1, 2], ['3', 2, 1], ['4', 2, 3]]);
  assert.equal(plan.cols, 3);
  assert.ok(plan.warnings.some(warning => warning.includes('3 个全空行和 3 个全空列')));
  assert.ok(plan.warnings.some(warning => warning.includes('讲台方向')));
});

test('friend targets, historical sources, end jumps and cycle snapshots survive ID migration', () => {
  const state = configured();
  state.students.forEach(student => { student.friendTargets = state.students.filter(other => other !== student).map(other => other.id); });
  Object.assign(state.settings, { friendEnabled: true, friendChance: 100, endJumpChance: 100 });
  for (let index = 0; index < 25; index++) engine.draw(state, new Date(2026, 9, 14, 12, 34, 56), { endJump: true });
  assert.ok(state.history.some(record => record.mode === 'friend'));
  assert.ok(state.history.some(record => record.endJump));
  assert.ok(state.history.some(record => record.before?.cycleBefore));
  const plan = ready(prepareImport({ students: state.students.map((student, index) => ({ name: student.name, id: index + 201 })) }, state));
  const next = engine.replaceStudents(state, plan.students, plan.identityMap);
  assert.deepEqual(next.students[0]?.friendTargets, state.students[0]?.friendTargets?.map(id => plan.identityMap[id]));
  for (let index = 0; index < state.history.length; index++) {
    const old = state.history[index]!, current = next.history[index]!;
    assert.equal(current.studentId, plan.identityMap[old.studentId]);
    if (old.mode === 'friend' && current.mode === 'friend') {
      assert.equal(current.friendSourceId, plan.identityMap[old.friendSourceId]);
      assert.deepEqual(current.friendTargetIds, old.friendTargetIds.map(id => plan.identityMap[id]));
    }
    if (old.endJump) assert.equal(current.endJump?.initialStudentId, plan.identityMap[old.endJump.initialStudentId]);
    if (old.before?.cycleBefore) assert.deepEqual(current.before?.cycleBefore, old.before.cycleBefore.map(id => plan.identityMap[id]));
  }
  assert.deepEqual(engine.restoreState(next), next);
  const original = engine.clone(state);
  for (let index = 0; index < 10; index++) { engine.undo(next); engine.undo(original); }
  assert.equal(next.rngState, original.rngState);
  assert.deepEqual(next.fairnessStats, mapped(original.fairnessStats, plan.identityMap));
});

test('explicit swaps preserve the person attached to each statistic instead of following the number', () => {
  const state = configured(2);
  for (let index = 0; index < 5; index++) engine.draw(state);
  const plan = ready(prepareImport({ students: [
    { name: state.students[0]!.name, id: state.students[1]!.id }, { name: state.students[1]!.name, id: state.students[0]!.id }
  ] }, state));
  const next = engine.replaceStudents(state, plan.students, plan.identityMap);
  assert.deepEqual(next.fairnessStats['12'], state.fairnessStats['11']);
  assert.deepEqual(next.fairnessStats['11'], state.fairnessStats['12']);
});

test('preserving records keeps existing friend choices through renumbering and accepts only new students supplied targets', () => {
  const state = configured(3);
  state.students[0]!.friendTargets = [state.students[1]!.id, state.students[2]!.id];
  const plan = ready(prepareImport({ students: [
    { name: state.students[0]!.name, id: '21', row: 1, col: 1, friendTargets: ['23'] },
    { name: state.students[1]!.name, id: '22', row: 1, col: 2, friendTargets: ['21'] },
    { name: state.students[2]!.name, id: '23', row: 1, col: 3 },
    { name: '新增同学', id: '24', row: 1, col: 4, friendTargets: ['21'] }
  ] }, state));
  const next = engine.replaceStudents(state, plan.students, plan.identityMap);
  assert.deepEqual(next.students.find(student => student.id === '21')?.friendTargets, ['22', '23']);
  assert.deepEqual(next.students.find(student => student.id === '22')?.friendTargets ?? [], []);
  assert.deepEqual(next.students.find(student => student.id === '24')?.friendTargets, ['21']);
  assert.deepEqual(engine.restoreState(next), next);
});

test('quick names and explicit seated text still work; unseated supplied IDs request layout', () => {
  const state = configured();
  const quick = ready(prepareTextImport('甲\n乙\n丙', state, 2));
  assert.deepEqual(quick.students.map(student => [student.id, student.row, student.col]), [['1', 1, 1], ['2', 1, 2], ['3', 2, 1]]);
  const manual = ready(prepareTextImport('学号,姓名,行,列\n4,甲,2,3', state, 8));
  assert.deepEqual([manual.students[0]?.row, manual.students[0]?.col], [2, 3]);
  assert.equal(prepareTextImport('21,甲\n2,乙', state, 8).kind, 'layout');
  const provided: Student[] = engine.normalizeStudents([{ name: '甲', id: 1, row: 1, col: 1, idSource: 'auto' }]);
  assert.equal(engine.restoreState(engine.createState(provided)).students[0]?.idSource, 'auto');
});
