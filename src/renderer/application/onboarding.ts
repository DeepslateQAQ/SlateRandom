import type { DesktopDraft, DesktopSettings } from '../desktop/types';

/**
 * The first-run desktop step stages elevation in a draft and commits it in one
 * patch when the flow finishes. Everything here is pure so the mapping between
 * the two stored elevation fields and the single radio group stays testable.
 */
export type ElevationChoice = 'disabled' | 'uac' | 'compatibility' | 'task';

export function draftFromSettings(settings: DesktopSettings): DesktopDraft {
  return {
    uac: settings.uac,
    uiAccess: settings.uiAccess,
    manualElevation: settings.manualElevation,
    autostartElevation: settings.autostartElevation
  };
}

/** Autostart picks the login-time method; a manual launch uses the manual one. */
export function selectedElevation(draft: DesktopDraft, autostart: boolean): ElevationChoice {
  if (!draft.uac) return 'disabled';
  if (autostart) return draft.autostartElevation === 'task' ? 'task' : 'uac';
  return draft.manualElevation === 'compatibility' ? 'compatibility' : 'uac';
}

/** Each radio answers with the smallest draft change that reflects the choice. */
export function elevationChoiceDraft(choice: ElevationChoice, autostart: boolean): Partial<DesktopDraft> | null {
  if (choice === 'disabled') return { uac: false, uiAccess: false };
  if (choice === 'uac') return { uac: true, manualElevation: 'uac', autostartElevation: 'uac' };
  if (choice === 'task') return { uac: true, autostartElevation: 'task' };
  if (choice === 'compatibility') return { uac: true, manualElevation: 'compatibility' };
  return null;
}

/**
 * A confirmed autostart change makes one stored choice meaningless: compatibility
 * only describes a manual launch, a task only describes login startup. Reset just
 * that field so an untouched draft keeps its other elevation choices.
 */
export function reconcileAutostart(draft: DesktopDraft, autostart: boolean): DesktopDraft {
  if (!draft.uac) return draft;
  if (autostart && draft.manualElevation === 'compatibility') return { ...draft, manualElevation: 'uac' };
  if (!autostart && draft.autostartElevation === 'task') return { ...draft, autostartElevation: 'uac' };
  return draft;
}

/** Only differences are applied, so the bridge never rewrites an equal setting. */
export function desktopPatch(draft: DesktopDraft | null, settings: DesktopSettings | null | undefined): Partial<DesktopSettings> | undefined {
  if (!draft || !settings) return undefined;
  const patch: Partial<DesktopSettings> = {};
  if (draft.uac !== settings.uac) patch.uac = draft.uac;
  if (draft.uiAccess !== settings.uiAccess) patch.uiAccess = draft.uiAccess;
  if (draft.manualElevation !== settings.manualElevation) patch.manualElevation = draft.manualElevation;
  if (draft.autostartElevation !== settings.autostartElevation) patch.autostartElevation = draft.autostartElevation;
  return Object.keys(patch).length ? patch : undefined;
}
