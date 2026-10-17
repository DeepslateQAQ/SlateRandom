'use strict';

const path = require('node:path');
const { createPrivilegeService } = require('./privileges.cjs');
const { ownedTaskName, buildTaskXml } = require('./windows/task-definition.cjs');

function createAutostartService({ app, helperPath, executable, baseArgs = [], userData, platform = process.platform, privilegeService }) {
  if (!app || typeof app.setLoginItemSettings !== 'function') throw new TypeError('An Electron app instance is required.');
  const taskName = ownedTaskName(userData);
  const launchArgs = baseArgs.filter(value => value !== '--slate-startup' && value !== '--slate-relaunched').concat('--slate-startup');
  const privileges = privilegeService || createPrivilegeService({ helperPath, executable, baseArgs: launchArgs, workingDirectory: path.dirname(executable) });
  let pending = false;

  async function apply(settings) {
    if (platform !== 'win32') return { ok: false, cancelled: false, error: 'Windows startup settings are unavailable on this platform.' };
    if (!settings || ['autostart', 'uac', 'uiAccess'].some(key => typeof settings[key] !== 'boolean')) return { ok: false, cancelled: false, error: 'Invalid startup preferences.' };
    if (settings.uiAccess && !settings.uac) return { ok: false, cancelled: false, error: 'UIAccess requires UAC elevation.' };
    const method = settings.autostartElevation || 'uac';
    if (method !== 'uac' && method !== 'task') return { ok: false, cancelled: false, error: 'Invalid startup elevation method.' };
    if (pending) return { ok: false, cancelled: false, error: 'A startup change is already pending.' };
    pending = true;
    try {
      const token = await privileges.getStatus();
      if (!token.available || typeof token.userSid !== 'string') return { ok: false, cancelled: false, error: token.error || 'Unable to determine the current Windows user.' };
      const task = await privileges.queryTask({ taskName, userSid: token.userSid });
      if (!task.ok) return { ...task, ok: false, cancelled: false };
      if (task.exists && !task.owned) return { ok: false, cancelled: false, error: 'The scheduled-task name belongs to another application.' };
      const useTask = settings.autostart && settings.uac && method === 'task';
      if (useTask) {
        const installed = await privileges.configureTask({ operation: 'install', taskName, userSid: token.userSid });
        if (!installed.ok) return installed;
        try { app.setLoginItemSettings({ openAtLogin: false, path: executable, args: launchArgs }); }
        catch (error) {
          const rollback = task.exists ? { ok: true } : await privileges.configureTask({ operation: 'remove', taskName, userSid: token.userSid });
          return { ok: false, cancelled: false, error: `Unable to disable the old startup entry: ${error.message}${rollback.ok ? '' : '. The new task may still be registered; rollback was not confirmed.'}` };
        }
        return { ok: true, cancelled: false, method: 'task', taskName };
      }
      if (task.exists) {
        const removed = await privileges.configureTask({ operation: 'remove', taskName, userSid: token.userSid });
        if (!removed.ok) return removed;
      }
      try { app.setLoginItemSettings({ openAtLogin: settings.autostart, path: executable, args: launchArgs }); }
      catch (error) {
        const rollback = task.exists ? await privileges.configureTask({ operation: 'install', taskName, userSid: token.userSid }) : { ok: true };
        return { ok: false, cancelled: false, error: `Unable to update the startup entry: ${error.message}${rollback.ok ? '' : '. The previous task could not be restored.'}` };
      }
      return { ok: true, cancelled: false, method: settings.autostart ? 'uac' : 'disabled', taskName };
    } catch (error) { return { ok: false, cancelled: false, error: error instanceof Error ? error.message : String(error) }; }
    finally { pending = false; }
  }

  return Object.freeze({ apply, taskName });
}

module.exports = { createAutostartService, ownedTaskName, buildTaskXml };
