import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DesktopDraft, DesktopSettings } from '../../../../src/renderer/desktop/types';
import {
  desktopPatch,
  draftFromSettings,
  elevationChoiceDraft,
  reconcileAutostart,
  selectedElevation
} from '../../../../src/renderer/application/onboarding';

const settings: DesktopSettings = {
  autostart: false, uac: true, uiAccess: false, showFloatingBall: true,
  manualElevation: 'uac', autostartElevation: 'uac'
};
const draft = (patch: Partial<DesktopDraft> = {}): DesktopDraft => ({
  uac: true, uiAccess: false, manualElevation: 'uac', autostartElevation: 'uac', ...patch
});

test('the draft starts from the stored desktop settings', () => {
  assert.deepEqual(draftFromSettings(settings), draft());
  assert.deepEqual(draftFromSettings({ ...settings, uac: false, manualElevation: 'compatibility' }),
    { uac: false, uiAccess: false, manualElevation: 'compatibility', autostartElevation: 'uac' });
});

test('the selected radio follows the stored autostart mode', () => {
  assert.equal(selectedElevation(draft({ uac: false, uiAccess: false }), false), 'disabled');
  assert.equal(selectedElevation(draft(), false), 'uac');
  assert.equal(selectedElevation(draft(), true), 'uac');
  // Compatibility only describes a manual launch, a task only login startup.
  assert.equal(selectedElevation(draft({ manualElevation: 'compatibility' }), false), 'compatibility');
  assert.equal(selectedElevation(draft({ manualElevation: 'compatibility' }), true), 'uac');
  assert.equal(selectedElevation(draft({ autostartElevation: 'task' }), true), 'task');
  assert.equal(selectedElevation(draft({ autostartElevation: 'task' }), false), 'uac');
});

test('each choice writes the smallest possible draft change', () => {
  assert.deepEqual(elevationChoiceDraft('disabled', false), { uac: false, uiAccess: false });
  assert.deepEqual(elevationChoiceDraft('uac', true), { uac: true, manualElevation: 'uac', autostartElevation: 'uac' });
  assert.deepEqual(elevationChoiceDraft('compatibility', false), { uac: true, manualElevation: 'compatibility' });
  assert.deepEqual(elevationChoiceDraft('task', true), { uac: true, autostartElevation: 'task' });
  assert.equal(elevationChoiceDraft('unknown' as never, false), null);
});

test('turning autostart on or off drops only the choice that stopped applying', () => {
  const compatibility = draft({ manualElevation: 'compatibility' });
  assert.deepEqual(reconcileAutostart(compatibility, false), compatibility);
  assert.deepEqual(reconcileAutostart(compatibility, true), draft());

  const task = draft({ autostartElevation: 'task' });
  assert.deepEqual(reconcileAutostart(task, true), task);
  assert.deepEqual(reconcileAutostart(task, false), draft());

  // Both other fields survive a reconciliation untouched.
  const mixed = draft({ manualElevation: 'compatibility', autostartElevation: 'task' });
  assert.deepEqual(reconcileAutostart(mixed, true), draft({ autostartElevation: 'task' }));
  assert.deepEqual(reconcileAutostart(mixed, false), draft({ manualElevation: 'compatibility' }));

  // Without elevation there is nothing to reconcile.
  const disabled = draft({ uac: false, uiAccess: false, manualElevation: 'compatibility' });
  assert.deepEqual(reconcileAutostart(disabled, true), disabled);
});

test('finishing submits only changed fields, and nothing when the draft matches', () => {
  assert.equal(desktopPatch(draft(), settings), undefined);
  assert.equal(desktopPatch(null, settings), undefined);
  assert.equal(desktopPatch(draft(), null), undefined);
  assert.deepEqual(desktopPatch(draft({ uiAccess: true }), settings), { uiAccess: true });
  // Disabling elevation only reports the field that actually changes.
  assert.deepEqual(desktopPatch(draft({ uac: false, uiAccess: false }), settings), { uac: false });
  assert.deepEqual(desktopPatch(draft({ uac: false, uiAccess: false }), { ...settings, uiAccess: true }),
    { uac: false, uiAccess: false });
  assert.deepEqual(desktopPatch(draft({ manualElevation: 'compatibility', autostartElevation: 'task' }), settings),
    { manualElevation: 'compatibility', autostartElevation: 'task' });
  // Autostart is applied immediately, so it is never part of the completion patch.
  assert.equal(desktopPatch(draft(), { ...settings, autostart: true })?.autostart, undefined);
});
