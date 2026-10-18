'use strict';
const fs = require('node:fs'), path = require('node:path');
const { PROTOCOL_SCHEMES } = require('./protocol-schemes.cjs');
const DEFAULTS = Object.freeze({ autostart: false, uac: false, uiAccess: false, showFloatingBall: true, manualElevation: 'uac', autostartElevation: 'uac', drawOnBallClick: false, externalDrawProtocols: false, slaterandomProtocol: true });
// reg export snapshots stay in this store so a disabled protocol can restore the
// exact association it replaced, including Unicode paths and value types.
const PROTOCOL_BACKUP_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/, PROTOCOL_BACKUP_LIMIT = 262144;
function normalizeSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const result = { autostart: source.autostart === true, uac: source.uac === true, uiAccess: source.uiAccess === true, showFloatingBall: source.showFloatingBall !== false, manualElevation: source.manualElevation === 'compatibility' ? 'compatibility' : 'uac', autostartElevation: source.autostartElevation === 'task' ? 'task' : 'uac', drawOnBallClick: source.drawOnBallClick === true, externalDrawProtocols: source.externalDrawProtocols === true, slaterandomProtocol: source.slaterandomProtocol !== false };
  if (!result.uac) result.uiAccess = false;
  return result;
}
function patchSettings(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('设置格式无效。');
  for (const key of Object.keys(patch)) {
    const choices = key === 'autostartElevation' ? ['uac', 'task'] : key === 'manualElevation' ? ['uac', 'compatibility'] : null;
    if (!Object.hasOwn(DEFAULTS, key) || (choices ? !choices.includes(patch[key]) : typeof patch[key] !== 'boolean')) throw Error('桌面设置字段或启动方式无效。');
  }
  const next = { ...current, ...patch };
  if (patch.uiAccess === true && !next.uac) throw Error('开启 UIAccess 前，请先开启 UAC 提权。');
  if (!next.uac) next.uiAccess = false;
  return normalizeSettings(next);
}
/** Only known schemes with a shaped entry survive; anything else is dropped, not repaired. */
function normalizeProtocolBackups(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) return null;
  const source = value.entries;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const entries = {};
  for (const scheme of PROTOCOL_SCHEMES) {
    if (!Object.hasOwn(source, scheme)) continue;
    const entry = source[scheme];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.existed !== 'boolean') continue;
    if (entry.existed === false) { entries[scheme] = { existed: false }; continue; }
    const reg = entry.reg;
    if (typeof reg !== 'string' || !reg.length || reg.length > PROTOCOL_BACKUP_LIMIT || !PROTOCOL_BACKUP_PATTERN.test(reg)) continue;
    entries[scheme] = { existed: true, reg };
  }
  return { version: 1, entries };
}
function copyProtocolBackups(value) {
  if (!value) return null;
  const entries = {};
  for (const [scheme, entry] of Object.entries(value.entries)) entries[scheme] = { ...entry };
  return { version: 1, entries };
}
function createSettingsStore(directory) {
  const file = path.join(directory, 'desktop-settings.json');
  let data = { version: 1, settings: { ...DEFAULTS }, ball: null, protocols: null }, warning = null;
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')); data.settings = normalizeSettings(parsed.settings);
      data.protocols = normalizeProtocolBackups(parsed.protocols);
      if (parsed.ball && Number.isFinite(parsed.ball.x) && Number.isFinite(parsed.ball.y)) data.ball = { x: Math.round(parsed.ball.x), y: Math.round(parsed.ball.y) };
    }
  } catch { warning = '桌面设置无法读取，已使用默认值；班级记录不受影响。'; }
  const save = candidate => {
    fs.mkdirSync(directory, { recursive: true });
    const temporary = file + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(candidate, null, 2), 'utf8');fs.renameSync(temporary,file);
    data = candidate;
  };
  return { get settings() { return { ...data.settings }; }, get ball() { return data.ball && { ...data.ball }; },
    get protocols() { return copyProtocolBackups(data.protocols); }, warning,
    write(settings) { save({ ...data, settings: normalizeSettings(settings) }); },
    set protocols(value) { save({ ...data, protocols: normalizeProtocolBackups(value) }); },
    position(bounds) { save({ ...data, ball: { x: Math.round(bounds.x), y: Math.round(bounds.y) } }); } };
}
module.exports = { DEFAULTS, normalizeSettings, patchSettings, normalizeProtocolBackups, createSettingsStore };
