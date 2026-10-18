'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { normalizeSettings, patchSettings } = require('../../../src/main/settings.cjs');
const { encodeAppCommand, decodeAppCommand } = require('../../../src/main/app-protocol.cjs');
const { FORMAT, VERSION } = require('../../../src/main/backup-import.cjs');
const entry = path.resolve(__dirname, '../../../src/main/main.cjs');
const source = fs.readFileSync(entry, 'utf8');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate) {
  for (let tick = 0; tick < 100; tick++) { if (predicate()) return; await new Promise(setImmediate); }
  assert.fail('Mocked main process did not reach the requested lifecycle point.');
}
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
function harness(options = {}) {
  const appReady = deferred(), status = deferred(), windows = [], ready = new Map(), handlers = new Map(), listeners = new Map(), effects = [], privilegeArgs = [], protocolCalls = [];
  let disk = normalizeSettings(options.settings), writeCount = 0, clock = 0, protocols = null;
  const app = Object.assign(new EventEmitter(), {
    isPackaged: options.packaged === true, commandLine: { appendSwitch() {} },
    setName() {}, setAppUserModelId() {}, setPath() {}, getPath: () => '/mock/data',
    requestSingleInstanceLock: () => true, releaseSingleInstanceLock() {}, whenReady: () => appReady.promise,
    quit() { effects.push('quit'); }, exit(code) { effects.push(['exit', code]); }, disableHardwareAcceleration() {}
  });
  class Window extends EventEmitter {
    constructor(config) {
      super(); this.config = config; this.bounds = { x: config.x, y: config.y, width: config.width, height: config.height };
      this.visible = false; this.destroyed = false; this.alpha = 1;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: '' }, isDestroyed: () => this.destroyed, getURL: () => this.webContents.mainFrame.url,
        stateSnapshots: [], sent: [], scripts: [], openHandler: null, setWindowOpenHandler(handler) { this.openHandler = handler; },
        send(channel, payload) { this.sent.push([channel, payload]); if (channel === 'slate:state-changed') this.stateSnapshots.push(payload); },
        async executeJavaScript(script) { this.scripts.push(script); return true; }
      });
      windows.push(this);
      options.onWindow?.(this, windows.length, app);
    }
    static fromWebContents(sender) { return windows.find(win => win.webContents === sender); }
    static getAllWindows() { return windows.filter(win => !win.destroyed); }
    removeMenu() {} setAlwaysOnTop() {} blur() {} focus() {} setShape() {}
    getBounds() { return { ...this.bounds }; } getContentBounds() { return this.getBounds(); }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    getOpacity() { return this.alpha; } setOpacity(value) { this.alpha = value; }
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; }
    show() { this.visible = true; } showInactive() { this.visible = true; } hide() { this.visible = false; }
    destroy() { this.destroyed = true; this.visible = false; }
    async loadURL(url) { this.webContents.mainFrame.url = url; }
    async loadFile(file, { query }) { this.webContents.mainFrame.url = require('node:url').pathToFileURL(file).href + '?' + new URLSearchParams(query); }
  }
  const area = { x: 0, y: 0, width: 1600, height: 900 };
  const screen = Object.assign(new EventEmitter(), {
    getPrimaryDisplay: () => ({ workArea: area }), getDisplayMatching: () => ({ workArea: area }), getDisplayNearestPoint: () => ({ workArea: area })
  });
  class Tray extends EventEmitter { setToolTip() {} setContextMenu() {} destroy() {} }
  const store = {
    get settings() { return { ...disk }; }, ball: null, warning: null,
    get protocols() { return protocols === null ? null : JSON.parse(JSON.stringify(protocols)); },
    set protocols(value) { protocols = value === null || value === undefined ? null : JSON.parse(JSON.stringify(value)); },
    write(target) { effects.push(['persist', target.autostart]); if (options.writeFailure?.(++writeCount)) throw Error('disk denied'); disk = normalizeSettings(target); }, position() {}
  };
  const native = { elevated: false, uiAccess: false, available: true };
  const privilege = { getStatus: () => options.delayedStatus ? status.promise : Promise.resolve(native),
    async requestRelaunch() { effects.push('relaunch'); return options.relaunch || { started: false, cancelled: true }; } };
  const mocks = {
    electron: { app, BrowserWindow: Window, ipcMain: { handle: (id, fn) => handlers.set(id, fn), on: (id, fn) => listeners.set(id, fn) }, screen,
      dialog: { showErrorBox() {}, async showSaveDialog() { throw Error('unexpected file dialog'); },
        async showOpenDialog() {
          if (options.openDialog) return await options.openDialog();
          return options.dialogResult ?? (() => { throw Error('unexpected file dialog'); })();
        } },
      clipboard: { readText: () => options.clipboardText ?? '' },
      session: { fromPath: () => ({}) }, Tray,
      Menu: { buildFromTemplate: value => ({ items: value, getMenuItemById: id => value.find(item => item.id === id) }) },
      shell: { openExternal: async url => { effects.push(['external', url]); } } },
    'node:fs': { mkdirSync() {}, mkdtempSync: () => '/mock/session', rmSync() {},
      promises: {
        stat(file) { return options.stat ? options.stat(file) : Promise.resolve({ isFile: () => true, size: 16 }); },
        readFile(file) { return options.readFile ? options.readFile(file) : Promise.resolve(Buffer.from('backup-bytes')); }
      } },
    './settings.cjs': { createSettingsStore: () => store, patchSettings },
    './privileges.cjs': { createPrivilegeService: config => { if (config?.baseArgs) privilegeArgs.push(config.baseArgs); return privilege; } },
    './handoff.cjs': {
      createParentHandoff: async () => ({ args: [], waitForChild: async () => {}, dispose: async () => {} }),
      connectChildHandoff: () => ({ dispose() {}, async handover({ show }) { await show(); } })
    },
    './window-ready.cjs': { waitForWindowReady(win) { const item = deferred(); ready.set(win, item); if (!options.delayedWindows) item.resolve(); return item.promise; } },
    './diagnostics.cjs': { createNativeLog: () => () => {} },
    './protocol-registration.cjs': { createProtocolRegistration: () => ({ apply(group, enabled) {
      protocolCalls.push([group, enabled]);
      return Promise.resolve(options.protocolApply?.(group, enabled) ?? { ok: true });
    } }) },
    './ball-shape.cjs': { ballShape: () => [] },
    './portable-location.cjs': { preparePortableLocation: value => ({ directory: value.directory, browserDirectory: '/mock/browser', migrated: options.migrated === true }) },
    './portable-data.cjs': { createPortableStore: () => ({
      // A real installation already finished the first-run flow; tests opt into a fresh one.
      load: () => { if (options.portableLoadError) throw options.portableLoadError; return options.portableState === undefined ? { version: 1, students: [], settings: { onboardingCompleted: true } } : options.portableState; },
      info: () => ({}), readCredentials: () => ({ active: '', records: [] })
    }) },
    './z-order.cjs': { createZOrderKeeper: () => ({ dispose() {} }) },
    './autostart.cjs': { createAutostartService: () => ({ async apply(target) {
      effects.push(['startup', target.autostart]); return options.startup?.(target) || { ok: true };
    } }) },
    '../shared/domain/engine.js': { restoreState: value => value }
  };
  const module = { exports: {} };
  const process = { argv: ['node', entry, ...(options.args || [])], env: options.devUrl === undefined ? {} : { SLATE_DEV_URL: options.devUrl },
    execPath: '/mock/electron', resourcesPath: '/mock/resources', pid: 42,
    kill() { throw Object.assign(Error('parent exited'), { code: 'ESRCH' }); }
  };
  vm.compileFunction(source, ['require', 'module', '__dirname', '__filename', 'process', 'setTimeout', 'Date'])(id => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (id.startsWith('./')) return require(path.resolve(path.dirname(entry), id));
    return require(id);
  }, module, path.dirname(entry), entry, process, callback => setImmediate(callback), { now: () => clock += 1000 });
  return { app, screen, windows, ready, effects, privilegeArgs, protocolCalls, store, api: module.exports,
    start: () => appReady.resolve(), resolveStatus: () => status.resolve(native),
    event(win = module.exports.getWindows().main, url) {
      if (url) win.webContents.mainFrame.url = url;
      return { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    },
    invoke(id, event, ...args) { return handlers.get(id)(event, ...args); },
    sync(id, event, value) { listeners.get(id)(event, value); return event.returnValue; }
  };
}

