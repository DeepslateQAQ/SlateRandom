import { readonly, ref, shallowRef } from 'vue';
import type { DesktopSettings, DesktopState } from './types';

const desktopState = shallowRef<DesktopState | null>(null);
const pending = ref(false);
const connectionError = ref('');
let initialized: Promise<void> | undefined;

export function initializeDesktopState(): Promise<void> {
  if (!initialized) {
    const bridge = window.slateDesktop;
    initialized = bridge ? bridge.state().then(state => {
      desktopState.value = state;
      bridge.subscribe(next => { desktopState.value = next; });
    }).catch((error: unknown) => {
      connectionError.value = error instanceof Error ? error.message : '无法读取桌面设置。';
    }) : Promise.resolve();
  }
  return initialized;
}

export function useDesktopState() {
  void initializeDesktopState();
  return { state: readonly(desktopState), pending: readonly(pending), error: readonly(connectionError) };
}

export async function updateDesktopSettings(patch: Partial<DesktopSettings>): Promise<void> {
  const bridge = window.slateDesktop;
  if (!bridge || pending.value) return;
  pending.value = true;
  connectionError.value = '';
  try { desktopState.value = await bridge.updateSettings(patch); }
  catch (error: unknown) { connectionError.value = error instanceof Error ? error.message : '桌面设置保存失败。'; }
  finally { pending.value = false; }
}
