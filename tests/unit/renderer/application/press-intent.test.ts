import test from 'node:test';
import assert from 'node:assert/strict';
import { pressIntent } from '../../../../src/renderer/application/press-intent.ts';

test('pointer and keyboard boundaries use real time, including exactly 200 and 500 ms', () => {
  for (const time of [0, 99, 150, 199.99]) assert.equal(pressIntent(time), 'draw');
  for (const time of [200, 250, 499.99]) assert.equal(pressIntent(time), 'cancel');
  assert.equal(pressIntent(500), 'configure');
  assert.equal(pressIntent(800), 'configure');
});
test('cancelled gestures never draw; a fired hold never fires twice on release', () => {
  assert.equal(pressIntent(100, true), 'cancel');
  assert.equal(pressIntent(600, true, true), 'cancel');
  assert.equal(pressIntent(499, false, true), 'configure');
});
