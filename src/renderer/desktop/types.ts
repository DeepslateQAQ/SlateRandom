import type { ClassState } from '../../shared/domain/model';
/** Renderer-only contract. Electron and native APIs stay behind the preload. */
export type DesktopRole = 'main' | 'ball';
export type BallSnap = 'none' | 'left' | 'right';

export interface DesktopSettings {
  autostart: boolean;
  uac: boolean;
  uiAccess: boolean;
  showFloatingBall: boolean;
  manualElevation: 'uac' | 'compatibility';
  autostartElevation: 'uac' | 'task';
}

export interface DesktopRuntime {
  elevated: boolean;
  uiAccess: boolean;
  autostart: boolean;
  status: string;
  error: string | null;
  requiresRestart: boolean;
}

export interface DesktopState {
  settings: DesktopSettings;
  runtime: DesktopRuntime;
  main?: { confirming: boolean; visible: boolean };
  ball: {
    snap: BallSnap;
    confirming: boolean;
    width: number;
    height: number;
    dragId?: string | null;
  };
}

/** dx/dy are total CSS screen-pixel displacement since dragStart. */
export interface DesktopDrag { id?: string; dx: number; dy: number }
export interface DesktopDragStart {
  id: string;
  screenX: number;
  screenY: number;
  pointerType: string;
}
export interface DesktopDragEnd { id: string; cancelled?: boolean }
export interface DesktopDragReady { nativeTracking: boolean }

export type DesktopRestoreOutcome =
  | { status: 'committed'; generation: string }
  | { status: 'pending-recovery'; generation: string; message: string };

export interface SlateDesktopBridge {
  readonly role: DesktopRole;
  state(): Promise<DesktopState>;
  updateSettings(patch: Partial<DesktopSettings>): Promise<DesktopState>;
  openMain(): Promise<void>;
  hideMain(): Promise<void>;
  quit(): Promise<void>;
  beginQuitConfirmation(): Promise<void>;
  endQuitConfirmation(): Promise<void>;
  readonly data?: {
    readonly preview: boolean;
    loadClass(): unknown | null;
    saveClass(state: ClassState): void;
    info(): Promise<{ directory: string; portable: boolean; generation?: string | null; migrated?: boolean; error?: string }>;
    readCredentials(scope: 'vision' | 'speech'): Promise<unknown | null>;
    writeCredentials(scope: 'vision' | 'speech', payload: unknown): Promise<void>;
    restoreAll(payload: { state: ClassState; credentials: Record<string, unknown> }): Promise<DesktopRestoreOutcome>;
    saveFile(file: { name: string; mime: string; bytes: Uint8Array }): Promise<void>;
  };
  speech?: { synthesize(text: string, voice?: string): Promise<Uint8Array>; clearCache(): Promise<void>; cancelPending(): Promise<void> };
  dragStart(start?: DesktopDragStart): Promise<void | DesktopDragReady>;
  dragMove(position: DesktopDrag): void;
  dragEnd(end?: DesktopDragEnd): Promise<void>;
  beginConfirmation(): Promise<void>;
  endConfirmation(): Promise<void>;
  subscribe(callback: (state: DesktopState) => void): () => void;
}

declare global {
  interface Window { readonly slateDesktop?: SlateDesktopBridge }
}
