/* Friend draw presentation only. Selection and fairness belong to DrawCore. */
(function () {
  'use strict';

  let activeRun = null;
  const seatClasses = ['friend-source', 'friend-target', 'friend-hidden'];
  const reduced = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const idOf = student => String(student?.id ?? '');

  function clean(run) {
    if (!run || run.closed) return;
    run.closed = true;
    cancelAnimationFrame(run.frame);
    cancelAnimationFrame(run.resizeFrame);
    window.removeEventListener('resize', run.onResize);
    window.visualViewport?.removeEventListener('resize', run.onResize);
    for (const timer of run.timers) clearTimeout(timer);
    run.timers.clear();
    for (const animation of run.animations) animation.cancel();
    run.animations.clear();
    for (const seat of run.seats) seat.classList.remove(...seatClasses);
    run.layer.remove();
    run.screen.classList.remove('is-friend');
    delete run.screen.dataset.friendPhase;
    if (activeRun === run) activeRun = null;
    run.cancel();
  }

  function clear() {
    const run = activeRun;
    if (run) { run.cancelled = true; clean(run); }
    return Promise.resolve({ cancelled: Boolean(run) });
  }

  async function pause(run, milliseconds) {
    if (run.closed) return false;
    if (run.delay) await Promise.race([Promise.resolve().then(() => run.delay(milliseconds)), run.cancelledPromise]);
    else await Promise.race([
      new Promise(resolve => {
        const timer = setTimeout(() => { run.timers.delete(timer); resolve(); }, milliseconds);
        run.timers.add(timer);
      }),
      run.cancelledPromise
    ]);
    return !run.closed;
  }

  function motion(run, element, frames, duration, done) {
    if (run.closed) return;
    if (run.reduced || typeof element.animate !== 'function') { done?.(); return; }
    const animation = element.animate(frames, { duration, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'both' });
    run.animations.add(animation);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); run.timers.delete(timer);
      run.animations.delete(animation);
      if (!run.closed) done?.();
      animation.cancel();
    };
    const timer = setTimeout(finish, duration + 150);
    run.timers.add(timer);
    animation.finished.then(finish, finish);
  }

  function emotion(run, value, student) {
    run.emotionStudent = student;
    if (value) run.layer.hidden = false;
    run.anchor.dataset.friendEmotion = value;
    const old = run.emotion;
    if (old) {
      run.emotion = null;
      delete old.dataset.friendEmoji;
      motion(run, old, [{ opacity: 1, transform: 'translateY(0px) scale(1)' }, { opacity: 0, transform: 'translateY(-7px) scale(.92)' }], 150, () => {
        old.remove();
        if (!run.emotion) run.layer.hidden = true;
      });
    }
    if (!value) { if (!old) run.layer.hidden = true; return; }
    const symbol = document.createElement('span');
    symbol.className = 'friend-emoji'; symbol.textContent = value;
    symbol.dataset.friendEmotion = value;
    symbol.dataset.friendEmoji = value;
    run.anchor.appendChild(symbol); run.emotion = symbol; run.layer.hidden = false;
    position(run);
    motion(run, symbol, [
      { opacity: 0, transform: 'translateY(10px) scale(.84)' },
      { opacity: 1, transform: 'translateY(0px) scale(1)' }
    ], 200);
  }

  function position(run) {
    if (run.closed || !run.emotionStudent || run.layer.hidden) return;
    const seat = run.byId.get(idOf(run.emotionStudent));
    if (!seat || !seat.isConnected) { run.layer.hidden = true; return; }
    // The viewport remains fixed until resize. Only the seat's rendered
    // rectangle must follow camera movement.
    if (run.geometryDirty || !run.geometry) {
      run.geometry = { viewport: run.viewport.getBoundingClientRect() };
      run.geometryDirty = false;
    }
    const rect = seat.getBoundingClientRect(), { viewport } = run.geometry;
    const size = Math.min(68, Math.max(38, viewport.width * .065));
    const left = 0, right = viewport.width, top = 0, bottom = viewport.height;
    // The emoji lives beside the transformed map, so zooming never scales it
    // into an unreadable glyph or moves it away from its student's real seat.
    const x = Math.max(left + size / 2 + 10, Math.min(right - size / 2 - 10, rect.left + rect.width / 2 - viewport.left));
    const y = Math.max(top + size + 12, Math.min(bottom - 12, rect.top - viewport.top - 10));
    const transform = 'translate3d(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px,0) translate(-50%,-100%)';
    if (run.anchor.style.transform !== transform) run.anchor.style.transform = transform;
    const fontSize = size.toFixed(2) + 'px';
    if (run.anchor.style.getPropertyValue('--friend-emoji-size') !== fontSize) run.anchor.style.setProperty('--friend-emoji-size', fontSize);
    const studentId = idOf(run.emotionStudent);
    if (run.anchor.dataset.friendStudent !== studentId) run.anchor.dataset.friendStudent = studentId;
  }

  function setPhase(run, phase) {
    if (!run.closed) { run.phase = phase; run.screen.dataset.friendPhase = phase; }
  }

  function reveal(run, targetsVisible) {
    const sourceId = idOf(run.source);
    for (const seat of run.seats) {
      const id = seat.dataset.liveStudent;
      const source = id === sourceId, target = targetsVisible && run.targetIds.has(id);
      seat.classList.toggle('friend-source', source);
      seat.classList.toggle('friend-target', target);
      seat.classList.toggle('friend-hidden', !source && !target);
    }
  }

  async function play(options = {}) {
    clear();
    const screen = document.querySelector('.draw-screen'), viewport = document.getElementById('liveSeatScroll');
    const grid = document.getElementById('liveSeats');
    if (!screen || !viewport || !grid || !options.source) return { cancelled: false, played: false };
    const seats = Array.from(grid.querySelectorAll('.live-seat'));
    const byId = new Map(seats.filter(seat => seat.dataset.liveStudent).map(seat => [seat.dataset.liveStudent, seat]));
    const sourceId = idOf(options.source);
    const targetIds = new Set((options.targets || []).map(idOf).filter(id => id && id !== sourceId && byId.has(id)));
    const targets = (options.targets || []).filter(student => targetIds.has(idOf(student)));
    const winner = targets.find(student => idOf(student) === String(options.record?.studentId));
    if (!byId.has(sourceId) || !targets.length || !winner) return { cancelled: false, played: false };
    let cancel;
    const cancelledPromise = new Promise(resolve => { cancel = resolve; });
    const layer = document.createElement('div');
    layer.className = 'friend-emoji-layer'; layer.setAttribute('aria-hidden', 'true'); layer.hidden = true;
    const anchor = document.createElement('div'); anchor.id = 'friendEmoji'; anchor.className = 'friend-emoji-anchor'; layer.appendChild(anchor);
    anchor.style.left = '0px'; anchor.style.top = '0px';
    viewport.appendChild(layer);
    const run = {
      screen, viewport, seats, byId, layer, anchor, targetIds, targets, source: options.source,
      group: [options.source, ...targets], cancelledPromise, cancel, delay: options.delay,
      animations: new Set(), timers: new Set(), frame: 0, resizeFrame: 0,
      emotion: null, emotionStudent: null, phase: 'source', closed: false, cancelled: false, reduced: reduced(), geometry: null, geometryDirty: true
    };
    activeRun = run;
    run.onResize = () => {
      run.geometryDirty = true;
      if (run.closed || run.resizeFrame) return;
      run.resizeFrame = requestAnimationFrame(() => {
        run.resizeFrame = 0;
        if (run.closed) return;
        if (run.phase === 'targets') options.cameraFit?.(run.group);
        else if (run.phase === 'result') options.cameraFocus?.(winner);
        else if (run.phase === 'source' || run.phase === 'thinking') options.cameraFocus?.(run.source);
        position(run);
      });
    };
    window.addEventListener('resize', run.onResize);
    window.visualViewport?.addEventListener('resize', run.onResize);
    const follow = () => { if (!run.closed) { position(run); run.frame = requestAnimationFrame(follow); } };
    run.frame = requestAnimationFrame(follow);

    try {
      screen.classList.add('is-friend'); setPhase(run, 'source');
      options.showCandidate?.(null, false);
      reveal(run, false); await options.cameraFocus?.(run.source);
      if (!await pause(run, run.reduced ? 0 : 340)) return { cancelled: true, played: true };

      setPhase(run, 'thinking');
      for (const [value, duration] of [['😰', 500], ['🤔', 550], ['😈', 600]]) {
        emotion(run, value, run.source);
        if (!await pause(run, run.reduced ? 0 : duration)) return { cancelled: true, played: true };
      }

      emotion(run, '', null); setPhase(run, 'targets');
      reveal(run, true); await options.cameraFit?.(run.group);
      if (!await pause(run, run.reduced ? 0 : 360)) return { cancelled: true, played: true };
      if (typeof options.animateNormal === 'function') {
        await Promise.race([Promise.resolve().then(() => options.animateNormal()), run.cancelledPromise]);
        if (run.closed) return { cancelled: true, played: true };
      }

      setPhase(run, 'result');
      await options.showCandidate?.(winner, false); await options.cameraFocus?.(winner);
      // Let the winning camera movement settle before bringing in the reaction.
      if (!await pause(run, run.reduced ? 0 : 220)) return { cancelled: true, played: true };
      emotion(run, '😭', winner);
      if (!await pause(run, run.reduced ? 0 : 650)) return { cancelled: true, played: true };

      setPhase(run, 'exit'); emotion(run, '', null);
      for (const seat of seats) seat.classList.remove(...seatClasses);
      if (!await pause(run, run.reduced ? 0 : 350)) return { cancelled: true, played: true };
      return { cancelled: false, played: true };
    } finally { clean(run); }
  }

  window.FriendTransitions = Object.freeze({ play, clear });
}());
