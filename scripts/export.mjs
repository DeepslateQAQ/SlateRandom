import { readFile, writeFile, mkdir, copyFile, mkdtemp, readdir, lstat, unlink, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { handoffText } from './handoff.mjs';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const userRoot = path.resolve(homedir());
const downloads = path.join(userRoot, 'Downloads');
const target = path.join(downloads, '点到-2026-10-11');
const desktop = path.join(userRoot, 'Desktop', '高一7班点名程序.html');
const desktopShortcut = path.join(userRoot, 'Desktop', 'SlateRandom 岩选.lnk');
const nativeTarget = path.join(target, 'SlateRandom-win32-x64');
const sourceMirror = path.join(target, '源码');
const preview = path.join(root, 'preview');
const qa = path.join(root, 'qa-output');
const artifact = path.join(root, 'dist', 'index.html');

const suiteFiles = {
  main: 'report.json',
  extra: 'extra-report.json',
  ui: 'ui-report.json',
  friend: 'friend-report.json',
  renderStyles: 'render-styles-report.json',
  speech: 'speech-report.json',
  settingsLayout: 'settings-layout-report.json',
  development: 'dev-smoke-report.json',
  imports: 'import-report.json',
  desktop: 'desktop-report.json',
  packaged: 'packaged-report.json',
  portable: 'portable-report.json',
  uiAccess: 'uiaccess-report.json'
};
const requiredScreenshots = [
  'settings-modes-320x700.png', 'settings-modes-768x432.png', 'settings-lifetime-statistics.png'
];
const previewMappings = [
  ['settings-modes-320x700.png', '抽选设置-小屏预览.png'],
  ['settings-modes-768x432.png', '抽选设置-高缩放预览.png'],
  ['settings-lifetime-statistics.png', '累计统计预览.png'],
  ['47-students-1920x1080.png', '座位表预览.png'],
  ['render-overview-landscape.png', '全览风格预览.png'],
  ['speech-provider-mimo.png', 'MiMo朗读设置预览.png'],
  ['friend-target-configuration.png', '友尽目标设置预览.png'],
  ['desktop-empty-overview.png', '空名单全览预览.png'],
  ['desktop-ball-confirm.png', 'SlateRandom悬浮球预览.png'],
  ['desktop-ball-progress.png', '悬浮球长按进度环预览.png'],
  ['desktop-general-settings.png', '桌面通用设置预览.png']
];
const sourceRootFiles = [
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'vite.config.mts',
  'index.html', 'README.md', 'README.txt', 'HANDOFF.md', 'CONTRIBUTING.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore'
];
const sourceWorkflowFiles = ['.github/workflows/windows-release.yml'];
// These are exact paths from the pre-layout source mirror.  Retire only these
// regular files; never recurse through a user directory or remove a directory.
const mappedOldPaths = [
  'frontend/App.vue','frontend/dom-attributes.d.ts','frontend/main.ts','frontend/application/controller.d.ts','frontend/application/controller.js','frontend/application/demo.ts','frontend/application/initial-state.test.ts','frontend/application/initial-state.ts','frontend/application/press-intent.test.ts','frontend/application/press-intent.ts','frontend/application/scene-performance.test.ts','frontend/application/store.test.ts','frontend/application/store.ts','frontend/application/controller.test.ts','frontend/components/AboutPage.vue','frontend/components/ConfigDialog.vue','frontend/components/DataPage.vue','frontend/components/DesktopSettings.vue','frontend/components/DrawSurface.vue','frontend/components/FloatingBall.vue','frontend/components/GeneralPage.vue','frontend/components/HelpPage.vue','frontend/components/LifetimeStats.vue','frontend/components/MainCloseButton.vue','frontend/components/ModalDialogs.vue','frontend/components/ModeSettings.vue','frontend/components/RosterPage.vue','frontend/components/RulesPage.vue','frontend/components/StatisticsPage.vue','frontend/components/StatusLayer.vue','frontend/desktop/gesture.test.ts','frontend/desktop/gesture.ts','frontend/desktop/state.ts','frontend/desktop/types.ts','frontend/domain/backup.test.ts','frontend/domain/backup.ts','frontend/domain/empty-state.test.ts','frontend/domain/engine.ts','frontend/domain/import.test.ts','frontend/domain/import.ts','frontend/domain/model.ts','frontend/domain/statistics.test.ts','frontend/domain/statistics.ts','frontend/platform/browser.test.ts','frontend/platform/browser.ts','frontend/platform/desktop.test.ts','frontend/platform/desktop.ts','frontend/platform/ports.ts','frontend/scene/camera.js','frontend/scene/draw-sequence.js','frontend/scene/imports.js','frontend/scene/reference-markup.js','frontend/scene/runtime.js','frontend/scene/stage.js','frontend/styles/desktop.css','frontend/styles/empty-roster.css','frontend/styles/theme.css',
  'src/chain-cooldown.test.cjs','src/dialog-transitions.css','src/dialog-transitions.js','src/endgame.test.cjs','src/engine.d.ts','src/engine.js','src/engine.test.cjs','src/friend-seat-config.css','src/friend-seat-config.js','src/friend-transitions.css','src/friend-transitions.js','src/friend.test.cjs','src/icons.css','src/lifetime-stats.css','src/mode-settings.css','src/providers-sources.txt','src/providers.css','src/providers.js','src/providers.test.cjs','src/render-style-ui.css','src/render-style-ui.js','src/seat-transitions.css','src/seat-transitions.js','src/settings-layout.css','src/speech-providers-sources.txt','src/speech-providers.css','src/speech-providers.js','src/speech-providers.test.cjs','src/styles.css','src/time-transitions.css','src/time-transitions.js','src/vendor/MaterialSymbols-LICENSE.txt','src/vendor/MaterialSymbols-NOTICE.txt','src/vendor/MaterialSymbolsOutlined-Subset.woff2','src/vendor/SheetJS-LICENSE.txt','src/vendor/xlsx.full.min.js',
  'desktop/autostart.cjs','desktop/autostart.test.cjs','desktop/ball-drag.cjs','desktop/ball-drag.test.cjs','desktop/ball-shape.cjs','desktop/ball-shape.test.cjs','desktop/data-service.cjs','desktop/data-service.test.cjs','desktop/diagnostics.cjs','desktop/geometry.cjs','desktop/geometry.test.cjs','desktop/handoff.cjs','desktop/handoff.test.cjs','desktop/main.cjs','desktop/portable-data.cjs','desktop/portable-data.test.cjs','desktop/portable-location.cjs','desktop/portable-location.test.cjs','desktop/preload.cjs','desktop/privileges.cjs','desktop/privileges.d.cts','desktop/settings.cjs','desktop/settings.test.cjs','desktop/window-ready.cjs','desktop/window-ready.test.cjs','desktop/z-order.cjs','desktop/z-order.test.cjs','desktop/assets/icon.ico','desktop/assets/icon.png','desktop/assets/icon.svg','desktop/windows/NOTICE.md','desktop/windows/privileges.test.cjs','desktop/windows/SlateRandom.Privileges.cs','desktop/windows/SlateRandom.Privileges.manifest','desktop/windows/task-definition.cjs','desktop/windows/verify-argv.ps1','desktop/windows/verify-task.ps1',
  'qa.mjs','qa-extra.mjs','qa-friend.mjs','qa-render-styles.mjs','qa-settings-layout.mjs','qa-speech.mjs','qa-ui.mjs','scripts/qa-dev-smoke.mjs','scripts/qa-import.mjs','scripts/qa-desktop.mjs','scripts/qa-electron-driver.cjs','scripts/qa-packaged.mjs','scripts/qa-portable.mjs','scripts/qa-uiaccess.mjs','scripts/measure-scene-performance.mjs','scripts/capture-native-window.ps1','scripts/inject-native-touch.ps1','scripts/inspect-native-windows.ps1','export.mjs'
];
const obsoleteSourceFiles = [
  ...mappedOldPaths,
  'desktop/windows/SlateRandom.Privileges.exe', 'desktop/windows/build-info.json',
  'desktop/assets/MaterialSymbolsOutlined-Subset.woff2',
  'build.mjs', 'scripts/split-scene.mjs',
  'src/app.js', 'src/index.html', 'src/mode-settings.js', 'src/lifetime-stats.js',
  'src/lifetime-stats.test.cjs', 'src/cinema-effects.js', 'src/cinema-effects.css'
];
const excludedNames = new Set(['node_modules', '.git', '.vite', '.vite-build', '.openai', '.codex', '.migration-baseline', '__pycache__',
  'build', 'migration-data', 'WORKSPACE-MANIFEST.json',
  'data', 'user-data', 'session-data', 'browser-data', 'roster.json', 'settings.json', 'desktop-settings.json', 'credentials.json',
  'statistics.srstat', '.fairness-key', '.state-transaction.json', '.portable-migration.json']);

function fail(message) { throw new Error(message + '；停止导出。'); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex').toUpperCase(); }
function inside(base, candidate) {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
async function maybeLstat(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function ordinaryFile(file) {
  const item = await maybeLstat(file);
  if (!item || item.isSymbolicLink() || !item.isFile()) fail('需要普通文件：' + path.relative(root, file));
}
async function safeDirectoryChain(base, directory) {
  const absoluteBase = path.resolve(base), absoluteDirectory = path.resolve(directory);
  if (!inside(absoluteBase, absoluteDirectory)) fail('目标目录越出指定范围');
  const relative = path.relative(absoluteBase, absoluteDirectory);
  const parts = relative ? relative.split(path.sep) : [];
  let current = absoluteBase;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = path.join(current, parts[index]);
    const item = await maybeLstat(current);
    if (!item) return;
    if (item.isSymbolicLink() || !item.isDirectory()) fail('目标目录包含链接或非目录：' + current);
  }
}
async function safeDestination(base, file) {
  if (!inside(base, file)) fail('目标文件越出指定范围');
  await safeDirectoryChain(base, path.dirname(file));
  const item = await maybeLstat(file);
  if (item && (item.isSymbolicLink() || !item.isFile())) fail('目标不是可替换的普通文件：' + file);
}
async function readJson(file) {
  await ordinaryFile(file);
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { fail('验证报告不是有效 JSON：' + path.basename(file)); }
}
function completedTime(report, name) {
  const time = Date.parse(report.completedAt);
  if (!Number.isFinite(time)) fail('验证报告缺少完成时间：' + name);
  return time;
}
function checkSuite(report, name, bytes, hash) {
  if (report.artifactBytes !== bytes || typeof report.artifactSha256 !== 'string' || report.artifactSha256.toUpperCase() !== hash ||
      !Array.isArray(report.checks) || !report.checks.length ||
      report.checks.some(check => typeof check !== 'string' || !check.trim()) ||
      !Array.isArray(report.runtimeErrors) || report.runtimeErrors.length ||
      report.failedCheck != null || report.failedAfter != null || report.error != null || report.passed === false ||
      !Array.isArray(report.screenshots)) fail('当前构建与通过的浏览器报告不一致：' + name);
  completedTime(report, name);
}
function checkToolchain(report, hash, bytes) {
  if (report.artifactBytes !== bytes || typeof report.sha256 !== 'string' || report.sha256.toUpperCase() !== hash ||
      report.typecheck?.passed !== true || report.typecheck?.strict !== true || report.typecheck?.strictTemplates !== true) fail('当前 SHA 与严格类型检查证明不一致');
  const groups = ['core', 'desktop', 'domain', 'platform', 'application', 'desktopFrontend'];
  if (!report.unitTests || groups.some(name => !Number.isInteger(report.unitTests[name]) || report.unitTests[name] < 1) ||
      report.unitTests.total < 140 || report.unitTests.failures !== 0 || ['cancelled', 'skipped', 'todo'].some(name => report.unitTests[name] !== 0) ||
      groups.reduce((sum, name) => sum + report.unitTests[name], 0) !== report.unitTests.total) {
    fail('核心、领域、平台与应用测试证明未全部通过');
  }
  completedTime(report, 'modern-toolchain');
  return { ...report.unitTests };
}
function excluded(name) {
  return excludedNames.has(name.toLowerCase()) || name.startsWith('.export-source-') || /^\.env(?:\.|$)/.test(name) || /\.(?:log|zip|tgz|tar\.gz)$/i.test(name);
}
async function collectFiles(directory) {
  const info = await maybeLstat(directory);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) fail('源码目录无效：' + path.relative(root, directory));
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded(entry.name)) continue;
    const file = path.join(directory, entry.name), item = await lstat(file);
    if (item.isSymbolicLink()) fail('源码目录不能包含链接：' + path.relative(root, file));
    if (item.isDirectory()) result.push(...await collectFiles(file));
    else if (item.isFile()) result.push(path.relative(root, file));
    else fail('源码包含非常规文件：' + path.relative(root, file));
  }
  return result;
}

