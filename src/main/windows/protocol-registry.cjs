'use strict';
// Windows per-user protocol association adapter. Everything here goes through
// reg.exe so that a snapshot (reg export) is byte-identical to what reg import
// can restore later. Nothing in this file executes any other program.
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { execFile } = require('node:child_process');
const { PROTOCOL_SCHEMES } = require('../protocol-schemes.cjs');

const CLASSES_ROOT = 'HKCU\\Software\\Classes';
const OWNED_VALUE = 'SlateRandomProtocol';
const OWNED_EXPORT = new RegExp(`"${OWNED_VALUE}"="1"`);
const DISPLAY_NAME = 'URL:SlateRandom Protocol';
const TEMPORARY_PREFIX = 'slate-protocol-';

/** Quotes one argument with the CommandLineToArgvW rules the shell applies. */
function quoteArgument(value) {
  const text = String(value);
  if (text === '') return '""';
  if (!/[\s"]/.test(text)) return text;
  let quoted = '', backslashes = 0;
  for (const character of text) {
    if (character === '\\') { backslashes++; continue; }
    if (character === '"') { quoted += '\\'.repeat(backslashes * 2 + 1) + '"'; backslashes = 0; continue; }
    quoted += '\\'.repeat(backslashes) + character; backslashes = 0;
  }
  return '"' + quoted + '\\'.repeat(backslashes * 2) + '"';
}
/** The protocol handler command line; the shell substitutes the quoted %1. */
function buildProtocolCommand(executable, args = []) {
  const parts = [executable, ...args].map(quoteArgument);
  return parts.join(' ') + ' "%1"';
}
/** A snapshot written by this app carries the ownership marker value. */
function isOwnedExport(buffer) {
  try { return OWNED_EXPORT.test(Buffer.from(buffer).toString('utf16le')); }
  catch { return false; }
}
function regExecutable() {
  const root = process.env.SystemRoot || process.env.SYSTEMROOT;
  return root ? nodePath.join(root, 'System32', 'reg.exe') : 'reg.exe';
}
function defaultRun(args) {
  return new Promise(resolve => {
    execFile(regExecutable(), args, { windowsHide: true, timeout: 5000, encoding: 'buffer' }, (error, stdout, stderr) => {
      if (error) return resolve({ code: typeof error.code === 'number' ? error.code : -1, stdout, stderr: error.message });
      resolve({ code: 0, stdout, stderr });
    });
  });
}
function schemeKey(scheme) { return `${CLASSES_ROOT}\\${scheme}`; }
function assertScheme(scheme) {
  if (!PROTOCOL_SCHEMES.includes(scheme)) throw Error('不支持的协议标识。');
}
function temporaryDirectory(fs, os, path) {
  return fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX));
}
function dispose(fs, directory) {
  try { fs.rmSync(directory, { recursive: true, force: true }); }
  catch {}
}

function createWindowsProtocolRegistry(config = {}) {
  const { executable, baseArgs = [], run = defaultRun, fs = nodeFs, os = nodeOs, path = nodePath } = config;
  const command = buildProtocolCommand(executable, baseArgs);

  async function step(scheme, label, args, missingIsSuccess) {
    const outcome = await run(args);
    if (outcome.code === 0 || (missingIsSuccess && outcome.code === 1)) return;
    throw Error(`无法注册 ${scheme}://（${label} 退出码 ${outcome.code}）。`);
  }

  return {
    /** The current per-user association snapshot, or null when HKCU defines none. */
    async exportKey(scheme) {
      assertScheme(scheme);
      const directory = temporaryDirectory(fs, os, path);
      try {
        const file = path.join(directory, scheme + '.reg');
        const outcome = await run(['export', schemeKey(scheme), file, '/y']);
        if (outcome.code === 1) return null;
        if (outcome.code !== 0) throw Error(`无法读取 ${scheme}:// 的现有注册。`);
        return fs.readFileSync(file);
      } finally { dispose(fs, directory); }
    },
    ownsExport: isOwnedExport,
    /** Writes the marker first so a partial write is always recognizable as ours. */
    async writeHandler(scheme) {
      assertScheme(scheme);
      const key = schemeKey(scheme);
      await step(scheme, '标记', ['add', key, '/v', OWNED_VALUE, '/t', 'REG_SZ', '/d', '1', '/f'], false);
      await step(scheme, '说明', ['add', key, '/ve', '/t', 'REG_SZ', '/d', DISPLAY_NAME, '/f'], false);
      await step(scheme, 'URL Protocol', ['add', key, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f'], false);
      await step(scheme, 'DelegateExecute', ['delete', key + '\\shell\\open\\command', '/v', 'DelegateExecute', '/f'], true);
      await step(scheme, 'ddeexec', ['delete', key + '\\shell\\open\\ddeexec', '/f'], true);
      await step(scheme, '命令', ['add', key + '\\shell\\open\\command', '/ve', '/t', 'REG_SZ', '/d', command, '/f'], false);
    },
    async deleteKey(scheme) {
      assertScheme(scheme);
      const outcome = await run(['delete', schemeKey(scheme), '/f']);
      if (outcome.code !== 0 && outcome.code !== 1) throw Error(`无法移除 ${scheme}:// 的现有注册。`);
    },
    async importKey(scheme, buffer) {
      assertScheme(scheme);
      const directory = temporaryDirectory(fs, os, path);
      try {
        const file = path.join(directory, scheme + '.reg');
        fs.writeFileSync(file, buffer);
        const outcome = await run(['import', file]);
        if (outcome.code !== 0) throw Error(`无法恢复 ${scheme}:// 的原有关联。`);
      } finally { dispose(fs, directory); }
    }
  };
}

module.exports = { buildProtocolCommand, isOwnedExport, createWindowsProtocolRegistry };
