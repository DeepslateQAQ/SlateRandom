import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../', import.meta.url)), output = path.join(root, 'qa-output');
const artifact = await readFile(path.join(root, 'dist/index.html'));
const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
await mkdir(output, { recursive: true });
const parent = await realpath(tmpdir()), profile = await mkdtemp(path.join(parent, 'rollcall-extra-'));
const KEY = 'rollcall-studio:v1', checks = [], screenshots = [], pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, client;
class CDP {
  constructor(ws) { this.ws = ws; this.next = 0; this.pending = new Map(); this.errors = []; ws.addEventListener('message', event => { const m = JSON.parse(String(event.data)); if (m.id) { const p = this.pending.get(m.id); if (p) { clearTimeout(p.timer); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } } else if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); }); }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.next, timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timed out')); }, 10000); this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(fn, ...args) { const r = await this.send('Runtime.evaluate', { expression: '(' + fn.toString() + ').apply(null,' + JSON.stringify(args) + ')', awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
}
async function waitFor(fn, ms = 10000) { const start = Date.now(); while (Date.now() - start < ms) { try { if (await fn()) return; } catch (_) {} await pause(60); } throw new Error('condition timed out'); }
function check(label, value) { assert.ok(value, label); checks.push(label); console.log('PASS ' + label); }
async function click(id) { await client.evaluate(async id => { const e = document.getElementById(id); const view = e.closest('section.view[hidden]'); if (view) { document.querySelector('.navigation [data-nav="' + view.id.replace('view-', '') + '"]').click(); await new Promise(resolve => setTimeout(resolve, 0)); } e.click(); await new Promise(resolve => setTimeout(resolve, 0)); }, id); await waitFor(() => client.evaluate(() => !document.querySelector('dialog[data-motion]')), 2000); }
async function picture(name) { const data = await client.send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(output, name), Buffer.from(data.data, 'base64')); screenshots.push(name); }
async function finished() { await waitFor(() => client.evaluate(() => document.getElementById('drawBtn').getAttribute('aria-busy') === 'false'), 12000); }
async function reload(state) { state.demo = false; state.settings.theme = 'classic'; state.settings.radius = 0; await client.evaluate((key, state) => { localStorage.setItem(key, JSON.stringify(state)); window.__oldPage = true; }, KEY, state); await client.send('Page.reload'); await waitFor(() => client.evaluate(() => !window.__oldPage && document.querySelectorAll('[data-mode-row]').length === 5)); }
try {
  browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--headless=new', '--disable-gpu', '--blink-settings=primaryHoverType=2,availableHoverTypes=2', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-proxy-server', '--remote-debugging-port=0', '--window-size=1000,800', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let port; await waitFor(async () => { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return port > 0; }, 20000);
  const target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(t => t.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  client = new CDP(socket); await client.send('Page.enable'); await client.send('Runtime.enable');
  await client.send('Page.navigate', { url: pathToFileURL(path.join(root, 'dist/index.html')).href });
  await waitFor(() => client.evaluate(() => document.querySelectorAll('[data-mode-row]').length === 5));
  await client.evaluate(() => {
    const state = DrawCore.createEmptyState(4242);
    state.settings = DrawCore.settings({ ...state.settings, theme: 'classic', radius: 0 });
    localStorage.setItem('rollcall-studio:v1', JSON.stringify(state));
  });
  await client.send('Page.reload');
  await waitFor(() => client.evaluate(() => document.querySelectorAll('[data-mode-row]').length === 5));
  await client.evaluate(() => { document.getElementById('configDialog').showModal(); document.querySelector('[data-import]').click(); });
  await click('providerSettingsBtn'); await waitFor(() => client.evaluate(() => document.getElementById('providerDialog').open));
  const multi = await client.evaluate(() => ['kimi', 'mimo', 'openai', 'claude', 'gemini'].every(id => { const select = document.getElementById('providerPreset'); select.value = id; select.dispatchEvent(new Event('change')); const model = document.getElementById('providerModelSelect'); return !model.disabled && model.options.length > 1 && document.getElementById('providerCustomFields').hidden; }));
  check('拥有多个视觉模型的提供商均提供模型下拉，预设不要求手填端点', multi);
  await client.evaluate(() => { const p = document.getElementById('providerPreset'); p.value = 'openai'; p.dispatchEvent(new Event('change')); document.getElementById('apiKey').value = 'qa-file-only-key'; document.getElementById('providerModelSelect').value = 'gpt-6-luna'; document.getElementById('providerForm').requestSubmit(); });
  await waitFor(() => client.evaluate(() => !document.getElementById('providerDialog').open));
  await client.send('Page.reload'); await waitFor(() => client.evaluate(() => document.getElementById('providerSummary')?.textContent.includes('gpt-6-luna')));
  check('直接双击 file HTML 后 API 密钥也能写入 IndexedDB 并跨刷新恢复', await client.evaluate(async () => { const c = await window.VisionProviders.getConfig(); return location.protocol === 'file:' && c.provider === 'openai' && c.key === 'qa-file-only-key' && c.model === 'gpt-6-luna'; }));
  await client.evaluate(() => { document.getElementById('configDialog').showModal(); document.querySelector('[data-import]').click(); });
  await click('providerSettingsBtn'); await waitFor(() => client.evaluate(() => document.getElementById('providerDialog').open));
  await client.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 600, deviceScaleFactor: 1, mobile: true });
  check('320px 下提供商配置白底黑字直角，表单与保存按钮均在视口内', await client.evaluate(() => { const dialog = document.getElementById('providerDialog'), color = getComputedStyle(dialog), r = dialog.getBoundingClientRect(); return color.backgroundColor === 'rgb(255, 255, 255)' && color.color === 'rgb(0, 0, 0)' && color.borderRadius === '0px' && r.left >= 0 && r.right <= innerWidth + 1 && dialog.scrollWidth <= dialog.clientWidth + 1 && Array.from(dialog.querySelectorAll('input,select,button')).filter(e => e.getClientRects().length).every(e => { const b = e.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth + 1; }); }));
  await picture('provider-settings-320.png');
  await click('providerClearKeyBtn'); await waitFor(() => client.evaluate(() => document.getElementById('providerClearKeyBtn').disabled));
  check('移除密钥真实删除数据库中的认证值，下次识别明确提示重新配置', await client.evaluate(async () => { try { await window.VisionProviders.getConfig(); return false; } catch (e) { return e.message.includes('API 密钥'); } }));
  await client.evaluate(() => { const p = document.getElementById('providerPreset'); p.value = 'custom'; p.dispatchEvent(new Event('change')); document.getElementById('apiEndpoint').value = 'https://example.com/v1?api_key=secret'; document.getElementById('apiModel').value = 'visual'; document.getElementById('providerForm').requestSubmit(); });
  await waitFor(() => client.evaluate(() => document.getElementById('providerError').textContent.includes('密钥')));
  check('自定义地址含密钥时拒绝保存，并保持原来的提供商选择', await client.evaluate(() => document.getElementById('providerDialog').open && document.getElementById('providerSummary').textContent.includes('OpenAI')));
  await client.evaluate(() => { document.getElementById('apiEndpoint').value = 'http://localhost:8080/v1'; document.getElementById('apiKey').value = ''; document.getElementById('providerForm').requestSubmit(); });
  await waitFor(() => client.evaluate(() => !document.getElementById('providerDialog').open));
  check('免密本地 OpenAI 兼容服务可保存，基础地址自动补全 Chat Completions 路径', await client.evaluate(async () => { const c = await window.VisionProviders.getConfig(); return c.key === '' && c.endpoint === 'http://localhost:8080/v1/chat/completions'; }));
  await client.send('Emulation.clearDeviceMetricsOverride');
  const interactionFixture = await client.evaluate(() => { const s = DrawCore.createState([{ id: '1', name: '甲同学', row: 1, col: 1 }, { id: '2', name: '乙同学', row: 1, col: 2 }, { id: '3', name: '丙同学', row: 2, col: 1 }], 5678); s.settings = DrawCore.settings({ strategy: 'manual', manualMode: 'normal', endJumpChance: 0 }); return s; });
  await reload(interactionFixture);
  const point = await client.evaluate(() => { const r = document.getElementById('drawBtn').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }); await pause(220);
  const hover = await client.evaluate(() => { const b = document.getElementById('drawBtn'), s = getComputedStyle(b); return { z: new DOMMatrix(s.transform).m43, glow: s.boxShadow, tone: s.getPropertyValue('--button-glow'), fill: s.backgroundColor }; });
  check('按钮悬浮使用真实正 Z 深度，泛光颜色匹配白色按钮背景', hover.z > 20 && hover.glow !== 'none' && /255/.test(hover.tone));
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 }); await pause(240);
  const pressed = await client.evaluate(() => { const s = getComputedStyle(document.getElementById('drawBtn')); return { z: new DOMMatrix(s.transform).m43, target: parseFloat(s.getPropertyValue('--button-depth')) }; });
  check('按钮按压时沿 Z 轴下降，但仍保持正深度高于静止按钮', pressed.z > 0 && pressed.z < hover.z && pressed.target === 10);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 }); await pause(350);
  check('按钮按住超过200ms而未到500ms后松开，只收回进度，不抽选或打开配置', await client.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 0 && !document.getElementById('configDialog').open && document.getElementById('drawBtn').getAttribute('aria-busy') === 'false', KEY));
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
  await client.evaluate(() => {
    window.__depthFrames = [];
    const original = SeatTransitions, capture = phase => { const seats = Array.from(document.querySelectorAll('#liveSeats [data-live-student]')); window.__depthFrames.push({ phase, frames: seats.map(el => { const s = getComputedStyle(el), m = new DOMMatrix(s.transform); return { id: el.dataset.liveStudent, z: m.m43, x: m.m41, y: m.m42, size: el.getBoundingClientRect().width, opacity: Number(s.opacity), color: s.backgroundColor }; }) }); };
    window.SeatTransitions = { ...original, enter: (...args) => { const p = original.enter(...args); capture('enter-start'); setTimeout(() => capture('enter-middle'), 120); return p; }, exit: (...args) => { const p = original.exit(...args); capture('exit-start'); setTimeout(() => capture('exit-middle'), 350); return p; } };
  });
  await client.evaluate(async () => { const b = document.body; b.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true })); await new Promise(r => setTimeout(r, 35)); b.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true })); });
  await waitFor(() => client.evaluate(() => window.__depthFrames.length > 0));
  await finished();
  const depth = await client.evaluate(() => window.__depthFrames);
  check('轻触空格不足200ms只抽选一次，座位真正从负 Z 深度浮入且没有 X/Y 位移', depth.some(frame => frame.phase === 'enter-start' && frame.frames.every(s => s.z < -600 && Math.abs(s.x) < .01 && Math.abs(s.y) < .01)) && await client.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 1, KEY));
  check('座位浮入中投影尺寸增大并显示白色高亮，抵达后清理 Z 动画样式', depth.some(frame => frame.phase === 'enter-middle' && frame.frames.some((seat, i) => seat.size > depth[0].frames[i].size && seat.opacity > .05 && seat.color === 'rgb(255, 255, 255)')) && await client.evaluate(() => document.querySelectorAll('.seat-transition-running').length === 0));
  await client.evaluate(async () => { const b = document.body; b.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true })); await new Promise(r => setTimeout(r, 250)); b.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true })); await new Promise(r => setTimeout(r, 250)); });
  check('空格按住200至500ms后松开，同样取消抽选且只反向撤回进度', await client.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 1 && !document.getElementById('configDialog').open, KEY));
  await client.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', key: 'r', bubbles: true }))); await pause(240);
  check('R 键启动重置按钮的同一条红色长按进度，500ms前记录保持', await client.evaluate(key => { const b = document.getElementById('resetDrawBtn'), color = getComputedStyle(b, '::before').backgroundColor.match(/\d+/g).map(Number); return b.hasAttribute('data-reset-holding') && color[0] > color[1] && color[0] > color[2] && JSON.parse(localStorage.getItem(key)).round === 1; }, KEY));
  await client.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR', key: 'r', bubbles: true }))); await pause(350);
  check('R 键提前松开不会重置，红色进度最终收回', await client.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 1 && !document.getElementById('resetDrawBtn').hasAttribute('data-reset-holding'), KEY));
  await client.evaluate(async () => { const b = document.body; b.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', key: 'r', bubbles: true })); await new Promise(r => setTimeout(r, 540)); b.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR', key: 'r', bubbles: true })); }); await finished();
  check('R 键按满500ms执行 Z 轴退场再重置，与 UI 长按共用逻辑', await client.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 0 && document.getElementById('liveBoard').hidden && window.__depthFrames.some(frame => frame.phase === 'exit-middle' && frame.frames.some(s => s.z < -1) && frame.frames.every(s => Math.abs(s.x) < .01 && Math.abs(s.y) < .01)), KEY));
  const qState = await client.evaluate(() => { const s = DrawCore.createState(Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1), name: '连坐' + i, row: Math.floor(i / 3) + 1, col: i % 3 + 1 })), 912); s.settings = DrawCore.settings({ strategy: 'manual', manualMode: 'direction', direction: 'right', directionMin: 3, directionMax: 3, endJumpChance: 0 }); DrawCore.draw(s, new Date()); return s; });
  await reload(qState);
  check('剩余轮数直接嵌入原提示中，只放大绿色 X，没有额外“剩余X轮”标签', await client.evaluate(key => { const n = document.getElementById('chainRemaining'), caption = document.getElementById('directionCaption'), s = getComputedStyle(n); return n.parentElement.id === 'directionRemainder' && caption.contains(n) && n.textContent === String(JSON.parse(localStorage.getItem(key)).lock.remaining) && !n.textContent.includes('轮') && parseFloat(s.fontSize) > parseFloat(getComputedStyle(caption).fontSize) && s.color.match(/\d+/g).map(Number)[1] > s.color.match(/\d+/g).map(Number)[0]; }, KEY));
  await client.evaluate(() => { const b = document.body; b.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', key: 'q', bubbles: true })); b.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', key: 'q', repeat: true, bubbles: true })); b.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyQ', key: 'q', bubbles: true })); });
  check('Q 键退出连坐，按键重复不增加抽选或历史，显示本轮结束提示', await client.evaluate((key, count) => { const s = JSON.parse(localStorage.getItem(key)); return s.lock === null && s.round === count && document.getElementById('exitChainBtn').hidden && document.getElementById('directionCaption').textContent.includes('本轮结束') && !document.getElementById('directionVisual').hidden; }, KEY, qState.round));
  await waitFor(() => client.evaluate(() => document.getElementById('directionVisual').hidden && document.getElementById('drawVisual').hidden), 5000);
  check('本轮结束提示等待约3秒再淡出消失，关闭配置也不会重新显示旧提示', await client.evaluate(() => document.getElementById('directionVisual').classList.contains('is-notice-fading')));
  await client.evaluate(async () => { document.getElementById('configDialog').showModal(); document.querySelector('.navigation [data-nav="dashboard"]').click(); await new Promise(resolve => setTimeout(resolve, 0)); const time = document.getElementById('timeChanceInput'); time.value = 40; time.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 0)); });
  const chanceBefore = await client.evaluate(key => JSON.parse(localStorage.getItem(key)).settings.directionChance, KEY);
  await client.evaluate(async () => { const direction = document.getElementById('directionChanceInput'); direction.value = 70; direction.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 0)); });
  check('模式行触发概率合计超过100%时明确拒绝保存并恢复原值', await client.evaluate((key, before) => (DialogTransitions.topModal() || document).querySelector('[data-toast-host]').textContent.includes('100%') && JSON.parse(localStorage.getItem(key)).settings.directionChance === before && Number(document.getElementById('directionChanceInput').value) === before && !document.getElementById('settingsDialog').open, KEY, chanceBefore));
  await client.evaluate(async () => { for (const [id, value] of [['directionChanceInput', 20], ['timeChanceInput', 30]]) { const input = document.getElementById(id); input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 0)); } });
  await client.evaluate(async () => { const input = document.getElementById('endJumpChanceInput'); input.value = 45; input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 0)); });
  check('末尾改选在功能页即时保存且默认开启，不参与模式概率合计，冷却期间连坐概率归普通', await client.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), chance = DrawCore.modeChances(s), input = document.getElementById('endJumpChanceInput'); return s.settings.directionChance === 20 && s.settings.timeChance === 30 && s.settings.endJumpChance === 45 && s.settings.endJumpEnabled === true && document.getElementById('endJumpEnabledInput').checked && document.getElementById('view-dashboard').contains(input) && !document.getElementById('settingsDialog').contains(input) && s.directionCooldownRemaining > 0 && chance.direction === 0 && chance.normal === 70 && chance.time === 30 && !document.getElementById('settingsDialog').open; }, KEY));
  await picture('probability-settings.png');
  await client.evaluate(async () => { const input = document.getElementById('endJumpChanceInput'); input.value = 100; input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 0)); });
  await click('endJumpEnabledInput');
  check('关闭结果跳变立即保存并保留100%预设，模式概率分配不变', await client.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), chance = DrawCore.modeChances(s), input = document.getElementById('endJumpChanceInput'); return s.settings.endJumpEnabled === false && s.settings.endJumpChance === 100 && input.disabled && input.value === '100' && chance.normal === 70 && chance.time === 30 && !document.getElementById('settingsDialog').open; }, KEY));
  await reload(await client.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY));
  check('结果跳变关闭状态和100%预设跨刷新保留', await client.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return s.settings.endJumpEnabled === false && s.settings.endJumpChance === 100 && !document.getElementById('endJumpEnabledInput').checked && document.getElementById('endJumpChanceInput').disabled; }, KEY));
  const disabledJumpRound = await client.evaluate(key => JSON.parse(localStorage.getItem(key)).round, KEY);
  await click('drawBtn'); await finished();
  check('关闭结果跳变后真实抽选只提交一次且不会发生末尾改选，即使保留100%概率', await client.evaluate((key, before) => { const s = JSON.parse(localStorage.getItem(key)), record = s.history.at(-1); return s.round === before + 1 && !record.endJump && s.settings.endJumpChance === 100 && s.settings.endJumpEnabled === false && document.querySelector('#liveSeats .current')?.dataset.liveStudent === record.studentId; }, KEY, disabledJumpRound));
  await client.evaluate(async () => { document.getElementById('configDialog').showModal(); document.querySelector('.navigation [data-nav="dashboard"]').click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  await click('endJumpEnabledInput');
  check('重新开启结果跳变恢复100%预设且不打开附加设置', await client.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return s.settings.endJumpEnabled === true && s.settings.endJumpChance === 100 && document.getElementById('endJumpEnabledInput').checked && !document.getElementById('endJumpChanceInput').disabled && !document.getElementById('settingsDialog').open; }, KEY));
  // Capture actual geometry immediately before/after the production helper.
  // This catches the original flex-order bug independently of its diagnostics.
  for (const positions of [[1, 2], [2, 1], [1, 4]]) {
    const fixture = await client.evaluate(positions => { const id = positions.join(',') === '2,1' ? '41' : positions.join(',') === '1,4' ? '18' : '14'; const s = DrawCore.createState([{ id, name: '目标同学', row: 1, col: 1 }, { id: '99', name: '其他同学', row: 1, col: 2 }], 901); s.settings = DrawCore.settings({ strategy: 'manual', manualMode: 'time', modes: ['time'], timeSource: 'time', timeSelection: 'fixed', positions: positions.join(',') }); return s; }, positions);
    await reload(fixture);
    await client.evaluate(() => {
      const NativeDate = window.Date; window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : ['2026-10-12T14:28:12'])); } static now() { return NativeDate.parse('2026-10-12T14:28:12'); } };
      window.__pairSamples = null; window.__nameSamples = null;
      const box = el => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; };
      for (const stage of ['pair', 'name']) { const original = TimeDigitsTransitions[stage]; TimeDigitsTransitions[stage] = positions => { const picked = positions.map(p => document.querySelector('#timeDigits [data-time-position="' + p + '"]')), before = picked.map(box), task = original(positions), after = picked.map(box); window[stage === 'pair' ? '__pairSamples' : '__nameSamples'] = { positions, before, after, firstFrameErrors: before.map((b, i) => Math.hypot(b.x - after[i].x, b.y - after[i].y)) }; return task; }; }
      Math.random = () => .9;
    });
    await click('drawBtn'); await waitFor(() => client.evaluate(() => !!window.__pairSamples), 7000);
    const start = await client.evaluate(() => window.__pairSamples);
    check('时间取位 ' + positions.join(',') + ' 开始聚焦时每个数字从其真实原位置起步，没有跳到最右侧', start.firstFrameErrors.every(error => error < 1));
    check('时间取位 ' + positions.join(',') + ' 未选数字留在原位置淡出，选中数字保持独立移动', await client.evaluate(() => document.querySelectorAll('.time-digit-ghost').length >= 4 && document.getElementById('timeVisual').dataset.phase === 'pairing' && Array.from(document.querySelectorAll('#timeDigits .chosen')).every(el => el.getAnimations().some(a => !(a instanceof CSSTransition)))));
    await waitFor(() => client.evaluate(() => document.getElementById('timeVisual').dataset.phase === 'naming'), 2200);
    const named = await client.evaluate(() => window.__nameSamples);
    check('时间取位 ' + positions.join(',') + ' 姓名揭晓从中央数字布局连贯左移，没有第二次跳变', named.firstFrameErrors.every(error => error < 1));
    await finished();
    check('时间取位 ' + positions.join(',') + ' 最终数字、真实学生和取位顺序一致，临时 ghost 和动画全部移除', await client.evaluate((key, positions) => { const s = JSON.parse(localStorage.getItem(key)), r = s.history.at(-1); return r.mode === 'time' && r.timeRule.positions.join(',') === positions.join(',') && r.studentId === s.lastId && document.querySelectorAll('.time-digits-ghost-layer').length === 0 && !document.getElementById('timeVisual').dataset.layoutFlip; }, KEY, positions));
  }
  // A pre-existing seen neighbor is swept by the pointer but remains dimmed.
  const directional = await client.evaluate(() => { const students = []; for (let row = 1; row <= 3; row++) for (let col = 1; col <= 3; col++) students.push({ id: String((row - 1) * 3 + col), name: '座位' + row + col, row, col }); const s = DrawCore.createState(students, 777); s.settings = DrawCore.settings({ strategy: 'manual', manualMode: 'direction', modes: ['direction'], direction: 'right', directionMin: 5, directionMax: 5, cooldown: 1 }); s.round = 2; s.lastId = '5'; s.counts = { '5': 1, '2': 1 }; s.lastSeen = { '5': 2, '2': 1 }; s.cycleSeen = ['2', '5']; s.history = [{ round: 1, studentId: '2', name: '座位12', row: 1, col: 2, mode: 'normal', reason: 'fixture', time: '2026-10-12T00:00:00Z' }, { round: 2, studentId: '5', name: '座位22', row: 2, col: 2, mode: 'normal', reason: 'fixture', time: '2026-10-12T00:00:00Z' }]; return s; });
  await reload(directional);
  await client.evaluate(() => { window.__seenFrames = []; Math.random = () => .9; const timer = setInterval(() => { if (!document.getElementById('seatArrow').classList.contains('spinning-arrow')) return; const cell = document.querySelector('#liveSeats [data-live-student="2"]'); window.__seenFrames.push({ caption: document.getElementById('directionCaption').textContent, candidate: cell.classList.contains('candidate'), opacity: Number(getComputedStyle(cell).opacity), arrow: document.getElementById('seatArrowPath').getAttribute('d') }); }, 16); setTimeout(() => clearInterval(timer), 7000); });
  await click('drawBtn'); await finished();
  const seen = await client.evaluate(() => window.__seenFrames);
  check('方向箭头实际经过已抽座位，字幕提示已抽过且从未给予 candidate 高亮', seen.some(frame => frame.caption.includes('座位12（已抽过）')) && seen.every(frame => !frame.candidate));
  check('方向动画经过已抽座位时始终保持淡化，指针依然正常旋转', seen.length > 20 && seen.every(frame => frame.opacity <= .31) && new Set(seen.map(frame => frame.arrow)).size > 20);
  const layoutSource = (await readFile(path.join(root, 'tests/e2e/qa.mjs'), 'utf8')).split('function seatLayoutSnapshot()')[1].split('function cameraFocusSnapshot()')[0];
  const layoutFixture = await client.evaluate(() => { const s = DrawCore.createState(Array.from({ length: 47 }, (_, i) => ({ id: String(i + 1), name: '随机' + (i + 1), row: Math.floor(i / 8) + 1, col: i % 8 + 1 })), 6789); s.settings = DrawCore.settings({ strategy: 'manual', manualMode: 'normal', endJumpChance: 0 }); DrawCore.draw(s); return s; });
  await reload(layoutFixture);
  await client.evaluate(source => window.__layoutSnapshot = new Function('return (function seatLayoutSnapshot()' + source + ')')(), layoutSource);
  for (const [width, height] of [[1920, 1080], [1366, 768], [1280, 720], [1280, 590], [768, 432], [768, 360], [320, 780]]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, mobile: width < 400, deviceScaleFactor: width === 768 ? 2.5 : 1 }); await pause(450);
    const layout = await client.evaluate(() => window.__layoutSnapshot());
    console.log('Layout ' + width + 'x' + height + ': ' + JSON.stringify(layout));
    check(width + '×' + height + ' 座位焦点、按钮与文字可见且无页面溢出', layout.pageFits && layout.controlsFit && layout.focusVisible && layout.focusUncovered && (layout.following ? layout.scrollClips && layout.seatHeight >= 47 && layout.nameSize >= 11 && layout.idSize >= 9 : layout.allVisible));
  }
  check('补充检查没有未处理的 JavaScript 异常', client.errors.length === 0);
  await writeFile(path.join(output, 'extra-report.json'), JSON.stringify({ artifactBytes: artifact.length, artifactSha256, completedAt: new Date().toISOString(), checks, runtimeErrors: client.errors, screenshots }, null, 2));
  console.log('Extra browser QA complete: ' + checks.length + ' checks');
} finally {
  if (client) { try { await client.send('Browser.close'); } catch (_) {} client.ws.close(); }
  if (browser && !browser.killed) browser.kill();
  await pause(500); const resolved = await realpath(profile).catch(() => null);
  if (resolved && path.dirname(resolved) === parent && path.basename(resolved).startsWith('rollcall-extra-')) await rm(resolved, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
