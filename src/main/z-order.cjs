'use strict';

// Reassert topmost without activating a window or revealing a hidden surface.
// Windows may reorder topmost HWNDs when other presentation apps come forward.
function createZOrderKeeper({ getWindows, intervalMs = 1500, schedule = setInterval, cancel = clearInterval, onError = () => {} }) {
  let disposed = false;
  const refresh = () => {
    if (disposed) return;
    const { main, ball } = getWindows();
    for (const win of [main, ball]) {
      if (!win || win.isDestroyed()) continue;
      try {
        win.setAlwaysOnTop(true, 'screen-saver');
        if (win.isVisible()) win.moveTop();
      } catch (error) { onError(error); }
    }
  };
  const timer = schedule(refresh, intervalMs);
  timer.unref?.();
  refresh();
  return { refresh, dispose() { if (disposed) return; disposed = true; cancel(timer); } };
}

module.exports = { createZOrderKeeper };
