'use strict';

const POLL_INTERVAL_MS = 35;

/**
 * Register before loadFile/loadURL. A native window being allocated or emitting
 * ready-to-show does not mean that its isolated Vue renderer can be used yet.
 */
function waitForWindowReady(win, { role, timeoutMs = 15000 } = {}) {
  if (role !== 'main' && role !== 'ball') return Promise.reject(new TypeError('A main or ball window role is required.'));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return Promise.reject(new TypeError('The window readiness timeout must be positive.'));
  const contents = win?.webContents;
  if (!contents || typeof contents.executeJavaScript !== 'function')
    return Promise.reject(new TypeError('An Electron BrowserWindow with webContents is required.'));

  return new Promise((resolve, reject) => {
    let settled = false, loaded = false, generation = 0, probeGeneration = -1;
    let pollTimer = null, deadlineTimer = null;
    const listeners = [];
    const elementId = role === 'main' ? 'drawBtn' : 'floatingBallButton';
    const source = `(() => window.slateDesktop?.role === ${JSON.stringify(role)} && document.getElementById(${JSON.stringify(elementId)}) !== null)()`;

    function listen(target, name, callback) {
      target.on(name, callback);
      listeners.push([target, name, callback]);
    }
    function cleanup() {
      clearTimeout(pollTimer);
      clearTimeout(deadlineTimer);
      for (const [target, name, callback] of listeners) target.removeListener(name, callback);
      listeners.length = 0;
    }
    function finish(error) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve();
    }
    function failure(message, code = 'SLATE_WINDOW_NOT_READY') {
      const error = new Error(`SlateRandom ${role} window: ${message}`);
      error.code = code;
      error.role = role;
      finish(error);
    }
    function destroyed() {
      return win.isDestroyed?.() === true || contents.isDestroyed?.() === true;
    }
    function probe() {
      if (settled || !loaded || probeGeneration === generation) return;
      if (destroyed()) return failure('destroyed before the renderer became ready.');
      const currentGeneration = generation;
      probeGeneration = currentGeneration;
      let result;
      try { result = contents.executeJavaScript(source); }
      catch (error) { failure(`renderer readiness check failed: ${errorMessage(error)}`); return; }
      // Attach rejection handling immediately. A late result after timeout,
      // closure or navigation must not settle the readiness promise again.
      Promise.resolve(result).then(ready => {
        if (settled || currentGeneration !== generation) return;
        probeGeneration = -1;
        if (destroyed()) return failure('destroyed before the renderer became ready.');
        if (ready === true) return finish();
        pollTimer = setTimeout(probe, POLL_INTERVAL_MS);
      }, error => {
        if (!settled && currentGeneration === generation)
          failure(`renderer readiness check failed: ${errorMessage(error)}`);
      });
    }

    listen(contents, 'did-start-loading', () => {
      loaded = false;
      generation++;
      clearTimeout(pollTimer);
    });
    listen(contents, 'did-finish-load', () => {
      loaded = true;
      generation++;
      clearTimeout(pollTimer);
      probe();
    });
    listen(contents, 'did-fail-load', (_event, errorCode, description, _url, isMainFrame) => {
      if (errorCode === -3 || isMainFrame === false) return;
      failure(`page load failed (${errorCode}): ${errorMessage(description)}`);
    });
    listen(contents, 'render-process-gone', (_event, details = {}) => {
      failure(`renderer exited (${details.reason || 'unknown'}, exit ${details.exitCode ?? 'unknown'}).`);
    });
    listen(contents, 'preload-error', (_event, _preloadPath, error) => {
      failure(`preload failed: ${errorMessage(error)}`);
    });
    listen(contents, 'destroyed', () => failure('webContents was destroyed before the renderer became ready.'));
    listen(win, 'closed', () => failure('window closed before the renderer became ready.'));
    listen(win, 'destroyed', () => failure('window was destroyed before the renderer became ready.'));

    deadlineTimer = setTimeout(() => {
      failure(`renderer did not become ready within ${timeoutMs} ms.`, 'SLATE_WINDOW_TIMEOUT');
    }, timeoutMs);
    if (destroyed()) failure('window was already destroyed.');
  });
}

function errorMessage(error) {
  return String(error?.message || error || 'unknown error').slice(0, 1024);
}

module.exports = { waitForWindowReady };
