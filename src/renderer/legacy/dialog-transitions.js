(function () {
  'use strict';
  const states = new WeakMap(), active = new Set(), modalOrder = [];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let sequence = 0, observer = null, escapeHeld = false;
  const ENTER_MS = 280, EXIT_MS = 220;
  const depth = value => 'perspective(1100px) translateZ(' + value + 'px)';
  const ease = value => 1 - Math.pow(1 - value, 3);

  function isModal(dialog) {
    if (!dialog?.open || !dialog.isConnected) return false;
    try { return dialog.matches(':modal'); } catch (_) { return true; }
  }
  function rememberOpen(dialog) {
    if (!isModal(dialog)) return;
    const index = modalOrder.indexOf(dialog); if (index !== -1) modalOrder.splice(index, 1);
    modalOrder.push(dialog);
  }
  function forget(dialog) {
    const index = modalOrder.indexOf(dialog); if (index !== -1) modalOrder.splice(index, 1);
  }
  function topModal() {
    // Native showModal() focuses the new top layer synchronously. This also
    // identifies dialogs opened by QA or other callers before the observer
    // has delivered the corresponding open-attribute mutation.
    const focused = document.activeElement?.closest('dialog');
    if (isModal(focused)) { rememberOpen(focused); return focused; }
    for (let index = modalOrder.length - 1; index >= 0; index--) {
      const dialog = modalOrder[index];
      if (isModal(dialog)) return dialog;
      modalOrder.splice(index, 1);
    }
    const existing = Array.from(document.querySelectorAll('dialog[open]')).filter(isModal);
    existing.forEach(rememberOpen);
    return modalOrder.at(-1) || null;
  }
  function escapeDown(event) {
    if (event.key !== 'Escape' && event.code !== 'Escape') return;
    const dialog = topModal();
    if (!dialog && !escapeHeld) return;
    // Chromium may issue non-cancelable CloseWatcher cancel events and dismiss
    // several dialogs in one watcher group. Prevent the keyboard default
    // before it reaches CloseWatcher, then animate exactly one top modal.
    event.preventDefault(); event.stopImmediatePropagation();
    if (escapeHeld || event.repeat) { escapeHeld = true; return; }
    escapeHeld = true;
    if (dialog) {
      const state = stateFor(dialog);
      if (state.phase === 'exit') return;
      if (state.onEscape?.() === true) return;
      if (state.canClose()) close(dialog);
    }
  }
  function escapeUp(event) {
    if (event.key !== 'Escape' && event.code !== 'Escape') return;
    if (escapeHeld || topModal()) { event.preventDefault(); event.stopImmediatePropagation(); }
    escapeHeld = false;
  }

  function stateFor(dialog) {
    if (!(dialog instanceof HTMLDialogElement)) throw new TypeError('需要一个 dialog 元素。');
    if (!states.has(dialog)) register(dialog);
    return states.get(dialog);
  }
  function snapshot(dialog, state) {
    const visual = getComputedStyle(dialog);
    return { transform: visual.transform === 'none' ? depth(0) : visual.transform,
      opacity: visual.opacity, backdrop: state.backdropOpacity ?? Number(getComputedStyle(dialog, '::backdrop').opacity || 1) };
  }
  function clean(dialog, state, result) {
    state.token++;
    if (state.animation) state.animation.cancel();
    if (state.frame) cancelAnimationFrame(state.frame);
    state.backdropStyle?.remove();
    state.animation = null; state.frame = null; state.backdropStyle = null; state.backdropOpacity = null;
    state.phase = null; active.delete(dialog);
    delete dialog.dataset.motion; delete dialog.dataset.dialogMotionId;
    const resolve = state.resolve; state.resolve = null; state.promise = null; state.complete = null;
    if (resolve) resolve(result);
  }
  function animate(dialog, state, phase, from, returnValue) {
    clean(dialog, state, false);
    const token = state.token, duration = phase === 'enter' ? ENTER_MS : EXIT_MS;
    state.phase = phase; dialog.dataset.motion = phase; active.add(dialog);
    const promise = new Promise(resolve => { state.resolve = resolve; }); state.promise = promise;
    const finish = () => {
      if (state.token !== token) return;
      // Keep the native modal and its backdrop until the exit has reached zero.
      // Native close restores focus and dispatches its single close event.
      if (phase === 'exit' && dialog.open) {
        if (returnValue === undefined) dialog.close(); else dialog.close(String(returnValue));
      }
      clean(dialog, state, true);
    };
    state.complete = finish;
    if (phase === 'exit') {
      state.onCloseStart?.();
      if (state.token !== token) return promise;
    }
    if (reducedMotion.matches || typeof dialog.animate !== 'function') { finish(); return promise; }
    const destination = phase === 'enter' ? { transform: depth(0), opacity: 1 } : { transform: depth(-110), opacity: 0 };
    const origin = from || { transform: depth(-140), opacity: 0, backdrop: 0 };
    try {
      state.animation = dialog.animate([
        { transform: origin.transform, opacity: origin.opacity }, destination
      ], { duration, easing: 'cubic-bezier(.22,.7,.25,1)', fill: 'both' });
      // ::backdrop does not inherit custom properties from its dialog. A small
      // scoped rule gives its opacity a real, interruptible animation in every
      // browser that supports native dialogs, including file:// delivery.
      const style = document.createElement('style'), id = String(++sequence);
      dialog.dataset.dialogMotionId = id;
      style.textContent = 'dialog[data-dialog-motion-id="' + id + '"]::backdrop{opacity:' + origin.backdrop + '!important}';
      document.head.appendChild(style); state.backdropStyle = style; state.backdropOpacity = origin.backdrop;
      const rule = style.sheet.cssRules[0], began = performance.now(), to = phase === 'enter' ? 1 : 0;
      const frame = now => {
        if (state.token !== token) return;
        const progress = Math.min(1, (now - began) / duration);
        state.backdropOpacity = origin.backdrop + (to - origin.backdrop) * ease(progress);
        rule.style.setProperty('opacity', String(state.backdropOpacity), 'important');
        if (progress < 1) state.frame = requestAnimationFrame(frame);
      };
      state.frame = requestAnimationFrame(frame);
      state.animation.finished.then(finish, () => { /* Interrupted transitions are resolved by clean(). */ });
    } catch (_) { finish(); }
    return promise;
  }
  function open(dialog) {
    const state = stateFor(dialog);
    if (state.phase === 'enter') return state.promise;
    if (dialog.open && state.phase !== 'exit') return Promise.resolve(true);
    const from = dialog.open ? snapshot(dialog, state) : null;
    if (!dialog.open) { dialog.showModal(); rememberOpen(dialog); }
    return animate(dialog, state, 'enter', from);
  }
  function close(dialog, returnValue) {
    const state = stateFor(dialog);
    if (!dialog.open) { clean(dialog, state, false); return Promise.resolve(false); }
    if (state.phase === 'exit') return state.promise;
    return animate(dialog, state, 'exit', snapshot(dialog, state), returnValue);
  }
  function register(dialog, options = {}) {
    if (!(dialog instanceof HTMLDialogElement)) return;
    if (states.has(dialog)) {
      const state = states.get(dialog);
      if (options.canClose) state.canClose = options.canClose;
      if (Object.hasOwn(options, 'onEscape')) state.onEscape = options.onEscape ?? null;
      if (Object.hasOwn(options, 'onCloseStart')) state.onCloseStart = options.onCloseStart ?? null;
      return;
    }
    const state = { token: 0, phase: null, canClose: options.canClose || (() => true),
      onEscape: options.onEscape ?? null, onCloseStart: options.onCloseStart ?? null }; states.set(dialog, state);
    rememberOpen(dialog);
    // Pointer events alone do not block a focused button's Enter key or a
    // form's implicit submit. Keep the departing modal inert to all actions.
    ['click', 'submit', 'keydown'].forEach(type => dialog.addEventListener(type, event => {
      if (state.phase !== 'exit') return;
      event.preventDefault(); event.stopImmediatePropagation();
    }, true));
    dialog.addEventListener('cancel', event => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (state.canClose()) close(dialog);
    });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog || !state.canClose()) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(dialog);
    });
    dialog.addEventListener('close', () => { if (!dialog.open) { forget(dialog); clean(dialog, state, false); } });
  }
  function init() {
    document.querySelectorAll('dialog').forEach(dialog => register(dialog));
    if (observer) return;
    document.addEventListener('keydown', escapeDown, true);
    document.addEventListener('keyup', escapeUp, true);
    document.addEventListener('focusin', event => {
      const dialog = event.target.closest?.('dialog');
      if (isModal(dialog)) { register(dialog); rememberOpen(dialog); }
    }, true);
    window.addEventListener('blur', () => { escapeHeld = false; });
    document.addEventListener('visibilitychange', () => { if (document.hidden) escapeHeld = false; });
    observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') {
          if (record.target instanceof HTMLDialogElement) {
            register(record.target);
            if (record.oldValue === null) rememberOpen(record.target);
            else if (!record.target.open) forget(record.target);
          }
          continue;
        }
        for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.matches('dialog')) register(node);
          node.querySelectorAll('dialog').forEach(dialog => register(dialog));
        }
      }
      for (const dialog of active) if (!dialog.isConnected) { forget(dialog); clean(dialog, states.get(dialog), false); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'], attributeOldValue: true });
  }
  reducedMotion.addEventListener('change', event => { if (event.matches) for (const dialog of Array.from(active)) states.get(dialog).complete?.(); });
  window.DialogTransitions = Object.freeze({ open, close, init, register, topModal });
  init();
})();
