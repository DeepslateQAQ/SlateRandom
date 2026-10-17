import { shallowReadonly, shallowRef } from 'vue';
import engine from '../domain/engine';
import type { ClassState } from '../../shared/domain/model';

export type ConfigView = 'general' | 'dashboard' | 'roster' | 'data' | 'help' | 'about' | 'history';
export interface AppSnapshot {
  state: ClassState;
  busy: boolean;
  saveError: string;
  recoveryRequired: boolean;
  view: ConfigView;
  swapMode: boolean;
  swapFirst: string | null;
  modeError: string;
  validationRevision: number;
}

/** Publish immutable snapshots at command boundaries; animation frames stay outside Vue. */
export function createAppStore(initial: ClassState) {
  const snapshot = shallowRef<AppSnapshot>({ state: engine.clone(initial), busy: false,
    saveError: '', recoveryRequired: false,
    view: 'dashboard', swapMode: false, swapFirst: null, modeError: '', validationRevision: 0 });
  return {
    snapshot: shallowReadonly(snapshot),
    publish(next: AppSnapshot): void {
      snapshot.value = { ...next, state: engine.clone(next.state) };
    }
  };
}
export type AppStore = ReturnType<typeof createAppStore>;
