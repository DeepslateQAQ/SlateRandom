'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createAutostartService, ownedTaskName, buildTaskXml } = require('../../../src/main/autostart.cjs');
const { createPrivilegeService } = require('../../../src/main/privileges.cjs');

const userSid = 'S-1-5-21-111-222-333-1001';
const userData = 'C:\\Users\\teacher\\AppData\\Roaming\\SlateRandom';
const executable = path.join(__dirname, '../../../build/windows/SlateRandom.Privileges.exe');
const base = { autostart: true, uac: true, uiAccess: false, autostartElevation: 'uac' };

function fixture({ taskExists = false, owned = true, install, remove, appError = false } = {}) {
  const calls = [];
  const app = { setLoginItemSettings(value) { calls.push(['run', value]); if (appError) throw new Error('Registry unavailable'); } };
  const privilegeService = {
    async getStatus() { calls.push(['status']); return { available: true, userSid, userName: 'CLASS\\teacher', elevated: false, uiAccess: false }; },
    async queryTask(value) { calls.push(['query', value]); return { ok: true, exists: taskExists, owned }; },
    async configureTask(value) { calls.push([value.operation, value]); return await (value.operation === 'install' ? install : remove) || { ok: true, cancelled: false }; }
  };
  const service = createAutostartService({ app, executable, userData, baseArgs: ['C:\\app\\src\\main\\main.cjs', '--slate-relaunched', '--slate-startup'], platform: 'win32', privilegeService });
  return { calls, service, app, privilegeService };
}

test('task name is stable for the same user-data directory and distinct for another installation', () => {
  assert.equal(ownedTaskName(userData), ownedTaskName('c:/USERS/teacher/AppData/Roaming/SlateRandom/'));
  assert.notEqual(ownedTaskName(userData), ownedTaskName(userData + '-test'));
  assert.match(ownedTaskName(userData), /^SlateRandom-[a-f0-9]{12}$/);
  assert.throws(() => ownedTaskName('relative/path'));
});

test('task XML uses only the original user interactive token and highest available permissions', () => {
  const xml = buildTaskXml({ taskName: ownedTaskName(userData), userSid, executable: 'C:\\Class & School\\SlateRandom.exe', arguments: ['a "quote"', 'C:\\tail\\', '--slate-startup'], workingDirectory: 'C:\\Class & School' });
  assert.equal((xml.match(new RegExp(`<UserId>${userSid}</UserId>`, 'g')) || []).length, 2);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>HighestAvailable<\/RunLevel>/);
  assert.match(xml, /<Hidden>false<\/Hidden>/);
  assert.match(xml, /Class &amp; School/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.doesNotMatch(xml, /<Password>|ServiceAccount|S-1-5-18|BootTrigger|powershell|cmd\.exe/);
});

test('task builder rejects SYSTEM principals, foreign names and relative executable paths', () => {
  const valid = { taskName: ownedTaskName(userData), userSid, executable, arguments: [], workingDirectory: __dirname };
  for (const override of [{ userSid: 'S-1-5-18' }, { taskName: '\\OtherVendor\\Task' }, { executable: 'relative.exe' }, { arguments: ['a\0b'] }]) assert.throws(() => buildTaskXml({ ...valid, ...override }));
});

test('task XML accepts canonical local, cloud and bounded SID structures only', () => {
  const valid = { taskName: ownedTaskName(userData), executable: 'C:\\SlateRandom\\SlateRandom.exe', arguments: [], workingDirectory: 'C:\\SlateRandom' };
  for (const sid of [userSid, 'S-1-12-1-111-222-333-444', 'S-1-0-0', 'S-1-281474976710655-4294967295', `S-1-5-${Array(15).fill('4294967295').join('-')}`]) {
    assert.ok(buildTaskXml({ ...valid, userSid: sid }).includes(`<UserId>${sid}</UserId>`), sid);
  }
  for (const sid of ['S-1-5-18', 'S-1-5-19', 'S-1-5-20', 'S-1-5', 'S-2-5-1', 's-1-5-1', 'S-1-05-1', 'S-1-5-01', 'S-1-5--1', 'S-1-5-1\n', ' S-1-5-1', 'S-1-281474976710656-1', 'S-1-5-4294967296', `S-1-5-${Array(16).fill('1').join('-')}`, null]) {
    assert.throws(() => buildTaskXml({ ...valid, userSid: sid }), TypeError, String(sid));
  }
});

test('automatic UAC startup uses Electron Run and removes the one-shot restart marker', async () => {
  const { calls, service } = fixture();
  const result = await service.apply(base);
  assert.equal(result.ok, true);
  assert.equal(result.method, 'uac');
  assert.deepEqual(calls.map(value => value[0]), ['status', 'query', 'run']);
  assert.deepEqual(calls.at(-1)[1], { openAtLogin: true, path: executable, args: ['C:\\app\\src\\main\\main.cjs', '--slate-startup'] });
});

test('task startup is confirmed before the Run entry is disabled', async () => {
  const { calls, service } = fixture();
  assert.equal((await service.apply({ ...base, autostartElevation: 'task' })).method, 'task');
  assert.deepEqual(calls.map(value => value[0]), ['status', 'query', 'install', 'run']);
  assert.equal(calls.at(-1)[1].openAtLogin, false);
  assert.equal(calls[2][1].userSid, userSid);
  assert.equal(calls[2][1].taskName, service.taskName);
});

