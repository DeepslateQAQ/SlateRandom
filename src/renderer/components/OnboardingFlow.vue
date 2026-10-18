<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import appIcon from '../../../resources/icons/icon.png?inline';
import type { AppSnapshot } from '../application/store';
import type { ApplicationActions } from '../application/controller.js';
import { useDesktopState, updateDesktopSettings } from '../desktop/state';
import type { DesktopDraft } from '../desktop/types';
import { desktopPatch as desktopPatchOf, draftFromSettings, reconcileAutostart } from '../application/onboarding';
import OnboardingAppearance from './OnboardingAppearance.vue';
import OnboardingDesktop from './OnboardingDesktop.vue';
import OnboardingRoster from './OnboardingRoster.vue';
import OnboardingProbability from './OnboardingProbability.vue';

type Step = 'welcome' | 'appearance' | 'general' | 'roster' | 'probability' | 'finish';
type IntroPhase = 'entering' | 'title' | 'content';

const props = defineProps<{ snapshot: AppSnapshot; actions?: ApplicationActions }>();

const desktopEdition = Boolean(window.slateDesktop);
const dialog = ref<HTMLDialogElement | null>(null);
const heading = ref<HTMLElement | null>(null);
const scrollArea = ref<HTMLElement | null>(null);
const backupInput = ref<HTMLInputElement | null>(null);
const step = ref<Step>('welcome');
const introPhase = ref<IntroPhase>('entering');
/** Bumped per open so the welcome card remounts instead of animating backwards. */
const openRun = ref(0);
const finishing = ref(false);
const finishError = ref('');
let introTimers: ReturnType<typeof setTimeout>[] = [];

const { state: desktopState, pending: desktopPending, error: desktopError } = useDesktopState();
const desktopDraft = ref<DesktopDraft | null>(null);
const desktopInitialized = ref(false);

const setupSteps = computed(() => ([
  { id: 'appearance' as Step, name: '外观' },
  ...(desktopEdition ? [{ id: 'general' as Step, name: '桌面' }] : []),
  { id: 'roster' as Step, name: '名单' },
  { id: 'probability' as Step, name: '概率' }
]));

const order = computed<Step[]>(() => ['welcome', ...setupSteps.value.map(item => item.id), 'finish']);
const isSetupStep = computed(() => setupSteps.value.some(item => item.id === step.value));
const blocked = computed(() => props.snapshot.busy || finishing.value);

const TITLES: Record<Step, string> = {
  welcome: 'SlateRandom 岩选',
  appearance: '选择外观',
  general: '桌面启动',
  roster: '导入名单',
  probability: '抽选概率',
  finish: '配置完成'
};
const LEADS: Record<Exclude<Step, 'welcome'>, string> = {
  appearance: '主题、主题色、圆角和背景扩散会即时预览。',
  general: '开机自启立即生效，提权在完成引导后应用。',
  roster: '一行一位同学，Excel、CSV 和座位表图片都能导入。',
  probability: '普通抽选用剩余概率，其他模式各自开关。',
  finish: '欢迎使用 SlateRandom 岩选！'
};
const stepTitle = computed(() => TITLES[step.value]);
const stepLead = computed(() => (step.value === 'welcome' ? '' : LEADS[step.value]));

const nextLabel = computed(() => (step.value === 'roster' && !props.snapshot.state.students.length ? '稍后再说' : '下一步'));

function headingElement(): HTMLElement | null { return heading.value; }

function go(target: Step): void {
  step.value = target;
  finishError.value = '';
  void nextTick(() => {
    scrollArea.value?.scrollTo({ top: 0 });
    headingElement()?.focus({ preventScroll: true });
  });
}

function next(): void {
  const list = order.value, index = list.indexOf(step.value);
  if (index < 0 || index >= list.length - 1) return;
  go(list[index + 1]!);
}

function back(): void {
  const list = order.value, index = list.indexOf(step.value);
  if (index > 0) go(list[index - 1]!);
}

function clearIntroTimers(): void {
  for (const timer of introTimers) clearTimeout(timer);
  introTimers = [];
}

function reducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
}

