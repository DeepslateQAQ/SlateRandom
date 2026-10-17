'use strict';

function failure(label, error, fallback) {
  const detail = error instanceof Error ? error.message : error == null ? fallback : String(error);
  return new Error(`${label}：${detail || fallback}`, error instanceof Error ? { cause: error } : undefined);
}

async function applyDesktopSettings({ previous, next, applyStartup, persist, relaunch }) {
  let startupApplied = false, preferencesPersisted = false, cancelled = false;
  const errors = [];
  try {
    if (applyStartup) {
      const outcome = await applyStartup(next);
      if (outcome?.ok !== true) {
        cancelled = outcome?.cancelled === true;
        throw failure('应用自启动设置失败', outcome?.error, cancelled ? '操作已取消。' : '系统未确认自启动变更。');
      }
      startupApplied = true;
    }
    persist(next);
    preferencesPersisted = true;
    if (relaunch) {
      const outcome = await relaunch(next);
      if (outcome?.started !== true) {
        cancelled = true;
        throw failure('启动新桌面进程失败', outcome?.error, outcome?.cancelled ? '操作已取消。' : '新进程未启动。');
      }
      return { started: true, error: null };
    }
    return { started: false, error: null };
  } catch (error) {
    errors.push(error instanceof Error ? error : failure('应用桌面设置失败', error, '未知错误。'));
  }

  // Startup and preferences are separate side effects: neither failed compensation
  // may prevent the other one from being attempted.
  if (startupApplied) {
    try {
      const outcome = await applyStartup(previous);
      if (outcome?.ok !== true) throw failure('恢复自启动设置失败', outcome?.error, outcome?.cancelled ? '操作已取消。' : '系统未确认自启动恢复。');
    } catch (error) {
      errors.push(failure('自启动补偿失败', error, '未知错误。'));
    }
  }
  if (preferencesPersisted) {
    try { persist(previous); }
    catch (error) { errors.push(failure('桌面偏好补偿失败', error, '未知错误。')); }
  }
  const message = errors.map(error => error.message).join('\n');
  if (cancelled) return { started: false, error: message };
  throw new AggregateError(errors, message);
}

module.exports = { applyDesktopSettings };