test('cancelled task UAC preserves the existing Run entry', async () => {
  const { calls, service } = fixture({ install: { ok: false, cancelled: true } });
  assert.deepEqual(await service.apply({ ...base, autostartElevation: 'task' }), { ok: false, cancelled: true });
  assert.deepEqual(calls.map(value => value[0]), ['status', 'query', 'install']);
});

test('switching from a task to automatic UAC removes the owned task before enabling Run', async () => {
  const { calls, service } = fixture({ taskExists: true });
  assert.equal((await service.apply(base)).ok, true);
  assert.deepEqual(calls.map(value => value[0]), ['status', 'query', 'remove', 'run']);
  assert.equal(calls.at(-1)[1].openAtLogin, true);
});

test('cancelling task removal preserves the previous startup configuration', async () => {
  const { calls, service } = fixture({ taskExists: true, remove: { ok: false, cancelled: true } });
  assert.equal((await service.apply({ ...base, autostart: false })).cancelled, true);
  assert.deepEqual(calls.map(value => value[0]), ['status', 'query', 'remove']);
});

test('disabling startup clears an owned task before clearing Run', async () => {
  const { calls, service } = fixture({ taskExists: true });
  assert.equal((await service.apply({ ...base, autostart: false, uac: false })).method, 'disabled');
  assert.deepEqual(calls.map(value => value[0]), ['status', 'query', 'remove', 'run']);
  assert.equal(calls.at(-1)[1].openAtLogin, false);
});

test('non-owned task and denied registration are not changed', async () => {
  const foreign = fixture({ taskExists: true, owned: false });
  assert.equal((await foreign.service.apply(base)).ok, false);
  assert.deepEqual(foreign.calls.map(value => value[0]), ['status', 'query']);
  const denied = fixture({ install: { ok: false, cancelled: false, error: 'Denied' } });
  assert.equal((await denied.service.apply({ ...base, autostartElevation: 'task' })).error, 'Denied');
  assert.deepEqual(denied.calls.map(value => value[0]), ['status', 'query', 'install']);
});

test('task preference with UAC disabled uses ordinary Run startup', async () => {
  const { calls, service } = fixture();
  assert.equal((await service.apply({ ...base, uac: false, autostartElevation: 'task' })).method, 'uac');
  assert.equal(calls.at(-1)[1].openAtLogin, true);
  assert.equal(calls.some(value => value[0] === 'install'), false);
});

test('cloud user SID reaches ordinary Run startup without account substitution', async () => {
  const { calls, service, privilegeService } = fixture();
  const cloudSid = 'S-1-12-1-111-222-333-444';
  privilegeService.getStatus = async () => ({ available: true, userSid: cloudSid, elevated: false, uiAccess: false });
  assert.equal((await service.apply({ ...base, uac: false })).ok, true);
  assert.equal(calls.find(value => value[0] === 'query')[1].userSid, cloudSid);
  assert.equal(calls.at(-1)[0], 'run');
  assert.equal(calls.some(value => value[0] === 'install'), false);
});

test('invalid settings and unmet UIAccess prerequisite perform no native writes', async () => {
  const { calls, service } = fixture();
  for (const settings of [{ ...base, uac: false, uiAccess: true }, { ...base, autostartElevation: 'unknown' }, { ...base, autostart: 'yes' }]) assert.equal((await service.apply(settings)).ok, false);
  assert.equal(calls.length, 0);
});

test('a Run write failure removes a newly created task and reports failure', async () => {
  const { calls, service } = fixture({ appError: true });
  assert.equal((await service.apply({ ...base, autostartElevation: 'task' })).ok, false);
  assert.deepEqual(calls.map(value => value[0]), ['status', 'query', 'install', 'run', 'remove']);
});

test('concurrent startup changes cannot open duplicate elevation requests', async () => {
  const { calls, service, privilegeService } = fixture();
  let release;
  privilegeService.configureTask = async () => new Promise(resolve => { release = resolve; });
  const first = service.apply({ ...base, autostartElevation: 'task' });
  assert.match((await service.apply(base)).error, /already pending/);
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  release({ ok: false, cancelled: true });
  await first;
  assert.equal(calls.some(value => value[0] === 'run'), false);
});

test('native helper validates XML constraints without registering a task', { skip: process.platform !== 'win32' }, async () => {
  const request = { taskName: ownedTaskName(userData), userSid, executable, arguments: ['中文 姓名', 'a "quote"', '--slate-startup'], workingDirectory: __dirname, uiAccess: false };
  request.taskXml = buildTaskXml(request);
  const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '../../native/windows/verify-task.ps1'), '-HelperPath', executable, '-EncodedRequest', encoded], { windowsHide: true, timeout: 20000, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(result.stdout.trim()), { validAccepted: true, unsafeRejected: 4, sidAccepted: 4, sidRejected: 12 });
});

test('native Task Scheduler query is read-only and addresses only the owned task name', { skip: process.platform !== 'win32' }, async () => {
  const service = createPrivilegeService({ helperPath: executable, executable, workingDirectory: __dirname });
  const status = await service.getStatus();
  assert.equal(status.available, true, status.error);
  assert.match(status.userSid, /^S-1-(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*)){1,15}$/);
  const task = await service.queryTask({ taskName: ownedTaskName('C:\\SlateRandom-QA-ReadOnly'), userSid: status.userSid });
  assert.equal(task.ok, true, task.error);
  assert.equal(task.exists, false);
});
