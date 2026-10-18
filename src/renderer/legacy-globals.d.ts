export {};

declare global {
  interface Window {
    VisionProviders?: {
      open(): Promise<void>;
      completeTheme(prompt: string, options?: {
        signal?: AbortSignal;
        timeoutMs?: number;
        config?: unknown;
      }): Promise<string>;
    };
    /** Legacy dialog controller; registered by src/renderer/legacy/dialog-transitions.js. */
    DialogTransitions?: {
      open(dialog: HTMLDialogElement): Promise<unknown>;
      close(dialog: HTMLDialogElement, returnValue?: string): Promise<unknown>;
      init(): void;
      register(dialog: HTMLDialogElement, options?: {
        canClose?: () => boolean;
        onEscape?: (() => boolean | void) | null;
        onCloseStart?: (() => void) | null;
      }): void;
      topModal(): HTMLDialogElement | null;
    };
  }
}
