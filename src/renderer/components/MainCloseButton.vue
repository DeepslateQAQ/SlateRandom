<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { CANCEL_MS, HOLD_MS } from '../application/press-intent';

const bridge = window.slateDesktop;
const available = bridge?.role === 'main';
const holding = ref(false), confirming = ref(false), pending = ref(false), localError = ref('');
const progress = ref(0), releasing = ref(false);
const root = ref<HTMLElement | null>(null);
const previousInert = new Map<HTMLElement, boolean>();
let disposed = false;

function isolateConfirmation(): void {
  const group = root.value?.parentElement;
  if (!group) return;
  for (const sibling of group.children) {
    if (!(sibling instanceof HTMLElement) || sibling === root.value) continue;
    if (!previousInert.has(sibling)) previousInert.set(sibling, sibling.inert);
    sibling.inert = true;
  }
}
function restoreSiblings(): void {
  for (const [element, inert] of previousInert) element.inert = inert;
  previousInert.clear();
}
let timer: ReturnType<typeof setTimeout> | undefined;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
let pointerId: number | null = null;
let keyboardKey: string | null = null;
let startedAt = 0, startX = 0, startY = 0;
let fired = false, cancelled = false, ignoreClickUntil = 0;

function stopTimer(): void { if (timer) clearTimeout(timer); timer = undefined; }
function retract(): void {
  if (!holding.value) return;
  progress.value = Math.min(1, Math.max(0, (performance.now() - startedAt) / HOLD_MS));
  holding.value = false;
  releasing.value = progress.value > 0;
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => { releasing.value = false; progress.value = 0; }, 260);
}

async function showConfirmation(): Promise<void> {
  if (!bridge || pending.value || confirming.value) return;
  fired = true;
  holding.value = false;
  releasing.value = false;
  pending.value = true;
  localError.value = '';
  try {
    await bridge.beginQuitConfirmation();
    if (disposed) { await bridge.endQuitConfirmation(); return; }
    confirming.value = true;
    isolateConfirmation();
  }
  catch (error: unknown) { localError.value = error instanceof Error ? error.message : '无法打开退出确认。'; }
  finally { pending.value = false; }
  if (confirming.value) { await nextTick(); document.getElementById('cancelMainQuitBtn')?.focus(); }
}

function begin(): void {
  if (!available || confirming.value || pending.value) return;
  if (releaseTimer) clearTimeout(releaseTimer);
  stopTimer();
  startedAt = performance.now();
  fired = false;
  cancelled = false;
  progress.value = 0;
  releasing.value = false;
  holding.value = true;
  timer = setTimeout(() => { if (!cancelled) void showConfirmation(); }, HOLD_MS);
}

async function hide(): Promise<void> {
  localError.value = '';
  try { await bridge?.hideMain(); }
  catch (error: unknown) { localError.value = error instanceof Error ? error.message : '无法收起主界面。'; }
}

function finish(wasCancelled = false): void {
  stopTimer();
  const elapsed = performance.now() - startedAt;
  retract();
  if (!fired && !wasCancelled && !cancelled && elapsed < CANCEL_MS) void hide();
}

function pointerDown(event: PointerEvent): void {
  if (event.button !== 0 || pointerId !== null || confirming.value || pending.value) return;
  event.preventDefault();
  pointerId = event.pointerId;
  startX = event.clientX; startY = event.clientY;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  begin();
}
function pointerMove(event: PointerEvent): void {
  if (event.pointerId !== pointerId || fired || cancelled) return;
  if (Math.hypot(event.clientX - startX, event.clientY - startY) > 14) { cancelled = true; stopTimer(); retract(); }
}
function pointerUp(event: PointerEvent, wasCancelled = false): void {
  if (event.pointerId !== pointerId) return;
  pointerId = null;
  ignoreClickUntil = performance.now() + 500;
  finish(wasCancelled);
  const element = event.currentTarget as HTMLElement;
  if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
}
function click(event: MouseEvent): void {
  if (performance.now() < ignoreClickUntil || confirming.value || pending.value) { event.preventDefault(); return; }
  void hide();
}
function keyDown(event: KeyboardEvent): void {
  if (event.key !== ' ' && event.key !== 'Enter') return;
  event.preventDefault(); event.stopPropagation();
  if (event.repeat || keyboardKey || confirming.value || pending.value) return;
  keyboardKey = event.key;
  begin();
}
function keyUp(event: KeyboardEvent): void {
  if (event.key !== keyboardKey) return;
  event.preventDefault(); event.stopPropagation();
  keyboardKey = null;
  ignoreClickUntil = performance.now() + 500;
  finish();
}
function blur(): void {
  if (!keyboardKey) return;
  keyboardKey = null;
  finish(true);
}

