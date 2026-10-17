import { createServer } from 'node:http';
import { createHash, createDecipheriv } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, realpath, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../', import.meta.url)), html = await readFile(path.join(root, 'dist/index.html'));
const artifactSha256 = createHash('sha256').update(html).digest('hex');
const output = path.join(root, 'qa-output'); await mkdir(output, { recursive: true });
const profileParent = await realpath(tmpdir()), profile = await mkdtemp(path.join(profileParent, 'rollcall-qa-'));
const KEY = 'rollcall-studio:v1', pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let visionRequests = 0, edge, cdp, server, edgeLog = '';
const checks = [];
function check(label, condition) { assert.ok(condition, label); checks.push(label); console.log('PASS ' + label); }
function decodeCompleteBackup(input) {
  const bytes = Buffer.from(input), magic = Buffer.from('SLATERANDOM-BK1\n');
  assert.deepEqual(bytes.subarray(0, 16), magic, 'Complete backup uses its binary format header');
  const decipher = createDecipheriv('aes-256-gcm', bytes.subarray(16, 48), bytes.subarray(48, 60));
  decipher.setAAD(magic); decipher.setAuthTag(bytes.subarray(60, 76));
  return JSON.parse(gunzipSync(Buffer.concat([decipher.update(bytes.subarray(76)), decipher.final()])).toString('utf8'));
}
function canonicalDrawState(state) {
  const result = structuredClone(state);
  // Missing counters and explicit zeros have identical engine semantics. Undo
  // retains zero keys when the undone draw was someone's first selection.
  for (const key of ['counts', 'lastSeen']) result[key] = Object.fromEntries(Object.entries(result[key]).filter(([, value]) => value !== 0));
  return result;
}
const screenshots = [];
const visionResult = { rows: 5, cols: 6, orientation: { podiumSideInImage: 'left', normalized: true }, students: [{ id: '01', name: '识别甲', row: 2, col: 2, sourceId: '2026080101' }, { id: '02', name: '识别乙', row: 2, col: 4, sourceId: '2026080102' }, { id: '03', name: '识别丙', row: 4, col: 2, sourceId: '2026080103' }, { id: '04', name: '识别丁', row: 4, col: 5, sourceId: '2026080104' }], uncertain: ['请核对姓名与推断学号'] };
class CDP {
  constructor(ws) { this.ws = ws; this.next = 0; this.pending = new Map(); this.errors = []; ws.addEventListener('message', event => { const m = JSON.parse(String(event.data)); if (m.id) { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); clearTimeout(p.timeout); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } } else if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.text + ': ' + (m.params.exceptionDetails.exception?.description || '')); }); ws.addEventListener('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timeout); p.reject(new Error('Browser debugging connection closed')); } this.pending.clear(); }); }
  send(method, params = {}) { const id = ++this.next; return new Promise((resolve, reject) => { const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error('Browser command timed out: ' + method)); }, 8000); this.pending.set(id, { resolve, reject, timeout }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(fn, ...args) { const result = await this.send('Runtime.evaluate', { expression: '(' + fn.toString() + ').apply(null,' + JSON.stringify(args) + ')', returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; }
}
async function waitFor(fn, timeout = 10000) { const start = Date.now(); while (Date.now() - start < timeout) { try { if (await fn()) return; } catch (_) {} await pause(100); } throw new Error('Browser condition timed out'); }
async function click(selector) { await cdp.evaluate(async selector => { const el = document.querySelector(selector); if (!el) throw new Error('Missing element: ' + selector); const view = el.closest('section.view[hidden]'); if (view) { document.querySelector('.navigation [data-nav="' + view.id.replace('view-', '') + '"]').click(); await new Promise(resolve => setTimeout(resolve, 0)); } el.click(); await new Promise(resolve => setTimeout(resolve, 0)); }, selector); await waitFor(() => cdp.evaluate(() => !document.querySelector('dialog[data-motion]')), 2000); }
async function buttonPoint() { return cdp.evaluate(() => { const r = document.getElementById('drawBtn').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }); }
async function mouse(type, point, extra = {}) { return cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra }); }
async function openConfig() { const p = await buttonPoint(); await mouse('mousePressed', p); await waitFor(() => cdp.evaluate(() => document.getElementById('configDialog').open), 5000); await mouse('mouseReleased', p); await waitFor(() => cdp.evaluate(() => !document.getElementById('configDialog').dataset.motion), 2000); }
async function closeConfig() { await click('#closeConfigBtn'); await waitFor(() => cdp.evaluate(() => !document.getElementById('configDialog').open && document.getElementById('drawBtn').getAttribute('aria-expanded') === 'false')); }
async function drawFinished() { await waitFor(() => cdp.evaluate(() => document.getElementById('drawBtn').getAttribute('aria-busy') === 'false' && !document.getElementById('drawBtn').hasAttribute('data-hold-releasing')), 10000); }
async function waitForScene(mode) { await waitFor(() => cdp.evaluate(mode => !document.getElementById('liveSeatScroll').dataset.transition && document.querySelector('.draw-screen').matches('.is-animating[data-animation="' + mode + '"]') && (mode === 'time' ? !document.getElementById('timeVisual').hidden : mode === 'normal' ? !!document.querySelector('#liveSeats .candidate') : document.getElementById('seatArrow').classList.contains('spinning-arrow')), mode), 4500); }
async function reloadStoredState(state, endJumpChance = 0) { if (typeof state !== 'string') { state.demo = false; state.settings.endJumpChance = endJumpChance; state.settings.theme = 'classic'; state.settings.radius = 0; } await cdp.evaluate((key, state) => { localStorage.setItem(key, typeof state === 'string' ? state : JSON.stringify(state)); window.__qaBeforeReload = true; }, KEY, state); await cdp.send('Page.reload'); await waitFor(() => cdp.evaluate(() => !window.__qaBeforeReload && document.getElementById('rosterSeats')?.children.length > 0)); await installLifecycleProbes(); }
async function installLifecycleProbes() {
  await cdp.evaluate((source, key) => {
    if (window.__qaLifecycle) return;
    window.__qaLifecycle = {};
    const snapshot = new Function('return (' + source + ')')(), original = SeatTransitions;
    const wrap = phase => (...args) => {
      const before = localStorage.getItem(key), promise = original[phase](...args), start = snapshot();
      document.getElementById('drawBtn').click(); start.repeatUnchanged = localStorage.getItem(key) === before; start.storedBefore = before;
      const trace = { start }; window.__qaLifecycle[phase] = trace;
      setTimeout(() => { trace.middle = snapshot(); }, phase === 'enter' ? 120 : 350);
      return promise;
    };
    window.SeatTransitions = { ...original, enter: wrap('enter'), exit: wrap('exit') };
  }, seatLifecycleSnapshot.toString(), KEY);
}
async function installDirectionFrameProbe() {
  await cdp.evaluate(key => {
    window.__qaDirectionTrace?.stop();
    const state = JSON.parse(localStorage.getItem(key)), svg = document.getElementById('seatArrow'), path = document.getElementById('seatArrowPath');
    const sectors = [[-1, 0, '上'], [-1, 1, '右上'], [0, 1, '右'], [1, 1, '右下'], [1, 0, '下'], [1, -1, '左下'], [0, -1, '左'], [-1, -1, '左上']];
    const green = value => { const channels = value.match(/[\d.]+/g)?.map(Number) || []; return channels.length >= 3 && channels[1] > channels[0] && channels[1] > channels[2]; };
    let frame = 0, deadline, resolve, initialized = false, started = false, hasCandidate = false, stopped = false;
    const trace = { frames: [], complete: false, done: new Promise(done => resolve = done) };
    const stop = complete => {
      if (stopped) return;
      stopped = true; cancelAnimationFrame(frame); clearTimeout(deadline); observer.disconnect(); trace.complete = complete === true; resolve();
    };
    trace.stop = stop; window.__qaDirectionTrace = trace;
    // The spinning class precedes the product's first pointAt() callback.
    // Begin after its first real SVG path update so a stale hidden path is not
    // mistaken for a rendered animation frame. Mismatches remain in the trace.
    const observer = new MutationObserver(() => { if (svg.classList.contains('spinning-arrow')) initialized = true; });
    observer.observe(path, { attributes: true, attributeFilter: ['d'] });
    const capture = now => {
      const anchor = document.querySelector('#liveSeats .anchor'), previous = state.students.find(student => student.id === anchor?.dataset.liveStudent);
      const coordinates = path.getAttribute('d')?.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
      if (!anchor || !previous || coordinates?.length !== 4) { trace.frames.push({ at: now, matches: false, green: false, error: 'Missing initialized direction geometry' }); return; }
      const layout = getComputedStyle(document.getElementById('liveSeats')), gx = parseFloat(layout.columnGap) || 0, gy = parseFloat(layout.rowGap) || 0;
      const cx = anchor.offsetLeft + anchor.offsetWidth / 2, cy = anchor.offsetTop + anchor.offsetHeight / 2;
      const dx = (coordinates[2] - cx) / (anchor.offsetWidth / 2 + gx - 2), dy = (coordinates[3] - cy) / (anchor.offsetHeight / 2 + gy - 2);
      const angle = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360, sector = Math.round(angle / 45) % 8, [dr, dc, label] = sectors[sector];
      const expected = state.students.find(student => student.row === previous.row + dr && student.col === previous.col + dc), candidates = Array.from(document.querySelectorAll('#liveSeats .candidate')), candidate = candidates[0], style = candidate && getComputedStyle(candidate), caption = document.getElementById('directionCaption').textContent;
      if (!candidate && !hasCandidate) return;
      hasCandidate ||= Boolean(candidate);
      trace.frames.push({ at: now, sector, caption, arrow: coordinates.join(','), expectedId: expected?.id, candidateId: candidate?.dataset.liveStudent, matches: Boolean(expected?.active && candidates.length === 1 && candidate.dataset.liveStudent === expected.id && caption.includes(expected.name) && caption.includes('向' + label) && document.getElementById('stageName').textContent === expected.name), green: Boolean(style && green(style.color) && green(style.backgroundColor) && green(style.borderTopColor)), bottomOpacity: Number(getComputedStyle(document.querySelector('.draw-screen'), '::after').opacity) });
    };
    const tick = now => {
      if (stopped) return;
      if (svg.classList.contains('spinning-arrow')) { started = true; if (initialized) capture(now); }
      else if (started) { stop(true); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); deadline = setTimeout(() => stop(false), 6000);
  }, KEY);
}
async function installLiveClock(iso = '2026-10-11T14:28:12.700') {
  await installLifecycleProbes();
  await cdp.evaluate(iso => {
    const NativeDate = window.Date, base = NativeDate.parse(iso);
    let start = performance.now();
    // Keep rollover fixtures independent of the visual seat lifecycle. Only
    // this deterministic QA clock pauses during entry/exit; production Date
    // continues normally. The scanner itself still advances every real second.
    let paused = 0, frozenAt = null;
    const updateFreeze = () => { const frozen = Boolean(document.getElementById('liveSeatScroll').dataset.transition) || document.querySelector('.draw-screen').classList.contains('is-lifecycle'); if (frozen && frozenAt == null) frozenAt = performance.now(); else if (!frozen && frozenAt != null) { paused += performance.now() - frozenAt; frozenAt = null; } };
    new MutationObserver(updateFreeze).observe(document.getElementById('liveSeatScroll'), { attributes: true, attributeFilter: ['data-transition'] });
    new MutationObserver(updateFreeze).observe(document.querySelector('.draw-screen'), { attributes: true, attributeFilter: ['class'] });
    const instant = () => base + performance.now() - start - paused - (frozenAt == null ? 0 : performance.now() - frozenAt);
    // Anchor the requested boundary to the real draw click, rather than to an
    // earlier CDP setup round trip. Communication latency must not skip 59s.
    document.getElementById('drawBtn').addEventListener('click', () => { start = performance.now(); paused = 0; frozenAt = null; updateFreeze(); }, { capture: true, once: true });
    window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [instant()])); }
      static now() { return instant(); }
    };
    window.__qaDrawCalls = 0; window.__qaOriginalDraw = window.DrawCore.draw;
    window.DrawCore.draw = (...args) => { window.__qaDrawCalls++; return window.__qaOriginalDraw(...args); };
    window.__qaTimeFadeSamples = [];
    window.__qaTimeNameSamples = [];
    let nameSampling = false;
    new MutationObserver(async () => {
      if (nameSampling || !document.getElementById('timeVisual').classList.contains('is-named')) return;
      nameSampling = true;
      for (let i = 0; i < 26; i++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const name = document.getElementById('timeMatchName'), style = getComputedStyle(name), box = name.getBoundingClientRect(), digits = Array.from(document.querySelectorAll('#timeDigits .chosen')).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left), record = JSON.parse(localStorage.getItem('rollcall-studio:v1')).history.at(-1);
        window.__qaTimeNameSamples.push({ text: name.textContent, expected: record.name, number: digits.map(el => el.textContent).join(''), picked: record.timeRule.picked, opacity: Number(style.opacity), clear: box.left + parseFloat(style.paddingLeft) >= Math.max(...digits.map(el => el.getBoundingClientRect().right)) - 2, active: document.querySelector('.draw-screen').matches('.is-animating[data-animation="time"]'), busy: document.getElementById('drawBtn').getAttribute('aria-busy') === 'true' });
        await new Promise(resolve => setTimeout(resolve, 16));
      }
    }).observe(document.getElementById('timeVisual'), { attributes: true, attributeFilter: ['class'] });
    let fadeSampling = false;
    new MutationObserver(async () => {
      if (fadeSampling || !document.getElementById('timeVisual').classList.contains('is-fading')) return;
      fadeSampling = true;
      for (let i = 0; i < 12; i++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        window.__qaTimeFadeSamples.push({ opacity: Number(getComputedStyle(document.getElementById('timeVisual')).opacity), busy: document.getElementById('drawBtn').getAttribute('aria-busy') === 'true', active: document.querySelector('.draw-screen').matches('.is-animating[data-animation="time"]') });
        await new Promise(resolve => setTimeout(resolve, 16));
      }
    }).observe(document.getElementById('timeVisual'), { attributes: true, attributeFilter: ['class'] });
    Math.random = () => .9;
    window.__qaTimeScanSamples = [];
    new MutationObserver(() => {
      const s = JSON.parse(localStorage.getItem('rollcall-studio:v1'));
      const selected = Array.from(document.querySelectorAll('#timeDigits .chosen')), chosen = selected.map(el => el.textContent).join('');
      const eligible = new Set(window.DrawCore.probabilities(s).map(item => item.student.id));
      window.__qaTimeScanSamples.push({ at: performance.now(), positions: selected.map(el => el.dataset.timePosition).join(','), digits: Array.from(document.querySelectorAll('#timeDigits [data-time-position]')).map(el => el.textContent).join(''), chosen, eligible: selected.length === 2 && eligible.has(String(Number(chosen))), round: s.round, rngState: s.rngState, calls: window.__qaDrawCalls });
    }).observe(document.getElementById('timeDigits'), { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  }, iso);
}
function minimalHome() { const button = document.getElementById('drawBtn'), style = getComputedStyle(button), visibleButtons = Array.from(document.querySelectorAll('button')).filter(b => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden'); return !document.getElementById('configDialog').open && document.getElementById('drawStage').hidden && document.getElementById('liveBoard').hidden && visibleButtons.length === 2 && visibleButtons.includes(button) && visibleButtons.some(b => b.id === 'renderStylePicker') && getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)' && style.borderRadius === '0px' && style.backgroundColor === 'rgb(255, 255, 255)' && style.color === 'rgb(0, 0, 0)'; }
function seatLayoutSnapshot() {
  const scroll = document.getElementById('liveSeatScroll'), view = scroll.getBoundingClientRect(), current = document.querySelector('#liveSeats .current'), button = document.getElementById('drawBtn').getBoundingClientRect(), map = document.getElementById('liveSeatMap'), screen = document.querySelector('.draw-screen');
  const inside = seat => { const box = seat.getBoundingClientRect(); return box.top >= view.top - 1 && box.bottom <= view.bottom + 1 && box.left >= view.left - 1 && box.right <= view.right + 1; };
  const controls = ['drawBtn', 'resetDrawBtn', 'exitChainBtn'].map(id => document.getElementById(id)).filter(el => !el.hidden);
  const controlsFit = controls.every(el => { const box = el.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return box.bottom <= innerHeight && box.top >= 0 && box.left >= 0 && box.right <= innerWidth && box.height >= 44 && box.width >= box.height - 1 && hit?.closest('button') === el; });
  const matrix = new DOMMatrix(getComputedStyle(map).transform), box = current?.getBoundingClientRect();
  const stage = document.getElementById('drawStage'), stageBox = stage.getBoundingClientRect();
  const focusUncovered = !!current && (screen.classList.contains('is-animating') || box.bottom <= stageBox.top - 4);
  return {
    layout: scroll.dataset.layout, following: screen.classList.contains('is-following'), focusVisible: !!current && inside(current), allVisible: Array.from(document.querySelectorAll('#liveSeats [data-live-student]')).every(inside),
    scale: matrix.a, camera: getComputedStyle(map).transform, count: document.querySelectorAll('#liveSeats [data-live-student]').length, empty: document.querySelectorAll('#liveSeats .empty').length,
    currentId: current?.dataset.liveStudent, seatHeight: box?.height, seatWidth: box?.width, nameSize: current && parseFloat(getComputedStyle(current.querySelector('.seat-name')).fontSize), idSize: current && parseFloat(getComputedStyle(current.querySelector('.seat-id')).fontSize),
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, view: { top: view.top, bottom: view.bottom, left: view.left, right: view.right, width: view.width, height: view.height },
    pageFits: document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight, controlsFit, focusUncovered,
    boardBehindControls: view.bottom > button.top && view.bottom <= innerHeight + 1,
    scrollClips: ['hidden', 'clip'].includes(getComputedStyle(scroll).overflowX) && ['hidden', 'clip'].includes(getComputedStyle(scroll).overflowY)
  };
}
function cameraFocusSnapshot() {
  const viewport = document.getElementById('liveSeatScroll'), view = viewport.getBoundingClientRect(), map = document.getElementById('liveSeatMap');
  const focusId = viewport.dataset.focusStudent, focus = Array.from(document.querySelectorAll('#liveSeats [data-live-student]')).find(el => el.dataset.liveStudent === focusId), box = focus?.getBoundingClientRect();
  const rendered = new DOMMatrix(getComputedStyle(map).transform), target = new DOMMatrix(map.style.transform), anchor = document.querySelector('#liveSeats .anchor'), candidate = document.querySelector('#liveSeats .candidate'), current = document.querySelector('#liveSeats .current');
  const x = (view.left + view.right) / 2, y = (view.top + view.bottom) / 2;
  const localX = focus && focus.offsetLeft + focus.offsetWidth / 2, localY = focus && focus.offsetTop + focus.offsetHeight / 2;
  const centerX = box && (box.left + box.right) / 2, centerY = box && (box.top + box.bottom) / 2;
  const targetX = centerX + (target.a - rendered.a) * localX + target.e - rendered.e, targetY = centerY + (target.d - rendered.d) * localY + target.f - rendered.f;
  return {
    focusId, anchorId: anchor?.dataset.liveStudent, candidateId: candidate?.dataset.liveStudent, currentId: current?.dataset.liveStudent,
    targetCamera: map.style.transform, camera: getComputedStyle(map).transform,
    targetError: Math.hypot(targetX - x, targetY - y), renderedError: Math.hypot(centerX - x, centerY - y),
    spinning: document.getElementById('seatArrow').classList.contains('spinning-arrow'), following: document.querySelector('.draw-screen').classList.contains('is-following'),
    arrow: document.getElementById('seatArrowPath').getAttribute('d'), caption: document.getElementById('directionCaption').textContent,
    candidateName: candidate?.querySelector('.seat-name').textContent,
    view: { width: view.width, height: view.height }, scale: target.a
  };
}
async function directionCameraFrames(count = 9, interval = 75) {
  const frames = [];
  for (let i = 0; i < count; i++) { frames.push(await cdp.evaluate(cameraFocusSnapshot)); await pause(interval); }
  return frames;
}
function centeredOn(frame, id, rendered = false) { return frame.focusId === id && frame.targetError < 2 && (!rendered || frame.renderedError < 2); }
function holdProgressSnapshot(id) {
  const button = document.getElementById(id), style = getComputedStyle(button, '::before');
  return { scale: new DOMMatrix(style.transform).a, holding: button.hasAttribute('data-holding') || button.hasAttribute('data-reset-holding'), releasing: button.hasAttribute('data-hold-releasing'), progress: parseFloat(button.style.getPropertyValue('--hold-progress')) };
}
function equalHomeButtonHeights() {
  const buttons = ['drawBtn', 'resetDrawBtn', 'exitChainBtn'].map(id => document.getElementById(id)).filter(button => !button.hidden), boxes = buttons.map(button => button.getBoundingClientRect());
  return boxes.length > 1 && boxes.every(box => Math.abs(box.height - boxes[0].height) < 1 && Math.abs(box.top - boxes[0].top) < 1 && Math.abs(box.bottom - boxes[0].bottom) < 1);
}
function minimumUiButtonWidths() {
  return Array.from(document.querySelectorAll('button:not(.seat)')).filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').map(el => { const box = el.getBoundingClientRect(); return { id: el.id || el.className, width: box.width, height: box.height }; }).filter(box => box.width < box.height - 1);
}
async function localMaterialFontSnapshot() {
  await document.fonts.ready;
  const font = Array.from(document.fonts).find(face => face.family.replace(/["']/g, '') === 'Material Symbols Outlined');
  const face = Array.from(document.styleSheets).flatMap(sheet => Array.from(sheet.cssRules)).find(rule => rule.type === CSSRule.FONT_FACE_RULE && rule.style.fontFamily.includes('Material Symbols Outlined'));
  return { loaded: font?.status === 'loaded' && document.fonts.check('20px "Material Symbols Outlined"'), source: face?.style.getPropertyValue('src'), icons: document.querySelectorAll('.material-icon').length, iconFamily: getComputedStyle(document.getElementById('directionSpinner')).fontFamily, arrow: document.getElementById('directionSpinner').textContent.trim(), externalFontFetches: performance.getEntriesByType('resource').filter(entry => /fonts\.(googleapis|gstatic)\.com/.test(entry.name)).length };
}
function overlayScrimsSnapshot() {
  const screen = document.querySelector('.draw-screen'), board = document.getElementById('liveBoard'), bottom = getComputedStyle(screen, '::after'), top = getComputedStyle(board, '::before'), controls = getComputedStyle(document.querySelector('.home-actions')), stage = getComputedStyle(document.getElementById('drawStage')), visual = getComputedStyle(document.getElementById('drawVisual'));
  const color = Array.from(top.backgroundImage.matchAll(/rgba?\(([^)]+)\)|color\(srgb\s+([^)]+)\)/gi), match => {
    const srgb = Boolean(match[2]), values = (match[2] || match[1]).replace(/,/g, ' ').trim().split(/\s*\/\s*|\s+/);
    const channels = values.slice(0, 3).map(value => parseFloat(value) * (value.endsWith('%') ? 2.55 : srgb ? 255 : 1));
    const alpha = values[3] == null ? 1 : parseFloat(values[3]) / (values[3].endsWith('%') ? 100 : 1);
    return [...channels, alpha];
  }).find(channels => channels.length === 4 && channels.every(Number.isFinite) && channels[3] > 0) || [];
  return { bottom: bottom.backgroundImage, top: top.backgroundImage, bottomHeight: parseFloat(bottom.height), topHeight: parseFloat(top.height), bottomPointer: bottom.pointerEvents, topPointer: top.pointerEvents, bottomZ: Number(bottom.zIndex), topZ: Number(top.zIndex), controlsZ: Number(controls.zIndex), stageZ: Number(stage.zIndex), visualZ: Number(visual.zIndex), topIsGreen: color.length === 4 && color[3] > 0 && color[1] > color[0] && color[1] > color[2], bottomOpacity: Number(bottom.opacity) };
}
function seatLifecycleSnapshot() {
  const scroll = document.getElementById('liveSeatScroll'), seats = Array.from(document.querySelectorAll('#liveSeats [data-live-student]'));
  const frames = seats.map(el => { const style = getComputedStyle(el), animation = el.getAnimations().find(item => item.effect?.target === el && !(item instanceof CSSTransition) && !(item instanceof CSSAnimation)), matrix = new DOMMatrix(style.transform); return { id: el.dataset.liveStudent, color: style.backgroundColor, opacity: Number(style.opacity), shifted: Math.abs(matrix.m43) > 2, depth: matrix.m43, xyStable: Math.abs(matrix.m41) < .01 && Math.abs(matrix.m42) < .01, delay: animation?.effect.getTiming().delay, whiteFrames: animation?.effect.getKeyframes().some(frame => ['#ffffff', 'rgb(255, 255, 255)'].includes(frame.backgroundColor)), running: el.classList.contains('seat-transition-running') }; });
  return { phase: scroll.dataset.transition, busy: document.getElementById('drawBtn').getAttribute('aria-busy') === 'true', count: frames.length, active: frames.filter(frame => frame.running).length, white: frames.filter(frame => frame.color === 'rgb(255, 255, 255)' && frame.opacity > .05).length, shifted: frames.filter(frame => frame.shifted).length, frames, arrowsHidden: document.getElementById('seatArrow').hasAttribute('hidden') || getComputedStyle(document.getElementById('seatArrow')).visibility === 'hidden', temporaryClasses: document.querySelectorAll('#liveSeats .seat-transition-running,#liveSeats .seat-transition-entering,#liveSeats .seat-transition-exiting').length };
}
async function screenshot(name) { const metrics = await cdp.send('Page.getLayoutMetrics'); const size = metrics.cssContentSize; const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 } }); await writeFile(path.join(output, name), Buffer.from(shot.data, 'base64')); if (!screenshots.includes(name)) screenshots.push(name); }
try {
  console.log('Browser QA starting: ' + html.length + ' bytes');
  server = createServer(async (req, res) => {
    if (req.url === '/vision' && req.method === 'POST') {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk); const request = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(req.headers.authorization, 'Bearer qa-temporary-key'); assert.equal(request.model, 'qa-vision'); assert.equal(request.stream, false);
        assert.ok(request.messages[0].content[1].image_url.url.startsWith('data:image/png;base64,'));
        const prompt = request.messages[0].content[0].text; assert.ok(prompt.includes('不能默认图片上方就是讲台') && prompt.includes('顺时针旋转90度') && prompt.includes('删除没有任何学生的整行和整列'));
        assert.ok(['名单.csv', '名单.xls', '名单.xlsx', '2026080101', '2026080102', '2026080103', '2026080104', 'idCandidates'].every(value => prompt.includes(value)));
        visionRequests++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(visionResult) } }] }));
      } catch (_) { res.statusCode = 400; res.end('{}'); }
      return;
    }
    if (req.url === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
    if (req.url !== '/') { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const site = 'http://127.0.0.1:' + server.address().port;
  edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-proxy-server', '--remote-debugging-port=0', '--window-size=1440,1080', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  edge.stderr.on('data', chunk => edgeLog = (edgeLog + chunk.toString()).slice(-4000));
  let debugPort;
  edge.on('error', error => console.error('Browser launch:', error.message));
  await waitFor(async () => { const data = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'); debugPort = Number(data.split('\n')[0]); return debugPort > 0; }, 20000);
  console.log('Browser debugger ready');
  const targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list', { signal: AbortSignal.timeout(5000) })).json(), target = targets.find(t => t.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  cdp = new CDP(socket); await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable'); await cdp.send('Network.setBlockedURLs', { urls: ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*'] }); await cdp.send('Page.navigate', { url: site });
  console.log('Browser page navigated');
  try { await waitFor(() => cdp.evaluate(() => typeof window.DrawCore?.createState === 'function' && document.getElementById('rosterSeats') && document.querySelectorAll('[data-mode-row]').length === 5)); }
  catch (error) { console.log('Page initialization diagnostics:', JSON.stringify(cdp.errors)); console.log(await cdp.evaluate(() => ({ title: document.title, content: document.body.innerText.slice(0, 600) }))); throw error; }
  // Old visual baselines expect the classic dark stage and square controls.
  await cdp.evaluate(key => {
    const state = window.DrawCore.createEmptyState(4242);
    state.settings = window.DrawCore.settings({ ...state.settings, theme: 'classic', radius: 0 });
    localStorage.setItem(key, JSON.stringify(state));
    window.__qaBeforeReload = true;
  }, KEY);
  await cdp.send('Page.reload');
  await waitFor(() => cdp.evaluate(() => !window.__qaBeforeReload && !!document.getElementById('rosterSeats')));
  await pause(260);
  check('桌面首屏是纯黑背景、白色直角按钮黑字，配置与结果均隐藏', await cdp.evaluate(minimalHome));
  check('首页没有抽取结果时隐藏重置按钮', await cdp.evaluate(() => document.getElementById('resetDrawBtn').hidden));
  check('全新安装默认空名单，不自动填充示例姓名或抽取记录', await cdp.evaluate(key => {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    return document.querySelectorAll('#rosterSeats [data-student]').length === 0 && document.querySelectorAll('#liveSeats [data-live-student]').length === 0 && (!saved || saved.students.length === 0 && saved.round === 0 && saved.history.length === 0 && saved.demo === false);
  }, KEY));
  await click('#drawBtn');
  await waitFor(() => cdp.evaluate(() => document.getElementById('configDialog').open && !document.getElementById('configDialog').dataset.motion && !document.getElementById('view-roster').hidden));
  check('空名单短按抽人打开名单座位页，不产生抽取记录或结果', await cdp.evaluate(key => {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    return (!saved || saved.round === 0 && saved.history.length === 0 && saved.lastId === null) && document.getElementById('drawBtn').getAttribute('aria-busy') === 'false' && document.getElementById('drawStage').hidden;
  }, KEY));
  await cdp.evaluate(() => DialogTransitions.close(document.getElementById('configDialog')));
  await waitFor(() => cdp.evaluate(() => !document.getElementById('configDialog').open && !document.getElementById('configDialog').dataset.motion));
  check('空名单配置关闭后恢复极简首页', await cdp.evaluate(minimalHome));
  const classroomFixture = await cdp.evaluate(() => {
    const students = Array.from({ length: 47 }, (_, i) => ({ id: String(i + 1), name: '回归同学' + String(i + 1).padStart(2, '0'), row: Math.floor(i / 8) + 1, col: i % 8 + 1, active: true }));
    const value = DrawCore.createState(students, 23456); value.demo = false; value.className = '回归测试班'; return value;
  });
  await reloadStoredState(classroomFixture);
  const materialFont = await cdp.evaluate(localMaterialFontSnapshot);
  check('Material 图标字体内嵌单文件 HTML，无需 Google 字体网络请求且正确加载', materialFont.loaded && materialFont.source.includes('data:font/woff2;base64,') && materialFont.icons >= 12 && materialFont.externalFontFetches === 0);
  check('方向箭头使用 Material 字体的真实箭头字形，Windows 默认字体不参与符号显示', materialFont.arrow === 'arrow_upward' && materialFont.iconFamily.includes('Material Symbols Outlined'));
  check('极简首页抽人按钮加入独立图标，并保持宽度不小于高度', await cdp.evaluate(() => !!document.getElementById('drawBtn').querySelector('.material-icon[aria-hidden="true"]')) && (await cdp.evaluate(minimumUiButtonWidths)).length === 0);
  check('显式测试名单恢复47人、8列6行48座位并保留一格空座及全部抽取模式', await cdp.evaluate(key => JSON.parse(localStorage.getItem(key)).demo === false && document.getElementById('rosterSeats').children.length === 48 && document.querySelectorAll('#rosterSeats [data-student]').length === 47 && document.querySelectorAll('#rosterSeats .empty').length === 1 && document.querySelectorAll('[data-mode-row]').length === 5, KEY));
  check('1440px 桌面布局没有整体横向溢出', await cdp.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await screenshot('desktop.png');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await pause(200);
  check('390px 手机布局没有整体横向溢出', await cdp.evaluate(() => document.documentElement.scrollWidth <= 390));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: true });
  check('320px 小屏布局没有整体横向溢出', await cdp.evaluate(() => document.documentElement.scrollWidth <= 320));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await screenshot('mobile.png');
  const demoNormalState = await cdp.evaluate(() => { const students = Array.from(document.querySelectorAll('#rosterSeats [data-student]')).map((seat, i) => ({ id: seat.dataset.student, name: seat.querySelector('.seat-name').textContent, row: Math.floor(i / 8) + 1, col: i % 8 + 1, active: true })); const s = window.DrawCore.createState(students, 23456); s.settings.strategy = 'manual'; s.settings.manualMode = 'normal'; return s; });
  await reloadStoredState(demoNormalState);
  const targetPoint = await buttonPoint();
  await Promise.all([cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: targetPoint.x, y: targetPoint.y, radiusX: 4, radiusY: 4, force: 1, id: 1 }] }), cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })]);
  await waitFor(() => cdp.evaluate(() => window.__qaLifecycle.enter?.start), 3500);
  const entranceStart = await cdp.evaluate(() => window.__qaLifecycle.enter.start);
  const entranceOrder = entranceStart.frames.map(frame => frame.delay).filter(delay => delay != null);
  check('首次抽取先让47个有名座位以白色浮入，空座不参与，动作期间锁住抽取', entranceStart.phase === 'enter' && entranceStart.busy && entranceStart.count === 47 && entranceStart.active >= 40 && entranceStart.frames.filter(frame => frame.running).every(frame => frame.whiteFrames) && entranceStart.arrowsHidden);
  check('入场延迟使用乱序，座位从负 Z 深度靠近，X/Y 行列位置保持不变', new Set(entranceOrder).size >= 20 && entranceOrder.some((delay, i) => i > 0 && delay < entranceOrder[i - 1]) && entranceStart.shifted >= 20 && entranceStart.frames.every(frame => frame.xyStable));
  await click('#drawBtn');
  check('入场中重复点击没有提前写入抽取记录或消耗随机状态', entranceStart.repeatUnchanged && JSON.parse(entranceStart.storedBefore).round === 0 && JSON.parse(entranceStart.storedBefore).rngState === demoNormalState.rngState);
  await pause(180);
  await waitFor(() => cdp.evaluate(() => window.__qaLifecycle.enter.middle));
  const entranceBright = await cdp.evaluate(() => window.__qaLifecycle.enter.middle);
  check('浮入期间确实绘制白亮座位，尚未到位时持续移动而不是只改变透明度', entranceBright.phase === 'enter' && entranceBright.white >= 1 && entranceBright.shifted >= 1);
  await screenshot('seat-white-enter.png');
  await waitFor(() => cdp.evaluate(() => !document.getElementById('liveSeatScroll').dataset.transition && document.querySelector('.draw-screen').matches('.is-animating[data-animation="normal"]') && document.querySelector('#liveSeats .candidate')), 4000);
  const normalStarted = await cdp.evaluate(async key => { const clear = document.querySelectorAll('#liveSeats .seat-transition-running,#liveSeats .seat-transition-entering').length === 0 && Array.from(document.querySelectorAll('#liveSeats [data-live-student]')).every(el => !el.getAnimations().some(animation => animation.effect?.target === el && !(animation instanceof CSSTransition) && !(animation instanceof CSSAnimation))); document.getElementById('drawBtn').click(); const singleDraw = JSON.parse(localStorage.getItem(key)).round === 1 && document.getElementById('drawBtn').getAttribute('aria-busy') === 'true', resetDisabled = document.getElementById('resetDrawBtn').disabled, samples = []; for (let i = 0; i < 9; i++) { const seat = document.querySelector('#liveSeats .candidate'); samples.push({ id: seat?.dataset.liveStudent, active: document.querySelector('.draw-screen').matches('.is-animating[data-animation="normal"]'), transform: getComputedStyle(document.getElementById('liveSeatMap')).transform }); await new Promise(resolve => setTimeout(resolve, 65)); } return { clear, singleDraw, resetDisabled, samples }; }, KEY);
  const normalMotion = normalStarted.samples;
  check('全部座位入场完成后恢复原色并进入抽取，临时动画类与WAAPI全部清理', normalStarted.clear);
  check('真实触屏短按可以抽取，动画中连续点击只记录一轮', normalStarted.singleDraw);
  check('抽取动画期间禁用重置按钮，避免中途清除本轮状态', normalStarted.resetDisabled);
  if (new Set(normalMotion.map(x => x.id).filter(Boolean)).size < 3) console.log('Normal frame diagnostics: ' + JSON.stringify(normalMotion));
  check('普通随机在全屏座位图中乱序高亮候选人，同时移动镜头', new Set(normalMotion.filter(x => x.active).map(x => x.id).filter(Boolean)).size > 2 && normalMotion.slice(1).some((x, i) => x.id && normalMotion[i].id && Math.abs(Number(x.id) - Number(normalMotion[i].id)) > 1) && new Set(normalMotion.map(x => x.transform)).size > 1 && normalMotion.some(x => x.active && x.transform !== 'none'));
  await screenshot('normal-camera.png');
  await waitFor(() => cdp.evaluate(() => document.querySelector('.draw-screen').classList.contains('is-settling')), 3500);
  check('普通结果揭晓后镜头连贯移向当前焦点，过渡完成前继续阻止重复抽取', await cdp.evaluate(() => document.querySelector('.draw-screen').classList.contains('is-settling') && document.getElementById('drawBtn').getAttribute('aria-busy') === 'true'));
  await screenshot('normal-settling.png');
  await drawFinished();
  check('抽取结果、历史与结果播报一致', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return document.getElementById('stageName').textContent === s.history[0].name && document.getElementById('announcement').textContent.includes(s.history[0].name); }, KEY));
  check('抽取后 47 人座位网格铺到下方操作层背后，当前同学绿色高亮且底部按钮可触达', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), seat = document.querySelector('#liveSeats .current'), b = document.getElementById('drawBtn').getBoundingClientRect(), grid = document.getElementById('liveBoard').getBoundingClientRect(), color = getComputedStyle(seat).color.match(/\d+/g).map(Number); return !document.getElementById('liveBoard').hidden && document.querySelectorAll('#liveSeats [data-live-student]').length === 47 && seat.dataset.liveStudent === s.lastId && color[1] > color[0] && color[1] > color[2] && b.top > innerHeight * .7 && grid.bottom > b.top && grid.bottom <= innerHeight + 1; }, KEY) && (await cdp.evaluate(seatLayoutSnapshot)).controlsFit);
  check('结果揭晓后左侧显示可用重置按钮，触屏可完整触达', await cdp.evaluate(() => { const button = document.getElementById('resetDrawBtn'), reset = button.getBoundingClientRect(), draw = document.getElementById('drawBtn').getBoundingClientRect(); return !button.hidden && !button.disabled && reset.right <= draw.left && reset.width >= 44 && reset.height >= 44 && reset.left >= 0 && reset.bottom <= innerHeight; }));
  check('手机抽人按钮与重置按钮高度及上下边缘保持一致', await cdp.evaluate(equalHomeButtonHeights));
  check('手机抽人及重置按钮的宽度至少等于高度，图标不挤出操作区域', (await cdp.evaluate(minimumUiButtonWidths)).length === 0);
  const restingScrims = await cdp.evaluate(overlayScrimsSnapshot);
  check('底部黑色渐隐遮罩衬托操作与姓名，按钮和结果层位于遮罩上方且点击不被拦截', restingScrims.bottom.startsWith('linear-gradient(0deg,') && restingScrims.bottom.includes('rgba(0, 0, 0, 0)') && restingScrims.bottomHeight > 100 && restingScrims.bottomPointer === 'none' && restingScrims.controlsZ > restingScrims.bottomZ && restingScrims.stageZ > restingScrims.bottomZ && (await cdp.evaluate(seatLayoutSnapshot)).controlsFit);
  check('顶部提示使用向下渐隐的绿色背景，遮罩允许座位画面和操作穿透', restingScrims.top.startsWith('linear-gradient(') && restingScrims.topIsGreen && restingScrims.top.includes('rgba(0, 0, 0, 0)') && restingScrims.topHeight >= 80 && restingScrims.topPointer === 'none' && restingScrims.visualZ > restingScrims.topZ);
  check('当前绿色座位保留明亮近光和扩散超过24px的局部渐变远光', await cdp.evaluate(() => { const seat = document.querySelector('#liveSeats .current'), near = getComputedStyle(seat), far = getComputedStyle(seat, '::before'); return seat.getClientRects().length > 0 && near.boxShadow !== 'none' && far.backgroundImage.includes('radial-gradient(') && Number(far.opacity) > .9 && parseFloat(far.top) <= -24 && parseFloat(far.left) <= -24 && far.pointerEvents === 'none'; }));
  await screenshot('draw-mobile.png');
  await screenshot('seat-overlay-controls.png');
  const holdPoint = await buttonPoint();
  const heldAt = Date.now();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...holdPoint, radiusX: 4, radiusY: 4, force: 1, id: 2 }] });
  await pause(250);
  check('长按中浅灰背景从左向右填充，500 毫秒前不打开菜单也不抽取', await cdp.evaluate(key => { const button = document.getElementById('drawBtn'), style = getComputedStyle(button, '::before'), scale = new DOMMatrix(style.transform).a, fill = style.backgroundColor.match(/\d+/g).map(Number); return button.hasAttribute('data-holding') && scale > 0 && scale < 1 && style.animationTimingFunction.includes('cubic-bezier') && style.transformOrigin.startsWith('0px') && fill[0] < 255 && fill[0] === fill[1] && fill[1] === fill[2] && !document.getElementById('configDialog').open && JSON.parse(localStorage.getItem(key)).round === 1; }, KEY));
  await screenshot('hold-progress.png');
  await waitFor(() => cdp.evaluate(() => document.getElementById('configDialog').open), 4000);
  check('真实触屏按满 500 毫秒打开配置，抽取轮数保持不变', Date.now() - heldAt >= 470 && Date.now() - heldAt < 1250 && await cdp.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 1 && document.getElementById('drawBtn').getAttribute('aria-expanded') === 'true', KEY));
  check('配置菜单是白色背景、黑色前景且没有圆角', await cdp.evaluate(() => { const style = getComputedStyle(document.getElementById('configDialog')); return style.backgroundColor === 'rgb(255, 255, 255)' && style.color === 'rgb(0, 0, 0)' && style.borderRadius === '0px'; }));
  check('配置菜单导航与操作使用内嵌 Material 图标，并保留可读的中文标签', await cdp.evaluate(() => Array.from(document.querySelectorAll('.navigation button')).every(el => el.querySelector('.material-icon[aria-hidden="true"]') && el.textContent.replace(el.querySelector('.material-icon').textContent, '').trim().length > 0) && document.getElementById('settingsBtn').querySelector('.material-icon')));
  const mobileMenuNarrowButtons = await cdp.evaluate(minimumUiButtonWidths);
  if (mobileMenuNarrowButtons.length) console.log('Mobile UI minimum width diagnostics: ' + JSON.stringify(mobileMenuNarrowButtons));
  check('手机配置页面每个可见操作按钮至少保持正方形宽度', mobileMenuNarrowButtons.length === 0);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const menuReleaseStart = await cdp.evaluate(holdProgressSnapshot, 'drawBtn'); await pause(120);
  const menuReleaseLater = await cdp.evaluate(holdProgressSnapshot, 'drawBtn');
  check('长按配置松手后灰色进度从满格逆向缩回，期间不产生额外抽选', menuReleaseStart.releasing && menuReleaseStart.progress > .8 && menuReleaseLater.scale < menuReleaseStart.scale && await cdp.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 1 && document.getElementById('configDialog').open, KEY));
  await waitFor(() => cdp.evaluate(() => !document.getElementById('drawBtn').hasAttribute('data-hold-releasing')), 1500);
  check('长按后松手不会额外抽人，背景进度最终清空', await cdp.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 1 && !document.getElementById('drawBtn').hasAttribute('data-holding') && new DOMMatrix(getComputedStyle(document.getElementById('drawBtn'), '::before').transform).a < .001, KEY));
  await click('[data-strategy="manual"]'); await cdp.evaluate(async () => { const select = document.getElementById('manualModeInput'); select.value = 'normal'; select.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 0)); });
  await click('#undoBtn'); check('菜单撤销恢复到零轮，首页结果重新隐藏', await cdp.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 0 && document.getElementById('drawStage').hidden, KEY));
  await screenshot('config-mobile.png');
  await cdp.send('Emulation.clearDeviceMetricsOverride'); await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await screenshot('config-desktop.png');
  await screenshot('material-config-preview.png');
  await click('#settingsBtn');
  await click('[data-settings-tab="time"]');
  const settingsNarrowButtons = await cdp.evaluate(minimumUiButtonWidths);
  if (settingsNarrowButtons.length) console.log('Settings minimum width diagnostics: ' + JSON.stringify(settingsNarrowButtons));
  check('规则设置取位按钮宽度不少于高度，真实 Material 图标字体持续加载', settingsNarrowButtons.length === 0 && (await cdp.evaluate(localMaterialFontSnapshot)).loaded);
  await click('[data-settings-tab="direction"]');
  check('连坐设置提供默认3至5轮的最小及最大值输入，范围标注1至50轮', await cdp.evaluate(() => { const min = document.getElementById('directionMinInput'), max = document.getElementById('directionMaxInput'); return min?.value === '3' && max?.value === '5' && min.min === '1' && max.min === '1' && min.max === '50' && max.max === '50'; }));
  await cdp.evaluate(() => { document.getElementById('directionMinInput').value = '6'; document.getElementById('directionMaxInput').value = '2'; document.getElementById('settingsForm').requestSubmit(); });
  check('连坐最小轮数大于最大轮数时明确拒绝保存', await cdp.evaluate(() => document.getElementById('settingsDialog').open && document.getElementById('settingsError').textContent.length > 0));
  await cdp.evaluate(() => { document.getElementById('directionMinInput').value = '2'; document.getElementById('directionMaxInput').value = '7'; });
  await click('[data-settings-tab="time"]');
  await cdp.evaluate(() => { document.getElementById('timeSourceInput').value = 'date'; document.getElementById('timeSourceInput').dispatchEvent(new Event('change')); document.getElementById('timeSelectionInput').value = 'fixed'; document.getElementById('timeSelectionInput').dispatchEvent(new Event('change')); document.getElementById('positionsInput').value = '99'; document.getElementById('settingsForm').requestSubmit(); });
  check('规则设置拒绝超出日期长度的取位', await cdp.evaluate(() => document.getElementById('settingsDialog').open && document.getElementById('settingsError').textContent.length > 0));
  await cdp.evaluate(() => { document.getElementById('positionsInput').value = '7,8'; document.getElementById('settingsForm').requestSubmit(); });
  await waitFor(() => cdp.evaluate(() => !document.getElementById('settingsDialog').open), 2000);
  check('正确的日期取位规则保存成功', await cdp.evaluate(key => JSON.parse(localStorage.getItem(key)).settings.positions === '7,8' && !document.getElementById('settingsDialog').open, KEY));
  check('连坐自定义2至7轮与其他规则一并保存，使用新的min/max字段持久化', await cdp.evaluate(key => { const settings = JSON.parse(localStorage.getItem(key)).settings; return settings.directionMin === 2 && settings.directionMax === 7 && settings.directionRounds === 'random'; }, KEY));
  await click('[data-import]');
  await cdp.evaluate(() => { document.getElementById('importClassInput').value = '测试班级'; document.getElementById('importColsInput').value = '2'; document.getElementById('rosterText').value = '1,张三\n2,李四\n3,=1+1\n4,同学 <b>测试</b>'; });
  await click('#previewImportBtn');
  await waitFor(() => cdp.evaluate(() => document.getElementById('importLayoutDialog').open && !document.getElementById('importLayoutDialog').dataset.motion));
  check('没有可匹配旧座位的姓名学号名单要求显式提供布局，未自动猜测行列', await cdp.evaluate(() => document.getElementById('importLayoutRows').value === '' && document.getElementById('importLayoutCols').value === '' && document.getElementById('importPreviewSection').hidden));
  await cdp.evaluate(() => { document.getElementById('importLayoutRows').value = '2'; document.getElementById('importLayoutCols').value = '2'; document.getElementById('importLayoutForm').requestSubmit(); });
  await waitFor(() => cdp.evaluate(() => !document.getElementById('importLayoutDialog').open && document.querySelectorAll('[data-preview-row]').length === 4 && !document.getElementById('importPreviewSection').hidden));
  check('按行导入先展示可编辑预览', await cdp.evaluate(() => document.querySelectorAll('[data-preview-row]').length === 4 && !document.getElementById('importPreviewSection').hidden));
  await cdp.evaluate(() => document.querySelector('[data-preview-row="0"] [data-field="name"]').value = '张一');
  await cdp.evaluate(() => { document.getElementById('importResetInput').checked = true; });
  await click('#applyImportBtn');
  await waitFor(() => cdp.evaluate(() => document.getElementById('confirmDialog').open));
  await click('#confirmActionBtn');
  await waitFor(() => cdp.evaluate(() => !document.getElementById('importDialog').open));
  check('核对后的姓名与新名单生效，HTML 内容被转义', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return s.students.length === 4 && s.students[0].name === '张一' && s.round === 0 && !document.querySelector('#rosterSeats b'); }, KEY));
  await closeConfig();
  for (let i = 0; i < 4; i++) { await click('#drawBtn'); await drawFinished(); }
  check('四人名单在三轮冷却下，每人各抽一次', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return s.round === 4 && Object.values(s.counts).every(n => n === 1); }, KEY));
  check('主页已抽到的同学淡化，只有最新结果保持绿色', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), current = document.querySelector('#liveSeats .current'), seen = Array.from(document.querySelectorAll('#liveSeats .seen')); return document.querySelectorAll('#liveSeats .current').length === 1 && current.dataset.liveStudent === s.lastId && seen.length === 3 && seen.every(el => Number(getComputedStyle(el).opacity) < Number(getComputedStyle(current).opacity)); }, KEY));
  await screenshot('draw-desktop.png');
  const completedCycle = await cdp.evaluate(key => localStorage.getItem(key), KEY);
  await cdp.evaluate(() => { window.__qaCycleDrawCalls = 0; window.__qaCycleOriginalDraw = window.DrawCore.draw; window.DrawCore.draw = (...args) => { window.__qaCycleDrawCalls++; return window.__qaCycleOriginalDraw(...args); }; });
  await click('#drawBtn');
  await waitFor(() => cdp.evaluate(() => document.getElementById('liveSeatScroll').dataset.transition === 'exit'), 2500);
  const cycleExit = await cdp.evaluate(seatLifecycleSnapshot);
  check('轮满后再次点击先将旧座位白亮退场，退场期间保留上一位和全部记录', cycleExit.phase === 'exit' && cycleExit.busy && cycleExit.active === 4 && cycleExit.frames.every(frame => frame.whiteFrames) && await cdp.evaluate((key, before) => localStorage.getItem(key) === before && window.__qaCycleDrawCalls === 0, KEY, completedCycle));
  await screenshot('cycle-white-exit.png');
  await waitFor(() => cdp.evaluate(() => document.getElementById('liveSeatScroll').dataset.transition === 'enter'), 2500);
  check('轮满换轮按退场再入场衔接，入场时仍未消耗抽取状态', (await cdp.evaluate(seatLifecycleSnapshot)).active > 0 && await cdp.evaluate((key, before) => { const s = JSON.parse(localStorage.getItem(key)), previous = JSON.parse(before); return s.round === previous.round && s.lastId === previous.lastId && s.rngState === previous.rngState && window.__qaCycleDrawCalls === 0; }, KEY, completedCycle));
  await screenshot('cycle-white-enter.png');
  await click('#drawBtn'); await drawFinished();
  check('自动换轮退入场期间重复点击被忽略，最终只调用一次真实抽取且所有临时样式移除', await cdp.evaluate(() => window.__qaCycleDrawCalls === 1 && !document.getElementById('liveSeatScroll').dataset.transition && document.querySelectorAll('#liveSeats .seat-transition-running,#liveSeats .seat-transition-entering,#liveSeats .seat-transition-exiting').length === 0));
  await cdp.evaluate(() => { window.DrawCore.draw = window.__qaCycleOriginalDraw; delete window.__qaCycleOriginalDraw; });
  check('全班轮满后下一次抽取自动清除旧座位标记，保留上一位位置与累计记录', await cdp.evaluate((key, before) => { const s = JSON.parse(localStorage.getItem(key)), previous = JSON.parse(before), r = s.history.at(-1); return s.round === 5 && s.history.length === 5 && s.cycleSeen.length === 1 && s.cycleSeen[0] === s.lastId && r.before.lastId === previous.lastId && document.querySelectorAll('#liveSeats .seen').length === 0 && document.querySelectorAll('#liveSeats .current').length === 1; }, KEY, completedCycle));
  await screenshot('cycle-next.png'); await openConfig(); await click('#undoBtn'); await closeConfig();
  check('撤销自动换轮的抽取会恢复上一轮全部座位标记、历史和随机状态', await cdp.evaluate((key, before) => localStorage.getItem(key) === before && document.querySelectorAll('#liveSeats .seen').length === 3, KEY, completedCycle));
  await openConfig();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output });
  await rm(path.join(output, '测试班级-抽取记录.csv'), { force: true });
  await click('.navigation [data-nav="data"]'); await click('#exportHistoryBtn');
  await waitFor(async () => (await readdir(output)).includes('测试班级-抽取记录.csv'));
  const csv = await readFile(path.join(output, '测试班级-抽取记录.csv'), 'utf8');
  check('导出 CSV 保留中文并防止姓名成为表格公式', csv.startsWith('\uFEFF') && csv.includes("'=1+1"));
  const backup = await cdp.evaluate(key => localStorage.getItem(key), KEY);
  const previousBackups = new Set(await readdir(output));
  await click('#backupBtn');
  let completeBackupFile;
  await waitFor(async () => { completeBackupFile = (await readdir(output)).find(name => name.endsWith('.slate') && !previousBackups.has(name)); return !!completeBackupFile; });
  const completeBackupBytes = await readFile(path.join(output, completeBackupFile));
  const completeBackup = decodeCompleteBackup(completeBackupBytes);
  assert.deepEqual(completeBackup.state, JSON.parse(backup), 'The real full backup preserves all classroom, fairness, history and random state');
  check('数据页实际导出 .slate 二进制完整备份，通过完整性校验且保留全部班级状态，默认不带 API 密钥', completeBackup.kind === 'all' && completeBackup.format === 'SlateRandomBackup' && !JSON.stringify(completeBackup.credentials).includes('qa-key-') && !await cdp.evaluate(() => document.getElementById('includeSecretsToggle').checked));
  await click('.navigation [data-nav="roster"]'); await click('#swapBtn'); await click('#rosterSeats [data-student="1"]'); await click('#rosterSeats [data-student="2"]');
  check('点击两位同学完成触屏友好的座位交换', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return s.students[0].col === 2 && s.students[1].col === 1; }, KEY));
  await click('#listViewBtn'); await click('[data-toggle-student="1"]');
  check('暂停学生后实时概率为零且记录保留', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return !s.students[0].active && s.counts['1'] === 1 && !window.DrawCore.probabilities(s).some(p => p.student.id === '1'); }, KEY));
  await click('[data-import]'); await click('[data-import-tab="json"]');
  await cdp.evaluate(() => document.getElementById('visionJson').value = '{"students":[{"id":1,"name":"甲","row":1,"col":1},{"id":2,"name":"乙","row":1,"col":1}]}');
  await click('#previewImportBtn');
  check('重复座位的识别结果会被明确拒绝', await cdp.evaluate(() => document.getElementById('importError').textContent.includes('安排了多个人')));
  await click('#providerSettingsBtn'); await waitFor(() => cdp.evaluate(() => document.getElementById('providerDialog').open));
  check('导入页面有独立提供商按钮，预设包含六家服务和自定义兼容接口', await cdp.evaluate(() => ['deepseek', 'kimi', 'mimo', 'openai', 'claude', 'gemini', 'custom'].every(id => Array.from(document.getElementById('providerPreset').options).some(option => option.value === id))));
  check('DeepSeek 默认视觉模型为 deepseek-flash，完整端点预设，仅需填写密钥', await cdp.evaluate(() => document.getElementById('providerPreset').value === 'deepseek' && document.getElementById('providerModelSelect').value === 'deepseek-flash' && document.getElementById('apiEndpoint').value === 'https://api.deepseek.com/chat/completions' && document.getElementById('providerCustomFields').hidden));
  await cdp.evaluate(() => { document.getElementById('apiKey').value = 'qa-deepseek-persist'; document.getElementById('providerForm').requestSubmit(); });
  await waitFor(() => cdp.evaluate(() => !document.getElementById('providerDialog').open));
  await click('#providerSettingsBtn'); await waitFor(() => cdp.evaluate(() => document.getElementById('providerDialog').open));
  await cdp.evaluate(() => { const select = document.getElementById('providerPreset'); select.value = 'openai'; select.dispatchEvent(new Event('change')); });
  check('OpenAI 下拉推荐 GPT-6-Luna 与 GPT-5.6-Luna，默认选中 GPT-6-Luna', await cdp.evaluate(() => { const select = document.getElementById('providerModelSelect'); return select.value === 'gpt-6-luna' && !select.disabled && Array.from(select.options).map(option => option.value).join(',') === 'gpt-6-luna,gpt-5.6-luna' && document.getElementById('apiEndpoint').value === 'https://api.openai.com/v1/chat/completions'; }));
  await cdp.evaluate(() => { document.getElementById('providerModelSelect').value = 'gpt-5.6-luna'; document.getElementById('apiKey').value = 'qa-openai-persist'; document.getElementById('providerForm').requestSubmit(); });
  await waitFor(() => cdp.evaluate(() => !document.getElementById('providerDialog').open));
  await cdp.send('Page.reload'); await waitFor(() => cdp.evaluate(() => document.getElementById('providerSummary')?.textContent.includes('gpt-5.6-luna')));
  check('API 密钥、提供商选择与模型在刷新后由 IndexedDB 恢复，班级记录不含密钥', await cdp.evaluate(async key => { const config = await window.VisionProviders.getConfig(); return config.provider === 'openai' && config.model === 'gpt-5.6-luna' && config.key === 'qa-openai-persist' && !localStorage.getItem(key).includes('qa-openai-persist'); }, KEY));
  await openConfig(); await click('[data-import]'); await click('#providerSettingsBtn'); await waitFor(() => cdp.evaluate(() => document.getElementById('providerDialog').open));
  await cdp.evaluate(() => { const select = document.getElementById('providerPreset'); select.value = 'deepseek'; select.dispatchEvent(new Event('change')); });
  check('每家提供商独立保存密钥，切回预设时已有密钥保持且输入栏为空', await cdp.evaluate(() => document.getElementById('apiKey').value === '' && document.getElementById('apiKey').placeholder.includes('已保存') && !document.getElementById('providerClearKeyBtn').disabled));
  await cdp.evaluate(() => { const select = document.getElementById('providerPreset'); select.value = 'custom'; select.dispatchEvent(new Event('change')); });
  await cdp.evaluate(endpoint => { document.getElementById('apiEndpoint').value = endpoint; document.getElementById('apiModel').value = 'qa-vision'; document.getElementById('apiKey').value = 'qa-temporary-key'; document.getElementById('providerForm').requestSubmit(); }, site + '/vision');
  await waitFor(() => cdp.evaluate(() => !document.getElementById('providerDialog').open));
  await cdp.send('Page.reload'); await waitFor(() => cdp.evaluate(() => document.getElementById('providerSummary')?.textContent.includes('qa-vision')));
  check('自定义兼容端点、模型与密钥同样持久化，设置无需再次填写', await cdp.evaluate(async () => { const config = await window.VisionProviders.getConfig(); return config.provider === 'custom' && config.key === 'qa-temporary-key' && config.model === 'qa-vision'; }));
  await openConfig(); await click('[data-import]');
  await click('[data-import-tab="image"]');
  await cdp.evaluate(async () => { const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1; const blob = await new Promise(resolve => canvas.toBlob(resolve)); const transfer = new DataTransfer(); transfer.items.add(new File([blob], '座位表.png', { type: 'image/png' })); const input = document.getElementById('imageFile'); input.files = transfer.files; input.dispatchEvent(new Event('change')); });
  await waitFor(() => cdp.evaluate(() => !document.getElementById('imagePreview').hidden));
  await cdp.evaluate(() => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['学号,姓名\n2026080101,识别甲'], '名单.csv', { type: 'text/csv' }));
    for (const format of ['xls', 'xlsx']) { const book = XLSX.utils.book_new(), rows = format === 'xls' ? [['学号', '姓名'], ['2026080102', '识别乙']] : [['学号', '姓名'], ['2026080103', '识别丙'], ['2026080104', '识别丁']]; XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '学生'); const data = XLSX.write(book, { type: 'array', bookType: format === 'xls' ? 'biff8' : 'xlsx' }); transfer.items.add(new File([data], '名单.' + format)); }
    const input = document.getElementById('referenceFile'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
  });
  await waitFor(() => cdp.evaluate(() => document.getElementById('referenceFileSummary').textContent.includes('3 个文件') && !document.getElementById('recognizeBtn').disabled));
  check('图片可同时加入CSV、真实XLS和XLSX参考表，中文姓名和完整长学号正确读取', await cdp.evaluate(() => ['2026080101', '2026080102', '2026080103', '2026080104', '识别甲', '识别丁'].every(value => document.getElementById('referencePreview').textContent.includes(value)) && !document.getElementById('imagePreview').hidden));
  await click('#recognizeBtn'); await waitFor(() => cdp.evaluate(() => !document.getElementById('importPreviewSection').hidden));
  check('视觉识别请求使用图像输入，结果含可核对的提示', visionRequests === 1 && await cdp.evaluate(() => document.getElementById('importWarnings').textContent.includes('请核对')));
  check('模型提示词要求判断讲台并旋转到上方，结果预览自动移除全空行列', await cdp.evaluate(() => document.getElementById('importWarnings').textContent.includes('3 个全空行和 3 个全空列') && document.querySelector('[data-preview-row="1"] [data-field="row"]').value === '1' && document.querySelector('[data-preview-row="1"] [data-field="col"]').value === '2'));
  check('模型联合图片与表格推断两位学号，预览显示原学号及候选核对提示', await cdp.evaluate(() => document.querySelector('[data-preview-row="0"] [data-field="id"]').value === '1' && document.getElementById('importWarnings').textContent.includes('2026080101') && document.getElementById('importWarnings').textContent.includes('候选 01')));
  await click('#applyImportBtn');
  check('识别导入保留单个空座与整理后坐标，API Key 不进入本机记录', await cdp.evaluate(key => { const raw = localStorage.getItem(key), s = JSON.parse(raw); return s.cols === 3 && s.students[1].col === 2 && s.students[1].row === 1 && s.students[3].col === 3 && document.querySelectorAll('#rosterSeats .empty').length === 2 && !raw.includes('qa-temporary-key'); }, KEY));
  await click('.navigation [data-nav="data"]');
  await cdp.evaluate(backup => { const transfer = new DataTransfer(); transfer.items.add(new File([backup], '班级备份.json', { type: 'application/json' })); const input = document.getElementById('backupFile'); input.files = transfer.files; input.dispatchEvent(new Event('change')); }, backup);
  await waitFor(() => cdp.evaluate(() => document.getElementById('confirmDialog').open)); await click('#confirmActionBtn');
  await waitFor(() => cdp.evaluate(() => document.getElementById('drawBtn').getAttribute('aria-busy') === 'false'));
  assert.deepEqual(await cdp.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY), JSON.parse(backup), 'Backup restores all class data including lifetime fairness');
  check('数据页兼容恢复旧 JSON 备份，还原班级、历史、累计公平次数及随机状态', true);
  await reloadStoredState(backup);
  check('刷新后恢复当前结果、已抽中淡化状态、名单历史与重置按钮', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return s.round === 4 && !document.getElementById('liveBoard').hidden && document.getElementById('stageName').textContent === s.history.at(-1).name && !document.getElementById('resetDrawBtn').hidden && Array.from(document.querySelectorAll('#liveSeats .seen')).every(el => s.counts[el.dataset.liveStudent] > 0) && document.querySelectorAll('#liveSeats .seen').length >= 2; }, KEY));
  check('跨会话刷新保留累计次数与周期出场位置，历史恢复后不会重播入场动画', await cdp.evaluate((key, before) => { const state = JSON.parse(localStorage.getItem(key)), original = JSON.parse(before); return JSON.stringify(state.fairnessStats) === JSON.stringify(original.fairnessStats) && Object.values(state.fairnessStats).every(stats => stats.draws >= 1 && stats.positionSamples >= 1 && stats.positionSum >= 0 && stats.positionSum <= stats.positionSamples) && !document.getElementById('liveSeatScroll').dataset.transition; }, KEY, backup));

  const cancelPoint = await buttonPoint();
  await mouse('mousePressed', cancelPoint); await pause(160); await mouse('mouseMoved', { x: cancelPoint.x + 24, y: cancelPoint.y }); await mouse('mouseReleased', { x: cancelPoint.x + 24, y: cancelPoint.y });
  await pause(650);
  check('按住后移动会取消长按进度，松手也不会抽取或延迟打开菜单', await cdp.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 4 && !document.getElementById('configDialog').open && !document.getElementById('drawBtn').hasAttribute('data-holding'), KEY));
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const cancelTouchPoint = await buttonPoint();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...cancelTouchPoint, radiusX: 4, radiusY: 4, force: 1, id: 3 }] });
  await pause(160); await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); await pause(650);
  check('真实触屏被取消时清空长按状态，并保持抽取轮数', await cdp.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 4 && !document.getElementById('configDialog').open && !document.getElementById('drawBtn').hasAttribute('data-holding'), KEY));
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  const shortHoldPoint = await buttonPoint();
  await mouse('mousePressed', shortHoldPoint); await pause(250);
  const shortHoldFill = await cdp.evaluate(holdProgressSnapshot, 'drawBtn');
  await mouse('mouseReleased', shortHoldPoint);
  const shortReleaseStart = await cdp.evaluate(holdProgressSnapshot, 'drawBtn'); await pause(80);
  const shortReleaseLater = await cdp.evaluate(holdProgressSnapshot, 'drawBtn');
  // Repress before further CDP reads consume the short retract window.
  await mouse('mousePressed', shortHoldPoint);
  check('未满500毫秒松开主按钮时进度从当前比例逆缩，缩回期间暂缓抽选且不会打开配置', shortHoldFill.holding && shortHoldFill.scale > 0 && shortReleaseStart.releasing && shortReleaseStart.progress > 0 && shortReleaseLater.scale < shortReleaseStart.scale && await cdp.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 4 && !document.getElementById('configDialog').open, KEY));
  check('进度缩回过程中再次按下主按钮，取消此前待触发的抽选并重新开始计时', await cdp.evaluate(key => document.getElementById('drawBtn').hasAttribute('data-holding') && !document.getElementById('drawBtn').hasAttribute('data-hold-releasing') && JSON.parse(localStorage.getItem(key)).round === 4, KEY));
  await waitFor(() => cdp.evaluate(() => document.getElementById('configDialog').open), 1800); await mouse('mouseReleased', shortHoldPoint);
  await waitFor(() => cdp.evaluate(() => !document.getElementById('drawBtn').hasAttribute('data-hold-releasing')), 1500);
  check('缩回中重新长按达到500毫秒只打开菜单，不重复抽选或消耗随机状态', await cdp.evaluate((key, expected) => localStorage.getItem(key) === expected && document.getElementById('configDialog').open, KEY, backup));
  await closeConfig();
  const escapeHoldPoint = await buttonPoint();
  await mouse('mousePressed', escapeHoldPoint);
  await waitFor(() => cdp.evaluate(() => document.getElementById('configDialog').open), 1800);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(() => cdp.evaluate(() => !document.getElementById('configDialog').open), 1800);
  await mouse('mouseReleased', escapeHoldPoint); await pause(650);
  check('仍按住主按钮时用Escape关闭长按菜单，随后松手不会意外抽选或重新打开配置', await cdp.evaluate((key, expected) => localStorage.getItem(key) === expected && !document.getElementById('configDialog').open && !document.getElementById('drawBtn').hasAttribute('data-holding') && !document.getElementById('drawBtn').hasAttribute('data-hold-releasing'), KEY, backup));
  await cdp.evaluate(() => document.getElementById('drawBtn').focus());
  await Promise.all([
    cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 }),
    cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Space', key: ' ', windowsVirtualKeyCode: 32, autoRepeat: true }),
    cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 })
  ]); await drawFinished();
  check('空格短按支持键盘抽取，按键重复事件不会多记一轮', await cdp.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 5, KEY));
  await cdp.evaluate(() => document.getElementById('drawBtn').focus());
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 });
  await waitFor(() => cdp.evaluate(() => document.getElementById('configDialog').open), 3000);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 });
  check('回车长按打开配置，松开保持原轮数', await cdp.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 5 && document.getElementById('configDialog').open, KEY));
  await closeConfig();
  await cdp.evaluate(() => Math.random = () => .9); await click('#drawBtn');
  const busyPoint = await buttonPoint(); await mouse('mousePressed', busyPoint); await drawFinished(); await mouse('mouseReleased', busyPoint); await pause(180);
  check('动画期间按住按钮，在结果揭晓后松开也不会触发第二轮', await cdp.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 6 && document.getElementById('drawBtn').getAttribute('aria-busy') === 'false' && !document.getElementById('configDialog').open, KEY));

  const directionState = await cdp.evaluate(() => {
    const students = Array.from({ length: 40 }, (_, i) => ({ id: String(i + 1), name: '座位' + (i + 1), row: Math.floor(i / 8) + 1, col: i % 8 + 1, active: true }));
    for (let seed = 1; seed < 2000; seed++) {
      const s = window.DrawCore.createState(students, seed); s.settings.strategy = 'manual'; s.settings.manualMode = 'normal'; window.DrawCore.draw(s);
      if (s.lastId === '19') { s.settings.manualMode = 'direction'; s.settings.direction = 'right'; s.settings.directionRounds = 'random'; s.settings.directionMin = 3; s.settings.directionMax = 5; return s; }
    }
    throw new Error('Could not seed center seat');
  });
  await reloadStoredState(directionState); await cdp.evaluate(() => Math.random = () => .9); await installDirectionFrameProbe(); await click('#drawBtn');
  await waitFor(() => cdp.evaluate(() => document.getElementById('seatArrow').classList.contains('spinning-arrow') && new DOMMatrix(getComputedStyle(document.getElementById('liveSeatMap')).transform).a > 1), 1500);
  const directionStarted = await cdp.evaluate(() => {
    const svg = document.getElementById('seatArrow'), map = getComputedStyle(document.getElementById('liveSeatMap')), anchor = document.querySelector('#liveSeats .anchor'), nearby = Array.from(document.querySelectorAll('#liveSeats .in-neighborhood,#liveSeats .anchor')), outside = document.querySelector('#liveSeats [data-live-student="1"]');
    const top = getComputedStyle(document.getElementById('liveBoard'), '::before'), font = Array.from(document.fonts).find(face => face.family.replace(/["']/g, '') === 'Material Symbols Outlined');
    const topChannels = Array.from(top.backgroundImage.matchAll(/rgba?\(([^)]+)\)|color\(srgb\s+([^)]+)\)/gi), match => {
      const srgb = Boolean(match[2]), values = (match[2] || match[1]).replace(/,/g, ' ').trim().split(/\s*\/\s*|\s+/);
      const channels = values.slice(0, 3).map(value => parseFloat(value) * (value.endsWith('%') ? 2.55 : srgb ? 255 : 1));
      const alpha = values[3] == null ? 1 : parseFloat(values[3]) / (values[3].endsWith('%') ? 100 : 1);
      return [...channels, alpha];
    }).find(channels => channels.length === 4 && channels.every(Number.isFinite) && channels[3] > 0) || [];
    return { rotating: !document.getElementById('directionVisual').hidden && document.getElementById('directionSpinner').classList.contains('spinning') && !svg.hasAttribute('hidden') && svg.classList.contains('spinning-arrow') && map.transform !== 'none' && document.getElementById('exitChainBtn').disabled,
      neighborhood: anchor?.dataset.liveStudent === '19' && nearby.length === 9 && nearby.every(el => { const id = Number(el.dataset.liveStudent), row = Math.floor((id - 1) / 8) + 1, col = (id - 1) % 8 + 1; return Math.abs(row - 3) <= 1 && Math.abs(col - 3) <= 1; }) && Number(getComputedStyle(outside).opacity) < .1,
      scrims: topChannels.length === 4 && topChannels[3] > 0 && topChannels[1] > topChannels[0] && topChannels[1] > topChannels[2] && Number(getComputedStyle(document.getElementById('drawVisual')).zIndex) > Number(top.zIndex) && getComputedStyle(document.querySelector('.draw-screen'), '::after').pointerEvents === 'none' && font?.status === 'loaded' };
  });
  await waitFor(async () => centeredOn(await cdp.evaluate(cameraFocusSnapshot), '19', true), 1000);
  const directionCameraStart = await cdp.evaluate(cameraFocusSnapshot);
  const directionGlow = await cdp.evaluate(() => {
    const anchor = document.querySelector('#liveSeats .anchor');
    if (!anchor) return false;
    const glow = getComputedStyle(anchor, '::before');
    return glow.backgroundImage.includes('radial-gradient') && Number(glow.opacity) > .05 && glow.pointerEvents === 'none' && glow.animationName === 'none';
  });
  await screenshot('direction-spinning.png');
  const directionFrames = await cdp.evaluate(async () => { await window.__qaDirectionTrace.done; return window.__qaDirectionTrace.frames; });
  check('方向抽取放大上一人附近的座位网格，并显示真实 SVG 旋转指针', directionStarted.rotating);
  check('方向旋转顶部提示与 Material 箭头显示在绿色渐隐背景前，动画期间底部遮罩随操作淡化', directionStarted.scrims && directionFrames.some(frame => frame.bottomOpacity < .3));
  check('方向指针的实际 SVG 路径在动画帧之间转动', new Set(directionFrames.map(frame => frame.arrow)).size > 1);
  check('方向镜头以上一人为九宫格中心，周围座位保留、其余区域淡化', directionStarted.neighborhood);
  if (directionFrames.length < 6 || directionFrames.some(frame => !frame.matches || !frame.green)) console.log('Direction frame diagnostics: ' + JSON.stringify(directionFrames));
  check('方向旋转每帧指向的九宫格邻座与唯一绿色候选、方向文字及姓名一致', directionFrames.length >= 6 && directionFrames.every(frame => frame.matches && frame.green));
  check('方向旋转会直接展示至少三个实际邻座，包括斜向邻座', new Set(directionFrames.map(frame => frame.sector)).size >= 3 && directionFrames.some(frame => frame.sector % 2 === 1));
  check('桌面方向旋转的镜头聚焦上一位，旋转中心位于动画视口几何中心', directionCameraStart.spinning && centeredOn(directionCameraStart, '19', true));
  await drawFinished();
  await waitFor(() => cdp.evaluate(() => !document.getElementById('seatArrow').hasAttribute('hidden')));
  check('随机连坐持续 3～5 轮，抽中上一人的右侧紧邻座位', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), r = s.history.at(-1); return r.mode === 'direction' && !r.fallback && r.before.lastId === '19' && r.studentId === '20' && s.lock.direction === 'right' && s.lock.remaining >= 2 && s.lock.remaining <= 4; }, KEY));
  check('连坐时底部用绿色显示剩余轮数，文字数值与真实方向锁一致', await cdp.evaluate(key => { const state = JSON.parse(localStorage.getItem(key)), label = document.getElementById('chainRemaining'), channels = getComputedStyle(label).color.match(/\d+/g).map(Number); return !label.hidden && label.textContent.includes(String(state.lock.remaining)) && channels[1] > channels[0] && channels[1] > channels[2]; }, KEY));
  check('方向结果显示从上一个人指向当前人的绿色 SVG 箭头与高亮座位', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), svg = document.getElementById('seatArrow'), path = document.getElementById('seatArrowPath'); return !svg.hasAttribute('hidden') && svg.getClientRects().length > 0 && getComputedStyle(svg).display !== 'none' && /^M[-\d. ]+L[-\d. ]+$/.test(path.getAttribute('d')) && document.querySelector('#liveSeats [data-live-student="19"]').classList.contains('seen') && document.querySelector('#liveSeats .current').dataset.liveStudent === s.lastId && !document.getElementById('directionSpinner').classList.contains('spinning'); }, KEY));
  check('桌面 40 人座位网格会根据可用高度布局，所有行完整显示', await cdp.evaluate(() => { const view = document.getElementById('liveSeatScroll').getBoundingClientRect(); return Array.from(document.querySelectorAll('#liveSeats [data-live-student]')).every(el => { const seat = el.getBoundingClientRect(); return seat.top >= view.top - 1 && seat.bottom <= view.bottom + 1; }); }));
  check('退出连坐次要按钮位于抽人按钮右侧', await cdp.evaluate(() => { const exit = document.getElementById('exitChainBtn'), a = document.getElementById('drawBtn').getBoundingClientRect(), b = exit.getBoundingClientRect(); return !exit.hidden && !exit.disabled && b.left >= a.right && Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) < 2; }));
  check('桌面抽人、重置与退出连坐三个按钮保持相同高度和上下边缘', await cdp.evaluate(equalHomeButtonHeights));
  check('绿色方向箭头保留近光，旋转中心使用静态局部光晕', directionGlow && await cdp.evaluate(() => {
    const arrow = document.getElementById('seatArrow'), path = document.getElementById('seatArrowPath'), style = getComputedStyle(path);
    const channels = style.stroke.match(/[\d.]+/g)?.map(Number) || [];
    return !arrow.hasAttribute('hidden') && arrow.getClientRects().length > 0 && style.filter.includes('drop-shadow(') && channels.length >= 3 && channels[1] > channels[0] && channels[1] > channels[2];
  }));
  await screenshot('direction-result.png');
  for (const width of [390, 320]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    await pause(200);
    check(width + 'px 连坐结果下重置、抽人、退出三按钮完整显示且无横向溢出', await cdp.evaluate(() => { const buttons = ['resetDrawBtn', 'drawBtn', 'exitChainBtn'].map(id => document.getElementById(id)), boxes = buttons.map(el => el.getBoundingClientRect()); return buttons.every(el => !el.hidden && !el.disabled) && boxes.every(box => box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && box.height >= 44) && boxes[0].right <= boxes[1].left && boxes[1].right <= boxes[2].left && document.documentElement.scrollWidth <= innerWidth; }));
    check(width + 'px 手机三按钮高度一致，主次按钮边缘对齐', await cdp.evaluate(equalHomeButtonHeights));
    const narrowActions = await cdp.evaluate(minimumUiButtonWidths);
    if (narrowActions.length) console.log(width + 'px minimum width diagnostics: ' + JSON.stringify(narrowActions));
    check(width + 'px 手机重置、抽人及退出连坐均不窄于正方形，图标和文本仍可点击', narrowActions.length === 0 && (await cdp.evaluate(seatLayoutSnapshot)).controlsFit);
    await screenshot('direction-three-actions-' + width + '.png');
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await waitFor(() => cdp.evaluate(() => innerWidth > 700 && document.getElementById('drawBtn').getBoundingClientRect().left > innerWidth / 4));
  await pause(450);
  const beforeReset = await cdp.evaluate(key => localStorage.getItem(key), KEY);
  const resetPoint = await cdp.evaluate(() => { const r = document.getElementById('resetDrawBtn').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...resetPoint, radiusX: 4, radiusY: 4, force: 1, id: 7 }] }); await pause(250);
  const resetHoldSample = await cdp.evaluate((key, before) => {
    const button = document.getElementById('resetDrawBtn'), style = getComputedStyle(button, '::before');
    const animation = button.getAnimations({ subtree: true }).find(a => a.animationName === 'hold-fill');
    const timing = animation?.effect?.getTiming(), color = style.backgroundColor.match(/\d+/g).map(Number);
    return { holding: button.hasAttribute('data-reset-holding'), scale: new DOMMatrix(style.transform).a, elapsed: animation?.currentTime,
      duration: timing?.duration, easing: style.animationTimingFunction, red: color[0] > color[1] && color[0] > color[2], unchanged: localStorage.getItem(key) === before };
  }, KEY, beforeReset);
  console.log('Reset hold sample: ' + JSON.stringify(resetHoldSample));
  check('重置长按期间从左向右填充红色进度条，未满500毫秒时不清空状态', resetHoldSample.holding && resetHoldSample.scale > 0 && resetHoldSample.scale < 1 && resetHoldSample.elapsed >= 100 && resetHoldSample.elapsed < 500 && resetHoldSample.duration === 500 && resetHoldSample.easing.includes('cubic-bezier') && resetHoldSample.red && resetHoldSample.unchanged);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const resetReleaseStart = await cdp.evaluate(holdProgressSnapshot, 'resetDrawBtn'); await pause(80);
  const resetReleaseLater = await cdp.evaluate(holdProgressSnapshot, 'resetDrawBtn');
  check('提前松开重置时红色进度从当前比例逆向缩回，状态不变', resetReleaseStart.releasing && resetReleaseStart.progress > 0 && resetReleaseLater.scale < resetReleaseStart.scale && await cdp.evaluate((key, before) => localStorage.getItem(key) === before, KEY, beforeReset));
  await screenshot('reset-red-progress.png');
  await waitFor(() => cdp.evaluate(() => !document.getElementById('resetDrawBtn').hasAttribute('data-hold-releasing')), 1500);
  check('提前松开重置取消红色进度，抽取记录和连坐状态保持不变', await cdp.evaluate((key, before) => !document.getElementById('resetDrawBtn').hasAttribute('data-reset-holding') && localStorage.getItem(key) === before && !document.getElementById('resetDrawBtn').hidden, KEY, beforeReset));
  const resetHeldAt = Date.now(); await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...resetPoint, radiusX: 4, radiusY: 4, force: 1, id: 8 }] });
  await waitFor(() => cdp.evaluate(() => document.getElementById('liveSeatScroll').dataset.transition === 'exit'), 1800);
  const resetTriggerElapsed = Date.now() - resetHeldAt, resetExit = await cdp.evaluate(seatLifecycleSnapshot);
  check('重置按满500毫秒后先白亮退场，退场期间保留统计并阻止再次抽取', resetTriggerElapsed >= 470 && resetTriggerElapsed < 1400 && resetExit.phase === 'exit' && resetExit.busy && resetExit.frames.filter(frame => frame.running).every(frame => frame.whiteFrames) && await cdp.evaluate((key, before) => localStorage.getItem(key) === before && document.getElementById('drawBtn').getAttribute('aria-busy') === 'true', KEY, beforeReset));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await screenshot('reset-white-exit.png');
  await waitFor(() => cdp.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 0, KEY), 4000); await drawFinished();
  check('退场完成后重置清空本轮历史、次数、周期标记、冷却、方向锁与上一位，松手不抽人', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return s.round === 0 && s.history.length === 0 && s.cycleSeen.length === 0 && Object.keys(s.counts).length === 0 && Object.keys(s.lastSeen).length === 0 && s.lock === null && s.lastId === null && !document.getElementById('liveSeatScroll').dataset.transition && document.querySelectorAll('#liveSeats .seat-transition-running').length === 0; }, KEY));
  check('重置保持名单姓名坐标、规则设置、班级资料及伪随机种子状态', await cdp.evaluate((key, before) => { const s = JSON.parse(localStorage.getItem(key)), original = JSON.parse(before); return JSON.stringify(s.students) === JSON.stringify(original.students) && JSON.stringify(s.settings) === JSON.stringify(original.settings) && s.cols === original.cols && s.className === original.className && s.demo === original.demo && s.rngState === original.rngState; }, KEY, beforeReset));
  check('手动重置保留跨会话累计次数及出场先后公平反馈，继续影响下一轮概率', await cdp.evaluate((key, before) => JSON.stringify(JSON.parse(localStorage.getItem(key)).fairnessStats) === JSON.stringify(JSON.parse(before).fairnessStats), KEY, beforeReset));
  await waitFor(() => cdp.evaluate(minimalHome), 2000);
  check('确认重置回到只有抽人按钮的纯黑首页', await cdp.evaluate(minimalHome));
  await screenshot('reset-home.png');
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await reloadStoredState(directionState); await cdp.evaluate(() => Math.random = () => .9); await click('#drawBtn'); await drawFinished();
  const beforeChainExit = await cdp.evaluate(key => JSON.parse(localStorage.getItem(key)).round, KEY);
  await cdp.evaluate(() => document.getElementById('exitChainBtn').focus());
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  check('聚焦退出连坐按钮时 Space 只激活本控件，不抽选或打开设置', await cdp.evaluate((key, round) => JSON.parse(localStorage.getItem(key)).round === round && !document.getElementById('configDialog').open && document.getElementById('drawBtn').getAttribute('aria-busy') === 'false', KEY, beforeChainExit));
  check('退出连坐立即解除方向锁、隐藏次要按钮，下一轮恢复普通随机', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return s.lock === null && s.settings.manualMode === 'normal' && document.getElementById('exitChainBtn').hidden; }, KEY));
  check('退出连坐同时移除剩余轮数提示', await cdp.evaluate(() => document.getElementById('chainRemaining').hidden));
  await click('#drawBtn'); await drawFinished();
  check('退出后的下一轮采用普通随机且只增加一次记录', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return s.round === 3 && s.history.at(-1).mode === 'normal'; }, KEY));
  const autoDirection = await cdp.evaluate(state => {
    for (let rngState = 1; rngState < 2000; rngState++) { const original = window.DrawCore.clone(state); original.settings.direction = 'auto'; original.settings.directionRounds = 'random'; original.settings.directionMin = 5; original.settings.directionMax = 5; original.rngState = rngState; const next = window.DrawCore.clone(original), records = Array.from({ length: 3 }, () => window.DrawCore.draw(next)); if (records.every(r => r.mode === 'direction' && !r.fallback) && new Set(records.map(r => r.direction)).size > 1) return original; }
    throw new Error('No changing direction seed');
  }, directionState);
  await reloadStoredState(autoDirection); await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  for (let i = 0; i < 3; i++) { await click('#drawBtn'); await drawFinished(); }
  check('随机方向在同一连坐锁定内每轮重新选择，剩余轮数递减而方向实际变化', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), records = s.history.slice(-3); return new Set(records.map(r => r.direction)).size > 1 && records.every(r => r.mode === 'direction' && !r.fallback) && s.lock.remaining === 2 && document.querySelector('#liveSeats .current').dataset.liveStudent === s.lastId && document.getElementById('lockLabel').textContent.includes('每轮重新随机方向'); }, KEY));
  check('自定义5至5轮锁定时主页剩余轮数随每轮抽选递减到2', await cdp.evaluate(() => !document.getElementById('chainRemaining').hidden && document.getElementById('chainRemaining').textContent.includes('2')));
  const twoRoundDirection = { ...directionState, settings: { ...directionState.settings, directionMin: 2, directionMax: 2, directionRounds: 'random' } };
  await reloadStoredState(twoRoundDirection); await click('#drawBtn'); await drawFinished();
  check('连坐范围2至2轮时第一轮后只保留1轮，并用绿色剩余提示显示', await cdp.evaluate(key => { const state = JSON.parse(localStorage.getItem(key)); return state.settings.directionMin === 2 && state.settings.directionMax === 2 && state.lock?.remaining === 1 && !document.getElementById('chainRemaining').hidden && document.getElementById('chainRemaining').textContent.includes('1'); }, KEY));
  await click('#drawBtn'); await drawFinished();
  check('自定义2轮连坐第二次抽选后自动结束，剩余提示与退出按钮一起隐藏', await cdp.evaluate(key => { const state = JSON.parse(localStorage.getItem(key)); return state.round === 3 && state.history.slice(-2).every(record => record.mode === 'direction') && state.lock === null && document.getElementById('chainRemaining').hidden && document.getElementById('exitChainBtn').hidden; }, KEY));
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });

  const pausedOriginState = await cdp.evaluate(state => {
    const base = window.DrawCore.clone(state); base.students.forEach(student => student.active = ['20', '21'].includes(student.id));
    for (let rngState = 1; rngState < 2000; rngState++) {
      const candidate = window.DrawCore.clone(base); candidate.rngState = rngState;
      const next = window.DrawCore.clone(candidate), record = window.DrawCore.draw(next);
      if (record.studentId === '20' && record.direction === 'right' && !record.fallback && record.reason.includes('接力起点')) return candidate;
    }
    throw new Error('Could not seed new origin adjacent to paused previous student');
  }, directionState);
  await reloadStoredState(pausedOriginState); await cdp.evaluate(() => Math.random = () => .9); await click('#drawBtn'); await pause(150);
  check('暂停上一位后先重新抽连坐起点，动画不会围绕暂停者旋转或绘制箭头', await cdp.evaluate(() => document.querySelector('.draw-screen').dataset.animation === 'normal' && document.getElementById('seatArrow').hasAttribute('hidden') && !document.getElementById('seatArrow').classList.contains('spinning-arrow') && !document.querySelector('#liveSeats .anchor')));
  await drawFinished();
  check('新起点即使碰巧紧邻暂停的上一位，结果也不会误画从暂停者出发的箭头', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), r = s.history.at(-1); return r.before.lastId === '19' && !s.students.find(student => student.id === '19').active && r.studentId === '20' && r.reason.includes('接力起点') && s.lock?.direction === 'right' && document.getElementById('seatArrow').hasAttribute('hidden') && document.querySelector('#liveSeats .current').dataset.liveStudent === '20'; }, KEY));

  for (const source of ['date', 'time', 'datetime']) {
    const sourceLabel = { date: '日期', time: '时间', datetime: '320px 日期与时间' }[source];
    if (source === 'datetime') await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 780, deviceScaleFactor: 1, mobile: true });
    const timeState = await cdp.evaluate(source => { const students = Array.from({ length: 40 }, (_, i) => ({ id: String(i + 1), name: '时间' + (i + 1), row: Math.floor(i / 8) + 1, col: i % 8 + 1, active: true })); const s = window.DrawCore.createState(students, 12345); s.settings.strategy = 'manual'; s.settings.manualMode = 'time'; s.settings.timeSource = source; s.settings.timeSelection = 'random'; return s; }, source);
    await reloadStoredState(timeState); await installLiveClock();
    const initialClock = await cdp.evaluate(source => window.DrawCore.dateDigits(new Date(), source), source);
    await click('#drawBtn'); await waitForScene('time'); await pause(160);
    check(sourceLabel + '模式先实时扫描可用连续两位，揭晓前不提交抽取记录', await cdp.evaluate((key, source) => { const s = JSON.parse(localStorage.getItem(key)), spans = Array.from(document.querySelectorAll('#timeDigits [data-time-position]')), digits = spans.map(el => el.textContent).join(''), chosen = spans.filter(el => el.classList.contains('chosen')), positions = chosen.map(el => Number(el.dataset.timePosition)), current = new Date(), matchingClock = [current, new Date(current.valueOf() - 200)].some(date => window.DrawCore.dateDigits(date, source) === digits), eligible = new Set(window.DrawCore.probabilities(s).map(item => item.student.id)); return !document.getElementById('timeVisual').hidden && document.getElementById('drawBtn').getAttribute('aria-busy') === 'true' && spans.length === { date: 8, time: 6, datetime: 14 }[source] && matchingClock && chosen.length === 2 && positions[1] === positions[0] + 1 && eligible.has(String(Number(chosen.map(el => el.textContent).join('')))) && s.round === 0 && s.history.length === 0 && window.__qaDrawCalls === 0 && document.getElementById('timeCaption').textContent.includes('正在选取'); }, KEY, source));
    const pairMark = await cdp.evaluate(() => ({ at: performance.now(), positions: Array.from(document.querySelectorAll('#timeDigits .chosen')).map(el => el.dataset.timePosition).join(',') }));
    let movedPair;
    // A 100 ms CDP poll can repeatedly land on the same position while the
    // early 60–100 ms scan alternates. Observe real DOM mutations so a brief
    // valid intermediate pair remains measurable without extending the scan.
    await waitFor(async () => { movedPair = await cdp.evaluate((key, mark) => {
      const s = JSON.parse(localStorage.getItem(key));
      const sample = window.__qaTimeScanSamples.find(frame => {
        const positions = frame.positions.split(',').map(Number);
        return frame.at >= mark.at && frame.positions !== mark.positions && positions.length === 2 && positions[1] === positions[0] + 1 && frame.round === 0 && frame.calls === 0;
      });
      return { moved: !!sample, eligible: sample?.eligible === true, uncommitted: s.round === 0 && s.history.length === 0 && window.__qaDrawCalls === 0 };
    }, KEY, pairMark); return movedPair.moved; }, 650);
    check(sourceLabel + '取位动画会移动到其他有效位置，扫描阶段仍是零轮', movedPair.moved && movedPair.eligible && movedPair.uncommitted);
    if (source !== 'date') {
      await waitFor(() => cdp.evaluate(initial => !document.getElementById('timeVisual').classList.contains('is-paired') && Array.from(document.querySelectorAll('#timeDigits [data-time-position]')).map(el => el.textContent).join('') !== initial, initialClock), 1000);
      check(sourceLabel + '扫描期间秒数实时跳动，尚未冻结数字或提交本轮', await cdp.evaluate((key, initial) => Array.from(document.querySelectorAll('#timeDigits [data-time-position]')).map(el => el.textContent).join('') !== initial && !document.getElementById('timeVisual').classList.contains('is-paired') && JSON.parse(localStorage.getItem(key)).round === 0 && window.__qaDrawCalls === 0, KEY, initialClock));
    }
    check(sourceLabel + '扫描阶段以全屏浮层展示本轮日期或时间', await cdp.evaluate(() => { const screen = document.querySelector('.draw-screen'), overlay = document.getElementById('timeVisual').getBoundingClientRect(); return screen.matches('.is-animating[data-animation="time"]') && overlay.width >= innerWidth * .9 && overlay.height >= innerHeight * .9; }));
    check(sourceLabel + '大字扫描期间座位表淡化，前景保留独立的局部光池', await cdp.evaluate(() => { const style = getComputedStyle(document.getElementById('liveSeatScroll')), visual = document.getElementById('timeVisual'), light = getComputedStyle(visual, '::before'); return Number(style.opacity) < .3 && Number(getComputedStyle(visual).zIndex) >= 20 && light.backgroundImage.includes('radial-gradient(') && light.pointerEvents === 'none'; }));
    if (source === 'datetime') check('320px 的完整日期时间扫描字形不会超出视口边缘', await cdp.evaluate(() => Array.from(document.querySelectorAll('#timeDigits span,#timeDigits i')).every(el => { const box = el.getBoundingClientRect(); return box.left >= -1 && box.right <= innerWidth + 1; })));
    await screenshot(source + '-selecting.png');
    await waitFor(() => cdp.evaluate(() => document.getElementById('timeVisual').classList.contains('is-paired')), 2500);
    if (source === 'date') {
      const cadence = await cdp.evaluate(() => {
        const changes = [];
        for (const frame of window.__qaTimeScanSamples) {
          if (!frame.positions || frame.round || frame.calls || changes.at(-1)?.positions === frame.positions) continue;
          changes.push(frame);
        }
        const intervals = changes.slice(1).map((frame, i) => frame.at - changes[i].at);
        const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
        return { count: intervals.length, early: mean(intervals.slice(0, 3)), late: mean(intervals.slice(-3)) };
      });
      console.log('Time scan cadence: ' + JSON.stringify(cadence));
      check('时间取位扫描采用非线性减速节拍，后段停留显著长于前段', cadence.count >= 7 && cadence.early > 0 && cadence.late > cadence.early * 1.6);
    }
    await waitFor(() => cdp.evaluate(() => Array.from(document.querySelectorAll('#timeDigits .time-digit:not(.chosen)')).every(el => Number(getComputedStyle(el).opacity) < .05 || el.getBoundingClientRect().width < 2)), 1500);
    check(sourceLabel + '扫描后只留下两位绿色数字，其他数字与分隔符淡出收缩', await cdp.evaluate(key => { const rule = JSON.parse(localStorage.getItem(key)).history.at(-1).timeRule, pair = Array.from(document.querySelectorAll('#timeDigits .chosen')); return pair.length === 2 && pair.map(el => el.textContent).join('') === rule.picked && pair.every(el => { const [r, g, b] = getComputedStyle(el).color.match(/\d+/g).map(Number); return g > r && g > b; }) && document.getElementById('drawBtn').getAttribute('aria-busy') === 'true'; }, KEY));
    await screenshot(source + '-paired.png');
    await waitFor(() => cdp.evaluate(() => document.getElementById('timeVisual').classList.contains('is-named')), 2000);
    await pause(180);
    await waitFor(() => cdp.evaluate(() => window.__qaTimeNameSamples.some(frame => frame.active && frame.busy && frame.opacity > .2 && frame.clear && frame.text === frame.expected)), 1800);
    check(sourceLabel + '两位数字向左让位，右侧出现本轮学生姓名', await cdp.evaluate(() => window.__qaTimeNameSamples.some(frame => frame.active && frame.busy && frame.opacity > .2 && frame.clear && frame.text === frame.expected)));
    await screenshot(source + '-named.png');
    if (source === 'datetime') check('320px 揭晓时两位数字与完整姓名均位于视口内', await cdp.evaluate(() => { const name = document.getElementById('timeMatchName').getBoundingClientRect(), chosen = Array.from(document.querySelectorAll('#timeDigits .chosen')).map(el => el.getBoundingClientRect()); return name.left >= 0 && name.right <= innerWidth + 1 && chosen.every(box => box.left >= 0 && box.right <= innerWidth + 1); }));
    await waitFor(() => cdp.evaluate(() => document.getElementById('timeVisual').classList.contains('is-fading')), 2000);
    await waitFor(() => cdp.evaluate(() => window.__qaTimeFadeSamples.some(frame => frame.active && frame.busy && frame.opacity < .9)), 1500);
    check(sourceLabel + '姓名揭晓后浮层整体淡出，再恢复座位焦点', await cdp.evaluate(() => window.__qaTimeFadeSamples.some(frame => frame.active && frame.busy && frame.opacity < .9)));
    await drawFinished();
    check(sourceLabel + '模式最终将随机连续两位绿色高亮，数字与记录一致', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), rule = s.history.at(-1).timeRule, chosen = Array.from(document.querySelectorAll('#timeDigits .chosen')); return rule.selection === 'random' && rule.positions.length === 2 && rule.positions[1] === rule.positions[0] + 1 && chosen.map(el => Number(el.dataset.timePosition)).join(',') === rule.positions.join(',') && chosen.map(el => el.textContent).join('') === rule.picked && chosen.every(el => { const [r, g, b] = getComputedStyle(el).color.match(/\d+/g).map(Number); return g > r && g > b; }) && document.getElementById('timeCaption').textContent.includes(rule.picked) && s.round === 1 && s.history.length === 1; }, KEY));
    check(sourceLabel + '在揭晓时只提交一次，最终时间快照、学号与伪随机结果一致', await cdp.evaluate((key, before) => { const s = JSON.parse(localStorage.getItem(key)), record = s.history.at(-1), expected = window.DrawCore.clone(before), r = window.__qaOriginalDraw(expected, new Date(record.time)); return window.__qaDrawCalls === 1 && record.mode === 'time' && !record.fallback && record.timeRule.digits === window.DrawCore.dateDigits(new Date(record.time), record.timeRule.source) && record.timeRule.number === Number(record.studentId) && r.studentId === record.studentId && expected.rngState === s.rngState && JSON.stringify(expected.counts) === JSON.stringify(s.counts) && record.before.rngState === before.rngState; }, KEY, timeState));
    check(sourceLabel + '浮层揭晓完毕后消失，主页恢复座位表与底部按钮', await cdp.evaluate(() => { const visual = document.getElementById('timeVisual'); return (visual.hidden || Number(getComputedStyle(visual).opacity) < .05) && !document.querySelector('.draw-screen').classList.contains('is-animating') && !document.getElementById('liveBoard').hidden && document.getElementById('drawBtn').getAttribute('aria-busy') === 'false'; }));
    await pause(30);
    const seatVisibility = await cdp.evaluate(() => { const seat = document.querySelector('#liveSeats .current').getBoundingClientRect(), viewport = document.getElementById('liveSeatScroll').getBoundingClientRect(), scroll = document.getElementById('liveSeatScroll'); return { seat: { top: seat.top, bottom: seat.bottom, left: seat.left, right: seat.right }, viewport: { top: viewport.top, bottom: viewport.bottom, left: viewport.left, right: viewport.right }, scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight, visible: seat.top >= viewport.top - 1 && seat.bottom <= viewport.bottom + 1 && seat.left >= viewport.left - 1 && seat.right <= viewport.right + 1 }; });
    if (!seatVisibility.visible) console.log('Current seat clipping diagnostics: ' + JSON.stringify(seatVisibility));
    check(sourceLabel + '结果自动定位当前焦点，座位姓名和学号完整可见', seatVisibility.visible);
    await screenshot(source + '-result.png');
    if (source === 'datetime') await cdp.send('Emulation.clearDeviceMetricsOverride');
  }

  for (const fixedRule of [{ source: 'time', positions: '6,5', label: '时间逆序取位' }, { source: 'date', positions: '8,2,5', label: '日期乱序三位' }]) {
    const fixedState = await cdp.evaluate(rule => { const students = Array.from({ length: 47 }, (_, i) => { const id = rule.source === 'date' && i === 0 ? '101' : String(i + 1); return { id, name: '定点' + id, row: Math.floor(i / 8) + 1, col: i % 8 + 1, active: true }; }); const s = window.DrawCore.createState(students, 45678); s.settings.strategy = 'manual'; s.settings.manualMode = 'time'; s.settings.timeSource = rule.source; s.settings.timeSelection = 'fixed'; s.settings.positions = rule.positions; return s; }, fixedRule);
    await reloadStoredState(fixedState); await installLiveClock(); await click('#drawBtn'); await waitForScene('time'); await pause(100);
    check(fixedRule.label + '扫描时按指定取位高亮，提交前保持零轮且每个高亮均对应可抽学生', await cdp.evaluate((key, positions) => { const s = JSON.parse(localStorage.getItem(key)), chosen = Array.from(document.querySelectorAll('#timeDigits .chosen')), read = chosen.sort((a, b) => positions.split(',').indexOf(a.dataset.timePosition) - positions.split(',').indexOf(b.dataset.timePosition)).map(el => el.textContent).join(''), eligible = new Set(window.DrawCore.probabilities(s).map(item => item.student.id)); return s.round === 0 && s.history.length === 0 && window.__qaDrawCalls === 0 && chosen.map(el => el.dataset.timePosition).join(',') === positions && eligible.has(String(Number(read))); }, KEY, fixedRule.positions));
    await waitFor(() => cdp.evaluate(() => document.getElementById('timeVisual').classList.contains('is-paired')), 3000);
    await waitFor(() => cdp.evaluate(() => Array.from(document.querySelectorAll('#timeDigits .time-digit:not(.chosen)')).every(el => Number(getComputedStyle(el).opacity) < .05 || el.getBoundingClientRect().width < 2)), 1500);
    await waitFor(() => cdp.evaluate(() => ['paired', 'naming', 'named'].includes(document.getElementById('timeVisual').dataset.phase)), 2000);
    check(fixedRule.label + '的绿色数字按设定顺序排列，视觉阅读结果与真实学号一致', await cdp.evaluate((key, positions) => { const s = JSON.parse(localStorage.getItem(key)), rule = s.history.at(-1).timeRule, pair = Array.from(document.querySelectorAll('#timeDigits .chosen')).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left); return rule.selection === 'fixed' && rule.positions.join(',') === positions && rule.digits === window.DrawCore.dateDigits(new Date(s.history.at(-1).time), rule.source) && pair.map(el => el.textContent).join('') === rule.picked && pair.map(el => el.dataset.timePosition).join(',') === positions && pair.every(el => { const [r, g, b] = getComputedStyle(el).color.match(/\d+/g).map(Number); return g > r && g > b; }); }, KEY, fixedRule.positions));
    check(fixedRule.label + '选定后移除其余数字，动画阶段没有额外记录', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return Array.from(document.querySelectorAll('#timeDigits .time-digit:not(.chosen)')).every(el => Number(getComputedStyle(el).opacity) < .05 || el.getBoundingClientRect().width < 2) && s.round === 1 && s.history.length === 1 && document.getElementById('drawBtn').getAttribute('aria-busy') === 'true'; }, KEY));
    await screenshot(fixedRule.source + '-fixed-paired.png');
    await waitFor(() => cdp.evaluate(() => document.getElementById('timeVisual').classList.contains('is-named')), 2000); await pause(180);
    await waitFor(() => cdp.evaluate(() => window.__qaTimeNameSamples.some(frame => frame.active && frame.opacity > .2 && frame.clear && frame.number === frame.picked && frame.text === frame.expected)), 1800);
    check(fixedRule.label + '左侧数字保持取位顺序，右侧显示实际抽中的姓名', await cdp.evaluate(() => window.__qaTimeNameSamples.some(frame => frame.active && frame.opacity > .2 && frame.clear && frame.number === frame.picked && frame.text === frame.expected)));
    await screenshot(fixedRule.source + '-fixed-named.png'); await drawFinished();
    check(fixedRule.label + '最终只提交一次，取位学号、座位高亮和姓名与记录一致', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), r = s.history.at(-1); return s.round === 1 && s.history.length === 1 && window.__qaDrawCalls === 1 && Number(r.studentId) === r.timeRule.number && document.getElementById('stageName').textContent === r.name && document.querySelector('#liveSeats .current').dataset.liveStudent === r.studentId && document.getElementById('timeCaption').textContent.includes(r.timeRule.picked) && document.getElementById('drawBtn').getAttribute('aria-busy') === 'false'; }, KEY));
  }

  const singlePairState = await cdp.evaluate(() => { const s = window.DrawCore.createState([{ id: '28', name: '可抽二八', row: 1, col: 1 }, { id: '501', name: '长学号', row: 3, col: 3 }], 2468); s.settings.strategy = 'manual'; s.settings.manualMode = 'time'; s.settings.timeSource = 'time'; s.settings.timeSelection = 'random'; return s; });
  await reloadStoredState(singlePairState); await installLiveClock();
  check('时间模式预检查无副作用，随机取位只列出实际能抽出的中间两位', await cdp.evaluate((key) => { const s = JSON.parse(localStorage.getItem(key)), before = JSON.stringify(s), options = window.DrawCore.timeOptions(s, new Date()), mode = window.DrawCore.previewMode(s, new Date()); return JSON.stringify(s) === before && mode === 'time' && options.length === 1 && options[0].rule.positions.join(',') === '3,4' && options[0].student.id === '28' && window.__qaDrawCalls === 0; }, KEY));
  await click('#drawBtn'); await waitForScene('time'); await pause(100);
  check('只有中间两位能匹配时，高亮停留在可用位数而不会假选最后两位', await cdp.evaluate(key => Array.from(document.querySelectorAll('#timeDigits .chosen')).map(el => el.dataset.timePosition).join(',') === '3,4' && JSON.parse(localStorage.getItem(key)).round === 0 && window.__qaDrawCalls === 0, KEY));
  await drawFinished();
  check('随机时间取位实际抽中中间两位对应学生，结果、学号与记录完全一致', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), r = s.history.at(-1); return r.mode === 'time' && r.timeRule.positions.join(',') === '3,4' && r.timeRule.picked === '28' && r.studentId === '28' && document.getElementById('stageName').textContent === '可抽二八' && window.__qaDrawCalls === 1 && s.round === 1; }, KEY));

  const protectedTimeState = await cdp.evaluate(() => {
    for (let seed = 1; seed < 500; seed++) { const s = window.DrawCore.createState([{ id: '14', name: '可抽一四', row: 1, col: 1 }, { id: '28', name: '保护二八', row: 1, col: 2 }, { id: '501', name: '较早抽到', row: 2, col: 1 }], seed); s.settings.strategy = 'manual'; s.settings.manualMode = 'normal'; if (window.DrawCore.draw(s).studentId !== '501' || window.DrawCore.draw(s).studentId !== '28') continue; s.settings.manualMode = 'time'; s.settings.timeSource = 'time'; s.settings.timeSelection = 'fixed'; s.settings.positions = '3,4'; return s; }
    throw new Error('Could not seed protected time target');
  });
  await reloadStoredState(protectedTimeState); await installLiveClock();
  const protectedStored = await cdp.evaluate(key => localStorage.getItem(key), KEY);
  await click('#drawBtn'); await pause(200);
  check('指定取位对应学生在公平保护中时，扫描会改用其他可抽取位', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return Array.from(document.querySelectorAll('#timeDigits .chosen')).map(el => el.dataset.timePosition).join(',') === '1,2' && s.round === 2 && s.history.length === 2 && window.__qaDrawCalls === 0; }, KEY));
  check('已有历史的时间扫描保留上一人的当前标记及更早已抽标记，名单状态和PRNG保持原样', await cdp.evaluate((key, before, rngState) => { const s = JSON.parse(localStorage.getItem(key)), current = document.querySelector('#liveSeats .current'), older = document.querySelector('#liveSeats [data-live-student="501"]'); return current?.dataset.liveStudent === '28' && document.querySelectorAll('#liveSeats .current').length === 1 && older.classList.contains('seen') && s.cycleSeen.includes('28') && s.cycleSeen.includes('501') && s.rngState === rngState && localStorage.getItem(key) === before && window.__qaDrawCalls === 0; }, KEY, protectedStored, protectedTimeState.rngState));
  await drawFinished();
  check('失效固定取位自动改选有效连续两位，保留原设定位并避免重复抽中', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), r = s.history.at(-1); return r.mode === 'time' && r.timeRule.selection === 'random' && r.timeRule.replacedPositions === '3,4' && r.timeRule.positions.join(',') !== '3,4' && r.timeRule.positions[1] === r.timeRule.positions[0] + 1 && r.timeRule.number === 14 && r.studentId === '14' && s.counts['28'] === 1 && s.counts['14'] === 1 && s.counts['501'] === 1 && s.round === 3 && s.history.length === 3 && window.__qaDrawCalls === 1; }, KEY));

  const unavailableTimeState = await cdp.evaluate(() => { const s = window.DrawCore.createState([{ id: '501', name: '无两位甲', row: 1, col: 1 }, { id: '502', name: '无两位乙', row: 3, col: 3 }], 97531); s.settings.strategy = 'manual'; s.settings.manualMode = 'time'; s.settings.modes = ['time', 'normal']; return s; });
  await reloadStoredState(unavailableTimeState); await installLiveClock(); await click('#drawBtn'); await waitForScene('normal');
  check('时间模式所有取位均无可抽学生时切换普通随机，不显示误导的时间浮层', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), r = s.history.at(-1); return r.mode === 'normal' && r.switchedFrom === 'time' && !r.timeRule && !r.direction && !r.fallback && document.getElementById('timeVisual').hidden && document.querySelector('.draw-screen').dataset.animation === 'normal' && s.round === 1 && window.__qaDrawCalls === 1; }, KEY));
  await drawFinished();
  check('无法使用时间模式后仍只有一条真实普通抽取记录', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return s.history.length === 1 && s.history[0].mode === 'normal' && document.getElementById('stageName').textContent === s.history[0].name && window.__qaDrawCalls === 1; }, KEY));

  const unavailableDirectionState = { ...unavailableTimeState, round: 1, lastId: '501', counts: { '501': 1 }, lastSeen: { '501': 1 }, cycleSeen: ['501'], lock: { direction: 'right', remaining: 3 }, settings: { ...unavailableTimeState.settings, manualMode: 'direction', modes: ['direction', 'normal'] } };
  await reloadStoredState(unavailableDirectionState); await installLiveClock(); await click('#drawBtn'); await waitForScene('normal');
  check('锁定连坐但所有方向都没有可抽邻座时解除锁定并切换实际模式', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), r = s.history.at(-1); return r.mode === 'normal' && r.switchedFrom === 'direction' && !r.direction && !r.timeRule && !r.fallback && s.lock === null && document.getElementById('seatArrow').hasAttribute('hidden') && document.getElementById('exitChainBtn').hidden && document.querySelector('.draw-screen').dataset.animation === 'normal' && window.__qaDrawCalls === 1; }, KEY));
  await drawFinished();
  check('模式切换后的撤销能恢复原方向锁、上一人位置与伪随机种子', await cdp.evaluate((key, before) => { const s = JSON.parse(localStorage.getItem(key)), reverted = window.DrawCore.clone(s); window.DrawCore.undo(reverted); return reverted.rngState === before.rngState && reverted.lastId === before.lastId && reverted.round === before.round && JSON.stringify(reverted.lock) === JSON.stringify(before.lock) && JSON.stringify(reverted.cycleSeen) === JSON.stringify(before.cycleSeen) && s.round === 2 && s.history.length === 1; }, KEY, unavailableDirectionState));

  const rolloverState = await cdp.evaluate(() => { const s = window.DrawCore.createState([{ id: '59', name: '跨分五九', row: 1, col: 1 }], 8642); s.settings.strategy = 'manual'; s.settings.manualMode = 'time'; s.settings.timeSource = 'time'; s.settings.modes = ['time', 'normal']; return s; });
  await reloadStoredState(rolloverState); await installLiveClock('2026-10-11T14:28:59.600'); await click('#drawBtn'); await waitForScene('time');
  // The overlay becomes visible before nextPaint() starts the first scan tick.
  // Wait for captured evidence, so CDP cannot read an uninitialized frame.
  await waitFor(() => cdp.evaluate(before => window.__qaTimeScanSamples.some(frame => frame.digits === '142859' && frame.chosen === '59' && frame.round === 0 && frame.rngState === before.rngState && frame.calls === 0), rolloverState), 1200);
  check('跨分钟扫描从有效59秒开始，揭晓前尚未消耗真实抽取或伪随机状态', await cdp.evaluate(before => window.__qaTimeScanSamples.some(frame => frame.digits === '142859' && frame.chosen === '59' && frame.round === 0 && frame.rngState === before.rngState && frame.calls === 0), rolloverState));
  await waitFor(() => cdp.evaluate(() => window.__qaTimeScanSamples.some(frame => frame.digits === '142900')), 1200);
  check('秒数跨过59→00时分钟同步变化，失效的旧59高亮被清除而没有提前提交', await cdp.evaluate(() => window.__qaTimeScanSamples.some(frame => frame.digits === '142900' && frame.chosen === '' && frame.round === 0 && frame.calls === 0)));
  await screenshot('time-minute-rollover.png'); await drawFinished();
  check('跨分钟导致全部取位失效时，揭晓重新验证并切模式，避免用旧59冒充当前时间结果', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), r = s.history.at(-1); return r.mode === 'normal' && r.switchedFrom === 'time' && !r.timeRule && window.DrawCore.dateDigits(new Date(r.time), 'time').startsWith('1429') && r.studentId === '59' && s.round === 1 && s.history.length === 1 && window.__qaDrawCalls === 1 && document.getElementById('stageName').textContent === '跨分五九' && document.getElementById('timeVisual').hidden; }, KEY));

  const timeJumpState = await cdp.evaluate(() => { const students = Array.from({ length: 40 }, (_, i) => ({ id: String(i + 1), name: '再跳' + (i + 1), row: Math.floor(i / 8) + 1, col: i % 8 + 1 })); const s = window.DrawCore.createState(students, 12345); s.settings.strategy = 'manual'; s.settings.manualMode = 'time'; return s; });
  timeJumpState.settings.endJumpChance = 100;
  await reloadStoredState(timeJumpState, 100); await installLiveClock(); await cdp.evaluate(() => Math.random = () => .1); await click('#drawBtn');
  await waitFor(() => cdp.evaluate(() => document.getElementById('drawStage').classList.contains('last-jump')), 5000);
  check('时间末尾真实改选仍匹配锁定时刻的有效学号，只给最终结果提交一次记录', await cdp.evaluate((key, before) => { const s = JSON.parse(localStorage.getItem(key)), r = s.history.at(-1), chosen = Array.from(document.querySelectorAll('#timeDigits .chosen')).map(el => el.textContent).join(''), eligible = new Set(window.DrawCore.probabilities(before).map(item => item.student.id)); return r.endJump && r.studentId !== r.endJump.initialStudentId && eligible.has(r.studentId) && Number(chosen) === Number(r.studentId) && s.round === 1 && s.history.length === 1 && window.__qaDrawCalls === 1; }, KEY, timeJumpState));
  await screenshot('time-last-jump.png'); await drawFinished();
  check('时间再跳变结束只提交一次，最终快照与学生学号匹配且PRNG等于一次真实抽取', await cdp.evaluate((key, before) => { const s = JSON.parse(localStorage.getItem(key)), r = s.history.at(-1), expected = window.DrawCore.clone(before); window.__qaOriginalDraw(expected, new Date(r.time), { endJump: true }); return s.round === 1 && s.history.length === 1 && window.__qaDrawCalls === 1 && r.mode === 'time' && r.timeRule.number === Number(r.studentId) && r.timeRule.digits === window.DrawCore.dateDigits(new Date(r.time), 'time') && expected.rngState === s.rngState && expected.lastId === s.lastId && !document.getElementById('drawStage').classList.contains('last-jump'); }, KEY, timeJumpState));

  for (const extraJump of [false, true]) {
    const normalState = await cdp.evaluate(() => { const students = Array.from({ length: 47 }, (_, i) => ({ id: String(i + 1), name: '随机' + (i + 1), row: Math.floor(i / 8) + 1, col: i % 8 + 1, active: true })); const s = window.DrawCore.createState(students, 6789); s.settings.strategy = 'manual'; s.settings.manualMode = 'normal'; return s; });
    normalState.settings.endJumpChance = extraJump ? 100 : 0;
    await reloadStoredState(normalState, normalState.settings.endJumpChance);
    const expected = await cdp.evaluate((state, extraJump) => { Math.random = () => extraJump ? .1 : .9; const next = window.DrawCore.clone(state); window.DrawCore.draw(next, undefined, { endJump: true }); return { rngState: next.rngState, lastId: next.lastId, counts: next.counts }; }, normalState, extraJump);
    await click('#drawBtn');
    if (extraJump) {
      await waitFor(() => cdp.evaluate(() => document.getElementById('drawStage').classList.contains('last-jump')), 4500);
      check('末尾继续随机或回选会改变真实学生，动画高亮最终结果而统计只增加一次', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), r = s.history.at(-1); return r.endJump && r.endJump.initialStudentId !== r.studentId && document.getElementById('drawBtn').getAttribute('aria-busy') === 'true' && document.getElementById('stageName').textContent === r.name && s.round === 1 && s.history.length === 1 && (r.endJump.kind !== 'back' || r.animationOrder.at(-1) === r.studentId); }, KEY));
      await screenshot('last-jump.png');
    }
    await drawFinished();
    check((extraJump ? '30% 再跳变' : '70% 常规揭晓') + '分支的最终结果、伪随机状态与真实抽取一致且只有一条记录', await cdp.evaluate((key, expected) => { const s = JSON.parse(localStorage.getItem(key)); return s.round === 1 && s.history.length === 1 && s.rngState === expected.rngState && s.lastId === expected.lastId && JSON.stringify(s.counts) === JSON.stringify(expected.counts) && document.getElementById('stageName').textContent === s.history[0].name && !document.getElementById('drawStage').classList.contains('last-jump') && document.querySelectorAll('#liveSeats .current').length === 1; }, KEY, expected));
    if (!extraJump) {
      await waitFor(() => cdp.evaluate(() => { const viewport = document.getElementById('liveSeatScroll').getBoundingClientRect(); return Array.from(document.querySelectorAll('#liveSeats [data-live-student]')).every(el => { const seat = el.getBoundingClientRect(); return seat.top >= viewport.top - 1 && seat.bottom <= viewport.bottom + 1 && seat.left >= viewport.left - 1 && seat.right <= viewport.right + 1; }); }), 2000);
      check('动画结束后保留 47 人 8 列 6 行与一个空座，并按可读性保持概览或焦点相机', await cdp.evaluate(() => !document.querySelector('.draw-screen').classList.contains('is-animating') && document.querySelectorAll('#liveSeats [data-live-student]').length === 47 && document.querySelectorAll('#liveSeats .empty').length === 1 && new DOMMatrix(getComputedStyle(document.getElementById('liveSeatMap')).transform).a <= 1.001));
      await screenshot('47-students-overview.png');
      for (const device of [{ width: 1920, height: 1080, mobile: false, expectFollow: false }, { width: 1366, height: 768, mobile: false }, { width: 1280, height: 720, mobile: false }, { width: 1280, height: 590, mobile: false }, { width: 1024, height: 540, mobile: false }, { width: 844, height: 390, mobile: true, expectFollow: true }, { width: 768, height: 432, mobile: false, deviceScaleFactor: 2.5, expectFollow: true }, { width: 768, height: 360, mobile: false, deviceScaleFactor: 2.5, expectFollow: true }, { width: 390, height: 844, mobile: true, expectFollow: true }, { width: 320, height: 780, mobile: true, expectFollow: true }]) {
        const { expectFollow, ...metrics } = device;
        await cdp.send('Emulation.setDeviceMetricsOverride', { ...metrics, deviceScaleFactor: device.deviceScaleFactor || 1 });
        await pause(450);
        await waitFor(async () => { const state = await cdp.evaluate(seatLayoutSnapshot); return state.viewport.width === device.width && state.viewport.height === device.height && state.focusVisible && state.focusUncovered && state.controlsFit && state.pageFits && (state.following ? state.layout === 'follow' && state.seatHeight >= 47 && state.nameSize >= 10.95 && state.idSize >= 8.95 && centeredOn(await cdp.evaluate(cameraFocusSnapshot), state.currentId, true) : state.allVisible); }, 3500);
        const layout = await cdp.evaluate(seatLayoutSnapshot), label = device.width + '×' + device.height + (device.deviceScaleFactor ? ' / 2.5×' : '');
        check(label + ' 座位图延伸到操作层背后，按可读空间切换概览或跟随且焦点不被按钮遮住', layout.count === 47 && layout.empty === 1 && layout.pageFits && layout.controlsFit && layout.boardBehindControls && layout.focusVisible && layout.focusUncovered && (layout.following ? layout.layout === 'follow' && layout.scrollClips && layout.seatHeight >= 47 && layout.nameSize >= 10.95 && layout.idSize >= 8.95 : layout.allVisible && layout.scale <= 1.001) && (expectFollow == null || layout.following === expectFollow));
        if (device.deviceScaleFactor) check(label + ' 真实 CSS 视口与物理 1920px 屏幕缩放一致', layout.viewport.width === device.width && layout.viewport.height === device.height && layout.viewport.dpr === 2.5);
        await screenshot('47-students-' + device.width + 'x' + device.height + (device.deviceScaleFactor ? '-2.5x' : '') + '.png');
      }
      await cdp.send('Emulation.clearDeviceMetricsOverride');
    }
  }

  const scaledMetrics = { width: 768, height: 432, deviceScaleFactor: 2.5, mobile: false };
  await cdp.send('Emulation.setDeviceMetricsOverride', scaledMetrics);
  for (const id of ['1', '8', '41', '47']) {
    const cornerState = await cdp.evaluate((initial, id) => {
      const state = window.DrawCore.clone(initial);
      for (let i = 0; i < 47 && state.lastId !== id; i++) window.DrawCore.draw(state, new Date('2026-10-11T14:28:12.700'));
      if (state.lastId !== id) throw new Error('Unable to build corner focus fixture: ' + id);
      return state;
    }, demoNormalState, id);
    await reloadStoredState(cornerState);
    await waitFor(async () => { const layout = await cdp.evaluate(seatLayoutSnapshot); return layout.following && layout.currentId === id && layout.focusVisible && layout.controlsFit && layout.seatHeight >= 47 && layout.nameSize >= 10.95 && layout.idSize >= 8.95 && centeredOn(await cdp.evaluate(cameraFocusSnapshot), id, true); });
    const cornerLayout = await cdp.evaluate(seatLayoutSnapshot);
    const restoredCornerState = await cdp.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY);
    assert.deepEqual(canonicalDrawState(restoredCornerState), canonicalDrawState(cornerState), 'Corner focus restore must preserve draw state');
    check('2.5× 边角座位 ' + id.padStart(2, '0') + ' 恢复时相机保持姓名与学号完整可见，焦点移动不改变抽取状态', cornerLayout.following && cornerLayout.focusVisible && cornerLayout.seatHeight >= 47 && cornerLayout.nameSize >= 10.95 && cornerLayout.idSize >= 8.95 && cornerLayout.pageFits && cornerLayout.controlsFit);
    check('2.5× 边角座位 ' + id.padStart(2, '0') + ' 持久化恢复时高亮座位位于可用座位视口中心', centeredOn(await cdp.evaluate(cameraFocusSnapshot), id));
  }
  await reloadStoredState(demoNormalState); await installLiveClock(); await click('#drawBtn');
  await waitForScene('normal');
  const scaledNormalFrames = await cdp.evaluate(async () => { const samples = []; for (let i = 0; i < 9; i++) { const current = document.querySelector('#liveSeats .candidate'), box = current?.getBoundingClientRect(), view = document.getElementById('liveSeatScroll').getBoundingClientRect(); samples.push({ id: current?.dataset.liveStudent, camera: getComputedStyle(document.getElementById('liveSeatMap')).transform, visible: !!box && box.top >= view.top - 1 && box.bottom <= view.bottom + 1 && box.left >= view.left - 1 && box.right <= view.right + 1, follow: document.querySelector('.draw-screen').classList.contains('is-following') }); await new Promise(resolve => setTimeout(resolve, 100)); } return samples; });
  check('1920×1080 屏幕 2.5× 缩放的普通动画持续跟随乱序高亮，不退回过小全图', scaledNormalFrames.every(frame => frame.follow) && new Set(scaledNormalFrames.map(frame => frame.id).filter(Boolean)).size >= 3 && new Set(scaledNormalFrames.map(frame => frame.camera)).size >= 3 && scaledNormalFrames.some(frame => frame.visible));
  const normalFocus = await cdp.evaluate(cameraFocusSnapshot);
  check('普通抽取动画镜头的目标中心始终是当前高亮候选座位', centeredOn(normalFocus, normalFocus.candidateId));
  await screenshot('scaled-normal-camera.png'); await drawFinished();
  let scaledLayout = await cdp.evaluate(seatLayoutSnapshot);
  check('2.5× 普通动画揭晓后仍保持焦点相机，当前学生清晰且完整可见', scaledLayout.following && scaledLayout.layout === 'follow' && scaledLayout.focusVisible && scaledLayout.nameSize >= 11 && scaledLayout.idSize >= 9 && scaledLayout.seatHeight >= 47 && scaledLayout.pageFits && scaledLayout.controlsFit && await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return s.round === 1 && s.history.length === 1 && window.__qaDrawCalls === 1; }, KEY));
  const normalResultFocus = await cdp.evaluate(cameraFocusSnapshot);
  check('普通抽取完成后摄像机以最终绿色高亮为几何中心', centeredOn(normalResultFocus, normalResultFocus.currentId, true));
  const scaledNormalResult = await cdp.evaluate(key => localStorage.getItem(key), KEY);
  await reloadStoredState(scaledNormalResult); await waitFor(async () => (await cdp.evaluate(seatLayoutSnapshot)).focusVisible);
  check('高缩放重载已抽中状态后恢复跟随相机与原焦点，不新增抽取', await cdp.evaluate((key, expected) => { const s = JSON.parse(localStorage.getItem(key)); return localStorage.getItem(key) === expected && s.round === 1 && s.history.length === 1 && s.lastId === JSON.parse(expected).lastId && document.querySelector('.draw-screen').classList.contains('is-following') && document.querySelector('#liveSeats .current').dataset.liveStudent === s.lastId; }, KEY, scaledNormalResult));
  await screenshot('scaled-normal-result.png');
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await click('#drawBtn'); await drawFinished(); await waitFor(async () => (await cdp.evaluate(seatLayoutSnapshot)).focusVisible);
  check('高缩放减少动态效果直接揭晓时仍自动跟随新焦点，并且只增加一轮', (await cdp.evaluate(seatLayoutSnapshot)).following && await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return s.round === 2 && s.history.length === 2 && document.querySelector('#liveSeats .current').dataset.liveStudent === s.lastId; }, KEY));
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  await openConfig(); await click('#undoBtn'); await closeConfig(); await waitFor(async () => (await cdp.evaluate(seatLayoutSnapshot)).focusVisible);
  assert.deepEqual(canonicalDrawState(await cdp.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY)), canonicalDrawState(JSON.parse(scaledNormalResult)), 'Undo must restore all draw values, with missing statistics treated as zero');
  check('高缩放撤销后相机跟随恢复的上一位，统计与随机状态精确还原', (await cdp.evaluate(seatLayoutSnapshot)).following);
  const undoFocus = await cdp.evaluate(cameraFocusSnapshot);
  check('高缩放撤销后的摄像机中心恢复到上一位高亮座位', centeredOn(undoFocus, undoFocus.currentId));

  for (const height of [432, 360]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...scaledMetrics, height });
    await reloadStoredState(directionState); await installLiveClock(); await click('#drawBtn');
    await waitFor(() => cdp.evaluate(() => document.getElementById('seatArrow').classList.contains('spinning-arrow')), 1800);
    await pause(240);
    const scaledDirectionFrames = await directionCameraFrames();
    check('768×' + height + ' / 2.5× 连坐旋转期间上一位始终位于视口中心，邻座高亮与指针和姓名同步', scaledDirectionFrames.every(frame => frame.spinning && frame.following && centeredOn(frame, '19', true) && (!frame.candidateId || frame.caption.includes(frame.candidateName))) && new Set(scaledDirectionFrames.map(frame => frame.candidateId).filter(Boolean)).size >= 3 && new Set(scaledDirectionFrames.map(frame => frame.arrow)).size >= 3);
    check('768×' + height + ' / 2.5× 旋转中不同邻座高亮不会改变镜头目标或产生横向晃动', new Set(scaledDirectionFrames.map(frame => frame.targetCamera)).size === 1 && scaledDirectionFrames.every(frame => Math.abs(frame.scale - scaledDirectionFrames[0].scale) < .001));
    await screenshot(height === 432 ? 'scaled-direction-spinning.png' : 'scaled-direction-spinning-toolbar.png');
    await waitFor(() => cdp.evaluate(() => !document.getElementById('seatArrow').classList.contains('spinning-arrow') && document.getElementById('drawBtn').getAttribute('aria-busy') === 'true'), 2500);
    const revealFocus = await cdp.evaluate(cameraFocusSnapshot);
    check('768×' + height + ' 连坐旋转结束后镜头连贯转向被抽中高亮，保留揭晓过渡', centeredOn(revealFocus, '20') && (revealFocus.candidateId === '20' || revealFocus.currentId === '20'));
    await drawFinished(); await waitFor(async () => (await cdp.evaluate(seatLayoutSnapshot)).focusVisible);
    const resultFocus = await cdp.evaluate(cameraFocusSnapshot);
    check('768×' + height + ' / 2.5× 连坐结果以当前高亮为中心，保留上一人箭头与可触达操作', centeredOn(resultFocus, '20', true) && (await cdp.evaluate(seatLayoutSnapshot)).following && (await cdp.evaluate(seatLayoutSnapshot)).controlsFit && await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), r = s.history.at(-1), exit = document.getElementById('exitChainBtn'), box = exit.getBoundingClientRect(); return r.studentId === '20' && !document.getElementById('seatArrow').hasAttribute('hidden') && document.querySelector('#liveSeats .current').dataset.liveStudent === r.studentId && !exit.hidden && box.right <= innerWidth && box.bottom <= innerHeight && box.height >= 44 && window.__qaDrawCalls === 1; }, KEY));
    check('768×' + height + ' 高缩放视口底部抽人、重置与退出连坐同高，完整可触达', await cdp.evaluate(equalHomeButtonHeights));
    await screenshot(height === 432 ? 'scaled-direction-result.png' : 'scaled-direction-result-toolbar.png');
  }

  await cdp.send('Emulation.setDeviceMetricsOverride', scaledMetrics);
  await reloadStoredState(directionState); await installLiveClock(); await click('#drawBtn');
  await waitFor(() => cdp.evaluate(() => document.getElementById('seatArrow').classList.contains('spinning-arrow')), 1800);
  await pause(240);
  const beforeDirectionResize = await cdp.evaluate(cameraFocusSnapshot);
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...scaledMetrics, height: 360 });
  await pause(260);
  const afterDirectionResize = await directionCameraFrames(4, 70);
  check('方向旋转途中改变可用高度会重新计算九宫格缩放，仍以旋转中心聚焦且不会追随邻座', centeredOn(beforeDirectionResize, '19', true) && afterDirectionResize.every(frame => frame.spinning && centeredOn(frame, '19', true)) && afterDirectionResize[0].view.height < beforeDirectionResize.view.height && afterDirectionResize[0].scale < beforeDirectionResize.scale && new Set(afterDirectionResize.map(frame => frame.candidateId)).size >= 2 && new Set(afterDirectionResize.map(frame => frame.targetCamera)).size === 1);
  await screenshot('scaled-direction-resize.png'); await drawFinished();
  check('旋转途中 resize 后最终仍以抽中的绿色高亮为中心，仅提交一轮', centeredOn(await cdp.evaluate(cameraFocusSnapshot), '20', true) && await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return s.round === 2 && s.history.length === 2 && window.__qaDrawCalls === 1; }, KEY));

  const directionEndState = structuredClone(directionState); directionEndState.settings.direction = 'auto'; directionEndState.settings.endJumpChance = 100;
  await reloadStoredState(directionEndState, 100); await installLiveClock(); await cdp.evaluate(() => Math.random = () => .1); await click('#drawBtn');
  await waitFor(() => cdp.evaluate(() => document.getElementById('drawStage').classList.contains('last-jump') && document.getElementById('seatArrow').classList.contains('spinning-arrow')), 4000);
  const teaserFrames = (await directionCameraFrames(3, 25)).filter(frame => frame.spinning);
  check('方向末尾真实改选期间镜头保持旋转中心，箭头朝合法邻座移动', teaserFrames.length > 0 && teaserFrames.every(frame => centeredOn(frame, '19', true)) && new Set(teaserFrames.map(frame => frame.targetCamera)).size === 1);
  await screenshot('scaled-direction-last-jump.png'); await drawFinished();
  const directionEndId = await cdp.evaluate(key => JSON.parse(localStorage.getItem(key)).lastId, KEY);
  check('方向末尾真实改选后镜头转向最终高亮，只有最终学生计数且轮数一致', centeredOn(await cdp.evaluate(cameraFocusSnapshot), directionEndId, true) && await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), r = s.history.at(-1); return r.endJump && r.endJump.initialStudentId !== r.studentId && s.round === 2 && s.history.length === 2 && window.__qaDrawCalls === 1 && !document.getElementById('drawStage').classList.contains('last-jump'); }, KEY));

  await cdp.send('Emulation.setDeviceMetricsOverride', scaledMetrics);

  const scaledTimeState = await cdp.evaluate(() => { const students = Array.from({ length: 47 }, (_, i) => ({ id: String(i + 1), name: '焦点时间' + (i + 1), row: Math.floor(i / 8) + 1, col: i % 8 + 1 })); const s = window.DrawCore.createState(students, 2468); s.settings.strategy = 'manual'; s.settings.manualMode = 'time'; s.settings.timeSource = 'datetime'; return s; });
  await reloadStoredState(scaledTimeState); await installLiveClock(); await click('#drawBtn');
  await waitFor(() => cdp.evaluate(() => !document.getElementById('timeVisual').hidden && !document.getElementById('timeVisual').classList.contains('is-paired')), 4500);
  check('2.5× 日期时间扫描浮层完整显示且背景进入相机跟随布局', await cdp.evaluate(() => document.querySelector('.draw-screen').classList.contains('is-following') && Array.from(document.querySelectorAll('#timeDigits span,#timeDigits i')).every(el => { const box = el.getBoundingClientRect(); return box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1; })));
  await screenshot('scaled-time-selecting.png'); await drawFinished(); await waitFor(async () => (await cdp.evaluate(seatLayoutSnapshot)).focusVisible);
  check('2.5× 时间浮层淡出后继续聚焦所选学号对应座位，数字和姓名与记录一致', (await cdp.evaluate(seatLayoutSnapshot)).following && await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)), r = s.history.at(-1); return r.mode === 'time' && Number(r.studentId) === r.timeRule.number && document.querySelector('#liveSeats .current').dataset.liveStudent === r.studentId && document.getElementById('stageName').textContent === r.name && document.getElementById('drawBtn').getAttribute('aria-busy') === 'false' && window.__qaDrawCalls === 1; }, KEY));
  const timeFocus = await cdp.evaluate(cameraFocusSnapshot);
  check('时间抽取浮层结束后摄像机以当前绿色高亮为中心', centeredOn(timeFocus, timeFocus.currentId, true));
  await screenshot('scaled-time-result.png');

  const beforeResize = await cdp.evaluate(key => localStorage.getItem(key), KEY);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await waitFor(async () => { const layout = await cdp.evaluate(seatLayoutSnapshot); return !layout.following && layout.allVisible && layout.scale <= 1.001; });
  check('窗口扩大到 1920×1080 后自动恢复完整概览，保留当前结果与抽取状态', await cdp.evaluate((key, expected) => localStorage.getItem(key) === expected, KEY, beforeResize));
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...scaledMetrics, height: 360 });
  await waitFor(async () => { const layout = await cdp.evaluate(seatLayoutSnapshot); return layout.following && layout.focusVisible && layout.controlsFit; });
  check('计入浏览器栏的 768×360 可用视口自动恢复焦点相机，不改变记录', await cdp.evaluate((key, expected) => localStorage.getItem(key) === expected, KEY, beforeResize));
  await screenshot('scaled-browser-toolbar-result.png');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await reloadStoredState(demoNormalState); await installLiveClock(); await click('#drawBtn'); await waitForScene('normal');
  await cdp.send('Emulation.setDeviceMetricsOverride', scaledMetrics);
  await waitFor(() => cdp.evaluate(() => document.querySelector('.draw-screen').matches('.is-following.is-animating')), 1500);
  check('普通动画途中缩小视口会即时切换跟随布局，不提前结束动画或额外抽取', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return s.round === 1 && s.history.length === 1 && window.__qaDrawCalls === 1 && document.getElementById('drawBtn').getAttribute('aria-busy') === 'true' && document.getElementById('liveSeatScroll').dataset.layout === 'follow'; }, KEY));
  await screenshot('scaled-resize-during-animation.png'); await drawFinished(); await waitFor(async () => (await cdp.evaluate(seatLayoutSnapshot)).focusVisible);
  check('动画中缩放结束后仍跟随最终座位，镜头不会重置为裁切的全图', (await cdp.evaluate(seatLayoutSnapshot)).following && await cdp.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 1 && window.__qaDrawCalls === 1, KEY));
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  await reloadStoredState(backup);
  await openConfig();
  await click('.navigation [data-nav="data"]');
  await cdp.evaluate(async () => { document.getElementById('resetBtn').scrollIntoView({ block: 'center' }); await new Promise(resolve => requestAnimationFrame(resolve)); });
  const menuResetPoint = await cdp.evaluate(() => { const box = document.getElementById('resetBtn').getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; });
  await mouse('mousePressed', menuResetPoint); await pause(250);
  const menuResetSample = await cdp.evaluate((key, expected) => {
    const button = document.getElementById('resetBtn'), style = getComputedStyle(button, '::before'), channels = style.backgroundColor.match(/\d+/g).map(Number);
    const animation = button.getAnimations({ subtree: true }).find(animation => animation.animationName === 'hold-fill');
    return { holding: button.hasAttribute('data-reset-holding'), fraction: new DOMMatrix(style.transform).a, elapsed: Number(animation?.currentTime), duration: animation?.effect.getTiming().duration, easing: style.animationTimingFunction, red: channels[0] > channels[1] && channels[0] > channels[2], unchanged: localStorage.getItem(key) === expected };
  }, KEY, backup);
  console.log('Menu reset hold sample: ' + JSON.stringify(menuResetSample));
  check('配置菜单重置按钮使用500毫秒红色非线性确认，按满前不清空状态', menuResetSample.holding && menuResetSample.fraction > 0 && menuResetSample.fraction < 1 && menuResetSample.elapsed >= 100 && menuResetSample.elapsed < 500 && menuResetSample.duration === 500 && menuResetSample.easing.includes('cubic-bezier') && menuResetSample.red && menuResetSample.unchanged);
  await mouse('mouseReleased', menuResetPoint);
  const menuResetReleaseStart = await cdp.evaluate(holdProgressSnapshot, 'resetBtn'); await pause(80);
  const menuResetReleaseLater = await cdp.evaluate(holdProgressSnapshot, 'resetBtn');
  check('配置菜单短按重置松手后红色进度逆向缩回，名单及抽取记录保持完整', menuResetReleaseStart.releasing && menuResetReleaseLater.scale < menuResetReleaseStart.scale && await cdp.evaluate((key, expected) => localStorage.getItem(key) === expected, KEY, backup));
  await waitFor(() => cdp.evaluate(() => !document.getElementById('resetBtn').hasAttribute('data-hold-releasing')), 1500);
  await cdp.evaluate(() => document.getElementById('resetBtn').focus());
  const menuResetHeldAt = Date.now();
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 });
  await waitFor(() => cdp.evaluate(() => document.getElementById('liveSeatScroll').dataset.transition === 'exit'), 1800);
  const menuResetTriggerElapsed = Date.now() - menuResetHeldAt;
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 });
  await waitFor(() => cdp.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 0, KEY), 4000); await drawFinished();
  check('配置菜单键盘按满500毫秒启动退场，完成后仅清本轮统计且保留长期公平反馈', menuResetTriggerElapsed >= 470 && menuResetTriggerElapsed < 1400 && await cdp.evaluate((key, before) => { const s = JSON.parse(localStorage.getItem(key)), original = JSON.parse(before); return s.round === 0 && s.history.length === 0 && s.cycleSeen.length === 0 && s.lastId === null && s.rngState === original.rngState && JSON.stringify(s.students) === JSON.stringify(original.students) && JSON.stringify(s.settings) === JSON.stringify(original.settings) && JSON.stringify(s.fairnessStats) === JSON.stringify(original.fairnessStats) && !document.getElementById('configDialog').open; }, KEY, backup));
  await reloadStoredState(backup);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await click('#drawBtn'); await drawFinished();
  check('减少动态效果设置下直接揭晓结果，仍只增加一条记录', await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)); return s.round === 5 && s.history.length === 5 && !document.getElementById('drawStage').classList.contains('last-jump') && document.getElementById('stageName').textContent === s.history.at(-1).name; }, KEY));
  check('减少动态效果跳过白亮退入场，但自动换轮仍只提交一次长期公平记录', await cdp.evaluate(key => { const state = JSON.parse(localStorage.getItem(key)); return !document.getElementById('liveSeatScroll').dataset.transition && document.querySelectorAll('#liveSeats .seat-transition-running').length === 0 && Object.values(state.fairnessStats).reduce((sum, stats) => sum + stats.draws, 0) === 5; }, KEY));
  await cdp.send('Emulation.setEmulatedMedia', { features: [] }); await reloadStoredState(backup);

  const fairnessFixture = await cdp.evaluate(() => {
    const students = [{ id: '1', name: '经常早位', row: 1, col: 1 }, { id: '2', name: '平均位次', row: 1, col: 2 }, { id: '3', name: '经常晚位', row: 2, col: 1 }, { id: '4', name: '总次较少', row: 2, col: 2 }], state = window.DrawCore.createState(students, 7654321);
    state.settings.strategy = 'manual'; state.settings.manualMode = 'normal'; state.fairnessStats = { '1': { draws: 20, positionSum: 0, positionSamples: 20 }, '2': { draws: 20, positionSum: 10, positionSamples: 20 }, '3': { draws: 20, positionSum: 20, positionSamples: 20 }, '4': { draws: 2, positionSum: 1, positionSamples: 2 } }; return state;
  });
  await reloadStoredState(fairnessFixture);
  const fairnessBefore = await cdp.evaluate(key => localStorage.getItem(key), KEY);
  check('长期公平权重给低累计次数和经常晚位者更高概率，给经常早位者更低概率', await cdp.evaluate(key => { const state = JSON.parse(localStorage.getItem(key)), probability = Object.fromEntries(window.DrawCore.probabilities(state).map(item => [item.student.id, item.probability])); return probability['4'] > probability['3'] && probability['3'] > probability['2'] && probability['2'] > probability['1'] && Object.values(probability).every(value => value > 0); }, KEY));
  await cdp.send('Page.reload'); await waitFor(() => cdp.evaluate(() => document.querySelectorAll('#rosterSeats [data-student]').length === 4));
  check('长期公平统计跨页面加载原样保存，未开始本轮时首页仍然只有抽人按钮', await cdp.evaluate((key, expected) => localStorage.getItem(key) === expected, KEY, fairnessBefore) && await cdp.evaluate(minimalHome));
  await installLiveClock(); await click('#drawBtn'); await drawFinished();
  check('新一轮只增加实际被抽中学生的长期次数及出场样本，第一位归一化位置为0', await cdp.evaluate((key, before) => { const state = JSON.parse(localStorage.getItem(key)), original = JSON.parse(before), record = state.history.at(-1); return record.fairnessPosition === 0 && window.__qaDrawCalls === 1 && state.round === 1 && Object.entries(state.fairnessStats).every(([id, stats]) => id === record.studentId ? stats.draws === original.fairnessStats[id].draws + 1 && stats.positionSamples === original.fairnessStats[id].positionSamples + 1 && stats.positionSum === original.fairnessStats[id].positionSum : JSON.stringify(stats) === JSON.stringify(original.fairnessStats[id])); }, KEY, fairnessBefore));
  await openConfig(); await click('#undoBtn'); await closeConfig();
  assert.deepEqual(canonicalDrawState(await cdp.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY)), canonicalDrawState(JSON.parse(fairnessBefore)), 'Undo restores lifelong counts and order statistics as well as the PRNG');
  check('撤销本轮精确恢复长期累计次数、位次反馈与伪随机状态，重新加载后仍保持', true);
  await cdp.send('Page.reload'); await waitFor(() => cdp.evaluate(() => document.querySelectorAll('#rosterSeats [data-student]').length === 4));
  check('撤销后的长期反馈跨会话保持，没有隐藏新增记录或重播退入场', await cdp.evaluate((key, expected) => { const actual = JSON.parse(localStorage.getItem(key)), before = JSON.parse(expected); return JSON.stringify(actual.fairnessStats) === JSON.stringify(before.fairnessStats) && actual.rngState === before.rngState && actual.round === 0 && actual.history.length === 0 && !document.getElementById('liveSeatScroll').dataset.transition; }, KEY, fairnessBefore));
  await reloadStoredState(backup);
  await cdp.send('Page.navigate', { url: pathToFileURL(path.join(root, 'dist/index.html')).href });
  await waitFor(() => cdp.evaluate(() => typeof window.DrawCore?.draw === 'function' && document.querySelectorAll('[data-mode-row]').length === 5));
  check('切换到首次使用的离线 file 地址仍为空名单，不从测试 HTTP 地址隐式复制学生', await cdp.evaluate(() => document.querySelectorAll('#rosterSeats [data-student]').length === 0));
  await reloadStoredState(classroomFixture);
  await waitFor(() => cdp.evaluate(() => document.querySelectorAll('#rosterSeats [data-student]').length === 47));
  check('单个 HTML 文件直接打开，全部脚本可离线运行', await cdp.evaluate(() => location.protocol === 'file:' && typeof window.DrawCore.draw === 'function' && document.querySelectorAll('[data-mode-row]').length === 5));
  const offlineMaterialFont = await cdp.evaluate(localMaterialFontSnapshot);
  check('离线 file 页面依然加载真实 Material 箭头及配置图标，不依赖外部字体服务', offlineMaterialFont.loaded && offlineMaterialFont.source.includes('data:font/woff2;base64,') && offlineMaterialFont.externalFontFetches === 0);
  check('浏览器没有未处理的 JavaScript 异常', cdp.errors.length === 0);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ artifactBytes: html.length, artifactSha256, completedAt: new Date().toISOString(), checks, runtimeErrors: cdp.errors, visionTest: 'local mock endpoint; no external model call', screenshots }, null, 2));
  console.log('Browser QA complete: ' + checks.length + ' checks. ' + output);
} catch (error) {
  await writeFile(path.join(output, 'partial-report.json'), JSON.stringify({ artifactBytes: html.length, artifactSha256, completedAt: new Date().toISOString(), checks, failedCheck: error.message, runtimeErrors: cdp?.errors || [], screenshots }, null, 2));
  console.error('Browser QA failed:', error.message);
  console.error('Browser diagnostics:', edgeLog);
  if (cdp) {
    try { console.error('Page diagnostics:', JSON.stringify(await cdp.evaluate(key => { const s = JSON.parse(localStorage.getItem(key) || '{}'); return { viewport: [innerWidth, innerHeight], screen: document.querySelector('.draw-screen')?.className, animation: document.querySelector('.draw-screen')?.dataset.animation, timeVisual: document.getElementById('timeVisual')?.className, camera: getComputedStyle(document.getElementById('liveSeatMap')).transform, round: s.round, mode: s.history?.at(-1)?.mode, runtimeText: document.getElementById('announcement')?.textContent }; }, KEY))); await screenshot('failure.png'); } catch (_) {}
  }
  throw error;
} finally {
  if (cdp) { try { await cdp.send('Browser.close'); } catch (_) {} cdp.ws.close(); }
  if (edge && !edge.killed) edge.kill();
  // Edge helpers can retain inherited output pipes after the browser exits.
  // Detach those diagnostic streams so a completed run actually terminates.
  edge?.stdout?.destroy(); edge?.stderr?.destroy(); edge?.unref();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await pause(500);
  const resolved = await realpath(profile).catch(() => null);
  if (resolved && path.dirname(resolved) === profileParent && path.basename(resolved).startsWith('rollcall-qa-')) await rm(resolved, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