for (const devUrl of ['https://127.0.0.1:5173/', 'http://example.com/', 'http://127.0.0.1.evil/', 'http://user@localhost/', 'http://localhost/#', 'not a URL', '']) {
  test(`development rejects unsafe launcher URL ${JSON.stringify(devUrl)}`, () => {
    assert.throws(() => harness({ devUrl }), /SLATE_DEV_URL/);
  });
}
for (const devUrl of ['http://127.0.0.1:5173/', 'http://localhost:5173/', 'http://[::1]:5173/']) {
  test(`development accepts loopback launcher ${devUrl}`, async () => {
    const ctx = harness({ devUrl });ctx.start();await until(() => ctx.api.isReady());
    assert.equal(new URL(ctx.api.getWindows().main.webContents.getURL()).origin, new URL(devUrl).origin);
  });
}
test('packaged startup ignores even an invalid development environment URL', async () => {
  const ctx = harness({ packaged: true, devUrl: 'not a valid development URL' });ctx.start();await until(() => ctx.api.isReady());
  assert.equal(new URL(ctx.api.getWindows().main.webContents.getURL()).protocol, 'file:');
});

for (const timing of ['token wait', 'main construction', 'windows loading', 'ready']) {
  test(`second-instance intent survives ${timing} and leaves only main visible`, async () => {
    const ctx = harness({ delayedStatus: timing === 'token wait', delayedWindows: timing === 'windows loading',
      onWindow: (_win, count, app) => { if (timing === 'main construction' && count === 1) app.emit('second-instance'); } });
    ctx.start();
    if (timing === 'token wait') { ctx.app.emit('second-instance');ctx.resolveStatus(); }
    if (timing === 'windows loading') {
      await until(() => ctx.windows.length === 2);ctx.app.emit('second-instance');
      for (const item of ctx.ready.values()) item.resolve();
    }
    await until(() => ctx.api.isReady());
    if (timing === 'ready') ctx.app.emit('second-instance');
    await until(() => ctx.api.getWindows().main.isVisible());
    assert.equal(ctx.api.getWindows().ball.isVisible(), false);
  });
}

test('desktop opens only approved friend and author links in the system browser', async () => {
  const ctx = harness();
  ctx.start();
  await until(() => ctx.api.isReady());
  const { main } = ctx.api.getWindows();
  assert.equal(typeof main.webContents.openHandler, 'function');
  const allowed = [
    'https://github.com/DeepslateQAQ',
    'https://github.com/SECTL/SecRandom',
    'https://secrandom.sectl.cn',
    'https://github.com/InkCanvasForClass/community',
    'https://iccce.ink'
  ];
  for (const url of allowed) assert.deepEqual(main.webContents.openHandler({ url }), { action: 'deny' });
  await new Promise(setImmediate);
  assert.deepEqual(ctx.effects.filter(effect => effect[0] === 'external').map(effect => effect[1]), allowed);
  for (const url of ['https://example.com', 'http://github.com/SECTL/SecRandom', 'https://github.com/SECTL/SecRandom/extra', 'javascript:alert(1)']) {
    assert.deepEqual(main.webContents.openHandler({ url }), { action: 'deny' });
  }
  await new Promise(setImmediate);
  assert.equal(ctx.effects.filter(effect => effect[0] === 'external').length, allowed.length);
});

