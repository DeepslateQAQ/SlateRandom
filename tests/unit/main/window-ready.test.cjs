'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { waitForWindowReady } = require('../../../src/main/window-ready.cjs');

function fixture(execute = async () => true) {
  const win = new EventEmitter(), contents = new EventEmitter(), scripts = [];
  let windowDestroyed = false, contentsDestroyed = false;
  win.webContents = contents;
  win.isDestroyed = () => windowDestroyed;
  contents.isDestroyed = () => contentsDestroyed;
  contents.executeJavaScript = source => { scripts.push(source);return execute(source); };
  return { win, contents, scripts,
    finish: () => contents.emit('did-finish-load'),
    destroyWindow: () => { windowDestroyed = true;win.emit('closed'); },
    destroyContents: () => { contentsDestroyed = true;contents.emit('destroyed'); } };
}

function assertClean({ win, contents }) {
  assert.equal(win.eventNames().length, 0, 'window readiness listeners were removed');
  assert.equal(contents.eventNames().length, 0, 'webContents readiness listeners were removed');
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('main waits for page load and verifies the bridge role and Vue mount, rather than ready-to-show', async () => {
  const f = fixture();
  const ready = waitForWindowReady(f.win, { role: 'main', timeoutMs: 500 });
  f.win.emit('ready-to-show');
  await tick();
  assert.equal(f.scripts.length, 0);
  f.finish();
  await ready;
  assert.match(f.scripts[0], /slateDesktop\?\.role === "main"/);
  assert.match(f.scripts[0], /getElementById\("drawBtn"\)/);
  assertClean(f);
});

test('ball keeps checking when Vue mounts after did-finish-load', async () => {
  let calls = 0;
  const f = fixture(async () => ++calls >= 3);
  const ready = waitForWindowReady(f.win, { role: 'ball', timeoutMs: 500 });
  f.finish();
  await ready;
  assert.equal(calls, 3);
  assert.match(f.scripts[0], /slateDesktop\?\.role === "ball"/);
  assert.match(f.scripts[0], /getElementById\("floatingBallButton"\)/);
  assertClean(f);
});

test('a result from an old page cannot mark the replacement page ready', async () => {
  let oldResult, mounted = false, calls = 0, resolved = false;
  const f = fixture(() => ++calls === 1 ? new Promise(resolve => { oldResult = resolve; }) : Promise.resolve(mounted));
  const ready = waitForWindowReady(f.win, { role: 'main', timeoutMs: 500 });
  ready.then(() => { resolved = true; });
  f.finish();
  f.contents.emit('did-start-loading');
  f.finish();
  oldResult(true);
  await tick();
  assert.equal(resolved, false);
  mounted = true;
  await ready;
  assert.ok(calls >= 3);
  assertClean(f);
});

test('real top-level load failure rejects immediately with useful context', async () => {
  const f = fixture();
  const ready = waitForWindowReady(f.win, { role: 'main', timeoutMs: 500 });
  f.contents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///missing.html', true);
  await assert.rejects(ready, /main window: page load failed \(-6\): ERR_FILE_NOT_FOUND/);
  assertClean(f);
});

test('aborted navigation and subframe failures do not reject a healthy final page', async () => {
  const f = fixture();
  const ready = waitForWindowReady(f.win, { role: 'main', timeoutMs: 500 });
  f.contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', '', true);
  f.contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', '', false);
  f.finish();
  await ready;
  assertClean(f);
});

test('renderer exit reports its reason and exit code', async () => {
  const f = fixture();
  const ready = waitForWindowReady(f.win, { role: 'ball', timeoutMs: 500 });
  f.contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -1073741819 });
  await assert.rejects(ready, /ball window: renderer exited \(crashed, exit -1073741819\)/);
  assertClean(f);
});

test('preload failure rejects before a missing bridge can hang the window', async () => {
  const f = fixture();
  const ready = waitForWindowReady(f.win, { role: 'main', timeoutMs: 500 });
  f.contents.emit('preload-error', {}, 'preload.cjs', Error('Cannot load isolated bridge'));
  await assert.rejects(ready, /preload failed: Cannot load isolated bridge/);
  assertClean(f);
});

test('window closure and webContents destruction both reject and clean up', async () => {
  for (const action of ['destroyWindow', 'destroyContents']) {
    const f = fixture();
    const ready = waitForWindowReady(f.win, { role: 'main', timeoutMs: 500 });
    f[action]();
    await assert.rejects(ready, /closed|destroyed/);
    assertClean(f);
  }
});

test('JavaScript rejection and synchronous failure produce a readiness error', async () => {
  for (const execute of [() => Promise.reject(Error('renderer unavailable')), () => { throw Error('context destroyed'); }]) {
    const f = fixture(execute);
    const ready = waitForWindowReady(f.win, { role: 'main', timeoutMs: 500 });
    f.finish();
    await assert.rejects(ready, /renderer readiness check failed: (renderer unavailable|context destroyed)/);
    assertClean(f);
  }
});

test('total deadline also bounds a hung executeJavaScript call', async () => {
  let completeProbe;
  const f = fixture(() => new Promise(resolve => { completeProbe = resolve; }));
  const ready = waitForWindowReady(f.win, { role: 'ball', timeoutMs: 25 });
  f.finish();
  await assert.rejects(ready, { code: 'SLATE_WINDOW_TIMEOUT', role: 'ball' });
  assertClean(f);
  completeProbe(true);
  await tick();
  assertClean(f);
});

test('missing document load and a renderer that never mounts both reach the total deadline', async () => {
  for (const load of [false, true]) {
    const f = fixture(async () => false);
    const ready = waitForWindowReady(f.win, { role: 'main', timeoutMs: 25 });
    if (load) f.finish();
    await assert.rejects(ready, { code: 'SLATE_WINDOW_TIMEOUT' });
    assertClean(f);
  }
});

test('invalid inputs and an already destroyed window reject without leaking listeners', async () => {
  const f = fixture();
  await assert.rejects(waitForWindowReady(f.win, { role: 'unknown' }), /role/);
  await assert.rejects(waitForWindowReady(f.win, { role: 'main', timeoutMs: 0 }), /timeout/);
  await assert.rejects(waitForWindowReady({}, { role: 'ball' }), /BrowserWindow/);
  f.destroyWindow();
  await assert.rejects(waitForWindowReady(f.win, { role: 'main' }), /already destroyed/);
  assertClean(f);
});
