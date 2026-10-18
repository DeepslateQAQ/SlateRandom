<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { BALL_HOLD_MS, BallDragSession, BallGesture, resolvePointerPoint } from '../desktop/gesture';
import { useDesktopState } from '../desktop/state';
import type { DesktopDragStart } from '../desktop/types';

const bridge = window.slateDesktop;
const { state, error } = useDesktopState();
const gesture = new BallGesture();
const holding = ref(false), dragging = ref(false), hovered = ref(false), localError = ref('');
const expanded = computed(() => Boolean(state.value?.ball.confirming));
const snap = computed(() => state.value?.ball.snap ?? 'none');
let activePointerType: string | null = null;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
let pointerId: number | null = null;
let capturedElement: HTMLElement | null = null;
let dragStart: DesktopDragStart | null = null;
let gestureSerial = 0;
const dragSession = new BallDragSession({
  start: start => bridge!.dragStart(start),
  move: point => bridge!.dragMove(point),
  end: end => bridge!.dragEnd(end),
}, callback => requestAnimationFrame(callback), id => cancelAnimationFrame(id), (reason, id) => {
  if (dragStart?.id !== id) return;
  localError.value = reason instanceof Error ? reason.message : '无法拖动悬浮球。';
  releasePointer(true);
});

function clearHold(): void { if (holdTimer) clearTimeout(holdTimer); holdTimer = undefined; holding.value = false; }
async function action(callback: (() => Promise<void>) | undefined): Promise<void> {
  localError.value = '';
  try { await callback?.(); }
  catch (reason: unknown) { localError.value = reason instanceof Error ? reason.message : '桌面操作失败。'; }
}

function pointerEnter(event: PointerEvent): void { if (event.pointerType === 'mouse' && pointerId === null) hovered.value = true; }
function pointerLeave(event: PointerEvent): void { if (event.pointerType === 'mouse' && pointerId === null) hovered.value = false; }

function pointerDown(event: PointerEvent): void {
  if (expanded.value || state.value?.main?.visible || !event.isPrimary || event.button !== 0) return;
  // A second touch contact must never take over an active gesture. A stale
  // mouse or pen gesture, however, can be ended by the next primary press.
  if (pointerId !== null) {
    if (activePointerType === 'touch') return;
    const { dragId } = releasePointer(true);
    if (dragId) void dragSession.end(dragId, true);
  }
  event.preventDefault();
  hovered.value = true;
  activePointerType = event.pointerType || 'mouse';
  pointerId = event.pointerId;
  capturedElement = event.currentTarget as HTMLElement;
  const point = resolvePointerPoint(event, window);
  dragStart = {
    id: `${Date.now().toString(36)}-${++gestureSerial}`,
    screenX: point.x, screenY: point.y, pointerType: event.pointerType || 'mouse',
  };
  gesture.begin(point, performance.now());
  // Synthetic tests and a cancelled Windows contact may no longer be capturable.
  try { capturedElement.setPointerCapture(event.pointerId); } catch {}
  holding.value = true;
  dragging.value = false;
  holdTimer = setTimeout(() => {
    if (gesture.confirm(performance.now())) { clearHold(); void action(() => bridge!.beginConfirmation()); }
  }, BALL_HOLD_MS);
}

function pointerMove(event: PointerEvent): void {
  if (event.pointerId !== pointerId) return;
  if (activePointerType === 'mouse' && event.buttons === 0) {
    const { dragId } = releasePointer(true);
    if (dragId) void dragSession.end(dragId, true);
    return;
  }
  if (event.pointerId !== pointerId || !dragStart) return;
  // Resolve touch against the current window origin, never its moving client frame.
  const latest = event.getCoalescedEvents?.().at(-1) ?? event;
  const movement = gesture.move(resolvePointerPoint(latest, window));
  if (!movement.dragging) return;
  clearHold();
  dragging.value = true;
  const position = { dx: movement.dx, dy: movement.dy };
  if (movement.firstDrag) dragSession.start(dragStart, position);
  else dragSession.move(dragStart.id, position);
}

function releasePointer(cancelled: boolean): { result: ReturnType<BallGesture['release']>; dragId: string | null } {
  const id = pointerId, element = capturedElement;
  const dragId = dragging.value ? dragStart?.id ?? null : null;
  const result = gesture.release(cancelled);
  pointerId = null;
  capturedElement = null;
  dragStart = null;
  clearHold();
  if (activePointerType === 'touch') hovered.value = false;
  activePointerType = null;
  dragging.value = false;
  // Clear the active id before releasePointerCapture synchronously dispatches loss.
  if (id !== null && element?.hasPointerCapture(id)) {
    try { element.releasePointerCapture(id); } catch {}
  }
  return { result, dragId };
}



