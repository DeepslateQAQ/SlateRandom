'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildTaskXml, taskMarker, quoteWindowsArgument } = require('./windows/task-definition.cjs');

const STATUS_TIMEOUT = 8000;
const RELAUNCH_TIMEOUT = 135000;

/** The renderer receives only booleans; executable paths stay in the main process. */
function createPrivilegeService(options = {}) {
  const helperPath = path.resolve(options.helperPath || path.join(__dirname, '..', '..', 'build', 'windows', 'SlateRandom.Privileges.exe'));
  const executable = options.executable || process.execPath;
  const baseArgs = Array.isArray(options.baseArgs) ? [...options.baseArgs] : [];
  const workingDirectory = options.workingDirectory || path.dirname(executable);
  const platform = options.platform || process.platform;
  const runFile = options.runFile || runHelper;
  let pending = false;

  async function getStatus(pid = process.pid) {
    if (platform !== 'win32') return { available: false, elevated: false, uiAccess: false, error: 'Windows permissions are unavailable on this platform.' };
    if (!Number.isSafeInteger(pid) || pid < 1) return { available: false, elevated: false, uiAccess: false, error: 'Invalid process ID.' };
    try {
      await fs.access(helperPath);
      const result = await runFile(helperPath, ['status', String(pid)], STATUS_TIMEOUT);
      const status = parseReply(result);
      if (status.error) return { available: true, elevated: false, uiAccess: false, error: status.error, errorCode: status.errorCode };
      if (typeof status.elevated !== 'boolean' || typeof status.uiAccess !== 'boolean' || status.processId !== pid)
        throw new Error('The Windows helper did not return the requested process token.');
      return { available: true, elevated: status.elevated, uiAccess: status.uiAccess, processId: pid, sessionId: status.sessionId,
        ...(typeof status.userSid === 'string' ? { userSid: status.userSid } : {}), ...(typeof status.userName === 'string' ? { userName: status.userName } : {}) };
    } catch (error) {
      return { available: false, elevated: false, uiAccess: false, error: readableError(error) };
    }
  }

  async function requestRelaunch(request = {}) {
    if (platform !== 'win32') return failure('Windows permissions are unavailable on this platform.');
    if (typeof request.uiAccess !== 'boolean') return failure('The UIAccess request must be a boolean.');
    if (pending) return failure('An elevation request is already pending.');
    let temporaryDirectory;
    pending = true;
    try {
      await fs.access(helperPath);
      const launch = await validateLaunch({ executable, arguments: baseArgs, workingDirectory, uiAccess: request.uiAccess });
      temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'SlateRandom-privileges-'));
      const responsePath = path.join(temporaryDirectory, 'result.json');
      const encoded = Buffer.from(JSON.stringify(launch), 'utf8').toString('base64');
      const result = parseReply(await runFile(helperPath, ['elevate-launch', encoded, responsePath], RELAUNCH_TIMEOUT));
      if (result.cancelled === true || result.errorCode === 1223) return { started: false, cancelled: true };
      if (result.started !== true || result.error) return failure(result.error || 'Windows did not start the new instance.', result.errorCode);
      if (!Number.isSafeInteger(result.processId) || result.processId < 1 || result.elevated !== true || (request.uiAccess && result.uiAccess !== true))
        return failure('The new instance did not receive the requested Windows token.');
      return { started: true, cancelled: false, processId: result.processId, elevated: result.elevated, uiAccess: result.uiAccess === true };
    } catch (error) {
      return failure(readableError(error));
    } finally {
      pending = false;
      if (temporaryDirectory) {
        // Delete only this invocation's known files and empty directory. Never recurse.
        await fs.unlink(path.join(temporaryDirectory, 'result.json')).catch(() => {});
        await fs.unlink(path.join(temporaryDirectory, 'result.json.pending')).catch(() => {});
        await fs.rmdir(temporaryDirectory).catch(() => {});
      }
    }
  }

  async function queryTask({ taskName, userSid }) {
    if (platform !== 'win32') return { ok: false, cancelled: false, error: 'Windows scheduled tasks are unavailable on this platform.' };
    try {
      taskMarker(taskName);
      const launch = await validateLaunch({ executable, arguments: baseArgs, workingDirectory, uiAccess: false });
      const request = { ...launch, taskName, userSid };
      const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
      const result = parseReply(await runFile(helperPath, ['task-status', encoded], STATUS_TIMEOUT));
      if (result.ok !== true || typeof result.exists !== 'boolean') throw new Error(result.error || 'Unable to read the SlateRandom scheduled task.');
      return { ok: true, cancelled: false, exists: result.exists, owned: result.owned === true, taskName };
    } catch (error) { return { ok: false, cancelled: false, error: readableError(error) }; }
  }

  async function configureTask({ operation, taskName, userSid }) {
    if (platform !== 'win32') return { ok: false, cancelled: false, error: 'Windows scheduled tasks are unavailable on this platform.' };
    if (operation !== 'install' && operation !== 'remove') return { ok: false, cancelled: false, error: 'Invalid scheduled-task operation.' };
    if (pending) return { ok: false, cancelled: false, error: 'An elevation request is already pending.' };
    pending = true;
    let temporaryDirectory;
    try {
      taskMarker(taskName);
      await fs.access(helperPath);
      const launch = await validateLaunch({ executable, arguments: baseArgs, workingDirectory, uiAccess: false });
      const taskXml = buildTaskXml({ ...launch, taskName, userSid });
      const request = { ...launch, taskName, userSid, taskXml };
      temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'SlateRandom-privileges-'));
      const responsePath = path.join(temporaryDirectory, 'result.json');
      const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
      if (encoded.length > 30000) throw new Error('The scheduled-task request is too long.');
      const result = parseReply(await runFile(helperPath, [`task-${operation}`, encoded, responsePath], RELAUNCH_TIMEOUT));
      if (result.cancelled === true || result.errorCode === 1223) return { ok: false, cancelled: true, taskName };
      if (result.ok !== true || result.taskName !== taskName || result.error) return { ok: false, cancelled: false, taskName, error: result.error || 'The scheduled-task change was not verified.' };
      if (operation === 'install' && result.installed !== true) return { ok: false, cancelled: false, taskName, error: 'Windows did not verify the startup task.' };
      return { ok: true, cancelled: false, taskName, installed: operation === 'install' };
    } catch (error) { return { ok: false, cancelled: false, taskName, error: readableError(error) }; }
    finally {
      pending = false;
      if (temporaryDirectory) {
        await fs.unlink(path.join(temporaryDirectory, 'result.json')).catch(() => {});
        await fs.unlink(path.join(temporaryDirectory, 'result.json.pending')).catch(() => {});
        await fs.rmdir(temporaryDirectory).catch(() => {});
      }
    }
  }

  return Object.freeze({ getStatus, requestRelaunch, queryTask, configureTask });
}