const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
async function powershell(script) {
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(output || 'Archive step failed')));
  });
}
async function sourceArchive(staging, destination, files) {
  const expectedFile = path.join(path.dirname(staging), 'expected-files.json');
  const expected = Object.fromEntries([...files].map(([name, bytes]) => ['源码/' + name.replaceAll('\\', '/'), sha256(bytes)]));
  await writeFile(expectedFile, JSON.stringify(expected));
  await powershell(`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem;
[System.IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(staging)},${psQuote(destination)},[System.IO.Compression.CompressionLevel]::Optimal,$true);
$expected=Get-Content -LiteralPath ${psQuote(expectedFile)} -Raw -Encoding UTF8|ConvertFrom-Json;
$zip=[System.IO.Compression.ZipFile]::OpenRead(${psQuote(destination)}); $seen=@{};
try { foreach($entry in $zip.Entries) { if(!$entry.Name){continue}; $name=$entry.FullName.Replace([char]92,[char]47); $property=$expected.PSObject.Properties[$name];
if(!$property -or $seen.ContainsKey($name)){throw ('Unexpected ZIP entry: '+$name)};
$stream=$entry.Open(); $hash=[System.Security.Cryptography.SHA256]::Create();
try{$actual=[BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','')}finally{$hash.Dispose();$stream.Dispose()};
if($actual -ne $property.Value){throw ('ZIP SHA mismatch: '+$name)}; $seen[$name]=$true };
if($seen.Count -ne @($expected.PSObject.Properties).Count){throw 'ZIP file count mismatch'}
} finally { $zip.Dispose() }`);
}
async function verifyNativeArchive(archive, files) {
  // Validate the exact ZIP handed to users, including empty data directories.
  // Filtering the loose copy alone must not let user data escape in the archive.
  const expected = {};
  for (const file of files) expected['SlateRandom-win32-x64/' + file.relative.replaceAll('\\', '/')] = sha256(await readFile(file.source));
  const encoded = Buffer.from(JSON.stringify(expected), 'utf8').toString('base64');
  await powershell(`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem;
$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psQuote(encoded)}))|ConvertFrom-Json;
$zip=[System.IO.Compression.ZipFile]::OpenRead(${psQuote(archive)}); $seen=@{};
try { foreach($entry in $zip.Entries) { $name=$entry.FullName.Replace([char]92,[char]47);
if($name -match '(^|/)data(/|$)' -or $name -match '(^|/)(roster\\.json|settings\\.json|desktop-settings\\.json|statistics\\.srstat|\\.fairness-key|\\.state-transaction\\.json|\\.portable-migration\\.json)$'){throw ('Personal data in native ZIP: '+$name)};
if(!$entry.Name){continue}; $property=$expected.PSObject.Properties[$name];
if(!$property -or $seen.ContainsKey($name)){throw ('Unexpected native ZIP entry: '+$name)};
$stream=$entry.Open();$hash=[System.Security.Cryptography.SHA256]::Create();
try{$actual=[BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','')}finally{$hash.Dispose();$stream.Dispose()};
if($actual -ne $property.Value){throw ('Native ZIP SHA mismatch: '+$name)};$seen[$name]=$true };
if($seen.Count -ne @($expected.PSObject.Properties).Count){throw 'Native ZIP file count mismatch'}
} finally { $zip.Dispose() }`);
}

