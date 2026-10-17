/* One native toggle switches between normal and overview presentation. */
(function () {
  'use strict';
  let options = {}, screen = null, picker = null, frame = 0;
  let resizeObserver = null, screenObserver = null;
  function currentStyle() { return options.getStyle?.() === 'overview' ? 'overview' : 'normal'; }
  function layout() {
    frame = 0;
    if (!screen || !picker?.isConnected) return;
    const viewport = screen.getBoundingClientRect(), actions = screen.querySelector('.home-actions');
    const width = viewport.width || window.innerWidth, height = viewport.height || window.innerHeight;
    const bounds = picker.getBoundingClientRect();
    let bottom = currentStyle() === 'overview' && width <= 600 ? 76 : 16;
    if (actions && bounds.width && bounds.height) {
      const controls = actions.getBoundingClientRect(), right = viewport.right - 16, left = right - bounds.width;
      const top = viewport.bottom - bottom - bounds.height;
      if (left < controls.right + 8 && right > controls.left - 8 && top < controls.bottom + 8 && top + bounds.height > controls.top - 8)
        bottom = Math.max(bottom, viewport.bottom - controls.top + 12);
    }
    const value = Math.round(Math.min(bottom, Math.max(8, height - bounds.height - 8))) + 'px';
    if (picker.style.getPropertyValue('--render-picker-bottom') !== value) picker.style.setProperty('--render-picker-bottom', value);
  }
  function scheduleLayout() { if (!frame) frame = requestAnimationFrame(layout); }
  function sync() {
    if (!picker) return;
    const style = currentStyle(), active = style === 'overview', busy = Boolean(options.isBusy?.());
    picker.dataset.selectedStyle = style; picker.disabled = busy;
    picker.setAttribute('aria-pressed', String(active)); picker.setAttribute('aria-busy', String(busy));
    picker.setAttribute('aria-label', active ? '退出全览，返回普通视图' : '开启全览视图');
    picker.title = active ? '退出全览' : '开启全览';
    scheduleLayout();
  }
  function init(settings) {
    options = settings || {}; screen = document.querySelector('.draw-screen');
    if (!screen) return;
    picker = document.getElementById('renderStylePicker');
    if (!picker) {
      picker = document.createElement('button'); picker.id = 'renderStylePicker'; picker.className = 'render-style-picker'; picker.type = 'button';
      const icon = document.createElement('span'); icon.className = 'icon material-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = 'grid_view';
      const label = document.createElement('span'); label.id = 'renderStyleLabel'; label.textContent = '全览'; picker.append(icon, label);
      // Keep native Space/Enter button activation separate from draw shortcuts.
      for (const type of ['keydown', 'keyup']) picker.addEventListener(type, event => {
        if (event.key === ' ' || event.key === 'Enter') event.stopPropagation();
      });
      picker.addEventListener('click', () => {
        if (options.isBusy?.()) return;
        const result = options.onChange?.(currentStyle() === 'overview' ? 'normal' : 'overview'); sync();
        if (result && typeof result.then === 'function') void result.then(sync, sync);
      });
      screen.appendChild(picker);
    }
    if (!resizeObserver && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(scheduleLayout); resizeObserver.observe(screen); resizeObserver.observe(picker);
      const actions = screen.querySelector('.home-actions'); if (actions) resizeObserver.observe(actions);
    }
    if (!screenObserver) {
      screenObserver = new MutationObserver(sync);
      screenObserver.observe(screen, { attributes: true, attributeFilter: ['class', 'data-render-style'] });
      window.addEventListener('resize', scheduleLayout, { passive: true });
      window.visualViewport?.addEventListener('resize', scheduleLayout, { passive: true });
    }
    sync();
  }
  window.RenderStyleUI = { init, sync };
})();
