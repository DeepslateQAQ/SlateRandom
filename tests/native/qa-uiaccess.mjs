import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { makeScenePerformanceFixture, measureScenePerformance } from './measure-scene-performance.mjs';

// This is an explicit real-permission regression, not part of routine QA.
// It requests one ordinary Windows UAC consent and then a real UIAccess token.
// Only its temporary desktop preferences are changed; startup remains disabled.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const { createPrivilegeService } = require('../../src/main/privileges.cjs');
const { ownedTaskName } = require('../../src/main/autostart.cjs');
const asar = require('@electron/asar');
const output = path.join(root, 'qa-output');
const release = path.join(root, 'release/SlateRandom-win32-x64');
const executable = path.join(release, 'SlateRandom.exe');
const tempParent = await realpath(tmpdir());
const profile = await mkdtemp(path.join(tempParent, 'SlateRandom-uiaccess-'));
const nativeLogPath = path.join(profile, 'desktop-native.log');
const chromiumLogPath = path.join(profile, 'chromium.log');
const checks = [], runtimeErrors = [], screenshots = [], phases = [], geometrySnapshots = [], permissionEvidence = [], clients = new Set(), ownedPids = new Set();
const sha = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (label, value) => { assert.ok(value, label); checks.push(label); console.log('PASS ' + label); };
const privilege = createPrivilegeService({ helperPath: path.join(release, 'resources/windows/SlateRandom.Privileges.exe'), executable, baseArgs: [], workingDirectory: release });
let launched, ports = [], processOutput = '', failure = null, successful = false, finalReport;
let artifactBytes = 0, artifactSha256 = '', executableSha256 = '', appAsarSha256 = '', cleanupConfirmed = false;

class CDP {
  constructor(socket, label) {
    this.socket = socket; this.label = label; this.next = 0; this.pending = new Map(); this.closed = false;
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        message.error ? pending.reject(Error(JSON.stringify(message.error))) : pending.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') {
        runtimeErrors.push({ phase: this.label, error: message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text });
      }
    });
    socket.addEventListener('close', () => this.end(Error(this.label + ' connection closed')));
    socket.addEventListener('error', () => this.end(Error(this.label + ' connection failed')));
    clients.add(this);
  }
  end(error) {
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  close() { this.end(Error(this.label + ' QA connection closed')); this.socket.close(); }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(Error(this.label + ' connection is closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(this.label + ': ' + method + ' timed out')); }, 12000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async evaluate(fn, ...args) {
    const response = await this.send('Runtime.evaluate', {
      expression: '(' + fn.toString() + ').apply(null,' + JSON.stringify(args) + ')', awaitPromise: true, returnByValue: true
    });
    if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  }
}

async function connect(url, label) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(Error(label + ' WebSocket timed out')); }, 12000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(Error(label + ' WebSocket failed')); }, { once: true });
  });
  return new CDP(socket, label);
}

async function waitFor(fn, timeoutMs = 35000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try { const result = await fn(); if (result) return result; }
    catch (error) { lastError = error; }
    await pause(80);
  } while (Date.now() < deadline);
  throw Error(label + ' timed out' + (lastError ? ': ' + lastError.message : ''));
}

async function jsonAt(port, endpoint) {
  const response = await fetch('http://127.0.0.1:' + port + endpoint, { signal: AbortSignal.timeout(1200) });
  if (!response.ok) throw Error('Diagnostic endpoint returned ' + response.status);
  return response.json();
}

async function reserveConsecutivePorts() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const first = randomInt(20000, 55000), listeners = [];
    try {
      for (let offset = 0; offset < 3; offset++) {
        const listener = net.createServer();
        listeners.push(listener);
        await new Promise((resolve, reject) => {
          listener.once('error', reject);
          listener.listen(first + offset, '127.0.0.1', resolve);
        });
      }
      return [first, first + 1, first + 2];
    } catch { /* Try a different private diagnostic port range. */ }
    finally { await Promise.all(listeners.map(listener => new Promise(resolve => listener.listening ? listener.close(resolve) : resolve()))); }
  }
  throw Error('Could not find three consecutive free diagnostic ports.');
}

async function powershell(args, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const command = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { command.kill(); reject(Error('Read-only Windows inspection timed out.')); }, timeoutMs);
    command.stdout.on('data', value => { stdout += value; }); command.stderr.on('data', value => { stderr += value; });
    command.once('error', error => { clearTimeout(timer); reject(error); });
    command.once('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout.replace(/^\uFEFF/, '').trim()) : reject(Error(stderr || 'Windows inspection exited ' + code)); });
  });
}

async function inspectWindows(processId) {
  const result = await powershell(['-File', path.join(root, 'tests/native/inspect-native-windows.ps1'), '-TargetProcessId', String(processId)]);
  const records = JSON.parse(result || '[]');
  return (Array.isArray(records) ? records : [records]).filter(window => window.className === 'Chrome_WidgetWin_1' && window.bounds.width >= 60 && window.bounds.height >= 60);
}

