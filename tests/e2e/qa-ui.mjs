import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// These checks run the exported, offline HTML, never real model services.
const root = fileURLToPath(new URL('../../', import.meta.url)), output = path.join(root, 'qa-output');
const artifact = await readFile(path.join(root, 'dist/index.html'));
const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
const KEY = 'rollcall-studio:v1', checks = [], screenshots = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
await mkdir(output, { recursive: true });
const parent = await realpath(tmpdir()), profile = await mkdtemp(path.join(parent, 'rollcall-ui-'));
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
async function settled(id, open = true) { await waitFor(() => client.evaluate((id, open) => { const d = document.getElementById(id); return d.open === open && !d.dataset.motion; }, id, open)); }
async function click(id) { await client.evaluate(async id => { const e = document.getElementById(id); const view = e.closest('section.view[hidden]'); if (view) { document.querySelector('.navigation [data-nav="' + view.id.replace('view-', '') + '"]').click(); await new Promise(resolve => setTimeout(resolve, 0)); } e.focus({ preventScroll: true }); e.click(); await new Promise(resolve => setTimeout(resolve, 0)); }, id); }
async function selectClick(selector) { await client.evaluate(async selector => { const e = document.querySelector(selector); const view = e.closest('section.view[hidden]'); if (view) { document.querySelector('.navigation [data-nav="' + view.id.replace('view-', '') + '"]').click(); await new Promise(resolve => setTimeout(resolve, 0)); } e.focus({ preventScroll: true }); e.click(); await new Promise(resolve => setTimeout(resolve, 0)); }, selector); }
async function close(id) { await client.evaluate(id => window.DialogTransitions.close(document.getElementById(id)), id); await settled(id, false); }
async function picture(name) { const data = await client.send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(output, name), Buffer.from(data.data, 'base64')); screenshots.push(name); }
async function nativeSpace() {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
}
async function tabTo(id) {
  for (let attempt = 0; attempt < 30; attempt++) {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    if (await client.evaluate(id => document.activeElement.id === id, id)) return;
  }
  throw new Error('Keyboard Tab cannot reach #' + id);
}
async function escape(heldRepeat = false) {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  if (heldRepeat) {
    await client.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, autoRepeat: true });
  }
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}
async function checkbox(id) {
  const point = await client.evaluate(id => { const e = document.getElementById(id); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, id);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
}
async function openConfig() {
  await client.evaluate(() => document.getElementById('drawBtn').focus({ preventScroll: true }));
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await pause(540);
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await settled('configDialog');
}
async function installTrace() {
  await client.evaluate(() => {
    window.__uiMotionFrames = []; window.__uiMotionEvents = [];
    const capture = () => {
      for (const d of document.querySelectorAll('dialog')) {
        if (!d.dataset.motion) continue;
        const s = getComputedStyle(d), b = getComputedStyle(d, '::backdrop'), m = new DOMMatrix(s.transform), r = d.getBoundingClientRect();
        const animations = d.getAnimations(), easings = animations.filter(a => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation)).map(a => a.effect.getTiming().easing);
        window.__uiMotionFrames.push({ id: d.id, phase: d.dataset.motion, at: performance.now(), open: d.open, modal: d.matches(':modal'), z: m.m43, x: m.m41, y: m.m42, perspective: m.m34, opacity: Number(s.opacity), backdropOpacity: Number(b.opacity), backdropColor: b.backgroundColor, cx: r.x + r.width / 2, cy: r.y + r.height / 2, animations: animations.length, easings });
      }
    };
    const observer = new MutationObserver(records => {
      for (const mutation of records) {
        if (mutation.target instanceof HTMLDialogElement && ['data-motion', 'open'].includes(mutation.attributeName)) {
          const d = mutation.target; window.__uiMotionEvents.push({ id: d.id, phase: d.dataset.motion || '', open: d.open, at: performance.now() });
        }
      }
      capture();
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-motion', 'open'] });
    document.addEventListener('cancel', event => { const d = event.target; queueMicrotask(() => window.__uiMotionEvents.push({ event: 'cancel', id: d.id, cancelable: event.cancelable, prevented: event.defaultPrevented, phase: d.dataset.motion || '', open: d.open, at: performance.now() })); }, true);
    for (const type of ['keydown', 'keyup']) document.addEventListener(type, event => { if (event.code === 'Escape') window.__uiMotionEvents.push({ event: type, id: event.target.id, trusted: event.isTrusted, repeat: event.repeat, at: performance.now() }); }, true);
    const frame = () => { capture(); requestAnimationFrame(frame); }; requestAnimationFrame(frame);
    window.__uiTraceObserver = observer;
  });
}
async function motion(id, phase) { return client.evaluate((id, phase) => window.__uiMotionFrames.filter(f => f.id === id && f.phase === phase), id, phase); }
async function clearTrace() { await client.evaluate(() => { window.__uiMotionFrames.length = 0; window.__uiMotionEvents.length = 0; }); }
async function holdSample(buttonId, code, key) {
  // Start, sample and release in one renderer task. The CSS animation's own
  // clock, rather than CDP round trips, supplies the expected linear fraction.
  return client.evaluate(async (buttonId, code, key, storageKey) => {
    const button = document.getElementById(buttonId), before = localStorage.getItem(storageKey);
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const fraction = () => { const transform = getComputedStyle(button, '::before').transform; return transform === 'none' ? 0 : new DOMMatrix(transform).a; };
    button.focus({ preventScroll: true });
    button.dispatchEvent(new KeyboardEvent('keydown', { code, key, bubbles: true }));
    const fill = button.getAnimations({ subtree: true }).find(animation => animation.animationName === 'hold-fill');
    if (!fill) throw new Error(buttonId + ' did not start hold-fill');
    while (Number(fill.currentTime || 0) < 275) await frame();
    const style = getComputedStyle(button, '::before');
    const held = { time: Number(fill.currentTime), duration: fill.effect.getTiming().duration, fraction: fraction(), easing: style.animationTimingFunction, color: style.backgroundColor };
    button.dispatchEvent(new KeyboardEvent('keyup', { code, key, bubbles: true }));
    const released = { fraction: fraction(), easing: getComputedStyle(button, '::before').animationTimingFunction, duration: parseFloat(button.style.getPropertyValue('--hold-release-duration')) };
    const samples = [released.fraction], started = performance.now();
    while (button.hasAttribute('data-hold-releasing') && performance.now() - started < 1000) { await frame(); samples.push(fraction()); }
    await new Promise(resolve => setTimeout(resolve, 120));
    return { held, released, samples, unchanged: before === localStorage.getItem(storageKey), clean: !button.hasAttribute('data-holding') && !button.hasAttribute('data-reset-holding') && !button.hasAttribute('data-hold-releasing') && !button.style.getPropertyValue('--hold-progress') && !button.style.getPropertyValue('--hold-release-duration') && fraction() === 0, noDraw: document.getElementById('drawBtn').getAttribute('aria-busy') === 'false', noDialog: !document.querySelector('dialog[open]') };
  }, buttonId, code, key, KEY);
}
function nonlinearHold(sample) {
  const { held, released, samples } = sample;
  return held.duration === 500 && held.time >= 260 && held.time < 400 && Math.abs(held.fraction - held.time / held.duration) > .025 && held.easing.includes('cubic-bezier') && released.easing.includes('cubic-bezier') && held.easing !== released.easing && Math.abs(held.fraction - released.fraction) < .015 && Math.abs(released.duration - held.fraction * 500) <= 1 && samples.length >= 3 && samples.slice(1).every((value, index) => value <= samples[index] + .005) && samples.some(value => value > 0 && value < released.fraction - .005) && sample.clean && sample.unchanged && sample.noDraw && sample.noDialog;
}
async function reload(state) {
  if (state) { state.demo = false; state.settings.theme = 'classic'; state.settings.radius = 0; }
  await client.evaluate((key, state) => { if (state) localStorage.setItem(key, JSON.stringify(state)); window.__uiOldPage = true; }, KEY, state);
  await client.send('Page.reload');
  await waitFor(() => client.evaluate(() => !window.__uiOldPage && document.querySelectorAll('[data-mode-row]').length === 5));
  await installTrace();
}
async function cleaned(id) {
  return client.evaluate(id => {
    const d = document.getElementById(id);
    return !d.dataset.motion && !d.style.transform && !d.style.opacity && d.getAnimations().filter(a => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation)).length === 0;
  }, id);
}
function motionChecks(label, frames) {
  check(label + ' 保持原 X/Y 中心并使用真正的透视 Z 位移', frames.length >= 3 && frames.some(f => Math.abs(f.z) > 1 && Math.abs(f.perspective) > 0) && frames.every(f => Math.abs(f.x) < .05 && Math.abs(f.y) < .05) && Math.max(...frames.map(f => f.cx)) - Math.min(...frames.map(f => f.cx)) < 2 && Math.max(...frames.map(f => f.cy)) - Math.min(...frames.map(f => f.cy)) < 2);
  check(label + ' 对话框内容渐变且动画期间始终保持 modal', frames.every(f => f.open && f.modal) && frames.some(f => f.opacity > .02 && f.opacity < .99));
  const backdropValues = frames.map(f => f.backdropOpacity);
  check(label + ' backdrop 随窗口透明度连续变化', Math.max(...backdropValues) - Math.min(...backdropValues) > .05);
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
  await waitFor(() => client.evaluate(() => document.querySelectorAll('[data-mode-row]').length === 5));
  check('全新离线页面默认没有示例座位，UI回归名单由测试显式提供', await client.evaluate(() => document.querySelectorAll('#rosterSeats [data-student]').length === 0));
  const uiClassroom = await client.evaluate(() => {
    const students = Array.from({ length: 47 }, (_, i) => ({ id: String(i + 1), name: '界面测试' + (i + 1), row: Math.floor(i / 8) + 1, col: i % 8 + 1, active: true }));
    const value = DrawCore.createState(students, 32198); value.demo = false; value.className = '界面回归班'; return value;
  });
  await reload(uiClassroom);
  check('统一弹窗控制器在独立 HTML 内可用', await client.evaluate(() => ['open', 'close', 'init'].every(k => typeof window.DialogTransitions?.[k] === 'function')));
  const drawHold = await holdSample('drawBtn', 'Space', ' ');
  console.log('Draw hold easing sample: ' + JSON.stringify(drawHold));
  check('抽选长按使用非线性填充，松手从当前画面连续反向回退且超过 200 ms 不误抽', nonlinearHold(drawHold));
  await installTrace();
  await openConfig();
  motionChecks('配置入场', await motion('configDialog', 'enter'));
  const cssTimings = await client.evaluate(() => {
    const timings = [];
    const visit = rules => { for (const rule of rules) { if (rule.style) for (const property of ['animation-timing-function', 'transition-timing-function']) { const value = rule.style.getPropertyValue(property); if (value) timings.push({ selector: rule.selectorText || rule.keyText || '', property, value }); } if (rule.cssRules) visit(rule.cssRules); } };
    for (const sheet of document.styleSheets) visit(sheet.cssRules);
    return timings;
  });
  const dialogEasings = (await motion('configDialog', 'enter')).flatMap(frame => frame.easings);
  check('所有 CSS 动画与过渡均使用非线性时序，弹窗运行中的 WAAPI 也使用贝塞尔曲线', cssTimings.length > 20 && cssTimings.every(timing => !timing.value.includes('linear')) && dialogEasings.length > 2 && dialogEasings.every(easing => easing.includes('cubic-bezier')));
  check('配置入场后清理临时动画样式', await cleaned('configDialog'));

  const glyph = await client.evaluate(async () => {
    await document.fonts.ready;
    const icon = document.querySelector('[data-mode-row="time"] .material-icon'), s = getComputedStyle(icon), range = document.createRange(); range.selectNodeContents(icon);
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d'); ctx.font = s.fontSize + ' ' + s.fontFamily;
    return { text: icon.textContent, width: range.getBoundingClientRect().width, size: parseFloat(s.fontSize), canvasWidth: ctx.measureText('schedule').width, transform: s.textTransform, family: s.fontFamily };
  });
  check('时间选项 schedule 实际渲染单个图标字形，不显示 SCHEDULE 字母', glyph.text === 'schedule' && glyph.transform === 'none' && glyph.family.includes('Material') && glyph.width > 8 && glyph.width <= glyph.size * 1.2 && glyph.canvasWidth <= glyph.size * 1.2);
  await client.evaluate(() => document.querySelector('[data-mode-row="time"]').scrollIntoView({ block: 'center' }));
  await picture('ui-mode-icon-switches.png');
  const modeBefore = await client.evaluate(() => { const b = document.getElementById('modeEnabled-time'), s = getComputedStyle(b); return { pressed: String(b.checked), w: parseFloat(s.width), h: parseFloat(s.height), radius: s.borderRadius, icon: b.querySelector('.icon')?.getClientRects().length || 0 }; });
  check('模式选项使用无圆角矩形开关且旧勾选图标隐藏', modeBefore.pressed === 'true' && modeBefore.w > modeBefore.h * 1.35 && modeBefore.radius === '0px' && modeBefore.icon === 0);
  await checkbox('modeEnabled-time');
  check('模式矩形开关保留真实选中状态并立即保存', await client.evaluate(key => !JSON.parse(localStorage.getItem(key)).settings.modes.includes('time') && document.getElementById('modeEnabled-time').checked === false, KEY));
  await checkbox('modeEnabled-time');

  await clearTrace(); await click('settingsBtn'); await settled('settingsDialog');
  motionChecks('嵌套规则入场', await motion('settingsDialog', 'enter'));
  check('嵌套弹窗打开时外层配置保留 open/modal', await client.evaluate(() => ['configDialog', 'settingsDialog'].every(id => { const d = document.getElementById(id); return d.open && d.matches(':modal'); })));
  const switchStyle = await client.evaluate(() => {
    const e = document.getElementById('voiceInput'), s = getComputedStyle(e), thumb = getComputedStyle(e, '::before');
    window.__voiceChanges = 0; e.addEventListener('change', () => window.__voiceChanges++);
    return { appearance: s.appearance, w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height, radius: s.borderRadius, thumb: thumb.content, thumbWidth: thumb.width, checked: e.checked };
  });
  check('checkbox 由自绘矩形 track/thumb 呈现，原生 input 仍保留语义', switchStyle.appearance === 'none' && switchStyle.w > switchStyle.h * 1.35 && switchStyle.radius === '0px' && switchStyle.thumb !== 'none' && parseFloat(switchStyle.thumbWidth) > 5 && switchStyle.checked === false);
  await checkbox('voiceInput');
  check('矩形开关鼠标点击触发原生 change 一次', await client.evaluate(() => document.getElementById('voiceInput').checked && window.__voiceChanges === 1));
  await client.evaluate(() => document.getElementById('voiceInput').focus()); await nativeSpace();
  check('矩形开关空格键保持原生键盘切换与焦点样式', await client.evaluate(() => { const e = document.getElementById('voiceInput'); return !e.checked && window.__voiceChanges === 2 && e.matches(':focus-visible'); }));
  await nativeSpace();
  await selectClick('[data-settings-tab="time"]');
  await client.evaluate(() => { const input = document.getElementById('timeSourceInput'); input.value = 'time'; input.dispatchEvent(new Event('change', { bubbles: true })); window.__qaDigitNodes = Array.from(document.querySelectorAll('#digitButtons [data-digit]')); window.__qaDigitNodes[5].focus(); window.__qaDigitText = window.__qaDigitNodes[5].textContent; });
  await waitFor(() => client.evaluate(() => window.__qaDigitNodes[5].textContent !== window.__qaDigitText), 2500);
  check('时间取位跨秒更新保持原节点与焦点', await client.evaluate(() => window.__qaDigitNodes.every((node, index) => node === document.querySelectorAll('#digitButtons [data-digit]')[index]) && document.activeElement === window.__qaDigitNodes[5]));
  await nativeSpace();
  check('键盘激活取位按钮仍保留节点焦点与无障碍选中状态', await client.evaluate(() => document.activeElement === window.__qaDigitNodes[5] && window.__qaDigitNodes[5].getAttribute('aria-pressed') === String(window.__qaDigitNodes[5].classList.contains('chosen'))));
  for (const [source, length] of [['date', 8], ['datetime', 14], ['time', 6]]) {
    await client.evaluate(source => { const nodes = document.querySelectorAll('#digitButtons [data-digit]'); nodes[nodes.length - 1].focus(); const input = document.getElementById('timeSourceInput'); input.value = source; input.dispatchEvent(new Event('change', { bubbles: true })); }, source);
    check('切换时间源 ' + source + ' 保持同一有效取位焦点', await client.evaluate(length => { const nodes = document.querySelectorAll('#digitButtons [data-digit]'); return nodes.length === length && document.activeElement === nodes[Math.min(window.__qaPreviousDigits || 6, length) - 1]; }, length));
    await client.evaluate(length => { window.__qaPreviousDigits = length; }, length);
  }
  await client.evaluate(() => { document.getElementById('positionsInput').value = '5,6'; document.getElementById('positionsInput').dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('directionMinInput').value = '0'; });
  await selectClick('[data-settings-tab="general"]');
  await client.evaluate(() => document.getElementById('settingsForm').requestSubmit());
  check('隐藏页无效字段自动切回连坐页并聚焦而不保存', await client.evaluate(key => document.getElementById('settingsDialog').open && document.activeElement.id === 'directionMinInput' && !document.activeElement.closest('[data-settings-panel]').hidden && JSON.parse(localStorage.getItem(key)).settings.voice === false, KEY));
  await client.evaluate(() => { document.getElementById('directionMinInput').value = '2'; });
  const hasCooldownFields = await client.evaluate(() => !!document.getElementById('directionCooldownMinInput') && !!document.getElementById('directionCooldownMaxInput'));
  if (hasCooldownFields) {
    await selectClick('[data-settings-tab="direction"]');
    check('连坐冷却双输入框默认 3～5 轮且允许 0～50', await client.evaluate(() => { const a = document.getElementById('directionCooldownMinInput'), b = document.getElementById('directionCooldownMaxInput'); return a.value === '3' && b.value === '5' && a.min === '0' && b.min === '0' && a.max === '50' && b.max === '50'; }));
    await client.evaluate(() => { document.getElementById('directionCooldownMinInput').value = 9; document.getElementById('directionCooldownMaxInput').value = 2; document.getElementById('settingsForm').requestSubmit(); });
    check('连坐冷却最少轮数大于最多轮数时拒绝保存并保留规则弹窗', await client.evaluate(key => document.getElementById('settingsDialog').open && document.getElementById('settingsError').textContent.trim().length > 0 && JSON.parse(localStorage.getItem(key)).settings.voice === false, KEY));
    await client.evaluate(() => { document.getElementById('directionCooldownMinInput').value = 2; document.getElementById('directionCooldownMaxInput').value = 4; });
  }
  await clearTrace();
  await client.evaluate(() => document.getElementById('settingsForm').requestSubmit()); await settled('settingsDialog', false);
  motionChecks('保存规则退场', await motion('settingsDialog', 'exit'));
  check('保存后语音 checked 正确持久化且嵌套焦点回到规则入口', await client.evaluate(key => JSON.parse(localStorage.getItem(key)).settings.voice === true && document.getElementById('configDialog').open && document.activeElement.id === 'settingsBtn', KEY));
  if (hasCooldownFields) check('连坐冷却上下限两个输入框合法范围正确保存', await client.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)).settings; return s.directionCooldownMin === 2 && s.directionCooldownMax === 4; }, KEY));
  check('保存退场结束后移除临时动画', await cleaned('settingsDialog'));
  await click('settingsBtn'); await settled('settingsDialog');
  check('重新打开规则矩形开关恢复保存状态', await client.evaluate(() => document.getElementById('voiceInput').checked));
  if (hasCooldownFields) { await selectClick('[data-settings-tab="direction"]'); check('重新打开规则恢复连坐冷却上下限', await client.evaluate(() => document.getElementById('directionCooldownMinInput').value === '2' && document.getElementById('directionCooldownMaxInput').value === '4')); }
  await close('settingsDialog');

  await selectClick('[data-nav="roster"]');
  await selectClick('#rosterSeats [data-student="1"]'); await click('seatSettingsBtn'); await settled('studentDialog');
  await checkbox('studentActiveInput');
  await client.evaluate(() => document.getElementById('studentForm').requestSubmit()); await settled('studentDialog', false);
  check('学生参与矩形开关保存真实 active 状态', await client.evaluate(key => JSON.parse(localStorage.getItem(key)).students.find(s => s.id === '1').active === false, KEY));
  await selectClick('#rosterSeats [data-student="1"]'); await click('seatSettingsBtn'); await settled('studentDialog');
  check('学生编辑重新打开恢复暂停参与开关', await client.evaluate(() => !document.getElementById('studentActiveInput').checked));
  await close('studentDialog'); await close('configDialog');
  check('配置关闭完成后焦点返回主页抽人按钮', await client.evaluate(() => document.activeElement.id === 'drawBtn'));
  await reload(); await openConfig(); await click('settingsBtn'); await settled('settingsDialog');
  check('刷新 HTML 后 checked 和 active 跨会话保留', await client.evaluate(key => document.getElementById('voiceInput').checked && JSON.parse(localStorage.getItem(key)).students.find(s => s.id === '1').active === false, KEY));
  await close('settingsDialog'); await close('configDialog');

  const fixture = await client.evaluate(() => {
    const s = DrawCore.createState(Array.from({ length: 47 }, (_, i) => ({ id: String(i + 1), name: '同学' + (i + 1), row: Math.floor(i / 8) + 1, col: i % 8 + 1 })), 9761);
    s.settings = DrawCore.settings({ strategy: 'manual', manualMode: 'normal', endJumpChance: 0 }); DrawCore.draw(s); return s;
  });
  await reload(fixture);
  const resetHold = await holdSample('resetDrawBtn', 'KeyR', 'r');
  console.log('Reset hold easing sample: ' + JSON.stringify(resetHold));
  check('R 键重置使用相同非线性填充和红色进度，短按连续回退并保留抽取记录', nonlinearHold(resetHold) && resetHold.held.easing === drawHold.held.easing && resetHold.released.easing === drawHold.released.easing && resetHold.held.color === 'rgb(201, 56, 56)');
  for (const [key, code, virtualKey] of [[' ', 'Space', 32], ['Enter', 'Enter', 13]]) {
    await reload(fixture);
    await tabTo('resetDrawBtn');
    const beforeReset = await client.evaluate(key => localStorage.getItem(key), KEY);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey }); await pause(70);
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey }); await pause(250);
    check(code + ' 短按重置不抽人也不打开配置', await client.evaluate((storageKey, before) => localStorage.getItem(storageKey) === before && !document.getElementById('configDialog').open, KEY, beforeReset));
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey }); await pause(620);
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey });
    await waitFor(() => client.evaluate(storageKey => { const s = JSON.parse(localStorage.getItem(storageKey)); return document.getElementById('drawBtn').getAttribute('aria-busy') === 'false' && s.round === 0 && !document.querySelector('.draw-screen').classList.contains('is-lifecycle'); }, KEY));
    check(code + ' 长按只重置当前进度并保留长期统计', await client.evaluate((storageKey, stats) => { const s = JSON.parse(localStorage.getItem(storageKey)); return s.round === 0 && s.history.length === 0 && JSON.stringify(s.fairnessStats) === JSON.stringify(stats) && !document.getElementById('configDialog').open; }, KEY, fixture.fairnessStats));
  }
  await reload(fixture);
  await openConfig(); await selectClick('[data-import]'); await settled('importDialog');
  await client.evaluate(() => { document.getElementById('rosterText').value = Array.from({ length: 47 }, (_, i) => (i + 1) + ',同学' + (i + 1)).join('\n'); document.getElementById('previewImportBtn').click(); });
  check('已有名单导入默认保留统计且使用自绘矩形开关', await client.evaluate(() => { const e = document.getElementById('importResetInput'), s = getComputedStyle(e); return !document.getElementById('importPreviewSection').hidden && !e.checked && s.appearance === 'none' && e.getBoundingClientRect().width > e.getBoundingClientRect().height * 1.35; }));
  await click('applyImportBtn'); await settled('importDialog', false);
  const imported = await client.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return { round: s.round, lastId: s.lastId, history: s.history, fairnessStats: s.fairnessStats }; }, KEY);
  lastLabel = '取消新名单重置开关后导入仍保留抽中记录与长期权重';
  assert.deepEqual(imported, { round: fixture.round, lastId: fixture.lastId, history: fixture.history, fairnessStats: fixture.fairnessStats });
  check(lastLabel, true);
  await selectClick('[data-import]'); await settled('importDialog');
  await client.evaluate(() => { document.getElementById('rosterText').value = Array.from({ length: 47 }, (_, i) => (i + 1) + ',同学' + (i + 1)).join('\n'); document.getElementById('previewImportBtn').click(); });
  await checkbox('importResetInput');
  const beforeRebuildCancel = await client.evaluate(key => localStorage.getItem(key), KEY);
  await click('applyImportBtn'); await settled('confirmDialog');
  check('重建名单确认位于导入之上且拥有独立可访问通知区域', await client.evaluate(() => { const d = DialogTransitions.topModal(), h = d.querySelector('[data-toast-host]'); return d.id === 'confirmDialog' && d.matches(':modal') && !!h && (h.getAttribute('aria-live') === 'polite' || h.getAttribute('role') === 'status') && document.getElementById('importDialog').open; }));
  await escape(); await settled('confirmDialog', false);
  check('取消重建完全保留名单、当前记录与长期统计', await client.evaluate((key, before) => localStorage.getItem(key) === before && document.getElementById('importDialog').open, KEY, beforeRebuildCancel));
  await click('applyImportBtn'); await settled('confirmDialog'); await click('confirmActionBtn'); await settled('confirmDialog', false); await settled('importDialog', false);
  check('明确确认重建后清空当前记录及长期统计', await client.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return s.students.length === 47 && s.round === 0 && s.history.length === 0 && Object.values(s.fairnessStats).every(stats => stats.draws === 0); }, KEY));

  await selectClick('[data-import]'); await settled('importDialog'); await click('providerSettingsBtn'); await settled('providerDialog');
  check('提供商弹窗参与统一控制器，三级嵌套均保留 modal', await client.evaluate(() => ['configDialog', 'importDialog', 'providerDialog'].every(id => { const d = document.getElementById(id); return d.open && d.matches(':modal'); })));
  await clearTrace(); await escape(true); await settled('providerDialog', false);
  motionChecks('Escape 提供商退场', await motion('providerDialog', 'exit'));
  check('Escape 只关闭最上层、长按 repeat 不关闭下一层，并恢复提供商按钮焦点', await client.evaluate(() => document.getElementById('importDialog').open && document.getElementById('configDialog').open && document.activeElement.id === 'providerSettingsBtn'));
  await close('importDialog');

  // Verify that a closing modal retains its barrier against direct activation and
  // Space presses until the final frame, rather than just checking CSS opacity.
  await clearTrace();
  const blocked = await client.evaluate(async key => {
    const d = document.getElementById('configDialog'), before = localStorage.getItem(key), p = DialogTransitions.close(d);
    await new Promise(resolve => setTimeout(resolve, 25));
    const during = { open: d.open, modal: d.matches(':modal'), phase: d.dataset.motion };
    const button = document.getElementById('drawBtn'); button.click();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
    await p; await new Promise(resolve => setTimeout(resolve, 120));
    return { during, unchanged: before === localStorage.getItem(key), busy: button.getAttribute('aria-busy'), closed: !d.open };
  }, KEY);
  motionChecks('主页配置退场', await motion('configDialog', 'exit'));
  check('关闭过程中保持 modal 屏障，点击/空格不能误触底层抽人', blocked.during.open && blocked.during.modal && blocked.during.phase === 'exit' && blocked.unchanged && blocked.busy === 'false' && blocked.closed);
  check('配置完整关闭后清理所有临时动画并归还焦点', await cleaned('configDialog') && await client.evaluate(() => document.activeElement.id === 'drawBtn'));

  // Interrupt in the same renderer task to avoid CDP transport latency hiding
  // the beginning of a short transition.
  await clearTrace();
  const interrupted = await client.evaluate(async () => {
    const d = document.getElementById('classDialog'), opener = document.getElementById('classBtn');
    await DialogTransitions.open(document.getElementById('configDialog')); document.querySelector('.navigation [data-nav="roster"]').click(); await new Promise(resolve => setTimeout(resolve, 0)); opener.focus();
    const entering = DialogTransitions.open(d); await new Promise(resolve => setTimeout(resolve, 60));
    const s = getComputedStyle(d), bm = new DOMMatrix(s.transform), before = bm.m43 / bm.m44, beforeOpacity = Number(s.opacity), br = d.getBoundingClientRect();
    const exiting = DialogTransitions.close(d), next = getComputedStyle(d), am = new DOMMatrix(next.transform), after = am.m43 / am.m44, afterOpacity = Number(next.opacity), ar = d.getBoundingClientRect();
    await Promise.all([entering, exiting]);
    return { before, after, beforeOpacity, afterOpacity, rectError: Math.max(Math.abs(br.x - ar.x), Math.abs(br.y - ar.y), Math.abs(br.width - ar.width), Math.abs(br.height - ar.height)), closed: !d.open, phase: d.dataset.motion || '', animations: d.getAnimations().filter(a => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation)).length };
  });
  console.log('Interrupted enter sample: ' + JSON.stringify(interrupted));
  check('入场被关闭打断时从当前 Z 深度/透明度连续退出', interrupted.before < -1 && Math.abs(interrupted.before - interrupted.after) < 2 && interrupted.rectError < .5 && Math.abs(interrupted.beforeOpacity - interrupted.afterOpacity) < .05 && interrupted.closed && !interrupted.phase && interrupted.animations === 0);
  const reversed = await client.evaluate(async () => {
    const d = document.getElementById('classDialog'); await DialogTransitions.open(d);
    const exiting = DialogTransitions.close(d); await new Promise(resolve => setTimeout(resolve, 60));
    const bm = new DOMMatrix(getComputedStyle(d).transform), before = bm.m43 / bm.m44, br = d.getBoundingClientRect(), entering = DialogTransitions.open(d), am = new DOMMatrix(getComputedStyle(d).transform), after = am.m43 / am.m44, ar = d.getBoundingClientRect();
    await Promise.all([exiting, entering]);
    return { before, after, rectError: Math.max(Math.abs(br.x - ar.x), Math.abs(br.y - ar.y), Math.abs(br.width - ar.width), Math.abs(br.height - ar.height)), open: d.open, modal: d.matches(':modal'), phase: d.dataset.motion || '' };
  });
  console.log('Interrupted exit sample: ' + JSON.stringify(reversed));
  check('退场被重新打开打断时连续反向浮入，不被旧关闭回调移除', Math.abs(reversed.before - reversed.after) < 2 && reversed.rectError < .5 && reversed.open && reversed.modal && !reversed.phase);
  await close('classDialog');

  // A small dialog supplies a real backdrop outside its bounding rectangle.
  await click('classBtn'); await settled('classDialog'); await clearTrace();
  const outside = await client.evaluate(() => { const r = document.getElementById('classDialog').getBoundingClientRect(); return { x: Math.max(2, r.left / 2), y: Math.max(2, r.top / 2) }; });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...outside, button: 'left', buttons: 1, clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...outside, button: 'left', buttons: 0, clickCount: 1 });
  await settled('classDialog', false);
  check('点击真实 backdrop 触发浮出，保留外层配置', (await motion('classDialog', 'exit')).length >= 3 && await client.evaluate(() => document.getElementById('configDialog').open));

  for (const [width, height, scale] of [[320, 700, 1], [768, 432, 2.5]]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: width === 320 });
    await pause(400); await click('settingsBtn'); await settled('settingsDialog');
    const layout = await client.evaluate(() => {
      const d = document.getElementById('settingsDialog'), r = d.getBoundingClientRect(), s = getComputedStyle(d), e = document.getElementById('voiceInput'), es = getComputedStyle(e);
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, client: d.clientWidth, scroll: d.scrollWidth, radius: s.borderRadius, background: s.backgroundColor, switchRadius: es.borderRadius, pageFits: document.documentElement.scrollWidth <= innerWidth + 1, fieldsFit: Array.from(d.querySelectorAll('input,select,button')).filter(el => el.getClientRects().length).every(el => { const b = el.getBoundingClientRect(); return b.left >= -.5 && b.right <= innerWidth + .5; }) };
    });
    check(width + '×' + height + '@' + scale + ' 配置与矩形开关无水平溢出且弹窗完全在 viewport 内', layout.x >= -.5 && layout.y >= -.5 && layout.right <= width + .5 && layout.bottom <= height + .5 && layout.scroll <= layout.client + 1 && layout.pageFits && layout.fieldsFit && layout.radius === '0px' && layout.switchRadius === '0px' && layout.background === 'rgb(255, 255, 255)');
    await client.evaluate(() => document.getElementById('voiceInput').scrollIntoView({ block: 'center' }));
    await picture('ui-switch-dialog-' + width + 'x' + height + '.png'); await close('settingsDialog');
  }
  await client.send('Emulation.clearDeviceMetricsOverride'); await close('configDialog');
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const reduced = await client.evaluate(async () => {
    const d = document.getElementById('configDialog'), started = performance.now(); await DialogTransitions.open(d);
    const enterMs = performance.now() - started, open = d.open, entering = d.dataset.motion || '', enterAnimations = d.getAnimations().filter(a => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation)).length;
    const closing = performance.now(); await DialogTransitions.close(d);
    return { enterMs, closeMs: performance.now() - closing, open, entering, enterAnimations, closed: !d.open, exiting: d.dataset.motion || '', animations: d.getAnimations().length };
  });
  check('减少动态效果直接开关弹窗并清理动画状态', reduced.open && reduced.closed && reduced.enterMs < 80 && reduced.closeMs < 80 && !reduced.entering && !reduced.exiting && reduced.enterAnimations === 0 && reduced.animations === 0);
  check('本轮 UI 浏览器检查没有未处理 JavaScript 异常', client.errors.length === 0);
  const report = { artifactBytes: artifact.length, artifactSha256, completedAt: new Date().toISOString(), checks, runtimeErrors: client.errors, screenshots };
  await writeFile(path.join(output, 'ui-report.json'), JSON.stringify(report, null, 2));
  console.log('UI browser QA complete: ' + checks.length + ' checks');
} catch (error) {
  let diagnostic;
  try { diagnostic = await client?.evaluate(() => ({ open: Array.from(document.querySelectorAll('dialog')).map(d => ({ id: d.id, open: d.open, motion: d.dataset.motion || '', style: d.getAttribute('style'), focus: document.activeElement.id })), events: window.__uiMotionEvents?.slice(-30), frames: window.__uiMotionFrames?.slice(-12) })); } catch (_) {}
  await writeFile(path.join(output, 'ui-partial-report.json'), JSON.stringify({ artifactBytes: artifact.length, artifactSha256, failedAfter: lastLabel, error: error.stack, checks, runtimeErrors: client?.errors || [], diagnostic, screenshots }, null, 2));
  throw error;
} finally {
  if (client) { try { await client.send('Browser.close'); } catch (_) {} client.ws.close(); }
  if (browser && !browser.killed) browser.kill();
  await pause(500); const resolved = await realpath(profile).catch(() => null);
  if (resolved && path.dirname(resolved) === parent && path.basename(resolved).startsWith('rollcall-ui-')) await rm(resolved, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
