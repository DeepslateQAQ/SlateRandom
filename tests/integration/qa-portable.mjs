import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, realpath, rm, rename, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Explicit native integration. The parent runs this serially with other GUI QA.
// No invocation reads real AppData: every legacy path is an isolated fixture.
const root = fileURLToPath(new URL('../../', import.meta.url)), require = createRequire(import.meta.url);
const engine = require('../../src/shared/domain/engine.js'), asar = require('@electron/asar');
const { createPortableStore } = require('../../src/main/portable-data.cjs');
const output = path.join(root, 'qa-output'), parent = await realpath(tmpdir());
const sandbox = await mkdtemp(path.join(parent, 'SlateRandom-portable-'));
const sha = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], runtimeErrors = [], runs = [];
let failed, complete = false, artifactSha256 = '', artifactBytes = 0, appAsarSha256 = '', portableZipSha256 = '';
const check = (label, condition) => { assert.ok(condition, label); checks.push(label); console.log('PASS ' + label); };
const cleanEnvironment = () => { const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.SLATE_DEV_URL; return env; };
async function wait(fn, label, timeout = 35000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await pause(70); }
  throw Error(label + ' timed out' + (last ? ': ' + last.message : ''));
}
class CDP {
  constructor(socket, label) {
    this.socket = socket; this.label = label; this.pending = new Map(); this.sequence = 0; this.closed = false;
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const item = this.pending.get(message.id); if (!item) return;
        this.pending.delete(message.id); clearTimeout(item.timeout);
        message.error ? item.reject(Error(JSON.stringify(message.error))) : item.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push({ phase: label, error: message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text });
    });
    socket.addEventListener('close', () => this.close()); socket.addEventListener('error', () => this.close());
  }
  close() { this.closed = true; for (const item of this.pending.values()) { clearTimeout(item.timeout); item.reject(Error(this.label + ' closed')); } this.pending.clear(); this.socket.close(); }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(Error(this.label + ' closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence, timeout = setTimeout(() => { this.pending.delete(id); reject(Error(method + ' timed out')); }, 15000);
      this.pending.set(id, { resolve, reject, timeout }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(fn, ...args) {
    const result = await this.send('Runtime.evaluate', { expression: '(' + fn.toString() + ').apply(null,' + JSON.stringify(args) + ')', awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
}
async function connect(target, label) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(label + ' connection timed out')), 12000); socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true }); socket.addEventListener('error', error => { clearTimeout(timer); reject(error); }, { once: true }); });
  const client = new CDP(socket, label); await client.send('Runtime.enable'); return client;
}
async function powershell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', value => { log += value; }); child.stderr.on('data', value => { log += value; });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve(log) : reject(Error('ZIP extraction failed: ' + log)));
  });
}
async function launch(release, legacyDirectory, label) {
  const run = { label, release, dataDirectory: path.join(release, 'data'), clients: [], log: '', exited: false };
  // Intentionally no --slate-user-data: portability must work beside the real exe.
  run.args = ['--slate-qa', '--slate-hidden', '--slate-legacy-data=' + legacyDirectory, '--remote-debugging-port=0'];
  run.child = spawn(path.join(release, 'SlateRandom.exe'), run.args, { cwd: release, windowsHide: true, env: cleanEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] }); runs.push(run);
  // Electron's crash reporter may retain a stdio pipe after the browser exits.
  // Wait for the owned process itself, rather than for every inherited pipe.
  run.ended = new Promise(resolve => { run.child.once('exit', code => { run.exited = true; run.exitCode = code; resolve(code); }); });
  run.child.once('error', error => { run.log += error.stack; });
  for (const stream of [run.child.stdout, run.child.stderr]) stream.on('data', value => { run.log = (run.log + value).slice(-128 * 1024); });
  const pages = await wait(async () => {
    if (run.exited) throw Error('Application exited: ' + run.log);
    const match = run.log.match(/DevTools listening on ws:\/\/([^/]+)\//); if (!match) return false;
    const targets = await (await fetch('http://' + match[1] + '/json/list', { signal: AbortSignal.timeout(1500) })).json();
    const main = targets.find(target => target.type === 'page' && target.url.includes('slateRole=main') && !new URL(target.url).searchParams.has('slatePreview'));
    const ball = targets.find(target => target.type === 'page' && target.url.includes('slateRole=ball'));
    return main && ball ? { main, ball } : false;
  }, label + ' diagnostic pages');
  run.main = await connect(pages.main, label + ':main'); run.ball = await connect(pages.ball, label + ':ball'); run.clients.push(run.main, run.ball);
  await wait(() => run.main.evaluate(() => document.readyState === 'complete' && !!document.getElementById('drawBtn') && typeof slateDesktop?.data?.loadClass === 'function'), label + ' renderer ready');
  const info = await run.main.evaluate(() => slateDesktop.data.info());
  check(label + ' 无目录参数时自动在实际可执行文件旁使用 data', path.resolve(info.directory) === path.resolve(run.dataDirectory) && info.portable === true && !run.args.some(argument => argument.startsWith('--slate-user-data=')));
  check(label + ' 浏览器 session 独立保存在 data/browser', (await readdir(run.dataDirectory)).includes('browser'));
  return run;
}
async function closeRun(run) {
  if (run.exited) return;
  // A first-run launch opens the main window, and the hold-to-quit path lives on
  // the ball; hand the screen back to the ball before quitting.
  await run.main.evaluate(() => slateDesktop.hideMain());
  await wait(() => run.main.evaluate(() => slateDesktop.state().then(state => state.main.visible === false)), run.label + ' main window hidden');
  await pause(250);
  await run.ball.evaluate(() => slateDesktop.beginConfirmation());
  void run.ball.evaluate(() => slateDesktop.quit()).catch(() => {});
  const code = await Promise.race([run.ended, pause(12000).then(() => 'timeout')]);
  assert.equal(code, 0, run.label + ' must exit before moving files');
  for (const client of run.clients) client.close();
}
function classFixture(name, seed) {
  const value = engine.createState([{ id: '1', name: '便携甲', row: 1, col: 1 }, { id: '2', name: '便携乙', row: 1, col: 2 }, { id: '3', name: '便携丙', row: 2, col: 1 }], seed);
  value.demo = false; value.className = name; value.seatRows = 3;
  value.settings = engine.settings({ renderStyle: 'overview', strategy: 'manual', manualMode: 'normal', modes: ['normal'], directionChance: 0, timeChance: 0, friendEnabled: false, endJumpChance: 0, voice: false });
  engine.draw(value, new Date('2026-10-15T07:00:00Z')); engine.draw(value, new Date('2026-10-15T07:01:00Z'));
  return engine.restoreState(value);
}
const credentials = {
  vision: { active: 'openai', records: [{ provider: 'openai', model: 'gpt-6-luna', key: 'portable-fake-vision-key', endpoint: 'https://api.openai.com/v1/chat/completions' }] },
  speech: { active: 'mimo', records: [{ provider: 'mimo', model: 'mimo-v2.5-tts', voice: '茉莉', key: 'portable-fake-speech-key', endpoint: 'https://api.xiaomimimo.com/v1/chat/completions', fallback: false }] }
};
async function snapshot(run, expected, expectedStatistics = null) {
  await wait(() => run.main.evaluate(name => slateDesktop.data.loadClass()?.className === name && document.querySelectorAll('#liveSeats .live-seat[data-live-student]').length === 3, expected.className), run.label + ' class rendered');
  const actual = await run.main.evaluate(async () => {
    await VisionProviders.exportSettings({ includeSecrets: true }); await SpeechProviders.exportSettings({ includeSecrets: true });
    return { state: slateDesktop.data.loadClass(), vision: await slateDesktop.data.readCredentials('vision'), speech: await slateDesktop.data.readCredentials('speech') };
  });
  check(run.label + ' 名单、概率设置、PRNG、历史、未抽优先与长期公平统计完整恢复', JSON.stringify(engine.restoreState(actual.state)) === JSON.stringify(expected));
  check(run.label + ' 视觉与语音提供商假密钥随 JSON 数据携带', actual.vision.records.find(record => record.provider === 'openai')?.key === credentials.vision.records[0].key && actual.speech.records.find(record => record.provider === 'mimo')?.key === credentials.speech.records[0].key);
  const statistics = await readFile(path.join(run.dataDirectory, 'statistics.srstat'));
  check(run.label + ' 统计使用完整二进制并保留原始检查点', statistics.subarray(0, 8).toString() === 'SLATEST1' && !statistics.includes(Buffer.from('fairnessStats')) && (!expectedStatistics || sha(statistics) === expectedStatistics));
  const roster = JSON.parse(await readFile(path.join(run.dataDirectory, 'roster.json'), 'utf8'));
  const settings = JSON.parse(await readFile(path.join(run.dataDirectory, 'settings.json'), 'utf8'));
  check(run.label + ' UTF-8 JSON 分别保存名单与设置，统计未泄漏到名单 JSON', roster.roster.className === expected.className && settings.settings.manualMode === 'normal' && !('counts' in roster.roster) && !('history' in roster.roster));
  return { stateSha256: sha(JSON.stringify(engine.restoreState(actual.state))), statisticsSha256: sha(statistics) };
}
async function sourceSnapshot(directory) {
  const entries = [];
  async function visit(folder, relative = '') { for (const entry of await readdir(folder, { withFileTypes: true })) { const name = path.join(relative, entry.name), absolute = path.join(folder, entry.name); if (entry.isDirectory()) await visit(absolute, name); else if (entry.isFile()) entries.push([name, sha(await readFile(absolute))]); else throw Error('Unexpected link in owned legacy fixture.'); } }
  await visit(directory); return sha(JSON.stringify(entries.sort((a, b) => a[0].localeCompare(b[0]))));
}
async function seedLegacy(release, legacyDirectory, fixture) {
  const helper = path.join(sandbox, 'seed-legacy-profile.cjs'), payload = path.join(sandbox, 'legacy-fixture.json');
  await writeFile(payload, JSON.stringify({ state: fixture, credentials }), 'utf8');
  const script = `'use strict';
const {app,BrowserWindow,session}=require('electron'),fs=require('node:fs');
app.setPath('userData',${JSON.stringify(legacyDirectory)});app.setPath('sessionData',${JSON.stringify(legacyDirectory)});
app.whenReady().then(async()=>{try{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await win.loadFile(${JSON.stringify(path.join(release, 'resources/app.asar/dist/index.html'))},{query:{slateRole:'main'}});const data=JSON.parse(fs.readFileSync(${JSON.stringify(payload)},'utf8'));await win.webContents.executeJavaScript('('+(${function (data) {
  return (async () => {
    localStorage.setItem('rollcall-studio:v1', JSON.stringify(data.state));
    async function writeProvider(databaseName, payload) {
      const database = await new Promise((resolve, reject) => { const request = indexedDB.open(databaseName, 1); request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('providers')) request.result.createObjectStore('providers', { keyPath: 'provider' }); if (!request.result.objectStoreNames.contains('preferences')) request.result.createObjectStore('preferences', { keyPath: 'id' }); }; request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result); });
      await new Promise((resolve, reject) => { const transaction = database.transaction(['providers', 'preferences'], 'readwrite'); const store = transaction.objectStore('providers'); store.clear(); for (const record of payload.records) store.put(record); transaction.objectStore('preferences').put({ id: 'active', provider: payload.active }); transaction.oncomplete = resolve; transaction.onerror = transaction.onabort = () => reject(transaction.error || Error('Legacy database write failed.')); }); database.close();
    }
    await writeProvider('rollcall-studio:providers', data.credentials.vision); await writeProvider('rollcall-studio:speech-providers', data.credentials.speech); return true;
  })();
}.toString()})+').apply(null,'+JSON.stringify([data])+')');session.defaultSession.flushStorageData();await session.defaultSession.cookies.flushStore();app.quit();}catch(error){console.error(error);app.exit(1);}});`;
  await mkdir(legacyDirectory, { recursive: true }); await writeFile(helper, script, 'utf8');
  await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [helper], { cwd: sandbox, windowsHide: true, env: cleanEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; const timeout = setTimeout(() => { child.kill(); reject(Error('Legacy fixture creation timed out: ' + log)); }, 45000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { log += value; });
    child.once('error', error => { clearTimeout(timeout); reject(error); }); child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(Error('Legacy fixture creation failed: ' + log)); });
  });
  await writeFile(path.join(legacyDirectory, 'desktop-settings.json'), JSON.stringify({ version: 1, settings: { autostart: false, uac: false, uiAccess: false, autostartElevation: 'task' }, ball: null }), 'utf8');
  await mkdir(path.join(legacyDirectory, 'Cache/qa-disposable'), { recursive: true }); await writeFile(path.join(legacyDirectory, 'Cache/qa-disposable/test'), 'disposable-cache');
  return sourceSnapshot(legacyDirectory);
}

