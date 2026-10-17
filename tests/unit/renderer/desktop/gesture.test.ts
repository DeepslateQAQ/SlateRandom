import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BallDragSession, BallGesture, BALL_HOLD_MS, resolvePointerPoint } from '../../../../src/renderer/desktop/gesture';
import type { DesktopDrag, DesktopDragEnd, DesktopDragStart } from '../../../../src/renderer/desktop/types';

test('short stationary press opens the window once', () => {
  const gesture = new BallGesture();
  gesture.begin({ x: 30, y: 40 }, 10);
  assert.equal(gesture.release(), 'click');
  assert.equal(gesture.release(), 'none');
});

test('a hold requires three complete seconds and consumes release', () => {
  const gesture = new BallGesture();
  gesture.begin({ x: 30, y: 40 }, 25);
  assert.equal(gesture.confirm(25 + BALL_HOLD_MS - 1), false);
  assert.equal(gesture.confirm(25 + BALL_HOLD_MS), true);
  assert.equal(gesture.confirm(25 + BALL_HOLD_MS + 20), false);
  assert.equal(gesture.release(), 'none');
});

test('touch jitter stays a press until six pixels of travel', () => {
  const gesture = new BallGesture();
  gesture.begin({ x: 0, y: 0 }, 0);
  assert.equal(gesture.move({ x: 3, y: 4 }).dragging, false);
  assert.deepEqual(gesture.move({ x: 6, y: 0 }), { firstDrag: true, dragging: true, dx: 6, dy: 0 });
  assert.equal(gesture.confirm(BALL_HOLD_MS), false);
  assert.equal(gesture.release(), 'drag');
});

test('dragging back to the original point cannot become a long press', () => {
  const gesture = new BallGesture();
  gesture.begin({ x: 100, y: 80 }, 0);
  gesture.move({ x: 90, y: 80 });
  assert.deepEqual(gesture.move({ x: 100, y: 80 }), { firstDrag: false, dragging: true, dx: 0, dy: 0 });
  assert.equal(gesture.confirm(9000), false);
  assert.equal(gesture.release(), 'drag');
});

test('pointer cancellation never opens the main window', () => {
  const gesture = new BallGesture();
  gesture.begin({ x: 0, y: 0 }, 0);
  assert.equal(gesture.release(true), 'none');
  assert.equal(gesture.active, false);
  assert.equal(gesture.confirm(9000), false);
});

test('a fresh gesture resets drag and long-press suppression', () => {
  const gesture = new BallGesture();
  gesture.begin({ x: 0, y: 0 }, 0);
  gesture.move({ x: 10, y: 10 });
  gesture.release();
  gesture.begin({ x: 0, y: 0 }, 100);
  assert.equal(gesture.confirm(3100), true);
  assert.equal(gesture.release(), 'none');
});

test('a stationary touch stays fixed in screen DIPs while the native window moves', () => {
  const gesture = new BallGesture();
  const touch = (clientX: number, clientY: number) => ({
    pointerType: 'touch', screenX: clientX, screenY: clientY, clientX, clientY,
  });
  gesture.begin(resolvePointerPoint(touch(38, 40), { screenX: 742, screenY: 258 }), 0);
  // Real Windows touch observed client-relative event.screenX/Y. Client offsets
  // change when the HWND follows the contact, even though the contact is still.
  for (const origin of [{ screenX: 730, screenY: 250 }, { screenX: 800, screenY: 320 }, { screenX: 742, screenY: 258 }]) {
    const point = resolvePointerPoint(touch(780 - origin.screenX, 298 - origin.screenY), origin);
    assert.deepEqual(point, { x: 780, y: 298 });
    assert.deepEqual(gesture.move(point), { firstDrag: false, dragging: false, dx: 0, dy: 0 });
  }
});

test('touch displacement follows the global contact independently of changing window offsets', () => {
  const gesture = new BallGesture();
  gesture.begin({ x: 780, y: 298 }, 0);
  const samples = [
    { origin: { screenX: 742, screenY: 258 }, clientX: 18, clientY: 32, expected: { dx: -20, dy: -8 } },
    { origin: { screenX: 700, screenY: 230 }, clientX: 60, clientY: 60, expected: { dx: -20, dy: -8 } },
    { origin: { screenX: 710.5, screenY: 220.5 }, clientX: 29.25, clientY: 49.25, expected: { dx: -40.25, dy: -28.25 } },
  ];
  for (const [index, sample] of samples.entries()) {
    const point = resolvePointerPoint({ pointerType: 'touch', screenX: sample.clientX, screenY: sample.clientY, clientX: sample.clientX, clientY: sample.clientY }, sample.origin);
    assert.deepEqual(gesture.move(point), { firstDrag: index === 0, dragging: true, ...sample.expected });
  }
});

