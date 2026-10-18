import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url), asar = require('@electron/asar');
const output = path.join(root, 'qa-output');
const parent = await realpath(tmpdir()), profile = await mkdtemp(path.join(parent, 'SlateRandom-packaged-'));
const release = path.join(profile, 'SlateRandom-win32-x64');
const checks = [], runtimeErrors = [], screenshots = [];
const sha = value => createHash('sha256').update(value).digest('hex');
const html = await readFile(path.join(root, 'dist/index.html'));
const archive = path.join(release, 'resources/app.asar');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (label, value) => { assert.ok(value, label); checks.push(label); console.log('PASS ' + label); };
let child, ws, exited = false, log = '', sequence = 0;
const pending = new Map();
async function wait(fn, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return; if (exited) throw Error('Packaged app exited during startup: ' + log); await pause(50); }
  throw Error('Packaged app timed out: ' + log);
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timeout = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out')); }, 15000);
    pending.set(id, { resolve, reject, timeout }); ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(fn, ...args) {
  const r = await send('Runtime.evaluate', { expression: '(' + fn.toString() + ').apply(null,' + JSON.stringify(args) + ')', awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
try {
  await mkdir(output, { recursive: true });
  const build = JSON.parse(await readFile(path.join(root, 'release/desktop-build.json'), 'utf8'));
  const portable = path.resolve(root, build.portableZip);
  assert.equal(path.dirname(portable), path.resolve(root, 'release'));
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem;
$zip=[System.IO.Compression.ZipFile]::OpenRead(${quote(portable)});
try{foreach($entry in $zip.Entries){$target=[IO.Path]::GetFullPath([IO.Path]::Combine(${quote(profile)},$entry.FullName));if(!$target.StartsWith(${quote(profile + path.sep)},[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe archive path'}}}finally{$zip.Dispose()};
[System.IO.Compression.ZipFile]::ExtractToDirectory(${quote(portable)},${quote(profile)})`;
  await new Promise((resolve, reject) => {
    const process = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; process.stderr.on('data', value => { errors += value; });
    process.once('error', reject); process.once('close', code => code === 0 ? resolve() : reject(Error('Portable ZIP extraction failed: ' + errors)));
  });
  const executable = await readFile(path.join(release, 'SlateRandom.exe'));
  check('实际解压可携带 ZIP，运行其中应用且可执行文件 SHA 与发布清单一致', sha(executable) === build.executableSHA256);
  check('实际发布 ASAR 内的 HTML 与验证单文件逐字节一致', sha(asar.extractFile(archive, 'dist/index.html')) === sha(html));
  const files = asar.listPackage(archive).map(name => name.replaceAll('\\', '/'));
  check('发布包包含主进程、sandbox preload、便携数据、计划任务定义模块与桌面 TTS 运行时', ['src/main/main.cjs', 'src/main/edge-tts.cjs', 'src/preload/preload.cjs', 'src/main/portable-data.cjs', 'src/main/portable-location.cjs', 'src/main/windows/task-definition.cjs', 'node_modules/node-edge-tts/dist/edge-tts.js', 'node_modules/ws/index.js', 'node_modules/https-proxy-agent/dist/index.js'].every(name => files.includes('/' + name)));
  check('发布包不携带回归名单、工作区、原生源码、构建证明或开发测试代码', !files.some(name => /(?:^|\/)(?:qa-output|frontend|tests|src\/native|build|\.migration-baseline|proofs?)(?:\/|$)/.test(name) || /\.test\.[cm]?[jt]s$/.test(name)));
  check('Windows 辅助程序独立放在 ASAR 外且与本次源码构建一致', sha(await readFile(path.join(release, 'resources/windows/SlateRandom.Privileges.exe'))) === sha(await readFile(path.join(root, 'build/windows/SlateRandom.Privileges.exe'))));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.SLATE_DEV_URL;
  child = spawn(path.join(release, 'SlateRandom.exe'), ['--slate-qa', '--slate-hidden', '--slate-user-data=' + path.join(profile, 'user-data'), '--remote-debugging-port=0'], { cwd: release, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', value => { log += value; }); child.stderr.on('data', value => { log += value; });
  const ended = new Promise(resolve => { child.once('exit', code => { exited = true; resolve(code); }); child.once('error', error => { log += error.stack; exited = true; resolve(-1); }); });
  let origin, targets;
  await wait(async () => {
    const match = log.match(/DevTools listening on ws:\/\/([^/]+)\//);
    if (!match) return false;
    origin = 'http://' + match[1];
    try { targets = await (await fetch(origin + '/json/list')).json(); return targets.filter(target => target.type === 'page').length === 2; } catch { return false; }
  });
  check('解压后的 SlateRandom.exe 实际启动双窗口，不依赖源目录或 Node', targets.filter(target => target.type === 'page').length === 2 && targets.every(target => target.type !== 'page' || target.url.includes('resources/app.asar/dist/index.html')));
  const main = targets.find(target => target.type === 'page' && target.url.includes('slateRole=main'));
  const ball = targets.find(target => target.type === 'page' && target.url.includes('slateRole=ball'));
  assert.ok(main && ball, 'Packaged window roles must be separate');
  const connect = async target => {
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    ws.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const entry = pending.get(message.id); if (!entry) return;
        clearTimeout(entry.timeout); pending.delete(message.id);
        message.error ? entry.reject(Error(JSON.stringify(message.error))) : entry.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    });
    await send('Runtime.enable');
  };
  await connect(main);
  await wait(() => evaluate(() => !!document.getElementById('drawBtn') && window.slateDesktop?.role === 'main'));
  // A brand-new packaged profile opens the first-run flow; skipping it once leaves
  // the empty roster the rest of this suite checks.
  const firstRunOpened = await evaluate(() => document.getElementById('onboardingDialog')?.open === true);
  await wait(() => evaluate(() => { const skip = document.getElementById('onboardingSkipBtn'); return !!skip && !skip.disabled; }), 'first-run flow ready');
  await evaluate(() => document.getElementById('onboardingSkipBtn').click());
  await wait(() => evaluate(() => document.getElementById('onboardingDialog').open === false));
  check('实际发布包首次启动进入首次引导并可直接跳过', firstRunOpened && await evaluate(() => !document.getElementById('onboardingDialog').open && !!document.getElementById('drawBtn')));
  check('实际打包主页面启用隔离桥接且默认空名单', await evaluate(() => window.slateDesktop.role === 'main' && typeof window.require === 'undefined' && typeof window.process === 'undefined' && document.querySelectorAll('[data-live-student]').length === 0));
  check('实际发布主进程已加载桌面 TTS 服务并拒绝无效输入', await evaluate(() => slateDesktop.speech.synthesize('', '茉莉').then(() => false, error => String(error?.message || error).includes('姓名文本无效'))));
  const portableInfo=await evaluate(()=>slateDesktop.data.info());
  check('发布包使用显式隔离便携目录，不读取测试外名单',path.resolve(portableInfo.directory)===path.resolve(profile,'user-data')&&portableInfo.portable===true);
  const state = await evaluate(() => slateDesktop.state());
  const { createPrivilegeService } = require('../../src/main/privileges.cjs');
  const actualToken = await createPrivilegeService({ helperPath: path.join(release, 'resources/windows/SlateRandom.Privileges.exe'), executable: path.join(release, 'SlateRandom.exe'), baseArgs: [], workingDirectory: release }).getStatus(child.pid);
  check('发布包能调用外部权限辅助程序读取真实 token，不伪造 UIAccess', actualToken.available === true && !actualToken.error && state.runtime.elevated === actualToken.elevated && state.runtime.uiAccess === actualToken.uiAccess && !state.runtime.error && !state.settings.uiAccess && !state.settings.autostart);
  await evaluate(() => document.getElementById('drawBtn').click());
  await wait(() => evaluate(() => document.getElementById('configDialog').open && document.querySelector('[data-nav=roster]')?.getAttribute('aria-current') === 'page'));
  check('实际打包版空名单抽选直接打开名单配置', await evaluate(() => document.getElementById('view-roster').hidden === false && document.querySelectorAll('[data-live-student]').length === 0));
  check('实际发布版六页设置导航完整，备份集中在数据页面',await evaluate(()=>Array.from(document.querySelectorAll('#configDialog [data-nav]'),e=>e.dataset.nav).join('|')==='general|dashboard|roster|data|help|about'&&!!document.querySelector('#view-data #exportSettingsBtn')&&!!document.querySelector('#view-data #exportRosterBtn')&&!!document.querySelector('#view-data #backupBtn')));
  await evaluate(() => slateDesktop.openMain());
  await evaluate(() => slateDesktop.hideMain());
  ws.close(); await connect(ball);
  await wait(() => evaluate(() => window.slateDesktop?.role === 'ball' && !!document.getElementById('floatingBallButton')));
  check('实际打包悬浮球挂载正确字形且无主界面混入', await evaluate(() => !document.getElementById('drawBtn') && document.querySelector('.floating-ball-core .material-icon').textContent === 'shuffle'));
  check('发布版启动与页面交互没有未处理运行时错误', runtimeErrors.length === 0);
  await evaluate(() => slateDesktop.beginConfirmation());
  // IPC quit destroys the calling target; its pending evaluation may close first.
  void evaluate(() => slateDesktop.quit()).catch(() => {});
  const exitCode = await Promise.race([ended, pause(6000).then(() => 'timeout')]);
  check('悬浮球确认退出结束实际发布进程', exitCode === 0);
  const report = { completedAt: new Date().toISOString(), artifactBytes: html.length, artifactSha256: sha(html), appAsarSha256: sha(await readFile(archive)), executableSha256: sha(executable), portableZipSha256: sha(await readFile(portable)), checks, runtimeErrors, screenshots, permissionsTest: 'read-only target token; QA mode; no UAC prompt, startup entry or scheduled-task mutation' };
  await writeFile(path.join(output, 'packaged-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Packaged QA complete: ' + checks.length + ' checks');
} catch (error) {
  await writeFile(path.join(output, 'packaged-partial-report.json'), JSON.stringify({ error: error.stack, checks, runtimeErrors, log }, null, 2)); throw error;
} finally {
  ws?.close();
  for (const entry of pending.values()) { clearTimeout(entry.timeout); entry.reject(Error('QA connection closed')); } pending.clear();
  if (child && !exited) { child.kill(); await pause(500); }
  const verified = await realpath(profile).catch(() => null);
  if (verified && path.dirname(verified) === parent && path.basename(verified).startsWith('SlateRandom-packaged-')) await rm(verified, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
