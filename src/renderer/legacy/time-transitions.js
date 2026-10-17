(function () {
  'use strict';

  // Resolve the layout first and animate each real digit from its own old
  // rectangle. Flex ordering must never become a visible intermediate frame.
  const motions = new Set(), ghostLayers = new Set();
  let generation = 0;
  const elements = () => ({
    visual: document.getElementById('timeVisual'),
    digits: document.getElementById('timeDigits'),
    name: document.getElementById('timeMatchName')
  });
  const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const box = element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };
  function selection(digits, positions) {
    const byPosition = new Map(Array.from(digits.querySelectorAll('[data-time-position]'), element => [Number(element.dataset.timePosition), element]));
    return Array.from(new Set(positions.map(Number))).map(position => byPosition.get(position)).filter(Boolean);
  }
  function clear() {
    generation++;
    for (const animation of motions) animation.cancel();
    motions.clear();
    for (const layer of ghostLayers) layer.remove();
    ghostLayers.clear();
    const { visual } = elements();
    if (visual) { delete visual.dataset.layoutFlip; delete visual.dataset.phase; }
  }
  function play(element, frames, duration) {
    if (reduced() || typeof element.animate !== 'function') return Promise.resolve();
    const animation = element.animate(frames, { duration, easing: 'cubic-bezier(.2,.72,.2,1)', fill: 'both' });
    motions.add(animation);
    // A background tab can defer animation.finished. Cleanup still completes
    // without blocking the draw button indefinitely.
    return new Promise(resolve => {
      let timer;
      const finish = () => {
        clearTimeout(timer); motions.delete(animation); animation.cancel(); resolve();
      };
      timer = setTimeout(finish, duration + 180);
      animation.finished.then(finish, finish);
    });
  }
  function flip(element, first, duration) {
    const last = box(element);
    if (!(last.width > 0 && last.height > 0)) return Promise.resolve();
    const x = first.left - last.left, y = first.top - last.top;
    const sx = first.width / last.width, sy = first.height / last.height;
    // Publish source geometry for diagnostics without relying on animation
    // sampling or recomputing the previous flex layout.
    element.dataset.motionFromX = String(first.left);
    element.dataset.motionFromY = String(first.top);
    return play(element, [
      { transform: 'translate(' + x + 'px,' + y + 'px) scale(' + sx + ',' + sy + ')', transformOrigin: '0 0' },
      { transform: 'translate(0px,0px) scale(1,1)', transformOrigin: '0 0' }
    ], duration);
  }
  function ghostsFor(digits, picked) {
    const layer = document.createElement('div');
    layer.className = 'time-digits-ghost-layer'; layer.setAttribute('aria-hidden', 'true');
    for (const original of digits.children) {
      if (picked.includes(original)) continue;
      const rect = box(original), style = getComputedStyle(original);
      if (rect.width <= 0 || rect.height <= 0) continue;
      const ghost = document.createElement('span');
      ghost.className = 'time-digit-ghost'; ghost.textContent = original.textContent;
      Object.assign(ghost.style, {
        left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px',
        font: style.font, fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight,
        lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, textAlign: style.textAlign,
        color: style.color, opacity: style.opacity, textShadow: style.textShadow,
        padding: style.padding, boxSizing: style.boxSizing
      });
      layer.appendChild(ghost);
    }
    if (!layer.children.length) return null;
    document.body.appendChild(layer); ghostLayers.add(layer); return layer;
  }
  async function pair(positions) {
    clear();
    const token = generation, { visual, digits } = elements();
    if (!visual || !digits) return;
    const picked = selection(digits, positions);
    if (!picked.length) return;
    const first = picked.map(box);
    const layer = reduced() ? null : ghostsFor(digits, picked);
    visual.dataset.layoutFlip = 'true'; visual.dataset.phase = 'pairing';
    digits.style.setProperty('--picked-count', String(picked.length));
    for (const digit of digits.querySelectorAll('[data-time-position]')) {
      const rank = picked.indexOf(digit);
      digit.classList.toggle('chosen', rank >= 0);
      digit.style.order = rank < 0 ? '0' : String(rank + 1);
    }
    visual.classList.remove('is-named', 'is-fading'); visual.classList.add('is-paired');
    // Each flip measures the final collapsed layout. All mutations and WAAPI
    // starts happen before the browser paints, so reordering stays invisible.
    const work = picked.map((digit, i) => flip(digit, first[i], 600));
    if (layer) work.push(play(layer, [{ opacity: 1 }, { opacity: 0 }], 360));
    try { await Promise.all(work); }
    finally {
      if (layer) { layer.remove(); ghostLayers.delete(layer); }
      if (generation === token) { delete visual.dataset.layoutFlip; visual.dataset.phase = 'paired'; }
    }
  }
  async function name(positions) {
    clear();
    const token = generation, { visual, digits, name: match } = elements();
    if (!visual || !digits || !match) return;
    const picked = selection(digits, positions), first = picked.map(box);
    visual.dataset.layoutFlip = 'true'; visual.dataset.phase = 'naming';
    visual.classList.add('is-paired', 'is-named');
    const work = picked.map((digit, i) => flip(digit, first[i], 650));
    work.push(play(match, [{ opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'translateX(0px)' }], 650));
    try { await Promise.all(work); }
    finally {
      if (generation === token) { delete visual.dataset.layoutFlip; visual.dataset.phase = 'named'; }
    }
  }
  window.TimeDigitsTransitions = { pair, name, clear };
})();
