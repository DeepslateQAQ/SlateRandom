/* Context controls for the configuration seat map. Drafts save only on request. */
(function () {
  'use strict';

  let options = {}, dialog = null, grid = null, toolbar = null, observer = null;
  let sourceId = null, editing = false, draft = new Set(), frame = 0, saving = false, generation = 0;
  const stamped = new Map(), glowStamps = new Map(), marked = new Set();
  const temporaryClasses = ['friend-config-source', 'friend-config-source-editing', 'friend-config-target'];
  const students = () => options.getState?.()?.students || [];
  const findStudent = id => students().find(student => String(student.id) === String(id));
  const blocked = () => saving || Boolean(options.isBusy?.());
  const sourceSeat = () => Array.from(grid?.querySelectorAll('[data-student]') || []).find(seat => seat.dataset.student === sourceId);
  const present = () => Boolean(dialog?.open && dialog.dataset.motion !== 'exit' && grid?.isConnected && grid.getClientRects().length);

  function stamp(element, attribute, value) {
    if (!stamped.has(element)) stamped.set(element, new Map());
    const original = stamped.get(element);
    if (!original.has(attribute)) original.set(attribute, element.hasAttribute(attribute) ? element.getAttribute(attribute) : null);
    element.setAttribute(attribute, value);
  }

  function restoreMarks() {
    for (const element of marked) element.classList.remove(...temporaryClasses);
    marked.clear();
    for (const [element, attributes] of stamped) for (const [attribute, value] of attributes) {
      if (value === null) element.removeAttribute(attribute); else element.setAttribute(attribute, value);
    }
    stamped.clear();
    for (const [element, original] of glowStamps) {
      if (original.value) element.style.setProperty('--button-glow', original.value, original.priority);
      else element.style.removeProperty('--button-glow');
    }
    glowStamps.clear();
  }

  function hide() {
    generation++;
    cancelAnimationFrame(frame); frame = 0;
    restoreMarks(); sourceId = null; editing = false; draft.clear();
    if (toolbar) {
      toolbar.hidden = true;
      delete toolbar.dataset.friendSource; delete toolbar.dataset.friendEditing;
      delete toolbar.dataset.friendCount;
    }
  }

  function dismiss() {
    if (!sourceId || !toolbar || toolbar.hidden) return false;
    const source = sourceId;
    hide(); focusSource(source);
    return true;
  }

  function updateStatus(message) {
    const status = toolbar?.querySelector('[data-friend-config-status]');
    if (status && status.textContent !== message) status.textContent = message;
  }

  function position() {
    if (!sourceId || !toolbar || toolbar.hidden) return;
    const seat = sourceSeat();
    if (!present() || !seat) { hide(); return; }
    const seatRect = seat.getBoundingClientRect(), dialogRect = dialog.getBoundingClientRect();
    if (!seatRect.width || !seatRect.height || !dialogRect.width || !dialogRect.height) { hide(); return; }
    // Account for the dialog's Z entrance scale as well as its own scrolling.
    const sx = dialogRect.width / Math.max(1, dialog.offsetWidth), sy = dialogRect.height / Math.max(1, dialog.offsetHeight);
    const width = toolbar.offsetWidth, height = toolbar.offsetHeight, padding = 8;
    const centerX = (seatRect.left + seatRect.width / 2 - dialogRect.left) / sx - dialog.clientLeft + dialog.scrollLeft;
    const seatTop = (seatRect.top - dialogRect.top) / sy - dialog.clientTop + dialog.scrollTop;
    const minX = dialog.scrollLeft + padding, maxX = Math.max(minX, dialog.scrollLeft + dialog.clientWidth - width - padding);
    const minY = dialog.scrollTop + padding, maxY = Math.max(minY, dialog.scrollTop + dialog.clientHeight - height - padding);
    const left = Math.max(minX, Math.min(maxX, centerX - width / 2));
    const top = Math.max(minY, Math.min(maxY, seatTop - height - 10));
    const x = left.toFixed(2) + 'px', y = top.toFixed(2) + 'px';
    if (toolbar.style.left !== x) toolbar.style.left = x;
    if (toolbar.style.top !== y) toolbar.style.top = y;
  }

  function track() {
    if (frame || !sourceId) return;
    const tick = () => {
      frame = 0;
      position();
      if (sourceId && !toolbar.hidden) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }

  function sync() {
    if (!sourceId || !toolbar) return;
    const source = findStudent(sourceId), seat = sourceSeat();
    if (!source || !seat || !present()) { hide(); return; }
    const known = new Set(students().map(student => String(student.id)));
    draft = new Set(Array.from(draft).filter(id => id !== sourceId && known.has(id)));
    restoreMarks();
    seat.classList.add('friend-config-source'); marked.add(seat);
    if (editing) {
      seat.classList.add('friend-config-source-editing');
      // The shared button focus handler captures the displayed fill for glow.
      // Restore its original tone when this temporary gray source is released.
      glowStamps.set(seat, { value: seat.style.getPropertyValue('--button-glow'), priority: seat.style.getPropertyPriority('--button-glow') });
      seat.style.setProperty('--button-glow', '#dedede');
    }
    stamp(seat, 'aria-controls', toolbar.id); stamp(seat, 'aria-expanded', 'true');
    if (editing) for (const cell of grid.querySelectorAll('[data-student]')) {
      if (cell.dataset.student === sourceId) continue;
      const selected = draft.has(cell.dataset.student);
      cell.classList.toggle('friend-config-target', selected); marked.add(cell);
      stamp(cell, 'aria-pressed', String(selected));
    }
    const count = editing ? draft.size : new Set((source.friendTargets || []).map(String).filter(id => id !== sourceId && known.has(id))).size;
    toolbar.dataset.friendSource = sourceId;
    toolbar.dataset.friendEditing = String(editing);
    toolbar.dataset.friendCount = String(count);
    toolbar.setAttribute('aria-label', editing ? '为' + source.name + '选择友尽目标，已选' + count + '人' : source.name + '的座位操作');
    toolbar.title = editing ? '点击其他座位多选，已选 ' + count + ' 人；保存空名单可清空目标。' : source.name + ' · 已配置 ' + count + ' 位友尽目标';
    toolbar.querySelector('#seatSettingsBtn').hidden = editing;
    toolbar.querySelector('#seatFriendBtn').hidden = editing;
    toolbar.querySelector('#saveFriendTargetsBtn').hidden = !editing;
    toolbar.querySelector('#cancelFriendTargetsBtn').hidden = !editing;
    toolbar.querySelector('#seatFriendBtn').title = '设置' + source.name + '的友尽目标，已有' + count + '人';
    for (const button of toolbar.querySelectorAll('button')) button.disabled = blocked();
    updateStatus(editing ? '为' + source.name + '选择友尽目标，已选 ' + count + ' 人。' : source.name + '，设置或选择友尽目标。');
    toolbar.hidden = false; position(); track();
  }

  function select(id, seatElement) {
    if (!toolbar || blocked()) return false;
    const candidate = findStudent(id);
    if (!candidate || !present() || (seatElement && !grid.contains(seatElement))) return false;
    const selectedId = String(candidate.id);
    if (editing && sourceId) {
      if (selectedId === sourceId) { options.toast?.('不能将自己设为友尽目标。'); return true; }
      if (draft.has(selectedId)) draft.delete(selectedId); else draft.add(selectedId);
      sync(); return true;
    }
    if (sourceId === selectedId && !toolbar.hidden) {
      hide(); focusSource(selectedId); return true;
    }
    hide(); sourceId = selectedId; sync();
    // A keyboard click can reach either contextual action without tabbing
    // through the rest of the classroom; touch still uses these same buttons.
    toolbar.querySelector('#seatSettingsBtn').focus({ preventScroll: true });
    return true;
  }

  function focusSource(id) {
    if (!present()) return;
    const cell = Array.from(grid.querySelectorAll('[data-student]')).find(seat => seat.dataset.student === id);
    cell?.focus({ preventScroll: true });
  }

  async function saveTargets() {
    if (blocked() || !editing || !sourceId) return;
    const source = sourceId, token = generation;
    const selected = students().map(student => String(student.id)).filter(id => id !== source && draft.has(id));
    saving = true; sync();
    try {
      const result = await options.commitTargets?.(source, selected);
      if (result === false) throw new Error('目标尚未保存，请检查配置后重试。');
      if (generation === token) { hide(); focusSource(source); }
    } catch (error) {
      if (generation === token) {
        const message = error?.message || '友尽目标保存失败，请重试。';
        updateStatus(message); options.toast?.(message);
      }
    } finally {
      saving = false;
      if (generation === token) sync();
    }
  }

  function onClose() { hide(); }
  function onLayout() { if (sourceId) { sync(); position(); } }

  function init(configuration = {}) {
    hide();
    observer?.disconnect();
    dialog?.removeEventListener('close', onClose);
    dialog?.removeEventListener('scroll', onLayout, true);
    window.removeEventListener('resize', onLayout);
    window.visualViewport?.removeEventListener('resize', onLayout);
    toolbar?.remove();
    options = configuration;
    dialog = document.getElementById('configDialog'); grid = document.getElementById('rosterSeats');
    if (!dialog || !grid) return false;
    toolbar = document.createElement('div');
    toolbar.id = 'friendSeatToolbar'; toolbar.className = 'friend-seat-toolbar'; toolbar.hidden = true;
    toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', '座位操作');
    toolbar.innerHTML = '<button id="seatSettingsBtn" type="button"><span class="icon material-icon" aria-hidden="true">tune</span>设置</button>' +
      '<button id="seatFriendBtn" type="button"><span class="icon material-icon" aria-hidden="true">link_off</span>友尽</button>' +
      '<button id="saveFriendTargetsBtn" class="friend-target-save" type="button" hidden><span class="icon material-icon" aria-hidden="true">check</span>保存目标</button>' +
      '<button id="cancelFriendTargetsBtn" class="friend-target-cancel" type="button" hidden><span class="icon material-icon" aria-hidden="true">close</span>取消</button>' +
      '<span class="sr-only" data-friend-config-status role="status" aria-live="polite" aria-atomic="true"></span>';
    dialog.appendChild(toolbar);
    toolbar.addEventListener('click', event => {
      event.stopPropagation();
      const button = event.target.closest('button');
      if (!button || blocked() || !sourceId) return;
      if (button.id === 'seatSettingsBtn') {
        const source = sourceId; hide(); options.onSettings?.(source);
      } else if (button.id === 'seatFriendBtn') {
        const source = findStudent(sourceId);
        if (!source) { hide(); return; }
        editing = true; draft = new Set((source.friendTargets || []).map(String).filter(id => id !== sourceId));
        sync(); sourceSeat()?.focus({ preventScroll: true });
      } else if (button.id === 'saveFriendTargetsBtn') saveTargets();
      else if (button.id === 'cancelFriendTargetsBtn') {
        const source = sourceId; hide(); focusSource(source);
      }
    });
    toolbar.addEventListener('keydown', event => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        const buttons = Array.from(toolbar.querySelectorAll('button')).filter(button => !button.hidden && !button.disabled);
        const index = buttons.indexOf(document.activeElement);
        if (index >= 0 && buttons.length) {
          event.preventDefault(); event.stopPropagation();
          buttons[(index + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length].focus({ preventScroll: true });
        }
      }
    });
    dialog.addEventListener('close', onClose);
    dialog.addEventListener('scroll', onLayout, true);
    window.addEventListener('resize', onLayout);
    window.visualViewport?.addEventListener('resize', onLayout);
    observer = new MutationObserver(records => {
      if (!sourceId) return;
      // Observe replacement and visibility, never our own selection classes or
      // live status writes; this avoids recursive refreshes during multi-select.
      if (records.some(record => !toolbar.contains(record.target) && (
        record.type === 'attributes' || record.target === grid || grid.contains(record.target) || !grid.isConnected
      ))) sync();
    });
    observer.observe(dialog, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'data-motion'] });
    return true;
  }

  window.FriendSeatConfig = Object.freeze({ init, select, sync, hide, dismiss, isEditing: () => editing });
}());
