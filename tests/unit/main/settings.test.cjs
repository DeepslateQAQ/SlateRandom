const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {patchSettings,createSettingsStore,normalizeSettings}=require('../../../src/main/settings.cjs');
test('UIAccess requires explicit UAC; disabling UAC also disables UIAccess',()=>{
  const initial=normalizeSettings({});assert.throws(()=>patchSettings(initial,{uiAccess:true}),/UAC/);
  const enabled=patchSettings(initial,{uac:true,uiAccess:true});assert.equal(enabled.uiAccess,true);
  assert.deepEqual(patchSettings(enabled,{uac:false}),{autostart:false,uac:false,uiAccess:false,showFloatingBall:true,manualElevation:'uac',autostartElevation:'uac'});
  assert.throws(()=>patchSettings(initial,{executable:'arbitrary.exe'}),/桌面设置/);
  assert.equal(patchSettings(initial,{autostartElevation:'task'}).autostartElevation,'task');
  assert.throws(()=>patchSettings(initial,{autostartElevation:'system'}),/启动方式/);
});
test('floating ball defaults on and persists independently of startup', () => {
  const initial = normalizeSettings({});
  assert.equal(initial.showFloatingBall, true);
  assert.equal(normalizeSettings({ showFloatingBall: false }).showFloatingBall, false);
  assert.equal(patchSettings(initial, { showFloatingBall: false }).showFloatingBall, false);
  assert.equal(patchSettings(initial, { showFloatingBall: false }).autostart, false);
  assert.throws(() => patchSettings(initial, { showFloatingBall: 'yes' }), /桌面设置/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-floating-ball-'));
  try {
    const store = createSettingsStore(dir);
    store.write(patchSettings(initial, { showFloatingBall: false }));
    assert.equal(createSettingsStore(dir).settings.showFloatingBall, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('manual compatibility preference migrates independently and survives reopening without enabling startup', () => {
  const legacy = normalizeSettings({ uac: true, autostartElevation: 'task' });
  assert.equal(legacy.manualElevation, 'uac');
  const next = patchSettings(legacy, { manualElevation: 'compatibility' });
  assert.equal(next.autostart, false); assert.equal(next.autostartElevation, 'task');
  assert.equal(next.uac, true); assert.equal(next.uiAccess, false);
  assert.throws(() => patchSettings(next, { manualElevation: 'task' }), /启动方式/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-manual-elevation-'));
  try {
    createSettingsStore(dir).write(next);
    assert.deepEqual(createSettingsStore(dir).settings, next);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('desktop preferences and ball position persist separately from classroom state',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'slate-settings-'));
  try{const a=createSettingsStore(dir);a.write({autostart:true,uac:true,uiAccess:true});a.position({x:-880,y:206});const b=createSettingsStore(dir);assert.deepEqual(b.settings,a.settings);assert.deepEqual(b.ball,{x:-880,y:206});assert.equal(fs.readdirSync(dir).length,1);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

function injectedStore(directory, fault) {
  const module = { exports: {} };
  const injectedFs = Object.create(fs);
  for (const method of ['mkdirSync', 'writeFileSync', 'renameSync']) {
    injectedFs[method] = (...args) => {
      fault(method);
      return fs[method](...args);
    };
  }
  const source = fs.readFileSync(path.join(__dirname, '../../../src/main/settings.cjs'), 'utf8');
  require('node:vm').compileFunction(source, ['require', 'module'])(id => id === 'node:fs' ? injectedFs : require(id), module);
  return module.exports.createSettingsStore(directory);
}

for (const operation of ['write', 'position']) for (const failedMethod of ['mkdirSync', 'writeFileSync', 'renameSync']) {
  test(`${operation}: ${failedMethod} failure preserves getters and last successfully published disk document`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-settings-fault-'));
    let fail = false;
    try {
      const store = injectedStore(dir, method => { if (fail && method === failedMethod) throw Error('injected EACCES'); });
      store.write({ autostart: true, uac: true, uiAccess: true });
      store.position({ x: -125, y: 212 });
      const settings = store.settings, ball = store.ball;
      const document = fs.readFileSync(path.join(dir, 'desktop-settings.json'), 'utf8');
      fail = true;
      assert.throws(() => operation === 'write' ? store.write({ autostart: false }) : store.position({ x: 700, y: -80 }), /EACCES/);
      assert.deepEqual(store.settings, settings);
      assert.deepEqual(store.ball, ball);
      assert.equal(fs.readFileSync(path.join(dir, 'desktop-settings.json'), 'utf8'), document);
      const reopened = createSettingsStore(dir);
      assert.deepEqual(reopened.settings, settings);
      assert.deepEqual(reopened.ball, ball);
      fail = false;
      // A later unrelated write must not silently publish the previously failed candidate.
      if (operation === 'write') {
        store.position({ x: 55.4, y: -66.7 });
        assert.deepEqual(createSettingsStore(dir).settings, settings);
        assert.deepEqual(store.ball, { x: 55, y: -67 });
      } else {
        store.write({ autostart: false });
        assert.deepEqual(createSettingsStore(dir).ball, ball);
        assert.equal(store.settings.autostart, false);
      }
      const leakedSettings = store.settings, leakedBall = store.ball;
      leakedSettings.autostart = !leakedSettings.autostart;
      leakedBall.x = 99999;
      const final = createSettingsStore(dir);
      assert.deepEqual(store.settings, final.settings);
      assert.deepEqual(store.ball, final.ball);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const rollbackFails of [false, true]) {
  test(`cancelled relaunch preserves last successful preference document when rollback failure=${rollbackFails}`, async () => {
    const { applyDesktopSettings } = require('../../../src/main/settings-update.cjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-settings-compensation-'));
    let writes = 0;
    try {
      const store = injectedStore(dir, method => {
        if (method === 'renameSync' && ++writes === 3 && rollbackFails) throw Error('rollback rename denied');
      });
      store.write({ autostart: false });
      const previous = store.settings, next = { ...previous, autostart: true };
      let native = previous;
      const outcome = await applyDesktopSettings({ previous, next,
        applyStartup: async target => { native = target; return { ok: true }; },
        persist: target => store.write(target),
        relaunch: async () => ({ started: false, cancelled: true })
      });
      assert.equal(outcome.started, false);
      assert.equal(native, previous);
      assert.match(outcome.error, /取消/);
      if (rollbackFails) assert.match(outcome.error, /rollback rename denied/);
      assert.deepEqual(store.settings, rollbackFails ? next : previous);
      assert.deepEqual(createSettingsStore(dir).settings, store.settings);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
