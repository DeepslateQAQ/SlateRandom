'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { preparePortableLocation, PortableLocationError, MARKER, CORE_FILES } = require('../../../src/main/portable-location.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'SlateRandom-location-test-'));
  t.after(() => {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, directory: path.join(root, 'portable', 'data'), legacyDirectory: path.join(root, 'old-appdata', 'SlateRandom') };
}
function put(root, relative, content) { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; }
function legacy(root) {
  put(root, 'Local Storage/leveldb/000003.log', 'roster-wal-with-real-names');
  put(root, 'Local Storage/leveldb/CURRENT', 'MANIFEST-000001');
  put(root, 'Local Storage/leveldb/LOCK', 'lock-not-portable');
  put(root, 'IndexedDB/file__0.indexeddb.leveldb/000009.ldb', 'provider-credentials');
  put(root, 'IndexedDB/file__0.indexeddb.leveldb/000010.log', 'indexeddb-write-ahead-data');
  put(root, 'IndexedDB/file__0.indexeddb.blob/1/2', 'blob');
  put(root, 'Network/Cookies', 'cookie-db');
  put(root, 'Preferences', '{"theme":"dark"}');
  put(root, 'Local State', '{}');
  put(root, 'desktop-settings.json', '{"settings":{"uac":true}}');
  put(root, 'Cache/Cache_Data/cache', 'cache');
  put(root, 'Code Cache/js/cache', 'code-cache');
  put(root, 'GPUCache/index', 'gpu-cache');
  put(root, 'ShaderCache/index', 'shader-cache');
  put(root, 'DawnGraphiteCache/index', 'dawn-cache');
  put(root, 'logs/process.log', 'log');
  put(root, 'desktop-native.log', 'native-log');
  put(root, 'desktop-native.log.1', 'old-native-log');
  put(root, 'SingletonLock', 'stale-instance');
  put(root, 'DevToolsActivePort', 'debug-port');
}
const code = expected => error => error instanceof PortableLocationError && error.code === expected;

test('fresh install creates a writable portable location without inventing an old profile', t => {
  const options = fixture(t), result = preparePortableLocation(options);
  assert.equal(result.directory, options.directory); assert.equal(result.browserDirectory, path.join(options.directory, 'browser'));
  assert.equal(result.migrated, false);
  assert.equal(fs.existsSync(options.legacyDirectory), false); assert.deepEqual(fs.readdirSync(options.directory), []);
});

test('explicit isolated QA directory never searches or reads any unprovided AppData location', t => {
  const { directory } = fixture(t), inspected = [];
  const tracked = { ...fs, lstatSync(file) { inspected.push(path.resolve(file)); return fs.lstatSync(file); } };
  const result = preparePortableLocation({ directory, fileSystem: tracked });
  assert.equal(result.migrated, false);
  const contains = (parent, candidate) => { const relative = path.relative(parent, candidate); return !relative.startsWith('..') && !path.isAbsolute(relative); };
  assert.equal(inspected.every(file => contains(directory, file) || contains(file, directory)), true);
});

test('migration preserves roster WAL, IndexedDB credentials/blobs, network databases and preferences', t => {
  const options = fixture(t); legacy(options.legacyDirectory);
  const result = preparePortableLocation(options), browser = result.browserDirectory;
  assert.equal(result.migrated, true); assert.equal(result.browserMigrated, true); assert.equal(result.desktopSettingsMigrated, true);
  for (const relative of ['Local Storage/leveldb/000003.log', 'Local Storage/leveldb/CURRENT', 'IndexedDB/file__0.indexeddb.leveldb/000009.ldb', 'IndexedDB/file__0.indexeddb.leveldb/000010.log', 'IndexedDB/file__0.indexeddb.blob/1/2', 'Network/Cookies', 'Preferences', 'Local State']) {
    assert.deepEqual(fs.readFileSync(path.join(browser, relative)), fs.readFileSync(path.join(options.legacyDirectory, relative)), relative);
  }
  assert.deepEqual(fs.readFileSync(path.join(options.directory, 'desktop-settings.json')), fs.readFileSync(path.join(options.legacyDirectory, 'desktop-settings.json')));
  assert.equal(fs.existsSync(path.join(browser, 'desktop-settings.json')), false);
  assert.equal(fs.readFileSync(path.join(options.legacyDirectory, 'Local Storage/leveldb/000003.log'), 'utf8'), 'roster-wal-with-real-names');
});

