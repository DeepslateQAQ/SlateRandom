export const HOLD_MS = 500;
export const CANCEL_MS = 200;
export type PressIntent = 'draw' | 'cancel' | 'configure';

/** Pointer and keyboard use the same elapsed-time contract, independent of easing. */
export function pressIntent(elapsedMs: number, cancelled = false, fired = false): PressIntent {
  if (cancelled) return 'cancel';
  if (fired || elapsedMs >= HOLD_MS) return 'configure';
  return elapsedMs < CANCEL_MS ? 'draw' : 'cancel';
}