function startIntro(): void {
  clearIntroTimers();
  if (reducedMotion()) { introPhase.value = 'content'; return; }
  introPhase.value = 'entering';
  // The mark floats in first, then slides left to make room for the title, then
  // the tagline and the three actions follow.
  introTimers.push(setTimeout(() => { introPhase.value = 'title'; }, 420));
  introTimers.push(setTimeout(() => { introPhase.value = 'content'; }, 1300));
}

function skipIntro(): void {
  if (introPhase.value === 'content') return;
  clearIntroTimers();
  introPhase.value = 'content';
}

function onKeydown(event: KeyboardEvent): void {
  if (introPhase.value === 'content') return;
  if (event.key !== 'Enter' && event.key !== ' ' && event.code !== 'Space') return;
  event.preventDefault();
  skipIntro();
}

watch(introPhase, phase => {
  if (phase === 'content' && step.value === 'welcome') {
    void nextTick(() => (document.getElementById('onboardingStartBtn') as HTMLElement | null)?.focus({ preventScroll: true }));
  }
});

/** Every run starts from what is stored, never from an abandoned draft. */
function resetDesktopDraft(): void {
  desktopInitialized.value = false;
  desktopDraft.value = desktopState.value ? draftFromSettings(desktopState.value.settings) : null;
  desktopInitialized.value = desktopState.value != null;
}

watch(desktopState, value => {
  if (!value || desktopInitialized.value) return;
  desktopDraft.value = draftFromSettings(value.settings);
  desktopInitialized.value = true;
});

async function changeAutostart(enabled: boolean): Promise<void> {
  const draft = desktopDraft.value;
  if (!desktopState.value || !draft) return;
  await updateDesktopSettings({ autostart: enabled });
  // A rejected or ignored write leaves the stored value in place.
  if (desktopState.value.settings.autostart !== enabled) return;
  desktopDraft.value = reconcileAutostart(draft, enabled);
}

function changeDraft(patch: Partial<DesktopDraft>): void {
  if (!desktopDraft.value) return;
  desktopDraft.value = { ...desktopDraft.value, ...patch };
}

const desktopPatch = computed(() => desktopPatchOf(desktopDraft.value, desktopState.value?.settings));

function register(element: HTMLDialogElement): void {
  window.DialogTransitions?.register(element, {
    canClose: () => false,
    onEscape: () => {
      if (!finishing.value && step.value !== 'welcome' && step.value !== 'finish') back();
      return true;
    }
  });
}

function openFlow(): void {
  // A fresh card per open: the previous run's end state must never animate back
  // through the entrance before the new one starts.
  openRun.value += 1;
  step.value = 'welcome';
  finishing.value = false;
  finishError.value = '';
  resetDesktopDraft();
  startIntro();
  const element = dialog.value;
  if (!element) return;
  // The snapshot can arrive before onMounted, so register again right before use.
  register(element);
  if (!element.open) {
    try { element.showModal(); }
    catch { /* Already modal, or no document focus: the next publish retries. */ }
  }
  void nextTick(() => headingElement()?.focus({ preventScroll: true }));
}

function closeFlow(): void {
  clearIntroTimers();
  const element = dialog.value;
  if (element?.open) element.close();
  step.value = 'welcome';
  document.getElementById('drawBtn')?.focus({ preventScroll: true });
}

watch(() => props.snapshot.onboarding, open => { if (open) openFlow(); else closeFlow(); }, { flush: 'sync' });

onMounted(() => {
  const element = dialog.value;
  if (!element) return;
  register(element);
  if (props.snapshot.onboarding) openFlow();
});

onBeforeUnmount(clearIntroTimers);

function requestBackup(): void {
  if (blocked.value) return;
  backupInput.value?.click();
}

function onBackupFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) void props.actions?.restoreAllFile(file);
}

/**
 * The way out mirrors the way in: the flow fades while the button it was just
 * pressed flies onto the home screen's own draw button, so the two screens read
 * as one move instead of a hard cut. Everything here is inline and reversible.
 */