// Read-only proof and filesystem preflight. No HTML, report, source mirror or
// staging directory is changed until every required proof below has passed.
await ordinaryFile(artifact);
const html = await readFile(artifact);
if (!html.length) fail('构建 HTML 为空');
const hash = sha256(html);
const suites = Object.fromEntries(await Promise.all(Object.entries(suiteFiles).map(async ([name, file]) => [name, await readJson(path.join(qa, file))])));
for (const [name, report] of Object.entries(suites)) checkSuite(report, name, html.length, hash);
if (suites.development.artifactSha256?.toUpperCase() !== hash ||
    suites.development.moduleProof?.defaultExport !== true ||
    suites.development.moduleProof?.factoryBodyUnchanged !== true ||
    suites.development.moduleProof?.seededDrawMatchesCommonJS !== true ||
    suites.development.moduleProof?.productionPluginAbsent !== true ||
    suites.development.moduleProof?.scriptReloadKeepsState !== true) fail('开发入口与唯一引擎的兼容验证未通过');
const modern = await readJson(path.join(qa, 'modern-toolchain-report.json'));
const unitTests = checkToolchain(modern, hash, html.length);
const screenshots = [...new Set(Object.values(suites).flatMap(report => report.screenshots))];
if (requiredScreenshots.some(name => !screenshots.includes(name))) fail('缺少本次设置布局与累计统计截图');
const screenshotBuffers = new Map();
for (const name of screenshots) {
  if (typeof name !== 'string' || name !== path.basename(name) || !/^[^\0<>:"/\\|?*]+\.png$/i.test(name)) fail('截图文件名无效');
  const file = path.join(qa, name); await ordinaryFile(file);
  const bytes = await readFile(file);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20)) fail('截图不是有效 PNG：' + name);
  screenshotBuffers.set(name, bytes);
}
const selectedPreviews = previewMappings.filter(([name]) => screenshotBuffers.has(name));
const manifest = [...sourceRootFiles, ...sourceWorkflowFiles];
for (const name of ['src', 'resources', 'scripts', 'tests', 'docs']) manifest.push(...await collectFiles(path.join(root, name)));
for (const name of obsoleteSourceFiles) {
  if (manifest.includes(path.join(name))) fail('源码清单仍含已废弃入口：' + name);
}
const sourceBuffers = new Map();
for (const name of [...new Set(manifest)].sort()) {
  const file = path.resolve(root, name);
  if (!inside(root, file)) fail('源码文件越出工作区');
  await ordinaryFile(file); sourceBuffers.set(name, await readFile(file));
}
const pkg = JSON.parse(sourceBuffers.get('package.json').toString('utf8'));
if (!/^3\./.test(pkg.dependencies?.vue ?? '') || !/^7\./.test(pkg.devDependencies?.vite ?? '') || !pkg.packageManager?.startsWith('pnpm@')) fail('现代工具链元数据不完整');
const nativeBuild = await readJson(path.join(root, 'release/desktop-build.json'));
const nativeDirectory = path.resolve(root, nativeBuild.app ?? '');
const nativeZip = path.resolve(root, nativeBuild.portableZip ?? '');
if (nativeDirectory !== path.join(root, 'release/SlateRandom-win32-x64') ||
    path.dirname(nativeZip) !== path.join(root, 'release') || !path.basename(nativeZip).startsWith('SlateRandom-') ||
    nativeBuild.htmlSHA256?.toUpperCase() !== hash || nativeBuild.executableSHA256 !== suites.packaged.executableSha256) fail('桌面发布包与当前验证不一致');
