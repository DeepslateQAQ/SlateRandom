/**
 * Browser-only functions: pass either directly to CDP evaluate(fn, options).
 * Fixtures are returned, never persisted. The caller must use an isolated QA
 * profile before saving one through its normal repository and reloading.
 */
export function makeScenePerformanceFixture({ mode = 'normal', renderStyle = 'normal', studentCount = 47, historyLength = 1 } = {}) {
  const core = window.DrawCore;
  const fail = message => { throw new Error('Performance fixture: ' + message); };
  if (!core) fail('SlateRandom engine is not ready.');
  if (!['normal', 'direction', 'time'].includes(mode)) fail('unsupported mode.');
  if (!['normal', 'overview'].includes(renderStyle)) fail('unsupported render style.');
  if (![47, 500].includes(studentCount)) fail('studentCount must be 47 or 500.');
  if (![1, 2000].includes(historyLength)) fail('historyLength must be 1 or 2000.');
  const cols = studentCount === 47 ? 8 : 20;
  const students = Array.from({ length: studentCount }, (_, index) => ({ id: String(index + 1), name: '性能样本' + (index + 1), row: Math.floor(index / cols) + 1, col: index % cols + 1 }));
  const date = new Date('2026-10-15T06:00:00Z');
  const normalSettings = core.settings({ strategy: 'manual', manualMode: 'normal', friendEnabled: false, endJumpChance: 0 });
  let state = null;
  for (let seed = 1; seed <= 1024; seed++) {
    const candidate = core.createState(students, seed);
    candidate.settings = normalSettings;
    if (core.draw(candidate, date).studentId === '19') { state = candidate; break; }
  }
  if (!state) fail('no initial seed selected student 19 in seeds 1..1024.');
  while (state.history.length < historyLength) core.draw(state, date);
  state.className = studentCount + ' 席性能回归'; state.demo = false; state.cols = cols; state.seatRows = Math.ceil(studentCount / cols);
  const targetSettings = core.settings({ ...normalSettings, manualMode: mode, renderStyle,
    direction: 'auto', directionMin: 3, directionMax: 3, directionCooldownMin: 0, directionCooldownMax: 0,
    timeSource: 'datetime', timeSelection: 'fixed', positions: '1,2' });
  let available = false;
  for (let attempts = 0; attempts <= 2 * studentCount; attempts++) {
    state.settings = targetSettings;
    const targetEligible = mode !== 'time' || core.probabilities(state).some(item => item.student.id === '20');
    if (targetEligible && core.previewMode(state, date) === mode) { available = true; break; }
    if (attempts === 2 * studentCount) break;
    state.settings = normalSettings;
    core.draw(state, date);
  }
  if (!available) fail(mode + ' target unavailable after ' + (2 * studentCount) + ' ordinary draws.');
  if (state.history.length !== historyLength) fail('target preparation changed history length to ' + state.history.length + ', expected ' + historyLength + '.');
  const restored = core.restoreState(state);
  const record = core.draw(core.restoreState(restored), date);
  if (record.mode !== mode || record.switchedFrom || record.fallback
    || (mode === 'direction' && !record.direction)
    || (mode === 'time' && (record.studentId !== '20' || record.timeRule?.replacedPositions
      || record.timeRule?.positions.join(',') !== '1,2'))) fail('actual target draw unexpectedly fell back.');
  return restored;
}

/** Measures one real draw without altering settings, roster, or animation timing. */
export async function measureScenePerformance({ timeoutMs = 60000, longFrameMs = 1000 / 30, trigger = true } = {}) {
  const screen = document.querySelector('.draw-screen'), draw = document.getElementById('drawBtn');
  if (!screen || !draw) throw new Error('SlateRandom draw surface is not ready.');
  if (window.__slatePerformanceRunning) throw new Error('A scene measurement is already running.');
  if (draw.getAttribute('aria-busy') === 'true' || document.querySelector('dialog[open]')) throw new Error('Close settings and wait for the previous draw first.');
  window.__slatePerformanceRunning = true;
  const rectDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
  const styleDescriptor = Object.getOwnPropertyDescriptor(window, 'getComputedStyle');
  const originalRect = Element.prototype.getBoundingClientRect, originalStyle = window.getComputedStyle;
  const originalRAF = window.requestAnimationFrame.bind(window), originalCancel = window.cancelAnimationFrame.bind(window);
  const reads = { getBoundingClientRect: 0, getComputedStyle: 0 }, phases = new Map();
  const phaseName = () => screen.classList.contains('is-lifecycle') ? 'lifecycle'
    : screen.classList.contains('is-animating') ? screen.dataset.animation || 'animation'
    : screen.classList.contains('is-settling') ? 'settling' : 'setup';
  const phase = () => {
    const key = phaseName();
    if (!phases.has(key)) phases.set(key, { intervals: [], getBoundingClientRect: 0, getComputedStyle: 0 });
    return phases.get(key);
  };
  const count = name => { reads[name]++; phase()[name]++; };
  let frame = 0, timeout, began = false, previous = 0;
  const startedAt = performance.now(), intervals = [];
  const round = number => Math.round(number * 1000) / 1000;
  const summarize = samples => {
    const sorted = samples.slice().sort((a, b) => a - b), at = q => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] : 0;
    return { frames: samples.length, p50Ms: round(at(.5)), p95Ms: round(at(.95)), maxMs: round(sorted.at(-1) || 0),
      longFrameCount: samples.filter(ms => ms > longFrameMs).length, over16_7Ms: samples.filter(ms => ms > 16.7).length,
      durationMs: round(samples.reduce((sum, ms) => sum + ms, 0)) };
  };
  try {
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', { configurable: true, writable: true, ...rectDescriptor,
      value: function (...args) { count('getBoundingClientRect'); return Reflect.apply(originalRect, this, args); } });
    Object.defineProperty(window, 'getComputedStyle', { configurable: true, writable: true, ...styleDescriptor,
      value: function (...args) { count('getComputedStyle'); return Reflect.apply(originalStyle, this, args); } });
    await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Scene measurement timed out; instrumentation has been removed.')), Math.max(1000, Math.min(120000, timeoutMs)));
      const tick = now => {
        const busy = draw.getAttribute('aria-busy') === 'true';
        if (busy) began = true;
        if (began && previous) {
          const delta = now - previous; intervals.push(delta); phase().intervals.push(delta);
        }
        previous = now;
        if (began && !busy) { resolve(); return; }
        frame = originalRAF(tick);
      };
      frame = originalRAF(tick);
      if (trigger) draw.click();
    });
    const byPhase = Object.fromEntries(Array.from(phases, ([name, value]) => [name, { ...summarize(value.intervals),
      layoutReads: { getBoundingClientRect: value.getBoundingClientRect, getComputedStyle: value.getComputedStyle } }]));
    return { viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      seats: document.querySelectorAll('#liveSeats [data-live-student]').length, renderStyle: screen.dataset.renderStyle,
      totalDurationMs: round(performance.now() - startedAt), longFrameThresholdMs: round(longFrameMs), ...summarize(intervals),
      layoutReads: reads, phases: byPhase };
  } finally {
    clearTimeout(timeout); originalCancel(frame);
    if (rectDescriptor) Object.defineProperty(Element.prototype, 'getBoundingClientRect', rectDescriptor);
    else delete Element.prototype.getBoundingClientRect;
    if (styleDescriptor) Object.defineProperty(window, 'getComputedStyle', styleDescriptor);
    else delete window.getComputedStyle;
    delete window.__slatePerformanceRunning;
  }
}
