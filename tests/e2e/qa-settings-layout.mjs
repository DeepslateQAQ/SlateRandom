import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// Validate the exported offline app, using local students and actual DrawCore
// records. No API provider or external account is contacted by this suite.
const root = fileURLToPath(new URL('../../', import.meta.url)), output = path.join(root, 'qa-output');
const artifact = await readFile(path.join(root, 'dist/index.html'));
const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
const KEY = 'rollcall-studio:v1', checks = [], screenshots = [], pause = ms => new Promise(resolve => setTimeout(resolve, ms));
await mkdir(output, { recursive: true });
const parent = await realpath(tmpdir()), profile = await mkdtemp(path.join(parent, 'rollcall-settings-'));
let browser, client, lastLabel = 'startup';

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
async function waitFor(fn, ms = 12000) {
  const started = Date.now();
  while (Date.now() - started < ms) { try { if (await fn()) return; } catch (_) {} await pause(55); }
  throw new Error('condition timed out at ' + lastLabel);
}
function check(label, value) { lastLabel = label; assert.ok(value, label); checks.push(label); console.log('PASS ' + label); }
async function settled(id, open = true) { await waitFor(() => client.evaluate((id, open) => { const dialog = document.getElementById(id); return dialog?.open === open && !dialog.dataset.motion; }, id, open), 4500); }
async function click(selector) { await client.evaluate(async selector => { const element = document.querySelector(selector); if (!element) throw Error('Missing ' + selector); element.focus({ preventScroll: true }); element.click(); await new Promise(resolve => setTimeout(resolve, 0)); }, selector); }
async function close(id) { await client.evaluate(id => window.DialogTransitions.close(document.getElementById(id)), id); await settled(id, false); }
async function picture(name) { const result = await client.send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(output, name), Buffer.from(result.data, 'base64')); screenshots.push(name); }
async function state() { return client.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY); }
async function reload(value, { keepAppearance = false } = {}) {
  if (value?.settings) value.settings.onboardingCompleted = true;
  if (value?.settings && !keepAppearance) { value.settings.theme = 'classic'; value.settings.radius = 0; }
  await client.evaluate((key, value) => { if (value) localStorage.setItem(key, JSON.stringify(value)); window.__settingsOldPage = true; }, KEY, value);
  await client.send('Page.reload');
  await waitFor(() => client.evaluate(() => !window.__settingsOldPage && document.querySelectorAll('[data-mode-row]').length === 5));
}
async function finished() { await waitFor(() => client.evaluate(() => document.getElementById('drawBtn').getAttribute('aria-busy') === 'false'), 25000); }
async function openConfig() {
  await client.evaluate(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 540));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
  });
  await settled('configDialog');
}
async function keyboardHold(duration) {
  return client.evaluate(async duration => {
    document.body.focus(); const started = performance.now();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, duration));
    const elapsed = performance.now() - started;
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
    return { elapsed, config: document.getElementById('configDialog').open, releaseDuration: parseFloat(document.getElementById('drawBtn').style.getPropertyValue('--hold-release-duration')) || 0 };
  }, duration);
}
async function pointerHold(duration) {
  const point = await client.evaluate(() => {
    const button = document.getElementById('drawBtn'), rect = button.getBoundingClientRect();
    window.__settingsPointerTimes = [];
    for (const type of ['pointerdown', 'pointerup']) button.addEventListener(type, event => { if (event.isTrusted) window.__settingsPointerTimes.push({ type, at: performance.now() }); }, { once: true });
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
  await client.evaluate(duration => new Promise(resolve => setTimeout(resolve, duration)), duration);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
  return client.evaluate(() => { const times = window.__settingsPointerTimes; return { elapsed: times.at(-1).at - times[0].at, trusted: times.length === 2 }; });
}
async function changeChance(mode, value) {
  return client.evaluate(async (mode, value) => {
    const input = document.querySelector('[data-mode-chance="' + mode + '"]'); input.focus(); input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    return { value: Number(input.value), detailsOpen: document.getElementById('settingsDialog').open };
  }, mode, value);
}
async function fixture(size = 6, lifetime = false) {
  return client.evaluate((size, lifetime) => {
    const students = Array.from({ length: size }, (_, i) => ({ id: String(i + 1), name: '测试同学' + String(i + 1).padStart(2, '0'), row: Math.floor(i / 8) + 1, col: i % 8 + 1, active: true }));
    const value = DrawCore.createState(students, 1547);
    value.demo = false; value.className = '设置回归班';
    value.settings = DrawCore.settings({ strategy: 'manual', manualMode: 'normal', friendChance: 20, directionChance: 33, timeChance: 33, endJumpChance: 0, voice: false, renderStyle: 'normal' });
    if (lifetime) {
      for (let i = 0; i < 11; i++) DrawCore.draw(value, new Date(1791955200000 + i * 1000));
      DrawCore.reset(value);
      for (let i = 0; i < 3; i++) DrawCore.draw(value, new Date(1791958800000 + i * 1000));
      const oldest = Object.keys(value.fairnessStats).find(id => !value.counts[id]);
      if (!oldest) throw Error('Fixture lacks previous-session student');
      value.students.find(student => student.id === oldest).active = false;
    }
    return value;
  }, size, lifetime);
}

try {
  browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-proxy-server', '--remote-debugging-port=0', '--window-size=1120,850', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let port;
  await waitFor(async () => { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return port > 0; }, 20000);
  const target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(target => target.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  client = new CDP(socket); await client.send('Page.enable'); await client.send('Runtime.enable');
  await client.send('Page.navigate', { url: pathToFileURL(path.join(root, 'dist/index.html')).href });
  await waitFor(() => client.evaluate(() => document.querySelectorAll('[data-mode-row]').length === 5));
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

  const fresh = await fixture();
  await reload(fresh); const shortSpace = await keyboardHold(150); await waitFor(() => client.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 1, KEY)); await finished();
  check('空格按住 150 ms 松开仅抽一人，适用新的 200 ms 取消边界', shortSpace.elapsed >= 130 && shortSpace.elapsed < 200 && !shortSpace.config && (await state()).round === 1);
  await reload(fresh); const longSpace = await keyboardHold(230); await pause(Math.max(650, longSpace.releaseDuration + 150));
  check('空格按住超过 200 ms 松开取消抽选且不会打开配置', longSpace.elapsed >= 200 && longSpace.elapsed < 500 && !longSpace.config && (await state()).round === 0);
  await reload(fresh); const shortPointer = await pointerHold(135); await waitFor(() => client.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 1, KEY)); await finished();
  check('原生指针在 100～200 ms 内松开仅抽一人，与空格边界一致', shortPointer.trusted && shortPointer.elapsed >= 100 && shortPointer.elapsed < 200 && (await state()).round === 1);
  await reload(fresh); const longPointer = await pointerHold(230); await pause(650);
  check('原生指针超过 200 ms 松开不抽人且进度条收回', longPointer.trusted && longPointer.elapsed >= 200 && longPointer.elapsed < 500 && (await state()).round === 0 && await client.evaluate(() => !document.getElementById('drawBtn').hasAttribute('data-hold-releasing')));
  await openConfig();
  check('长按 500 ms 仍打开配置且不进行抽选', (await state()).round === 0 && await client.evaluate(() => document.getElementById('configDialog').open));

  check('设置导航固定为通用、功能、名单、数据、帮助、关于六页，使用内嵌 Material 图标', await client.evaluate(() => {
    const expected = [['general', '通用'], ['dashboard', '功能'], ['roster', '名单'], ['data', '数据'], ['help', '帮助'], ['about', '关于']];
    const buttons = Array.from(document.querySelectorAll('.navigation [data-nav]'));
    return buttons.length === expected.length && buttons.every((button, index) => button.dataset.nav === expected[index][0] && button.textContent.replace(button.querySelector('.material-icon').textContent, '').trim().startsWith(expected[index][1]));
  }));
  check('全览入口使用原生切换按钮并同步当前未开启状态', await client.evaluate(() => {
    const button = document.getElementById('renderStylePicker');
    return button.tagName === 'BUTTON' && button.type === 'button' && button.getAttribute('aria-pressed') === 'false' && button.textContent.includes('全览') && !button.querySelector('input');
  }));
  await click('.navigation [data-nav="about"]');
  check('Lite 标题与关于页面显示 SlateRandom 岩选品牌及作者 DeepslateQAQ', await client.evaluate(() => {
    const about = document.getElementById('view-about'), heading = about.querySelector('h2')?.textContent || '';
    return ['SlateRandom', '岩选', 'Lite'].every(value => document.title.toLowerCase().includes(value.toLowerCase()) && heading.toLowerCase().includes(value.toLowerCase())) && about.textContent.includes('DeepslateQAQ') && about.textContent.includes('GPL');
  }));
  check('关于页提供 SecRandom 与 ICC-CE 的仓库和官网友情链接', await client.evaluate(() => {
    const about = document.getElementById('view-about');
    const links = Array.from(about.querySelectorAll('.about-friend-links a'), anchor => anchor.href);
    const expected = [
      'https://github.com/SECTL/SecRandom',
      'https://secrandom.sectl.cn/',
      'https://github.com/InkCanvasForClass/community',
      'https://iccce.ink/'
    ];
    return about.textContent.includes('如果对岩选不够满意，您也可以尝试：') && links.length === expected.length && expected.every(url => links.includes(url)) &&
      about.querySelectorAll('.about-friend-links li').length === 2 && about.querySelectorAll('.about-friend-logo').length === 2 &&
      about.querySelectorAll('.about-friend-actions a').length === 4 && !about.textContent.includes('SECTL/SecRandom') &&
      !about.textContent.includes('secrandom.sectl.cn') && !about.textContent.includes('InkCanvasForClass/community') && !about.textContent.includes('iccce.ink');
  }));
  await click('.navigation [data-nav="general"]');
  check('Lite 通用页面显示浏览器偏好并隐藏所有桌面关闭、自启及提权控件', await client.evaluate(() => {
    const page = document.getElementById('view-general');
    return !window.slateDesktop && !page.hidden && ['SlateRandom', 'Lite'].every(value => page.textContent.toLowerCase().includes(value.toLowerCase())) && page.contains(document.getElementById('liteFullscreenInput')) && !document.getElementById('desktopSettings') && !document.getElementById('desktopCloseMainBtn') && !document.getElementById('desktopUacInput');
  }));
  await click('.navigation [data-nav="data"]');
  check('数据页集中设置、名单与全部备份入口及累计统计，密钥导出默认关闭且只出现一组恢复控件', await client.evaluate(() => {
    const page = document.getElementById('view-data');
    const ids = ['exportSettingsBtn', 'importSettingsBtn', 'settingsBackupFile', 'exportRosterBtn', 'importRosterBtn', 'rosterBackupFile', 'backupBtn', 'restoreBackupBtn', 'sendToDesktopBtn', 'backupFile', 'includeSecretsToggle', 'backupDataStatus', 'dataDirectoryText', 'lifetimeStatsMount'];
    const toggle = document.getElementById('includeSecretsToggle'), style = getComputedStyle(toggle), send = document.getElementById('sendToDesktopBtn');
    return !page.hidden && ids.every(id => page.contains(document.getElementById(id)) && document.querySelectorAll('#' + id).length === 1) && !toggle.checked && toggle.getAttribute('role') === 'switch' && style.appearance === 'none' && document.getElementById('backupFile').accept.includes('.slate') && document.getElementById('backupFile').accept.includes('.json') && send.tagName === 'BUTTON' && send.textContent.includes('发送到桌面版') && page.contains(send.closest('.backup-row-all'));
  }));

  await click('.navigation [data-nav="roster"]');
  check('班级、导入与座位管理集中在名单页，备份集中数据页，功能页保留模式与概率', await client.evaluate(() => {
    const roster = document.getElementById('view-roster'), dashboard = document.getElementById('view-dashboard');
    return ['classBtn', 'swapBtn', 'reflowBtn', 'rosterSeats', 'rosterTable'].every(id => roster.contains(document.getElementById(id))) &&
      roster.querySelector('[data-import]') && !roster.querySelector('#backupBtn,#restoreBackupBtn') && document.getElementById('view-data').contains(document.getElementById('backupBtn')) && !dashboard.querySelector('[data-import],#classBtn,#rosterSeats,#desktopSettings') && dashboard.contains(document.getElementById('modeOptions'));
  }));
  await click('.navigation [data-nav="dashboard"]');
  check('五行功能的名称、概率与矩形开关对齐，有附加设置的四种模式保留最右入口', await client.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-mode-row]'));
    return rows.length === 5 && rows.every(row => {
      const chance = row.querySelector('[data-mode-chance]'), toggle = row.querySelector('[data-mode-enabled]'), detail = row.querySelector('[data-mode-control="details"]');
      const a = chance.getBoundingClientRect(), b = toggle.getBoundingClientRect(), c = detail?.getBoundingClientRect();
      const detailsFit = row.dataset.modeRow === 'endJump' ? !detail && row.tabIndex === -1 : c && row.tabIndex === 0 && b.right <= c.left + 1 && Math.abs(b.top + b.height / 2 - c.top - c.height / 2) < 3;
      return chance.type === 'number' && toggle.type === 'checkbox' && toggle.getAttribute('role') === 'switch' && row.getAttribute('role') === 'group' && detailsFit &&
        a.right <= b.left + 1 && Math.abs(a.top + a.height / 2 - b.top - b.height / 2) < 3;
    }) && document.getElementById('modeChance-normal').readOnly && document.getElementById('modeEnabled-normal').checked && document.getElementById('modeEnabled-normal').disabled;
  }));

  for (const [width, height, scale] of [[1120, 850, 1], [768, 432, 2.5], [320, 700, 1]]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: width === 320 });
    await pause(320);
    const geometry = await client.evaluate(() => {
      const dialog = document.getElementById('configDialog'), box = dialog.getBoundingClientRect(), content = dialog.querySelector('.config-content');
      const rows = Array.from(document.querySelectorAll('[data-mode-row]')).map(row => {
        const rect = row.getBoundingClientRect(), chance = row.querySelector('[data-mode-chance]').getBoundingClientRect(), toggle = row.querySelector('[data-mode-enabled]').getBoundingClientRect(), detail = row.querySelector('[data-mode-control="details"]')?.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width, chanceRight: chance.right, toggleLeft: toggle.left, toggleRight: toggle.right, detailLeft: detail?.left ?? rect.right, detailRight: detail?.right ?? rect.right };
      });
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, documentFits: document.documentElement.scrollWidth <= innerWidth + 1, dialogFits: dialog.scrollWidth <= dialog.clientWidth + 1, contentFits: content.scrollWidth <= content.clientWidth + 1, rows };
    });
    check(width + '×' + height + '@' + scale + ' 设置布局无水平溢出且概率、开关、入口保持同一行', geometry.left >= -1 && geometry.right <= width + 1 && geometry.top >= -1 && geometry.bottom <= height + 1 && geometry.documentFits && geometry.dialogFits && geometry.contentFits && geometry.rows.every(row => row.left >= -1 && row.right <= width + 1 && row.chanceRight <= row.toggleLeft + 1 && row.toggleRight <= row.detailLeft + 1 && row.detailRight <= row.right + 1));
    await picture('settings-modes-' + width + 'x' + height + '.png');
  }
  await client.send('Emulation.clearDeviceMetricsOverride');
  check('概率输入的未提交编辑与焦点在真实同页刷新时保留，避免渲染覆盖正在输入的数值', await client.evaluate(async () => {
    const input = document.getElementById('directionChanceInput'); input.focus(); input.value = '12'; input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.navigation [data-nav="dashboard"]').click(); await new Promise(resolve => setTimeout(resolve, 0));
    document.querySelector('.navigation [data-nav="dashboard"]').click(); await new Promise(resolve => setTimeout(resolve, 0));
    const kept = document.activeElement === input && input === document.getElementById('directionChanceInput') && input.value === '12';
    input.value = '33'; input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 0)); return kept;
  }));
  const changed = await changeChance('direction', 20);
  check('行内概率修改立即保存且更新普通剩余概率，不误打开附加设置', changed.value === 20 && !changed.detailsOpen && (await state()).settings.directionChance === 20 && await client.evaluate(() => document.getElementById('modeChance-normal').value === '47'));
  const rejected = await changeChance('direction', 90);
  check('连坐与时间超过 100% 时拒绝并回滚原值，友尽概率独立于合计', rejected.value === 20 && !rejected.detailsOpen && (await state()).settings.directionChance === 20 && await client.evaluate(() => (DialogTransitions.topModal() || document).querySelector('[data-toast-host]').textContent.includes('100%')));
  await waitFor(() => client.evaluate(() => { const h = DialogTransitions.topModal()?.querySelector('[data-toast-host]'); return h && Number(getComputedStyle(h).opacity) > .5; }));
  check('概率错误通知实际位于当前 modal 可见区域并作为 live region 发布', await client.evaluate(() => { const modal = DialogTransitions.topModal(), host = modal?.querySelector('[data-toast-host]'), r = host?.getBoundingClientRect(); return modal?.matches(':modal') && host?.getAttribute('aria-live') === 'polite' && host.getAttribute('role') === 'status' && r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && getComputedStyle(host).visibility === 'visible' && Number(getComputedStyle(host).opacity) > 0; }));
  await client.evaluate(async () => { const modal = DialogTransitions.topModal(); modal.scrollTop = modal.scrollHeight; await new Promise(requestAnimationFrame); });
  check('滚动当前配置后通知仍在 modal 可见面内而非页面底层', await client.evaluate(() => { const modal = DialogTransitions.topModal(), host = modal.querySelector('[data-toast-host]'), h = host.getBoundingClientRect(), d = modal.getBoundingClientRect(); return h.width > 0 && h.height > 0 && h.top >= Math.max(0, d.top) && h.bottom <= Math.min(innerHeight, d.bottom) && Array.from(document.querySelectorAll('[data-toast-host]')).filter(other => other !== host).every(other => !other.textContent.trim()); }));
  await click('#modeEnabled-direction');
  check('模式开关立即保存、禁用概率并保留预设值，取消连坐后概率归普通且不误开详情', !(await state()).settings.modes.includes('direction') && await client.evaluate(() => document.getElementById('directionChanceInput').disabled && document.getElementById('directionChanceInput').value === '20' && document.getElementById('modeChance-normal').value === '67' && !document.getElementById('settingsDialog').open));
  await close('configDialog'); await reload(); await openConfig();
  check('关闭模式及其概率预设跨刷新保留，重新开启恢复原概率', await client.evaluate(async key => {
    const input = document.getElementById('directionChanceInput'), toggle = document.getElementById('modeEnabled-direction');
    const preserved = !toggle.checked && input.disabled && input.value === '20'; toggle.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const stored = JSON.parse(localStorage.getItem(key));
    return preserved && stored.settings.directionChance === 20 && stored.settings.modes.includes('direction') && !input.disabled && input.value === '20';
  }, KEY));
  for (const [mode, expected] of [['normal', ['cooldownInput', 'strengthInput']], ['direction', ['directionMinInput', 'directionMaxInput', 'directionCooldownMinInput', 'directionCooldownMaxInput']], ['time', ['timeSourceInput', 'timeSelectionInput', 'positionsInput']], ['friend', []]]) {
    await click('[data-mode-row="' + mode + '"] .mode-setting-heading'); await settled('settingsDialog');
    const detail = await client.evaluate((mode, expected) => {
      const dialog = document.getElementById('settingsDialog'), panels = Array.from(dialog.querySelectorAll('[data-settings-panel]')).filter(panel => !panel.hidden && getComputedStyle(panel).display !== 'none');
      return { panels: panels.map(panel => panel.dataset.settingsPanel), fields: expected.every(id => { const element = document.getElementById(id); return element && dialog.contains(element) && element.getClientRects().length > 0; }), noInline: !dialog.querySelector('[data-mode-chance],[data-mode-enabled]'), context: dialog.dataset.settingsContext || '' };
    }, mode, expected);
    check(mode + ' 模式点击行背景打开对应附加设置，概率与开关留在原模式行', detail.panels.includes(mode) && detail.panels.every(panel => panel === mode) && detail.fields && detail.noInline && detail.context === mode);
    await close('settingsDialog');
  }
  await client.evaluate(() => document.querySelector('[data-mode-row="time"]').focus());
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await settled('settingsDialog');
  check('模式行支持原生键盘焦点与 Enter 打开详情，内嵌 Material 图标保持单字形', await client.evaluate(async () => {
    await document.fonts.ready;
    const icon = document.querySelector('[data-mode-row="time"] .material-icon'), style = getComputedStyle(icon), range = document.createRange(); range.selectNodeContents(icon);
    return document.getElementById('settingsDialog').dataset.settingsContext === 'time' && icon.textContent === 'schedule' && style.fontFamily.includes('Material') && range.getBoundingClientRect().width <= parseFloat(style.fontSize) * 1.2;
  }));
  await close('settingsDialog'); await close('configDialog');

  const accumulated = await fixture(47, true), lifetimeBefore = JSON.stringify(accumulated.fairnessStats);
  await reload(accumulated); await openConfig(); await click('.navigation [data-nav="data"]');
  check('数据页提供匿名分析报告导出按钮，明确排除姓名、学号、班级与凭据', await client.evaluate(() => {
    const button = document.getElementById('exportAnalysisBtn'), row = button?.closest('.backup-row');
    return !!button && button.textContent.includes('导出分析数据') && row.textContent.includes('姓名、学号、班级') && row.textContent.includes('匿名键');
  }));
  check('统计显示全部 47 人的跨会话累计次数，包括暂停同学，并区分累计 14 次与本次 3 次', await client.evaluate(fixture => {
    const rows = Array.from(document.querySelectorAll('[data-stats-student]'));
    return rows.length === 47 && document.getElementById('lifetimeTotalDraws').textContent === '14次' && document.getElementById('lifetimeSessionRound').textContent === '3次' && rows.every(row => {
      const id = row.dataset.statsStudent, student = fixture.students.find(student => student.id === id);
      return Number(row.querySelector('[data-stats-value="draws"]').textContent) === (fixture.fairnessStats[id]?.draws || 0) && Number(row.querySelector('[data-stats-value="session"]').textContent) === (fixture.counts[id] || 0) && (student.active || row.classList.contains('lifetime-stats-paused'));
    });
  }, accumulated));
  check('统计明细呈现保存的样本数、归一位置总和及平均值，历史只保留真实三条本次记录', await client.evaluate(fixture => {
    const actual = Array.from(document.querySelectorAll('[data-stats-student]')).every(row => {
      const saved = fixture.fairnessStats[row.dataset.statsStudent] || { positionSamples: 0, positionSum: 0 }, details = Object.fromEntries(Array.from(row.querySelectorAll('.lifetime-stats-details > div'), pair => [pair.querySelector('dt').textContent, pair.querySelector('dd').textContent]));
      const position = row.querySelector('[data-stats-value="position"]'), expectedAverage = saved.positionSamples ? saved.positionSum / saved.positionSamples : null;
      return details['出场位置样本'] === saved.positionSamples + ' 次' && Number(details['归一出场位置总和']) === saved.positionSum && (expectedAverage === null ? position.textContent.startsWith('—') : Number(position.title) === expectedAverage && Number(details['平均归一出场位次']) === expectedAverage);
    });
    const historical = Array.from(document.querySelectorAll('#historyTable tr'));
    return actual && historical.length === 3 && historical.every(row => /^#\d+/.test(row.firstElementChild.textContent)) && JSON.parse(localStorage.getItem('rollcall-studio:v1')).history.length === 3;
  }, accumulated));
  await picture('settings-lifetime-statistics.png');
  const scrollProbe = await client.evaluate(async () => {
    const content = document.querySelector('.config-content'), table = document.querySelector('.lifetime-stats-scroll');
    table.scrollIntoView({ block: 'center' });
    await new Promise(resolve => setTimeout(resolve, 120));
    content.scrollTop = Math.max(0, content.scrollTop - 120);
    const rect = table.getBoundingClientRect();
    return { top: content.scrollTop, x: rect.x + rect.width / 2,
      y: Math.min(innerHeight - 160, Math.max(rect.y + 300, 260)), tableTop: table.scrollTop };
  });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: scrollProbe.x, y: scrollProbe.y, deltaX: 0, deltaY: 300 });
  await pause(320);
  const scrollAfter = await client.evaluate(() => ({ top: document.querySelector('.config-content').scrollTop, tableTop: document.querySelector('.lifetime-stats-scroll').scrollTop }));
  check('长期统计表格上滚轮仍可上下翻阅数据页，不被横向滚动容器截断', scrollAfter.top > scrollProbe.top && scrollAfter.tableTop === scrollProbe.tableTop);
  await client.evaluate(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', key: 'r', bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 540));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR', key: 'r', bubbles: true }));
  });
  await waitFor(() => client.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 0 && document.getElementById('drawBtn').getAttribute('aria-busy') === 'false', KEY), 25000);
  await reload(); await openConfig(); await click('.navigation [data-nav="data"]');
  check('实际 R 长按重置后刷新，长期公平统计完全保留、累计仍为 14 次、本次归零且没有伪造旧历史', JSON.stringify((await state()).fairnessStats) === lifetimeBefore && await client.evaluate(() => document.getElementById('lifetimeTotalDraws').textContent === '14次' && document.getElementById('lifetimeSessionRound').textContent === '0次' && document.querySelectorAll('#historyTable tr').length === 1 && document.querySelector('#historyTable td').colSpan === 5));
  await close('configDialog');
  const oldCounters = structuredClone(fresh); oldCounters.fairnessStats = { '1': { draws: 7, positionSamples: 0, positionSum: 0 } };
  await reload(oldCounters); await openConfig(); await click('.navigation [data-nav="data"]');
  check('只有旧累计计数而无位置样本时显示未知位次，不编造位置、样本或历史', await client.evaluate(() => {
    const row = document.querySelector('[data-stats-student="1"]'), details = Object.fromEntries(Array.from(row.querySelectorAll('.lifetime-stats-details > div'), pair => [pair.querySelector('dt').textContent, pair.querySelector('dd').textContent]));
    return document.getElementById('lifetimeTotalDraws').textContent === '7次' && row.querySelector('[data-stats-value="position"]').textContent.startsWith('—') && details['出场位置样本'] === '0 次' && details['平均归一出场位次'] === '尚无位置样本' && JSON.parse(localStorage.getItem('rollcall-studio:v1')).history.length === 0;
  }));

  check('离线 HTML 的元数据对应真实 Vue 3 挂载、TypeScript、Vite 与锁定 pnpm 构建', await client.evaluate(() => {
    const metadata = JSON.parse(document.getElementById('buildMetadata').textContent), application = document.getElementById('app').__vue_app__;
    return metadata.framework === 'Vue 3' && metadata.language === 'TypeScript' && metadata.bundler === 'Vite' && metadata.format === 'classic IIFE' && /^pnpm@\d+\.\d+\.\d+$/.test(metadata.packageManager) && /^3\./.test(metadata.vue) && application && application.version === metadata.vue && application._container === document.getElementById('app');
  }));
  check('导出保持 file:// 可直接运行，只有经典内联脚本、内联样式与 data 字体，保留依赖许可证', await client.evaluate(() => {
    const scripts = Array.from(document.scripts), fontRules = [];
    const visit = rules => { for (const rule of rules) { if (rule.type === CSSRule.FONT_FACE_RULE) fontRules.push(rule.cssText); if (rule.cssRules) visit(rule.cssRules); } };
    for (const sheet of document.styleSheets) visit(sheet.cssRules);
    return location.protocol === 'file:' && scripts.some(script => !script.type && script.textContent.length > 50000) && scripts.every(script => !script.src && ['', 'text/plain'].includes(script.type)) && !document.querySelector('link[rel="stylesheet"],link[rel="modulepreload"]') && fontRules.some(rule => rule.includes('Material Symbols Outlined') && rule.includes('data:font/woff2;base64,')) && ['dependencyLicenses', 'sheetjsLicense', 'materialSymbolsLicense'].every(id => document.getElementById(id)?.textContent.length > 100);
  }));
  check('现代界面沿用 v1 本机数据格式，核心恢复能完整读回跨会话统计与设定', await client.evaluate(key => {
    const saved = JSON.parse(localStorage.getItem(key)), restored = DrawCore.restoreState(saved);
    return saved.version === 1 && key === 'rollcall-studio:v1' && restored.className === '设置回归班' && restored.students.length === 6 && restored.fairnessStats['1'].draws === 7 && restored.settings.directionChance === saved.settings.directionChance && restored.settings.timeChance === saved.settings.timeChance && restored.round === 0;
  }, KEY));
  check('三类数据页面的模式、座位与统计列表在真实同页发布后保留 keyed DOM 节点，不销毁整表', await client.evaluate(async () => {
    const selectors = ['[data-mode-row]', '#rosterSeats [data-student]', '#rosterTable tr', '[data-stats-student]'];
    const before = selectors.map(selector => Array.from(document.querySelectorAll(selector)));
    const statistics = document.querySelector('[data-stats-student="1"]'); statistics.querySelector('details summary').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    document.querySelector('.navigation [data-nav="data"]').click(); await new Promise(resolve => setTimeout(resolve, 0));
    const after = selectors.map(selector => Array.from(document.querySelectorAll(selector)));
    return before[0].length === 5 && before.slice(1).every(nodes => nodes.length === 6) && before.every((nodes, index) => nodes.length === after[index].length && nodes.every((node, ordinal) => node === after[index][ordinal])) && statistics.querySelector('details').open;
  }));
  await close('configDialog'); await reload(accumulated); await openConfig(); await click('.navigation [data-nav="roster"]');
  check('语义主题 token 修改能改变真实当前座位的高亮色，恢复后颜色与原图一致', await client.evaluate(async () => {
    const root = document.documentElement, seat = document.querySelector('#rosterSeats .current');
    if (!seat) throw Error('Theme check needs the actual last-drawn seat');
    const originalInline = root.style.getPropertyValue('--color-accent'), before = getComputedStyle(seat).backgroundColor;
    let changed, restored;
    try {
      root.style.setProperty('--color-accent', 'rgb(128, 64, 255)'); await new Promise(resolve => setTimeout(resolve, 350)); changed = getComputedStyle(seat).backgroundColor;
    } finally {
      if (originalInline) root.style.setProperty('--color-accent', originalInline); else root.style.removeProperty('--color-accent');
      await new Promise(resolve => setTimeout(resolve, 350)); restored = getComputedStyle(seat).backgroundColor;
    }
    return changed === 'rgb(128, 64, 255)' && changed !== before && restored === before;
  }));

  await click('.navigation [data-nav="general"]');
  check('通用页外观区提供预览、四种主题、十个圆形预设色、圆角滑块、AI 与自定义 CSS 入口', await client.evaluate(() => {
    const page = document.getElementById('view-general');
    const swatches = Array.from(document.querySelectorAll('[data-appearance-accent]'));
    return !page.hidden && !!document.getElementById('appearancePreview') &&
      document.querySelectorAll('[data-appearance-theme]').length === 4 &&
      swatches.length === 10 &&
      swatches.every(swatch => {
        const box = swatch.getBoundingClientRect();
        return Math.abs(box.width - box.height) < 1 && box.width >= 34 && box.width <= 36;
      }) &&
      ['appearanceRadius', 'appearanceAccentHex', 'appearanceBackgroundTint', 'appearanceAiPrompt', 'appearanceCss', 'appearanceCssSave', 'appearanceProviderBtn', 'appearanceAiGenerate']
        .every(id => !!document.getElementById(id));
  }));
  const themeSnapshot = async theme => {
    await click('[data-appearance-theme="' + theme + '"]'); await pause(320);
    return client.evaluate(() => ({
      stage: document.documentElement.dataset.stageTheme,
      settings: document.documentElement.dataset.settingsTheme,
      dialog: getComputedStyle(document.getElementById('configDialog')).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor
    }));
  };
  const lightTheme = await themeSnapshot('light');
  check('浅色主题同时照亮舞台与设置', lightTheme.stage === 'light' && lightTheme.settings === 'light' && lightTheme.dialog === 'rgb(255, 255, 255)' && lightTheme.body === 'rgb(244, 246, 243)');
  const darkTheme = await themeSnapshot('dark');
  check('深色主题让舞台与设置都使用深色表面', darkTheme.stage === 'dark' && darkTheme.settings === 'dark' && darkTheme.dialog === 'rgb(13, 14, 13)');
  check('深色设置的开关滑块使用独立高对比 token', await client.evaluate(() => {
    const input = document.getElementById('liteFullscreenInput');
    return getComputedStyle(input, '::before').backgroundColor === 'rgb(185, 189, 185)';
  }));
  await client.evaluate(() => document.getElementById('resetDrawBtn').setAttribute('data-reset-holding', ''));
  const resetHoldColor = await client.evaluate(() => getComputedStyle(document.getElementById('resetDrawBtn')).color);
  await client.evaluate(() => document.getElementById('resetDrawBtn').removeAttribute('data-reset-holding'));
  check('红色长按进度上的文字保持白色', resetHoldColor === 'rgb(255, 255, 255)');
  const classicTheme = await themeSnapshot('classic');
  check('经典主题保留深色舞台与浅色设置', classicTheme.stage === 'dark' && classicTheme.settings === 'light' && classicTheme.dialog === 'rgb(255, 255, 255)');
  const radius16 = await client.evaluate(async () => {
    const input = document.getElementById('appearanceRadius');
    input.value = '16';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 140));
    return {
      dialog: getComputedStyle(document.getElementById('configDialog')).borderRadius,
      draw: getComputedStyle(document.getElementById('drawBtn')).borderRadius,
      seat: getComputedStyle(document.querySelector('#rosterSeats .seat')).borderRadius,
      thumb: getComputedStyle(document.getElementById('liteFullscreenInput'), '::before').borderRadius,
      drawFill: getComputedStyle(document.getElementById('drawBtn'), '::before').borderRadius,
      resetFill: getComputedStyle(document.getElementById('resetDrawBtn'), '::before').borderRadius,
      historyResetFill: getComputedStyle(document.getElementById('resetBtn'), '::before').borderRadius,
      cssClearRadius: getComputedStyle(document.getElementById('appearanceCssClear')).borderRadius,
      cssImportRadius: getComputedStyle(document.getElementById('appearanceCssImport')).borderRadius,
      cssImportTag: document.getElementById('appearanceCssImport').tagName,
      stored: JSON.parse(localStorage.getItem('rollcall-studio:v1')).settings.radius
    };
  });
  check('圆角滑块按控件 1×、座位 1.5×、对话框 2× 生效并持久化', radius16.dialog === '32px' && radius16.draw === '16px' && radius16.seat === '24px' && radius16.thumb === '12px' && radius16.stored === 16);
  check('长按进度填充继承按钮圆角，不在圆角处留下直角溢出', radius16.drawFill === '16px' && radius16.resetFill === '16px' && radius16.historyResetFill === '16px');
  check('自定义 CSS 的清空与文件导入按钮共享原生按钮样式和圆角', radius16.cssClearRadius === '16px' && radius16.cssImportRadius === '16px' && radius16.cssImportTag === 'BUTTON');
  await client.evaluate(() => {
    const input = document.getElementById('appearanceRadius');
    input.value = '8';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await pause(140);
  check('圆角恢复为 8 并持久化', await client.evaluate(key => JSON.parse(localStorage.getItem(key)).settings.radius === 8, KEY));
  await click('[data-appearance-accent="indigo"]'); await pause(280);
  check('预设主题色种子驱动当前座位与舞台高亮', await client.evaluate(key => {
    const settings = JSON.parse(localStorage.getItem(key)).settings;
    const root = getComputedStyle(document.documentElement);
    const current = document.querySelector('#rosterSeats .current');
    return settings.accent === '#6366f1' && root.getPropertyValue('--color-accent').trim() === '#6366f1' &&
      getComputedStyle(current).backgroundColor === 'rgb(99, 102, 241)';
  }, KEY));
  await client.evaluate(() => {
    const input = document.getElementById('appearanceAccentHex');
    input.value = '#000000';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await pause(240);
  check('极端自定义主题色经 HCT 约束后不会变成不可见黑色', await client.evaluate(key => {
    const settings = JSON.parse(localStorage.getItem(key)).settings;
    return settings.accent !== '#000000' && settings.accent !== '#ffffff' &&
      getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() === settings.accent &&
      document.getElementById('appearanceAccentHex').value === settings.accent;
  }, KEY));
  await click('[data-appearance-accent="indigo"]'); await pause(240);
  const tintSnapshot = () => client.evaluate(() => ({
    enabled: document.documentElement.dataset.backgroundTint,
    body: getComputedStyle(document.body).backgroundColor,
    dialog: getComputedStyle(document.getElementById('configDialog')).backgroundColor,
    preview: getComputedStyle(document.querySelector('.appearance-preview-stage')).backgroundColor,
    canvas: getComputedStyle(document.querySelector('.draw-screen')).backgroundColor,
    token: getComputedStyle(document.documentElement).getPropertyValue('--stage-canvas').trim()
  }));
  const tintOff = await tintSnapshot();
  await click('#appearanceBackgroundTint'); await pause(280);
  const tintOn = await tintSnapshot(), tintStored = await client.evaluate(key => JSON.parse(localStorage.getItem(key)).settings.backgroundTint, KEY);
  check('背景颜色扩散同时作用于主舞台、设置页背景与对话框', tintOn.enabled === 'true' && tintStored === true &&
    tintOn.token !== tintOff.token && tintOn.body !== tintOff.body && tintOn.dialog !== tintOff.dialog &&
    tintOn.canvas === tintOn.body && tintOn.canvas !== tintOff.canvas && tintOn.preview !== tintOff.preview);
  await click('#appearanceBackgroundTint'); await pause(280);
  const tintRestored = await tintSnapshot(), tintRestoredStored = await client.evaluate(key => JSON.parse(localStorage.getItem(key)).settings.backgroundTint, KEY);
  check('关闭背景颜色扩散恢复设置页、预览与主舞台原始底色', tintRestored.enabled === 'false' && tintRestoredStored === false &&
    tintRestored.body === tintOff.body && tintRestored.dialog === tintOff.dialog &&
    tintRestored.canvas === tintOff.canvas && tintRestored.preview === tintOff.preview);
  await client.evaluate(() => {
    const area = document.getElementById('appearanceCss');
    area.value = '.qa-appearance{color:rgb(1,2,3)}';
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('#appearanceCssSave'); await pause(280);
  check('自定义 CSS 保存后注入最后一个样式元素', await client.evaluate(() => {
    const style = document.getElementById('slate-appearance-custom-css');
    return style.textContent.includes('.qa-appearance') && style.textContent.includes('rgb(1,2,3)');
  }));
  await client.evaluate(() => {
    const area = document.getElementById('appearanceCss');
    area.value = '@import url(https://example.com/a.css);\n:root{--qa-external:1}';
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('#appearanceCssSave'); await pause(280);
  check('外部资源 CSS 保存前提示并保持旧样式不变', await client.evaluate(() => {
    const warning = document.getElementById('appearanceCssWarning');
    return !!warning && warning.textContent.includes('example.com') &&
      !document.getElementById('slate-appearance-custom-css').textContent.includes('@import');
  }));
  await client.evaluate(() => document.querySelector('#appearanceCssWarning .btn-primary').click()); await pause(280);
  check('确认后写入含外部资源的 CSS', await client.evaluate(() => document.getElementById('slate-appearance-custom-css').textContent.includes('@import url(https://example.com/a.css)')));
  await client.evaluate(() => {
    const buttons = [...document.querySelectorAll('.appearance-css-actions button')];
    buttons.find(button => button.textContent.trim() === '清空').click();
  });
  await pause(280);
  check('清空自定义 CSS 并关闭开关', await client.evaluate(key => {
    const settings = JSON.parse(localStorage.getItem(key)).settings;
    return document.getElementById('slate-appearance-custom-css').textContent === '' &&
      settings.customCss === '' && settings.customCssEnabled === false;
  }, KEY));
  await click('[data-appearance-theme="dark"]'); await pause(160);
  await client.evaluate(() => {
    const input = document.getElementById('appearanceRadius');
    input.value = '10';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const area = document.getElementById('appearanceCss');
    area.value = ':root{--qa-persist:1}';
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('#appearanceCssSave'); await pause(280);
  await client.evaluate(() => { window.__settingsAppearancePage = true; });
  await client.send('Page.reload');
  await waitFor(() => client.evaluate(() => !window.__settingsAppearancePage && document.querySelectorAll('[data-mode-row]').length === 5));
  await pause(200);
  check('刷新后从 localStorage 恢复主题、圆角与自定义 CSS', await client.evaluate(key => {
    const settings = JSON.parse(localStorage.getItem(key)).settings;
    return settings.theme === 'dark' && settings.radius === 10 && settings.customCssEnabled === true &&
      document.documentElement.dataset.settingsTheme === 'dark' &&
      getComputedStyle(document.documentElement).getPropertyValue('--radius-ui').trim() === '10px' &&
      document.getElementById('slate-appearance-custom-css').textContent.includes('--qa-persist') &&
      getComputedStyle(document.getElementById('drawBtn')).borderRadius === '10px';
  }, KEY));
  await reload(accumulated); await pause(200);
  check('外观检查结束后恢复经典主题与直角基线', await client.evaluate(key => {
    const settings = JSON.parse(localStorage.getItem(key)).settings;
    return settings.theme === 'classic' && settings.radius === 0 &&
      document.documentElement.dataset.stageTheme === 'dark' &&
      document.documentElement.dataset.settingsTheme === 'light';
  }, KEY));

  // The desktop edition only renders inside the packaged Electron app, so the
  // "desktop shows no send button" side is covered by the manual Windows
  // checklist rather than by stubbing window.slateDesktop in this browser suite.
  check('设置布局浏览器检查没有未处理 JavaScript 异常', client.errors.length === 0);
  const report = { artifactBytes: artifact.length, artifactSha256, completedAt: new Date().toISOString(), checks, runtimeErrors: client.errors, screenshots };
  await writeFile(path.join(output, 'settings-layout-report.json'), JSON.stringify(report, null, 2));
  console.log('Settings layout browser QA complete: ' + checks.length + ' checks');
} catch (error) {
  let diagnostic;
  try { diagnostic = await client?.evaluate(() => ({ dialogs: Array.from(document.querySelectorAll('dialog')).map(dialog => ({ id: dialog.id, open: dialog.open, motion: dialog.dataset.motion || '', context: dialog.dataset.mode || '' })), page: document.getElementById('configDialog')?.innerText, focused: document.activeElement?.id, state: JSON.parse(localStorage.getItem('rollcall-studio:v1')), pointerTimes: window.__settingsPointerTimes })); } catch (_) {}
  await writeFile(path.join(output, 'settings-layout-partial-report.json'), JSON.stringify({ artifactBytes: artifact.length, artifactSha256, failedAfter: lastLabel, error: error.stack, checks, runtimeErrors: client?.errors || [], diagnostic, screenshots }, null, 2));
  throw error;
} finally {
  if (client) { try { await client.send('Browser.close'); } catch (_) {} client.ws.close(); }
  if (browser && !browser.killed) browser.kill();
  await pause(500); const resolved = await realpath(profile).catch(() => null);
  if (resolved && path.dirname(resolved) === parent && path.basename(resolved).startsWith('rollcall-settings-')) await rm(resolved, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
