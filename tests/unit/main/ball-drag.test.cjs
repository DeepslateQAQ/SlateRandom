'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBallDrag } = require('../../../src/main/ball-drag.cjs');
function fixture() {
  let bounds = { x: 100, y: 100, width: 76, height: 79 }, next = 0;
  const timers = new Map(), positions = [], ends = [];
  const win = { getBounds: () => ({ ...bounds }), isDestroyed: () => false, setPosition(x, y) { positions.push({ x, y }); bounds = { ...bounds, x, y }; }, setBounds() { throw Error('Touch movement must not resize the window'); } };
  const drag = createBallDrag({ getWindow: () => win,
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    schedule(fn) { const id = ++next;timers.set(id, fn);return id; }, cancel(id) { timers.delete(id); }, onEnd: cancelled => ends.push(cancelled) });
  return { drag, timers, positions, ends, frame() { const jobs = [...timers.values()];timers.clear();for (const job of jobs) job(); }, bounds: () => bounds };
}
test('a touch input burst moves the HWND once to the latest point without reapplying its size', () => {
  const t = fixture();t.drag.start({ id: 'touch-1' });
  for (let dx = 1; dx <= 120; dx++) t.drag.move({ id: 'touch-1', dx, dy: 30 });
  assert.equal(t.timers.size, 1);assert.equal(t.positions.length, 0);t.frame();
  assert.deepEqual(t.positions, [{ x: 220, y: 130 }]);assert.equal(t.bounds().height, 79);
  t.drag.move({ id: 'touch-1', dx: 120, dy: 30 });t.frame();assert.equal(t.positions.length, 1);
});
test('late frames and releases from a previous gesture cannot move or end a new touch', async () => {
  const t = fixture();t.drag.start({ id: 'old' });t.drag.move({ id: 'old', dx: 70, dy: 20 });
  t.drag.start({ id: 'new' });t.drag.move({ id: 'old', dx: -90, dy: -90 });await t.drag.end({ id: 'old' });
  t.frame();assert.equal(t.positions.length, 0);assert.equal(t.drag.id, 'new');
  t.drag.move({ id: 'new', dx: 20, dy: 10 });await t.drag.end({ id: 'new' });
  assert.deepEqual(t.positions, [{ x: 120, y: 110 }]);assert.deepEqual(t.ends, [false]);
});
test('pointer cancellation flushes one valid final point and is distinct from a release requiring snap', async () => {
  const t = fixture();t.drag.start({ id: 'cancel' });t.drag.move({ id: 'cancel', dx: -10, dy: 15 });
  await t.drag.end({ id: 'cancel', cancelled: true });t.frame();
  assert.deepEqual(t.positions, [{ x: 90, y: 115 }]);assert.deepEqual(t.ends, [true]);assert.equal(t.drag.active, false);
});
test('legacy QA drags stay compatible and out-of-screen input is constrained', async () => {
  const t = fixture();t.drag.start();t.drag.move({ dx: 3000, dy: 2000 });await t.drag.end();
  assert.deepEqual(t.positions, [{ x: 1844, y: 1001 }]);assert.deepEqual(t.ends, [false]);
});