async function cancelConfirmation(): Promise<void> {
  if (!bridge || pending.value) return;
  pending.value = true;
  try { await bridge.endQuitConfirmation(); localError.value = ''; }
  catch (error: unknown) { localError.value = error instanceof Error ? error.message : '无法取消退出。'; }
  finally { confirming.value = false; restoreSiblings(); pending.value = false; }
  if (!confirming.value) { await nextTick(); document.getElementById('desktopCloseMainBtn')?.focus(); }
}
async function quit(): Promise<void> {
  if (!bridge || pending.value || !confirming.value) return;
  pending.value = true;
  localError.value = '';
  try { await bridge.quit(); }
  catch (error: unknown) {
    localError.value = error instanceof Error ? error.message : '无法退出程序。';
    confirming.value = false;
    restoreSiblings();
    try { await bridge.endQuitConfirmation(); }
    catch (cleanupError: unknown) { localError.value += ' ' + (cleanupError instanceof Error ? cleanupError.message : '无法结束退出确认。'); }
    await nextTick(); document.getElementById('desktopCloseMainBtn')?.focus();
  }
  finally { pending.value = false; }
}

function visibilityChanged(): void {
  if (document.hidden && confirming.value) void cancelConfirmation();
}
onMounted(() => document.addEventListener('visibilitychange', visibilityChanged));
onBeforeUnmount(() => {
  disposed = true;
  restoreSiblings();
  document.removeEventListener('visibilitychange', visibilityChanged);
  stopTimer();
  if (releaseTimer) clearTimeout(releaseTimer);
  if (confirming.value && bridge) void bridge.endQuitConfirmation().catch(() => {});
});
</script>

<template>
  <div v-if="available" ref="root" class="desktop-close-main main-close-control" :data-main-quit-confirming="confirming ? 'true' : 'false'" :data-confirming="confirming ? 'true' : 'false'" :class="{ 'is-confirming': confirming, 'is-holding': holding }"
    :style="{ '--close-progress': String(progress) }" @keydown.esc.stop.prevent="confirming && cancelConfirmation()">
    <button id="desktopCloseMainBtn" class="desktop-close-trigger" type="button"
      :data-holding="holding ? '' : undefined" :data-hold-releasing="releasing ? '' : undefined"
      title="短按收起主界面，长按 500 ms 退出程序" aria-label="收起 SlateRandom 岩选主界面，长按 500 毫秒退出程序"
      :aria-expanded="confirming" :disabled="pending || confirming"
      @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp($event)"
      @pointercancel="pointerUp($event, true)" @lostpointercapture="pointerUp($event, true)"
      @keydown="keyDown" @keyup="keyUp" @blur="blur" @click="click" @contextmenu.prevent>
      <span class="icon material-icon" aria-hidden="true">close</span><span class="action-label">收起</span>
    </button>
    <div class="desktop-main-quit-confirmation" :aria-hidden="!confirming">
      <button id="cancelMainQuitBtn" class="desktop-main-quit-cancel" type="button" aria-label="取消退出"
        :tabindex="confirming ? 0 : -1" :disabled="pending" @click="cancelConfirmation"><span class="material-icon" aria-hidden="true">close</span></button>
      <span>是否退出 <strong>SlateRandom 岩选</strong></span>
      <button id="confirmMainQuitBtn" class="desktop-main-quit-accept" type="button" aria-label="确认退出 SlateRandom 岩选"
        :tabindex="confirming ? 0 : -1" :disabled="pending" @click="quit"><span class="material-icon" aria-hidden="true">check</span></button>
    </div>
    <p v-if="localError" class="desktop-main-quit-error" role="alert">{{ localError }}</p>
  </div>
</template>
