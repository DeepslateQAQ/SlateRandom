'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');

function ownedTaskName(userData) {
  if (typeof userData !== 'string' || !path.win32.isAbsolute(userData)) throw new TypeError('An absolute Windows user-data path is required.');
  const canonical = path.win32.normalize(userData).replace(/\\+$/, '').toLowerCase();
  return `SlateRandom-${createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12)}`;
}

function taskMarker(taskName) {
  if (typeof taskName !== 'string' || !/^SlateRandom-[a-f0-9]{12}$/.test(taskName)) throw new TypeError('Invalid SlateRandom task name.');
  return `urn:slaterandom:autostart:${taskName}`;
}

function quoteWindowsArgument(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new TypeError('Invalid Windows argument.');
  let output = '"';
  let slashes = 0;
  for (const character of value) {
    if (character === '\\') { slashes++; continue; }
    output += '\\'.repeat(character === '"' ? slashes * 2 + 1 : slashes) + character;
    slashes = 0;
  }
  return output + '\\'.repeat(slashes * 2) + '"';
}

function buildTaskXml({ taskName, userSid, executable, arguments: args, workingDirectory }) {
  const marker = taskMarker(taskName);
  const sidParts = typeof userSid === 'string' && /^S-1-(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*)){1,15}(?![\s\S])/.test(userSid) ? userSid.split('-') : null;
  if (!sidParts || Number(sidParts[2]) > 281474976710655 || sidParts.slice(3).some(value => Number(value) > 4294967295) || ['S-1-5-18', 'S-1-5-19', 'S-1-5-20'].includes(userSid)) throw new TypeError('A current Windows user SID is required.');
  if (typeof executable !== 'string' || !path.win32.isAbsolute(executable) || path.win32.extname(executable).toLowerCase() !== '.exe') throw new TypeError('An absolute executable path is required.');
  if (!Array.isArray(args) || args.length > 64 || args.some(value => typeof value !== 'string' || value.includes('\0'))) throw new TypeError('Invalid startup arguments.');
  if (typeof workingDirectory !== 'string' || !path.win32.isAbsolute(workingDirectory)) throw new TypeError('An absolute working directory is required.');
  const escape = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
  const argumentsText = args.map(quoteWindowsArgument).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>DeepslateQAQ</Author><Description>SlateRandom 岩选 current-user startup</Description><URI>${escape(marker)}</URI></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${escape(userSid)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="SlateRandom"><UserId>${escape(userSid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
  <Actions Context="SlateRandom"><Exec><Command>${escape(executable)}</Command><Arguments>${escape(argumentsText)}</Arguments><WorkingDirectory>${escape(workingDirectory)}</WorkingDirectory></Exec></Actions>
</Task>`;
}

module.exports = { ownedTaskName, taskMarker, buildTaskXml, quoteWindowsArgument };
