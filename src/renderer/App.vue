<script setup lang="ts">
import { onMounted, shallowRef, watch } from 'vue';
import DrawSurface from './components/DrawSurface.vue';
import ModalDialogs from './components/ModalDialogs.vue';
import StatusLayer from './components/StatusLayer.vue';
import ConfigDialog from './components/ConfigDialog.vue';
import engine from './domain/engine';
import { createAppStore } from './application/store';
import { mountController, type ApplicationActions } from './application/controller.js';
import { BrowserClassRepository, BrowserFilePort, BrowserFullscreenPort } from './platform/browser';
import { DesktopClassRepository, DesktopFilePort } from './platform/desktop';
import { APPEARANCE_MIRROR_KEY, applyAppearance, readAppearanceMirror } from './application/appearance';
import FloatingBall from './components/FloatingBall.vue';
import OnboardingFlow from './components/OnboardingFlow.vue';
import './styles/desktop.css';

const desktopRole = window.slateDesktop?.role;
if (desktopRole) document.documentElement.dataset.desktopRole = desktopRole;
document.documentElement.dataset.edition = desktopRole ? 'desktop' : 'lite';
document.title = desktopRole ? 'SlateRandom 岩选 · 更好玩好用的随机抽选' : 'SlateRandom 岩选 Lite · 更好玩好用的随机抽选';

const store = createAppStore(engine.createEmptyState());
const snapshot = store.snapshot;
const actions = shallowRef<ApplicationActions>();
const portable = Boolean(window.slateDesktop?.data && !window.slateDesktop.data.preview);
onMounted(() => {
  if (desktopRole === 'ball') return;
  const data = window.slateDesktop?.data;
  actions.value = mountController({ store, repository: portable && data ? new DesktopClassRepository(data) : new BrowserClassRepository(),
    filePort: portable && data ? new DesktopFilePort(data) : new BrowserFilePort(), fullscreenPort: new BrowserFullscreenPort() });
});

if (portable) {
  // A migrated profile can still turn out to be a first run; the main window
  // was only kept hidden by the ball preference, so ask for it explicitly.
  watch(() => snapshot.value.onboarding, open => { if (open) void window.slateDesktop?.openMain().catch(() => {}); });
}

if (desktopRole !== 'ball') {
  // Not immediate: the first paint uses the mirror/system default in main.ts,
  // and this watch applies the authoritative settings once the controller loads.
  watch(
    [
      () => snapshot.value.state.settings.theme,
      () => snapshot.value.state.settings.accent,
      () => snapshot.value.state.settings.radius,
      () => snapshot.value.state.settings.customCss,
      () => snapshot.value.state.settings.customCssEnabled
    ],
    () => applyAppearance(snapshot.value.state.settings),
    { flush: 'post' }
  );
}

if (desktopRole === 'ball') {
  const applyBallState = (): boolean => {
    try {
      const saved = window.slateDesktop?.data?.loadClass();
      const settings = saved && typeof saved === 'object'
        ? (saved as { settings?: unknown }).settings
        : undefined;
      if (settings) { applyAppearance(settings, { mirror: false }); return true; }
    } catch {
      // Portable data unavailable; fall back to the mirror below.
    }
    return false;
  };
  const syncBallAppearance = (fromState = false): void => {
    if (!fromState) {
      const mirrored = readAppearanceMirror();
      if (mirrored) { applyAppearance(mirrored, { mirror: false }); return; }
    }
    if (applyBallState()) return;
    const mirrored = readAppearanceMirror();
    if (mirrored) applyAppearance(mirrored, { mirror: false });
  };
  syncBallAppearance();
  window.addEventListener('storage', event => {
    if (event.key === APPEARANCE_MIRROR_KEY) syncBallAppearance();
  });
  // storage events are unreliable under file://; re-read the authoritative
  // portable state whenever the ball is touched.
  window.addEventListener('pointerdown', () => syncBallAppearance(true));
}
</script>

<template>
  <FloatingBall v-if="desktopRole === 'ball'" />
  <template v-else>
    <DrawSurface v-once />
    <ConfigDialog :snapshot="snapshot" :actions="actions" />
    <ModalDialogs v-once />
    <StatusLayer v-once />
    <OnboardingFlow :snapshot="snapshot" :actions="actions" />
    <div v-if="snapshot.onboarding" class="onboarding-cover" aria-hidden="true"></div>
    <div v-if="!snapshot.booted" class="boot-veil" aria-hidden="true"></div>
  </template>
</template>
