'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MARKER = '.portable-migration.json';
const CORE_FILES = Object.freeze(['roster.json', 'settings.json', 'statistics.srstat', '.fairness-key', '.state-transaction.json']);
const SKIP_DIRECTORIES = new Set(['cache', 'code cache', 'gpucache', 'shadercache', 'grshadercache', 'dawncache', 'dawngraphitecache', 'dawnwebgpucache', 'logs', 'log', 'crashpad', 'crash reports']);
const SKIP_FILES = new Set(['lock', 'devtoolsactiveport', 'desktop-settings.json', 'desktop-native.log', 'chrome_debug.log', 'debug.log', 'electron_debug.log']);

class PortableLocationError extends Error {
  constructor(code, message, cause) { super(message, cause ? { cause } : undefined); this.name = 'PortableLocationError'; this.code = code; }
}
function key(value) { return process.platform === 'win32' ? value.toLowerCase() : value; }
function contains(parent, candidate) {
  const relative = path.relative(key(parent), key(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function preparePortableLocation(options) {
  if (!options || typeof options.directory !== 'string' || !options.directory.trim()) throw new TypeError('Portable directory is required.');
  const directory = path.resolve(options.directory);
  const legacyDirectory = typeof options.legacyDirectory === 'string' && options.legacyDirectory.trim() ? path.resolve(options.legacyDirectory) : null;
  const browserDirectory = path.join(directory, 'browser');
  const io = options.fileSystem || fs;
  let staging = null;
  const fail = (code, message, cause) => { throw new PortableLocationError(code, message, cause); };
  function stat(value) {
    try { return io.lstatSync(value); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function safeEntry(value, expected) {
    const entry = stat(value);
    if (!entry) return null;
    if (entry.isSymbolicLink()) fail('MIGRATION_UNSAFE_PATH', `迁移遇到符号链接或目录联接，已停止以保护原数据：${value}`);
    if (expected === 'directory' ? !entry.isDirectory() : (!entry.isDirectory() && !entry.isFile())) fail('MIGRATION_UNSAFE_PATH', `迁移路径不是普通${expected === 'directory' ? '目录' : '文件或目录'}：${value}`);
    return entry;
  }
  function safeAncestors(value) {
    const parsed = path.parse(value), parts = value.slice(parsed.root.length).split(path.sep).filter(Boolean);
    let current = parsed.root;
    for (const part of parts) { current = path.join(current, part); safeEntry(current, 'directory'); }
  }
  function skip(name, relative) {
    const lower = name.toLowerCase();
    if (SKIP_DIRECTORIES.has(lower) || lower.startsWith('dawn') || SKIP_FILES.has(lower) || lower.startsWith('singleton')) return true;
    // LevelDB's numbered .log files contain real roster and IndexedDB writes.
    // Only root/native logging is disposable; never filter arbitrary *.log below it.
    if (!relative && (/\.log(?:\.\d+)?$/.test(lower) || CORE_FILES.includes(lower) || lower === MARKER)) return true;
    return false;
  }
  function copyTree(source, target, relative = '') {
    safeEntry(source, 'directory'); io.mkdirSync(target, { recursive: false });
    for (const name of io.readdirSync(source)) {
      if (skip(name, relative)) continue;
      const from = path.join(source, name), to = path.join(target, name), entry = safeEntry(from);
      if (!entry) fail('MIGRATION_SOURCE_CHANGED', '旧数据在迁移期间发生变化；旧目录已保留，请关闭旧版本后重试。');
      if (entry.isDirectory()) copyTree(from, to, path.join(relative, name));
      else io.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    }
  }
  function writeAtomic(file, content) {
    const temp = path.join(directory, `.migration-file-${crypto.randomBytes(12).toString('hex')}.tmp`);
    let descriptor;
    try {
      descriptor = io.openSync(temp, 'wx', 0o600); io.writeFileSync(descriptor, content); io.fsyncSync(descriptor); io.closeSync(descriptor); descriptor = undefined;
      io.renameSync(temp, file);
    } finally {
      if (descriptor !== undefined) try { io.closeSync(descriptor); } catch {}
      try { if (stat(temp)) io.unlinkSync(temp); } catch {}
    }
  }
  function cleanupStaging() {
    // The only recursive removal is an exact, freshly generated child of data.
    if (staging && path.dirname(staging) === directory && path.basename(staging).startsWith('.migration-stage-')) {
      try { io.rmSync(staging, { recursive: true, force: true }); } catch {}
    }
  }
  try {
    safeAncestors(directory);
    io.mkdirSync(directory, { recursive: true });
    safeEntry(directory, 'directory');
    // Test actual write access even for a fresh install; never silently fall back.
    const probe = path.join(directory, `.migration-write-${crypto.randomBytes(12).toString('hex')}.tmp`);
    let descriptor;
    try { descriptor = io.openSync(probe, 'wx', 0o600); io.closeSync(descriptor); descriptor = undefined; io.unlinkSync(probe); }
    finally { if (descriptor !== undefined) try { io.closeSync(descriptor); } catch {} }

    const existingBrowser = safeEntry(browserDirectory, 'directory');
    const markerPath = path.join(directory, MARKER), markerStat = safeEntry(markerPath);
    if (markerStat) {
      let marker;
      try { marker = JSON.parse(io.readFileSync(markerPath, 'utf8')); }
      catch (error) { fail('MIGRATION_MARKER_INVALID', '便携迁移标记无法读取；原数据未被覆盖，请保留 data 目录并检查备份。', error); }
      if (marker.format !== 'SlateRandomPortableMigration' || marker.version !== 1 || marker.status !== 'complete') fail('MIGRATION_MARKER_INVALID', '便携迁移标记版本或状态无效；原数据未被覆盖。');
    }
    let hasCore = false;
    for (const name of CORE_FILES) if (safeEntry(path.join(directory, name))) hasCore = true;
    const destinationDesktop = path.join(directory, 'desktop-settings.json');
    const existingDesktop = safeEntry(destinationDesktop);
    if (existingDesktop && !existingDesktop.isFile()) fail('MIGRATION_UNSAFE_PATH', '便携桌面设置不是普通文件，迁移已停止。');
    const canMigrateBrowser = !existingBrowser && !hasCore && !markerStat;
    const unchanged = { directory, browserDirectory, migrated: false, browserMigrated: false, desktopSettingsMigrated: false };
    if (!legacyDirectory || (!canMigrateBrowser && existingDesktop)) return unchanged;

    if (contains(directory, legacyDirectory) || contains(legacyDirectory, directory)) fail('MIGRATION_UNSAFE_PATH', '便携目录与旧数据目录相同或互相包含，无法安全迁移。请使用独立的程序 data 目录。');
    safeAncestors(legacyDirectory);
    if (!safeEntry(legacyDirectory, 'directory')) return unchanged;
    let browserMigrated = false, desktopSettingsMigrated = false;
    const sourceDesktop = path.join(legacyDirectory, 'desktop-settings.json');
    const legacyDesktop = safeEntry(sourceDesktop);
    if (legacyDesktop && !legacyDesktop.isFile()) fail('MIGRATION_UNSAFE_PATH', '旧桌面设置不是普通文件，迁移已停止。');
    if (canMigrateBrowser) {
      staging = path.join(directory, `.migration-stage-${crypto.randomBytes(12).toString('hex')}`);
      copyTree(legacyDirectory, staging);
      io.renameSync(staging, browserDirectory); staging = null; browserMigrated = true;
    }
    if (!existingDesktop && legacyDesktop) {
      // The desktop configuration is separate from Chromium; existing portable
      // preferences always win, including when a class has already been imported.
      writeAtomic(destinationDesktop, io.readFileSync(sourceDesktop)); desktopSettingsMigrated = true;
    }
    if (!markerStat && (browserMigrated || desktopSettingsMigrated || existingBrowser)) {
      writeAtomic(markerPath, JSON.stringify({ format: 'SlateRandomPortableMigration', version: 1, status: 'complete', createdAt: new Date().toISOString(), browserMigrated, desktopSettingsMigrated }, null, 2) + '\n');
    }
    return { directory, browserDirectory, migrated: browserMigrated || desktopSettingsMigrated, browserMigrated, desktopSettingsMigrated };
  } catch (error) {
    cleanupStaging();
    if (error instanceof PortableLocationError) throw error;
    throw new PortableLocationError('MIGRATION_IO', `无法在便携目录“${directory}”完成数据准备或迁移。旧数据已保留，请关闭旧版本并将程序移到可写目录后重试；不会改存 AppData。${error.code ? ` (${error.code})` : ''}`, error);
  }
}

module.exports = { preparePortableLocation, PortableLocationError, MARKER, CORE_FILES };
