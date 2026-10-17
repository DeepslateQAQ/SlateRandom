'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createPrivilegeService, quoteWindowsArgument } = require('../../../../src/main/privileges.cjs');

const compiledHelperPath = path.join(__dirname, '../../../../build/windows/SlateRandom.Privileges.exe');
let helperPath;
let trustedLaunch;
test.before(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'SlateRandom-privileges-test-'));
  helperPath = path.join(directory, 'SlateRandom.Privileges.exe');
  await fs.writeFile(helperPath, 'unit-test helper fixture');
  trustedLaunch = { helperPath, executable: helperPath, workingDirectory: __dirname, platform: 'win32' };
});
test.after(async () => {
  await fs.unlink(helperPath);
  await fs.rmdir(path.dirname(helperPath));
});

test('non-Windows reports unavailable without launching anything', async () => {
  let calls = 0;
  const service = createPrivilegeService({ platform: 'linux', runFile: () => { calls++; } });
  assert.equal((await service.getStatus()).available, false);
  assert.equal((await service.requestRelaunch({ uiAccess: true })).started, false);
  assert.equal(calls, 0);
});

test('status queries the requested PID and preserves actual token values', async () => {
  const service = createPrivilegeService({ ...trustedLaunch, runFile: async (file, args, timeout) => {
    assert.equal(file, helperPath);
    assert.deepEqual(args, ['status', '1234']);
    assert.equal(timeout, 8000);
    return JSON.stringify({ processId: 1234, elevated: false, uiAccess: true, sessionId: 1, userSid: 'S-1-12-1-111-222-333-444', userName: 'AzureAD\\teacher' });
  } });
  assert.deepEqual(await service.getStatus(1234), { available: true, elevated: false, uiAccess: true, processId: 1234, sessionId: 1, userSid: 'S-1-12-1-111-222-333-444', userName: 'AzureAD\\teacher' });
});

test('status rejects an unrelated process token', async () => {
  const service = createPrivilegeService({ ...trustedLaunch, runFile: async () => ({ processId: 1235, elevated: true, uiAccess: true }) });
  const result = await service.getStatus(1234);
  assert.equal(result.elevated, false);
  assert.equal(result.uiAccess, false);
  assert.match(result.error, /requested process/);
});

test('invalid PID is rejected before helper execution', async () => {
  let calls = 0;
  const service = createPrivilegeService({ ...trustedLaunch, runFile: () => { calls++; } });
  for (const pid of [-1, 0, 1.5, NaN, '42']) assert.equal((await service.getStatus(pid)).available, false);
  assert.equal(calls, 0);
});

test('permission failure is reported rather than displayed as enabled', async () => {
  const service = createPrivilegeService({ ...trustedLaunch, runFile: async () => ({ error: 'Access denied', errorCode: 5, elevated: true, uiAccess: true }) });
  const result = await service.getStatus(1234);
  assert.equal(result.elevated, false);
  assert.equal(result.uiAccess, false);
  assert.equal(result.errorCode, 5);
});

test('launch keeps main-process argv intact and cleans only its own temporary directory', async () => {
  const originalArgs = ['C:\\教室\\Slate Random', 'a "quote"', '', 'C:\\path\\tail\\', '--slate-relaunched'];
  let resultDirectory;
  const service = createPrivilegeService({ ...trustedLaunch, baseArgs: originalArgs, runFile: async (file, args, timeout) => {
    assert.equal(file, helperPath);
    assert.equal(args[0], 'elevate-launch');
    assert.equal(timeout, 135000);
    const payload = JSON.parse(Buffer.from(args[1], 'base64').toString('utf8'));
    assert.deepEqual(payload.arguments, originalArgs);
    assert.equal(payload.uiAccess, true);
    assert.equal(payload.executable, helperPath);
    assert.equal(payload.workingDirectory, __dirname);
    resultDirectory = path.dirname(args[2]);
    assert.equal(path.basename(args[2]), 'result.json');
    await fs.writeFile(args[2], '{}');
    return { started: true, cancelled: false, elevated: true, uiAccess: true, processId: 3456 };
  } });
  assert.deepEqual(await service.requestRelaunch({ uiAccess: true }), { started: true, cancelled: false, processId: 3456, elevated: true, uiAccess: true });
  await assert.rejects(fs.access(resultDirectory), { code: 'ENOENT' });
});

