import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// Exercise the complete offline artifact, including persistent configuration
// and real rendered frames. No model endpoint or external account is contacted.
const root = fileURLToPath(new URL('../../', import.meta.url)), output = path.join(root, 'qa-output');
const KEY = 'rollcall-studio:v1', checks = [], screenshots = [], pause = ms => new Promise(r => setTimeout(r, ms));
const artifact = await readFile(path.join(root, 'dist/index.html'));
const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(await realpath(tmpdir()), 'rollcall-friend-'));
let browser, client, lastLabel = 'startup';
class CDP {
  constructor(ws) {
    this.ws = ws; this.next = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', e => {
      const m = JSON.parse(String(e.data));
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
async function waitFor(fn, ms = 12000) {
  const start = Date.now();
  while (Date.now() - start < ms) { try { if (await fn()) return; } catch (_) {} await pause(50); }
  throw new Error('condition timed out at ' + lastLabel);
}
function check(label, value) { lastLabel = label; assert.ok(value, label); checks.push(label); console.log('PASS ' + label); }
async function click(id) { await client.evaluate(async id => { const e = document.getElementById(id); if (!e) throw Error('Missing ' + id); const view = e.closest('section.view[hidden]'); if (view) { document.querySelector('.navigation [data-nav="' + view.id.replace('view-', '') + '"]').click(); await new Promise(resolve => setTimeout(resolve, 0)); } e.click(); await new Promise(resolve => setTimeout(resolve, 0)); }, id); }
async function selectClick(selector) { await client.evaluate(async selector => { const e = document.querySelector(selector); if (!e) throw Error('Missing ' + selector); const view = e.closest('section.view[hidden]'); if (view) { document.querySelector('.navigation [data-nav="' + view.id.replace('view-', '') + '"]').click(); await new Promise(resolve => setTimeout(resolve, 0)); } e.click(); await new Promise(resolve => setTimeout(resolve, 0)); }, selector); }
async function settled(id, open = true) { await waitFor(() => client.evaluate((id, open) => { const d = document.getElementById(id); return d.open === open && !d.dataset.motion; }, id, open), 4000); }
async function closeConfig() { await client.evaluate(() => window.DialogTransitions.close(document.getElementById('configDialog'))); await settled('configDialog', false); }
async function openConfig() {
  await client.evaluate(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
    await new Promise(r => setTimeout(r, 540));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
  });
  await settled('configDialog');
}
async function openRoster() { await openConfig(); await selectClick('[data-nav="roster"]'); await waitFor(() => client.evaluate(() => !document.getElementById('view-roster').hidden)); }
async function picture(name) { const r = await client.send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(output, name), Buffer.from(r.data, 'base64')); screenshots.push(name); }
async function state() { return client.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY); }
async function reload(s) {
  if (s) { s.demo = false; s.settings.theme = 'classic'; s.settings.radius = 0; }
  await client.evaluate((key, s) => { if (s) localStorage.setItem(key, JSON.stringify(s)); window.__friendOldPage = true; }, KEY, s);
  await client.send('Page.reload');
  await waitFor(() => client.evaluate(() => !window.__friendOldPage && document.querySelectorAll('[data-mode-row]').length === 5));
}
async function finished() { await waitFor(() => client.evaluate(() => document.getElementById('drawBtn').getAttribute('aria-busy') === 'false'), 22000); }
async function chooseSeat(id) { await selectClick('#rosterSeats [data-student="' + id + '"]'); }
async function toggleFriendSwitch() {
  const point = await client.evaluate(() => {
    const e = document.getElementById('friendEnabledInput'); e.scrollIntoView({ block: 'center' });
    const r = e.getBoundingClientRect();
    if (r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight) throw Error('Friend switch outside viewport');
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}
async function restoreThroughUi(backup) {
  await selectClick('[data-nav="data"]');
  await client.evaluate(s => {
    const data = new DataTransfer(); data.items.add(new File([JSON.stringify(s)], 'friend-switch-backup.json', { type: 'application/json' }));
    const input = document.getElementById('backupFile'); input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  }, backup);
  await settled('confirmDialog'); await click('confirmActionBtn'); await settled('confirmDialog', false); await finished();
}
async function fixture({ source = '19', targets = ['1', '47', '8', '42'], chance = 100, seen = ['8'], paused = ['42'], direction = false } = {}) {
  return client.evaluate(({ source, targets, chance, seen, paused, direction }) => {
    const students = Array.from({ length: 47 }, (_, i) => ({ id: String(i + 1), name: '同学' + String(i + 1).padStart(2, '0'), row: Math.floor(i / 8) + 1, col: i % 8 + 1, active: true, friendTargets: String(i + 1) === source ? targets : [] }));
    let s;
    for (let seed = 1; seed < 10000; seed++) {
      s = DrawCore.createState(students, seed);
      s.settings = DrawCore.settings({ strategy: 'manual', manualMode: 'normal', friendChance: 0, endJumpChance: 0 });
      if (DrawCore.draw(s, new Date('2026-10-13T10:20:30')).studentId === source) break;
    }
    if (s.lastId !== source) throw Error('Cannot seed requested source');
    s.demo = false;
    s.settings = DrawCore.settings({ strategy: 'manual', manualMode: direction ? 'direction' : 'normal', friendChance: chance, endJumpChance: 0, directionMin: 3, directionMax: 3, directionCooldownMin: 2, directionCooldownMax: 2 });
    for (const id of seen) { if (!s.cycleSeen.includes(id)) s.cycleSeen.push(id); s.counts[id] = Math.max(1, s.counts[id] || 0); }
    for (const id of paused) s.students.find(p => p.id === id).active = false;
    if (direction) s.lock = { remaining: 2, direction: 'right' };
    return s;
  }, { source, targets, chance, seen, paused, direction });
}
async function installFrames() {
  await client.evaluate(() => {
    window.__friendFrames = []; window.__friendTraceStop = false;
    const box = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2, width: r.width, height: r.height }; };
    const capture = () => {
      const scene = document.querySelector('[data-friend-phase]'), phase = scene?.dataset.friendPhase;
      if (phase) {
        const emoji = document.querySelector('[data-friend-emoji]') || document.getElementById('friendEmoji'), vp = document.getElementById('liveSeatScroll');
        window.__friendFrames.push({ phase, at: performance.now(), w: innerWidth, h: innerHeight, focus: vp.dataset.focusStudent, viewport: box(vp), emoji: emoji?.textContent.trim() || '', emojiBox: emoji ? box(emoji) : null, emojiOpacity: emoji ? Number(getComputedStyle(emoji).opacity) : 0, busy: document.getElementById('drawBtn').getAttribute('aria-busy'), seats: Array.from(document.querySelectorAll('#liveSeats [data-live-student]')).map(el => { const s = getComputedStyle(el); return { id: el.dataset.liveStudent, classes: Array.from(el.classList), opacity: Number(s.opacity), color: s.backgroundColor, ...box(el) }; }) });
      }
    };
    const observer = new MutationObserver(capture); observer.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true, attributeFilter: ['data-friend-phase', 'class', 'style'] });
    const frame = () => { if (window.__friendTraceStop) { observer.disconnect(); return; } capture(); requestAnimationFrame(frame); }; requestAnimationFrame(frame);
    window.__friendTraceObserver = observer;
  });
}
async function cleanup() {
  return client.evaluate(() => !document.querySelector('[data-friend-phase]') && !document.querySelector('.friend-hidden,.friend-source,.friend-target') && !document.querySelector('#friendEmoji:not([hidden]),[data-friend-emoji]:not([hidden])') && !Array.from(document.querySelectorAll('#liveSeats [data-live-student]')).some(e => e.style.opacity));
}
function settledFrames(frames, phase, minOpacity = .85) {
  return frames.filter(f => f.phase === phase && f.seats.some(s => s.classes.includes('friend-source') && s.opacity > minOpacity));
}