try {
  await mkdir(output, { recursive: true });
  const artifact = await readFile(path.join(root, 'dist/index.html')); artifactBytes = artifact.length; artifactSha256 = sha(artifact);
  const build = JSON.parse(await readFile(path.join(root, 'release/desktop-build.json'), 'utf8'));
  const portable = path.resolve(root, build.portableZip); assert.equal(path.dirname(portable), path.resolve(root, 'release')); portableZipSha256 = sha(await readFile(portable));
  const extraction = path.join(sandbox, 'unpacked'); await mkdir(extraction);
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  await powershell(`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression.FileSystem;$archive=[System.IO.Compression.ZipFile]::OpenRead(${quote(portable)});try{foreach($entry in $archive.Entries){$target=[IO.Path]::GetFullPath([IO.Path]::Combine(${quote(extraction)},$entry.FullName));if(!$target.StartsWith(${quote(extraction + path.sep)},[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe archive path'}}}finally{$archive.Dispose()};[System.IO.Compression.ZipFile]::ExtractToDirectory(${quote(portable)},${quote(extraction)})`);
  let release = path.join(extraction, 'SlateRandom-win32-x64');
  appAsarSha256 = sha(await readFile(path.join(release, 'resources/app.asar')));
  check('便携回归运行本次实际 ZIP 解压的应用及相同 HTML', sha(await readFile(path.join(release, 'SlateRandom.exe'))) === build.executableSHA256 && sha(asar.extractFile(path.join(release, 'resources/app.asar'), 'dist/index.html')) === artifactSha256);
  const isolatedMissingLegacy = path.join(sandbox, 'no-existing-old-appdata');
  const fresh = await launch(release, isolatedMissingLegacy, '首次便携启动');
  check('首次便携启动没有虚构名单或意外读取真实 AppData', (await fresh.main.evaluate(() => slateDesktop.data.loadClass())).students.length === 0);
  const fixture = classFixture('目录移动回归', 2477);
  await fresh.main.evaluate(async (state, credentials) => { slateDesktop.data.saveClass(DrawCore.restoreState(state)); await VisionProviders.importSettings(credentials.vision, { preserveKeys: false }); await SpeechProviders.importSettings(credentials.speech, { preserveKeys: false }); }, fixture, credentials);
  await fresh.main.send('Page.reload'); const beforeMove = await snapshot(fresh, fixture); await closeRun(fresh);
  const movedParent = path.join(sandbox, 'relocated'); await mkdir(movedParent); const movedRelease = path.join(movedParent, 'SlateRandom-win32-x64');
  await wait(async () => { try { await rename(release, movedRelease); return true; } catch (error) { if (['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) return false; throw error; } }, 'moving closed complete executable directory', 15000); release = movedRelease;
  const moved = await launch(release, isolatedMissingLegacy, '移动整个目录后启动');
  const afterMove = await snapshot(moved, fixture, beforeMove.statisticsSha256);
  check('更换完整程序目录后状态与累计公平统计保持逐字节一致', beforeMove.stateSha256 === afterMove.stateSha256);
  const store = createPortableStore({ directory: moved.dataDirectory });
  const full = store.readBackup(store.exportData('all').data);
  check('原生完整备份包含可恢复状态和两种提供商假密钥', JSON.stringify(engine.restoreState(full.state)) === JSON.stringify(fixture) && full.credentials.vision.records[0].key === credentials.vision.records[0].key && full.credentials.speech.records[0].key === credentials.speech.records[0].key);
  check('设置和名单可单独导出，不在名单导出中夹带公平统计', store.readBackup(store.exportData('settings').data).settings.manualMode === 'normal' && store.readBackup(store.exportData('roster').data).roster.students.length === 3 && !('fairnessStats' in store.readBackup(store.exportData('roster').data).roster));
  await closeRun(moved);

  // Preserve the just-tested portable data, then emulate upgrading an old app.
  await rename(path.join(release, 'data'), path.join(sandbox, 'saved-portable-data'));
  const legacyDirectory = path.join(sandbox, 'legacy-appdata-SlateRandom'), legacyFixture = classFixture('旧版迁移回归', 9477);
  const oldProfileSha256 = await seedLegacy(release, legacyDirectory, legacyFixture);
  check('旧版迁移使用独立真实 Local Storage 与 IndexedDB 资料', (await readdir(legacyDirectory)).includes('Local Storage') && (await readdir(legacyDirectory)).includes('IndexedDB'));
  const migrated = await launch(release, legacyDirectory, '自动迁移旧版后启动');
  await snapshot(migrated, legacyFixture);
  const migrationInfo = await migrated.main.evaluate(() => slateDesktop.data.info());
  check('新版本检测到旧版本并迁移到可执行文件旁的 data/browser', migrationInfo.migrated === true && (await readdir(migrated.dataDirectory)).includes('.portable-migration.json'));
  check('迁移后自动将旧浏览器名单转换为 JSON 和统计二进制', await migrated.main.evaluate(() => localStorage.getItem('rollcall-studio:v1') === null) && (await readdir(migrated.dataDirectory)).includes('statistics.srstat'));
  const copiedCache=await readFile(path.join(migrated.dataDirectory,'browser/Cache/qa-disposable/test')).catch(error=>error.code==='ENOENT'?null:Promise.reject(error));
  check('迁移排除旧浏览器缓存并沿用旧桌面设置', copiedCache===null && JSON.parse(await readFile(path.join(migrated.dataDirectory, 'desktop-settings.json'), 'utf8')).settings.autostartElevation === 'task');
  await closeRun(migrated);
  check('原旧版名单、IndexedDB 与桌面设置完整保留且文件内容未修改', await sourceSnapshot(legacyDirectory) === oldProfileSha256);
  check('全部便携与迁移操作没有未处理 renderer 错误', runtimeErrors.length === 0);
  complete = true;
} catch (error) { failed = error; }
finally {
  for (const run of runs.reverse()) {
    try { if (!run.exited) await closeRun(run); }
    catch { if (!run.exited) { run.child.kill(); await Promise.race([run.ended, pause(3000)]); } }
    for (const client of run.clients) client.close();
  }
}
if (failed || runs.some(run => !run.exited)) {
  const error = failed || Error('An owned portable-test process did not exit.');
  await writeFile(path.join(output, 'portable-partial-report.json'), JSON.stringify({ completedAt: new Date().toISOString(), artifactBytes, artifactSha256, appAsarSha256, portableZipSha256, error: error.stack, sandbox, checks, runtimeErrors, processes: runs.map(run => ({ label: run.label, pid: run.child.pid, exited: run.exited, log: run.log })) }, null, 2));
  throw error;
}
check('所有便携回归自有进程已退出，安全清理隔离目录', complete && runs.every(run => run.exited));
const verified = await realpath(sandbox);
if (path.dirname(verified) !== parent || !path.basename(verified).startsWith('SlateRandom-portable-')) throw Error('Unsafe portable QA cleanup path.');
await rm(verified, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
await writeFile(path.join(output, 'portable-report.json'), JSON.stringify({ completedAt: new Date().toISOString(), artifactBytes, artifactSha256, appAsarSha256, portableZipSha256, checks, runtimeErrors, screenshots: [], portability: 'actual unzipped exe/data; whole-directory relocation; legacy Local Storage + IndexedDB migration; original legacy files unchanged', permissionsTest: 'QA isolated paths only; no real AppData, UAC or startup mutations', cleanupConfirmed: true }, null, 2));
console.log('Portable native QA complete: ' + checks.length + ' checks');
