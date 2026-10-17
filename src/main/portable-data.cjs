'use strict';

// Readable class/configuration JSON and a portable, authenticated statistics file.
// The local key prevents casual text editing and detects damage; it is deliberately
// portable, so this is not protection against somebody who can run arbitrary code.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const v8 = require('node:v8');
const zlib = require('node:zlib');

const VERSION = 1;
// The wire codec is independent of the domain/document schema. New statistics
// use portable UTF-8 JSON; codec 1 remains readable for existing V8 snapshots.
const STAT_CODEC = 2;
const LEGACY_STAT_CODEC = 1;
const LIMIT = 32 * 1024 * 1024;
const FILES = Object.freeze({ roster: 'roster.json', settings: 'settings.json', statistics: 'statistics.srstat', key: '.fairness-key' });
const JOURNAL = '.state-transaction.json';
const STAT_MAGIC = Buffer.from('SLATEST1');
const BACKUP_MAGIC = Buffer.from('SLATERANDOM-BK1\n');
const ROSTER_KEYS = new Set(['className', 'demo', 'students', 'cols', 'seatRows']);
const BACKUP_KINDS = new Set(['settings', 'roster', 'all']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value != null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);

class PortableDataError extends Error {
  constructor(code, message, cause) { super(message, cause ? { cause } : undefined); this.name = 'PortableDataError'; this.code = code; }
}
function invalid(message, code = 'DATA_INVALID') { throw new PortableDataError(code, message); }
function digest(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function jsonBytes(value) { return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function checkBytes(data, label, limit = LIMIT) {
  if (!Buffer.isBuffer(data) || data.length > limit) invalid(`${label}过大或格式无效。`);
  return data;
}
function parseJson(data, label) {
  try { return JSON.parse(checkBytes(data, label).toString('utf8')); }
  catch (error) { if (error instanceof PortableDataError) throw error; throw new PortableDataError('DATA_INVALID', `${label}不是有效的 UTF-8 JSON，原文件已保留。`, error); }
}
function generation(value) { return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value); }
function validEnvelope(value, format) {
  if (!object(value) || value.format !== format || value.version !== VERSION) invalid('数据格式或版本不受支持，请使用兼容版本的 SlateRandom。', 'DATA_VERSION');
}
function validateRoster(roster) {
  if (!object(roster) || typeof roster.className !== 'string' || roster.className.length > 200 || typeof roster.demo !== 'boolean' || !Number.isInteger(roster.cols) || roster.cols < 1 || roster.cols > 50 || !Array.isArray(roster.students) || roster.students.length > 2500) invalid('名单数据格式无效。');
  if (own(roster, 'seatRows') && (!Number.isInteger(roster.seatRows) || roster.seatRows < 1 || roster.seatRows > 100)) invalid('名单座位行数无效。');
  const ids = new Set(), seats = new Set();
  for (const student of roster.students) {
    if (!object(student) || typeof student.id !== 'string' || !/^[1-9]\d{0,11}$/.test(student.id) || ids.has(student.id) || typeof student.name !== 'string' || !student.name.trim() || student.name.length > 200 || !Number.isInteger(student.row) || student.row < 1 || student.row > 100 || !Number.isInteger(student.col) || student.col < 1 || student.col > roster.cols || typeof student.active !== 'boolean') invalid('名单包含无效学号、姓名或座位。');
    if (own(roster, 'seatRows') && student.row > roster.seatRows) invalid('名单座位超出配置的行数。');
    const seat = `${student.row}:${student.col}`;
    if (seats.has(seat)) invalid('名单中的座位重复。');
    if (student.friendTargets != null && (!Array.isArray(student.friendTargets) || student.friendTargets.length > roster.students.length || student.friendTargets.some(id => typeof id !== 'string'))) invalid('友尽目标格式无效。');
    ids.add(student.id); seats.add(seat);
  }
  return roster;
}
function validateSettings(settings) {
  if (!object(settings) || jsonBytes(settings).length > LIMIT / 4) invalid('抽选设置格式无效。');
  return settings;
}
function validateState(state) {
  if (!object(state) || state.version !== VERSION) invalid('班级状态格式或版本无效。');
  validateRoster(state); validateSettings(state.settings);
  if (!Number.isInteger(state.rngState) || state.rngState < 0 || state.rngState > 4294967295 || !Number.isInteger(state.round) || state.round < 0 || state.round > 1000000000 || !Array.isArray(state.history) || state.history.length > 2000 || !Array.isArray(state.cycleSeen) || !object(state.counts) || !object(state.lastSeen) || !object(state.fairnessStats)) invalid('公平统计或抽选状态格式无效。');
  checkBytes(jsonBytes(state), '班级数据');
  return state;
}
function split(state) {
  validateState(state);
  const roster = {}, statistics = {};
  for (const [key, value] of Object.entries(state)) {
    if (ROSTER_KEYS.has(key)) roster[key] = value;
    else if (key !== 'settings') statistics[key] = value;
  }
  return { roster: clone(roster), settings: clone(state.settings), statistics: clone(statistics) };
}
function encodeStatistics(statistics, roster, key, id) {
  const payload = jsonBytes({ format: 'SlateRandom.statistics', version: VERSION, generation: id, rosterHash: digest(jsonBytes(roster)), statistics });
  const codec = Buffer.alloc(2); codec.writeUInt16BE(STAT_CODEC);
  const header = Buffer.concat([STAT_MAGIC, codec, Buffer.from(id, 'hex')]);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(zlib.deflateSync(payload)), cipher.final()]);
  return Buffer.concat([header, nonce, ciphertext, cipher.getAuthTag()]);
}
function decodeStatistics(data, roster, key, id) {
  checkBytes(data, '公平统计');
  if (!Buffer.isBuffer(key) || key.length !== 32) invalid('公平统计校验密钥缺失或损坏；请恢复完整 data 目录或完整备份。', 'DATA_INTEGRITY');
  if (data.length < 54 || !data.subarray(0, 8).equals(STAT_MAGIC)) invalid('公平统计版本不受支持或文件头损坏，统计未被清空。', 'DATA_VERSION');
  const codec = data.readUInt16BE(8);
  if (codec !== STAT_CODEC && codec !== LEGACY_STAT_CODEC) invalid('公平统计版本不受支持或文件头损坏，统计未被清空。', 'DATA_VERSION');
  if (data.subarray(10, 26).toString('hex') !== id) invalid('名单、设置和公平统计不属于同一次保存；请恢复完整备份。', 'DATA_INTEGRITY');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(26, 38));
    decipher.setAAD(data.subarray(0, 26)); decipher.setAuthTag(data.subarray(-16));
    const compressed = Buffer.concat([decipher.update(data.subarray(38, -16)), decipher.final()]);
    const payload = zlib.inflateSync(compressed, { maxOutputLength: LIMIT });
    const value = codec === LEGACY_STAT_CODEC ? v8.deserialize(payload) : JSON.parse(payload.toString('utf8'));
    validEnvelope(value, 'SlateRandom.statistics');
    if (value.generation !== id || value.rosterHash !== digest(jsonBytes(roster)) || !object(value.statistics)) invalid('名单和公平统计校验不一致。', 'DATA_INTEGRITY');
    return value.statistics;
  } catch (error) {
    if (error instanceof PortableDataError) throw error;
    throw new PortableDataError('DATA_INTEGRITY', '公平统计校验失败，文件可能损坏或被修改；原统计已保留，请恢复完整备份。', error);
  }
}
function settingsDocument(data) {
  const value = parseJson(data, '设置文件'); validEnvelope(value, 'SlateRandom.settings');
  if (value.generation != null && !generation(value.generation)) invalid('设置文件的保存标识无效。');
  if (value.settings != null) validateSettings(value.settings);
  if (!object(value.credentials)) invalid('提供商配置格式无效。');
  return value;
}
function readParts(files) {
  const rosterDoc = parseJson(files[FILES.roster], '名单文件'); validEnvelope(rosterDoc, 'SlateRandom.roster');
  const settingsDoc = settingsDocument(files[FILES.settings]);
  if (!generation(rosterDoc.generation) || rosterDoc.generation !== settingsDoc.generation || settingsDoc.settings == null) invalid('名单和设置不属于同一次保存；原文件已保留。', 'DATA_INTEGRITY');
  const roster = validateRoster(rosterDoc.roster);
  const statistics = decodeStatistics(files[FILES.statistics], roster, files[FILES.key], rosterDoc.generation);
  const state = { ...statistics, ...roster, settings: settingsDoc.settings };
  validateState(state);
  return { state, credentials: settingsDoc.credentials, generation: rosterDoc.generation, updatedAt: rosterDoc.updatedAt };
}
function encodeBackup(value) {
  // Match the browser's portable frame exactly: magic16/key32/iv12/tag16/cipher.
  // The embedded random key deliberately permits use on another computer.
  const key = crypto.randomBytes(32), nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(BACKUP_MAGIC);
  const compressed = zlib.gzipSync(jsonBytes(value));
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return Buffer.concat([BACKUP_MAGIC, key, nonce, cipher.getAuthTag(), ciphertext]);
}
function readBackup(input, kind) {
  const data = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input || []);
  checkBytes(data, '备份', LIMIT * 2);
  if (data.subarray(0, 16).equals(BACKUP_MAGIC)) {
    if (kind && kind !== 'all') invalid('备份类型与选择的导入类型不一致。');
    if (data.length < 77) invalid('完整备份不完整。', 'DATA_INTEGRITY');
    const key = data.subarray(16, 48), nonce = data.subarray(48, 60), tag = data.subarray(60, 76);
    let value;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(BACKUP_MAGIC); decipher.setAuthTag(tag);
      const compressed = Buffer.concat([decipher.update(data.subarray(76)), decipher.final()]);
      value = JSON.parse(zlib.gunzipSync(compressed, { maxOutputLength: LIMIT }).toString('utf8'));
    }
    catch (error) { throw new PortableDataError('DATA_INTEGRITY', '完整备份无法解码，当前数据未修改。', error); }
    validEnvelope(value, 'SlateRandomBackup');
    if (value.kind !== 'all' || !object(value.credentials)) invalid('完整备份结构无效。');
    validateState(value.state);
    return { kind: 'all', state: clone(value.state), credentials: clone(value.credentials), desktopSettings: value.desktop == null ? null : clone(value.desktop), updatedAt: value.createdAt };
  }
  const value = parseJson(data, 'JSON 备份');
  validEnvelope(value, 'SlateRandom.backup');
  if (!['roster', 'settings'].includes(value.kind) || (kind && value.kind !== kind)) invalid('JSON 备份类型无效或与选择的类型不一致。');
  if (value.kind === 'roster') return { kind: 'roster', roster: clone(validateRoster(value.roster)), updatedAt: value.createdAt };
  validateSettings(value.settings);
  if (!object(value.credentials)) invalid('设置备份的提供商配置无效。');
  return { kind: 'settings', settings: clone(value.settings), credentials: clone(value.credentials), desktopSettings: value.desktopSettings == null ? null : clone(value.desktopSettings), updatedAt: value.createdAt };
}