test('preview identity survives URL edits and replacement persistent windows lose preview authority', async () => {
  const ctx = harness({ args: ['--slate-handoff-pipe=mock', '--slate-handoff-token=mock', '--slate-handoff-parent-pid=99'], delayedWindows: true });
  ctx.start();await until(() => ctx.windows.length === 2);
  const preview = ctx.windows[0];
  for (const suffix of ['', '?slatePreview=false', '?slateRole=main']) {
    const url = require('node:url').pathToFileURL(path.resolve(path.dirname(entry), '../../dist/index.html')).href + suffix;
    const event = ctx.event(preview, url);
    assert.deepEqual(ctx.sync('slate:data-load', event), { ok: true, value: null });
    assert.throws(() => ctx.invoke('slate:settings', event, { uac: true }), /预览/);
    await assert.rejects(ctx.invoke('slate:data-credentials-read', event, 'vision'), /预览/);
  }
  ctx.app.emit('second-instance');
  for (const item of ctx.ready.values()) item.resolve();
  await until(() => ctx.windows.length === 4);
  ctx.app.emit('second-instance');
  for (const item of ctx.ready.values()) item.resolve();
  await until(() => ctx.api.isReady());
  assert.equal(ctx.api.getWindows().main.isVisible(), true);
  assert.equal(ctx.api.getWindows().ball.isVisible(), false);
  assert.equal(preview.isDestroyed(), true);
  await assert.rejects(ctx.invoke('slate:data-credentials-read', ctx.event(preview), 'vision'), /不允许/);
  const official = ctx.api.getWindows().main;
  const event = ctx.event(official, official.webContents.getURL() + '&slatePreview=true');
  assert.deepEqual(await ctx.invoke('slate:data-credentials-read', event, 'vision'), { active: '', records: [] });
});

test('main IPC rejects ball, subframe and foreign-origin attempts before data or settings effects', async () => {
  const ctx = harness({ devUrl: 'http://127.0.0.1:5173/' });ctx.start();await until(() => ctx.api.isReady());
  const { main, ball } = ctx.api.getWindows();
  for (const event of [ctx.event(ball), { sender: main.webContents, senderFrame: { url: main.webContents.getURL() } }]) {
    assert.throws(() => ctx.invoke('slate:settings', event, { autostart: true }), /不允许|主页面/);
    await assert.rejects(ctx.invoke('slate:data-credentials-read', event, 'vision'), /不允许|主页面/);
  }
  assert.throws(() => ctx.invoke('slate:settings', ctx.event(main, 'http://localhost:5173/'), {}), /来源/);
  assert.deepEqual(ctx.effects, []);
});

test('main settings returns DesktopState and restores startup after failed preference publication', async () => {
  const ctx = harness({ writeFailure: count => count === 1 });ctx.start();await until(() => ctx.api.isReady());
  const outcome = await ctx.invoke('slate:settings', ctx.event(), { autostart: true });
  assert.equal(outcome.settings.autostart, false);assert.match(outcome.runtime.error, /disk denied/);
  assert.deepEqual(ctx.effects, [['startup', true], ['persist', true], ['startup', false]]);
  assert.deepEqual(outcome.settings, ctx.store.settings);
});

test('main keeps pending guard through both compensations and synchronizes actual surviving disk preferences', async () => {
  const compensation = deferred();
  const ctx = harness({ writeFailure: count => count === 2, startup: target => target.autostart ? { ok: true } : compensation.promise });
  ctx.start();await until(() => ctx.api.isReady());
  const pending = ctx.invoke('slate:settings', ctx.event(), { autostart: true, uac: true });
  await until(() => ctx.effects.some(effect => Array.isArray(effect) && effect[0] === 'startup' && effect[1] === false));
  const duplicate = await ctx.invoke('slate:settings', ctx.event(), { autostart: false });
  assert.equal(duplicate.settings.autostart, true);
  assert.equal(ctx.effects.filter(effect => Array.isArray(effect) && effect[0] === 'persist').length, 1);
  compensation.resolve({ ok: false, error: 'startup rollback denied' });
  const outcome = await pending;
  assert.match(outcome.runtime.error, /取消/);assert.match(outcome.runtime.error, /startup rollback denied/);assert.match(outcome.runtime.error, /disk denied/);
  assert.equal(outcome.settings.autostart, true);assert.deepEqual(outcome.settings, ctx.store.settings);
  assert.equal(ctx.effects.includes('quit'), false);
});

test('ordinary preference updates return DesktopState without startup or relaunch work', async () => {
  const ctx = harness();ctx.start();await until(() => ctx.api.isReady());
  const outcome = await ctx.invoke('slate:settings', ctx.event(), { autostartElevation: 'task' });
  assert.equal(outcome.settings.autostartElevation, 'task');
  assert.equal(outcome.runtime.error, null);
  assert.deepEqual(ctx.effects, [['persist', false]]);
});

test('manual compatibility selection saves without changing startup or requesting app elevation', async () => {
  const ctx = harness({ settings: { uac: true, manualElevation: 'compatibility' } });
  ctx.start(); await until(() => ctx.api.isReady());
  assert.deepEqual(ctx.effects, []);
  const outcome = await ctx.invoke('slate:settings', ctx.event(), { autostartElevation: 'task' });
  assert.equal(outcome.settings.manualElevation, 'compatibility');
  assert.equal(outcome.settings.autostart, false);
  assert.deepEqual(ctx.effects, [['persist', false]]);
});

