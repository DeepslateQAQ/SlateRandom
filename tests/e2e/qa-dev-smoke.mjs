import { createServer, resolveConfig } from 'vite';
import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// This suite uses the real development server and local classroom fixtures.
// --modules-only validates module adaptation without starting a browser.
const root = fileURLToPath(new URL('../../', import.meta.url)), output = path.join(root, 'qa-output');
const artifact = await readFile(path.join(root, 'dist/index.html'));
const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
const parent = await realpath(tmpdir()), profile = await mkdtemp(path.join(parent, 'rollcall-dev-'));
const KEY = 'rollcall-studio:v1', checks = [], pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const modulesOnly = process.argv.includes('--modules-only');
let server, browser, client, lastLabel = 'startup', moduleProof;

class CDP {
  constructor(ws) {
    this.ws = ws; this.next = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.next, timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timed out')); }, 18000);
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(fn, ...args) {
    const result = await this.send('Runtime.evaluate', { expression: '(' + fn.toString() + ').apply(null,' + JSON.stringify(args) + ')', awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
}
async function waitFor(fn, ms = 20000) {
  const started = Date.now();
  while (Date.now() - started < ms) { try { if (await fn()) return; } catch (_) {} await pause(55); }
  throw new Error('condition timed out at ' + lastLabel);
}
function check(label, value) { lastLabel = label; assert.ok(value, label); checks.push(label); console.log('PASS ' + label); }
async function settled(id, open = true) { await waitFor(() => client.evaluate((id, open) => { const dialog = document.getElementById(id); return dialog?.open === open && !dialog.dataset.motion; }, id, open), 4500); }
async function click(selector) { await client.evaluate(async selector => { const node = document.querySelector(selector); if (!node) throw Error('Missing ' + selector); node.click(); await new Promise(resolve => setTimeout(resolve, 0)); }, selector); }

async function proveDevelopmentModules(base) {
  const optimizer = server.environments.client.depsOptimizer;
  await optimizer.scanProcessing;
  await waitFor(() => Boolean(optimizer.metadata.optimized.vue));
  const domain = await server.transformRequest('/src/renderer/domain/engine.ts');
  const enginePath = domain.code.match(/import canonicalEngine from "([^"]+)"/)[1];
  const transformed = await server.transformRequest(enginePath);
  assert.match(transformed.code, /export default canonicalEngine/);
  const source = await readFile(path.join(root, 'src/shared/domain/engine.js'), 'utf8');
  const factory = source.slice(source.indexOf("  'use strict';"), source.lastIndexOf('\n});')).replace(/\r$/, '');
  assert.ok(transformed.code.includes(factory), 'Development must reuse the original algorithm body without editing it');
  const adapted = (await import('data:text/javascript;base64,' + Buffer.from(transformed.code).toString('base64'))).default;
  const canonical = createRequire(import.meta.url)('../../src/shared/domain/engine.js');
  const students = [{ id: '1', name: '甲', row: 1, col: 1 }, { id: '2', name: '乙', row: 1, col: 2 }, { id: '3', name: '丙', row: 2, col: 1 }];
  const left = adapted.createState(students, 5678), right = canonical.createState(students, 5678);
  left.settings = adapted.settings({ strategy: 'manual', manualMode: 'normal', endJumpChance: 0, friendEnabled: false });
  right.settings = canonical.settings(left.settings);
  adapted.draw(left, new Date('2026-10-14T10:20:30')); canonical.draw(right, new Date('2026-10-14T10:20:30'));
  assert.deepEqual(left, right, 'Development and CommonJS must produce the same seeded record and state');
  const speech = await server.transformRequest('/src/renderer/legacy/speech-providers.js');
  assert.ok(speech.code.includes(await readFile(path.join(root, 'src/renderer/legacy/speech-providers.js'), 'utf8')), 'Other browser-global adapters must remain unchanged');
  const home = await fetch(base), body = await home.text(), servedEngine = await fetch(new URL(enginePath, base));
  assert.equal(home.status, 200); assert.equal(servedEngine.status, 200);
  assert.ok((await servedEngine.text()).includes('export default canonicalEngine'));
  const production = await resolveConfig({ root, configFile: path.join(root, 'vite.config.mts') }, 'build');
  assert.ok(!production.plugins.some(plugin => plugin.name === 'rollcall:canonical-engine-dev-module'));
  assert.ok((await readFile(path.join(root, 'dist/index.html'))).equals(artifact), 'The development probe must not rebuild the production artifact');
  return { actualDomainImport: enginePath, defaultExport: true, factoryBodyUnchanged: true, seededDrawMatchesCommonJS: true, legacySpeechModuleUnchanged: true, httpEntry: home.status, httpEngine: servedEngine.status, entryHasViteClient: body.includes('/@vite/client'), productionPluginAbsent: true };
}

try {
  server = await createServer({ root, configFile: path.join(root, 'vite.config.mts'), cacheDir: path.join(profile, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: true } });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw Error('Vite did not listen on a local TCP port');
  const base = 'http://127.0.0.1:' + address.port + '/';
  moduleProof = await proveDevelopmentModules(base);
  console.log('Development module proof: ' + JSON.stringify({ ...moduleProof, artifactBytes: artifact.length, artifactSha256 }));

  if (!modulesOnly) {
    await mkdir(output, { recursive: true });
    const edgeProfile = path.join(profile, 'edge');
    browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-proxy-server', '--remote-debugging-port=0', '--window-size=1000,800', '--user-data-dir=' + edgeProfile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let port;
    await waitFor(async () => { port = Number((await readFile(path.join(edgeProfile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return port > 0; });
    const target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(target => target.type === 'page');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    client = new CDP(socket); await client.send('Page.enable'); await client.send('Runtime.enable');
    await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await client.send('Page.navigate', { url: base });
    await waitFor(() => client.evaluate(() => document.getElementById('app')?.__vue_app__ && typeof window.DrawCore?.draw === 'function' && document.querySelectorAll('[data-mode-row]').length === 5));
    check('真实 Vite 开发入口挂载 Vue 与 canonical engine，启动无默认导出错误', await client.evaluate(() => location.hostname === '127.0.0.1' && !!document.getElementById('app').__vue_app__ && typeof DrawCore.restoreState === 'function') && client.errors.length === 0);
    check('真实开发入口默认空名单，未自动生成课堂示例或历史', await client.evaluate(key => {
      const saved = JSON.parse(localStorage.getItem(key) || 'null');
      return document.querySelectorAll('#rosterSeats [data-student]').length === 0 && (!saved || saved.students.length === 0 && saved.round === 0 && saved.history.length === 0 && saved.demo === false);
    }, KEY));

    const fixture = await client.evaluate(() => {
      const students = Array.from({ length: 47 }, (_, index) => ({ id: String(index + 1), name: '开发同学' + String(index + 1).padStart(2, '0'), row: Math.floor(index / 8) + 1, col: index % 8 + 1, active: true }));
      const value = DrawCore.createState(students, 9761); value.demo = false; value.className = '开发回归班';
      value.settings = DrawCore.settings({ strategy: 'manual', manualMode: 'normal', endJumpChance: 0, friendEnabled: false, voice: false, renderStyle: 'normal' });
      return value;
    });
    await client.evaluate((key, value) => { localStorage.setItem(key, JSON.stringify(value)); window.__devOldPage = true; }, KEY, fixture);
    await client.send('Page.reload');
    await waitFor(() => client.evaluate(() => !window.__devOldPage && document.getElementById('app')?.__vue_app__ && document.querySelectorAll('#rosterSeats [data-student]').length === 47));
    check('开发页面刷新从原 v1 key 恢复 47 人、8×6 减一空座和五行功能设置', await client.evaluate(key => { const saved = JSON.parse(localStorage.getItem(key)); return saved.version === 1 && saved.className === '开发回归班' && saved.students.length === 47 && saved.round === 0 && document.querySelectorAll('#rosterSeats .empty').length === 1 && document.querySelectorAll('[data-mode-row]').length === 5; }, KEY));

    const elapsed = await client.evaluate(async () => {
      const started = performance.now(); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 150));
      const held = performance.now() - started; document.body.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true })); return held;
    });
    await waitFor(() => client.evaluate(key => { const value = JSON.parse(localStorage.getItem(key)); return value.round === 1 && document.getElementById('drawBtn').getAttribute('aria-busy') === 'false' && document.getElementById('stageName').textContent === value.history[0].name; }, KEY), 25000);
    check('真实空格按住 150 ms 仅抽一次，结果名字、座位与 seeded canonical 状态一致', elapsed >= 130 && elapsed < 200 && await client.evaluate((key, original) => {
      const saved = JSON.parse(localStorage.getItem(key)), expected = DrawCore.restoreState(original), record = saved.history[0]; DrawCore.draw(expected, new Date(record.time));
      return saved.history.length === 1 && saved.lastId === expected.lastId && saved.rngState === expected.rngState && document.querySelector('#liveSeats .current').dataset.liveStudent === saved.lastId && document.getElementById('stageName').textContent === record.name;
    }, KEY, fixture));

    await client.evaluate(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })); await new Promise(resolve => setTimeout(resolve, 540)); document.body.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true })); });
    await settled('configDialog');
    const pages = [];
    for (const page of ['general', 'roster', 'data', 'help', 'about', 'dashboard']) {
      await click('.navigation [data-nav="' + page + '"]');
      pages.push(await client.evaluate(page => {
        const view = document.getElementById('view-' + page), selected = document.querySelector('.navigation [data-nav="' + page + '"]');
        if (view.hidden || selected.getAttribute('aria-current') !== 'page') return false;
        if (page === 'roster') return view.querySelectorAll('[data-student].seat').length === 47;
        if (page === 'data') return view.querySelectorAll('[data-stats-student]').length === 47 && document.getElementById('lifetimeTotalDraws').textContent === '1次' && view.contains(document.getElementById('backupBtn'));
        if (page === 'general') return ['SlateRandom', 'Lite'].every(value => view.textContent.includes(value)) && !document.getElementById('desktopSettings') && !document.getElementById('desktopCloseMainBtn');
        if (page === 'help') return view.textContent.includes('操作指南');
        if (page === 'about') return ['SlateRandom', '岩选', 'Lite'].every(value => view.textContent.includes(value) && document.title.includes(value)) && view.textContent.includes('DeepslateQAQ') && view.textContent.includes('MIT');
        return view.querySelectorAll('[data-mode-row]').length === 5;
      }, page));
    }
    check('开发入口长按 500 ms 打开配置，六页真实切换且累计统计保留，Lite 隐藏桌面控件并不增加抽取', pages.every(Boolean) && await client.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 1 && document.getElementById('configDialog').open, KEY));

    await client.evaluate(async () => { const input = document.getElementById('directionChanceInput'); input.focus(); input.value = '20'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 0)); });
    const changed = await client.evaluate(key => JSON.parse(localStorage.getItem(key)).settings.directionChance === 20 && document.getElementById('directionChanceInput').value === '20' && document.getElementById('modeChance-normal').value === '47' && !document.getElementById('settingsDialog').open, KEY);
    await client.evaluate(() => DialogTransitions.close(document.getElementById('configDialog'))); await settled('configDialog', false);
    check('开发页面概率按真实事件持久化并更新普通剩余概率，全部操作无运行异常', changed && client.errors.length === 0 && (await readFile(path.join(root, 'dist/index.html'))).equals(artifact));

    // Exercise a real component edit: native keyboard handlers must restart
    // once, restore saved state, and avoid duplicate draws after a dev refresh.
    const appFile = path.join(root, 'src/renderer/App.vue'), originalApp = await readFile(appFile);
    try {
      await client.evaluate(() => { window.__devBeforeEdit = true; });
      await writeFile(appFile, Buffer.concat([originalApp, Buffer.from('\n<!-- development refresh verification -->\n')]));
      await waitFor(() => client.evaluate(key => !window.__devBeforeEdit && document.getElementById('app')?.__vue_app__ && document.getElementById('drawBtn').getAttribute('aria-busy') === 'false' && JSON.parse(localStorage.getItem(key)).round === 1, KEY));
      await client.evaluate(async () => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 150));
        document.body.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
      });
      await waitFor(() => client.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 2 && document.getElementById('drawBtn').getAttribute('aria-busy') === 'false', KEY));
      await pause(300);
      check('真实组件修改自动刷新并保留记录和配置，刷新后空格仅新增一轮且不重复注册监听', await client.evaluate(key => {
        const saved = JSON.parse(localStorage.getItem(key));
        return saved.round === 2 && saved.history.length === 2 && saved.settings.directionChance === 20 && document.getElementById('stageName').textContent === saved.history.at(-1).name;
      }, KEY) && client.errors.length === 0);
      moduleProof.scriptReloadKeepsState = true;
    } finally {
      await writeFile(appFile, originalApp);
      assert.ok((await readFile(appFile)).equals(originalApp));
    }
    await writeFile(path.join(output, 'dev-smoke-report.json'), JSON.stringify({ completedAt: new Date().toISOString(), artifactBytes: artifact.length, artifactSha256, checks, runtimeErrors: client.errors, screenshots: [], moduleProof, source: 'real localhost Vite development server; no external model calls' }, null, 2));
    console.log('Vite development browser smoke complete: ' + checks.length + ' checks');
  }
} catch (error) {
  if (!modulesOnly) {
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'dev-smoke-partial-report.json'), JSON.stringify({ completedAt: new Date().toISOString(), artifactBytes: artifact.length, artifactSha256, failedAfter: lastLabel, error: error.stack, checks, runtimeErrors: client?.errors || [], moduleProof }, null, 2));
  }
  throw error;
} finally {
  if (client) { try { await client.send('Browser.close'); } catch (_) {} client.ws.close(); }
  if (browser && !browser.killed) browser.kill();
  await server?.close(); await pause(500);
  const absolute = await realpath(profile).catch(() => null);
  if (absolute && path.dirname(absolute) === parent && path.basename(absolute).startsWith('rollcall-dev-')) await rm(absolute, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => {});
}