test('mouse and pen screen coordinates remain absolute and never receive the window offset twice', () => {
  for (const pointerType of ['mouse', 'pen', '']) {
    assert.deepEqual(resolvePointerPoint({ pointerType, screenX: 1050.5, screenY: -200.25, clientX: 308.5, clientY: 58.25 }, { screenX: 742, screenY: -258.5 }), { x: 1050.5, y: -200.25 });
  }
});

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const start = (id: string, pointerType = 'mouse'): DesktopDragStart => ({ id, screenX: 100, screenY: 80, pointerType });
function fixture(overrides: {
  start?: (value: DesktopDragStart) => Promise<void | { nativeTracking: boolean }>;
  end?: (value: DesktopDragEnd) => Promise<void>;
} = {}) {
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const calls: unknown[] = [], errors: unknown[] = [];
  const session = new BallDragSession({
    start: value => { calls.push(['start', value.id]); return overrides.start?.(value) ?? Promise.resolve(); },
    move: value => { calls.push(['move', value]); },
    end: value => { calls.push(['end', value]); return overrides.end?.(value) ?? Promise.resolve(); },
  }, callback => { const id = ++nextFrame; frames.set(id, callback); return id; }, id => {
    frames.delete(id);
  }, (reason, id) => { errors.push([id, reason]); });
  return {
    session, calls, frames, errors,
    frame() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(0); },
  };
}

test('touch moves coalesce into the latest total screen displacement per frame', async () => {
  const f = fixture();
  f.session.start(start('one'), { dx: 6, dy: 0 });
  await settle();
  for (let dx = 7; dx <= 100; dx++) f.session.move('one', { dx, dy: -dx });
  assert.equal(f.frames.size, 1);
  assert.deepEqual(f.calls, [['start', 'one']]);
  f.frame();
  assert.deepEqual(f.calls.at(-1), ['move', { id: 'one', dx: 100, dy: -100 }]);
  f.frame();
  assert.equal(f.calls.length, 2);
});

test('release flushes the final point before native end and cancels the pending frame', async () => {
  const f = fixture();
  f.session.start(start('one'), { dx: 6, dy: 0 });
  await settle();
  f.session.move('one', { dx: 49, dy: 20 });
  await f.session.end('one');
  assert.equal(f.frames.size, 0);
  assert.deepEqual(f.calls, [
    ['start', 'one'], ['move', { id: 'one', dx: 49, dy: 20 }], ['end', { id: 'one', cancelled: false }],
  ]);
  await f.session.end('one');
  f.frame();
  assert.equal(f.calls.length, 3);
});

test('capture cancellation carries cancellation instead of becoming a click or normal snap', async () => {
  const f = fixture();
  f.session.start(start('one'), { dx: 20, dy: 30 });
  await f.session.end('one', true);
  assert.deepEqual(f.calls.at(-1), ['end', { id: 'one', cancelled: true }]);
  assert.equal(f.session.id, null);
  assert.equal(f.frames.size, 0);
});

test('a delayed start and end complete before a newer touch may start moving the native window', async () => {
  const firstStart = deferred<void>(), firstEnd = deferred<void>();
  const f = fixture({
    start: value => value.id === 'old' ? firstStart.promise : Promise.resolve(),
    end: value => value.id === 'old' ? firstEnd.promise : Promise.resolve(),
  });
  f.session.start(start('old'), { dx: 20, dy: 0 });
  await settle();
  const finished = f.session.end('old', true);
  f.session.start(start('new'), { dx: 40, dy: 4 });
  f.session.move('new', { dx: 70, dy: 7 });
  assert.deepEqual(f.calls, [['start', 'old']]);
  firstStart.resolve();
  await settle();
  assert.deepEqual(f.calls, [
    ['start', 'old'], ['move', { id: 'old', dx: 20, dy: 0 }], ['end', { id: 'old', cancelled: true }],
  ]);
  firstEnd.resolve();
  await finished;
  await settle();
  assert.deepEqual(f.calls.at(-1), ['start', 'new']);
  f.frame();
  assert.deepEqual(f.calls.at(-1), ['move', { id: 'new', dx: 70, dy: 7 }]);
  assert.equal(f.session.id, 'new');
});