test('switching manual compatibility to UAC rolls preferences back when authorization is cancelled', async () => {
  const ctx = harness({ settings: { uac: true, manualElevation: 'compatibility' } });
  ctx.start(); await until(() => ctx.api.isReady());
  const outcome = await ctx.invoke('slate:settings', ctx.event(), { manualElevation: 'uac' });
  assert.equal(outcome.settings.manualElevation, 'compatibility');
  assert.match(outcome.runtime.error, /取消/);
  assert.equal(outcome.settings.autostart, false);
  assert.deepEqual(ctx.effects, [['persist', false], 'relaunch', ['persist', false]]);
});

test('login UAC and UIAccess requests are not suppressed by manual compatibility preference', async () => {
  for (const options of [
    { settings: { uac: true, manualElevation: 'compatibility' }, args: ['--slate-startup'] },
    { settings: { uac: true, uiAccess: true, manualElevation: 'compatibility' } }
  ]) {
    const ctx = harness(options); ctx.start(); await until(() => ctx.api.isReady());
    assert.deepEqual(ctx.effects, ['relaunch']);
  }
});

test('only confirmed replacement startup schedules the existing parent shutdown', async () => {
  const ctx = harness({ relaunch: { started: true } });ctx.start();await until(() => ctx.api.isReady());
  const outcome = await ctx.invoke('slate:settings', ctx.event(), { uac: true });
  assert.equal(outcome.settings.uac, true);assert.equal(outcome.runtime.error, null);
  assert.deepEqual(ctx.effects, [['persist', false], 'relaunch']);
  await until(() => ctx.effects.includes('quit'));
});

test('verification mode rejects startup and elevation requests without invoking native services', async () => {
  const ctx = harness({ args: ['--slate-qa'] });ctx.start();await until(() => ctx.api.isReady());
  const startup = await ctx.invoke('slate:settings', ctx.event(), { autostart: true });
  assert.match(startup.runtime.error, /验证模式/);assert.equal(startup.settings.autostart, false);
  assert.deepEqual(ctx.effects, []);
  const elevation = await ctx.invoke('slate:settings', ctx.event(), { uac: true });
  assert.match(elevation.runtime.error, /验证模式/);assert.equal(elevation.settings.uac, false);
  assert.deepEqual(ctx.effects, [['persist', false], ['persist', false]]);
});

test('main open and hide publish native visibility to both renderers on every round trip', async () => {
  const ctx = harness();ctx.start();await until(() => ctx.api.isReady());
  const { main, ball } = ctx.api.getWindows();
  for (let round = 0; round < 2; round++) {
    await ctx.invoke('slate:open-main', ctx.event(ball));
    assert.equal(main.isVisible(), true);assert.equal(ball.isVisible(), false);
    for (const win of [main, ball]) {
      assert.equal(win.webContents.stateSnapshots.at(-1)?.main.visible, main.isVisible());
    }
    await ctx.invoke('slate:hide-main', ctx.event(main));
    assert.equal(main.isVisible(), false);assert.equal(ball.isVisible(), true);
    for (const win of [main, ball]) {
      assert.equal(win.webContents.stateSnapshots.at(-1)?.main.visible, main.isVisible());
    }
  }
});

test('opening main cancels interrupted ball drag and hidden input cannot revive or move it', async () => {
  const ctx = harness();ctx.start();await until(() => ctx.api.isReady());
  const { main, ball } = ctx.api.getWindows();
  ball.setBounds({ x: 600, y: 220, width: 76, height: 76 });
  await ctx.invoke('slate:drag-start', ctx.event(ball), { id: 'interrupted' });
  assert.equal(ball.webContents.stateSnapshots.at(-1).ball.dragId, 'interrupted');
  await ctx.invoke('slate:open-main', ctx.event(ball));
  assert.equal(ball.webContents.stateSnapshots.at(-1).ball.dragId, null);
  assert.equal(ball.isVisible(), false);
  const hiddenBounds = ball.getBounds();
  ctx.sync('slate:drag-move', ctx.event(ball), { id: 'interrupted', dx: 80, dy: 40 });
  await ctx.invoke('slate:drag-end', ctx.event(ball), { id: 'interrupted', cancelled: true });
  assert.deepEqual(ball.getBounds(), hiddenBounds);
  await ctx.invoke('slate:drag-start', ctx.event(ball), { id: 'hidden' });
  assert.equal(ctx.invoke('slate:state', ctx.event(ball)).ball.dragId, null);
  ctx.sync('slate:drag-move', ctx.event(ball), { id: 'hidden', dx: 120, dy: 60 });
  await ctx.invoke('slate:drag-end', ctx.event(ball), { id: 'hidden', cancelled: true });
  assert.deepEqual(ball.getBounds(), hiddenBounds);
  await ctx.invoke('slate:hide-main', ctx.event(main));
  await ctx.invoke('slate:drag-start', ctx.event(ball), { id: 'fresh' });
  assert.equal(ball.webContents.stateSnapshots.at(-1).ball.dragId, 'fresh');
  ctx.sync('slate:drag-move', ctx.event(ball), { id: 'fresh', dx: 35, dy: 25 });
  await ctx.invoke('slate:drag-end', ctx.event(ball), { id: 'fresh', cancelled: true });
  assert.deepEqual(ball.getBounds(), { ...hiddenBounds, x: hiddenBounds.x + 35, y: hiddenBounds.y + 25 });
  assert.equal(ball.webContents.stateSnapshots.at(-1).ball.dragId, null);
});