await ordinaryFile(nativeZip);
await ordinaryFile(path.join(nativeDirectory, 'SlateRandom.exe'));
if (sha256(await readFile(path.join(nativeDirectory, 'SlateRandom.exe'))) !== nativeBuild.executableSHA256.toUpperCase()) fail('桌面可执行文件已改变');
const nativeZipBytes = await readFile(nativeZip);
if (nativeZipBytes.length !== nativeBuild.zipBytes) fail('桌面 ZIP 大小与发布清单不一致');
if (suites.packaged.portableZipSha256?.toUpperCase() !== sha256(nativeZipBytes)) fail('桌面 ZIP 与实际解压运行的验证包不一致');
if (suites.portable.portableZipSha256?.toUpperCase() !== sha256(nativeZipBytes) || suites.portable.cleanupConfirmed !== true) fail('目录搬迁及旧资料迁移验收与当前可携带 ZIP 不一致');
await ordinaryFile(path.join(nativeDirectory, 'resources', 'app.asar'));
const appAsarSha256 = sha256(await readFile(path.join(nativeDirectory, 'resources', 'app.asar')));
for (const [name, suite] of [['packaged', suites.packaged], ['portable', suites.portable], ['uiAccess', suites.uiAccess]]) {
  if (typeof suite.appAsarSha256 !== 'string' || suite.appAsarSha256.toUpperCase() !== appAsarSha256) fail('实际原生验收与当前应用代码不一致：' + name);
}
const nativeNames = await collectFiles(nativeDirectory);
const nativeFiles = nativeNames.map(name => ({ source: path.join(root, name), relative: path.relative(nativeDirectory, path.join(root, name)) }));
if (nativeFiles.some(file => !inside(nativeDirectory, file.source) || !file.relative || file.relative.startsWith('..'))) fail('桌面目录文件越出范围');
if (nativeFiles.some(file => file.relative.split(path.sep).some(excluded))) fail('桌面发布清单包含便携个人数据');
await verifyNativeArchive(nativeZip, nativeFiles);
const suiteCounts = Object.fromEntries(Object.entries(suites).map(([name, report]) => [name, report.checks.length]));
const completedAt = new Date(Math.max(completedTime(modern, 'modern-toolchain'), ...Object.entries(suites).map(([name, report]) => completedTime(report, name)))).toISOString();
const report = {
  artifactBytes: html.length, sha256: hash, completedAt, exportedAt: new Date().toISOString(),
  framework: { name: 'Vue 3', vue: pkg.dependencies.vue, language: 'TypeScript', typescript: pkg.devDependencies.typescript,
    bundler: 'Vite 7', vite: pkg.devDependencies.vite, packageManager: pkg.packageManager, format: 'single HTML / classic IIFE' },
  schema: { version: 1,
    desktop: { root: 'executable directory/data', roster: 'roster.json', settingsAndCredentials: 'settings.json', desktopPreferences: 'desktop-settings.json', statistics: 'statistics.srstat', portableKey: '.fairness-key', browserSession: 'browser/', integrity: 'authenticated compressed binary; portable key; discourages casual editing, not absolute tamper resistance' },
    lite: { classStorage: 'localStorage:rollcall-studio:v1', credentialDatabases: ['rollcall-studio:providers', 'rollcall-studio:speech-providers'] },
    backup: { version: 1, partial: 'JSON settings or roster', all: '.slate portable authenticated binary; compatible between Lite and desktop; API keys excluded by default' } },
  typecheck: modern.typecheck, unitTests,
  checks: Object.values(suites).flatMap(item => item.checks), runtimeErrors: [], suites: suiteCounts,
  visionTest: suites.main.visionTest ?? 'localhost mock; no external model call',
  speechTest: suites.speech.speechTest ?? 'localhost mock; no external TTS call', screenshots,
  desktopFile: path.basename(desktop), nativeBuild,
  permissionsTest: suites.uiAccess.permissionsTest,
  scenePerformance: suites.uiAccess.scenePerformance ?? [],
  nativeZipSha256: sha256(nativeZipBytes), appAsarSha256,
  portabilityTest: suites.portable.portability,
  delivery: { htmlAliases: ['点到.html', 'SlateRandom-Lite.html', path.basename(desktop)], preserveExistingNativeData: true, sourceExcludesPersonalData: true }
};
const handoff = handoffText({html, hash, report, unitTests, suiteCounts, completedAt, desktop, pkg});
const reportBytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
const stagedFiles = new Map(sourceBuffers);
stagedFiles.set('继续开发.txt', Buffer.from(handoff));
stagedFiles.set(path.join('dist', 'index.html'), html);
stagedFiles.set(path.join('preview', '点到-预览版.html'), html);
for (const [name, exported] of selectedPreviews) stagedFiles.set(path.join('preview', exported), screenshotBuffers.get(name));
for (const name of Object.values(suiteFiles).concat('modern-toolchain-report.json')) stagedFiles.set(path.join('qa-output', name), await readFile(path.join(qa, name)));
stagedFiles.set(path.join('qa-output', 'final-report.json'), reportBytes);
for (const [name, bytes] of screenshotBuffers) stagedFiles.set(path.join('qa-output', name), bytes);

