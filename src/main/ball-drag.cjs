'use strict';
const G = require('./geometry.cjs');

/** Keep the HWND size fixed while dragging and collapse input bursts to a frame. */
function createBallDrag({ getWindow, screen, positionWindow = (win, x, y) => win.setPosition(x, y), onStart = () => {}, onEnd = () => {}, schedule = setTimeout, cancel = clearTimeout }) {
  let gesture = null, timer = null, pending = null;
  const matches = input => gesture && (gesture.id === null ? !input?.id : input?.id === gesture.id);
  function flush() {
    timer = null;
    if (!gesture || !pending) return;
    const win = getWindow(), point = pending; pending = null;
    if (!win || win.isDestroyed()) return;
    const bounds = { ...gesture.bounds, x: Math.round(gesture.bounds.x + point.dx), y: Math.round(gesture.bounds.y + point.dy) };
    const next = G.constrainBall(bounds, screen.getDisplayMatching(bounds).workArea);
    if (next.x === gesture.x && next.y === gesture.y) return;
    positionWindow(win, next.x, next.y);
    gesture.x = next.x; gesture.y = next.y;
  }
  return {
    get active() { return Boolean(gesture); },
    get id() { return gesture?.id || null; },
    start(input) {
      const id = input?.id;
      if (id !== undefined && (typeof id !== 'string' || !id || id.length > 120)) throw Error('Invalid drag gesture.');
      if (timer !== null) cancel(timer);
      timer = null; pending = null;
      const bounds = getWindow().getBounds();
      gesture = { id: id || null, bounds, x: bounds.x, y: bounds.y };
      onStart();
      return { nativeTracking: false };
    },
    move(input) {
      if (!input || typeof input !== 'object' || !matches(input) || !Number.isFinite(input.dx) || !Number.isFinite(input.dy) || Math.abs(input.dx) > 20000 || Math.abs(input.dy) > 20000) return;
      pending = { dx: input.dx, dy: input.dy };
      if (timer === null) timer = schedule(flush, 16);
    },
    async end(input) {
      if (!matches(input)) return;
      if (timer !== null) cancel(timer);
      timer = null; flush(); gesture = null;
      return onEnd(input?.cancelled === true);
    },
    dispose() {
      if (timer !== null) cancel(timer);
      timer = null; pending = null; gesture = null;
    }
  };
}
module.exports = { createBallDrag };