test('main collapses expanded ball confirmation and ignores hidden requests until the ball returns', async () => {
  const ctx = harness();ctx.start();await until(() => ctx.api.isReady());
  const { main, ball } = ctx.api.getWindows();
  await ctx.invoke('slate:confirmation-open', ctx.event(ball));
  assert.equal(ball.webContents.stateSnapshots.at(-1).ball.confirming, true);
  assert.equal(ball.getBounds().width, 348);
  await ctx.invoke('slate:open-main', ctx.event(ball));
  assert.equal(ball.webContents.stateSnapshots.at(-1).ball.confirming, false);
  assert.equal(ball.getBounds().width, 76);assert.equal(ball.getBounds().height, 76);
  const hiddenBounds = ball.getBounds();
  await ctx.invoke('slate:confirmation-open', ctx.event(ball));
  assert.equal(ctx.invoke('slate:state', ctx.event(ball)).ball.confirming, false);
  assert.deepEqual(ball.getBounds(), hiddenBounds);
  await ctx.invoke('slate:hide-main', ctx.event(main));
  assert.equal(ball.isVisible(), true);
  assert.equal(ball.webContents.stateSnapshots.at(-1).ball.confirming, false);
  assert.equal(ball.getBounds().width, 76);
  await ctx.invoke('slate:confirmation-open', ctx.event(ball));
  assert.equal(ball.webContents.stateSnapshots.at(-1).ball.confirming, true);
  assert.equal(ball.getBounds().width, 348);
  await ctx.invoke('slate:confirmation-close', ctx.event(ball));
  assert.equal(ball.webContents.stateSnapshots.at(-1).ball.confirming, false);
  assert.equal(ball.getBounds().width, 76);
});

test('confirmation and display-reflow native calls discard rounded ball dimensions', async () => {
  const ctx = harness();ctx.start();await until(() => ctx.api.isReady());
  const { ball } = ctx.api.getWindows();
  for (let round = 0; round < 4; round++) {
    ball.setBounds({ ...ball.getBounds(), width: 77, height: 75 });
    ctx.invoke('slate:confirmation-open', ctx.event(ball));
    assert.equal(ball.getBounds().width, 348);assert.equal(ball.getBounds().height, 76);
    ball.setBounds({ ...ball.getBounds(), width: 347, height: 77 });
    ctx.screen.emit('display-metrics-changed');
    assert.equal(ball.getBounds().width, 348);assert.equal(ball.getBounds().height, 76);
    ctx.invoke('slate:confirmation-close', ctx.event(ball));
    assert.equal(ball.getBounds().width, 76);assert.equal(ball.getBounds().height, 76);
    ball.setBounds({ ...ball.getBounds(), width: 75, height: 77 });
    ctx.screen.emit('display-metrics-changed');
    assert.equal(ball.getBounds().width, 76);assert.equal(ball.getBounds().height, 76);
  }
});

for (const roundedWidth of [75, 77]) {
  test(`left-to-right release snaps using design size instead of transient native width ${roundedWidth}`, async () => {
    const ctx = harness();ctx.start();await until(() => ctx.api.isReady());
    const { ball } = ctx.api.getWindows(), area = ctx.screen.getDisplayMatching(ball.getBounds()).workArea;
    const moveTo = async x => {
      const from = ball.getBounds();
      await ctx.invoke('slate:drag-start', ctx.event(ball));
      ctx.sync('slate:drag-move', ctx.event(ball), { dx: x - from.x, dy: 0 });
      const original = ball.getBounds.bind(ball);
      let releaseSnapshot = true;
      ball.getBounds = () => {
        const bounds = original();
        if (releaseSnapshot) { releaseSnapshot = false;return { ...bounds, width: roundedWidth, height: 77 }; }
        return bounds;
      };
      try { await ctx.invoke('slate:drag-end', ctx.event(ball)); }
      finally { ball.getBounds = original; }
    };
    await moveTo(area.x + 8);
    assert.equal(ctx.api.state().ball.snap, 'left');assert.equal(ball.getBounds().x, area.x);
    await moveTo(area.x + area.width - 84);
    assert.equal(ctx.api.state().ball.snap, 'right');
    assert.equal(ball.getBounds().x + ball.getBounds().width, area.x + area.width);
    assert.equal(ball.getBounds().width, 76);assert.equal(ball.getBounds().height, 76);
  });
}

test('floating ball preference selects the startup window', async () => {
  const ballFirst = harness();
  ballFirst.start();
  await until(() => ballFirst.api.isReady() && ballFirst.api.getWindows().ball?.isVisible());
  assert.equal(ballFirst.api.getWindows().main.isVisible(), false);
  assert.equal(ballFirst.api.getWindows().ball.isVisible(), true);
  ballFirst.api.getWindows().main.destroy();ballFirst.api.getWindows().ball.destroy();

  const mainFirst = harness({ settings: { showFloatingBall: false } });
  mainFirst.start();
  await until(() => mainFirst.api.isReady() && mainFirst.api.getWindows().main?.isVisible());
  assert.equal(mainFirst.api.getWindows().main.isVisible(), true);
  assert.equal(mainFirst.api.getWindows().ball.isVisible(), false);
});

test('a fresh install and an unfinished run show the main window for the first-run flow', async () => {
  for (const portableState of [null, { version: 1, students: [], settings: { onboardingCompleted: false } }]) {
    const ctx = harness({ portableState });
    ctx.start();
    await until(() => ctx.api.isReady() && ctx.api.getWindows().main?.isVisible());
    assert.equal(ctx.api.getWindows().main.isVisible(), true);
    assert.equal(ctx.api.getWindows().ball.isVisible(), false);
  }
});