// Preflight exact destinations, including existing loose-source entries. Unknown
// Other files remain untouched; only the named obsolete regular files retire.
await safeDirectoryChain(userRoot, target);
await safeDirectoryChain(userRoot, sourceMirror);
await safeDirectoryChain(root, preview);
const publicFiles = [path.join(target, '点到.html'), path.join(target, 'SlateRandom-Lite.html'), path.join(target, '使用说明.txt'), path.join(target, '验证报告.json'), desktop];
publicFiles.push(desktopShortcut, path.join(target, path.basename(nativeZip)), path.join(target, '点到-完整源码.zip'), path.join(root, '点到-完整源码.zip'));
for (const file of publicFiles) await safeDestination(userRoot, file);
await safeDestination(root, path.join(preview, '点到-预览版.html'));
await safeDestination(root, path.join(root, '继续开发.txt'));
await safeDestination(root, path.join(qa, 'final-report.json'));
for (const [, exported] of selectedPreviews) {
  await safeDestination(userRoot, path.join(target, exported));
  await safeDestination(root, path.join(preview, exported));
}
for (const name of stagedFiles.keys()) await safeDestination(userRoot, path.join(sourceMirror, name));
for (const file of nativeFiles) await safeDestination(userRoot, path.join(nativeTarget, file.relative));
const retire = [];
for (const name of obsoleteSourceFiles) {
  const file = path.resolve(sourceMirror, name);
  if (!inside(sourceMirror, file) || path.relative(sourceMirror, file).split(path.sep).join('/') !== name || path.basename(file) === '') fail('旧源码清理目标不符');
  await safeDirectoryChain(userRoot, path.dirname(file));
  const item = await maybeLstat(file);
  if (!item) continue;
  if (item.isSymbolicLink() || !item.isFile()) fail('旧源码清理目标是目录或链接，拒绝删除：' + file);
  retire.push(file);
}

