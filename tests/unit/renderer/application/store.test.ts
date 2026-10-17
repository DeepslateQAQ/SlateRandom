import test from 'node:test';
import assert from 'node:assert/strict';
import { isReactive, watch } from 'vue';
import engine from '../../../../src/renderer/domain/engine';
import type { ClassState } from '../../../../src/shared/domain/model';
import { createAppStore } from '../../../../src/renderer/application/store';

function configured(): ClassState {
  const state = engine.createState(Array.from({ length: 8 }, (_, index) => ({
    id: String(index + 1), name: '学生' + (index + 1), row: Math.floor(index / 4) + 1, col: index % 4 + 1
  })), 60713);
  Object.assign(state.settings, { strategy: 'manual', manualMode: 'normal', friendEnabled: false, endJumpChance: 0 });
  for (let round = 0; round < 5; round++) engine.draw(state, new Date(2026, 9, 14, 12, 34, 56));
  return state;
}

test('发布快照切断名单、历史、公平统计与随机状态的可变引用', () => {
  const domain = configured(), original = engine.clone(domain), store = createAppStore(domain);
  const initial = store.snapshot.value;
  assert.notEqual(initial.state, domain);
  assert.notEqual(initial.state.students, domain.students);
  assert.notEqual(initial.state.history, domain.history);
  assert.notEqual(initial.state.fairnessStats, domain.fairnessStats);
  assert.deepEqual(initial.state, domain);

  // Accidental presentation-side writes, including a draw on the copied state,
  // cannot corrupt the canonical command state or its next seeded decision.
  initial.state.students[0]!.name = '视图副本';
  engine.draw(initial.state, new Date(2026, 9, 14, 12, 34, 56));
  assert.deepEqual(domain, original);
  const expected = engine.clone(original);
  assert.deepEqual(engine.draw(domain, new Date(2026, 9, 14, 12, 34, 56)), engine.draw(expected, new Date(2026, 9, 14, 12, 34, 56)));

  store.publish({ ...initial, state: domain });
  const published = store.snapshot.value.state, saved = engine.clone(published);
  domain.students[0]!.name = '命令的后续变更';
  domain.history[0]!.name = '后续记录变更';
  const stats = Object.values(domain.fairnessStats).find(value => value !== undefined);
  assert.ok(stats); stats.draws += 10;
  assert.deepEqual(published, saved);
  assert.notEqual(published, initial.state);
});

test('切换 view、busy 与编辑元数据不会推进 PRNG 或改写累计统计', () => {
  const domain = configured(), original = engine.clone(domain), store = createAppStore(domain);
  const previous = store.snapshot.value;
  store.publish({ ...previous, state: domain, busy: true, view: 'history', swapMode: true,
    swapFirst: '1', modeError: '概率合计超过 100%', validationRevision: 1 });
  const next = store.snapshot.value;
  assert.equal(next.busy, true); assert.equal(next.view, 'history'); assert.equal(next.swapMode, true);
  assert.equal(next.swapFirst, '1'); assert.equal(next.validationRevision, 1);
  assert.equal(next.modeError, '概率合计超过 100%');
  assert.deepEqual(next.state, original); assert.deepEqual(domain, original);
  assert.equal(next.state.rngState, previous.state.rngState);
  assert.deepEqual(next.state.fairnessStats, previous.state.fairnessStats);
  assert.notEqual(next.state.fairnessStats, previous.state.fairnessStats);
  assert.equal(previous.busy, false); assert.equal(previous.view, 'dashboard');
});

test('保存错误与恢复阻塞独立于 busy，并在快照替换后继续发布', () => {
  const domain = configured(), store = createAppStore(domain);
  const initial = store.snapshot.value;
  assert.equal(initial.saveError, '');
  assert.equal(initial.recoveryRequired, false);

  store.publish({ ...initial, state: domain, saveError: '保存失败，请恢复全部数据', recoveryRequired: true });
  const failed = store.snapshot.value;
  assert.notEqual(failed, initial);
  assert.equal(failed.saveError, '保存失败，请恢复全部数据');
  assert.equal(failed.recoveryRequired, true);
  assert.equal(failed.busy, false);

  store.publish({ ...failed, state: domain, busy: true, view: 'data' });
  const busy = store.snapshot.value;
  assert.notEqual(busy, failed);
  assert.equal(busy.saveError, failed.saveError);
  assert.equal(busy.recoveryRequired, true);
  assert.equal(busy.busy, true);

  store.publish({ ...busy, state: domain, busy: false, view: 'roster' });
  const idle = store.snapshot.value;
  assert.notEqual(idle, busy);
  assert.equal(idle.saveError, failed.saveError);
  assert.equal(idle.recoveryRequired, true);
  assert.equal(idle.busy, false);

  store.publish({ ...idle, state: domain, saveError: '', recoveryRequired: false });
  assert.equal(store.snapshot.value.saveError, '');
  assert.equal(store.snapshot.value.recoveryRequired, false);
  assert.equal(store.snapshot.value.busy, false);
  assert.equal(failed.saveError, '保存失败，请恢复全部数据');
  assert.equal(failed.recoveryRequired, true);
  assert.deepEqual(store.snapshot.value.state, domain);
});

test('领域命令的多字段更新只在 publish 时触发一次 Vue 浅快照通知', () => {
  const domain = configured(), store = createAppStore(domain);
  const seenRounds: number[] = [], publications: number[] = [];
  const stopSnapshot = watch(() => store.snapshot.value, value => publications.push(value.state.round), { flush: 'sync' });
  const stopRound = watch(() => store.snapshot.value.state.round, value => seenRounds.push(value), { flush: 'sync' });
  try {
    assert.equal(isReactive(store.snapshot.value.state), false);
    const initialRound = domain.round;
    engine.draw(domain, new Date(2026, 9, 14, 12, 34, 56));
    assert.equal(store.snapshot.value.state.round, initialRound);
    assert.deepEqual(publications, []); assert.deepEqual(seenRounds, []);

    store.publish({ ...store.snapshot.value, state: domain, busy: true });
    assert.deepEqual(publications, [initialRound + 1]); assert.deepEqual(seenRounds, [initialRound + 1]);
    assert.notEqual(store.snapshot.value.state.history, domain.history);

    engine.draw(domain, new Date(2026, 9, 14, 12, 34, 56));
    assert.deepEqual(publications, [initialRound + 1]);
    assert.equal(store.snapshot.value.state.round, initialRound + 1);
    store.publish({ ...store.snapshot.value, state: domain, busy: false });
    assert.deepEqual(publications, [initialRound + 1, initialRound + 2]);
    assert.deepEqual(seenRounds, [initialRound + 1, initialRound + 2]);
  } finally { stopSnapshot(); stopRound(); }
});
