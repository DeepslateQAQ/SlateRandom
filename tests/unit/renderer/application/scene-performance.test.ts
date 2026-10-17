import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDrawSequence } from '../../../../src/renderer/scene/draw-sequence.js';
import { createCamera } from '../../../../src/renderer/scene/camera.js';
import { createStage } from '../../../../src/renderer/scene/stage.js';
import engine from '../../../../src/renderer/domain/engine';

function classes() {
  const values = new Set<string>();
  return { add: (...items: string[]) => items.forEach(item => values.add(item)), remove: (...items: string[]) => items.forEach(item => values.delete(item)), contains: (item: string) => values.has(item), toggle(item: string, active: boolean) { if (active) values.add(item); else values.delete(item); } };
}
function replaceGlobals(values: Record<string, unknown>) {
  const originals = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  return () => { for (const [key, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } };
}
function element() { return { classList: classes(), style: {} as Record<string, string>, attrs: {} as Record<string, string>, textContent: '', dataset: {} as Record<string, string>, setAttribute(key: string, value: string) { this.attrs[key] = value; }, removeAttribute(key: string) { delete this.attrs[key]; } }; }

for (const resized of [false, true]) test('direction animation measures stable geometry once' + (resized ? ', then once again after resize' : '') + ' while preserving focus and dimmed seats', async t => {
  const counters = { style: 0, geometry: 0, frames: 0, disconnected: false };
  let now = 0;
  const listeners = new Map<string, Set<() => void>>();
  const window = {
    addEventListener(name: string, handler: () => void) { const handlers = listeners.get(name) || new Set(); handlers.add(handler); listeners.set(name, handlers); },
    removeEventListener(name: string, handler: () => void) { listeners.get(name)?.delete(handler); }
  };
  const students = Array.from({ length: 9 }, (_, i) => ({ id: String(i + 1), name: '同学' + (i + 1), row: Math.floor(i / 3) + 1, col: i % 3 + 1, active: i !== 3 }));
  const cells = new Map(students.map(student => [student.id, element()]));
  const anchor = cells.get('5')!;
  for (const [name, value] of Object.entries({ offsetLeft: 200, offsetTop: 100, offsetWidth: 80, offsetHeight: 60 })) Object.defineProperty(anchor, name, { get() { counters.geometry++; return value + (resized && counters.frames > 29 && name === 'offsetWidth' ? 20 : 0); } });
  const elements: Record<string, ReturnType<typeof element>> = Object.fromEntries(['liveSeatMap', 'liveSeatScroll', 'liveSeats', 'seatArrow', 'seatArrowPath', 'directionSpinner', 'directionCaptionText', 'drawStage'].map(id => [id, element()]));
  Object.defineProperties(elements.liveSeatMap, { offsetWidth: { get() { counters.geometry++; return 800; } }, offsetHeight: { get() { counters.geometry++; return 600; } } });
  Object.assign(elements.liveSeats!, { querySelector: (selector: string) => cells.get(selector.match(/"(\d+)"/)?.[1] || '') });
  const focus: string[] = [], candidates: (string | null)[] = [];
  const restore = replaceGlobals({
    window, document: { querySelector: () => ({ classList: classes() }) },
    performance: { now: () => now },
    getComputedStyle: () => { counters.style++; return { columnGap: '8px', rowGap: '8px' }; },
    ResizeObserver: class { observe() {} disconnect() { counters.disconnected = true; } },
    requestAnimationFrame: (callback: (time: number) => void) => {
      const id = ++counters.frames;
      queueMicrotask(() => { now += 16; if (resized && id === 30) listeners.get('resize')?.forEach(handler => handler()); callback(now); });
      return id;
    }, cancelAnimationFrame() {}
  }); t.after(restore);
  const context = {
    $: (id: string) => elements[id], state: { students, cycleSeen: ['2', '5'] },
    directionZoom: () => 2, cameraTo: (student: { id: string }) => { focus.push(student.id); },
    motionDuration: (ms: number) => ms, delay: async () => {},
    showVisualCandidate: (student: { id: string } | null) => { candidates.push(student?.id || null); }
  };
  const sequence = createDrawSequence(context);
  await sequence.animateDirection(students[4], { studentId: '6', direction: 'right', name: '同学6' }, false);
  assert.ok(counters.frames > 110); assert.equal(counters.style, resized ? 2 : 1); assert.equal(counters.geometry, resized ? 12 : 6);
  assert.deepEqual(focus, ['5', '6']); assert.equal(candidates.includes('2'), false); assert.equal(candidates.includes('4'), false); assert.equal(candidates.at(-1), '6');
  assert.equal(counters.disconnected, true); assert.equal(listeners.get('resize')?.size, 0);
  assert.equal(elements.seatArrow!.attrs.viewBox, '0 0 800 600'); assert.equal(elements.seatArrow!.classList.contains('spinning-arrow'), false);
  assert.match(elements.seatArrowPath!.attrs.d!, resized ? /^M298\.000 130\.000L306\.000 130\.000$/ : /^M278\.000 130\.000L286\.000 130\.000$/);
});

test('camera publishes the same centered focus without rewriting an identical transform', t => {
  let writes = 0, reads = 0, transform = '';
  const map = element(); Object.defineProperty(map.style, 'transform', { get: () => transform, set: value => { writes++; transform = value; } });
  const viewport = Object.assign(element(), { clientWidth: 800, clientHeight: 600, scrollTo() {}, getBoundingClientRect: () => ({ top: 0, left: 0 }) });
  const seat = element();
  for (const [name, value] of Object.entries({ offsetLeft: 200, offsetTop: 100, offsetWidth: 80, offsetHeight: 60 })) Object.defineProperty(seat, name, { get() { reads++; return value; } });
  Object.assign(map, { offsetLeft: 0, offsetTop: 0, offsetWidth: 800, offsetHeight: 600 });
  const context = {
    $: (id: string) => id === 'liveSeatMap' ? map : viewport,
    state: { history: [] }, drawingMode: 'normal', sceneActive: true,
    isOverview: () => false, liveSeat: () => seat,
    cameraTarget: null as unknown, cameraAnchor: null as unknown, cameraScale: 1
  };
  const restore = replaceGlobals({ window: {} }); t.after(restore);
  const camera = createCamera(context);
  camera.cameraTo({ id: '1' }, 1.6); camera.cameraTo({ id: '1' }, 1.6);
  assert.equal(reads, 8); assert.equal(writes, 1); assert.equal(transform, 'translate(16.00px,92.00px) scale(1.6000)');
  assert.equal(viewport.dataset.focusStudent, '1'); assert.equal(viewport.dataset.cameraCenterX, 400); assert.equal(viewport.dataset.cameraCenterY, 300);
});

test('friend emoji follows moving seats every frame while caching viewport geometry until resize', () => {
  let seatReads = 0, viewportReads = 0, sizeWrites = 0, step = 0;
  const properties = new Map<string, string>();
  const anchor = { style: { transform: '', getPropertyValue: (key: string) => properties.get(key), setProperty: (key: string, value: string) => { sizeWrites++; properties.set(key, value); } }, dataset: {} };
  const context = { window: { FriendTransitions: {} as { position?: (run: unknown) => void } } };
  const source = fs.readFileSync('src/renderer/legacy/friend-transitions.js', 'utf8').replace('Object.freeze({ play, clear })', 'Object.freeze({ play, clear, position })');
  vm.runInNewContext(source, context);
  const run = { closed: false, emotionStudent: { id: '1' }, layer: { hidden: false }, anchor, geometryDirty: true,
    byId: new Map([['1', { isConnected: true, getBoundingClientRect() { seatReads++; return { left: 200 + step, width: 80, top: 200 }; } }]]),
    viewport: { getBoundingClientRect() { viewportReads++; return { left: 10, top: 20, width: 800, height: 600 }; } } };
  for (step = 0; step < 120; step++) context.window.FriendTransitions.position!(run);
  assert.equal(seatReads, 120); assert.equal(viewportReads, 1); assert.equal(sizeWrites, 1);
  assert.equal(anchor.style.transform, 'translate3d(349.00px,170.00px,0) translate(-50%,-100%)');
  run.geometryDirty = true; context.window.FriendTransitions.position!(run);
  assert.equal(viewportReads, 2); assert.equal(sizeWrites, 1);
  assert.equal(Object.hasOwn(anchor.style, 'left'), false); assert.equal(Object.hasOwn(anchor.style, 'top'), false);
});

test('seat renders reuse all 47 nodes, restore transient classes, and rebuild only for changed seat topology', t => {
  const style = () => {
    const values = new Map<string, string>();
    return { getPropertyValue: (key: string) => values.get(key) || '', setProperty: (key: string, value: string) => values.set(key, value) };
  };
  const cell = (id?: string) => {
    const attrs = new Map<string, string>();
    const name = { textContent: '' }, number = { textContent: '' };
    return { className: id ? 'live-seat' : 'live-seat empty', title: '', id, name, number,
      getAttribute: (key: string) => attrs.get(key), setAttribute: (key: string, value: string) => attrs.set(key, value),
      querySelector: (selector: string) => selector === '.seat-name' ? name : number };
  };
  let rebuilds = 0;
  const grid = { style: style(), children: [] as ReturnType<typeof cell>[],
    set innerHTML(value: string) { rebuilds++; this.children = Array.from(value.matchAll(/<div class="live-seat(?: empty)?"([^>]*)>/g), match => cell(/data-live-student="(\d+)"/.exec(match[1]!)?.[1])); } };
  const elements = { liveSeats: grid, liveSeatMap: { style: style(), hidden: false }, seatCountLabel: { textContent: '' }, liveBoardEmptyNotice: null };
  const state = engine.createState(Array.from({ length: 47 }, (_, index) => ({ id: String(index + 1), name: '学生' + (index + 1), row: Math.floor(index / 8) + 1, col: index % 8 + 1 })), 42);
  state.cols = 8; state.seatRows = 6;
  const context = { state, busy: true, drawCommitted: false, settling: false, resultVisible: true,
    $: (id: keyof typeof elements) => elements[id], displayId: (id: string) => id.padStart(2, '0') };
  const restore = replaceGlobals({ window: { FriendSeatConfig: { sync() {} } }, document: { querySelector: () => ({ classList: classes() }) } }); t.after(restore);
  const stage = createStage(context);
  stage.renderSeats();
  const originals = grid.children.slice(), first = originals[0]!, second = originals[1]!;
  assert.equal(originals.length, 48); assert.equal(originals.at(-1)!.className, 'live-seat empty');
  engine.draw(state); context.drawCommitted = true;
  first.className = 'live-seat candidate anchor in-neighborhood friend-source friend-hidden seat-transition-running';
  stage.renderSeats(); stage.renderSeats();
  assert.equal(rebuilds, 1); assert.ok(grid.children.every((node, i) => node === originals[i]));
  assert.equal(first.className, 'live-seat');
  context.settling = true; state.students[1]!.active = false; state.students[0]!.name = '<更新姓名 & 原样>';
  stage.renderSeats();
  assert.equal(first.name.textContent, '<更新姓名 & 原样>'); assert.match(first.getAttribute('aria-label')!, /<更新姓名 & 原样>/);
  assert.equal(second.className, 'live-seat paused');
  const winner = grid.children.find(node => node.id === state.lastId)!;
  assert.equal(winner.className, 'live-seat current');
  stage.renderSeats(true); assert.equal(winner.className, 'live-seat'); assert.equal(rebuilds, 1);
  [state.students[0]!.col, state.students[1]!.col] = [state.students[1]!.col, state.students[0]!.col];
  stage.renderSeats(); assert.equal(rebuilds, 2); assert.equal(grid.children[0]!.id, '2'); assert.equal(grid.children[1]!.id, '1');
});

for (const changeEligibility of [false, true]) test('live time scan updates real seconds without redundant layout work' + (changeEligibility ? ' and invalidates options when eligibility changes' : ''), async t => {
  const NativeDate = Date, epoch = new NativeDate(2026, 9, 16, 12, 34, 19).valueOf();
  let now = 0, nextTimer = 1, optionCalls = 0, probabilityCalls = 0, glyphWrites = 0;
  const timers = new Map<number, { at: number; callback: () => void; interval?: number }>();
  const addTimer = (callback: () => void, duration: number, interval?: number) => { const id = nextTimer++; timers.set(id, { at: now + duration, callback, interval }); return id; };
  const state = engine.createState(Array.from({ length: 47 }, (_, index) => ({ id: String(index + 1), name: '学生' + (index + 1), row: Math.floor(index / 8) + 1, col: index % 8 + 1 })), 42);
  state.settings = engine.settings({ timeSource: 'time', timeSelection: 'fixed', positions: '5,6' });
  const text = ['1', '2', '3', '4', '1', '9'];
  const digits = text.map((_, i) => ({ dataset: { timePosition: String(i + 1) }, get textContent() { return text[i]; }, set textContent(value: string | undefined) { glyphWrites++; text[i] = value!; } }));
  const elements = { timeDigits: { style: { setProperty() {} } }, timeCaption: { textContent: '' }, drawStage: { classList: classes() } };
  const focused: { id: string; at: number }[] = [], highlights: string[] = [];
  const originalOptions = engine.timeOptions, originalProbability = engine.probabilities;
  engine.timeOptions = (...args) => { optionCalls++; return originalOptions(...args); };
  engine.probabilities = (...args) => { probabilityCalls++; return originalProbability(...args); };
  t.after(() => { engine.timeOptions = originalOptions; engine.probabilities = originalProbability; });
  const restore = replaceGlobals({
    Date: class extends NativeDate { constructor() { super(epoch + now); } }, performance: { now: () => now },
    setTimeout: (callback: () => void, duration: number) => addTimer(callback, duration), clearTimeout: (id: number) => timers.delete(id),
    setInterval: (callback: () => void, duration: number) => addTimer(callback, duration, duration), clearInterval: (id: number) => timers.delete(id)
  }); t.after(restore);
  const sequence = createDrawSequence({ state, $: (id: keyof typeof elements) => elements[id], $$: () => digits,
    followCamera: true, cameraTo: (student: { id: string }) => focused.push({ id: student.id, at: now }),
    highlightTime: (positions: number[]) => highlights.push(positions.join(',')), motionDuration: (ms: number) => ms,
    delay: (ms: number) => new Promise<void>(resolve => addTimer(resolve, ms)) });
  if (changeEligibility) addTimer(() => { state.cycleSeen = ['19']; }, 500);
  let finished = false;
  const work = sequence.scanLiveTime(false).then(() => { finished = true; });
  while (!finished && timers.size) {
    const [id, timer] = Array.from(timers).sort((a, b) => a[1].at - b[1].at)[0]!;
    assert.ok(timer.at <= 2000); now = timer.at;
    if (timer.interval) timer.at += timer.interval; else timers.delete(id);
    timer.callback(); await Promise.resolve();
  }
  await work;
  assert.equal(glyphWrites, 2); assert.equal(text.join(''), '123420');
  assert.equal(optionCalls, changeEligibility ? 3 : 2); assert.equal(probabilityCalls, changeEligibility ? 2 : 1);
  assert.equal(focused[0]!.id, '19'); assert.equal(focused.at(-1)!.id, '20');
  if (changeEligibility) assert.ok(focused.filter(item => item.at >= 500).every(item => item.id !== '19'));
  else { assert.deepEqual(focused.map(item => item.id), ['19', '20']); assert.deepEqual(highlights, ['5,6']); }
  assert.equal(timers.size, 0);
});
