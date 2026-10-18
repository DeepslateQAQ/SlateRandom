import engine from './engine';
import type { ClassState, Settings, Student } from '../../shared/domain/model';

export const BACKUP_LIMIT = 32 * 1024 * 1024;
export const BACKUP_MAGIC = new TextEncoder().encode('SLATERANDOM-BK1\n');
export type BackupKind = 'settings' | 'roster' | 'all';
export interface ProviderSettings { active: string; records: Record<string, unknown>[] }
export interface BackupCredentials { vision?: ProviderSettings; speech?: ProviderSettings }
export interface RosterBackup { className: string; demo: boolean; students: Student[]; cols: number; seatRows?: number }
export interface AllBackup {
  kind: 'all'; state: ClassState; credentials: BackupCredentials;
  desktopSettings: Record<string, unknown> | null; updatedAt?: string; legacy?: boolean;
}
export interface SettingsBackup { kind: 'settings'; settings: Settings; credentials: BackupCredentials; desktopSettings: Record<string, unknown> | null; updatedAt?: string }
export interface RosterDocument { kind: 'roster'; roster: RosterBackup; updatedAt?: string }
export type ParsedBackup = AllBackup | SettingsBackup | RosterDocument;

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function checkCredentials(value: unknown): BackupCredentials {
  if (!object(value)) throw new Error('备份中的提供商配置格式无效。');
  for (const scope of ['vision', 'speech']) {
    const entry = value[scope];
    if (entry === undefined) continue;
    if (!object(entry) || typeof entry.active !== 'string' || !Array.isArray(entry.records) || entry.records.length > 32) throw new Error('备份中的提供商配置格式无效。');
    const ids = new Set();
    for (const record of entry.records) {
      if (!object(record) || typeof record.provider !== 'string' || ids.has(record.provider) || (Object.hasOwn(record, 'key') && typeof record.key !== 'string')) throw new Error('备份中的提供商记录无效或重复。');
      ids.add(record.provider);
    }
  }
  return engine.clone(value) as BackupCredentials;
}
function desktop(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (!object(value)) throw new Error('桌面设置格式无效。');
  const allowed = ['autostart', 'uac', 'uiAccess', 'showFloatingBall', 'manualElevation', 'autostartElevation', 'drawOnBallClick', 'externalDrawProtocols', 'slaterandomProtocol'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('桌面设置包含不支持的字段。');
  for (const key of ['autostart', 'uac', 'uiAccess', 'showFloatingBall', 'drawOnBallClick', 'externalDrawProtocols', 'slaterandomProtocol']) if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean') throw new Error('桌面设置格式无效。');
  if (Object.hasOwn(value, 'autostartElevation') && !['uac', 'task'].includes(String(value.autostartElevation))) throw new Error('自启动提权方式无效。');
  if (Object.hasOwn(value, 'manualElevation') && !['uac', 'compatibility'].includes(String(value.manualElevation))) throw new Error('手动启动提权方式无效。');
  if (value.uiAccess === true && value.uac === false) throw new Error('UIAccess 需要启用 UAC 提权。');
  return engine.clone(value);
}
export function rosterSnapshot(state: ClassState): RosterBackup {
  return { className: state.className, demo: state.demo, students: engine.clone(state.students), cols: state.cols,
    ...(state.seatRows == null ? {} : { seatRows: state.seatRows }) };
}
function readRoster(value: unknown): RosterBackup {
  if (!object(value) || typeof value.className !== 'string' || typeof value.demo !== 'boolean' || !Array.isArray(value.students) || !Number.isInteger(value.cols)) throw new Error('名单备份格式无效。');
  const next = engine.createEmptyState(1);
  Object.assign(next, value); next.version = 1; next.settings = engine.settings();
  // Roster files carry no statistics, random seed, or active selection state.
  for (const key of Object.keys(value)) if (!['className', 'demo', 'students', 'cols', 'seatRows'].includes(key)) throw new Error('名单备份包含不支持的数据字段。');
  return rosterSnapshot(engine.restoreState(next));
}
export function applyRosterBackup(state: ClassState, roster: RosterBackup): ClassState {
  const validated = readRoster(roster);
  const next = validated.students.length ? engine.replaceStudents(state, validated.students) : engine.createEmptyState(state.rngState);
  // A deliberate roster restore also restores its saved friendship choices.
  Object.assign(next, validated); next.settings = engine.clone(state.settings);
  return engine.restoreState(next);
}
export function applySettingsBackup(state: ClassState, settings: unknown): ClassState {
  if (!object(settings)) throw new Error('抽选设置格式无效。');
  const next = engine.clone(state); next.settings = engine.settings(settings);
  return engine.restoreState(next);
}
/** Only an explicit full restore may replace an unreadable protected snapshot. */
export function verifyCurrentDataForRestore(loadCurrent: () => unknown, fullRestore: boolean): boolean {
  try { loadCurrent(); return true; }
  catch (error) { if (!fullRestore) throw error; return false; }
}
function parseDocument(value: unknown, kind?: BackupKind): ParsedBackup {
  if (!object(value)) throw new Error('备份格式无效。');
  if (value.format === 'SlateRandomBackup' && value.version === 1 && value.kind === 'all') {
    if (kind && kind !== 'all') throw new Error('备份类型与选择的导入类型不一致。');
    return { kind: 'all', state: engine.restoreState(value.state), credentials: checkCredentials(value.credentials), desktopSettings: desktop(value.desktop), updatedAt: typeof value.createdAt === 'string' ? value.createdAt : undefined };
  }
  if (value.format === 'SlateRandom.backup' && value.version === 1) {
    if (kind && value.kind !== kind) throw new Error('备份类型与选择的导入类型不一致。');
    const updatedAt = typeof value.createdAt === 'string' ? value.createdAt : undefined;
    if (value.kind === 'roster') return { kind: 'roster', roster: readRoster(value.roster), updatedAt };
    if (value.kind === 'settings') {
      if (!object(value.settings)) throw new Error('抽选设置格式无效。');
      return { kind: 'settings', settings: engine.settings(value.settings), credentials: checkCredentials(value.credentials), desktopSettings: desktop(value.desktopSettings), updatedAt };
    }
    throw new Error('备份类型无效。');
  }
  if (value.version === 1 && Array.isArray(value.students) && value.format === undefined) {
    if (kind && kind !== 'all') throw new Error('旧版班级备份请使用「恢复全部」导入。');
    return { kind: 'all', state: engine.restoreState(value), credentials: {}, desktopSettings: null, legacy: true };
  }
  throw new Error('备份格式或版本不受支持，请使用兼容版本的 SlateRandom 岩选。');
}
function checkSize(bytes: Uint8Array, limit = BACKUP_LIMIT): void {
  if (bytes.byteLength === 0 || bytes.byteLength > limit) throw new Error('备份为空或超过允许大小。');
}
async function transform(bytes: Uint8Array, inflate: boolean): Promise<Uint8Array> {
  const Stream = inflate ? globalThis.DecompressionStream : globalThis.CompressionStream;
  if (typeof Stream !== 'function') throw new Error('当前环境不支持完整备份压缩，请使用新版浏览器或桌面版。');
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new Stream('gzip'));
  const reader = stream.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > BACKUP_LIMIT) { await reader.cancel(); throw new Error('备份解压后超过 32 MB，已拒绝恢复。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
export async function encodeBackup(payload: unknown): Promise<Uint8Array> {
  const parsed = parseDocument(payload, 'all');
  if (parsed.kind !== 'all' || parsed.legacy) throw new Error('完整备份数据格式无效。');
  if (!globalThis.crypto?.subtle) throw new Error('当前环境不支持完整备份校验，请使用新版浏览器或桌面版。');
  const json = new TextEncoder().encode(JSON.stringify(payload)); checkSize(json);
  const compressed = await transform(json, false);
  const keyBytes = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new Uint8Array(BACKUP_MAGIC), tagLength: 128 }, key, new Uint8Array(compressed)));
  const result = new Uint8Array(76 + sealed.byteLength - 16);
  result.set(BACKUP_MAGIC); result.set(keyBytes, 16); result.set(iv, 48); result.set(sealed.subarray(-16), 60); result.set(sealed.subarray(0, -16), 76);
  return result;
}
export async function readBackup(input: ArrayBuffer | Uint8Array | string, kind?: BackupKind): Promise<ParsedBackup> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  checkSize(bytes, BACKUP_LIMIT * 2);
  const framed = bytes.length >= 16 && BACKUP_MAGIC.every((value, index) => bytes[index] === value);
  if (framed) {
    if (kind && kind !== 'all') throw new Error('备份类型与选择的导入类型不一致。');
    if (bytes.length < 77) throw new Error('完整备份不完整，当前数据未修改。');
    try {
      if (!globalThis.crypto?.subtle) throw new Error();
      const key = await crypto.subtle.importKey('raw', bytes.slice(16, 48), 'AES-GCM', false, ['decrypt']);
      const cipher = new Uint8Array(bytes.length - 76 + 16); cipher.set(bytes.subarray(76)); cipher.set(bytes.subarray(60, 76), bytes.length - 76);
      const compressed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(48, 60), additionalData: new Uint8Array(BACKUP_MAGIC), tagLength: 128 }, key, cipher));
      const json = await transform(compressed, true); checkSize(json);
      return parseDocument(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json)), 'all');
    } catch { throw new Error('完整备份校验失败、文件损坏或格式无效，当前数据未修改。'); }
  }
  checkSize(bytes);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')); }
  catch { throw new Error('备份不是有效的 UTF-8 JSON 或 SlateRandom 岩选完整备份。'); }
  return parseDocument(value, kind);
}
