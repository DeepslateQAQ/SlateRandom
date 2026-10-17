/* Visual seat lifecycle only. Does not read or advance the draw engine RNG. */
(function () {
  'use strict';

  let activeRun = null;
  let entrancePaths = new Map();
  const temporaryClasses = ['seat-transition-running', 'seat-transition-entering', 'seat-transition-exiting'];
  const whiteShadow = '0 0 0 1px #ffffff8c, 0 0 14px #ffffff70, 0 0 38px #ffffff32, inset 0 0 18px #ffffff48';

  function shuffled(items) {
    const result = items.slice();
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function cleanRun(run) {
    if (!run || run.closed) return;
    run.closed = true;
    for (const animation of run.animations) animation.cancel();
    for (const seat of run.seats) seat.classList.remove(...temporaryClasses);
    if (run.viewport.dataset.transition === run.phase) delete run.viewport.dataset.transition;
    if (activeRun === run) activeRun = null;
  }

  // Cancellation is synchronous; the resolved Promise also permits `await clear()`.
  function clear() {
    const run = activeRun;
    if (run) { run.cancelled = true; cleanRun(run); }
    return Promise.resolve({ cancelled: Boolean(run) });
  }

  function snapshot(seat, viewportRect) {
    const rect = seat.getBoundingClientRect();
    const style = getComputedStyle(seat);
    const label = seat.querySelector('.seat-id');
    return {
      seat, label, id: seat.dataset.liveStudent, rect,
      labelColor: label ? getComputedStyle(label).color : null,
      original: {
        opacity: style.opacity, backgroundColor: style.backgroundColor,
        color: style.color, borderColor: style.borderColor,
        boxShadow: style.boxShadow, transform: style.transform
      },
      visible: rect.right > viewportRect.left && rect.left < viewportRect.right &&
        rect.bottom > viewportRect.top && rect.top < viewportRect.bottom
    };
  }

  function makePath(rank) {
    return { rank, depth: 640 + Math.random() * 300 };
  }

  function travel(entry, path) {
    const original = entry.original.transform === 'none' ? '' : ' ' + entry.original.transform;
    // Each seat keeps its own X/Y center. Perspective projects only its depth,
    // so it approaches the viewer inside its existing row and column.
    return 'perspective(720px) translate3d(0px,0px,-' + path.depth.toFixed(2) + 'px)' + original;
  }

  function frames(entry, phase, outside) {
    const original = entry.original;
    const atSeat = 'perspective(720px) translate3d(0px,0px,0px)' + (original.transform === 'none' ? '' : ' ' + original.transform);
    const bright = { backgroundColor: '#ffffff', color: '#090909', borderColor: '#ffffff', boxShadow: whiteShadow, visibility: 'visible' };
    if (phase === 'enter') return [
      { ...bright, transform: outside, opacity: 0, offset: 0 },
      { ...bright, transform: outside, opacity: .92, offset: .08 },
      { ...bright, transform: atSeat, opacity: 1, offset: .76 },
      { ...original, transform: atSeat, visibility: 'visible', offset: 1 }
    ];
    return [
      { ...original, transform: atSeat, visibility: 'visible', offset: 0 },
      { ...bright, transform: atSeat, opacity: 1, offset: .16 },
      { ...bright, transform: atSeat, opacity: 1, offset: .28 },
      { ...bright, transform: outside, opacity: 0, offset: 1 }
    ];
  }

  async function transition(phase, options = {}) {
    clear();
    const viewport = document.getElementById('liveSeatScroll');
    const grid = document.getElementById('liveSeats');
    if (!viewport || !grid) return { phase, count: 0, cancelled: false };
    const seats = Array.from(grid.querySelectorAll('.live-seat[data-live-student]'));
    if (!seats.length || window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
        typeof seats[0].animate !== 'function') return { phase, count: seats.length, cancelled: false };
    const viewportRect = viewport.getBoundingClientRect();
    if (viewportRect.width < 1 || viewportRect.height < 1) return { phase, count: 0, cancelled: false };

    // Capture every original style before any pending-seat class is applied.
    const entries = seats.map(seat => snapshot(seat, viewportRect));
    let ordered;
    if (phase === 'enter') {
      ordered = shuffled(entries.filter(entry => entry.visible)).concat(shuffled(entries.filter(entry => !entry.visible)));
      entrancePaths = new Map(ordered.map((entry, index) => [entry.id, makePath(index)]));
    } else {
      const reverse = items => shuffled(items).sort((a, b) =>
        (entrancePaths.get(b.id)?.rank ?? 0) - (entrancePaths.get(a.id)?.rank ?? 0));
      ordered = reverse(entries.filter(entry => entry.visible)).concat(reverse(entries.filter(entry => !entry.visible)));
    }
    const requestedDuration = Number(options.duration);
    const baseDuration = Number.isFinite(requestedDuration) && requestedDuration > 0
      ? Math.max(160, Math.min(1800, requestedDuration)) : phase === 'enter' ? 1280 : 1080;
    const totalDuration = baseDuration;
    const seatDuration = (Math.min(650, baseDuration * .48) / baseDuration) * totalDuration;
    const requestedStagger = Number(options.stagger);
    const spread = ordered.length < 2 ? 0 : Number.isFinite(requestedStagger) && requestedStagger >= 0
      ? Math.min(totalDuration - seatDuration, requestedStagger * (ordered.length - 1) * totalDuration / baseDuration) : totalDuration - seatDuration;
    const run = { phase, viewport, seats, animations: new Set(), closed: false, cancelled: false };
    activeRun = run;
    viewport.dataset.transition = phase;
    for (const seat of seats) seat.classList.add('seat-transition-running', 'seat-transition-' + (phase === 'enter' ? 'entering' : 'exiting'));

    try {
      const completions = ordered.map((entry, index) => {
        const path = entrancePaths.get(entry.id) || makePath(index);
        const outside = travel(entry, path, viewportRect);
        const delay = ordered.length > 1 ? index * spread / (ordered.length - 1) : 0;
        const duration = seatDuration * (.88 + Math.random() * .12);
        const timing = {
          duration, delay, fill: 'both',
          easing: phase === 'enter' ? 'cubic-bezier(.18,.72,.22,1)' : 'cubic-bezier(.55,.05,.75,.5)'
        };
        const animation = entry.seat.animate(frames(entry, phase, outside), timing);
        run.animations.add(animation);
        let labelAnimation = null;
        if (entry.label) {
          const labelFrames = phase === 'enter'
            ? [{ color: '#292929', offset: 0 }, { color: '#292929', offset: .76 }, { color: entry.labelColor, offset: 1 }]
            : [{ color: entry.labelColor, offset: 0 }, { color: '#292929', offset: .16 }, { color: '#292929', offset: 1 }];
          labelAnimation = entry.label.animate(labelFrames, timing);
          run.animations.add(labelAnimation);
          // A cancelled sibling must never create an unhandled rejection.
          labelAnimation.finished.catch(() => {});
        }
        return animation.finished.catch(() => {}).then(() => {
          if (run.closed || phase !== 'enter') return;
          // Each arrival immediately returns to its own normal/seen/paused state.
          entry.seat.classList.remove(...temporaryClasses);
          animation.cancel(); run.animations.delete(animation);
          if (labelAnimation) { labelAnimation.cancel(); run.animations.delete(labelAnimation); }
        });
      });
      await Promise.all(completions);
    } finally {
      // For exit, reset/render must immediately follow the awaited Promise. Cleanup
      // happens before the next paint, so the old grid cannot flash between scenes.
      cleanRun(run);
    }
    return { phase, count: seats.length, cancelled: run.cancelled };
  }

  window.SeatTransitions = Object.freeze({
    enter: options => transition('enter', options),
    exit: options => transition('exit', options),
    clear
  });
}());