function nativeWindowRoles(windows) {
  const sorted = [...windows].sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height);
  if (sorted.length !== 2 || sorted[0].bounds.height <= sorted[1].bounds.height * 3) return null;
  return { main: sorted[0], ball: sorted[1], sorted };
}

async function waitForNativeVisibility(processId, mainVisible, ballVisible, label, timeoutMs = 35000) {
  return waitFor(async () => {
    const windows = await inspectWindows(processId), roles = nativeWindowRoles(windows);
    return roles && roles.main.isVisible === mainVisible && roles.ball.isVisible === ballVisible ? windows : false;
  }, timeoutMs, label);
}

async function readProcessIdentity(processId) {
  assert.ok(Number.isSafeInteger(processId) && processId > 0);
  const script = `[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);$ErrorActionPreference='Stop';$target=Get-CimInstance Win32_Process -Filter "ProcessId = ${processId}";if(!$target){throw 'The verified application process no longer exists.'};$owner=Invoke-CimMethod -InputObject $target -MethodName GetOwnerSid;ConvertTo-Json -InputObject @{processId=[int]$target.ProcessId;sessionId=[int]$target.SessionId;returnValue=[int]$owner.ReturnValue;userSid=[string]$owner.Sid} -Compress`;
  const identity = JSON.parse(await powershell(['-Command', script]));
  if (identity.processId !== processId || !Number.isSafeInteger(identity.sessionId)) {
    throw Error('The Windows process identity did not match the verified PID.');
  }
  if (identity.returnValue === 2 && !identity.userSid) return { ...identity, ownerUnavailable: 'access-denied' };
  if (identity.returnValue !== 0 || typeof identity.userSid !== 'string' || !/^S-1-\d+(?:-\d+)+$/.test(identity.userSid)) {
    throw Error('Cannot independently verify the elevated process owner through WMI (return ' + identity.returnValue + ', matching PID ' + (identity.processId === processId) + ', SID available ' + Boolean(identity.userSid) + ').');
  }
  return identity;
}

async function livingOwnedPids() {
  if (!ownedPids.size) return [];
  const numbers = [...ownedPids];
  assert.ok(numbers.every(pid => Number.isSafeInteger(pid) && pid > 0));
  const script = `[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);$known=@(${numbers.join(',')});$found=@(Get-CimInstance Win32_Process -Filter "Name = 'SlateRandom.exe'" | Where-Object {$known -contains [int]$_.ProcessId} | Select-Object -ExpandProperty ProcessId);ConvertTo-Json -InputObject $found -Compress`;
  const result = JSON.parse(await powershell(['-Command', script]) || '[]');
  return Array.isArray(result) ? result : [result];
}