test('migration removes only disposable caches, locks and application logs from the new copy', t => {
  const options = fixture(t); legacy(options.legacyDirectory); const { browserDirectory } = preparePortableLocation(options);
  for (const relative of ['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'DawnGraphiteCache', 'logs', 'desktop-native.log', 'desktop-native.log.1', 'SingletonLock', 'DevToolsActivePort', 'Local Storage/leveldb/LOCK']) {
    assert.equal(fs.existsSync(path.join(browserDirectory, relative)), false, relative);
    assert.equal(fs.existsSync(path.join(options.legacyDirectory, relative)), true, `original ${relative}`);
  }
  const marker = JSON.parse(fs.readFileSync(path.join(options.directory, MARKER), 'utf8'));
  assert.equal(marker.status, 'complete'); assert.equal(JSON.stringify(marker).includes('roster-wal'), false); assert.equal(JSON.stringify(marker).includes('provider-credentials'), false);
  assert.equal(fs.readdirSync(options.directory).some(name => name.startsWith('.migration-stage-')), false);
});

test('a second launch keeps existing portable profile/preferences even after old files change', t => {
  const options = fixture(t); legacy(options.legacyDirectory); const first = preparePortableLocation(options);
  put(options.legacyDirectory, 'Preferences', 'changed-old-preferences'); put(options.legacyDirectory, 'desktop-settings.json', 'changed-old-settings');
  const second = preparePortableLocation(options);
  assert.equal(second.migrated, false);
  assert.equal(fs.readFileSync(path.join(first.browserDirectory, 'Preferences'), 'utf8'), '{"theme":"dark"}');
  assert.equal(fs.readFileSync(path.join(options.directory, 'desktop-settings.json'), 'utf8'), '{"settings":{"uac":true}}');
});

test('any existing portable core file protects the browser from an older AppData roster', t => {
  const options = fixture(t); legacy(options.legacyDirectory);
  for (const [index, name] of CORE_FILES.entries()) {
    const directory = path.join(options.root, `core-${index}`, 'data'); put(directory, name, 'existing-portable-data');
    const result = preparePortableLocation({ directory, legacyDirectory: options.legacyDirectory });
    assert.equal(result.browserMigrated, false, name); assert.equal(fs.existsSync(result.browserDirectory), false, name);
    assert.equal(fs.readFileSync(path.join(directory, name), 'utf8'), 'existing-portable-data');
    assert.equal(result.desktopSettingsMigrated, true); // separate, absent desktop prefs may be recovered
  }
});

test('existing browser prevents profile replacement but still allows missing separate desktop settings to migrate', t => {
  const options = fixture(t); legacy(options.legacyDirectory); put(options.directory, 'browser/Preferences', 'portable-preferences');
  const result = preparePortableLocation(options);
  assert.equal(result.browserMigrated, false); assert.equal(result.desktopSettingsMigrated, true);
  assert.equal(fs.readFileSync(path.join(result.browserDirectory, 'Preferences'), 'utf8'), 'portable-preferences');
  assert.equal(fs.existsSync(path.join(result.browserDirectory, 'Local Storage')), false);
});

test('an existing migration marker prevents importing an old class after portable browser removal', t => {
  const options = fixture(t); legacy(options.legacyDirectory);
  put(options.directory, MARKER, JSON.stringify({ format: 'SlateRandomPortableMigration', version: 1, status: 'complete' }));
  const result = preparePortableLocation(options);
  assert.equal(result.browserMigrated, false); assert.equal(fs.existsSync(result.browserDirectory), false);
});

test('failed profile copy cleans its private staging child, leaves old data intact and can retry', t => {
  const options = fixture(t); legacy(options.legacyDirectory);
  const failing = { ...fs, copyFileSync(from, to, flags) { if (from.endsWith('000003.log')) { const error = new Error('read denied'); error.code = 'EACCES'; throw error; } return fs.copyFileSync(from, to, flags); } };
  assert.throws(() => preparePortableLocation({ ...options, fileSystem: failing }), code('MIGRATION_IO'));
  assert.equal(fs.existsSync(path.join(options.directory, MARKER)), false); assert.equal(fs.existsSync(path.join(options.directory, 'browser')), false);
  assert.equal(fs.readdirSync(options.directory).some(name => name.startsWith('.migration-stage-')), false);
  assert.equal(fs.readFileSync(path.join(options.legacyDirectory, 'Local Storage/leveldb/000003.log'), 'utf8'), 'roster-wal-with-real-names');
  assert.equal(preparePortableLocation(options).browserMigrated, true);
});

test('failure after atomic browser publication retries desktop configuration and marker without overwriting browser', t => {
  const options = fixture(t); legacy(options.legacyDirectory);
  const failing = { ...fs, renameSync(from, to) { if (to === path.join(options.directory, 'desktop-settings.json')) { const error = new Error('simulated interruption'); error.code = 'EIO'; throw error; } return fs.renameSync(from, to); } };
  assert.throws(() => preparePortableLocation({ ...options, fileSystem: failing }), code('MIGRATION_IO'));
  assert.equal(fs.existsSync(path.join(options.directory, 'browser/Preferences')), true); assert.equal(fs.existsSync(path.join(options.directory, MARKER)), false);
  put(options.legacyDirectory, 'Preferences', 'changed-after-interruption');
  const result = preparePortableLocation(options); assert.equal(result.browserMigrated, false); assert.equal(result.desktopSettingsMigrated, true);
  assert.equal(fs.readFileSync(path.join(result.browserDirectory, 'Preferences'), 'utf8'), '{"theme":"dark"}');
  assert.equal(fs.existsSync(path.join(options.directory, MARKER)), true);
});

test('equal or ancestor/descendant migration locations cannot copy into portable data', t => {
  const { directory } = fixture(t);
  for (const legacyDirectory of [directory, path.dirname(directory), path.join(directory, 'old')]) assert.throws(() => preparePortableLocation({ directory, legacyDirectory }), code('MIGRATION_UNSAFE_PATH'));
  assert.equal(fs.existsSync(path.join(directory, 'browser')), false);
  assert.equal(fs.readdirSync(directory).some(name => name.startsWith('.migration-stage-')), false);
});

test('junction or symlink inside a legacy profile is rejected without reading the outside target', t => {
  const options = fixture(t); legacy(options.legacyDirectory); const outside = path.join(options.root, 'outside'); put(outside, 'secret', 'outside-data');
  const link = path.join(options.legacyDirectory, 'external-profile');
  try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Creating links is unavailable.'); throw error; }
  assert.throws(() => preparePortableLocation(options), code('MIGRATION_UNSAFE_PATH'));
  assert.equal(fs.existsSync(path.join(options.directory, MARKER)), false); assert.equal(fs.existsSync(path.join(options.directory, 'browser')), false);
  assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'outside-data');
});