async function validateLaunch(input) {
  if (typeof input.executable !== 'string' || !path.win32.isAbsolute(input.executable) || path.win32.extname(input.executable).toLowerCase() !== '.exe')
    throw new Error('An absolute Windows executable path is required.');
  if (!Array.isArray(input.arguments) || input.arguments.length > 64 || input.arguments.some(value => typeof value !== 'string' || value.includes('\0')))
    throw new Error('Invalid launch arguments.');
  if (typeof input.workingDirectory !== 'string' || !path.win32.isAbsolute(input.workingDirectory))
    throw new Error('An absolute working directory is required.');
  await fs.access(input.executable);
  const directory = await fs.stat(input.workingDirectory);
  if (!directory.isDirectory()) throw new Error('The working directory does not exist.');
  if (JSON.stringify(input).length > 30000) throw new Error('The launch request is too long.');
  return { executable: input.executable, arguments: [...input.arguments], workingDirectory: input.workingDirectory, uiAccess: input.uiAccess };
}

function runHelper(executable, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { windowsHide: true, timeout, maxBuffer: 256 * 1024, encoding: 'utf8', shell: false }, (error, stdout, stderr) => {
      if (stdout.trim()) return resolve(stdout);
      if (error) return reject(error.killed ? new Error('The Windows permission request timed out.') : new Error(stderr.trim() || error.message));
      reject(new Error('The Windows helper returned no token status.'));
    });
  });
}

function parseReply(result) {
  const reply = typeof result === 'string' ? JSON.parse(result.replace(/^\uFEFF/, '').trim()) : result;
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new Error('Invalid Windows helper response.');
  return reply;
}

function failure(error, errorCode) {
  return { started: false, cancelled: false, error, ...(Number.isInteger(errorCode) ? { errorCode } : {}) };
}

function readableError(error) { return error instanceof Error ? error.message : String(error); }

const defaultService = createPrivilegeService();
module.exports = { createPrivilegeService, getStatus: defaultService.getStatus, requestRelaunch: defaultService.requestRelaunch, quoteWindowsArgument };
