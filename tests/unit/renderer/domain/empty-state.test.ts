import assert from 'node:assert/strict';
import { test } from 'node:test';
import engine from '../../../../src/renderer/domain/engine';
import { completeImportLayout, prepareImport } from '../../../../src/renderer/domain/import';

test('unconfigured state persists settings and seed without creating demo students or consuming PRNG', () => {
  const state = engine.createEmptyState(123);
  Object.assign(state.settings, { renderStyle: 'overview', directionMin: 4, directionMax: 9 });
  assert.equal(state.demo, false); assert.equal(state.className, '尚未配置名单');
  assert.equal(state.rngState, 123); assert.deepEqual(state.students, []);
  const restored = engine.restoreState(engine.clone(state));
  assert.deepEqual(restored, state);
  assert.deepEqual(engine.probabilities(restored), []);
  assert.throws(() => engine.draw(restored), /没有可参与/);
  assert.deepEqual(restored, state);
  assert.equal(engine.random(restored), engine.random(state));
});

test('empty backups cannot smuggle historical student references or statistics', () => {
  const empty = engine.createEmptyState(123);
  const invalid: Record<string, unknown>[] = [
    { history: [{ studentId: '1' }] }, { lock: { direction: 'left', remaining: 3 } },
    { lastId: '1' }, { counts: { '1': 0 } }, { lastSeen: { '1': 0 } },
    { fairnessStats: { '1': { draws: 0, positionSamples: 0, positionSum: 0 } } },
    { cycleSeen: ['1'] }, { round: 1 }, { directionCooldownRemaining: 1 }, { demo: true },
    { counts: [] }, { history: null }
  ];
  for (const patch of invalid) assert.throws(() => engine.restoreState({ ...empty, ...patch }), /备份/);
  assert.throws(() => engine.normalizeStudents([]), /名单/);
  assert.throws(() => engine.createState([]), /名单/);
  assert.throws(() => prepareImport({ students: [] }, empty), /students/);
});

test('the first unseated roster asks for dimensions instead of inheriting a sample classroom', () => {
  const empty = engine.createEmptyState(123), before = engine.clone(empty);
  const plan = prepareImport({ students: [{ name: '甲', id: '9' }, { name: '乙', id: '2' }] }, empty);
  assert.equal(plan.kind, 'layout'); if (plan.kind !== 'layout') return;
  assert.deepEqual(plan.identityMap, {});
  const ready = completeImportLayout(plan, { rows: 1, cols: 2 });
  assert.deepEqual(ready.students.map(student => [student.id, student.row, student.col]), [['2', 1, 1], ['9', 1, 2]]);
  assert.deepEqual(empty, before);
});
