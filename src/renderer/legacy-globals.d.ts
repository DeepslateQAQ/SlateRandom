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
  }
}