function pointerUp(event: PointerEvent): void {
  if (event.pointerId !== pointerId) return;
  hovered.value = event.pointerType === 'touch' ? false : Boolean(capturedElement?.matches(':hover'));
  if (dragging.value && dragStart) {
    const movement = gesture.move(resolvePointerPoint(event, window));
    dragSession.move(dragStart.id, { dx: movement.dx, dy: movement.dy });
  }
  const { result, dragId } = releasePointer(false);
  if (dragId) void dragSession.end(dragId);
  else if (result === 'click') void action(() => bridge!.openMain({ draw: true }));
}

function pointerCancel(event: PointerEvent): void {
  if (event.pointerId !== pointerId) return;
  hovered.value = false;
  if (dragging.value && dragSession.nativeTracking) return;
  const { dragId } = releasePointer(true);
  if (dragId) void dragSession.end(dragId, true);
}

function lostCapture(event: PointerEvent): void {
  if (pointerId !== event.pointerId) return;
  // Moving a touch HWND may lose DOM capture. Loss alone is not contact release:
  // window-level listeners still receive a later pointerup/cancel.
  if (!dragging.value) pointerCancel(event);
}

function keyboard(event: KeyboardEvent): void {
  if (event.key !== ' ' && event.key !== 'Enter') return;
  event.preventDefault();
  if (event.repeat || expanded.value) return;
  void action(() => bridge!.openMain({ draw: true }));
}

const stopNativeWatch = watch(() => state.value?.ball.dragId, (id, previous) => {
  if (!dragStart || previous !== dragStart.id || id === dragStart.id) return;
  const ended = dragStart.id;
  releasePointer(true);
  dragSession.endedByNative(ended);
});
function cancelInteraction(): void {
  hovered.value = false;
  const { dragId } = releasePointer(true);
  if (dragId) void dragSession.end(dragId, true);
}
// Native hide/show does not change Page Visibility with backgroundThrottling:false.
const stopWindowWatch = watch(() => state.value?.main?.visible, visible => {
  if (visible) cancelInteraction();
});
function visibilityChanged(): void {
  if (document.hidden) cancelInteraction();
}
function windowBlurred(): void {
  if (activePointerType === 'mouse') cancelInteraction();
}
// Listen above the button so a capture loss cannot strand a gesture or turn the
// next touch into a click. Capture listeners also run before nested controls.
window.addEventListener('pointermove', pointerMove, true);
window.addEventListener('pointerup', pointerUp, true);
window.addEventListener('pointercancel', pointerCancel, true);
window.addEventListener('blur', windowBlurred);
document.addEventListener('visibilitychange', visibilityChanged);
onBeforeUnmount(() => {
  cancelInteraction();
  stopWindowWatch();
  stopNativeWatch();
   window.removeEventListener('pointermove', pointerMove, true);
   window.removeEventListener('pointerup', pointerUp, true);
   window.removeEventListener('pointercancel', pointerCancel, true);
  window.removeEventListener('blur', windowBlurred);
   document.removeEventListener('visibilitychange', visibilityChanged);
});
</script>

<template>
  <main id="floatingBall" class="floating-ball-window" :data-snap="snap" :data-confirming="expanded"
    :data-dragging="dragging" @contextmenu.prevent>
    <div class="floating-ball-surface">
      <button id="floatingBallButton" class="floating-ball-core" type="button" :aria-label="expanded ? 'SlateRandom 岩选' : '打开 SlateRandom 岩选，长按 3 秒关闭程序'" :class="{ 'is-holding': holding, 'is-hovered': hovered }"
         :style="{ '--ball-hold-duration': `${BALL_HOLD_MS}ms` }"
        :aria-expanded="expanded" @pointerenter="pointerEnter" @pointerleave="pointerLeave" @pointerdown="pointerDown" @lostpointercapture="lostCapture"
        @keydown="keyboard">
        <span class="material-icon" aria-hidden="true">shuffle</span>
        <svg class="floating-ball-hold-ring" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
          <circle class="floating-ball-hold-progress" cx="32" cy="32" r="29.5" pathLength="100" />
        </svg>
      </button>
      <div class="floating-ball-confirmation" :aria-hidden="!expanded">
        <button id="cancelQuitBtn" class="floating-confirm-cancel" type="button" aria-label="取消关闭"
          :tabindex="expanded ? 0 : -1" @click="action(() => bridge!.endConfirmation())"><span class="material-icon" aria-hidden="true">close</span></button>
        <span class="floating-confirm-text">是否关闭 <strong>SlateRandom 岩选</strong></span>
        <button id="confirmQuitBtn" class="floating-confirm-accept" type="button" aria-label="确认关闭 SlateRandom 岩选"
          :tabindex="expanded ? 0 : -1" @click="action(() => bridge!.quit())"><span class="material-icon" aria-hidden="true">check</span></button>
      </div>
    </div>
    <p v-if="localError || error" class="floating-ball-error" role="alert">{{ localError || error }}</p>
  </main>
</template>
