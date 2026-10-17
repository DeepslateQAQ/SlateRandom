import type { ClassState } from '../../shared/domain/model';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface RecoveryCopy {
  key: string;
  raw: string;
  saved: boolean;
}

export interface ClassLoadResult {
  state: ClassState;
  warning: string;
  fromStorage: boolean;
  saveError?: string;
  recoveryRequired?: boolean;
  recovery?: RecoveryCopy;
}

export interface ClassRepository {
  load(fallback: ClassState): ClassLoadResult;
  save(state: ClassState): void;
}

export interface TextDownload {
  name: string;
  text: string;
  mime: string;
}
export interface BinaryDownload {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

export interface FilePort {
  save(file: TextDownload | BinaryDownload): void | Promise<void>;
}

export interface FullscreenPort {
  readonly active: boolean;
  toggle(target?: Element): Promise<void>;
}

export type FetchPort = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Existing credential services remain separate from class data and backups. */
export const CREDENTIAL_DATABASES = {
  vision: 'rollcall-studio:providers',
  speech: 'rollcall-studio:speech-providers'
} as const;
