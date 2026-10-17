const test = require('node:test'), assert = require('node:assert/strict');
const { applyDesktopSettings } = require('../../../src/main/settings-update.cjs');
const previous = Object.freeze({ autostart: false, uac: false, uiAccess: false, autostartElevation: 'uac' });
const next = Object.freeze({ autostart: true, uac: true, uiAccess: false, autostartElevation: 'task' });

function fixture({ startup = 'ok', persist = 'ok', launch = 'ok', rollbackStartup = 'ok', rollbackPersist = 'ok', changeStartup = true, restart = true } = {}) {
  const calls = [];
  let native = previous, disk = previous;
  function result(mode, success) {
    if (mode === 'throw') throw Error('injected exception');
    if (mode === 'cancel') return { cancelled: true, error: 'injected cancellation' };
    if (mode === 'false') return { ok: false, started: false, error: 'injected refusal' };
    return success;
  }
  return {
    calls,
    get native() { return native; },
    get disk() { return disk; },
    run() {
      return applyDesktopSettings({ previous, next,
        applyStartup: !changeStartup ? null : async target => {
          calls.push(target === next ? 'startup-next' : 'startup-previous');
          const outcome = result(target === next ? startup : rollbackStartup, { ok: true });
          if (outcome.ok) native = target;
          return outcome;
        },
        persist: target => {
          calls.push(target === next ? 'persist-next' : 'persist-previous');
          if ((target === next ? persist : rollbackPersist) === 'throw') throw Error('injected disk failure');
          disk = target;
        },
        relaunch: !restart ? null : async target => {
          assert.equal(target, next);
          calls.push('relaunch');
          return result(launch, { started: true });
        }
      });
    }
  };
}

for (const changeStartup of [false, true]) for (const restart of [false, true]) {
  test(`success performs only required side effects: startup=${changeStartup}, relaunch=${restart}`, async () => {
    const state = fixture({ changeStartup, restart });
    assert.deepEqual(await state.run(), { started: restart, error: null });
    assert.deepEqual(state.calls, [...(changeStartup ? ['startup-next'] : []), 'persist-next', ...(restart ? ['relaunch'] : [])]);
    assert.equal(state.disk, next);
    assert.equal(state.native, changeStartup ? next : previous);
  });
}

for (const startup of ['false', 'throw', 'cancel']) {
  test(`startup ${startup} never persists, relaunches or compensates an unconfirmed side effect`, async () => {
    const state = fixture({ startup });
    if (startup === 'cancel') {
      const outcome = await state.run();
      assert.equal(outcome.started, false);
      assert.match(outcome.error, /injected cancellation/);
    } else await assert.rejects(state.run(), AggregateError);
    assert.deepEqual(state.calls, ['startup-next']);
    assert.equal(state.native, previous);
    assert.equal(state.disk, previous);
  });
}

for (const rollbackStartup of ['ok', 'false', 'throw', 'cancel']) {
  test(`failed forward persistence compensates only startup (${rollbackStartup})`, async () => {
    const state = fixture({ persist: 'throw', rollbackStartup });
    await assert.rejects(state.run(), error => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /injected disk failure/);
      assert.equal(error.errors.length, rollbackStartup === 'ok' ? 1 : 2);
      return true;
    });
    assert.deepEqual(state.calls, ['startup-next', 'persist-next', 'startup-previous']);
    assert.equal(state.disk, previous);
    assert.equal(state.native, rollbackStartup === 'ok' ? previous : next);
  });
}

for (const launch of ['throw', 'false', 'cancel']) {
  for (const rollbackStartup of ['ok', 'false', 'throw', 'cancel']) {
    for (const rollbackPersist of ['ok', 'throw']) {
      test(`relaunch=${launch}, startup compensation=${rollbackStartup}, preferences compensation=${rollbackPersist}`, async () => {
        const state = fixture({ launch, rollbackStartup, rollbackPersist });
        const errorCount = 1 + Number(rollbackStartup !== 'ok') + Number(rollbackPersist !== 'ok');
        if (launch === 'throw') {
          await assert.rejects(state.run(), error => {
            assert.ok(error instanceof AggregateError);
            assert.equal(error.errors.length, errorCount);
            if (rollbackStartup !== 'ok') assert.match(error.message, /自启动补偿失败/);
            if (rollbackPersist !== 'ok') assert.match(error.message, /桌面偏好补偿失败/);
            return true;
          });
        } else {
          const outcome = await state.run();
          assert.equal(outcome.started, false);
          assert.match(outcome.error, launch === 'cancel' ? /injected cancellation/ : /injected refusal/);
          if (rollbackStartup !== 'ok') assert.match(outcome.error, /自启动补偿失败/);
          if (rollbackPersist !== 'ok') assert.match(outcome.error, /桌面偏好补偿失败/);
        }
        assert.deepEqual(state.calls, ['startup-next', 'persist-next', 'relaunch', 'startup-previous', 'persist-previous']);
        assert.equal(state.native, rollbackStartup === 'ok' ? previous : next);
        assert.equal(state.disk, rollbackPersist === 'ok' ? previous : next);
      });
    }
  }
}

for (const launch of ['throw', 'false', 'cancel']) {
  test(`no startup mutation requires only preference compensation after relaunch ${launch}`, async () => {
    const state = fixture({ changeStartup: false, launch });
    if (launch === 'throw') await assert.rejects(state.run(), AggregateError);
    else assert.equal((await state.run()).started, false);
    assert.deepEqual(state.calls, ['persist-next', 'relaunch', 'persist-previous']);
    assert.equal(state.disk, previous);
  });
}

test('failed persistence without startup change has nothing to compensate', async () => {
  const state = fixture({ changeStartup: false, persist: 'throw' });
  await assert.rejects(state.run(), AggregateError);
  assert.deepEqual(state.calls, ['persist-next']);
  assert.equal(state.disk, previous);
});
