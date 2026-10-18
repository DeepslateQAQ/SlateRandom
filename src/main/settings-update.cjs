'use strict';

function failure(label, error, fallback) {
  const detail = error instanceof Error ? error.message : error == null ? fallback : String(error);
  return new Error(`${label}：${detail || fallback}`, error instanceof Error ? { cause: error } : undefined);
}

async function applyDesktopSettings({ previous, next, applyStartup, applyProtocols, persist, relaunch }) {
  let startupApplied = false, preferencesPersisted = false, cancelled = false;
  // Protocol writes can partially complete (one scheme per group), so the
  // compensation runs whenever the step was attempted, not only when it failed.
  let protocolsAttempted = false;
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
    if (applyProtocols) {
      protocolsAttempted = true;
      const outcome = await applyProtocols(next);
      if (outcome?.ok !== true) throw failure('应用协议设置失败', outcome?.error, '系统未确认协议注册变更。');
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

  // Each side effect is separate: no failed compensation may prevent another one.
  if (protocolsAttempted) {
    try {
      const outcome = await applyProtocols(previous);
      if (outcome?.ok !== true) throw failure('恢复协议设置失败', outcome?.error, '系统未确认协议注册恢复。');
    } catch (error) {
      errors.push(failure('协议补偿失败', error, '未知错误。'));
    }
  }
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