test('a migrated profile, a finished profile and an unreadable state leave the ball first', async () => {
  // A migrated profile without portable state defers to the renderer, which asks for
  // the main window itself once it knows the data needs the flow.
  const migrated = harness({ portableState: null, migrated: true });
  migrated.start();
  await until(() => migrated.api.isReady() && migrated.api.getWindows().ball?.isVisible());
  assert.equal(migrated.api.getWindows().main.isVisible(), false);

  const finished = harness({ portableState: { version: 1, students: [], settings: { onboardingCompleted: true } } });
  finished.start();
  await until(() => finished.api.isReady() && finished.api.getWindows().ball?.isVisible());
  assert.equal(finished.api.getWindows().main.isVisible(), false);

  const unreadable = harness({ portableLoadError: Error('portable state is corrupt') });
  unreadable.start();
  await until(() => unreadable.api.isReady() && unreadable.api.getWindows().ball?.isVisible());
  assert.equal(unreadable.api.getWindows().main.isVisible(), false);
});

test('an upgrade relaunch carries the migration decision instead of claiming a fresh install', async () => {
  const relaunchArgs = ctx => ctx.privilegeArgs.at(-1);

  const upgraded = harness({ portableState: null, migrated: true, settings: { uac: true, manualElevation: 'uac' }, relaunch: { started: false, cancelled: true } });
  upgraded.start();
  await until(() => upgraded.api.isReady());
  assert.ok(relaunchArgs(upgraded).includes('--slate-data-migrated'));
  // The child of an upgrade keeps the ball-first startup the parent chose.
  assert.equal(upgraded.api.getWindows().main.isVisible(), false);
  assert.equal(upgraded.api.getWindows().ball.isVisible(), true);

  const fresh = harness({ portableState: null, settings: { uac: true, manualElevation: 'uac' }, relaunch: { started: false, cancelled: true } });
  fresh.start();
  await until(() => fresh.api.isReady());
  assert.equal(relaunchArgs(fresh).includes('--slate-data-migrated'), false);
  assert.ok(relaunchArgs(fresh).includes('--slate-show-main'));
});

test('tray checkbox callback toggles the floating ball and stays synchronized with saved preferences', async () => {
  // The mock's click is the template callback; Electron's native wrapper has
  // already applied the new checked state before invoking it in the real menu.
  const ctx = harness();
  ctx.start();
  await until(() => ctx.api.isReady() && ctx.api.getWindows().ball?.isVisible());
  const item = ctx.api.getTrayMenu().getMenuItemById('show-floating-ball');
  assert.equal(item.type, 'checkbox');
  assert.equal(item.checked, true);
  item.checked = false;item.click(item);
  await until(() => ctx.api.state().settings.showFloatingBall === false && !ctx.api.getWindows().ball.isVisible());
  assert.equal(item.checked, false);
  assert.equal(ctx.api.getWindows().main.isVisible(), false);
  item.checked = true;item.click(item);
  await until(() => ctx.api.state().settings.showFloatingBall === true && ctx.api.getWindows().ball.isVisible());
  assert.equal(item.checked, true);
});

test('floating ball preference hides and restores a visible ball without opening the main window', async () => {
  const ctx = harness();
  ctx.start();
  await until(() => ctx.api.isReady() && ctx.api.getWindows().ball?.isVisible());
  const { ball, main } = ctx.api.getWindows();
  const disabled = await ctx.invoke('slate:settings', ctx.event(), { showFloatingBall: false });
  assert.equal(disabled.settings.showFloatingBall, false);
  assert.equal(ball.isVisible(), false);
  assert.equal(main.isVisible(), false);
  const enabled = await ctx.invoke('slate:settings', ctx.event(), { showFloatingBall: true });
  assert.equal(enabled.settings.showFloatingBall, true);
  assert.equal(ball.isVisible(), true);
  assert.equal(main.isVisible(), false);
});

test('collapsed display reflow derives the new edge from current position, not the previous dock anchor', async () => {
  const ctx = harness();ctx.start();await until(() => ctx.api.isReady());
  const { ball } = ctx.api.getWindows(), area = ctx.screen.getDisplayMatching(ball.getBounds()).workArea;
  ball.setBounds({ x: area.x + 8, y: 130, width: 75, height: 77 });
  ctx.screen.emit('display-metrics-changed');
  assert.equal(ctx.api.state().ball.snap, 'left');assert.equal(ball.getBounds().x, area.x);
  ball.setBounds({ x: area.x + area.width - 84, y: 170, width: 77, height: 75 });
  ctx.screen.emit('display-metrics-changed');
  assert.equal(ctx.api.state().ball.snap, 'right');
  assert.equal(ball.getBounds().x + ball.getBounds().width, area.x + area.width);
  assert.equal(ball.getBounds().height, 76);
});

const drawScripts = main => main.webContents.scripts.filter(script => script.includes('__slateTriggerDraw'));
const protocolEvents = (main, channel) => main.webContents.sent.filter(([name]) => name === channel);

test('default launch reconciles only the enabled app protocol group once', async () => {
  const ctx = harness();
  ctx.start();
  await until(() => ctx.api.isReady());
  assert.deepEqual(ctx.protocolCalls, [['app', true]]);
});

test('verification mode never touches the protocol service', async () => {
  const ctx = harness({ args: ['--slate-qa'] });
  ctx.start();
  await until(() => ctx.api.isReady());
  assert.deepEqual(ctx.protocolCalls, []);
});

test('cold start pick opens main and forces a draw even when the ball click preference is off', async () => {
  const ctx = harness({ args: ['slaterandom://pick'] });
  ctx.start();
  await until(() => ctx.api.isReady() && ctx.api.getWindows().main.isVisible());
  const { main, ball } = ctx.api.getWindows();
  await until(() => drawScripts(main).length === 1);
  assert.equal(ball.isVisible(), false);
  assert.equal(ctx.api.state().settings.drawOnBallClick, false);
});