test('UAC cancellation leaves the existing instance running', async () => {
  const service = createPrivilegeService({ ...trustedLaunch, runFile: async () => ({ started: false, cancelled: true, errorCode: 1223 }) });
  assert.deepEqual(await service.requestRelaunch({ uiAccess: false }), { started: false, cancelled: true });
});

test('UIAccess requires a verified administrator UIAccess token on the new PID', async () => {
  const cases = [
    { started: true, processId: 3456, elevated: true, uiAccess: false },
    { started: true, processId: 3456, elevated: false, uiAccess: true },
    { started: true, elevated: true, uiAccess: true }
  ];
  for (const reply of cases) {
    const service = createPrivilegeService({ ...trustedLaunch, runFile: async () => reply });
    assert.equal((await service.requestRelaunch({ uiAccess: true })).started, false);
  }
});

test('concurrent requests do not open duplicate consent dialogs', async () => {
  let release;
  let calls = 0;
  let entered;
  const helperEntered = new Promise(resolve => { entered = resolve; });
  const service = createPrivilegeService({ ...trustedLaunch, runFile: async () => {
    calls++;
    entered(true);
    return new Promise(resolve => { release = resolve; });
  } });
  const first = service.requestRelaunch({ uiAccess: true });
  assert.match((await service.requestRelaunch({ uiAccess: true })).error, /already pending/);
  assert.equal(await Promise.race([helperEntered, first.then(() => false)]), true, 'the first request must reach the helper');
  release({ cancelled: true });
  await first;
  assert.equal(calls, 1);
});

test('renderer request cannot replace the trusted executable or arguments', async () => {
  const service = createPrivilegeService({ ...trustedLaunch, baseArgs: ['trusted'], runFile: async (file, args) => {
    const payload = JSON.parse(Buffer.from(args[1], 'base64').toString('utf8'));
    assert.equal(payload.executable, helperPath);
    assert.deepEqual(payload.arguments, ['trusted']);
    return { cancelled: true };
  } });
  await service.requestRelaunch({ uiAccess: false, executable: 'C:\\malicious.exe', arguments: ['untrusted'] });
});

test('nonboolean and malformed argv requests never run the helper', async () => {
  let calls = 0;
  const runFile = async () => { calls++; };
  assert.equal((await createPrivilegeService({ ...trustedLaunch, runFile }).requestRelaunch({ uiAccess: 'yes' })).started, false);
  assert.equal((await createPrivilegeService({ ...trustedLaunch, runFile, baseArgs: ['a\0b'] }).requestRelaunch({ uiAccess: true })).started, false);
  assert.equal(calls, 0);
});

test('Windows argv quoting escapes embedded quotes and terminal backslashes', () => {
  assert.equal(quoteWindowsArgument(''), '""');
  assert.equal(quoteWindowsArgument('a b'), '"a b"');
  assert.equal(quoteWindowsArgument('中文'), '"中文"');
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"');
  assert.equal(quoteWindowsArgument('C:\\last\\'), '"C:\\last\\\\"');
  assert.equal(quoteWindowsArgument('a\\"b'), '"a\\\\\\"b"');
  assert.throws(() => quoteWindowsArgument('a\0b'));
});

test('compiled helper reads this process token without requesting UAC', { skip: process.platform !== 'win32' }, async () => {
  const status = await createPrivilegeService({ helperPath: compiledHelperPath }).getStatus();
  assert.equal(status.available, true, status.error);
  assert.equal(status.processId, process.pid);
  assert.equal(typeof status.elevated, 'boolean');
  assert.equal(typeof status.uiAccess, 'boolean');
  assert.ok(Number.isInteger(status.sessionId));
});

test('compiled C# quoting round trips through the actual Windows argument parser', { skip: process.platform !== 'win32' }, async () => {
  const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '../../../native/windows/verify-argv.ps1'), '-HelperPath', compiledHelperPath], { windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024, encoding: 'utf8' });
  const fixtures = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  assert.equal(fixtures.length, 15);
  for (const fixture of fixtures) {
    assert.equal(fixture.parsed, fixture.value);
    assert.equal(fixture.quoted, quoteWindowsArgument(fixture.value));
  }
});