test('stale motion and release cannot alter or finish a newer drag', async () => {
  const f = fixture();
  f.session.start(start('old'), { dx: 10, dy: 0 });
  await f.session.end('old', true);
  f.session.start(start('new'), { dx: 20, dy: 2 });
  await settle();
  f.session.move('old', { dx: 800, dy: 900 });
  await f.session.end('old');
  f.frame();
  assert.deepEqual(f.calls.at(-1), ['move', { id: 'new', dx: 20, dy: 2 }]);
  assert.equal(f.session.id, 'new');
});

test('native completion after capture loss cancels queued DOM movement without ending twice', async () => {
  const f = fixture({ start: async () => ({ nativeTracking: true }) });
  f.session.start(start('one'), { dx: 10, dy: 10 });
  await settle();
  assert.equal(f.session.nativeTracking, true);
  f.session.endedByNative('one');
  f.frame();
  await f.session.end('one', true);
  assert.deepEqual(f.calls, [['start', 'one']]);
  assert.equal(f.session.id, null);
});

test('a rejected asynchronous start reports once and does not poison the next gesture', async () => {
  const pending = deferred<void>();
  const f = fixture({ start: value => value.id === 'old' ? pending.promise : Promise.resolve() });
  f.session.start(start('old'), { dx: 20, dy: 20 });
  const ended = f.session.end('old', true);
  f.session.start(start('new'), { dx: 40, dy: 40 });
  pending.reject(Error('native start failed'));
  await ended;
  await settle();
  f.frame();
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.calls.at(-1), ['move', { id: 'new', dx: 40, dy: 40 }]);
});

test('non-finite or stale DOM input cannot replace the queued valid screen displacement', async () => {
  const f = fixture();
  f.session.start(start('one'), { dx: 10, dy: -10 });
  await settle();
  f.session.move('one', { dx: NaN, dy: 20 } as DesktopDrag);
  f.session.move('one', { dx: Infinity, dy: 20 });
  f.frame();
  assert.deepEqual(f.calls.at(-1), ['move', { id: 'one', dx: 10, dy: -10 }]);
});

test('touch smoothing damps one reversed coordinate sample and converges during a stationary contact', async () => {
  const f = fixture();
  f.session.start(start('touch', 'touch'), { dx: 10, dy: -10 });
  await settle();
  // The first touch position incurs no extra smoothing frame.
  assert.deepEqual(f.calls.at(-1), ['move', { id: 'touch', dx: 10, dy: -10 }]);
  const positions: number[] = [10];
  for (const raw of [30, 27, 45]) {
    f.session.move('touch', { dx: raw, dy: -raw });
    f.frame();
    const last = f.calls.at(-1) as [string, DesktopDrag];
    positions.push(last[1].dx);
  }
  assert.deepEqual(positions, [10, 20, 23.5, 34.25]);
  // Continue rendering after input stops so the ball reaches the stationary hand.
  for (let frames = 0; f.frames.size && frames < 20; frames++) {
    f.frame();
    const last = f.calls.at(-1) as [string, DesktopDrag];
    positions.push(last[1].dx);
  }
  assert.equal(f.frames.size, 0);
  assert.ok(positions.every((value, index) => index === 0 || value >= positions[index - 1]!));
  assert.deepEqual(f.calls.at(-1), ['move', { id: 'touch', dx: 45, dy: -45 }]);
});

test('touch release flushes the exact raw endpoint instead of leaving a filtered displacement', async () => {
  const f = fixture();
  f.session.start(start('touch', 'touch'), { dx: 10, dy: 0 });
  await settle();
  f.session.move('touch', { dx: 50, dy: 20 });
  f.frame();
  assert.deepEqual(f.calls.at(-1), ['move', { id: 'touch', dx: 30, dy: 10 }]);
  // pointerup can carry a newer final position than the last pointermove.
  f.session.move('touch', { dx: 56, dy: 24 });
  await f.session.end('touch');
  assert.deepEqual(f.calls.slice(-2), [
    ['move', { id: 'touch', dx: 56, dy: 24 }], ['end', { id: 'touch', cancelled: false }],
  ]);
  assert.equal(f.frames.size, 0);
});

test('mouse and pen motion bypass touch smoothing including small direction changes', async () => {
  for (const pointerType of ['mouse', 'pen']) {
    const f = fixture();
    f.session.start(start('one', pointerType), { dx: 10, dy: 0 });
    await settle();
    f.frame();
    for (const dx of [30, 27, 45]) {
      f.session.move('one', { dx, dy: 0 });
      f.frame();
      assert.deepEqual(f.calls.at(-1), ['move', { id: 'one', dx, dy: 0 }]);
      assert.equal(f.frames.size, 0);
    }
  }
});