test('a plain default launch never runs the draw script', async () => {
  const ctx = harness();
  ctx.start();
  await until(() => ctx.api.isReady());
  await settle();
  const { main, ball } = ctx.api.getWindows();
  assert.deepEqual(drawScripts(main), []);
  assert.equal(ball.isVisible(), true);
});

test('second-instance main commands toggle native visibility and ignore missing actions', async () => {
  const ctx = harness();
  ctx.start();
  await until(() => ctx.api.isReady());
  const { main, ball } = ctx.api.getWindows();
  ctx.app.emit('second-instance', {}, ['slaterandom://main/hide']);
  await settle();
  assert.equal(main.isVisible(), false);
  assert.equal(ball.isVisible(), true);
  ctx.app.emit('second-instance', {}, ['slaterandom://main/show']);
  await until(() => main.isVisible() && !ball.isVisible());
  ctx.app.emit('second-instance', {}, ['slaterandom://main']);
  await settle();
  assert.equal(main.isVisible(), true);
  assert.equal(ball.isVisible(), false);
});

test('second-instance settings commands open, close and toggle the settings surface', async () => {
  const ctx = harness();
  ctx.start();
  await until(() => ctx.api.isReady());
  const { main } = ctx.api.getWindows();
  const command = action => main.webContents.scripts.filter(script =>
    script.includes(`new CustomEvent("slate:settings-command", { detail: {"action":"${action}"} })`));
  ctx.app.emit('second-instance', {}, ['slaterandom://settings/show']);
  await until(() => command('open').length === 1);
  assert.equal(main.isVisible(), true);
  ctx.app.emit('second-instance', {}, ['slaterandom://settings/hide']);
  await until(() => command('close').length === 1);
  ctx.app.emit('second-instance', {}, ['slaterandom://main/hide']);
  await until(() => !main.isVisible());
  ctx.app.emit('second-instance', {}, ['slaterandom://settings/hide']);
  await settle();
  assert.equal(command('close').length, 1);
  ctx.app.emit('second-instance', {}, ['slaterandom://settings/toggle']);
  await until(() => command('toggle').length === 1);
  assert.equal(main.isVisible(), true);
});

test('ball commands update the saved preference and the native ball visibility', async () => {
  const ctx = harness();
  ctx.start();
  await until(() => ctx.api.isReady() && ctx.api.getWindows().ball.isVisible());
  const { main, ball } = ctx.api.getWindows();
  ctx.app.emit('second-instance', {}, ['slaterandom://ball/hide']);
  await until(() => ctx.api.state().settings.showFloatingBall === false && !ball.isVisible());
  assert.equal(main.isVisible(), false);
  ctx.app.emit('second-instance', {}, ['slaterandom://ball/show']);
  await until(() => ctx.api.state().settings.showFloatingBall === true && ball.isVisible());
  ctx.app.emit('second-instance', {}, ['slaterandom://ball/toggle']);
  await until(() => ctx.api.state().settings.showFloatingBall === false && !ball.isVisible());
});

test('ball click opens without drawing when the preference is off, then forces a draw when main is visible', async () => {
  const ctx = harness();
  ctx.start();
  await until(() => ctx.api.isReady() && ctx.api.getWindows().ball.isVisible());
  const { main } = ctx.api.getWindows();
  ctx.app.emit('second-instance', {}, ['slaterandom://ball/click']);
  await until(() => main.isVisible());
  await settle();
  assert.deepEqual(drawScripts(main), []);
  ctx.app.emit('second-instance', {}, ['slaterandom://ball/click']);
  await until(() => drawScripts(main).length === 1);
});

test('ball click draws on open when the ball click preference is enabled', async () => {
  const ctx = harness({ settings: { drawOnBallClick: true } });
  ctx.start();
  await until(() => ctx.api.isReady() && ctx.api.getWindows().ball.isVisible());
  const { main } = ctx.api.getWindows();
  ctx.app.emit('second-instance', {}, ['slaterandom://ball/click']);
  await until(() => main.isVisible() && drawScripts(main).length === 1);
});

test('second-instance app commands are ignored after the protocol preference is disabled', async () => {
  const ctx = harness({ settings: { slaterandomProtocol: false } });
  ctx.start();
  await until(() => ctx.api.isReady() && ctx.api.getWindows().ball.isVisible());
  const { main, ball } = ctx.api.getWindows();
  const scriptCount = main.webContents.scripts.length;
  assert.deepEqual(ctx.protocolCalls, []);
  ctx.app.emit('second-instance', {}, ['slaterandom://ball/hide']);
  await settle();
  assert.equal(ctx.api.state().settings.showFloatingBall, true);
  assert.equal(ball.isVisible(), true);
  assert.equal(main.webContents.scripts.length, scriptCount);
});

test('path import reads an absolute file and forwards name, kind and bytes', async () => {
  const bytes = Buffer.from('abcdefghijklmnop');
  const ctx = harness({ stat: () => ({ isFile: () => true, size: bytes.length }), readFile: () => bytes });
  ctx.start();
  await until(() => ctx.api.isReady());
  const { main } = ctx.api.getWindows();
  ctx.app.emit('second-instance', {}, ['slaterandom://import?kind=all&source=path&path=%2Ftmp%2Fx.slate&name=renamed.slate']);
  await until(() => protocolEvents(main, 'slate:import-request').length === 1);
  const payload = protocolEvents(main, 'slate:import-request')[0][1];
  assert.equal(payload.kind, 'all');
  assert.equal(payload.name, 'renamed.slate');
  assert.equal(payload.bytes.byteLength, bytes.length);
});

