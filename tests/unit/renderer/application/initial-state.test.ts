import test from 'node:test';
import assert from 'node:assert/strict';
import engine from '../../../../src/renderer/domain/engine';
import { demoStudents } from '../../../../src/renderer/application/demo';
import { migrateAutomaticDemo } from '../../../../src/renderer/application/initial-state';

test('旧版自动演示名单移除，保留渲染偏好并可持久化空状态', () => {
  const state = engine.createState(demoStudents, 42);
  state.settings.renderStyle = 'overview';
  engine.draw(state);
  const empty = migrateAutomaticDemo(state);
  assert.deepEqual(empty.students, []);
  assert.deepEqual(empty.history, []);
  assert.equal(empty.settings.renderStyle, 'overview');
  assert.equal(empty.rngState, state.rngState);
  assert.deepEqual(engine.restoreState(empty), empty);
});

test('导入的同名名单和修改过的演示名单均保留原名单与累计统计', () => {
  const imported = engine.createState(demoStudents, 42);
  imported.demo = false;
  engine.draw(imported);
  assert.equal(migrateAutomaticDemo(imported), imported);
  const edited = engine.createState(demoStudents, 42);
  edited.students[0]!.name = '实际同学';
  engine.draw(edited);
  assert.equal(migrateAutomaticDemo(edited), edited);
  const empty = engine.createEmptyState();
  assert.equal(migrateAutomaticDemo(empty), empty);
});
