import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// Run against the complete offline artifact. All students and clocks below
// are local fixtures; the suite never connects to model endpoints.
const root = fileURLToPath(new URL('../../', import.meta.url)), output = path.join(root, 'qa-output');
const KEY = 'rollcall-studio:v1', checks = [], screenshots = [], pause = ms => new Promise(r => setTimeout(r, ms));
const artifact = await readFile(path.join(root, 'dist/index.html'));
const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
await mkdir(output, { recursive: true });
const parent = await realpath(tmpdir()), profile = await mkdtemp(path.join(parent, 'rollcall-render-'));
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
async function waitFor(fn, ms = 12000) {
  const start = Date.now();
  while (Date.now() - start < ms) { try { if (await fn()) return; } catch (_) {} await pause(50); }
  throw new Error('condition timed out at ' + lastLabel);
}
function check(label, value) { lastLabel = label; assert.ok(value, label); checks.push(label); console.log('PASS ' + label); }
async function click(id) { await client.evaluate(async id => { const e = document.getElementById(id); if (!e) throw Error('Missing ' + id); const view = e.closest('section.view[hidden]'); if (view) { document.querySelector('.navigation [data-nav="' + view.id.replace('view-', '') + '"]').click(); await new Promise(resolve => setTimeout(resolve, 0)); } e.click(); await new Promise(resolve => setTimeout(resolve, 0)); }, id); }
async function selectClick(selector) { await client.evaluate(async selector => { const e = document.querySelector(selector); if (!e) throw Error('Missing ' + selector); const view = e.closest('section.view[hidden]'); if (view) { document.querySelector('.navigation [data-nav="' + view.id.replace('view-', '') + '"]').click(); await new Promise(resolve => setTimeout(resolve, 0)); } e.click(); await new Promise(resolve => setTimeout(resolve, 0)); }, selector); }
async function settled(id, open = true) { await waitFor(() => client.evaluate((id, open) => { const d = document.getElementById(id); return d.open === open && !d.dataset.motion; }, id, open), 4000); }
async function closeConfig() { await client.evaluate(() => DialogTransitions.close(document.getElementById('configDialog'))); await settled('configDialog', false); }
async function openConfig() {
  await client.evaluate(async () => {
    document.activeElement?.blur();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
    await new Promise(r => setTimeout(r, 550));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
  });
  await settled('configDialog');
}
async function state() { return client.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY); }
async function reload(s) {
  if (s) { s.demo = false; s.settings.theme = 'classic'; s.settings.radius = 0; }
  await client.evaluate((key, s) => { if (s) localStorage.setItem(key, JSON.stringify(s)); window.__renderOldPage = true; }, KEY, s);
  await client.send('Page.reload');
  await waitFor(() => client.evaluate(() => !window.__renderOldPage && document.getElementById('renderStylePicker') && document.querySelectorAll('[data-mode-row]').length === 5));
  // Chromium preserves the focused element across a reload. Clear the prior
  // dialog's restored draw-button focus before measuring the default collapsed
  // state; focus expansion and Z depth are exercised separately below.
  await client.evaluate(() => document.activeElement?.blur());
  await pause(360);
}
async function finished() { await waitFor(() => client.evaluate(() => document.getElementById('drawBtn').getAttribute('aria-busy') === 'false' && !document.getElementById('renderStylePicker').disabled && !document.querySelector('main').classList.contains('is-lifecycle')), 30000); await pause(120); }
async function setStyle(style) {
  if(await client.evaluate(style=>document.querySelector('main').dataset.renderStyle!==style,style))await click('renderStylePicker');
  await waitFor(() => client.evaluate(style => document.querySelector('main').dataset.renderStyle === style, style));
  await waitFor(() => client.evaluate(() => document.getElementById('drawBtn').getAttribute('aria-busy') === 'false' && !document.getElementById('liveSeatScroll').dataset.transition && !document.querySelector('main').classList.contains('is-lifecycle')));
  await pause(350);
}
async function picker() {
  return client.evaluate(key=>{
    const p=document.getElementById('renderStylePicker'),r=p.getBoundingClientRect();
    return {pressed:p.getAttribute('aria-pressed')==='true',disabled:p.disabled,selected:p.dataset.selectedStyle,actual:document.querySelector('main').dataset.renderStyle,persisted:JSON.parse(localStorage.getItem(key)).settings.renderStyle,width:r.width,height:r.height,left:r.left,top:r.top,right:r.right,bottom:r.bottom};
  },KEY);
}
async function tapOverview() {
  const p=await picker(),point={x:p.left+p.width/2,y:p.top+p.height/2,id:1};
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
  await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await waitFor(()=>client.evaluate(before=>document.querySelector('main').dataset.renderStyle!==before,p.actual));
}
async function pressToggle(key,code,windowsVirtualKeyCode){
  const before=(await picker()).actual;
  await client.evaluate(()=>document.getElementById('renderStylePicker').focus());
  // Native button activation on Enter requires Chromium's character event too.
  await client.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode,text:key==='Enter'?'\r':key,unmodifiedText:key==='Enter'?'\r':key});
  await client.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode});
  await waitFor(()=>client.evaluate(before=>document.querySelector('main').dataset.renderStyle!==before,before));
  await finished();
}
async function metrics(width, height, mobile = false) {
  await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: width === 768 ? 2.5 : 1, mobile });
  await waitFor(() => client.evaluate((w, h) => innerWidth === w && innerHeight === h, width, height));
  await pause(450);
}
async function fixture(style = 'normal', mode = 'normal', { initial = false, allSeen = false } = {}) {
  return client.evaluate(({ style, mode, initial, allSeen }) => {
    const students = Array.from({ length: 47 }, (_, i) => ({ id: String(i + 1), name: '同学' + String(i + 1).padStart(2, '0'), row: Math.floor(i / 8) + 1, col: i % 8 + 1, active: true, friendTargets: i === 18 ? ['1', '8', '47'] : [] }));
    let s = DrawCore.createState(students, 123);
    if (!initial) {
      for (let seed = 1; seed < 10000; seed++) {
        s = DrawCore.createState(students, seed);
        s.settings = DrawCore.settings({ strategy: 'manual', manualMode: 'normal', friendEnabled: false, endJumpChance: 0 });
        if (DrawCore.draw(s, new Date('2026-10-13T10:20:30')).studentId === '19') break;
      }
      if (s.lastId !== '19') throw Error('Cannot seed source 19');
    }
    s.settings = DrawCore.settings({ strategy: 'manual', manualMode: mode === 'friend' ? 'normal' : mode, renderStyle: style, friendEnabled: mode === 'friend', friendChance: mode === 'friend' ? 100 : 0, endJumpChance: 0, direction: 'auto', directionMin: 3, directionMax: 3, directionCooldownMin: 0, directionCooldownMax: 0, timeSource: 'time', timeSelection: 'fixed', positions: '5,6' });
    if (mode === 'direction' && !initial) s.lock = { remaining: 2, direction: 'right' };
    if (allSeen) s.cycleSeen = s.students.map(p => p.id);
    s.demo = false;
    return s;
  }, { style, mode, initial, allSeen });
}
async function installClock() {
  await client.evaluate(() => {
    const NativeDate = Date, base = new NativeDate('2026-10-13T10:20:31').getTime(), start = performance.now();
    class LiveDate extends NativeDate { constructor(...args) { super(...(args.length ? args : [base + performance.now() - start])); } static now() { return base + performance.now() - start; } }
    window.Date = LiveDate;
  });
}
async function trace() {
  await client.evaluate(() => {
    window.__renderFrames=[];window.__renderTraceStop=false;
    const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    let last=-Infinity;
    const capture=()=>{
      if(window.__renderTraceStop)return;
      const now=performance.now(),screen=document.querySelector('main'),viewport=document.getElementById('liveSeatScroll');
      if(now-last>28&&(document.getElementById('drawBtn').getAttribute('aria-busy')==='true'||viewport.dataset.transition)){
        last=now;
        window.__renderFrames.push({at:now,style:screen.dataset.renderStyle,animation:screen.dataset.animation||'',lifecycle:screen.classList.contains('is-lifecycle'),seatTransition:viewport.dataset.transition||'',arrowSpinning:document.getElementById('seatArrow').classList.contains('spinning-arrow'),classes:Array.from(screen.classList),busy:document.getElementById('drawBtn').getAttribute('aria-busy')==='true',w:innerWidth,h:innerHeight,transform:getComputedStyle(document.getElementById('liveSeatMap')).transform,focus:viewport.dataset.focusStudent||'',group:viewport.dataset.focusGroup||'',friendPhase:screen.dataset.friendPhase||'',emoji:document.querySelector('[data-friend-emoji]')?.textContent.trim()||'',digits:document.getElementById('timeDigits').textContent.replace(/\D/g,''),seats:Array.from(document.querySelectorAll('#liveSeats [data-live-student]')).map(el=>{const c=getComputedStyle(el),m=new DOMMatrix(c.transform);return {id:el.dataset.liveStudent,classes:Array.from(el.classList),opacity:Number(c.opacity),color:c.backgroundColor,z:m.m43/m.m44,...rect(el)};})});
      }
      requestAnimationFrame(capture);
    };
    requestAnimationFrame(capture);
  });
}
async function frames() { return client.evaluate(() => { window.__renderTraceStop = true; return window.__renderFrames; }); }
async function drawFrames() { await trace(); await click('drawBtn'); await finished(); return frames(); }
function allSeatsFit(f) { return f.seats.length === 47 && f.seats.every(s => s.left >= -1 && s.right <= f.w + 1 && s.top >= -1 && s.bottom <= f.h + 1); }
function sameCamera(fs) { return fs.length > 3 && new Set(fs.map(f => f.transform)).size === 1 && fs.every(f => !f.focus && !f.group); }
function lifecycleUsesZ(fs, phase) {
  return fs.some(f => f.seatTransition === phase && f.seats.some(s => Math.abs(s.z) > 10)) && fs.some(f => f.seatTransition === phase && f.seats.some(s => { const color = s.color.match(/[\d.]+/g)?.map(Number); return color && color.slice(0, 3).every(v => v >= 235) && s.opacity > .2; }));
}
async function view() {
  return client.evaluate(() => {
    const r = e => { const a = e.getBoundingClientRect(); return { left: a.left, right: a.right, top: a.top, bottom: a.bottom, width: a.width, height: a.height, cssHeight: parseFloat(getComputedStyle(e).height) }; };
    return { w: innerWidth, h: innerHeight, style: document.querySelector('main').dataset.renderStyle, picker: r(document.getElementById('renderStylePicker')), draw: r(document.getElementById('drawBtn')), reset: r(document.getElementById('resetDrawBtn')), seats: Array.from(document.querySelectorAll('#liveSeats [data-live-student]')).map(e => ({ id: e.dataset.liveStudent, ...r(e) })) };
  });
}
async function screenshot(name) {
  const r = await client.send('Page.captureScreenshot', { format: 'png' }), bytes = Buffer.from(r.data, 'base64');
  await writeFile(path.join(output, name), bytes); if (!screenshots.includes(name)) screenshots.push(name); return bytes;
}