function startFinishTransition(): { done: Promise<void>; cancel: () => void } {
  const noop = (): void => {};
  const element = dialog.value;
  const button = document.getElementById('onboardingFinishBtn') as HTMLElement | null;
  const target = document.getElementById('drawBtn');
  const shell = document.querySelector<HTMLElement>('.onboarding-shell');
  if (!element || !button || !target || !shell || reducedMotion()) return { done: Promise.resolve(), cancel: noop };

  const from = button.getBoundingClientRect(), to = target.getBoundingClientRect();
  if (!from.width || !to.width) return { done: Promise.resolve(), cancel: noop };
  const cover = document.querySelector<HTMLElement>('.onboarding-cover');
  const flyer = button.cloneNode(true) as HTMLElement;
  // The clone is decorative: it must not duplicate the id or stay focusable.
  flyer.removeAttribute('id');
  flyer.removeAttribute('disabled');
  flyer.setAttribute('aria-hidden', 'true');
  flyer.tabIndex = -1;
  flyer.classList.add('onboarding-flyer');
  Object.assign(flyer.style, {
    left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`,
    transition: 'left 420ms cubic-bezier(.22,.7,.25,1), top 420ms cubic-bezier(.22,.7,.25,1), width 420ms cubic-bezier(.22,.7,.25,1), height 420ms cubic-bezier(.22,.7,.25,1), border-radius 420ms ease, opacity 160ms ease 280ms'
  });
  element.appendChild(flyer);
  shell.classList.add('is-exiting');
  element.style.transition = 'background-color 260ms ease';
  element.style.backgroundColor = 'transparent';
  if (cover) { cover.style.transition = 'opacity 260ms ease'; cover.style.opacity = '0'; }
  // Commit the starting geometry before asking for the landing one.
  void flyer.offsetWidth;
  flyer.style.left = `${to.left}px`; flyer.style.top = `${to.top}px`;
  flyer.style.width = `${to.width}px`; flyer.style.height = `${to.height}px`;
  flyer.style.borderRadius = getComputedStyle(target).borderTopLeftRadius;
  flyer.style.opacity = '0';

  const done = new Promise<void>(resolve => { setTimeout(resolve, 460); });
  const cancel = (): void => {
    flyer.remove();
    shell.classList.remove('is-exiting');
    element.style.removeProperty('transition');
    element.style.removeProperty('background-color');
    if (cover) { cover.style.removeProperty('transition'); cover.style.removeProperty('opacity'); }
  };
  return { done, cancel };
}

async function finish(): Promise<void> {
  const actions = props.actions;
  if (!actions || finishing.value) return;
  finishing.value = true;
  finishError.value = '';
  const transition = startFinishTransition();
  try {
    // The landing plays first; the completion flag is still written before any
    // desktop patch can relaunch the process.
    await transition.done;
    const done = await actions.finishOnboarding(desktopPatch.value);
    if (!done) finishError.value = props.snapshot.saveError || '保存失败，请重试。';
  } finally {
    transition.cancel();
    finishing.value = false;
  }
}

async function skip(): Promise<void> {
  const actions = props.actions;
  if (!actions || finishing.value) return;
  finishError.value = '';
  if (actions.skipOnboarding()) return;
  // The failure publishes a new snapshot; read it after the parent re-renders.
  await nextTick();
  finishError.value = props.snapshot.saveError || '保存失败，请重试。';
}

function dismiss(): void { props.actions?.dismissOnboardingForSession(); }
</script>

<template>
  <dialog id="onboardingDialog" ref="dialog" class="dialog onboarding-dialog" aria-labelledby="onboardingTitle">
    <div class="modal-toast-wrap"><div class="toast" data-toast-host role="status" aria-live="polite" aria-atomic="true" hidden></div></div>
    <input id="onboardingBackupFile" ref="backupInput" type="file" hidden
      accept=".slate,.slatebackup,.json,application/octet-stream,application/json" @change="onBackupFile">
    <div class="onboarding-shell" :data-intro-phase="introPhase" @click="skipIntro" @keydown="onKeydown">
      <header v-if="isSetupStep" class="onboarding-header">
        <div class="onboarding-brand">
          <img class="onboarding-mark onboarding-mark-sm" :src="appIcon" alt="" width="26" height="26">
          <span class="onboarding-brand-text"><strong>SlateRandom 岩选</strong></span>
        </div>
        <ol class="onboarding-progress" aria-label="引导进度">
          <li v-for="item in setupSteps" :key="item.id" :data-progress="item.id"
            :aria-current="step === item.id ? 'step' : undefined">{{ item.name }}</li>
        </ol>
      </header>

      <main ref="scrollArea" class="onboarding-main">
        <section :key="step + ':' + openRun" class="onboarding-card" :data-onboarding-step="step">
          <template v-if="step === 'welcome'">
            <div class="onboarding-hero">
              <img class="onboarding-mark" :src="appIcon" alt="" width="184" height="184">
              <div class="onboarding-hero-copy">
                <h2 id="onboardingTitle" ref="heading" class="onboarding-hero-title" tabindex="-1">{{ stepTitle }}</h2>
                <p class="onboarding-tagline">更好玩好用的随机抽选</p>
                <div class="onboarding-welcome-actions">
                  <button id="onboardingStartBtn" type="button" class="btn btn-primary onboarding-primary"
                    :disabled="introPhase !== 'content' || blocked" @click.stop="go('appearance')">
                    <span class="icon material-icon" aria-hidden="true">arrow_forward</span>从这里开始
                  </button>
                  <button id="onboardingSkipBtn" type="button" class="text-btn"
                    :disabled="introPhase !== 'content' || blocked" @click.stop="skip">
                    <span class="icon material-icon" aria-hidden="true">close</span>跳过引导
                  </button>
                  <button id="onboardingImportBackupBtn" type="button" class="text-btn"
                    aria-label="导入全部备份并跳过引导" :disabled="introPhase !== 'content' || blocked"
                    @click.stop="requestBackup">
                    <span class="icon material-icon" aria-hidden="true">upload</span>导入备份
                  </button>
                </div>
              </div>
            </div>
          </template>

          <template v-else>
            <header class="onboarding-card-heading">
              <h2 id="onboardingTitle" ref="heading" tabindex="-1">{{ stepTitle }}</h2>
              <p class="onboarding-lead">{{ stepLead }}</p>
            </header>

            <OnboardingAppearance v-if="step === 'appearance'" :settings="snapshot.state.settings"
              :busy="blocked" :actions="actions" />
            <OnboardingDesktop v-else-if="step === 'general'" :state="desktopState" :draft="desktopDraft"
              :error="desktopError" :pending="desktopPending || finishing" :busy="blocked"
              @autostart="changeAutostart" @draft="changeDraft" />
            <OnboardingRoster v-else-if="step === 'roster'" :state="snapshot.state" :busy="blocked" :actions="actions" />
            <OnboardingProbability v-else-if="step === 'probability'" :state="snapshot.state" :busy="blocked"
              :mode-error="snapshot.modeError" :validation-revision="snapshot.validationRevision"
              @toggle="(mode, enabled) => actions?.toggleMode(mode, enabled)"
              @chance="(mode, value) => actions?.changeChance(mode, value)"
              @strategy="value => actions?.strategy(value)"
              @manual-mode="value => actions?.manualMode(value)" />
            <div v-else-if="step === 'finish'" class="onboarding-finish">
              <button id="onboardingFinishBtn" type="button" class="btn btn-primary"
                :disabled="blocked || desktopPending" @click="finish">
                <span class="icon material-icon" aria-hidden="true">shuffle</span>开始抽人
              </button>
            </div>
          </template>

          <p v-if="finishError" id="onboardingError" class="error-message onboarding-error" role="alert">{{ finishError }}</p>
          <button v-if="finishError" id="onboardingDismissBtn" type="button" class="text-btn onboarding-dismiss"
            @click="dismiss">仍然进入</button>
        </section>
      </main>

      <footer v-if="isSetupStep" class="onboarding-footer">
        <button id="onboardingBackBtn" type="button" class="btn btn-plain" :disabled="blocked" @click="back">
          <span class="icon material-icon" aria-hidden="true">arrow_back</span>上一步
        </button>
        <button id="onboardingNextBtn" type="button" class="btn btn-primary" :disabled="blocked || desktopPending"
          @click="next">
          {{ nextLabel }}<span class="icon material-icon" aria-hidden="true">arrow_forward</span>
        </button>
      </footer>
    </div>
  </dialog>
</template>