try {
  browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-proxy-server', '--remote-debugging-port=0', '--window-size=1000,800', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let port;
  await waitFor(async () => { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return port > 0; }, 20000);
  const target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(t => t.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  client = new CDP(socket); await client.send('Page.enable'); await client.send('Runtime.enable');
  await client.send('Page.navigate', { url: pathToFileURL(path.join(root, 'dist/index.html')).href });
  await waitFor(() => client.evaluate(() => document.getElementById('friendChanceInput') && typeof window.FriendTransitions?.play === 'function'));

  const config = await fixture({ targets: [], seen: [], paused: [] }); await reload(config); await openRoster();
  await chooseSeat('19');
  check('点击座位只显示位于该座位上方的设置／友尽悬浮工具条', await client.evaluate(() => { const t = document.getElementById('friendSeatToolbar'), seat = document.querySelector('#rosterSeats [data-student="19"]'), a = t.getBoundingClientRect(), b = seat.getBoundingClientRect(); return !document.getElementById('studentDialog').open && !t.hidden && t.dataset.friendSource === '19' && !document.getElementById('seatSettingsBtn').hidden && !document.getElementById('seatFriendBtn').hidden && a.bottom <= b.top + 6 && Math.abs((a.left + a.width / 2) - (b.left + b.width / 2)) < Math.max(12, b.width); }));
  check('友尽界面使用已加载的离线 Material Icons link_off 字形，按钮中不混入过场表情', await client.evaluate(async () => {
    const b = document.getElementById('seatFriendBtn'), e = b.querySelector('.material-icon');
    if (!e || e.textContent.trim() !== 'link_off' || /[😰🤔😈😭]/u.test(b.textContent)) return false;
    const font = getComputedStyle(e), loaded = await document.fonts.load(font.fontSize + ' ' + font.fontFamily, 'link_off');
    const r = e.getBoundingClientRect(); return loaded.length > 0 && document.fonts.check(font.fontSize + ' ' + font.fontFamily, 'link_off') && font.fontFamily.includes('Material') && r.width > 0 && r.width < 35 && r.height > 0;
  }));
  await chooseSeat('19');
  check('非目标编辑时再次点击同一座位收起工具条，恢复原座位状态且不修改统计', await client.evaluate((key, before) => {
    const t = document.getElementById('friendSeatToolbar'), s = document.querySelector('#rosterSeats [data-student="19"]');
    return t.hidden && !document.querySelector('#rosterSeats .friend-config-source,.friend-config-source-editing,.friend-config-target') && !s.hasAttribute('aria-expanded') && !s.hasAttribute('aria-controls') && s.classList.contains('current') && JSON.stringify(JSON.parse(localStorage.getItem(key))) === JSON.stringify(before);
  }, KEY, config));
  await chooseSeat('19');
  await click('seatFriendBtn');
  check('进入目标编辑时同一工具条显示保存，并保留明确的源座位', await client.evaluate(() => { const t = document.getElementById('friendSeatToolbar'); return t.dataset.friendEditing === 'true' && t.dataset.friendSource === '19' && !document.getElementById('saveFriendTargetsBtn').hidden && document.getElementById('seatSettingsBtn').hidden && document.getElementById('seatFriendBtn').hidden; }));
  await waitFor(() => client.evaluate(() => { const c = getComputedStyle(document.querySelector('#rosterSeats [data-student="19"]')).backgroundColor.match(/[\d.]+/g).map(Number); return c[0] === c[1] && c[1] === c[2]; }));
  check('友尽目标编辑将发起学生标灰，保留其当前抽中状态且拒绝作为目标', await client.evaluate((key, before) => {
    const s = document.querySelector('#rosterSeats [data-student="19"]'), rgb = getComputedStyle(s).backgroundColor.match(/[\d.]+/g).map(Number), t = document.getElementById('friendSeatToolbar');
    return s.classList.contains('friend-config-source-editing') && s.classList.contains('current') && !s.classList.contains('friend-config-target') && rgb[0] === rgb[1] && rgb[1] === rgb[2] && rgb[0] > 100 && rgb[0] < 245 && t.dataset.friendSource === '19' && JSON.stringify(JSON.parse(localStorage.getItem(key))) === JSON.stringify(before);
  }, KEY, config));
  await chooseSeat('19'); await chooseSeat('1'); await chooseSeat('8'); await chooseSeat('47');
  check('目标支持跨行多选，红色显示被选择座位且拒绝把自己加入目标', await client.evaluate(() => { const ids = Array.from(document.querySelectorAll('#rosterSeats .friend-config-target')).map(e => e.dataset.student).sort(), s = getComputedStyle(document.querySelector('#rosterSeats .friend-config-target')); const red = [s.color, s.backgroundColor, s.borderTopColor].some(tone => { const c = tone.match(/[\d.]+/g).map(Number); return c[0] > c[1] + 30 && c[0] > c[2] + 30; }); return JSON.stringify(ids) === JSON.stringify(['1', '47', '8']) && red; }));
  // Submit the unchanged class through its real application command. This
  // publishes a Vue snapshot without corrupting Vue-owned roster DOM.
  await click('classBtn'); await settled('classDialog');
  await client.evaluate(() => document.getElementById('classForm').requestSubmit());
  await settled('classDialog', false);
  await waitFor(() => client.evaluate(() => {
    const seat = document.querySelector('#rosterSeats [data-student="19"]'), rgb = getComputedStyle(seat).backgroundColor.match(/[\d.]+/g).map(Number);
    return seat.classList.contains('friend-config-source-editing') && rgb[0] === rgb[1] && rgb[1] === rgb[2];
  }));
  check('应用命令发布快照后工具条仍锚定灰色发起者并保留目标草稿，不改写名单统计', await client.evaluate(() => {
    const t = document.getElementById('friendSeatToolbar'), s = document.querySelector('#rosterSeats [data-student="19"]'), rgb = getComputedStyle(s).backgroundColor.match(/[\d.]+/g).map(Number), ids = Array.from(document.querySelectorAll('#rosterSeats .friend-config-target')).map(e => e.dataset.student).sort();
    return !t.hidden && t.dataset.friendSource === '19' && t.dataset.friendEditing === 'true' && s.classList.contains('current') && rgb[0] === rgb[1] && rgb[1] === rgb[2] && JSON.stringify(ids) === JSON.stringify(['1', '47', '8']);
  }));
  assert.deepEqual(await state(), config, '发布快照不改变名单、历史、随机序列或公平统计');
  await picture('friend-target-configuration.png');
  await click('saveFriendTargetsBtn');
  check('保存目标立即持久化并退出红色多选和发起者灰色状态', await client.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), t = document.getElementById('friendSeatToolbar'), source = document.querySelector('#rosterSeats [data-student="19"]'); return JSON.stringify(s.students.find(x => x.id === '19').friendTargets.slice().sort()) === JSON.stringify(['1', '47', '8']) && !document.querySelector('#rosterSeats .friend-config-target,.friend-config-source-editing') && t.dataset.friendEditing !== 'true' && source.classList.contains('current'); }, KEY));
  await reload(); await openRoster(); await chooseSeat('19'); await click('seatFriendBtn');
  check('跨刷新恢复个人友尽目标，重开编辑准确重选已有目标', await client.evaluate(() => JSON.stringify(Array.from(document.querySelectorAll('#rosterSeats .friend-config-target')).map(e => e.dataset.student).sort()) === JSON.stringify(['1', '47', '8'])));
  await chooseSeat('1'); await chooseSeat('2'); await click('cancelFriendTargetsBtn');
  check('取消目标草稿保留原关系并清除红色选择、灰色发起者与临时工具条', await client.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return JSON.stringify(s.students.find(x => x.id === '19').friendTargets.slice().sort()) === JSON.stringify(['1', '47', '8']) && document.getElementById('friendSeatToolbar').hidden && !document.querySelector('#rosterSeats .friend-config-target,.friend-config-source-editing'); }, KEY));
  await chooseSeat('19'); await click('seatFriendBtn'); await chooseSeat('2');
  const beforeEscape = await state();
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await pause(350);
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, autoRepeat: true });
  await pause(350);
  check('长按 Escape 只取消友尽草稿并把焦点还给源座位，不关闭配置', await client.evaluate((key, before) => document.getElementById('configDialog').open && !document.getElementById('configDialog').dataset.motion && document.getElementById('friendSeatToolbar').hidden && document.activeElement === document.querySelector('#rosterSeats [data-student="19"]') && JSON.stringify(JSON.parse(localStorage.getItem(key))) === JSON.stringify(before), KEY, beforeEscape));
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await settled('configDialog', false);
  check('第二次独立 Escape 关闭配置并恢复主页焦点', await client.evaluate(() => document.activeElement.id === 'drawBtn'));
  await openRoster();
  await chooseSeat('19'); await click('seatFriendBtn');
  // Toggle one existing target through the real touch event path.
  const point = await client.evaluate(() => { const seat = document.querySelector('#rosterSeats [data-student="8"]'); seat.scrollIntoView({ block: 'center' }); const r = seat.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] }); await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await waitFor(() => client.evaluate(() => !document.querySelector('#rosterSeats [data-student="8"]').classList.contains('friend-config-target')));
  await click('saveFriendTargetsBtn');
  check('触摸座位能取消已选目标，保存后只保留剩余多选项', await client.evaluate(key => JSON.stringify(JSON.parse(localStorage.getItem(key)).students.find(x => x.id === '19').friendTargets.slice().sort()) === JSON.stringify(['1', '47']), KEY));

  await chooseSeat('1'); await click('seatSettingsBtn'); await settled('studentDialog');
  await client.evaluate(() => { document.getElementById('studentIdInput').value = '101'; document.getElementById('studentForm').requestSubmit(); }); await settled('studentDialog', false);
  check('修改目标学号后，所有源同学的目标引用随之更新', await client.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return s.students.find(x => x.id === '19').friendTargets.includes('101') && !s.students.some(x => x.friendTargets?.includes('1')); }, KEY));

  const priorImport = await state();
  await selectClick('[data-import]'); await settled('importDialog');
  await client.evaluate(s => { document.getElementById('rosterText').value = s.students.filter(p => p.id !== '47').map(p => [p.id, p.name, p.row, p.col].join(',')).join('\n'); document.getElementById('importColsInput').value = 8; document.getElementById('previewImportBtn').click(); document.getElementById('importResetInput').checked = false; }, priorImport);
  await click('applyImportBtn'); await settled('importDialog', false);
  check('保留记录导入保留相同学号的目标，自动剔除被删除的目标', await client.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return JSON.stringify(s.students.find(p => p.id === '19').friendTargets) === JSON.stringify(['101']) && !s.students.some(p => p.friendTargets?.includes('47')); }, KEY));
  await selectClick('[data-nav="roster"]');
  await chooseSeat('19'); await click('seatFriendBtn'); await chooseSeat('101'); await click('saveFriendTargetsBtn');
  check('保存空目标能够清除友尽关系且不保留旧选择', await client.evaluate(key => !(JSON.parse(localStorage.getItem(key)).students.find(p => p.id === '19').friendTargets?.length), KEY));

  await selectClick('[data-nav="dashboard"]');
  await client.evaluate(async () => { for (const [id, value] of [['directionChanceInput', 60], ['timeChanceInput', 40], ['friendChanceInput', 100]]) { const input = document.getElementById(id); input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 0)); } });
  check('友尽概率独立于基础100%，连坐60%＋时间40%＋友尽100%能够保存', await client.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)).settings; return s.directionChance === 60 && s.timeChance === 40 && s.friendChance === 100; }, KEY));
  check('友尽概率设置解释为前置判定，并在模式行内保留配置', await client.evaluate(() => { const e = document.getElementById('friendChanceInput'); return e.value === '100' && e.min === '0' && e.max === '100' && e.getAttribute('aria-label').includes('独立前置'); }));
  await picture('friend-probability-settings.png'); await closeConfig();

  await openConfig(); await selectClick('[data-import]'); await settled('importDialog'); await selectClick('[data-import-tab="json"]');
  await client.evaluate(() => {
    document.getElementById('visionJson').value = JSON.stringify({ rows: 1, cols: 3, students: [{ id: '5', name: 'JSON源', row: 1, col: 1, friendTargets: ['6', '7'] }, { id: '6', name: 'JSON目标甲', row: 1, col: 2 }, { id: '7', name: 'JSON目标乙', row: 1, col: 3 }] });
    document.getElementById('previewImportBtn').click();
    document.querySelector('[data-preview-row="0"] [data-field="id"]').value = '105';
    document.querySelector('[data-preview-row="1"] [data-field="id"]').value = '106';
  });
  await client.evaluate(() => { document.getElementById('importResetInput').checked = true; });
  await click('applyImportBtn'); await settled('confirmDialog'); await click('confirmActionBtn'); await settled('confirmDialog', false); await settled('importDialog', false);
  check('JSON预览保留友尽关系，修改源与目标学号后同步保存新引用', await client.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return JSON.stringify(s.students.find(p => p.id === '105').friendTargets.slice().sort()) === JSON.stringify(['106', '7']) && s.students.every(p => !(p.friendTargets || []).some(id => ['5', '6'].includes(id))) && s.round === 0; }, KEY));
  await selectClick('[data-import]'); await settled('importDialog'); await selectClick('[data-import-tab="json"]');
  await client.evaluate(() => {
    document.getElementById('visionJson').value = JSON.stringify({ rows: 1, cols: 4, students: [{ id: '105', name: 'JSON源', row: 1, col: 1, friendTargets: ['7'] }, { id: '106', name: 'JSON目标甲', row: 1, col: 2 }, { id: '7', name: 'JSON目标乙', row: 1, col: 3 }, { id: '8', name: '新增JSON源', row: 1, col: 4, friendTargets: ['105'] }] });
    document.getElementById('previewImportBtn').click(); document.getElementById('importResetInput').checked = false;
  });
  await click('applyImportBtn'); await settled('importDialog', false);
  check('保留记录JSON导入优先保留已有个人关系，不受输入的冲突关系覆盖', await client.evaluate(key => JSON.stringify(JSON.parse(localStorage.getItem(key)).students.find(p => p.id === '105').friendTargets.slice().sort()) === JSON.stringify(['106', '7']), KEY));
  check('保留记录JSON导入的新增学生能够保留其输入的友尽目标', await client.evaluate(key => JSON.stringify(JSON.parse(localStorage.getItem(key)).students.find(p => p.id === '8').friendTargets) === JSON.stringify(['105']), KEY));
  await closeConfig();

  // Use the real mode-row switch at the physical 1920×1080 / 2.5 viewport.
  await client.send('Emulation.setDeviceMetricsOverride', { width: 768, height: 432, deviceScaleFactor: 2.5, mobile: false });
  const switchFixture = await fixture(); await reload(switchFixture); await openConfig();
  const defaultEnabled = await client.evaluate(() => {
    const e = document.getElementById('friendEnabledInput'); return e.checked && e.type === 'checkbox' && e.getAttribute('role') === 'switch' && e.classList.contains('rect-switch') && !document.getElementById('friendChanceInput').disabled;
  });
  await toggleFriendSwitch();
  const savedDisabled = await client.evaluate(key => !document.getElementById('friendEnabledInput').checked && document.getElementById('friendChanceInput').disabled && JSON.parse(localStorage.getItem(key)).settings.friendEnabled === false && !document.getElementById('settingsDialog').open, KEY);
  check('友尽矩形开关默认开启，模式行关闭后立即保存、禁用概率且不误打开附加设置', defaultEnabled && savedDisabled);
  await closeConfig(); const disabledBackup = await state(); await reload(); await openConfig();
  check('模式行关闭状态跨刷新保留，不清除100%概率或个人目标，重开仍保持概率输入禁用', disabledBackup.settings.friendEnabled === false && disabledBackup.settings.friendChance === 100 && JSON.stringify(disabledBackup.students.find(s => s.id === '19').friendTargets) === JSON.stringify(switchFixture.students.find(s => s.id === '19').friendTargets) && await client.evaluate(() => !document.getElementById('friendEnabledInput').checked && document.getElementById('friendChanceInput').disabled && document.getElementById('friendChanceInput').value === '100'));
  await closeConfig();
  const disabledExpected = await client.evaluate(s => {
    const copy = DrawCore.restoreState(JSON.parse(JSON.stringify(s)));
    // The existing zero-chance path is the no-preflight-RNG control.
    copy.settings.friendEnabled = true; copy.settings.friendChance = 0;
    const record = DrawCore.draw(copy, new Date('2026-10-13T10:20:30'));
    return { id: record.studentId, rngState: copy.rngState, round: copy.round };
  }, disabledBackup);
  await installFrames(); await click('drawBtn'); await finished();
  const disabledDrawn = await state();
  check('友尽开关关闭时即使概率100%且存在目标，也执行原方式且不消耗额外随机数', disabledDrawn.history.at(-1).mode === 'normal' && disabledDrawn.lastId === disabledExpected.id && disabledDrawn.rngState === disabledExpected.rngState && disabledDrawn.round === disabledExpected.round && await client.evaluate(() => window.__friendFrames.length === 0) && await cleanup());
  await openConfig(); await restoreThroughUi(disabledBackup);
  check('真实JSON备份恢复保留关闭开关、原概率及目标，旧备份缺字段按默认开启', await client.evaluate(key => {
    const s = JSON.parse(localStorage.getItem(key)), old = JSON.parse(JSON.stringify(s)); delete old.settings.friendEnabled;
    return s.settings.friendEnabled === false && s.settings.friendChance === 100 && s.students.find(p => p.id === '19').friendTargets.length === 4 && DrawCore.restoreState(old).settings.friendEnabled === true;
  }, KEY));
  await selectClick('[data-nav="dashboard"]'); await toggleFriendSwitch(); await closeConfig();
  const activeFixture = await state();
  await client.send('Emulation.clearDeviceMetricsOverride'); await reload(activeFixture); await installFrames();
  await click('drawBtn');
  await waitFor(() => client.evaluate(() => window.__friendFrames.some(f => f.emoji === '🤔' && f.emojiOpacity > .85)), 16000);
  await picture('friend-source-emotion.png');
  await waitFor(() => client.evaluate(() => window.__friendFrames.some(f => f.phase === 'targets' && f.seats.some(s => s.classes.includes('candidate')) && ['19', '1', '47'].every(id => f.seats.find(s => s.id === id).opacity > .85))), 16000);
  await picture('friend-target-draw.png');
  await waitFor(() => client.evaluate(() => window.__friendFrames.some(f => f.emoji === '😭' && f.emojiOpacity > .85)), 16000);
  await picture('friend-winner-emotion.png'); await finished();
  const frames = await client.evaluate(() => { window.__friendTraceStop = true; return window.__friendFrames; }), final = await state();
  const record = final.history.at(-1), sourceFrames = [...settledFrames(frames, 'source'), ...settledFrames(frames, 'thinking')];
  check('友尽100%前置判定命中，仅从源同学的未抽且未暂停目标中选一人', record.mode === 'friend' && record.friendSourceId === '19' && ['1', '47'].includes(record.studentId) && JSON.stringify(record.friendTargetIds.slice().sort()) === JSON.stringify(['1', '47']));
  check('重新打开功能开关保留100%概率与个人目标，并恢复真实友尽表情过场', activeFixture.settings.friendEnabled === true && activeFixture.settings.friendChance === 100 && activeFixture.students.find(s => s.id === '19').friendTargets.length === 4 && record.mode === 'friend' && frames.some(f => f.emoji === '😈' && f.emojiOpacity > .85));
  check('友尽最终只提交一条历史、一位同学的次数和长期公平统计', final.round === activeFixture.round + 1 && final.history.length === activeFixture.history.length + 1 && final.students.every(s => (final.counts[s.id] || 0) - (activeFixture.counts[s.id] || 0) === (s.id === record.studentId ? 1 : 0)) && final.students.every(s => (final.fairnessStats[s.id]?.draws || 0) - (activeFixture.fairnessStats[s.id]?.draws || 0) === (s.id === record.studentId ? 1 : 0)));
  check('过场先保留源同学、淡出所有其他座位并聚焦源同学', sourceFrames.some(f => f.focus === '19' && f.seats.filter(s => s.id !== '19').every(s => s.opacity < .08) && Math.abs(f.seats.find(s => s.id === '19').cx - f.viewport.cx) < 2 && Math.abs(f.seats.find(s => s.id === '19').cy - f.viewport.cy) < 2));
  const emojiSequence = frames.filter(f => f.emojiOpacity > .4).map(f => f.emoji).filter((e, i, a) => e && e !== a[i - 1]);
  check('源同学上方依次显示 😰 → 🤔 → 😈，最终目标显示 😭', ['😰', '🤔', '😈', '😭'].every((e, i, all) => emojiSequence.indexOf(e) >= 0 && (!i || emojiSequence.indexOf(e) > emojiSequence.indexOf(all[i - 1]))));
  check('源表情位于源座位上方且跟随摄像机投影', frames.some(f => f.emoji === '🤔' && f.emojiOpacity > .6 && f.emojiBox && f.emojiBox.bottom <= f.seats.find(s => s.id === '19').top + 12 && Math.abs(f.emojiBox.cx - f.seats.find(s => s.id === '19').cx) < 6));
  const targets = frames.filter(f => f.phase === 'targets');
  check('目标阶段只重新显示源和有效目标，已抽与暂停目标始终淡出', targets.some(f => ['1', '47'].every(id => f.seats.find(s => s.id === id)?.opacity > .8) && f.seats.filter(s => !['19', '1', '47'].includes(s.id)).every(s => s.opacity < .08)));
  check('目标阶段摄像机完整容纳当前可见座位，最远角落目标没有裁切', targets.some(f => f.seats.filter(s => ['19', '1', '47'].includes(s.id)).every(s => s.left >= 0 && s.right <= f.w + 1 && s.top >= 0 && s.bottom <= f.h + 1 && s.opacity > .8)));
  check('目标镜头按可见源与目标紧密取景，充分利用视口宽度或高度', targets.some(f => { const visible = f.seats.filter(s => ['19', '1', '47'].includes(s.id)); return visible.every(s => s.opacity > .8) && Math.max((Math.max(...visible.map(s => s.right)) - Math.min(...visible.map(s => s.left))) / f.w, (Math.max(...visible.map(s => s.bottom)) - Math.min(...visible.map(s => s.top))) / f.h) > .65; }));
  const highlights = targets.flatMap(f => f.seats.filter(s => s.classes.includes('candidate')).map(s => s.id));
  check('友尽沿普通抽选动画随机高亮目标，绝不高亮源或不可抽目标', highlights.includes('1') && highlights.includes('47') && highlights.every(id => ['1', '47'].includes(id)));
  check('选中后聚焦赢家并在其座位上方显示 😭', frames.some(f => f.phase === 'result' && f.focus === record.studentId && f.emoji === '😭' && f.emojiOpacity > .6 && f.emojiBox && f.emojiBox.bottom <= f.seats.find(s => s.id === record.studentId).top + 12 && Math.abs(f.emojiBox.cx - f.seats.find(s => s.id === record.studentId).cx) < 6));
  check('退出友尽动画恢复全部座位，移除表情和所有临时样式', await cleanup());
  await picture('friend-final-result.png');

  // Check real undo/replay restores the preflight RNG, not just the visible label.
  await openConfig(); await click('undoBtn');
  const undone = await state();
  check('撤销友尽恢复源、当前轮次、随机种子和目标统计', undone.lastId === activeFixture.lastId && undone.round === activeFixture.round && undone.rngState === activeFixture.rngState && activeFixture.students.every(s => (undone.counts[s.id] || 0) === (activeFixture.counts[s.id] || 0)) && JSON.stringify(undone.fairnessStats) === JSON.stringify(activeFixture.fairnessStats));
  await closeConfig(); await click('drawBtn'); await finished();
  const replay = await state();
  check('撤销后重抽复现友尽目标与最终随机种子', replay.lastId === final.lastId && replay.history.at(-1).mode === 'friend' && replay.rngState === final.rngState);
  await reload();
  check('刷新恢复友尽历史与目标名单，不丢失结果或个人配置', await client.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), r = s.history.at(-1); return r.mode === 'friend' && document.getElementById('stageName').textContent === r.name && s.students.find(x => x.id === '19').friendTargets.length === 4 && DrawCore.restoreState(JSON.parse(JSON.stringify(s))).history.at(-1).friendSourceId === '19'; }, KEY));
  await openRoster(); await chooseSeat('19'); await click('seatSettingsBtn'); await settled('studentDialog');
  await client.evaluate(() => { document.getElementById('studentIdInput').value = '119'; document.getElementById('studentForm').requestSubmit(); }); await settled('studentDialog', false);
  check('修改源学号同步更新友尽历史、先前源引用及个人目标配置', await client.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), r = s.history.at(-1); return r.friendSourceId === '119' && r.before.lastId === '119' && s.students.find(x => x.id === '119').friendTargets.length === 4 && !s.students.some(x => x.id === '19'); }, KEY));
  await selectClick('[data-nav="data"]');
  await client.evaluate(s => { const data = new DataTransfer(); data.items.add(new File([JSON.stringify(s)], 'friend-browser-backup.json', { type: 'application/json' })); const input = document.getElementById('backupFile'); input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true })); }, final);
  await settled('confirmDialog'); await click('confirmActionBtn'); await settled('confirmDialog', false); await finished();
  check('真实备份恢复界面还原源学号、个人目标、友尽历史与统计', await client.evaluate((key, backup) => { const s = JSON.parse(localStorage.getItem(key)); return s.history.at(-1).friendSourceId === '19' && s.students.find(x => x.id === '19').friendTargets.length === 4 && JSON.stringify(s.counts) === JSON.stringify(backup.counts) && JSON.stringify(s.fairnessStats) === JSON.stringify(backup.fairnessStats); }, KEY, final));
  await closeConfig();

  for (const [label, next] of [
    ['友尽0%时恢复原普通抽选概率且不播放友尽过场', await fixture({ chance: 0 })],
    ['全部友尽目标已抽或暂停时跳过友尽并恢复正常方式', await fixture({ targets: ['8', '42'] })]
  ]) {
    await reload(next); await installFrames(); await click('drawBtn'); await finished();
    const s = await state(); check(label, s.history.at(-1).mode === 'normal' && await client.evaluate(() => window.__friendFrames.length === 0) && await cleanup());
  }
  const chain = await fixture({ direction: true }); await reload(chain); await click('drawBtn'); await finished();
  const interrupted = await state();
  check('友尽前置命中可打断连坐，结束原连坐并正确启动配置冷却', interrupted.history.at(-1).mode === 'friend' && !interrupted.lock && interrupted.directionCooldownRemaining === 2);

  await reload(activeFixture); await installFrames(); await click('drawBtn');
  await waitFor(() => client.evaluate(() => window.__friendFrames.some(f => f.phase === 'targets')), 16000);
  await client.send('Emulation.setDeviceMetricsOverride', { width: 768, height: 432, deviceScaleFactor: 2.5, mobile: false });
  await finished();
  check('目标过场中改变窗口尺寸立即重新框景，选中后仍清理并跟随赢家', await client.evaluate(() => window.__friendFrames.some(f => f.w === 768 && f.h === 432 && f.phase === 'targets' && f.seats.filter(s => ['19', '1', '47'].includes(s.id)).every(s => s.opacity > .8 && s.left >= -1 && s.right <= 769 && s.top >= -1 && s.bottom <= 433))) && await cleanup());

  // Cover the exact 1920×1080 @ 2.5 viewport and narrow touch layout.
  for (const [width, height, mobile] of [[768, 432, false], [320, 780, true]]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: width === 768 ? 2.5 : 1, mobile });
    await reload(activeFixture); await installFrames(); await click('drawBtn'); await finished();
    const f = await client.evaluate(() => { window.__friendTraceStop = true; return window.__friendFrames; });
    check(width + '×' + height + ' 下友尽目标摄像机自动适配，不裁切可见座位', f.some(x => x.phase === 'targets' && x.seats.filter(s => ['19', '1', '47'].includes(s.id)).every(s => s.opacity > .8 && s.left >= -1 && s.right <= width + 1 && s.top >= -1 && s.bottom <= height + 1)) && await cleanup());
    check(width + '×' + height + ' 下最终焦点位于赢家，并且底部按钮不溢出', await client.evaluate(() => { const b = document.getElementById('drawBtn').getBoundingClientRect(), v = document.getElementById('liveSeatScroll'), s = JSON.parse(localStorage.getItem('rollcall-studio:v1')); return b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight && v.dataset.focusStudent === s.lastId && document.documentElement.scrollWidth <= innerWidth + 1; }));
  }
  await openRoster(); await chooseSeat('1');
  check('320px 触屏布局的座位工具条贴近源座位，Material Icons 与边缘按钮完整位于视口内', await client.evaluate(async () => {
    const t = document.getElementById('friendSeatToolbar'), r = t.getBoundingClientRect(), e = document.querySelector('#seatFriendBtn .material-icon');
    if (!e) return false;
    const font = getComputedStyle(e), loaded = await document.fonts.load(font.fontSize + ' ' + font.fontFamily, 'link_off'), glyph = e.getBoundingClientRect();
    return loaded.length > 0 && e.textContent.trim() === 'link_off' && glyph.width > 0 && glyph.width < 35 && !t.hidden && r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1 && Array.from(t.querySelectorAll('button')).filter(b => !b.hidden).every(b => { const q = b.getBoundingClientRect(); return q.left >= 0 && q.right <= innerWidth + 1; });
  }));
  await click('seatFriendBtn'); await chooseSeat('47');
  await closeConfig();
  check('关闭配置放弃未保存目标并清理友尽选择，当前抽取统计保持', await client.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return !(s.students.find(p => p.id === '1').friendTargets?.length) && !document.querySelector('.friend-config-target,.friend-config-source') && document.getElementById('friendSeatToolbar').hidden && s.round === 2; }, KEY));
  await client.send('Emulation.clearDeviceMetricsOverride');
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await reload(activeFixture); await click('drawBtn'); await finished();
  check('减少动态效果仍执行真实友尽选择，结束后没有表情或隐藏座位残留', (await state()).history.at(-1).mode === 'friend' && await cleanup());
  await client.send('Emulation.setEmulatedMedia', { features: [] });
  check('离线友尽完整交互和逐帧动画检查没有浏览器运行错误', client.errors.length === 0);
  check('浏览器检查过程中 HTML 构建文件保持一致', (await readFile(path.join(root, 'dist/index.html'))).equals(artifact));
  await writeFile(path.join(output, 'friend-report.json'), JSON.stringify({ completedAt: new Date().toISOString(), artifactBytes: artifact.length, artifactSha256, checks, runtimeErrors: client.errors, screenshots }, null, 2));
  console.log(JSON.stringify({ checkCount: checks.length, artifactBytes: artifact.length, screenshots }));
} catch (error) {
  if (client) { try { await picture('friend-failure.png'); } catch (_) {} }
  await writeFile(path.join(output, 'friend-partial-report.json'), JSON.stringify({ completedAt: new Date().toISOString(), artifactBytes: artifact.length, artifactSha256, checks, failedCheck: lastLabel, error: String(error), runtimeErrors: client?.errors || [], screenshots }, null, 2));
  throw error;
} finally {
  if (client) { try { await client.send('Browser.close'); } catch (_) {} client.ws.close(); }
  if (browser) { try { browser.kill(); } catch (_) {} }
  const absolute = await realpath(profile).catch(() => null), parent = await realpath(tmpdir());
  if (absolute && absolute.startsWith(parent + path.sep) && path.basename(absolute).startsWith('rollcall-friend-')) { await pause(700); await rm(absolute, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
}