try {
  browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--headless=new', '--disable-gpu', '--blink-settings=primaryHoverType=2,availableHoverTypes=2', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-proxy-server', '--remote-debugging-port=0', '--window-size=1000,800', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let port;
  await waitFor(async () => { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return port > 0; }, 20000);
  const target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(t => t.type === 'page'), socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  client = new CDP(socket); await client.send('Page.enable'); await client.send('Runtime.enable');
  await client.send('Page.navigate', { url: pathToFileURL(path.join(root, 'dist/index.html')).href });
  await waitFor(() => client.evaluate(() => document.getElementById('renderStylePicker')?.tagName==='BUTTON'));
  await metrics(768, 432);
  await reload(await fixture('normal', 'normal', { initial: true }));
  check('Overview uses one native touch-sized toggle with icon and aria-pressed feedback',await client.evaluate(()=>{
    const p=document.getElementById('renderStylePicker'),r=p.getBoundingClientRect();
    return p.tagName==='BUTTON'&&p.type==='button'&&p.getAttribute('aria-pressed')==='false'&&p.getAttribute('aria-label').includes('全览')&&p.querySelector('.material-icon')?.textContent==='grid_view'&&p.textContent.includes('全览')&&!p.querySelector('input')&&r.width>=r.height&&r.height>=44&&r.right<=innerWidth&&r.bottom<=innerHeight&&r.left>innerWidth/2;
  }));
  let p=await picker();const initialToggleWidth=p.width;
  await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.left+p.width/2,y:p.top+p.height/2});await pause(300);
  p=await picker();
  check('Hover does not expand a menu or change the saved rendering mode',!p.pressed&&p.width<initialToggleWidth+8&&p.persisted==='normal'&&await client.evaluate(()=>!document.querySelector('.render-style-option,.render-style-thumb')));
  await trace();await tapOverview();await finished();const styleEntry=await frames();p=await picker();
  check('Touch tap enables overview exactly once without drawing a student',p.pressed&&p.persisted==='overview'&&(await state()).round===0);
  check('Overview toggle preserves the existing white Z entry and all 47 seats',lifecycleUsesZ(styleEntry,'enter')&&await client.evaluate(()=>!document.getElementById('liveBoard').hidden&&!document.getElementById('resetDrawBtn').hidden&&document.querySelectorAll('#liveSeats [data-live-student]').length===47));
  await trace();await pressToggle('Enter','Enter',13);const keyboardExit=await frames();
  check('Enter toggles back to normal with the Z exit and never opens settings',!(await picker()).pressed&&lifecycleUsesZ(keyboardExit,'exit')&&(await state()).round===0&&await client.evaluate(()=>document.getElementById('liveBoard').hidden&&!document.querySelector('dialog[open]')));
  await pressToggle(' ','Space',32);
  check('Focused overview button uses native Space activation without triggering draw or long-press settings',(await picker()).pressed&&(await state()).round===0&&await client.evaluate(()=>!document.querySelector('dialog[open]')));
  const beforeEmptyReset = await state(); await trace();
  await client.evaluate(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', key: 'r', bubbles: true })); await new Promise(r => setTimeout(r, 550)); document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR', key: 'r', bubbles: true })); }); await finished();
  const resetEmptyFrames = await frames();
  check('全览空记录重置仍播放白色Z退场再入场，座位常驻且次数、随机种子和公平统计不变', lifecycleUsesZ(resetEmptyFrames, 'exit') && lifecycleUsesZ(resetEmptyFrames, 'enter') && JSON.stringify(await state()) === JSON.stringify(beforeEmptyReset) && await client.evaluate(() => !document.getElementById('liveBoard').hidden));
  p=await picker();const cancelPoint={x:p.left+p.width/2,y:p.top+p.height/2,id:1};
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[cancelPoint]});
  await client.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await pause(250);
  check('Cancelling a touch does not toggle overview or change statistics',(await picker()).pressed&&(await state()).round===0);
  await trace(); await setStyle('normal'); const exitHome = await frames();
  check('全览无历史切回普通先播放白色Z退场，结束回到仅抽选按钮的初始主页', lifecycleUsesZ(exitHome, 'exit') && await client.evaluate(() => document.getElementById('liveBoard').hidden && document.getElementById('resetDrawBtn').hidden && !document.querySelector('main').classList.contains('has-result')) && (await state()).round === 0);
  await trace(); await setStyle('overview'); const entryAgain = await frames(); await trace(); await setStyle('normal'); const exitNormalHome = await frames();
  check('初始模式重新进入全览再切普通同样执行Z入退场，不创建历史或留下座位动画类', lifecycleUsesZ(entryAgain, 'enter') && lifecycleUsesZ(exitNormalHome, 'exit') && (await state()).round === 0 && await client.evaluate(() => document.getElementById('liveBoard').hidden && !document.querySelector('.seat-transition-running')));
  await setStyle('overview');
  await reload();
  check('刷新恢复无历史全览风格和常驻座位，切换按钮状态与实际渲染一致', await client.evaluate(() => document.querySelector('main').dataset.renderStyle === 'overview' && document.getElementById('renderStylePicker').getAttribute('aria-pressed')==='true' && !document.getElementById('liveBoard').hidden));
  const backup = await fixture('normal');backup.settings.renderStyle='cinema'; await openConfig(); await selectClick('[data-nav="data"]');
  await client.evaluate(s => { const d = new DataTransfer(); d.items.add(new File([JSON.stringify(s)], 'render-style-backup.json', { type: 'application/json' })); const e = document.getElementById('backupFile'); e.files = d.files; e.dispatchEvent(new Event('change', { bubbles: true })); }, backup);
  await settled('confirmDialog'); await click('confirmActionBtn'); await settled('confirmDialog', false); await waitFor(() => client.evaluate(() => document.getElementById('drawBtn').getAttribute('aria-busy') === 'false')); await closeConfig();
  check('旧电影备份通过实际恢复流程转为普通视图，右下选项与班级记录正确恢复', (await state()).settings.renderStyle === 'normal' && (await state()).round === backup.round && await client.evaluate(() => document.getElementById('renderStylePicker').getAttribute('aria-pressed')==='false' && document.querySelector('main').dataset.renderStyle === 'normal'));
  check('损坏或旧版备份的风格字段安全归一化为普通模式', await client.evaluate(() => DrawCore.settings({ renderStyle: 'unknown' }).renderStyle === 'normal' && DrawCore.settings({}).renderStyle === 'normal'));

  await reload(await fixture('overview'));
  let v = await view();
  check('全览将重置和抽人置于左下，默认折叠为同高正方形图标按钮', v.draw.left < v.w / 3 && v.reset.left < v.w / 3 && v.draw.top > v.h / 2 && v.reset.top > v.h / 2 && Math.abs(v.draw.height - v.reset.height) < .6 && Math.abs(v.draw.width - v.draw.height) < 1 && Math.abs(v.reset.width - v.reset.height) < 1);
  check('768×432 全览完整显示 8×6−1 共47个实际座位，没有横向页面溢出', allSeatsFit({ ...v, seats: v.seats }) && await client.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const beforeHover = v.draw, hoverPoint = { x: v.draw.left + v.draw.width / 2, y: v.draw.top + v.draw.height / 2 };
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hoverPoint }); await pause(380);
  v = await view();
  check('全览悬浮抽选键横向展开名称，并保持原高度和左下位置', v.draw.width > beforeHover.width + 20 && Math.abs(v.draw.cssHeight - beforeHover.cssHeight) < .6 && await client.evaluate(() => { const e = document.getElementById('drawButtonText'), s = getComputedStyle(e); return e.getBoundingClientRect().width > 15 && Number(s.opacity) > .9; }));
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 20 }); await pause(380);
  const held = await client.evaluate(async key => {
    document.activeElement?.blur(); const b = document.getElementById('drawBtn'), initial = b.getBoundingClientRect(), before = localStorage.getItem(key);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
    await new Promise(r => setTimeout(r, 280));
    const q = b.getBoundingClientRect(), s = getComputedStyle(b, '::before'), progress = s.transform === 'none' ? 0 : new DOMMatrix(s.transform).a;
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
    await new Promise(r => setTimeout(r, 450));
    return { expanded: q.width > initial.width + 20, sameHeight: Math.abs(q.height - initial.height) < 1, progress, unchanged: before === localStorage.getItem(key), noDraw: b.getAttribute('aria-busy') === 'false', noDialog: !document.querySelector('dialog[open]') };
  }, KEY);
  check('全览按住时横向展开进度条，200～500 ms 松手撤回且不抽人', held.expanded && held.sameHeight && held.progress > .1 && held.progress < 1 && held.unchanged && held.noDraw && held.noDialog);
  await openConfig();
  check('全览空格长按500 ms仍打开配置并保留当前抽取记录', (await state()).round === 1 && await client.evaluate(() => document.getElementById('configDialog').open)); await closeConfig();
  const cancelReset = await client.evaluate(async key => {
    document.activeElement?.blur(); const b = document.getElementById('resetDrawBtn'), before = localStorage.getItem(key), initial = b.getBoundingClientRect();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', key: 'r', bubbles: true })); await new Promise(r => setTimeout(r, 280));
    const q = b.getBoundingClientRect(), s = getComputedStyle(b, '::before'), color = s.backgroundColor;
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR', key: 'r', bubbles: true })); await new Promise(r => setTimeout(r, 450));
    return q.width > initial.width + 20 && Math.abs(q.height - initial.height) < 1 && /201, 56, 56|201,56,56|c93838/i.test(color) && before === localStorage.getItem(key) && !b.hasAttribute('data-reset-holding');
  }, KEY);
  check('全览R键重置按住横向伸长且使用红色进度，未满500 ms取消保留统计', cancelReset);
  await trace();
  await client.evaluate(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', key: 'r', bubbles: true })); await new Promise(r => setTimeout(r, 550)); document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR', key: 'r', bubbles: true })); }); await finished();
  const resetOverviewFrames = await frames();
  check('全览R键完整长按播放退场再入场并常驻全班，风格和长期公平统计保留', (await state()).round === 0 && (await state()).settings.renderStyle === 'overview' && Object.values((await state()).fairnessStats).some(s => s.draws > 0) && lifecycleUsesZ(resetOverviewFrames, 'exit') && lifecycleUsesZ(resetOverviewFrames, 'enter') && await client.evaluate(() => !document.getElementById('liveBoard').hidden));
  await reload(await fixture('overview'));
  await trace();
  await client.evaluate(async () => { document.activeElement?.blur(); document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true })); await new Promise(r => setTimeout(r, 40)); document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true })); });
  // Short keyboard release is intentionally debounced before startDraw. Wait
  // for that draw to begin, rather than mistaking the pre-draw idle for its end.
  await waitFor(() => client.evaluate(() => document.getElementById('drawBtn').getAttribute('aria-busy') === 'true'));
  await finished();
  let fs = await frames();
  check('全览小于200 ms空格短按只完成一次抽取，普通乱序高亮时摄像机始终显示全班', (await state()).round === 2 && fs.filter(f => f.animation === 'normal').length > 5 && fs.filter(f => f.animation === 'normal').every(allSeatsFit) && sameCamera(fs.filter(f => f.animation === 'normal')));
  await reload(await fixture('overview', 'direction')); fs = await drawFrames();
  const spins = fs.filter(f => f.animation === 'direction' && f.classes.includes('is-animating'));
  check('全览连坐旋转箭头期间不缩放追焦，47个座位始终完整处于视口', spins.length > 8 && spins.every(allSeatsFit) && sameCamera(spins));
  check('全览连坐不淡出九宫格外的未抽座位，仍保留已抽及暂停状态', spins.some(f => f.seats.filter(s => !s.classes.includes('in-neighborhood') && !s.classes.includes('seen') && !s.classes.includes('current')).every(s => s.opacity > .8)));
  await screenshot('render-overview-landscape.png');
  await reload(await fixture('overview', 'friend')); fs = await drawFrames();
  check('全览友尽表情过场保留全班框景，源及目标阶段不改为追焦镜头', fs.some(f => f.friendPhase === 'thinking' && f.emoji === '🤔') && fs.some(f => f.friendPhase === 'result' && f.emoji === '😭') && sameCamera(fs.filter(f => f.friendPhase)) && fs.filter(f => f.friendPhase).every(allSeatsFit));
  await metrics(320, 780, true); await reload(await fixture('overview', 'direction')); fs = await drawFrames(); v = await view();
  check('320px触屏全览及连坐箭头完整容纳47座位，左下动作与右下全览按钮互不遮挡', fs.filter(f => f.animation === 'direction').length > 8 && fs.filter(f => f.animation === 'direction').every(allSeatsFit) && allSeatsFit(v) && (v.draw.right <= v.picker.left + 1 || v.draw.top >= v.picker.bottom - 1 || v.draw.bottom <= v.picker.top + 1) && v.reset.bottom <= v.h && v.picker.right <= v.w + 1);
  await screenshot('render-overview-phone.png');

  await metrics(768, 432); await reload(await fixture('normal'));
  const normalRun = await drawFrames();
  check('Normal rendering shuffles highlights, follows focus and commits one draw',normalRun.filter(f=>f.animation==='normal').length>8&&new Set(normalRun.filter(f=>f.focus).map(f=>f.focus)).size>3&&(await state()).round===2);
  for(const retired of ['cinema','cinematic']){
    const legacy=await fixture('normal');legacy.settings.renderStyle=retired;
    const expected=await client.evaluate(s=>{const c=DrawCore.restoreState(s);return {rng:c.rngState,counts:c.counts,fairness:c.fairnessStats,history:c.history};},legacy);
    await reload(legacy);
    check('Retired '+retired+' stored style opens as normal',await client.evaluate(()=>document.querySelector('main').dataset.renderStyle==='normal'&&document.getElementById('renderStylePicker').getAttribute('aria-pressed')==='false'&&typeof window.CinematicEffects==='undefined'&&!document.querySelector('#cinemaMask,#cinemaCutStage,#cinemaFrameMotion')));
    const restored=await client.evaluate(key=>{const c=DrawCore.restoreState(JSON.parse(localStorage.getItem(key)));return {rng:c.rngState,counts:c.counts,fairness:c.fairnessStats,history:c.history};},KEY);
    check('Retired '+retired+' migration preserves fairness and PRNG',JSON.stringify(restored)===JSON.stringify(expected));
    await click('drawBtn');await finished();
    check('Retired '+retired+' style saves next draw as normal',(await state()).settings.renderStyle==='normal'&&(await state()).round===legacy.round+1);
  }
  await reload(await fixture('normal','time'));await installClock();fs=await drawFrames();
  check('Normal time selection keeps live seconds and a valid two-digit result',new Set(fs.filter(f=>f.animation==='time').map(f=>f.digits)).size>=2&&(await state()).history.at(-1).mode==='time');
  await client.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await reload(await fixture('normal','friend'));await click('drawBtn');await finished();
  check('Reduced motion still commits friendship draw',(await state()).history.at(-1).mode==='friend'&&await client.evaluate(()=>!document.getElementById('drawBtn').disabled&&!document.querySelector('main').classList.contains('is-animating')));
  await client.send('Emulation.setEmulatedMedia',{features:[]});
  check('普通与全览完整交互、旧电影数据兼容和动画检查没有浏览器运行错误', client.errors.length === 0);
  check('风格浏览器检查全过程使用同一份完整离线HTML构建', (await readFile(path.join(root, 'dist/index.html'))).equals(artifact));
  await writeFile(path.join(output, 'render-styles-report.json'), JSON.stringify({ completedAt: new Date().toISOString(), artifactBytes: artifact.length, artifactSha256, checks, runtimeErrors: client.errors, screenshots }, null, 2));
  console.log(JSON.stringify({ checkCount: checks.length, artifactBytes: artifact.length, screenshots }));
} catch (error) {
  if (client) { try { await screenshot('render-styles-failure.png'); } catch (_) {} }
  const diagnostic = client ? await client.evaluate(() => {
    return {state:JSON.parse(localStorage.getItem('rollcall-studio:v1')),picker:{pressed:document.getElementById('renderStylePicker').getAttribute('aria-pressed'),disabled:document.getElementById('renderStylePicker').disabled},frames:window.__renderFrames||[]};
  }).catch(() => null) : null;
  await writeFile(path.join(output, 'render-styles-partial-report.json'), JSON.stringify({ completedAt: new Date().toISOString(), artifactBytes: artifact.length, artifactSha256, checks, failedCheck: lastLabel, error: String(error), runtimeErrors: client?.errors || [], screenshots, diagnostic }, null, 2));
  throw error;
} finally {
  if (client) { try { await client.send('Browser.close'); } catch (_) {} client.ws.close(); }
  if (browser) { try { browser.kill(); } catch (_) {} }
  const absolute = await realpath(profile).catch(() => null);
  if (absolute && absolute.startsWith(parent + path.sep) && path.basename(absolute).startsWith('rollcall-render-')) { await pause(700); await rm(absolute, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
}