function createPortableStore(options) {
  if (!object(options) || typeof options.directory !== 'string' || !options.directory.trim()) throw new TypeError('Portable data directory is required.');
  const directory = path.resolve(options.directory);
  const io = options.fileSystem || fs;
  const filePath = name => path.join(directory, name);
  const exists = name => io.existsSync(filePath(name));
  const read = name => io.readFileSync(filePath(name));
  function ioFailure(error) {
    if (error instanceof PortableDataError) return error;
    return new PortableDataError('DATA_IO', `无法读写便携数据目录“${directory}”。请将程序移到可写目录并保留完整 data 文件夹；不会改存 AppData。${error.code ? ` (${error.code})` : ''}`, error);
  }
  function atomic(name, bytes) {
    const temporary = filePath(`.${name.replace(/^\./, '')}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    let handle;
    try {
      handle = io.openSync(temporary, 'wx', 0o600);
      io.writeFileSync(handle, bytes); io.fsyncSync(handle); io.closeSync(handle); handle = undefined;
      io.renameSync(temporary, filePath(name));
    } finally {
      if (handle !== undefined) try { io.closeSync(handle); } catch {}
      try { if (io.existsSync(temporary)) io.unlinkSync(temporary); } catch {}
    }
  }
  function pendingFiles(value) {
    validEnvelope(value, 'SlateRandom.transaction');
    if (!object(value.files) || Object.keys(value.files).length !== Object.keys(FILES).length) invalid('便携数据事务日志损坏；原文件已保留。', 'DATA_INTEGRITY');
    const files = {};
    for (const name of Object.values(FILES)) {
      const entry = value.files[name];
      if (!object(entry) || typeof entry.data !== 'string' || typeof entry.sha256 !== 'string' || entry.data.length > LIMIT * 2) invalid('便携数据事务日志损坏。', 'DATA_INTEGRITY');
      const bytes = Buffer.from(entry.data, 'base64');
      if (digest(bytes) !== entry.sha256) invalid('便携数据事务日志校验失败；原文件已保留。', 'DATA_INTEGRITY');
      files[name] = bytes;
    }
    readParts(files);
    return files;
  }
  function apply(files) {
    for (const name of Object.values(FILES)) atomic(name, files[name]);
    io.unlinkSync(filePath(JOURNAL));
  }
  function recover() {
    try {
      if (!exists(JOURNAL)) return;
      const value = JSON.parse(checkBytes(read(JOURNAL), '保存事务', LIMIT * 4).toString('utf8'));
      apply(pendingFiles(value));
    } catch (error) { throw ioFailure(error); }
  }
  function transaction(files) {
    // Publish a complete, fsynced recovery journal before replacing any live file.
    // Readers roll this transaction forward before inspecting a generation.
    const id = readParts(files).generation;
    const entries = {};
    for (const name of Object.values(FILES)) entries[name] = { data: files[name].toString('base64'), sha256: digest(files[name]) };
    try {
      io.mkdirSync(directory, { recursive: true });
      atomic(JOURNAL, jsonBytes({ format: 'SlateRandom.transaction', version: VERSION, files: entries }));
    } catch (error) { throw ioFailure(error); }
    try {
      apply(files);
      return { status: 'committed', generation: id };
    } catch (error) {
      return { status: 'pending-recovery', generation: id, message: ioFailure(error).message };
    }
  }
  function loadFiles() {
    recover();
    try {
      const hasRoster = exists(FILES.roster), hasStatistics = exists(FILES.statistics);
      if (!hasRoster && !hasStatistics && !exists(FILES.key)) {
        if (exists(FILES.settings)) settingsDocument(read(FILES.settings));
        return null;
      }
      const result = {};
      for (const name of Object.values(FILES)) {
        if (!exists(name)) invalid('便携数据文件缺失；不会清空公平统计。请恢复完整 data 目录或完整备份。', 'DATA_INTEGRITY');
        result[name] = read(name);
      }
      return result;
    } catch (error) { throw ioFailure(error); }
  }
  function credentialDocument() {
    recover();
    try {
      if (exists(FILES.settings)) return settingsDocument(read(FILES.settings));
      return { format: 'SlateRandom.settings', version: VERSION, generation: null, settings: null, credentials: {} };
    } catch (error) { throw ioFailure(error); }
  }
  function credentialScope(scope) {
    if (typeof scope !== 'string' || !/^[a-z][a-z0-9_.:-]{0,79}$/i.test(scope) || ['constructor', 'prototype'].includes(scope)) invalid('提供商配置分区无效。');
    return scope;
  }
  function info() {
    const files = loadFiles();
    const decoded = files ? readParts(files) : null;
    return { directory, hasState: !!decoded, generation: decoded?.generation || null, updatedAt: decoded?.updatedAt || null, files: { ...FILES }, statisticsFormat: 'AES-256-GCM + deflate + UTF-8 JSON, codec v2 (reads V8 v1)', protection: 'portable-integrity' };
  }
  function buildFiles(state, credentials, key) {
    const parts = split(state), id = crypto.randomBytes(16).toString('hex'), now = new Date().toISOString();
    if (!object(credentials)) invalid('提供商配置格式无效。');
    return {
      [FILES.roster]: jsonBytes({ format: 'SlateRandom.roster', version: VERSION, generation: id, updatedAt: now, roster: parts.roster }),
      [FILES.settings]: jsonBytes({ format: 'SlateRandom.settings', version: VERSION, generation: id, updatedAt: now, settings: parts.settings, credentials: clone(credentials) }),
      [FILES.statistics]: encodeStatistics(parts.statistics, parts.roster, key, id),
      [FILES.key]: key,
    };
  }
  function save(state) {
    const current = loadFiles();
    // A damaged existing generation must never be silently overwritten as empty.
    if (current) readParts(current);
    const key = current ? current[FILES.key] : crypto.randomBytes(32);
    const credentials = credentialDocument().credentials;
    const files = buildFiles(state, credentials, key);
    const outcome = transaction(files);
    if (outcome.status === 'pending-recovery') recover();
    const document = JSON.parse(files[FILES.roster].toString('utf8'));
    return { directory, hasState: true, generation: document.generation, updatedAt: document.updatedAt, files: { ...FILES } };
  }
  function exportData(kind, extra = {}) {
    if (!BACKUP_KINDS.has(kind)) invalid('导出类型无效。');
    const files = loadFiles();
    if (!files) invalid('尚无可导出的名单和设置。', 'DATA_EMPTY');
    const decoded = readParts(files), parts = split(decoded.state), createdAt = new Date().toISOString();
    const stamp = createdAt.slice(0, 19).replace(/[:T]/g, '-');
    if (kind === 'all') return { fileName: `SlateRandom-all-${stamp}.slate`, mimeType: 'application/octet-stream', data: encodeBackup({ format: 'SlateRandomBackup', version: VERSION, kind: 'all', createdAt, state: decoded.state, credentials: decoded.credentials, desktop: extra.desktopSettings || null }) };
    const payload = { format: 'SlateRandom.backup', version: VERSION, kind, createdAt };
    if (kind === 'roster') payload.roster = parts.roster;
    else { payload.settings = parts.settings; payload.credentials = decoded.credentials; payload.desktopSettings = extra.desktopSettings || null; }
    return { fileName: `SlateRandom-${kind}-${stamp}.json`, mimeType: 'application/json', data: jsonBytes(payload) };
  }
  function restoreAll(input) {
    const backup = readBackup(input, 'all');
    // Explicit full restore can repair a damaged current generation: unlike save,
    // it is a deliberate, completely validated replacement selected by the user.
    return restorePayload(backup);
  }
  function restorePayload(payload) {
    if (!object(payload) || !object(payload.credentials)) invalid('完整恢复的数据结构无效。');
    const files = buildFiles(payload.state, payload.credentials, crypto.randomBytes(32));
    return transaction(files);
  }
  return {
    directory, load() { const files = loadFiles(); return files ? clone(readParts(files).state) : null; }, save, info, exportData, readBackup, restoreAll, restorePayload,
    readCredentials(scope) { const value = credentialDocument().credentials[credentialScope(scope)]; return value == null ? null : clone(value); },
    writeCredentials(scope, payload) {
      credentialScope(scope);
      if (payload !== null && !object(payload)) invalid('提供商配置应为对象。');
      const files = loadFiles(); if (files) readParts(files);
      const document = credentialDocument();
      if (payload === null) delete document.credentials[scope];
      else { checkBytes(jsonBytes(payload), '提供商配置', LIMIT / 4); document.credentials[scope] = clone(payload); }
      try { io.mkdirSync(directory, { recursive: true }); atomic(FILES.settings, jsonBytes(document)); }
      catch (error) { throw ioFailure(error); }
      return true;
    },
  };
}

module.exports = { createPortableStore, readBackup, PortableDataError, FILES, VERSION };