// All proofs have passed. Build a new clean source tree first, then copy the
// exact verified HTML to both user locations. ZIP packaging is a separate step.
const stagingRoot = await mkdtemp(path.join(root, '.export-source-'));
try {
const staging = path.join(stagingRoot, '源码');
await mkdir(staging, { recursive: true });
for (const [name, bytes] of stagedFiles) {
  const file = path.join(staging, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
}
const sourceZip = path.join(stagingRoot, '点到-完整源码.zip');
await sourceArchive(staging, sourceZip, stagedFiles);
await mkdir(target, { recursive: true });
await mkdir(path.dirname(desktop), { recursive: true });
await mkdir(preview, { recursive: true });
await writeFile(path.join(target, '点到.html'), html);
await writeFile(path.join(target, 'SlateRandom-Lite.html'), html);
await writeFile(desktop, html);
await writeFile(path.join(preview, '点到-预览版.html'), html);
await writeFile(path.join(target, '使用说明.txt'), sourceBuffers.get('README.txt'));
await writeFile(path.join(target, '验证报告.json'), reportBytes);
await writeFile(path.join(qa, 'final-report.json'), reportBytes);
await writeFile(path.join(root, '继续开发.txt'), handoff, 'utf8');
for (const [name, exported] of selectedPreviews) {
  const bytes = screenshotBuffers.get(name); await writeFile(path.join(target, exported), bytes); await writeFile(path.join(preview, exported), bytes);
}
for (const file of retire) {
  await safeDestination(userRoot, file);
  const current = await maybeLstat(file);
  if (current) {
    if (current.isSymbolicLink() || !current.isFile()) fail('旧源码清理目标已改变');
    await unlink(file);
  }
}
for (const name of stagedFiles.keys()) {
  const destination = path.join(sourceMirror, name);
  await safeDestination(userRoot, destination);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(staging, name), destination);
}
await copyFile(sourceZip, path.join(target, '点到-完整源码.zip'));
await copyFile(sourceZip, path.join(root, '点到-完整源码.zip'));
await copyFile(nativeZip, path.join(target, path.basename(nativeZip)));
for (const file of nativeFiles) {
  const destination = path.join(nativeTarget, file.relative);
  await safeDestination(userRoot, destination); await mkdir(path.dirname(destination), { recursive: true });
  const sourceHash = sha256(await readFile(file.source));
  const existing = await maybeLstat(destination);
  // Identical Chromium resources can be mapped by an existing process. They
  // already are the verified version and do not need another write.
  if (!existing || sha256(await readFile(destination)) !== sourceHash) await copyFile(file.source, destination);
  if (sha256(await readFile(destination)) !== sourceHash) fail('桌面发布目录副本 SHA 不一致：' + file.relative);
}
const launch = path.join(nativeTarget, 'SlateRandom.exe');
await powershell(`$ErrorActionPreference='Stop'; $shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut(${psQuote(desktopShortcut)}); $link.TargetPath=${psQuote(launch)}; $link.WorkingDirectory=${psQuote(nativeTarget)}; $link.IconLocation=${psQuote(launch + ',0')}; $link.Description='SlateRandom 岩选 — DeepslateQAQ'; $link.Save()`);
if (sha256(await readFile(path.join(target, path.basename(nativeZip)))) !== sha256(nativeZipBytes)) fail('桌面发布 ZIP 副本 SHA 不一致');
const sourceZipHash = sha256(await readFile(sourceZip));
for (const file of [path.join(target, '点到-完整源码.zip'), path.join(root, '点到-完整源码.zip')]) if (sha256(await readFile(file)) !== sourceZipHash) fail('源码 ZIP 副本 SHA 不一致');
const htmlCopies = [artifact, path.join(target, '点到.html'), path.join(target, 'SlateRandom-Lite.html'), desktop, path.join(preview, '点到-预览版.html'), path.join(sourceMirror, 'dist', 'index.html'), path.join(staging, 'dist', 'index.html')];
for (const file of htmlCopies) {
  if (sha256(await readFile(file)) !== hash) fail('HTML 同步副本 SHA 不一致');
}
console.log(JSON.stringify({ target, desktop, staging, artifactBytes: html.length, sha256: hash,
  browserChecks: report.checks.length, suites: suiteCounts, unitTests, typecheck: modern.typecheck,
  screenshots: screenshots.length, sourceFiles: stagedFiles.size, sourceZipHash, nativeFiles: nativeFiles.length, nativeZip: path.join(target, path.basename(nativeZip)), desktopShortcut, retiredSourceFiles: retire.map(file => path.basename(file)) }));
} finally {
  const verified = await realpath(stagingRoot);
  if (path.dirname(verified) !== await realpath(root) || !path.basename(verified).startsWith('.export-source-')) throw Error('拒绝清理未经验证的导出暂存路径。');
  await rm(verified, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