async function nativeEvents() {
  const content = await readFile(nativeLogPath, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
  const events = content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  for (const event of events) {
    if (Number.isSafeInteger(event.pid) && event.pid > 0) ownedPids.add(event.pid);
    if (Number.isSafeInteger(event.childPid) && event.childPid > 0) ownedPids.add(event.childPid);
  }
  return events;
}

async function runEntrySnapshot() {
  const script = `[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);$item=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue;$entries=@($item.PSObject.Properties | Where-Object {$_.Name -notmatch '^PS' -and ($_.Name -match 'SlateRandom' -or [string]$_.Value -match 'SlateRandom\\.exe')} | Sort-Object Name | ForEach-Object {@{name=$_.Name;value=[string]$_.Value}});ConvertTo-Json -InputObject $entries -Depth 3 -Compress`;
  return sha(await powershell(['-Command', script]));
}

async function attachPhase(port, label, elevated, uiAccess, timeoutMs) {
  const targets = await waitFor(async () => {
    const all = await jsonAt(port, '/json/list');
    const pages = all.filter(target => target.type === 'page' && !new URL(target.url).searchParams.has('slatePreview'));
    const main = pages.find(target => target.url.includes('slateRole=main'));
    const ball = pages.find(target => target.url.includes('slateRole=ball'));
    if (!main || !ball) return false;
    for (const target of [main, ball]) {
      const url = new URL(target.url); url.search = '';
      if (path.resolve(fileURLToPath(url)) !== path.resolve(release, 'resources/app.asar/dist/index.html')) throw Error('Unexpected diagnostic page source.');
    }
    return { main, ball };
  }, timeoutMs, label + ' replacement diagnostic pages');
  const version = await jsonAt(port, '/json/version');
  const browser = await connect(version.webSocketDebuggerUrl, label + ':browser');
  const processInfo = await browser.send('SystemInfo.getProcessInfo');
  const processId = processInfo.processInfo.find(process => process.type === 'browser')?.id;
  check(label + ' 使用独立真实浏览器进程', Number.isSafeInteger(processId) && processId > 0 && !phases.some(phase => phase.processId === processId));
  ownedPids.add(processId);
  const [main, ball] = await Promise.all([connect(targets.main.webSocketDebuggerUrl, label + ':main'), connect(targets.ball.webSocketDebuggerUrl, label + ':ball')]);
  await Promise.all([main.send('Runtime.enable'), ball.send('Runtime.enable')]);
  await waitFor(() => main.evaluate(() => document.readyState === 'complete' && !!document.getElementById('drawBtn') && window.slateDesktop?.role === 'main'), 35000, label + ' main renderer readiness');
  await waitFor(() => ball.evaluate(() => document.readyState === 'complete' && !!document.getElementById('floatingBallButton') && window.slateDesktop?.role === 'ball'), 35000, label + ' floating-ball renderer readiness');
  check(label + ' 主窗口和悬浮球两个 renderer 均已加载并桥接', await main.evaluate(() => typeof slateDesktop.state === 'function' && typeof window.require === 'undefined') && await ball.evaluate(() => typeof slateDesktop.openMain === 'function' && !document.getElementById('drawBtn')));
  const state = await main.evaluate(() => slateDesktop.state());
  const external = await privilege.getStatus(processId);
  const evidence = { phase: label, processId, source: 'external-helper', external: {
    available: external.available, elevated: external.elevated, uiAccess: external.uiAccess,
    sessionId: external.sessionId, errorCode: external.errorCode, error: external.error || null
  } };
  permissionEvidence.push(evidence);
  console.log('Native token ' + JSON.stringify({ ...evidence, runtime: state.runtime }));
  let actual = external, inspectedWindows = null;
  if (elevated && external.available === true && external.errorCode === 5) {
    // Only the exact medium-to-high token access denial may use this fallback.
    // Bind the real self-helper check to the helper-verified child PID and CDP
    // PID, then independently verify the HWND session and Windows process owner.
    const events = await nativeEvents();
    const self = events.findLast(event => event.pid === processId && event.event === 'token-status');
    const previous = phases.at(-1);
    const parentLaunch = events.findLast(event => event.pid === previous?.processId && event.event === 'relaunch-token-ready' && event.childPid === processId);
    const processStart = events.find(event => event.pid === processId && event.event === 'process-start' && event.handoff === true);
    evidence.source = 'same-PID self-helper + verified parent launch + native HWND session';
    evidence.self = self && { processId: self.pid, available: self.available, elevated: self.elevated, uiAccess: self.uiAccess, error: self.error || null };
    evidence.parentProcessId = parentLaunch?.pid;
    evidence.parentVerifiedChildPid = parentLaunch?.childPid;
    check(label + ' 外部检查拒绝访问时严格绑定真实自检令牌与父子 PID', Boolean(processStart && previous && parentLaunch && self
      && parentLaunch.uiAccess === uiAccess && self.available === true && !self.error
      && self.elevated === elevated && self.uiAccess === uiAccess
      && state.runtime.elevated === self.elevated && state.runtime.uiAccess === self.uiAccess && !state.runtime.error));
    inspectedWindows = await waitForNativeVisibility(processId, true, false, label + ' native session identity');
    const sessions = [...new Set(inspectedWindows.map(window => window.sessionId))];
    check(label + ' 自检回退使用 HWND 的实际会话，未复制预期会话', sessions.length === 1 && Number.isSafeInteger(sessions[0]));
    const identity = await readProcessIdentity(processId);
    evidence.identity = { processId: identity.processId, sessionId: identity.sessionId, ownerLookupSucceeded: identity.returnValue === 0, ownerUnavailable: identity.ownerUnavailable };
    check(label + ' WMI 进程身份与 HWND 会话一致', identity.sessionId === sessions[0]);
    actual = { available: true, processId, elevated: self.elevated, uiAccess: self.uiAccess,
      sessionId: sessions[0], ...(identity.returnValue === 0 ? { userSid: identity.userSid } : {}), source: evidence.source };
  }
  check(label + ' 原生 token 与界面状态一致', actual.available === true && !actual.error && actual.processId === processId && actual.elevated === elevated && actual.uiAccess === uiAccess && state.runtime.elevated === elevated && state.runtime.uiAccess === uiAccess && !state.runtime.error);
  check(label + ' 自启动保持关闭且未改变自启方式', state.settings.autostart === false && state.settings.autostartElevation === 'uac');
  const windows = inspectedWindows || await waitForNativeVisibility(processId, true, false, label + ' native main shown and ball hidden');
  check(label + ' 两个原生窗口均位于当前会话 Default 桌面', windows.length === 2 && windows.every(window => window.sessionId === actual.sessionId && String(window.desktop).toLowerCase() === 'default'));
  const { sorted } = nativeWindowRoles(windows);
  check(label + ' 主界面显示时悬浮球保持隐藏', sorted[0].isVisible === true && sorted[1].isVisible === false);
  check(label + ' 隐藏悬浮球未持有键盘焦点', await ball.evaluate(() => !document.hasFocus()));
  check(label + ' 主窗口和悬浮球均有有效原生大小', sorted[0].bounds.width > sorted[1].bounds.width * 3 && sorted[0].bounds.height > sorted[1].bounds.height * 3 && sorted[1].bounds.width > 0 && sorted[1].bounds.height > 0);
  let previousGeometry = '', stableGeometrySamples = 0;
  const geometry = await waitFor(async () => {
    const candidate = await main.evaluate(() => ({
      x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio,
      workArea: { x: Number(screen.availLeft) || 0, y: Number(screen.availTop) || 0, width: screen.availWidth, height: screen.availHeight }
    }));
    const key = JSON.stringify(candidate);
    stableGeometrySamples = key === previousGeometry ? stableGeometrySamples + 1 : 0;
    previousGeometry = key;
    return stableGeometrySamples >= 2 ? candidate : false;
  }, 5000, label + ' settled window geometry');
  geometrySnapshots.push({ phase: label, processId, geometry, nativeBounds: sorted.map(window => window.bounds), nativeStyles: sorted.map(window => ({ layered: window.layered, hasNativeRegion: window.hasNativeRegion })) });
  console.log('Native geometry ' + JSON.stringify(geometrySnapshots.at(-1)));
  const { workArea } = geometry;
  const marginX = geometry.x - workArea.x, marginY = geometry.y - workArea.y;
  const phase = { label, port, processId, main, ball, browser, state, actual, windows, geometry };
  phases.push(phase);
  // Windows can include a 7-DIP invisible resize frame in screenX/GetWindowRect
  // while outerWidth follows Chromium's logical window bounds. Keep this check
  // entirely in DOM CSS units, allow that non-client inset plus integer rounding,
  // and still require positive margins on all four sides. The separate native
  // inspection above verifies actual HWND visibility and dimensions.
  const rightMargin = workArea.width - marginX - geometry.width;
  const bottomMargin = workArea.height - marginY - geometry.height;
  check(label + ' 主界面居中并留出屏幕边距', marginX > 0 && marginY > 0 && rightMargin > 0 && bottomMargin > 0
    && Math.abs(marginX - (workArea.width - geometry.width) / 2) <= 10
    && Math.abs(marginY - (workArea.height - geometry.height) / 2) <= 10);
  const index = phases.length;
  if (uiAccess) {
    const gpu = await browser.send('SystemInfo.getInfo');
    geometrySnapshots.at(-1).gpuFeatureStatus = gpu.gpu.featureStatus;
    check('UIAccess 主窗口未使用原生透明度分层', sorted[0].layered === false);
    check('UIAccess 悬浮球使用 CSS 抗锯齿边缘，未套用整数区域裁切', sorted[1].hasNativeRegion === false);
    const mainScreenName = 'uiaccess-phase-' + index + '-main-screen.png';
    const mainCapture = JSON.parse(await powershell(['-File', path.join(root, 'tests/native/capture-native-window.ps1'),
      '-TargetProcessId', String(processId), '-WindowHandle', sorted[0].hwnd,
      '-OutputPath', path.join(output, mainScreenName), '-SampleStep', '4']));
    // Keep physical desktop captures local: the native window rectangle can
    // contain a thin strip of other applications around its invisible frame.
    mainCapture.imageSha256 = sha(await readFile(path.join(output, mainScreenName)));
    geometrySnapshots.at(-1).mainScreenCapture = mainCapture;
    check('UIAccess 主窗口的座位高亮真实显示在屏幕上', mainCapture.greenPixels > 150);
  }
  const captureRenderer = async (role, client) => {
    const capture = await client.send('Page.captureScreenshot', { format: 'png' });
    const name = 'uiaccess-phase-' + index + '-' + role + '-renderer.png';
    await writeFile(path.join(output, name), Buffer.from(capture.data, 'base64'));
    screenshots.push(name);
  };
  await captureRenderer('main', main);
  const ballWindow = sorted.find(window => window.bounds.width < 400 && window.bounds.height < 150);
  assert.ok(ballWindow, 'The verified native floating-ball HWND must exist.');
  const screenName = 'uiaccess-phase-' + index + '-ball-screen.png';
  await main.evaluate(() => slateDesktop.hideMain());
  await waitForNativeVisibility(processId, false, true, label + ' main hidden for unobscured screen capture', 10000);
  await pause(1650);
  const ballAfterHeartbeat = nativeWindowRoles(await inspectWindows(processId));
  check(label + ' 置顶心跳后仅悬浮球可见且未获取焦点', ballAfterHeartbeat?.main.isVisible === false && ballAfterHeartbeat?.ball.isVisible === true && await ball.evaluate(() => !document.hasFocus()));
  // Hidden native windows do not owe Chromium a paint. Capture each renderer
  // only while its corresponding window is visible, matching normal app use.
  await captureRenderer('ball', ball);
  const screenCapture = JSON.parse(await powershell(['-File', path.join(root, 'tests/native/capture-native-window.ps1'),
    '-TargetProcessId', String(processId), '-WindowHandle', ballWindow.hwnd, '-OutputPath', path.join(output, screenName)]));
  screenCapture.imageSha256 = sha(await readFile(path.join(output, screenName)));
  geometrySnapshots.at(-1).screenCapture = screenCapture;
  check(label + ' 悬浮球在实际屏幕呈现绿色球体，不只是透明窗口占位', screenCapture.isVisible === true && screenCapture.greenPixels > screenCapture.width * screenCapture.height * .15);
  await ball.evaluate(() => slateDesktop.openMain());
  await waitForNativeVisibility(processId, true, false, label + ' main reopened after capture', 10000);
  return phase;
}

async function requestChange(phase, patch) {
  // The source renderer is destroyed after a successful handoff. Do not await
  // the long-lived IPC evaluation, or confuse that expected disconnect with a
  // failed elevation. A real bridge rejection remains available diagnostically.
  await phase.main.evaluate(patch => {
    window.__slatePermissionTestError = null;
    void slateDesktop.updateSettings(patch).catch(error => { window.__slatePermissionTestError = error.message; });
    return true;
  }, patch);
}

async function installClassFixture(phase) {
  await phase.main.evaluate(async () => {
    const state = DrawCore.createState([
      { id: '1', name: '权限甲', row: 1, col: 1 },
      { id: '2', name: '权限乙', row: 1, col: 2 },
      { id: '3', name: '权限丙', row: 2, col: 1 }
    ], 90477);
    state.demo = false;
    state.className = '权限交接回归';
    state.settings = DrawCore.settings({
      renderStyle: 'overview', strategy: 'manual', manualMode: 'normal', modes: ['normal'],
      directionChance: 0, timeChance: 0, friendEnabled: false, endJumpChance: 0, voice: false
    });
    DrawCore.draw(state, new Date('2026-10-15T06:00:00.000Z'));
    slateDesktop.data.saveClass(DrawCore.restoreState(state));
    await VisionProviders.importSettings({active:'openai',records:[{provider:'openai',model:'gpt-6-luna',key:'uiaccess-fake-vision-key'}]},{preserveKeys:false});
    await SpeechProviders.importSettings({active:'mimo',records:[{provider:'mimo',voice:'茉莉',key:'uiaccess-fake-speech-key',fallback:false}]},{preserveKeys:false});
  });
  await phase.main.send('Page.reload');
  await waitFor(() => phase.main.evaluate(() => document.readyState === 'complete'
    && document.querySelectorAll('#liveSeats .live-seat[data-live-student]').length === 3
    && document.getElementById('navCount')?.textContent.trim() === '3'
    && document.getElementById('stageName')?.textContent.length > 0), 35000, 'normal renderer restoring seeded class and statistics');
}

async function checkClassPersistence(phase, expected = null) {
  const snapshot = await phase.main.evaluate(async () => {
    const saved = slateDesktop.data.loadClass();
    const raw = JSON.stringify(saved);
    const record = saved?.history?.at(-1);
    const numericMetric = id => Number(document.getElementById(id)?.textContent.match(/\d+/)?.[0]);
    return {
      raw,
      info:await slateDesktop.data.info(),
      vision:await slateDesktop.data.readCredentials('vision'),speech:await slateDesktop.data.readCredentials('speech'),
      validSavedData: saved?.demo === false && saved.className === '权限交接回归'
        && saved.students.length === 3 && saved.round === 1 && saved.history.length === 1
        && saved.lastId === record?.studentId && saved.cycleSeen.length === 1
        && Object.values(saved.counts).reduce((sum, value) => sum + value, 0) === 1
        && Object.values(saved.fairnessStats).reduce((sum, stats) => sum + stats.draws, 0) === 1,
      restoredRoster: document.querySelectorAll('#liveSeats .live-seat[data-live-student]').length === 3
        && document.getElementById('navCount')?.textContent.trim() === '3'
        && document.querySelectorAll('#rosterList [data-student]').length === 3
        && document.querySelector('.draw-screen')?.dataset.renderStyle === 'overview',
      restoredResultAndStats: document.querySelector('.draw-screen')?.classList.contains('has-result')
        && document.getElementById('liveBoard')?.hidden === false
        && document.getElementById('stageName')?.textContent === record?.name
        && document.querySelector('#liveSeats .live-seat.current')?.dataset.liveStudent === record?.studentId
        && numericMetric('roundMetric') === 1 && numericMetric('lifetimeTotalDraws') === 1
    };
  });
  check(phase.label + ' 班级、历史与长期公平统计完整保留', snapshot.validSavedData && (!expected || snapshot.raw === expected.raw));
  check(phase.label+' 名单和提供商配置来自指定便携目录',path.resolve(snapshot.info.directory)===path.resolve(profile)&&snapshot.info.portable===true&&snapshot.vision?.records?.find(record=>record.provider==='openai')?.key==='uiaccess-fake-vision-key'&&snapshot.speech?.records?.find(record=>record.provider==='mimo')?.key==='uiaccess-fake-speech-key');
  const statisticsSha256=sha(await readFile(path.join(profile,'statistics.srstat')));
  check(phase.label+' 公平统计二进制文件在权限交接中保持完整',!expected||statisticsSha256===expected.statisticsSha256);
  check(phase.label + ' 实际界面恢复三人名单及全览座位表', snapshot.restoredRoster);
  check(phase.label + ' controller 恢复抽中焦点和累计统计，未读入空名单', snapshot.restoredResultAndStats);
  return {raw:snapshot.raw,statisticsSha256};
}

async function checkIndexedPersistence(phase, initialize = false) {
  const marker = await phase.main.evaluate(initialize => new Promise((resolve, reject) => {
    const request = indexedDB.open('slate-uiaccess-qa', 1);
    request.onupgradeneeded = () => {
      if (initialize) request.result.createObjectStore('probe');
      else request.transaction.abort();
    };
    request.onerror = () => reject(Error('The persisted IndexedDB probe could not be opened.'));
    request.onblocked = () => reject(Error('The persisted IndexedDB probe is still locked.'));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('probe', initialize ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('probe');
      const operation = initialize ? store.put('same-profile', 'marker') : store.get('marker');
      let value;
      operation.onsuccess = () => { value = initialize ? 'same-profile' : operation.result; };
      transaction.oncomplete = () => { database.close();resolve(value); };
      transaction.onerror = transaction.onabort = () => { database.close();reject(Error('The IndexedDB probe transaction failed.')); };
    };
  }), initialize);
  check(phase.label + ' IndexedDB 持久记录跨权限交接完整保留', marker === 'same-profile');
}

async function confirmExit(phase) {
  if (!phase?.ball.closed) {
    try {
      if (phase.main && !phase.main.closed) await phase.main.evaluate(() => slateDesktop.hideMain());
      await phase.ball.evaluate(() => slateDesktop.beginConfirmation());
      void phase.ball.evaluate(() => slateDesktop.quit()).catch(() => {});
      return;
    } catch { /* Try only this isolated browser's CDP endpoint below. */ }
  }
  if (phase?.browser && !phase.browser.closed) void phase.browser.send('Browser.close').catch(() => {});
}

async function cleanup() {
  await nativeEvents().catch(() => {});
  for (const phase of [...phases].reverse()) await confirmExit(phase);
  // A failed renderer or handoff can leave an instance whose page was never
  // attached. Only close browser endpoints whose PID is in this private log.
  for (const port of ports) {
    try {
      const version = await jsonAt(port, '/json/version');
      const browser = await connect(version.webSocketDebuggerUrl, 'cleanup:' + port);
      const info = await browser.send('SystemInfo.getProcessInfo');
      const pid = info.processInfo.find(process => process.type === 'browser')?.id;
      if (ownedPids.has(pid)) void browser.send('Browser.close').catch(() => {});
      else browser.close();
    } catch { /* The expected endpoint is already gone. */ }
  }
  let remaining = [];
  try {
    await waitFor(async () => { remaining = await livingOwnedPids(); return remaining.length === 0; }, 20000, 'all isolated permission-test processes exiting');
    cleanupConfirmed = true;
  } catch (error) {
    console.error('QA cleanup could not confirm exit for own PIDs ' + remaining.join(', ') + '. Retained ' + profile);
    if (!failure) failure = error;
  }
  for (const client of clients) client.close();
  // Preserve diagnostics outside the disposable profile even on success.
  for (const [source, target] of [[nativeLogPath, 'uiaccess-native.log'], [chromiumLogPath, 'uiaccess-chromium.log']]) {
    const content = await readFile(source).catch(() => null);
    if (content) await writeFile(path.join(output, target), content);
  }
  if (successful && cleanupConfirmed && !failure) {
    const verified = await realpath(profile);
    if (path.dirname(verified) !== tempParent || !path.basename(verified).startsWith('SlateRandom-uiaccess-')) throw Error('Unexpected permission-test profile path; refusing removal.');
    await rm(verified, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

try {
  if (process.platform !== 'win32') throw Error('Actual UIAccess regression requires Windows.');
  await mkdir(output, { recursive: true });
  const artifact = await readFile(path.join(root, 'dist/index.html'));
  artifactBytes = artifact.length; artifactSha256 = sha(artifact);
  executableSha256 = sha(await readFile(executable));
  appAsarSha256 = sha(await readFile(path.join(release, 'resources/app.asar')));
  check('实际提权测试使用当前已构建的发布包', sha(asar.extractFile(path.join(release, 'resources/app.asar'), 'dist/index.html')) === artifactSha256);
  const current = await privilege.getStatus();
  check('测试从普通权限启动，能够检验真正 UAC 交接', current.available && !current.error && current.elevated === false && current.uiAccess === false);
  const startupBefore = { run: await runEntrySnapshot(), task: await privilege.queryTask({ taskName: ownedTaskName(profile), userSid: current.userSid }) };
  check('隔离配置尚无自启动计划任务', startupBefore.task.ok === true && startupBefore.task.exists === false);
  await writeFile(path.join(profile, 'desktop-settings.json'), JSON.stringify({ version: 1, settings: { autostart: false, uac: false, uiAccess: false, autostartElevation: 'uac' }, ball: null }, null, 2));
  ports = await reserveConsecutivePorts();
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.SLATE_DEV_URL;
  launched = spawn(executable, ['--slate-user-data=' + profile, '--remote-debugging-port=' + ports[0], '--slate-show-main', '--enable-logging=file', '--log-file=' + chromiumLogPath], { cwd: release, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  launched.on('error', error => { processOutput += error.stack + '\n'; });
  launched.stdout.on('data', value => { processOutput = (processOutput + value).slice(-128 * 1024); });
  launched.stderr.on('data', value => { processOutput = (processOutput + value).slice(-128 * 1024); });
  if (launched.pid) ownedPids.add(launched.pid);
  const normal = await attachPhase(ports[0], '普通权限', false, false, 35000);
  check('普通窗口 PID 与自行启动的进程一致', normal.processId === launched.pid);
  check('普通窗口与测试进程使用同一登录会话', normal.actual.sessionId === current.sessionId && normal.actual.userSid === current.userSid);
  await installClassFixture(normal);
  await checkIndexedPersistence(normal, true);
  const expectedClass = await checkClassPersistence(normal);
  console.log('Requesting one real Windows UAC consent for the isolated QA instance.');
  await requestChange(normal, { uac: true });
  const elevated = await attachPhase(ports[1], 'UAC 管理员', true, false, 150000);
  await waitFor(async () => !(await livingOwnedPids()).includes(normal.processId), 20000, 'original normal instance exiting after UAC handoff');
  check('UAC 交接后原普通实例已退出，新实例主界面可见', !(await livingOwnedPids()).includes(normal.processId));
  check('UAC 交接保持同一登录会话', elevated.actual.sessionId === current.sessionId);
  if (elevated.actual.userSid) check('UAC 进程所有者与当前用户一致', elevated.actual.userSid === current.userSid);
  await checkClassPersistence(elevated, expectedClass);
  await checkIndexedPersistence(elevated);
  await requestChange(elevated, { uiAccess: true });
  const uiaccess = await attachPhase(ports[2], 'UIAccess', true, true, 150000);
  await waitFor(async () => !(await livingOwnedPids()).includes(elevated.processId), 20000, 'original administrator instance exiting after UIAccess handoff');
  check('UIAccess 交接后原管理员实例退出且新实例真令牌已启用', !(await livingOwnedPids()).includes(elevated.processId));
  check('UIAccess 交接保持同一登录会话', uiaccess.actual.sessionId === current.sessionId);
  if (uiaccess.actual.userSid) check('UIAccess 进程所有者与当前用户一致', uiaccess.actual.userSid === current.userSid);
  await checkClassPersistence(uiaccess, expectedClass);
  await checkIndexedPersistence(uiaccess);
  await uiaccess.main.evaluate(() => slateDesktop.hideMain());
  await waitForNativeVisibility(uiaccess.processId, false, true, 'UIAccess ball visible for confirmation');
  await uiaccess.ball.evaluate(() => slateDesktop.beginConfirmation());
  await waitFor(() => uiaccess.ball.evaluate(() => innerWidth >= 340
    && getComputedStyle(document.querySelector('.floating-ball-confirmation')).opacity === '1'), 10000, 'UIAccess confirmation expansion');
  const expandedWindows = await inspectWindows(uiaccess.processId);
  check('UIAccess 展开关闭确认后仍可见且保持透明抗锯齿合成', expandedWindows.some(window => window.isVisible && window.bounds.width >= 340
    && window.bounds.width < 500 && !window.hasNativeRegion));
  await uiaccess.ball.evaluate(() => slateDesktop.endConfirmation());
  await waitFor(() => uiaccess.ball.evaluate(() => innerWidth <= 80), 10000, 'UIAccess confirmation collapsed');
  check('UIAccess 取消确认后收回圆球，程序继续运行', (await uiaccess.ball.evaluate(() => slateDesktop.state())).ball.confirming === false);
  const collapsedWindows = nativeWindowRoles(await waitForNativeVisibility(uiaccess.processId, false, true, 'UIAccess ball remains visible after confirmation'));
  check('UIAccess 关闭主界面后悬浮球仍可见', collapsedWindows.main.isVisible === false && collapsedWindows.ball.isVisible === true);
  await uiaccess.ball.evaluate(() => slateDesktop.openMain());
  const reopenedWindows = nativeWindowRoles(await waitForNativeVisibility(uiaccess.processId, true, false, 'UIAccess main reopen'));
  check('UIAccess 悬浮球可重新打开真实桌面主窗口并自动隐藏', reopenedWindows.main.isVisible === true && reopenedWindows.ball.isVisible === false);
  const events = await nativeEvents();
  for (const [oldPhase, newPhase] of [[normal, elevated], [elevated, uiaccess]]) {
    const visible = events.findIndex(event => event.pid === oldPhase.processId && event.event === 'relaunch-windows-visible' && event.childPid === newPhase.processId);
    const exiting = events.findIndex(event => event.pid === oldPhase.processId && event.event === 'relaunch-parent-exit');
    check(oldPhase.label + ' 在新窗口真实显示确认后才退出', visible >= 0 && exiting > visible);
    check(newPhase.label + ' 日志确认主窗口显示且悬浮球隐藏', events.some(event => event.pid === newPhase.processId && event.event === 'windows-visible' && event.main === true && event.ball === false));
    check(newPhase.label + ' 两个 renderer 均先完成 readiness', ['main', 'ball'].every(role => events.some(event => event.pid === newPhase.processId && event.event === 'renderer-ready' && event.role === role)));
  }
  const failures = events.filter(event => ['startup-failed', 'relaunch-failed', 'renderer-failed', 'preload-error', 'load-rejected'].includes(event.event)
    || event.event === 'renderer-exit' && event.reason !== 'clean-exit'
    || event.event === 'child-process-gone' && ['crashed', 'oom', 'launch-failed', 'integrity-failure', 'abnormal-exit'].includes(event.reason));
  check('实际 UAC→UIAccess 交接没有加载、renderer 或进程崩溃错误', failures.length === 0);
  check('实际双窗口交互没有未处理 JavaScript 错误', runtimeErrors.length === 0);
  const saved = JSON.parse(await readFile(path.join(profile, 'desktop-settings.json'), 'utf8'));
  check('隔离数据库持久化 UAC/UIAccess，保持自启动关闭', saved.settings.uac === true && saved.settings.uiAccess === true && saved.settings.autostart === false && saved.settings.autostartElevation === 'uac');
  const startupAfter = { run: await runEntrySnapshot(), task: await privilege.queryTask({ taskName: ownedTaskName(profile), userSid: current.userSid }) };
  check('实际权限测试没有修改 Run 启动项或创建计划任务', startupAfter.run === startupBefore.run && startupAfter.task.ok === true && startupAfter.task.exists === false);
  const scenePerformance = [];
  await uiaccess.main.send('Emulation.setDeviceMetricsOverride', { width: 768, height: 432, deviceScaleFactor: 2.5, mobile: false });
  for (const mode of ['normal', 'direction', 'time']) {
    const fixture = await uiaccess.main.evaluate(makeScenePerformanceFixture, { mode });
    await uiaccess.main.evaluate(state => { slateDesktop.data.saveClass(state); location.reload(); }, fixture);
    await waitFor(() => uiaccess.main.evaluate(() => document.querySelectorAll('#liveSeats [data-live-student]').length === 47
      && document.getElementById('drawBtn')?.getAttribute('aria-busy') !== 'true'), 12000, '47-seat fixture ready');
    await pause(1000);
    const measurement = await uiaccess.main.evaluate(measureScenePerformance, { timeoutMs: 10000 });
    scenePerformance.push({ mode, ...measurement });
    check('UIAccess 47 席 ' + mode + ' 动画在 768×432 / 2.5x 视口完成', measurement.seats === 47 && measurement.frames > 15
      && measurement.viewport.width === 768 && measurement.viewport.height === 432);
    console.log('Scene performance ' + JSON.stringify(scenePerformance.at(-1)));
  }
  finalReport = {
    artifactBytes, artifactSha256, executableSha256, appAsarSha256, checks, runtimeErrors, screenshots,
    permissionsTest: 'actual UAC→admin→UIAccess handoff verified; isolated profile; no startup changes',
    classPersistence: { participants: 3, rounds: 1, historyRecords: 1, lifetimeDraws: 1, sha256: sha(expectedClass.raw), statisticsSha256:expectedClass.statisticsSha256,verifiedHandoffs: 2,storage:'portable JSON + authenticated binary + data/browser IndexedDB' },
    pids: phases.map(phase => ({ phase: phase.label, processId: phase.processId, port: phase.port, sessionId: phase.actual.sessionId, elevated: phase.actual.elevated, uiAccess: phase.actual.uiAccess })),
    nativeWindows: phases.map(phase => ({ phase: phase.label, processId: phase.processId, windows: phase.windows, geometry: phase.geometry })),
    geometrySnapshots, permissionEvidence, scenePerformance
  };
  successful = true;
} catch (error) { failure = error; }
finally {
  try { await cleanup(); }
  catch (error) { if (!failure) failure = error; else processOutput += '\nCleanup: ' + error.stack; }
}

if (failure) {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'uiaccess-partial-report.json'), JSON.stringify({ completedAt: new Date().toISOString(), artifactBytes, artifactSha256, appAsarSha256, error: failure.stack, profile, checks, runtimeErrors, geometrySnapshots, permissionEvidence, pids: [...ownedPids], cleanupConfirmed, processOutput }, null, 2) + '\n');
  console.error('Actual UIAccess QA failed; diagnostics retained at ' + profile);
  throw failure;
}
check('实际权限测试的所有自有进程均退出后才移除隔离数据', cleanupConfirmed);
await writeFile(path.join(output, 'uiaccess-report.json'), JSON.stringify({ completedAt: new Date().toISOString(), ...finalReport, cleanupConfirmed }, null, 2) + '\n');
console.log('Actual UIAccess QA complete: ' + checks.length + ' checks');
