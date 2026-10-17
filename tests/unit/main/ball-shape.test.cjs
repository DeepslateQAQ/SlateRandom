'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ballShape } = require('../../../src/main/ball-shape.cjs');

function contains(rects, x, y) {
  return rects.some(r => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height);
}
function assertWithin(rects, width, height) {
  for (const r of rects) {
    assert.ok([r.x, r.y, r.width, r.height].every(Number.isInteger));
    assert.ok(r.x >= 0 && r.y >= 0 && r.width >= 0 && r.height >= 0);
    assert.ok(r.x + r.width <= width && r.y + r.height <= height);
  }
}

test('undocked ball keeps its full 64 px circle and excludes transparent corners and padding', () => {
  const region = ballShape();
  for (const point of [[38, 40], [6, 40], [69, 40], [38, 8], [38, 71]])
    assert.equal(contains(region, ...point), true, 'visible circle at ' + point);
  for (const point of [[0, 40], [75, 40], [6, 8], [69, 8], [38, 7], [38, 72]])
    assert.equal(contains(region, ...point), false, 'transparent area at ' + point);
  const area = region.reduce((sum, r) => sum + r.width * r.height, 0);
  assert.ok(area > 3150 && area < 3300, 'region approximates the circle rather than its rectangular bounds');
  assertWithin(region, 76, 80);
});

test('docked sides connect to the exact viewport edge and leave the opposite corners open', () => {
  const left = ballShape({ snap: 'left' }), right = ballShape({ snap: 'right' });
  for (let y = 8; y < 72; y++) {
    assert.equal(contains(left, 0, y), true);
    assert.equal(contains(right, 75, y), true);
  }
  assert.equal(contains(left, 69, 8), false);
  assert.equal(contains(right, 6, 8), false);
  for (let y = 0; y < 80; y++) for (let x = 0; x < 76; x++)
    assert.equal(contains(left, x, y), contains(right, 75 - x, y), 'docked regions mirror each other');
});

test('confirmation uses the full capsule and keeps both confirmation controls inside the input region', () => {
  for (const snap of ['none', 'left', 'right']) {
    const region = ballShape({ width: 348, height: 80, snap, confirming: true });
    for (const x of [38, 100, 174, 250, 310]) assert.equal(contains(region, x, 40), true);
    assert.equal(contains(region, snap === 'left' ? 0 : 347, 40), snap !== 'none');
    assert.equal(contains(region, 174, 7), false);
    assert.equal(contains(region, 174, 72), false);
    if (snap === 'none') {
      assert.equal(contains(region, 6, 8), false);
      assert.equal(contains(region, 341, 8), false);
    }
    assertWithin(region, 348, 80);
  }
});

test('regions follow actual viewport height and clip safely while width or height changes', () => {
  const compact = ballShape({ width: 76, height: 76 });
  assert.equal(contains(compact, 38, 6), true);
  assert.equal(contains(compact, 38, 5), false);
  assert.equal(contains(compact, 38, 69), true);
  assert.equal(contains(compact, 38, 70), false);
  for (const width of [20, 64, 76, 100, 220, 348, 420])
    for (const height of [1, 48, 76, 79, 80, 100])
      for (const snap of ['none', 'left', 'right'])
        for (const confirming of [false, true]) {
          const region = ballShape({ width, height, snap, confirming });
          assert.ok(region.length > 0);
          assertWithin(region, width, height);
        }
});

test('changing width preserves left/right anchoring and undocked padding', () => {
  assert.equal(contains(ballShape({ width: 100, snap: 'left' }), 0, 40), true);
  assert.equal(contains(ballShape({ width: 100, snap: 'right' }), 99, 40), true);
  const plain = ballShape({ width: 100 });
  assert.equal(contains(plain, 6, 40), true);
  assert.equal(contains(plain, 69, 40), true);
  assert.equal(contains(plain, 70, 40), false);
});

test('identical consecutive scanlines are coalesced without overlap', () => {
  const region = ballShape({ width: 348, confirming: true });
  assert.ok(region.length < 64);
  let previous;
  for (const r of region) {
    if (previous) {
      assert.ok(r.y >= previous.y + previous.height);
      assert.ok(r.y !== previous.y + previous.height || r.x !== previous.x || r.width !== previous.width);
    }
    previous = r;
  }
});

test('empty and invalid viewports never accidentally return the full-rectangle reset command', () => {
  const tiny = ballShape({ width: 1, height: 1 });
  assert.deepEqual(tiny, [{ x: 0, y: 0, width: 0, height: 0 }]);
  assert.equal(contains(tiny, 0, 0), false);
  for (const value of [0, -1, NaN, Infinity, 1.5, '76'])
    assert.throws(() => ballShape({ width: value }), /positive integers/);
  assert.throws(() => ballShape({ snap: 'top' }), /shape state/);
  assert.throws(() => ballShape({ confirming: 'yes' }), /shape state/);
});