test('junction or symlink used as the portable directory is rejected', t => {
  const options = fixture(t), outside = path.join(options.root, 'outside'); fs.mkdirSync(outside); fs.mkdirSync(path.dirname(options.directory), { recursive: true });
  try { fs.symlinkSync(outside, options.directory, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Creating links is unavailable.'); throw error; }
  assert.throws(() => preparePortableLocation(options), code('MIGRATION_UNSAFE_PATH')); assert.deepEqual(fs.readdirSync(outside), []);
});

test('write denial is reported with the selected portable path and never falls back to AppData', t => {
  const options = fixture(t), failing = { ...fs, openSync() { const error = new Error('write denied'); error.code = 'EACCES'; throw error; } };
  assert.throws(() => preparePortableLocation({ ...options, fileSystem: failing }), error => code('MIGRATION_IO')(error) && error.message.includes(options.directory) && error.message.includes('不会改存 AppData'));
  assert.equal(fs.existsSync(options.legacyDirectory), false);
});

test('invalid or unsupported migration marker fails visibly without replacing existing files', t => {
  const options = fixture(t); legacy(options.legacyDirectory); put(options.directory, MARKER, '{invalid json');
  assert.throws(() => preparePortableLocation(options), code('MIGRATION_MARKER_INVALID'));
  assert.equal(fs.readFileSync(path.join(options.directory, MARKER), 'utf8'), '{invalid json');
  assert.equal(fs.existsSync(path.join(options.directory, 'browser')), false);
});

test('established browser, core or marker plus desktop settings never access the old profile', t => {
  const options = fixture(t);
  for (const kind of ['browser', 'core', 'marker']) {
    const directory = path.join(options.root, kind, 'data');
    put(directory, 'desktop-settings.json', 'portable-settings');
    if (kind === 'browser') put(directory, 'browser/Preferences', 'portable-browser');
    if (kind === 'core') put(directory, CORE_FILES[0], 'portable-roster');
    if (kind === 'marker') put(directory, MARKER, JSON.stringify({ format: 'SlateRandomPortableMigration', version: 1, status: 'complete' }));
    const fileSystem = { ...fs, lstatSync(file) {
      if (path.resolve(file) === path.join(options.root, 'old-appdata') || path.resolve(file).startsWith(options.legacyDirectory)) throw new Error('Old profile must not be accessed');
      return fs.lstatSync(file);
    } };
    assert.equal(preparePortableLocation({ ...options, directory, fileSystem }).migrated, false);
    assert.equal(fs.readFileSync(path.join(directory, 'desktop-settings.json'), 'utf8'), 'portable-settings');
  }
});

test('needed migration still reports denied old-source access without replacing portable files', t => {
  const options = fixture(t);
  put(options.directory, 'browser/Preferences', 'portable-browser');
  const fileSystem = { ...fs, lstatSync(file) {
    if (path.resolve(file) === options.legacyDirectory) { const error = new Error('Old profile denied'); error.code = 'EACCES'; throw error; }
    return fs.lstatSync(file);
  } };
  assert.throws(() => preparePortableLocation({ ...options, fileSystem }), code('MIGRATION_IO'));
  assert.equal(fs.readFileSync(path.join(options.directory, 'browser/Preferences'), 'utf8'), 'portable-browser');
});
