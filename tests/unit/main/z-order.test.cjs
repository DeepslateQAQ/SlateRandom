'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createZOrderKeeper } = require('../../../src/main/z-order.cjs');
function windowFixture(visible) {
  const calls = [];
  return { calls, isDestroyed: () => false, isVisible: () => visible,
    setAlwaysOnTop: (...args) => calls.push(['topmost', ...args]), moveTop: () => calls.push(['moveTop']) };
}
test('periodic Z-order refresh never activates or reveals hidden windows', () => {
  const main = windowFixture(true), ball = windowFixture(false);
  let tick, cancelled = 0;
  const keeper = createZOrderKeeper({ getWindows: () => ({ main, ball }),
    schedule(fn, ms) { tick = fn; assert.equal(ms, 1500); return 123; }, cancel(id) { assert.equal(id, 123); cancelled++; } });
  assert.deepEqual(main.calls, [['topmost', true, 'screen-saver'], ['moveTop']]);
  assert.deepEqual(ball.calls, [['topmost', true, 'screen-saver']]);
  tick(); assert.equal(main.calls.length, 4); assert.equal(ball.calls.length, 2);
  keeper.dispose(); keeper.dispose(); tick(); keeper.refresh();
  assert.equal(cancelled, 1); assert.equal(main.calls.length, 4);
});
test('one unavailable HWND cannot stop the floating ball refresh', () => {
  const ball = windowFixture(true), errors = [];
  const main = windowFixture(true); main.setAlwaysOnTop = () => { throw Error('window replaced'); };
  const keeper = createZOrderKeeper({ getWindows: () => ({ main, ball }), onError: error => errors.push(error.message),
    schedule: () => 1, cancel() {} });
  assert.deepEqual(errors, ['window replaced']);
  assert.deepEqual(ball.calls, [['topmost', true, 'screen-saver'], ['moveTop']]);
  keeper.dispose();
});