test('path import rejects a relative path with a protocol notice', async () => {
  const ctx = harness();
  ctx.start();
  await until(() => ctx.api.isReady());
  const { main } = ctx.api.getWindows();
  ctx.app.emit('second-instance', {}, ['slaterandom://import?kind=all&source=path&path=relative.slate']);
  await until(() => main.webContents.scripts.some(script => script.includes('slate:protocol-notice')));
  assert.deepEqual(protocolEvents(main, 'slate:import-request'), []);
});

test('clipboard import accepts a valid envelope and reports an invalid one', async () => {
  const bytes = Buffer.from('clipboard-backup');
  const envelope = JSON.stringify({ format: FORMAT, version: VERSION, kind: 'all', name: 'clip.slate', data: bytes.toString('base64') });
  const valid = harness({ clipboardText: envelope });
  valid.start();
  await until(() => valid.api.isReady());
  const validMain = valid.api.getWindows().main;
  valid.app.emit('second-instance', {}, ['slaterandom://import?kind=all&source=clipboard']);
  await until(() => protocolEvents(validMain, 'slate:import-request').length === 1);
  const payload = protocolEvents(validMain, 'slate:import-request')[0][1];
  assert.equal(payload.kind, 'all');
  assert.equal(payload.name, 'clip.slate');
  assert.equal(payload.bytes.byteLength, bytes.length);

  const invalid = harness({ clipboardText: '{"format":"other"}' });
  invalid.start();
  await until(() => invalid.api.isReady());
  const invalidMain = invalid.api.getWindows().main;
  invalid.app.emit('second-instance', {}, ['slaterandom://import?kind=all&source=clipboard']);
  await until(() => invalidMain.webContents.scripts.some(script => script.includes('slate:protocol-notice')));
  assert.deepEqual(protocolEvents(invalidMain, 'slate:import-request'), []);
});

test('picker import delivers the chosen file and stays silent when cancelled', async () => {
  const chosen = harness({ openDialog: async () => ({ canceled: false, filePaths: ['/tmp/x.slate'] }) });
  chosen.start();
  await until(() => chosen.api.isReady());
  const chosenMain = chosen.api.getWindows().main;
  chosen.app.emit('second-instance', {}, ['slaterandom://import?kind=all&source=picker']);
  await until(() => protocolEvents(chosenMain, 'slate:import-request').length === 1);
  const payload = protocolEvents(chosenMain, 'slate:import-request')[0][1];
  assert.equal(payload.kind, 'all');
  assert.equal(payload.name, 'x.slate');
  assert.equal(payload.bytes.byteLength, Buffer.byteLength('backup-bytes'));

  const cancelled = harness({ openDialog: async () => ({ canceled: true, filePaths: [] }) });
  cancelled.start();
  await until(() => cancelled.api.isReady());
  const cancelledMain = cancelled.api.getWindows().main;
  cancelled.app.emit('second-instance', {}, ['slaterandom://import?kind=all&source=picker']);
  await until(() => cancelledMain.isVisible());
  await settle();
  assert.deepEqual(protocolEvents(cancelledMain, 'slate:import-request'), []);
  assert.equal(cancelledMain.webContents.scripts.some(script => script.includes('slate:protocol-notice')), false);
});

test('UIAccess relaunch carries the pending SlateRandom command', async () => {
  const ctx = harness({ settings: { uac: true, manualElevation: 'uac' }, args: ['slaterandom://pick'],
    relaunch: { started: false, cancelled: true } });
  ctx.start();
  await until(() => ctx.api.isReady());
  const args = ctx.privilegeArgs.at(-1);
  const value = args.find(argument => argument.startsWith('--slate-app-command='))?.slice('--slate-app-command='.length);
  assert.ok(value);
  assert.deepEqual(decodeAppCommand(value), { command: 'pick' });
});

test('a relaunched child executes its encoded app command', async () => {
  const ctx = harness({ args: ['--slate-app-command=' + encodeAppCommand({ command: 'ball', action: 'hide' })] });
  ctx.start();
  await until(() => ctx.api.isReady() && ctx.api.state().settings.showFloatingBall === false);
  assert.equal(ctx.api.getWindows().ball.isVisible(), false);
});

test('startup app group failure disables the app switch and drops the pending pick', async () => {
  const ctx = harness({ args: ['slaterandom://pick'],
    protocolApply: (group, enabled) => group === 'app' && enabled ? { ok: false, error: 'reg denied' } : { ok: true } });
  ctx.start();
  await until(() => ctx.api.isReady() && ctx.api.getWindows().main.isVisible());
  await settle();
  assert.equal(ctx.api.state().settings.slaterandomProtocol, false);
  assert.match(ctx.api.state().runtime.error, /reg denied/);
  assert.deepEqual(ctx.protocolCalls, [['app', true], ['app', false]]);
  assert.deepEqual(drawScripts(ctx.api.getWindows().main), []);
  assert.equal(ctx.effects.some(effect => effect[0] === 'persist'), true);
});

test('startup external group failure leaves the app protocol independently enabled', async () => {
  const ctx = harness({ settings: { externalDrawProtocols: true },
    protocolApply: (group, enabled) => group === 'external' && enabled ? { ok: false, error: 'ext denied' } : { ok: true } });
  ctx.start();
  await until(() => ctx.api.isReady());
  assert.equal(ctx.api.state().settings.externalDrawProtocols, false);
  assert.equal(ctx.api.state().settings.slaterandomProtocol, true);
  assert.match(ctx.api.state().runtime.error, /ext denied/);
  assert.deepEqual(ctx.protocolCalls, [['external', true], ['external', false], ['app', true]]);
});
