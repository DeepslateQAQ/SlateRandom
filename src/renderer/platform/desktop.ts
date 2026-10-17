import engine from '../domain/engine';
import type { ClassState } from '../../shared/domain/model';
import type { SlateDesktopBridge } from '../desktop/types';
import { BrowserClassRepository, CLASS_STORAGE_KEY } from './browser';
import type { BinaryDownload, ClassLoadResult, ClassRepository, FilePort, TextDownload } from './ports';

/** Small synchronous checkpoints commit the draw before another command starts. */
export class DesktopClassRepository implements ClassRepository {
  constructor(private readonly data: NonNullable<SlateDesktopBridge['data']>,
    private readonly legacy = new BrowserClassRepository()) {}

  load(fallback: ClassState): ClassLoadResult {
    try {
      const saved = this.data.loadClass();
      if (saved !== null) return { state: engine.restoreState(saved), warning: '', fromStorage: true };
    } catch (error) {
      return {
        state: engine.clone(fallback), fromStorage: false, recoveryRequired: true,
        warning: error instanceof Error ? error.message : '便携数据无法读取，原文件已保留；请在数据页面恢复完整备份。'
      };
    }
    const migrated = this.legacy.load(fallback);
    if (migrated.recovery || migrated.warning) return migrated;
    try {
      this.data.saveClass(migrated.state);
    } catch (error) {
      return {
        ...migrated,
        saveError: error instanceof Error ? error.message : '迁移后的名单暂未保存，请及时导出备份。'
      };
    }
    // The original AppData profile remains intact. This copied entry is no
    // longer authoritative once portable JSON/binary checkpoints exist.
    try { globalThis.localStorage.removeItem(CLASS_STORAGE_KEY); } catch { /* Portable data is already durable. */ }
    return migrated;
  }

  save(state: ClassState): void { this.data.saveClass(state); }
}

export class DesktopFilePort implements FilePort {
  constructor(private readonly data: NonNullable<SlateDesktopBridge['data']>) {}
  async save(file: TextDownload | BinaryDownload): Promise<void> {
    const bytes = 'bytes' in file ? file.bytes : new TextEncoder().encode(file.text);
    await this.data.saveFile({ name: file.name, mime: file.mime, bytes });
  }
}
