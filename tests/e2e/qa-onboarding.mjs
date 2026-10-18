import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// Runs the exported offline HTML. The first-run flow must appear on a truly
// empty profile only, and every other fixture in the suite must stay out of it.
const root = fileURLToPath(new URL('../../', import.meta.url)), output = path.join(root, 'qa-output');
const KEY = 'rollcall-studio:v1', checks = [], screenshots = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
await mkdir(output, { recursive: true });
const parent = await realpath(tmpdir()), profile = await mkdtemp(path.join(parent, 'rollcall-onboarding-'));
let browser, client, lastLabel = 'startup';

class CDP {
  constructor(ws) {
    this.ws = ws; this.next = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', event => {
      const m = JSON.parse(String(event.data));
      if (m.id) {
        const p = this.pending.get(m.id); if (!p) return;
        clearTimeout(p.timer); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.next, timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timed out')); }, 15000);
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(fn, ...args) {
    const r = await this.send('Runtime.evaluate', { expression: '(' + fn.toString() + ').apply(null,' + JSON.stringify(args) + ')', awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}
async function waitFor(fn, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) { try { if (await fn()) return; } catch (_) {} await pause(60); }
  throw new Error('condition timed out at ' + lastLabel);
}
function check(label, value) { lastLabel = label; assert.ok(value, label); checks.push(label); console.log('PASS ' + label); }
async function click(id) { await client.evaluate(async id => { const e = document.getElementById(id); e.focus({ preventScroll: true }); e.click(); await new Promise(resolve => setTimeout(resolve, 0)); }, id); }
async function selectClick(selector) { await client.evaluate(async selector => { const e = document.querySelector(selector); e.focus({ preventScroll: true }); e.click(); await new Promise(resolve => setTimeout(resolve, 0)); }, selector); }
async function picture(name) { const data = await client.send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(output, name), Buffer.from(data.data, 'base64')); screenshots.push(name); }
async function storedState() { return client.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY); }
async function dialogOpen(id) { return client.evaluate(id => document.getElementById(id)?.open === true, id); }
async function step() { return client.evaluate(() => document.querySelector('[data-onboarding-step]')?.dataset.onboardingStep || ''); }
async function finishIntro() {
  // The welcome page reveals its actions after the intro; either wait it out or
  // advance it with a real click, exactly like a user who does not sit through it.
  await waitFor(() => client.evaluate(() => document.getElementById('onboardingStartBtn')?.disabled === false), 6000);
}
async function reloadPage() { await client.send('Page.reload'); await waitFor(() => client.evaluate(() => typeof window.DrawCore?.createState === 'function' && document.querySelectorAll('[data-mode-row]').length === 5)); }

try {
  browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--headless=new', '--disable-gpu', '--blink-settings=primaryHoverType=2,availableHoverTypes=2', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-proxy-server', '--remote-debugging-port=0', '--window-size=1000,800', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let port; await waitFor(async () => { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return port > 0; }, 20000);
  const target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(t => t.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  client = new CDP(socket); await client.send('Page.enable'); await client.send('Runtime.enable');
  await client.send('Page.navigate', { url: pathToFileURL(path.join(root, 'dist/index.html')).href });
  await waitFor(() => client.evaluate(() => typeof window.DrawCore?.createState === 'function' && document.querySelectorAll('[data-mode-row]').length === 5));

  await client.evaluate(() => { localStorage.clear(); });
  await reloadPage();
  await waitFor(() => dialogOpen('onboardingDialog'));
  check('全新浏览器首次打开进入全窗口引导的欢迎页', await client.evaluate(() => {
    const dialog = document.getElementById('onboardingDialog');
    return dialog.open === true && dialog.matches(':modal') && document.getElementById('onboardingTitle').textContent.includes('SlateRandom 岩选')
      && !!document.getElementById('onboardingStartBtn') && !!document.getElementById('onboardingImportBackupBtn')
      && !!document.getElementById('onboardingBackupFile') && !!document.getElementById('onboardingSkipBtn');
  }));
  check('欢迎页不写入完成标记，刷新仍会继续引导', (await storedState())?.settings?.onboardingCompleted !== true);
  await picture('onboarding-welcome.png');

  await finishIntro();
  await click('onboardingStartBtn');
  await waitFor(async () => (await step()) === 'appearance');
  check('进入外观步骤并显示独立 id 的外观预览', await client.evaluate(() => { const oobe = document.getElementById('onboardingAppearancePreview'); const settings = document.getElementById('appearancePreview'); return !!oobe && oobe !== settings && oobe.closest('#onboardingDialog') !== null && settings.closest('#configDialog') !== null; }));
  await selectClick('[data-onboarding-theme="dark"]');
  await waitFor(() => client.evaluate(() => document.documentElement.dataset.themePreference === 'dark'));
  check('外观步骤切换深色主题即时预览并保存', await client.evaluate(key => document.documentElement.dataset.settingsTheme === 'dark' && JSON.parse(localStorage.getItem(key)).settings.theme === 'dark', KEY));
  await picture('onboarding-appearance.png');

  await click('onboardingNextBtn');
  await waitFor(async () => (await step()) === 'roster');
  check('名单步骤提供导入入口且不重复触发全局导入监听', await client.evaluate(() => { const b = document.getElementById('onboardingImportRosterBtn'); return !!b && !b.hasAttribute('data-import') && document.getElementById('onboardingRosterStatus').textContent.includes('还没有名单'); }));
  await click('onboardingImportRosterBtn');
  await waitFor(() => dialogOpen('importDialog'));
  check('引导内可以打开嵌套的名单导入对话框且引导保持打开', await client.evaluate(() => document.getElementById('importDialog').open && document.getElementById('importDialog').matches(':modal') && document.getElementById('onboardingDialog').open));
  check('名单导入对话框只接收识别结果，不再混入备份文件入口', await client.evaluate(() => !document.getElementById('rosterJsonFile')));
  await client.evaluate(() => window.DialogTransitions.close(document.getElementById('importDialog')));
  await waitFor(async () => !(await dialogOpen('importDialog')));
  await client.evaluate(() => document.dispatchEvent(new Event('slate:open-settings')));
  await pause(250);
  check('引导进行中托盘设置被忽略，不会叠加在引导上', await client.evaluate(() => !document.getElementById('configDialog').open && document.getElementById('onboardingDialog').open));
  check('空名单时下一步改为稍后再说', await client.evaluate(() => document.getElementById('onboardingNextBtn').textContent.includes('稍后再说')));

  // The roster step owns a dedicated 「导入名单备份」 button for saved roster files.
  check('名单步骤提供独立的导入名单备份按钮', await client.evaluate(() => document.getElementById('onboardingImportRosterBackupBtn').textContent.includes('导入名单备份')));
  await client.evaluate(backup => {
    const input = document.getElementById('onboardingRosterBackupFile');
    const transfer = new DataTransfer();
    transfer.items.add(new File([JSON.stringify(backup)], 'roster.json', { type: 'application/json' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, {
    format: 'SlateRandom.backup', version: 1, kind: 'roster', createdAt: '2026-10-18T00:00:00Z',
    roster: {
      className: '备份班级', demo: false, cols: 3, seatRows: 4,
      students: [
        { id: '3', name: '丙', row: 1, col: 2, active: true },
        { id: '1', name: '甲', row: 1, col: 1, active: true },
        { id: '7', name: '丁', row: 3, col: 2, active: true }
      ]
    }
  });
  await waitFor(() => dialogOpen('confirmDialog'));
  check('导入名单备份先确认再替换名单', await client.evaluate(() => document.getElementById('confirmTitle').textContent === '导入名单'));
  await click('confirmActionBtn');
  await waitFor(async () => !(await dialogOpen('confirmDialog')));
  check('导入名单备份保留座位表、班级名与空余行，并继续停留在引导里', await client.evaluate(key => {
    const state = JSON.parse(localStorage.getItem(key));
    return state.className === '备份班级' && state.cols === 3 && state.seatRows === 4 && state.students.length === 3
      && state.students.find(student => student.id === '7').row === 3
      && state.settings.onboardingCompleted === false
      && document.getElementById('onboardingDialog').open
      && document.getElementById('onboardingRosterStatus').textContent.includes('已导入 3 位同学');
  }, KEY));
  check('导入名单备份后下一步恢复为正常文案', await client.evaluate(() => document.getElementById('onboardingNextBtn').textContent.includes('下一步')));

  await click('onboardingNextBtn');
  await waitFor(async () => (await step()) === 'probability');
  check('概率步骤使用 onboarding 前缀的独占 id', await client.evaluate(() => !!document.getElementById('onboarding-modeOptions') && !!document.getElementById('onboarding-manualModeInput') && !!document.getElementById('onboarding-directionChanceInput')));
  await client.evaluate(() => { const input = document.getElementById('onboarding-directionChanceInput'); input.value = '20'; input.dispatchEvent(new Event('change', { bubbles: true })); });
  await waitFor(async () => (await storedState())?.settings?.directionChance === 20);
  check('引导内调整概率立即保存到本机存储', (await storedState()).settings.directionChance === 20);
  await picture('onboarding-probability.png');

  await click('onboardingNextBtn');
  await waitFor(async () => (await step()) === 'finish');
  check('完成页只有标题与开始抽人按钮', await client.evaluate(() => !!document.getElementById('onboardingFinishBtn') && !document.getElementById('onboardingNextBtn') && !document.getElementById('onboardingSkipBtn')));
  await click('onboardingFinishBtn');
  await waitFor(async () => !(await dialogOpen('onboardingDialog')));
  check('完成后关闭引导、回到主页并写入完成标记', (await storedState()).settings.onboardingCompleted === true && await client.evaluate(() => !!document.getElementById('drawBtn') && !document.querySelector('.onboarding-cover')));
  await picture('onboarding-finished.png');

  await reloadPage();
  check('刷新后不再进入引导', !(await dialogOpen('onboardingDialog')) && await client.evaluate(() => !!document.getElementById('drawBtn')));
  await client.evaluate(() => document.dispatchEvent(new Event('slate:open-settings')));
  await waitFor(() => dialogOpen('configDialog'));
  check('引导关闭后设置页保留原名 id 的模式控件', await client.evaluate(() => !document.getElementById('onboarding-modeOptions') && !document.getElementById('onboardingDialog').open && !!document.getElementById('configDialog').open));

  await selectClick('[data-nav="about"]');
  await selectClick('#rerunOnboardingBtn');
  await waitFor(() => dialogOpen('onboardingDialog'));
  check('关于页可以重新运行引导并回到欢迎页', (await step()) === 'welcome' && await dialogOpen('onboardingDialog'));
  check('重新运行引导写入未完成标记', (await storedState()).settings.onboardingCompleted === false);
  await waitFor(() => client.evaluate(() => document.getElementById('onboardingSkipBtn')?.disabled === false));
  await click('onboardingSkipBtn');
  await waitFor(async () => !(await dialogOpen('onboardingDialog')));
  check('重新运行后跳过引导关闭全窗口界面并恢复主页', !(await dialogOpen('onboardingDialog')) && (await storedState()).settings.onboardingCompleted === true && await client.evaluate(() => !!document.getElementById('drawBtn')));
  check('本轮引导浏览器检查没有未处理 JavaScript 异常', client.errors.length === 0);

  const report = { completedAt: new Date().toISOString(), checks, runtimeErrors: client.errors, screenshots };
  await writeFile(path.join(output, 'onboarding-report.json'), JSON.stringify(report, null, 2));
  console.log('Onboarding browser QA complete: ' + checks.length + ' checks');
} catch (error) {
  let diagnostic;
  try { diagnostic = await client?.evaluate(() => ({ dialogs: Array.from(document.querySelectorAll('dialog')).map(d => ({ id: d.id, open: d.open })), step: document.querySelector('[data-onboarding-step]')?.dataset.onboardingStep || '', stored: localStorage.getItem('rollcall-studio:v1') })); } catch (_) {}
  await writeFile(path.join(output, 'onboarding-partial-report.json'), JSON.stringify({ failedAfter: lastLabel, error: error.stack, checks, runtimeErrors: client?.errors || [], diagnostic, screenshots }, null, 2));
  throw error;
} finally {
  if (client) { try { await client.send('Browser.close'); } catch (_) {} client.ws.close(); }
  if (browser && !browser.killed) browser.kill();
  await pause(500); const resolved = await realpath(profile).catch(() => null);
  if (resolved && path.dirname(resolved) === parent && path.basename(resolved).startsWith('rollcall-onboarding-')) await rm(resolved, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
