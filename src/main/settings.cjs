'use strict';
const fs = require('node:fs'), path = require('node:path');
const DEFAULTS = Object.freeze({ autostart: false, uac: false, uiAccess: false, showFloatingBall: true, manualElevation: 'uac', autostartElevation: 'uac' });
function normalizeSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const result = { autostart: source.autostart === true, uac: source.uac === true, uiAccess: source.uiAccess === true, showFloatingBall: source.showFloatingBall !== false, manualElevation: source.manualElevation === 'compatibility' ? 'compatibility' : 'uac', autostartElevation: source.autostartElevation === 'task' ? 'task' : 'uac' };
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
function createSettingsStore(directory) {
  const file = path.join(directory, 'desktop-settings.json');
  let data = { version: 1, settings: { ...DEFAULTS }, ball: null }, warning = null;
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')); data.settings = normalizeSettings(parsed.settings);
      if (parsed.ball && Number.isFinite(parsed.ball.x) && Number.isFinite(parsed.ball.y)) data.ball = { x: Math.round(parsed.ball.x), y: Math.round(parsed.ball.y) };
    }
  } catch { warning = '桌面设置无法读取，已使用默认值；班级记录不受影响。'; }
  const save = candidate => {
    fs.mkdirSync(directory, { recursive: true });
    const temporary = file + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(candidate, null, 2), 'utf8');fs.renameSync(temporary,file);
    data = candidate;
  };
  return { get settings() { return { ...data.settings }; }, get ball() { return data.ball && { ...data.ball }; }, warning,
    write(settings) { save({ ...data, settings: normalizeSettings(settings) }); },
    position(bounds) { save({ ...data, ball: { x: Math.round(bounds.x), y: Math.round(bounds.y) } }); } };
}
module.exports = { DEFAULTS, normalizeSettings, patchSettings, createSettingsStore };
