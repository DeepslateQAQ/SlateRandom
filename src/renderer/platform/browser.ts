import engine from '../domain/engine';
import type { ClassState, DomainEngine } from '../../shared/domain/model';
import type { BinaryDownload, ClassLoadResult, ClassRepository, FetchPort, FilePort, FullscreenPort, StorageLike, TextDownload } from './ports';

export const CLASS_STORAGE_KEY = 'rollcall-studio:v1';

export class BrowserClassRepository implements ClassRepository {
  constructor(private readonly suppliedStorage?: StorageLike, private readonly core: Pick<DomainEngine, 'clone' | 'restoreState'> = engine) {}

  private storage(): StorageLike {
    return this.suppliedStorage ?? globalThis.localStorage;
  }

  load(fallback: ClassState): ClassLoadResult {
    const initial = this.core.clone(fallback);
    let raw: string | null;
    try {
      raw = this.storage().getItem(CLASS_STORAGE_KEY);
    } catch {
      return { state: initial, warning: '浏览器未允许本机存储，本次操作仍可使用；请及时导出备份。', fromStorage: false };
    }
    if (raw === null) return { state: initial, warning: '', fromStorage: false };
    try {
      const parsed: unknown = JSON.parse(raw);
      return { state: this.core.restoreState(parsed), warning: '', fromStorage: true };
    } catch {
      const recovery = { key: CLASS_STORAGE_KEY + ':recovery', raw, saved: false };
      try {
        this.storage().setItem(recovery.key, raw);
        recovery.saved = true;
      } catch { /* The original entry remains available if the recovery write fails. */ }
      return {
        state: initial, recovery, fromStorage: false,
        warning: recovery.saved ? '本机记录格式无效，请重新配置名单。原记录保存在恢复副本中。' : '本机记录格式无效，请重新配置名单；原记录暂未覆盖。'
      };
    }
  }

  save(state: ClassState): void {
    this.storage().setItem(CLASS_STORAGE_KEY, JSON.stringify(state));
  }
}

export class BrowserFilePort implements FilePort {
  save(file: TextDownload | BinaryDownload): void {
    const name = file.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'SlateRandom 岩选导出';
    const contents = 'bytes' in file ? new Uint8Array(file.bytes).buffer : file.text;
    const url = URL.createObjectURL(new Blob([contents], { type: file.mime }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; anchor.hidden = true;
    document.body.appendChild(anchor);
    try { anchor.click(); }
    finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
}

export class BrowserFullscreenPort implements FullscreenPort {
  get active(): boolean { return document.fullscreenElement !== null; }

  async toggle(target: Element = document.documentElement): Promise<void> {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await target.requestFullscreen();
  }
}

export const browserFetch: FetchPort = (input, init) => globalThis.fetch(input, init);
