'use strict';
const { app, BrowserWindow, ipcMain, screen, dialog, session, Tray, Menu, shell, clipboard } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createSettingsStore, patchSettings } = require('./settings.cjs');
const { applyDesktopSettings } = require('./settings-update.cjs');
const { createPrivilegeService } = require('./privileges.cjs');
const { createParentHandoff, connectChildHandoff } = require('./handoff.cjs');
const { waitForWindowReady } = require('./window-ready.cjs');
const { createNativeLog } = require('./diagnostics.cjs');
const G = require('./geometry.cjs');
const { ballShape } = require('./ball-shape.cjs');
const { preparePortableLocation } = require('./portable-location.cjs');
const { createPortableStore } = require('./portable-data.cjs');
const { needsOnboarding } = require('./onboarding.cjs');
const { installDataService } = require('./data-service.cjs');
const { createZOrderKeeper } = require('./z-order.cjs');
const { createEdgeTtsService } = require('./edge-tts.cjs');
const { createBallDrag } = require('./ball-drag.cjs');
const { parseDrawRequest, hasDrawProtocolScheme } = require('./draw-protocol.cjs');
const { parseAppProtocol, encodeAppCommand, decodeAppCommand, hasAppProtocolScheme } = require('./app-protocol.cjs');
const { createProtocolRegistration } = require('./protocol-registration.cjs');
const { createWindowsProtocolRegistry } = require('./windows/protocol-registry.cjs');
const { PROTOCOL_GROUPS } = require('./protocol-schemes.cjs');
const { parseClipboardEnvelope, backupNameAllowed, MAX_BACKUP_BYTES } = require('./backup-import.cjs');
const flag = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const qaMode = process.argv.includes('--slate-qa'), hidden = process.argv.includes('--slate-hidden');
const root = path.resolve(__dirname, '../..');
const devUrl = (() => {
  if (app.isPackaged || process.env.SLATE_DEV_URL === undefined) return null;
  const value = process.env.SLATE_DEV_URL;
  let url;
  try { url = new URL(value); } catch { throw Error('SLATE_DEV_URL 必须是开发启动器的本机 HTTP 地址。'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash || value.includes('#')) throw Error('SLATE_DEV_URL 必须是无用户信息或片段的本机 HTTP 地址。');
  return url.href;
})();
const appEntry = __filename;
// Keep the Windows startup/profile identity stable across the display rename.
app.setName('SlateRandom');
app.setAppUserModelId('io.slaterandom.app');
const qaData = flag('--slate-user-data');
const directory = qaData && path.isAbsolute(qaData) ? qaData : path.join(app.isPackaged ? path.dirname(process.execPath) : root, 'data');
const legacyDirectory = flag('--slate-legacy-data') || (!qaData ? path.join(app.getPath('appData'), 'SlateRandom') : undefined);
let dataLocation = { directory, browserDirectory: path.join(directory, 'browser'), migrated: false }, bootstrapError = null;
try { dataLocation = preparePortableLocation({ directory, legacyDirectory }); }
catch (error) { bootstrapError = error; }
// A privilege relaunch inherits the parent's upgrade decision; the child's own
// location check runs before the parent finished migrating and reports false.
if (process.argv.includes('--slate-data-migrated')) dataLocation = { ...dataLocation, migrated: true };
app.setPath('userData', directory);
const persistentSessionPath = dataLocation.browserDirectory;
try { fs.mkdirSync(persistentSessionPath, { recursive: true }); }
catch (error) { bootstrapError ||= error; }
// Chromium may initialize its default profile before the first BrowserWindow.
// Keep even that profile separate until the original browser has fully exited.
if (flag('--slate-handoff-pipe') && flag('--slate-handoff-token')) {
  app.setPath('sessionData', fs.mkdtempSync(path.join(os.tmpdir(), 'SlateRandom-handoff-')));
} else app.setPath('sessionData', persistentSessionPath);
const store = createSettingsStore(app.getPath('userData'));
const portableStore = createPortableStore({ directory });
const edgeTts = createEdgeTtsService({ cacheDirectory: path.join(directory, 'cache', 'tts') });
const engine = require('../shared/domain/engine.js');
// UIAccess tokens cannot use every DirectComposition presentation path. Keep
// accelerated rasterization while bypassing that Windows surface path.
// The explicit software option remains available for driver troubleshooting.
const softwareRendering = flag('--slate-renderer') === 'software';
if (softwareRendering) app.disableHardwareAcceleration();
else if (store.settings.uiAccess) app.commandLine.appendSwitch('disable-direct-composition');
const log = createNativeLog(app.getPath('userData'));
const helperPath = app.isPackaged ? path.join(process.resourcesPath, 'windows', 'SlateRandom.Privileges.exe') : path.join(root, 'build/windows/SlateRandom.Privileges.exe');
const launchArgs = app.isPackaged ? [] : [appEntry];
if (softwareRendering) launchArgs.push('--slate-renderer=software');
const nativeWorkingDirectory = app.isPackaged ? path.dirname(process.execPath) : root;
if (qaData) {
  launchArgs.push('--slate-user-data=' + qaData);
  if (flag('--slate-legacy-data')) launchArgs.push('--slate-legacy-data=' + flag('--slate-legacy-data'));
  // Keep an explicitly requested private diagnostic session reachable after a
  // real elevation. Ordinary app launches never enable remote debugging.
  if (flag('--log-file')) launchArgs.push('--log-file=' + flag('--log-file'));
  if (flag('--remote-debugging-port')) {
    const port = Number(flag('--remote-debugging-port'));
    // The original browser keeps its port until the replacement is visible.
    // Private diagnostic profiles use the next port for each handoff.
    if (Number.isInteger(port) && port >= 0 && port < 65535) launchArgs.push('--remote-debugging-port=' + (port ? port + 1 : 0));
  }
  if (process.argv.some(value => value.startsWith('--enable-logging'))) launchArgs.push('--enable-logging=file');
}
const privilege = createPrivilegeService({ helperPath, executable: process.execPath, baseArgs: launchArgs, workingDirectory: nativeWorkingDirectory });
const childPipe = flag('--slate-handoff-pipe'), childToken = flag('--slate-handoff-token');
const handoffChild = childPipe && childToken ? connectChildHandoff({ pipe: childPipe, token: childToken }) : null;
const handoffParentPid = Number(flag('--slate-handoff-parent-pid'));
const protocolRegistration = createProtocolRegistration({
  store,
  registry: process.platform === 'win32' ? createWindowsProtocolRegistry({ executable: process.execPath, baseArgs: launchArgs }) : null,
  platform: process.platform,
  log
});
const windowReady = new WeakMap(), windowIdentity = new WeakMap();
let main, ball, native = { elevated: false, uiAccess: false }, snap = 'none', confirming = false;
let quitting = false, pendingSettings = false, opacityRun = 0, ballRun = 0, nativeError = store.warning, windowsReady = false;
let renderingSession = null, handoffAccepted = false;
let tray = null, trayMenu = null, mainConfirming = false;
let zOrderKeeper = null;
let settings = store.settings, autostart = null;
// Portable data still unavailable at a mutating step means the renderer shows
// its recovery surface, so the launch must not claim a first run then.
const onboardingPendingAtLaunch = (() => {
  try { return needsOnboarding(portableStore.load(), { migrated: dataLocation.migrated }); }
  catch { return false; }
})();
// A protocol call is an intent, not an immediate action: it is remembered here
// and consumed once the windows, the tray and the renderer contract exist.
const protocolRequest = parseDrawRequest(process.argv);
let pendingExternalDraw = protocolRequest && settings.externalDrawProtocols ? protocolRequest : null;
if (settings.externalDrawProtocols && process.argv.includes('--slate-protocol-draw')) {
  pendingExternalDraw = pendingExternalDraw || { protocol: 'relaunch', route: '' };
}
const appProtocolRequest = parseAppProtocol(process.argv);
let pendingAppQueue = appProtocolRequest && settings.slaterandomProtocol ? [appProtocolRequest] : [];
const relaunchCommand = process.argv.find(value => value.startsWith('--slate-app-command='));
if (relaunchCommand && settings.slaterandomProtocol) {
  const command = decodeAppCommand(relaunchCommand.slice('--slate-app-command='.length));
  if (command) pendingAppQueue.push(command);
}
let appProtocolReady = false, drawTriggerPending = false, protocolActivationRunning = false;
let showMainRequested = process.argv.includes('--slate-show-main')
  || settings.showFloatingBall === false
  || onboardingPendingAtLaunch
  || Boolean(pendingExternalDraw)
  || pendingAppQueue.some(appCommandNeedsMain);
// Electron's setPosition can feed its adjusted GetBounds size back into the
// Windows move operation at fractional DPI. Always use the intended ball size.
function positionBall(win, x, y) { win.setBounds({ x, y, width: G.BALL_SIZE, height: G.BALL_SIZE }); }
const ballDrag = createBallDrag({ getWindow: () => ball, screen, positionWindow: positionBall,
  onStart() { ballRun++;snap = 'none';broadcast(); },
  async onEnd(cancelled) {
    if (cancelled) { store.position(ball.getBounds());broadcast();return; }
    const bounds = ball.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
    // Native bounds may be DPI-rounded; normalize size without reusing the old
    // dock anchor, then derive the destination from the released position.
    const next = G.snapBall(G.confirmBounds(bounds, area, 'none', false), area);
    snap = next.snap;broadcast();await animateBall(next.bounds);
  } });
log('process-start', { handoff: Boolean(handoffChild), showMain: process.argv.includes('--slate-show-main'), onboardingPending: onboardingPendingAtLaunch, softwareRendering });
if (!handoffChild && !app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', (_event, argv = []) => handleSecondInstance(argv));
  app.whenReady().then(start).catch(error => {
    log('startup-failed', { error: error.message, code: error.code });
    handoffChild?.dispose(); quitting = true;
    // Never leave a failed transparent HWND occupying the user's touch area.
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
    if ((!handoffChild || handoffAccepted) && !hidden && !qaMode) dialog.showErrorBox('SlateRandom 岩选无法打开窗口', error.message + '\n桌面诊断保存在应用数据目录的 desktop-native.log。');
    console.error(error); app.exit(1);
  });
  app.on('child-process-gone', (_event, details) => log('child-process-gone', { type: details.type, reason: details.reason, exitCode: details.exitCode }));
}

function state() {
  return { settings: { ...settings }, runtime: { elevated: native.elevated, uiAccess: native.uiAccess,
    autostart: settings.autostart, status: native.error ? '权限状态不可用' : native.uiAccess ? 'UIAccess 全局置顶已启用' : native.elevated ? '管理员置顶' : '普通置顶',
    error: nativeError || null, requiresRestart: (native.uiAccess && !settings.uiAccess) || (native.elevated && !settings.uac) },
    main: { confirming: mainConfirming, visible: Boolean(main && !main.isDestroyed() && main.isVisible()) },
    ball: { snap, confirming, dragId: ballDrag.id, width: ball?.getBounds().width || G.BALL_SIZE, height: G.BALL_SIZE } };
}
function broadcast() {
  if (softwareRendering && native.uiAccess && ball && !ball.isDestroyed()) applyBallShape(ball);
  const snapshot = state();
  for (const win of [main, ball]) if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('slate:state-changed', snapshot);
}
function trusted(event, role) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const identity = win && windowIdentity.get(win);
  if (!identity || (win !== main && win !== ball) || (role && identity.role !== role)) throw Error('不允许此窗口执行桌面操作。');
  if (event.senderFrame !== event.sender.mainFrame) throw Error('桌面操作只能来自主页面。');
  const target = event.senderFrame.url;
  if (devUrl) { if (new URL(target).origin !== new URL(devUrl).origin) throw Error('桌面页面来源无效。'); }
  else if (!target.startsWith('file:') || path.resolve(fileURLToPath(new URL(target))) !== path.resolve(root, 'dist', 'index.html')) throw Error('桌面页面来源无效。');
  return win;
}
function isPreview(event) { return windowIdentity.get(BrowserWindow.fromWebContents(event.sender))?.preview === true; }
const EXTERNAL_LINKS = new Set([
  'https://github.com/DeepslateQAQ',
  'https://github.com/SECTL/SecRandom',
  'https://secrandom.sectl.cn',
  'https://github.com/InkCanvasForClass/community',
  'https://iccce.ink'
]);
function isExternalLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && EXTERNAL_LINKS.has(url.href.replace(/\/$/, ''));
  } catch { return false; }
}
function installWindowPolicy(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLink(url)) void shell.openExternal(url).catch(error => log('external-link-failed', { error: error.message }));
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    const own = win.webContents.getURL();
    if (target !== own) event.preventDefault();
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.on('close', event => { if (!quitting) { event.preventDefault(); if (win === main) void hideMain(); else if (!main?.isVisible()) ball.showInactive(); } });
}
function createWindow(role, bounds, preview = false) {
  const isBall = role === 'ball';
  const transparent = isBall ? !(softwareRendering && native.uiAccess) : true;
  const win = new BrowserWindow({ ...bounds, frame: false, resizable: false, maximizable: false, minimizable: false,
    ...(isBall ? { thickFrame: false } : {}),
    fullscreenable: false, alwaysOnTop: true, transparent, backgroundColor: transparent ? '#00000000' : '#000000',
    show: false, hasShadow: false, skipTaskbar: true, focusable: !isBall, title: 'SlateRandom 岩选',
    icon: path.join(root, 'resources/icons/icon.ico'),
    webPreferences: { preload: path.join(root, 'src/preload/preload.cjs'), additionalArguments: ['--slate-role=' + role, ...(preview ? ['--slate-preview'] : [])],
      ...(preview ? { partition: 'slate-handoff-preview' } : renderingSession ? { session: renderingSession } : {}),
      // The hidden ball must suspend its native renderer child; otherwise Windows
      // restores only the no-activate parent and swallows subsequent mouse downs.
      nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: isBall,
      disableHtmlFullscreenWindowResize: true, spellcheck: false } });
  windowIdentity.set(win, Object.freeze({ role, preview }));
  win.removeMenu(); installWindowPolicy(win);
  if (isBall) win.on('focus', () => { if (!win.isDestroyed()) win.blur(); });
  if (isBall && softwareRendering && native.uiAccess) {
    applyBallShape(win);
    win.on('resize', () => applyBallShape(win));
  }
  const ready = waitForWindowReady(win, { role });
  windowReady.set(win, ready);
  void ready.then(() => log('renderer-ready', { role, preview }), error => log('renderer-failed', { role, preview, error: error.message, code: error.code }));
  win.webContents.on('render-process-gone', (_event, details) => log('renderer-exit', { role, reason: details.reason, exitCode: details.exitCode }));
  win.webContents.on('preload-error', (_event, _file, error) => log('preload-error', { role, error: error.message }));
  let loading;
  const query = { slateRole: role, ...(preview ? { slatePreview: 'true' } : {}) };
  if (devUrl) { const url = new URL(devUrl);for (const [key,value] of Object.entries(query)) url.searchParams.set(key,value);loading = win.loadURL(url.href); }
  else loading = win.loadFile(path.join(root, 'dist', 'index.html'), { query });
  void loading.catch(error => log('load-rejected', { role, error: error.message }));
  return win;
}
function applyBallShape(win) {
  if (win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  win.setShape(ballShape({ width, height, snap, confirming }));
}
async function replaceInstance(uiAccess, showMain, protocolDraw = false, appCommand = null) {
  let handoff;
  try {
    handoff = await createParentHandoff({ releaseLock: () => app.releaseSingleInstanceLock(), acquireLock: () => app.requestSingleInstanceLock() });
    log('relaunch-requested', { uiAccess, showMain });
    const args = [...launchArgs, '--slate-relaunched', ...handoff.args, '--slate-handoff-parent-pid=' + process.pid];
    if (showMain) args.push('--slate-show-main');
    // The child cannot see what the parent already consumed, so an outstanding
    // protocol intent travels as a re-encoded command, never as a raw URL.
    if (protocolDraw) args.push('--slate-protocol-draw');
    if (appCommand) args.push('--slate-app-command=' + encodeAppCommand(appCommand));
    // The child cannot see that this launch migrated an old profile, so carry the
    // decision over; otherwise an upgraded user would start on the main window.
    if (dataLocation.migrated) args.push('--slate-data-migrated');
    const service = createPrivilegeService({ helperPath, executable: process.execPath, baseArgs: args, workingDirectory: nativeWorkingDirectory });
    const result = await service.requestRelaunch({ uiAccess });
    if (!result.started) return result;
    log('relaunch-token-ready', { childPid: result.processId, uiAccess: result.uiAccess });
    await handoff.waitForChild(result.processId);
    log('relaunch-windows-visible', { childPid: result.processId });
    return result;
  } catch (error) {
    log('relaunch-failed', { code: error.code, error: error.message });
    return { started: false, cancelled: false, error: '提权后的窗口未能完成显示，已保留原窗口。' + error.message };
  } finally { if (handoff) await handoff.dispose(); }
}
async function start() {
  if (bootstrapError) throw bootstrapError;
  native = await privilege.getStatus();
  log('token-status', { available: native.available, elevated: native.elevated, uiAccess: native.uiAccess, error: native.error });
  if (native.error) nativeError = native.error;
  const { createAutostartService } = require('./autostart.cjs');
  autostart = createAutostartService({ app, helperPath, executable: process.execPath, baseArgs: launchArgs, userData: app.getPath('userData') });
  // Compatibility mode is configured by the user in Windows, never claimed here.
  // Login launches retain their independent UAC/task preference.
  const requestUac = process.argv.includes('--slate-startup') || settings.manualElevation === 'uac';
  const needsPrivilege = (settings.uac && requestUac && !native.elevated && !native.uiAccess) || (settings.uiAccess && !native.uiAccess);
  if (!qaMode && needsPrivilege && !process.argv.includes('--slate-relaunched')) {
    const result = await replaceInstance(settings.uiAccess, showMainRequested, Boolean(pendingExternalDraw), pendingAppQueue[0] || null);
    if (result.started) { log('relaunch-parent-exit');quitting = true;app.quit();return; }
    nativeError = result.cancelled ? 'UAC 授权已取消，当前使用普通置顶。' : result.error;
  }
  // Reconcile each group independently: a failure disables only its own switch,
  // and the main window still appears because the protocol really was invoked.
  if (!qaMode) {
    const errors = [];
    for (const [group, wanted, key] of [
      ['external', settings.externalDrawProtocols, 'externalDrawProtocols'],
      ['app', settings.slaterandomProtocol, 'slaterandomProtocol']
    ]) {
      const entries = store.protocols?.entries;
      const hasBackups = Boolean(entries && PROTOCOL_GROUPS[group].some(scheme => entries[scheme]));
      // A disabled group with nothing to restore must not scan the registry.
      if (!wanted && !hasBackups) continue;
      const outcome = await protocolRegistration.apply(group, wanted);
      if (outcome.ok) continue;
      const label = group === 'external' ? '外部点名协议' : 'SlateRandom 协议';
      errors.push(label + '：' + outcome.error);
      log('protocol-registration-failed', { group, enabled: wanted, error: outcome.error });
      if (!wanted) continue;
      const rollback = await protocolRegistration.apply(group, false);
      if (!rollback.ok) errors.push(label + '：恢复原协议失败：' + rollback.error);
      settings = patchSettings(settings, { [key]: false });
      if (group === 'external') pendingExternalDraw = null;
      else pendingAppQueue = [];
    }
    if (errors.length) {
      nativeError = errors.join('；');
      try { store.write(settings); }
      catch (error) { nativeError += '；保存设置失败：' + error.message; }
    }
  }
  const display = screen.getPrimaryDisplay();
  const initial = store.ball || { x: display.workArea.x + display.workArea.width - G.BALL_SIZE, y: display.workArea.y + Math.round(display.workArea.height * .46) };
  const ballDisplay = screen.getDisplayNearestPoint(initial);
  const position = G.snapBall({ ...initial, width: G.BALL_SIZE, height: G.BALL_SIZE }, ballDisplay.workArea);
  snap = position.snap;
  // A replacement must not open the original Chromium storage while the old
  // browser still owns its LevelDB/IndexedDB locks. Its first render uses an
  // in-memory session; the persistent session is created after the old PID exits.
  main = createWindow('main', G.mainBounds(ballDisplay.workArea), Boolean(handoffChild));
  ball = createWindow('ball', position.bounds, Boolean(handoffChild));
  registerIpc();
  screen.on('display-metrics-changed', reflowDisplays);screen.on('display-removed', reflowDisplays);
  app.on('before-quit', () => { quitting = true;ballDrag.dispose(); });
  await Promise.all([windowReady.get(main), windowReady.get(ball)]);
  windowsReady = true;
  const showWindows = async () => {
    if (!hidden || showMainRequested) {
      if (showMainRequested) await openMain();
      else ball.showInactive();
      log('windows-show-check', { main: main.isVisible(), ball: ball.isVisible(), mainOpacity: main.getOpacity(), ballOpacity: ball.getOpacity() });
      if (showMainRequested ? !main.isVisible() || ball.isVisible() : !ball.isVisible()) throw Error('Windows 未显示新实例的界面。');
    }
    // The request is consumed once: a later show must never replay the draw, and
    // drawOnBallClick still decides whether an external call actually picks.
    if (pendingExternalDraw && (!handoffChild || handoffAccepted)) {
      const request = pendingExternalDraw;
      pendingExternalDraw = null;
      log('protocol-activation', { protocol: request.protocol, route: request.route });
      await triggerDraw();
    }
    log('windows-visible', { main: main.isVisible(), ball: ball.isVisible() }); broadcast();
  };
  if (handoffChild) {
    if (!Number.isSafeInteger(handoffParentPid) || handoffParentPid <= 0 || handoffParentPid === process.pid) throw Error('The original handoff process ID is invalid.');
    for (const win of [main, ball]) await win.webContents.executeJavaScript('document.body.inert = true');
    await handoffChild.handover({ acquireLock: () => app.requestSingleInstanceLock(), show: showWindows });
    handoffAccepted = true;
    const deadline = Date.now() + 10000;
    while (true) {
      try { process.kill(handoffParentPid, 0); }
      catch (error) { if (error.code === 'ESRCH') break; throw error; }
      if (Date.now() >= deadline) throw Error('The original instance has not released its browser storage.');
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    log('profile-released', { parentPid: handoffParentPid });
    renderingSession = session.fromPath(persistentSessionPath);
    const previewMain = main, previewBall = ball;
    windowsReady = false;
    main = createWindow('main', G.mainBounds(ballDisplay.workArea));
    ball = createWindow('ball', position.bounds);
    await Promise.all([windowReady.get(main), windowReady.get(ball)]);
    windowsReady = true;
    await showWindows();
    previewMain.destroy();previewBall.destroy();
    log('persistent-windows-ready');
  } else await showWindows();
  createTray();
  zOrderKeeper = createZOrderKeeper({ getWindows: () => ({ main, ball }), onError: error => log('z-order-refresh-failed', { error: error.message }) });
  app.once('will-quit', () => zOrderKeeper?.dispose());
  // Startup commands run after the windows, tray and z-order keeper exist, so an
  // import picker or a fade can never hold up the first visible frame.
  if (pendingAppQueue.length) {
    const commands = pendingAppQueue;
    pendingAppQueue = [];
    for (const command of commands) {
      log('app-protocol-activation', { command: command.command, action: command.action, kind: command.kind, source: command.source });
      void enqueueAppCommand(command);
    }
  }
  appProtocolReady = true;
}
async function openConfiguration() {
  await openMain();
  if (!main || main.isDestroyed()) return;
  await main.webContents.executeJavaScript(`(() => {
    document.dispatchEvent(new CustomEvent('slate:open-settings'));
  })()`);
}
function createTray() {
  if (tray) return;
  tray = new Tray(path.join(root, 'resources', 'icons', 'icon.ico'));
  tray.setToolTip('SlateRandom 岩选');
  trayMenu = Menu.buildFromTemplate([
    { label: '打开主界面', click: () => { void openMain(); } },
    { id: 'show-floating-ball', label: '显示悬浮球', type: 'checkbox', checked: settings.showFloatingBall,
      click: item => { void updateSettings({ showFloatingBall: item.checked }).finally(syncTrayMenu); } },
    { label: '设置', click: () => { void openConfiguration(); } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true;app.quit(); } }
  ]);
  tray.setContextMenu(trayMenu);
  tray.on('click', () => { void openMain(); });
  app.on('will-quit', () => { tray?.destroy();tray = null; });
}
function reflowDisplays() {
  if (!ball || ball.isDestroyed()) return;
  const display = screen.getDisplayMatching(ball.getBounds());
  const next = G.snapBall(G.confirmBounds(ball.getBounds(),display.workArea,confirming ? snap : 'none',confirming),display.workArea);
  snap = next.snap;ball.setBounds(next.bounds);
  if (main && !main.isDestroyed()) main.setBounds(G.mainBounds(display.workArea));broadcast();
}
async function setRendererOpacity(win, value) {
  if (!win || win.isDestroyed()) return;
  opacityRun++;
  try {
    await win.webContents.executeJavaScript(`(() => {
      window.__slateWindowFade?.cancel(); window.__slateWindowFade = null;
      document.documentElement.style.opacity = '${value}';
      return true;
    })()`);
  } catch {}
}
async function openMain({ draw = false } = {}) {
  showMainRequested = true;
  if (!windowsReady || !main || main.isDestroyed() || !ball || ball.isDestroyed()) return;
  const display = screen.getDisplayMatching(ball.getBounds());main.setBounds(G.mainBounds(display.workArea));
  await windowReady.get(main);
  if (main.isDestroyed()) throw Error('主窗口已经关闭，请重新打开 SlateRandom。');
  ballRun++;ballDrag.dispose();
  if (confirming) {
    confirming = false;
    ball.setBounds(G.confirmBounds(ball.getBounds(), display.workArea, snap, false));
  }
  if (main.isVisible()) {
    ball.hide();broadcast();
    await setRendererOpacity(main, 1);
    if (!main.isDestroyed() && !qaMode) main.focus();
    if (draw) await triggerDraw();
    return;
  }
  // On Windows 10 a transparent window shown with showInactive and native
  // opacity 0 can remain uncomposited despite isVisible() being true. Show it
  // actively and fade the renderer instead of the native window.
  await setRendererOpacity(main, 0);
  main.show();ball.hide();broadcast();
  await rendererOpacity(main,0,1,220);
  if (main.isDestroyed()) return;
  if (!main.isVisible()) main.show();
  if (!qaMode) main.focus();
  if (draw) await triggerDraw();
}
async function hideMain() {
  showMainRequested = false;
  if (!main || main.isDestroyed() || !main.isVisible()) return;
  mainConfirming = false;broadcast();
  if (await rendererOpacity(main,1,0,160)) {
    main.hide();
    await setRendererOpacity(main, 1);
    if (settings.showFloatingBall) ball.showInactive();
    broadcast();
  }
}
/* Protocol intent execution -------------------------------------------------
   Commands arrive from the OS or from a UIAccess relaunch. The renderer contract
   is polled, never assumed, and each command runs serially so two calls can
   never interleave window animations or a draw. */
let appProtocolQueue = Promise.resolve();
async function waitForRendererReady() {
  if (!windowsReady || !main || main.isDestroyed()) return false;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!main || main.isDestroyed()) return false;
    try {
      if (await main.webContents.executeJavaScript('window.__slateRendererReady === true') === true) return true;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  log('renderer-command-timeout');
  return false;
}
async function dispatchRendererEvent(name, detail = {}) {
  if (!await waitForRendererReady()) return false;
  const payload = JSON.stringify(detail);
  try {
    await main.webContents.executeJavaScript(
      `document.dispatchEvent(new CustomEvent(${JSON.stringify(name)}, { detail: ${payload} }))`
    );
    return true;
  } catch (error) {
    log('renderer-event-failed', { name, error: error.message });
    return false;
  }
}
async function triggerDraw({ force = false } = {}) {
  if (!force && !settings.drawOnBallClick) return false;
  if (!windowsReady || !main || main.isDestroyed()) return false;
  if (drawTriggerPending) return false;
  drawTriggerPending = true;
  try {
    if (!await waitForRendererReady()) return false;
    const started = await main.webContents.executeJavaScript('(() => window.__slateTriggerDraw?.() === true)()') === true;
    log('draw-trigger', { started, force });
    return started;
  } catch (error) {
    log('draw-trigger-failed', { error: error.message });
    return false;
  } finally { drawTriggerPending = false; }
}
/** Only these commands need the main window before they can do their work. */
function appCommandNeedsMain(command) {
  if (command.command === 'pick' || command.command === 'import') return true;
  if (command.command === 'main') return command.action === 'show';
  if (command.command === 'settings') return command.action !== 'hide';
  return false; // main hide/toggle, every ball action
}
async function consumeExternalDraw() {
  if (!pendingExternalDraw || protocolActivationRunning) return;
  protocolActivationRunning = true;
  const request = pendingExternalDraw;
  pendingExternalDraw = null;
  try {
    log('protocol-activation', { protocol: request.protocol, route: request.route });
    await openMain();
    await triggerDraw();
  } catch (error) { log('protocol-activation-failed', { error: error.message }); }
  finally { protocolActivationRunning = false; }
}
async function executeAppProtocol(command) {
  // A URL can outlive the setting that enabled it; the stored preference wins.
  if (!settings.slaterandomProtocol) { log('protocol-ignored', { protocol: 'slaterandom', reason: 'disabled' }); return; }
  if (command.command === 'pick') { await openMain(); await triggerDraw({ force: true }); return; }
  if (command.command === 'import') { await openMain(); await requestBackupImport(command); return; }
  if (command.command === 'main') {
    if (command.action === 'show') await openMain();
    else if (command.action === 'hide') await hideMain();
    else if (main?.isVisible()) await hideMain(); else await openMain();
    return;
  }
  if (command.command === 'settings') {
    if (command.action === 'show') { await openMain(); await dispatchRendererEvent('slate:settings-command', { action: 'open' }); }
    else if (command.action === 'hide') { if (main?.isVisible()) await dispatchRendererEvent('slate:settings-command', { action: 'close' }); }
    else { await openMain(); await dispatchRendererEvent('slate:settings-command', { action: 'toggle' }); }
    return;
  }
  if (command.action === 'show') await updateSettings({ showFloatingBall: true });
  else if (command.action === 'hide') await updateSettings({ showFloatingBall: false });
  else if (command.action === 'toggle') await updateSettings({ showFloatingBall: !settings.showFloatingBall });
  else if (main?.isVisible()) await triggerDraw({ force: true });
  else await openMain({ draw: true });
}
function enqueueAppCommand(command) {
  appProtocolQueue = appProtocolQueue.then(() => executeAppProtocol(command)).catch(error => {
    log('app-protocol-failed', { command: command.command, action: command.action, error: error.message });
  });
  return appProtocolQueue;
}
function handleSecondInstance(argv) {
  const appCommand = parseAppProtocol(argv);
  if (appCommand) {
    if (!settings.slaterandomProtocol) { log('protocol-ignored', { protocol: 'slaterandom', reason: 'disabled' }); return; }
    if (quitting) { log('protocol-ignored', { protocol: 'slaterandom', reason: 'quit' }); return; }
    if (appProtocolReady && windowsReady && (!handoffChild || handoffAccepted)) void enqueueAppCommand(appCommand);
    else {
      // Startup commands keep priority: the queue drains in arrival order.
      pendingAppQueue.push(appCommand);
      if (appCommandNeedsMain(appCommand)) showMainRequested = true;
    }
    return;
  }
  if (hasAppProtocolScheme(argv)) { log('protocol-ignored', { protocol: 'slaterandom', reason: 'invalid' }); return; }
  const request = parseDrawRequest(argv);
  if (request) {
    if (!settings.externalDrawProtocols) { log('protocol-ignored', { protocol: request.protocol, reason: 'disabled' }); return; }
    if (quitting) { log('protocol-ignored', { protocol: request.protocol, reason: 'quit' }); return; }
    if (protocolActivationRunning) { log('protocol-ignored', { protocol: request.protocol, reason: 'busy' }); return; }
    pendingExternalDraw = request; showMainRequested = true;
    if (windowsReady && (!handoffChild || handoffAccepted)) void consumeExternalDraw();
    return;
  }
  if (hasDrawProtocolScheme(argv)) { log('protocol-ignored', { protocol: 'external', reason: 'invalid' }); return; }
  showMainRequested = true;
  if (windowsReady) void openMain();
}
async function protocolNotice(message) {
  log('protocol-notice', { message });
  await dispatchRendererEvent('slate:protocol-notice', { message });
}
async function readBackupImport(command) {
  const { kind, source } = command;
  if (source === 'clipboard') return parseClipboardEnvelope(clipboard.readText(), kind);
  let filePath, name;
  if (source === 'picker') {
    const result = await dialog.showOpenDialog(main, {
      title: '选择 SlateRandom 备份',
      properties: ['openFile'],
      filters: [{ name: 'SlateRandom 备份', extensions: kind === 'all' ? ['slate', 'slatebackup', 'json'] : ['json'] }]
    });
    if (result.canceled || !result.filePaths.length) return null;
    filePath = result.filePaths[0];
    name = path.basename(filePath);
  } else {
    if (!path.isAbsolute(command.path)) throw Error('备份路径必须是绝对路径。');
    filePath = command.path;
    name = command.name ? path.basename(command.name) : path.basename(filePath);
  }
  if (!backupNameAllowed(name, kind)) throw Error('备份文件扩展名不受支持。');
  let stat;
  try { stat = await fs.promises.stat(filePath); }
  catch { throw Error('无法读取备份文件或文件不可访问。'); }
  if (!stat.isFile()) throw Error('备份路径不是文件。');
  if (stat.size < 1 || stat.size > MAX_BACKUP_BYTES) throw Error('备份为空或超过 64 MB。');
  let bytes;
  try { bytes = await fs.promises.readFile(filePath); }
  catch { throw Error('无法读取备份文件或文件不可访问。'); }
  if (!bytes.length || bytes.length > MAX_BACKUP_BYTES) throw Error('备份为空或超过 64 MB。');
  return { kind, name, bytes };
}
/** Reads from the requested source only; the renderer always asks for confirmation. */
async function requestBackupImport(command) {
  try {
    const payload = await readBackupImport(command);
    if (!payload) return;
    if (!await waitForRendererReady()) return;
    main.webContents.send('slate:import-request', { kind: payload.kind, name: payload.name, bytes: new Uint8Array(payload.bytes) });
  } catch (error) { await protocolNotice(error.message); }
}
function applyFloatingBallPreference(show) {
  if (!windowsReady || !ball || ball.isDestroyed()) return;
  if (show) {
    if (!main?.isVisible() && !ball.isVisible()) { ball.showInactive(); broadcast(); }
  } else if (ball.isVisible()) {
    ball.hide(); broadcast();
  }
}
function syncTrayMenu() {
  const item = trayMenu?.getMenuItemById?.('show-floating-ball');
  if (item) item.checked = settings.showFloatingBall;
}
async function rendererOpacity(win,from,to,ms) {
  const run = ++opacityRun;
  await win.webContents.executeJavaScript(`(() => {
    const from = ${from === null ? 'Number(getComputedStyle(document.documentElement).opacity)' : from};
    window.__slateWindowFade?.cancel();
    const animation = document.documentElement.animate([{opacity:from},{opacity:${to}}],
      {duration:${ms},easing:'cubic-bezier(.16,1,.3,1)',fill:'forwards'});
    window.__slateWindowFade = animation;
    return animation.finished.then(() => true, () => false);
  })()`);
  return run === opacityRun && !win.isDestroyed();
}
function animateBall(next) {
  const from = ball.getBounds(), run = ++ballRun, start = Date.now();
  return new Promise(resolve => { const frame = () => {
    if (ball.isDestroyed() || run !== ballRun) return resolve();
    const progress = Math.min(1,(Date.now()-start)/260), e=G.eased(progress);
    positionBall(ball,Math.round(from.x+(next.x-from.x)*e),Math.round(from.y+(next.y-from.y)*e));
    if (progress<1) setTimeout(frame,16);else { store.position(next);resolve(); } };frame(); });
}
async function updateSettings(patch) {
  if (pendingSettings) return state();
  const previous = { ...settings };
  pendingSettings = true;nativeError = null;
  try {
    const next = patchSettings(settings, patch);
    const startupChanged = previous.autostart !== next.autostart || (next.autostart && (previous.uac !== next.uac || previous.autostartElevation !== next.autostartElevation));
    const needsElevation = (next.uac && next.manualElevation === 'uac' && !native.elevated && !native.uiAccess) || (next.uiAccess && !native.uiAccess);
    // Only the groups the user actually changed are written; an unrelated save
    // must never rewrite the other group's association.
    const externalChange = previous.externalDrawProtocols !== next.externalDrawProtocols;
    const appChange = previous.slaterandomProtocol !== next.slaterandomProtocol;
    const result = await applyDesktopSettings({ previous, next,
      applyStartup: startupChanged ? async target => {
        if (qaMode) throw Error('验证模式不修改开机启动或计划任务。');
        return autostart.apply(target);
      } : null,
      applyProtocols: externalChange || appChange ? async target => {
        if (qaMode) return { ok: false, error: '验证模式不修改系统协议注册。' };
        if (externalChange) {
          const outcome = await protocolRegistration.apply('external', target.externalDrawProtocols);
          if (!outcome.ok) return outcome;
        }
        if (appChange) return protocolRegistration.apply('app', target.slaterandomProtocol);
        return { ok: true };
      } : null,
      persist(target) { store.write(target);settings = store.settings; },
      relaunch: needsElevation ? async target => {
        if (qaMode) throw Error('验证模式不申请 UAC 或 UIAccess。');
        return replaceInstance(target.uiAccess, true, Boolean(pendingExternalDraw), pendingAppQueue[0] || null);
      } : null });
    nativeError = result.error;
    if (result.started === true) { quitting = true;setTimeout(() => { log('relaunch-parent-exit');app.quit(); }, 120); }
  } catch (error) { nativeError = error.message; }
  finally {
    settings = store.settings;pendingSettings = false;
    syncTrayMenu();
    if (previous.showFloatingBall !== settings.showFloatingBall) applyFloatingBallPreference(settings.showFloatingBall);
    broadcast();
  }
  return state();
}
function registerIpc() {
  const handle=(channel,role,callback)=>ipcMain.handle(channel,(event,...args)=>{trusted(event,role);return callback(...args);});
  handle('slate:state',null,state);
  ipcMain.handle('slate:settings', (event, patch) => {
    trusted(event, 'main');
    if (isPreview(event)) throw Error('交接预览不可修改正式桌面设置。');
    return updateSettings(patch);
  });
  ipcMain.handle('slate:open-main', (event, options) => {
    trusted(event);
    const draw = Boolean(options && typeof options === 'object' && options.draw === true && !isPreview(event));
    return openMain({ draw });
  });
  handle('slate:hide-main','main',hideMain);
  ipcMain.handle('slate:quit', event => {
    const win = trusted(event);
    if (!(win === ball ? confirming : mainConfirming)) throw Error('请先长按关闭按钮或悬浮球确认退出。');
    quitting=true;app.quit();
  });
  handle('slate:quit-confirmation-open','main',()=>{ mainConfirming=true;broadcast(); });
  handle('slate:quit-confirmation-close','main',()=>{ mainConfirming=false;broadcast(); });
  handle('slate:drag-start','ball',input=>{ if (!confirming && ball.isVisible() && !main?.isVisible()) return ballDrag.start(input); });
  ipcMain.on('slate:drag-move',(event,position)=>{try{trusted(event,'ball');if (ball.isVisible() && !main?.isVisible()) ballDrag.move(position);}catch{} });
  handle('slate:drag-end','ball',input=>ballDrag.end(input));
  handle('slate:confirmation-open','ball',()=>{if(ballDrag.active || !ball.isVisible() || main?.isVisible())return;confirming=true;const area=screen.getDisplayMatching(ball.getBounds()).workArea;ball.setBounds(G.confirmBounds(ball.getBounds(),area,snap,true));broadcast();});
  handle('slate:confirmation-close','ball',()=>{confirming=false;const area=screen.getDisplayMatching(ball.getBounds()).workArea;ball.setBounds(G.confirmBounds(ball.getBounds(),area,snap,false));broadcast();});
  handle('slate:speech-synthesize', 'main', ({ text, voice } = {}) => edgeTts.synthesize(text, voice));
  handle('slate:speech-cancel', 'main', () => edgeTts.cancelPending());
  ipcMain.handle('slate:speech-cache-clear', event => {
    trusted(event, 'main');
    if (isPreview(event)) throw Error('交接预览不可清空正式语音缓存。');
    return edgeTts.clearCache();
  });
  installDataService({ ipcMain, trusted, isPreview, store: portableStore, engine, location: dataLocation, dialog, getWindow: () => main });
}

// The QA driver loads this entry as a real app and uses native BrowserWindow
// objects directly. No test-only methods are exposed to application renderers.
module.exports = { state, getWindows: () => ({ main, ball }), getTray: () => tray, getTrayMenu: () => trayMenu,
  ready: () => app.whenReady(), isReady: () => windowsReady && Boolean(tray) };
