'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const v8 = require('node:v8');
const engine = require('../../../src/shared/domain/engine.js');
const { createPortableStore, readBackup, PortableDataError, FILES } = require('../../../src/main/portable-data.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'SlateRandom-store-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory: path.join(root, 'data') };
}
function state() {
  const value = engine.createState([
    { id: '1', name: '林一', row: 1, col: 1, active: true },
    { id: '2', name: '周二', row: 1, col: 2, active: true },
    { id: '3', name: '陈三', row: 2, col: 1, active: true },
  ], 42);
  value.className = '便携测试班'; value.seatRows = 3;
  value.settings.strategy = 'manual'; value.settings.manualMode = 'normal'; value.settings.endJumpChance = 0;
  value.students[0].friendTargets = ['2', '3'];
  engine.draw(value, new Date('2026-10-15T01:02:03Z'));
  return value;
}
function code(expected) { return error => error instanceof PortableDataError && error.code === expected; }

test('first run returns null without fabricating a roster or creating AppData files', t => {
  const { directory } = fixture(t), store = createPortableStore({ directory });
  assert.equal(store.load(), null); assert.equal(store.info().hasState, false); assert.equal(fs.existsSync(directory), false);
});

test('readable UTF-8 roster/settings and binary statistics round-trip the entire engine state', t => {
  const { directory } = fixture(t), store = createPortableStore({ directory }), original = state();
  store.save(original);
  const roster = JSON.parse(fs.readFileSync(path.join(directory, FILES.roster), 'utf8'));
  const settings = JSON.parse(fs.readFileSync(path.join(directory, FILES.settings), 'utf8'));
  assert.equal(roster.roster.className, '便携测试班'); assert.equal(roster.roster.seatRows, 3);
  assert.equal(roster.roster.students[0].name, '林一'); assert.deepEqual(settings.settings, original.settings);
  for (const key of ['rngState', 'counts', 'fairnessStats', 'history', 'cycleSeen']) assert.equal(key in roster.roster, false);
  const binary = fs.readFileSync(path.join(directory, FILES.statistics));
  assert.equal(binary.includes(Buffer.from('positionSum')), false); assert.equal(binary.includes(Buffer.from('rngState')), false);
  assert.deepEqual(store.load(), original); assert.deepEqual(engine.restoreState(store.load()), engine.restoreState(original));
  const copy = store.load(); copy.students[0].name = 'external mutation'; assert.equal(store.load().students[0].name, '林一');
});

test('portable checkpoints retain normalized 10, 11 and 12 digit identities after reopening', t => {
  const { directory } = fixture(t);
  for (const id of ['9999999999', '10000000000', '999999999999']) {
    const original = engine.createState([{ id, name: '合成学生', row: 1, col: 1 }], 7);
    createPortableStore({ directory }).save(original);
    const reopened = createPortableStore({ directory });
    assert.deepEqual(reopened.load(), original);
    assert.deepEqual(readBackup(reopened.exportData('all').data).state, original);
    for (const invalidId of ['1000000000000', '0', '-1', '1.5', '01']) {
      const invalid = structuredClone(original); invalid.students[0].id = invalidId;
      assert.throws(() => reopened.save(invalid), code('DATA_INVALID'), invalidId);
      assert.deepEqual(reopened.load(), original);
    }
  }
});

test('new statistics codec 2 decrypts to ordinary UTF-8 JSON without a V8 deserializer', t => {
  const { directory } = fixture(t), store = createPortableStore({ directory }), original = state();
  store.save(original);
  const binary = fs.readFileSync(path.join(directory, FILES.statistics));
  const key = fs.readFileSync(path.join(directory, FILES.key));
  assert.equal(binary.subarray(0, 8).toString('ascii'), 'SLATEST1');
  assert.equal(binary.readUInt16BE(8), 2);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, binary.subarray(26, 38));
  decipher.setAAD(binary.subarray(0, 26)); decipher.setAuthTag(binary.subarray(-16));
  const compressed = Buffer.concat([decipher.update(binary.subarray(38, -16)), decipher.final()]);
  const payload = JSON.parse(zlib.inflateSync(compressed).toString('utf8'));
  const roster = JSON.parse(fs.readFileSync(path.join(directory, FILES.roster), 'utf8'));
  const settings = JSON.parse(fs.readFileSync(path.join(directory, FILES.settings), 'utf8'));
  assert.equal(payload.format, 'SlateRandom.statistics'); assert.equal(payload.version, 1);
  assert.equal(roster.version, 1); assert.equal(settings.version, 1);
  assert.equal(payload.generation, binary.subarray(10, 26).toString('hex'));
  assert.equal(payload.generation, roster.generation);
  assert.equal(payload.rosterHash, crypto.createHash('sha256').update(JSON.stringify(roster.roster, null, 2) + '\n').digest('hex'));
  assert.deepEqual({ ...payload.statistics, ...roster.roster, settings: settings.settings }, original);
});

test('legacy codec 1 remains byte-for-byte intact on read and upgrades on save without losing state', t => {
  const { directory } = fixture(t), store = createPortableStore({ directory }), original = state();
  store.save(original);
  const roster = JSON.parse(fs.readFileSync(path.join(directory, FILES.roster), 'utf8'));
  const statistics = { ...original }; delete statistics.settings;
  for (const name of Object.keys(roster.roster)) delete statistics[name];
  const payload = v8.serialize({
    format: 'SlateRandom.statistics', version: 1, generation: roster.generation,
    rosterHash: crypto.createHash('sha256').update(JSON.stringify(roster.roster, null, 2) + '\n').digest('hex'), statistics,
  });
  const header = Buffer.concat([Buffer.from('SLATEST1'), Buffer.from([0, 1]), Buffer.from(roster.generation, 'hex')]);
  const nonce = crypto.randomBytes(12), key = fs.readFileSync(path.join(directory, FILES.key));
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(zlib.deflateSync(payload)), cipher.final()]);
  fs.writeFileSync(path.join(directory, FILES.statistics), Buffer.concat([header, nonce, ciphertext, cipher.getAuthTag()]));
  const before = Object.fromEntries(Object.values(FILES).map(name => [name, fs.readFileSync(path.join(directory, name))]));
  assert.deepEqual(store.load(), original); assert.equal(store.info().hasState, true);
  assert.deepEqual(readBackup(store.exportData('all').data).state, original);
  for (const [name, bytes] of Object.entries(before)) assert.deepEqual(fs.readFileSync(path.join(directory, name)), bytes);
  store.save(store.load());
  assert.equal(fs.readFileSync(path.join(directory, FILES.statistics)).readUInt16BE(8), 2);
  const upgraded = store.load(); assert.deepEqual(upgraded, original);
  const expectedNext = structuredClone(original), date = new Date('2026-10-15T01:03:04Z');
  assert.deepEqual(engine.draw(upgraded, date), engine.draw(expectedNext, date));
  assert.deepEqual(upgraded, expectedNext);
});

test('unknown statistics codec reports DATA_VERSION and preserves every existing file', t => {
  const { directory } = fixture(t), store = createPortableStore({ directory }); store.save(state());
  const file = path.join(directory, FILES.statistics), binary = fs.readFileSync(file);
  binary.writeUInt16BE(65535, 8); fs.writeFileSync(file, binary);
  const before = Object.fromEntries(Object.values(FILES).map(name => [name, fs.readFileSync(path.join(directory, name))]));
  assert.throws(() => store.load(), code('DATA_VERSION'));
  assert.throws(() => store.save(engine.createEmptyState()), code('DATA_VERSION'));
  assert.throws(() => store.writeCredentials('vision', { apiKey: 'replacement' }), code('DATA_VERSION'));
  for (const [name, bytes] of Object.entries(before)) assert.deepEqual(fs.readFileSync(path.join(directory, name)), bytes);
});

test('copying the entire data directory to another location retains history, seed, fairness and undo', t => {
  const { root, directory } = fixture(t), original = state(); createPortableStore({ directory }).save(original);
  const moved = path.join(root, 'second-machine', 'data'); fs.cpSync(directory, moved, { recursive: true });
  const restored = createPortableStore({ directory: moved }).load(); assert.deepEqual(restored, original);
  assert.deepEqual(engine.undo(restored), engine.undo(original)); assert.deepEqual(restored, original);
});

test('credentials can be saved before a roster and survive repeated state writes without statistics changes', t => {
  const { directory } = fixture(t), store = createPortableStore({ directory });
  store.writeCredentials('vision', { provider: 'openai', apiKey: 'not-a-real-secret' });
  assert.equal(store.load(), null); store.save(state());
  const statistics = fs.readFileSync(path.join(directory, FILES.statistics));
  store.writeCredentials('speech', { provider: 'mimo', apiKey: 'fake-speech-key' });
  assert.deepEqual(fs.readFileSync(path.join(directory, FILES.statistics)), statistics);
  const credentials = store.readCredentials('vision'); credentials.apiKey = 'changed';
  assert.equal(store.readCredentials('vision').apiKey, 'not-a-real-secret');
  store.save(store.load()); assert.equal(store.readCredentials('speech').provider, 'mimo');
  store.writeCredentials('vision', null); assert.equal(store.readCredentials('vision'), null);
});

test('bit-flipped statistics are reported and never silently reset or overwritten by save', t => {
  const { directory } = fixture(t), store = createPortableStore({ directory }); store.save(state());
  const file = path.join(directory, FILES.statistics), damaged = fs.readFileSync(file); damaged[45] ^= 8; fs.writeFileSync(file, damaged);
  assert.throws(() => store.load(), code('DATA_INTEGRITY')); assert.throws(() => store.save(engine.createEmptyState()), code('DATA_INTEGRITY'));
  assert.deepEqual(fs.readFileSync(file), damaged);
});

test('missing portable key or missing statistics cannot turn an existing roster into a new class', t => {
  const { directory } = fixture(t), store = createPortableStore({ directory }); store.save(state());
  fs.unlinkSync(path.join(directory, FILES.key)); assert.throws(() => store.load(), code('DATA_INTEGRITY'));
  assert.equal(fs.existsSync(path.join(directory, FILES.roster)), true);
});

test('a changed roster and a mixed-generation settings file are rejected before fairness can be misattributed', t => {
  const { directory } = fixture(t), store = createPortableStore({ directory }); store.save(state());
  const rosterPath = path.join(directory, FILES.roster), original = fs.readFileSync(rosterPath);
  const roster = JSON.parse(original); roster.roster.students[0].id = '99'; fs.writeFileSync(rosterPath, JSON.stringify(roster));
  assert.throws(() => store.load(), code('DATA_INTEGRITY')); fs.writeFileSync(rosterPath, original);
  const settingsPath = path.join(directory, FILES.settings), settings = JSON.parse(fs.readFileSync(settingsPath));
  settings.generation = 'a'.repeat(32); fs.writeFileSync(settingsPath, JSON.stringify(settings));
  assert.throws(() => store.load(), code('DATA_INTEGRITY'));
});

test('journal publication failures leave the old generation and every live file unchanged', t => {
  for (const operation of ['save', 'restorePayload']) {
    for (const failure of ['fsync', 'rename']) {
      const { directory } = fixture(t), store = createPortableStore({ directory }), before = state();
      store.save(before); store.writeCredentials('vision', { apiKey: 'old-vision' });
      const previousGeneration = store.info().generation;
      const previousFiles = Object.fromEntries(Object.values(FILES).map(name => [name, fs.readFileSync(path.join(directory, name))]));
      const after = structuredClone(before); engine.draw(after, new Date('2026-10-15T01:03:04Z'));
      const journal = path.join(directory, '.state-transaction.json');
      const handles = new Map();
      const failingFs = {
        ...fs,
        openSync(file, ...args) { const handle = fs.openSync(file, ...args); handles.set(handle, file); return handle; },
        closeSync(handle) { handles.delete(handle); return fs.closeSync(handle); },
        fsyncSync(handle) {
          if (failure === 'fsync' && path.basename(handles.get(handle)).startsWith('.state-transaction.')) throw Object.assign(new Error('journal fsync failed'), { code: 'EIO' });
          return fs.fsyncSync(handle);
        },
        renameSync(source, target) {
          if (failure === 'rename' && target === journal) throw Object.assign(new Error('journal publish failed'), { code: 'EIO' });
          return fs.renameSync(source, target);
        },
      };
      const failingStore = createPortableStore({ directory, fileSystem: failingFs });
      assert.throws(() => operation === 'save' ? failingStore.save(after) : failingStore.restorePayload({ state: after, credentials: {} }), code('DATA_IO'));
      assert.equal(fs.existsSync(journal), false);
      for (const [name, bytes] of Object.entries(previousFiles)) assert.deepEqual(fs.readFileSync(path.join(directory, name)), bytes);
      assert.deepEqual(store.load(), before); assert.equal(store.info().generation, previousGeneration);
      assert.equal(store.readCredentials('vision').apiKey, 'old-vision');
    }
  }
});

test('full restore reports every post-publication fault as pending and readers roll forward that exact generation', t => {
  for (const operation of ['restorePayload', 'restoreAll']) {
    for (const targetName of [...Object.values(FILES), '.state-transaction.json']) {
      const { root, directory } = fixture(t), store = createPortableStore({ directory }), before = state();
      store.save(before); store.writeCredentials('vision', { apiKey: 'old-vision' }); store.writeCredentials('speech', { apiKey: 'old-speech' });
      const previousGeneration = store.info().generation;
      const after = structuredClone(before); after.className = '恢复后的班级'; engine.draw(after, new Date('2026-10-15T01:03:04Z'));
      const credentials = { vision: { apiKey: 'restored-vision' }, speech: { apiKey: 'restored-speech' } };
      const source = createPortableStore({ directory: path.join(root, 'source') });
      source.restorePayload({ state: after, credentials });
      const backup = source.exportData('all').data, journal = path.join(directory, '.state-transaction.json');
      let blocked = true;
      const failingFs = {
        ...fs,
        renameSync(source, target) {
          if (blocked && targetName !== '.state-transaction.json' && target === path.join(directory, targetName)) throw Object.assign(new Error('live replacement failed'), { code: 'EIO' });
          return fs.renameSync(source, target);
        },
        unlinkSync(target) {
          if (blocked && targetName === '.state-transaction.json' && target === journal) throw Object.assign(new Error('journal cleanup failed'), { code: 'EIO' });
          return fs.unlinkSync(target);
        },
      };
      const failingStore = createPortableStore({ directory, fileSystem: failingFs });
      const outcome = operation === 'restoreAll' ? failingStore.restoreAll(backup) : failingStore.restorePayload({ state: after, credentials });
      assert.equal(outcome.status, 'pending-recovery'); assert.match(outcome.message, /无法读写便携数据目录/);
      assert.match(outcome.generation, /^[a-f0-9]{32}$/); assert.notEqual(outcome.generation, previousGeneration);
      const pending = JSON.parse(fs.readFileSync(journal, 'utf8'));
      const roster = JSON.parse(Buffer.from(pending.files[FILES.roster].data, 'base64').toString('utf8'));
      assert.equal(roster.generation, outcome.generation);
      assert.throws(() => failingStore.load(), code('DATA_IO'));
      assert.throws(() => failingStore.info(), code('DATA_IO'));
      assert.throws(() => failingStore.readCredentials('vision'), code('DATA_IO'));
      assert.equal(fs.existsSync(journal), true);
      blocked = false;
      assert.deepEqual(failingStore.load(), after); assert.equal(failingStore.info().generation, outcome.generation);
      assert.deepEqual(failingStore.readCredentials('vision'), credentials.vision); assert.deepEqual(failingStore.readCredentials('speech'), credentials.speech);
      assert.equal(fs.existsSync(journal), false);
    }
  }
});

test('save retries recovery after each transient live replacement or journal cleanup fault before reporting success', t => {
  for (const targetName of [...Object.values(FILES), '.state-transaction.json']) {
    const { directory } = fixture(t), store = createPortableStore({ directory }), before = state();
    store.save(before); store.writeCredentials('vision', { apiKey: 'preserved-vision' });
    const after = structuredClone(before); engine.draw(after, new Date('2026-10-15T01:03:04Z'));
    const journal = path.join(directory, '.state-transaction.json');
    let failures = 0;
    const failingFs = {
      ...fs,
      renameSync(source, target) {
        if (targetName !== '.state-transaction.json' && target === path.join(directory, targetName) && failures++ === 0) throw Object.assign(new Error('transient replacement failure'), { code: 'EIO' });
        return fs.renameSync(source, target);
      },
      unlinkSync(target) {
        if (targetName === '.state-transaction.json' && target === journal && failures++ === 0) throw Object.assign(new Error('transient cleanup failure'), { code: 'EIO' });
        return fs.unlinkSync(target);
      },
    };
    const result = createPortableStore({ directory, fileSystem: failingFs }).save(after);
    assert.ok(failures >= 2); assert.equal(fs.existsSync(journal), false);
    assert.deepEqual(store.load(), after); assert.equal(result.generation, store.info().generation);
    assert.equal(store.readCredentials('vision').apiKey, 'preserved-vision');
  }
});

test('save reports persistent post-publication failures while retaining the generation for later recovery', t => {
  for (const targetName of [...Object.values(FILES), '.state-transaction.json']) {
    const { directory } = fixture(t), store = createPortableStore({ directory }), before = state(); store.save(before);
    const after = structuredClone(before); engine.draw(after, new Date('2026-10-15T01:03:04Z'));
    const journal = path.join(directory, '.state-transaction.json');
    let failures = 0;
    const failingFs = {
      ...fs,
      renameSync(source, target) {
        if (targetName !== '.state-transaction.json' && target === path.join(directory, targetName)) { failures++; throw Object.assign(new Error('persistent replacement failure'), { code: 'EIO' }); }
        return fs.renameSync(source, target);
      },
      unlinkSync(target) {
        if (targetName === '.state-transaction.json' && target === journal) { failures++; throw Object.assign(new Error('persistent cleanup failure'), { code: 'EIO' }); }
        return fs.unlinkSync(target);
      },
    };
    assert.throws(() => createPortableStore({ directory, fileSystem: failingFs }).save(after), code('DATA_IO'));
    assert.equal(failures, 2); assert.equal(fs.existsSync(journal), true);
    const pending = JSON.parse(fs.readFileSync(journal, 'utf8'));
    const generation = JSON.parse(Buffer.from(pending.files[FILES.roster].data, 'base64').toString('utf8')).generation;
    assert.deepEqual(createPortableStore({ directory }).load(), after); assert.equal(store.info().generation, generation);
    assert.equal(fs.existsSync(journal), false);
  }
});

test('a damaged transaction is preserved and not partially replayed', t => {
  const { directory } = fixture(t), store = createPortableStore({ directory }); store.save(state());
  const before = fs.readFileSync(path.join(directory, FILES.roster));
  fs.writeFileSync(path.join(directory, '.state-transaction.json'), JSON.stringify({ format: 'SlateRandom.transaction', version: 1, files: {} }));
  assert.throws(() => store.load(), code('DATA_INTEGRITY'));
  assert.deepEqual(fs.readFileSync(path.join(directory, FILES.roster)), before);
  assert.equal(fs.existsSync(path.join(directory, '.state-transaction.json')), true);
});

test('read-only directory errors name the portable directory and never use an AppData fallback', t => {
  const { directory } = fixture(t);
  const failingFs = { ...fs, mkdirSync() { const error = new Error('access denied'); error.code = 'EACCES'; throw error; } };
  assert.throws(() => createPortableStore({ directory, fileSystem: failingFs }).save(state()), error => code('DATA_IO')(error) && error.message.includes(directory) && error.message.includes('不会改存 AppData'));
  assert.equal(fs.existsSync(directory), false);
});

test('separate JSON exports contain only the requested category and the expected provider settings', t => {
  const { directory } = fixture(t), store = createPortableStore({ directory }), original = state(); store.save(original);
  store.writeCredentials('vision', { apiKey: 'test-key' });
  const roster = readBackup(store.exportData('roster').data, 'roster');
  assert.deepEqual(roster.roster.students, original.students); assert.equal('settings' in roster, false); assert.equal('state' in roster, false); assert.equal('credentials' in roster, false);
  const settings = readBackup(store.exportData('settings', { desktopSettings: { autostart: false, uac: true } }).data, 'settings');
  assert.deepEqual(settings.settings, original.settings); assert.equal(settings.credentials.vision.apiKey, 'test-key'); assert.equal(settings.desktopSettings.uac, true); assert.equal('roster' in settings, false);
  assert.throws(() => readBackup(store.exportData('roster').data, 'settings'), code('DATA_INVALID'));
});

test('complete backup is portable, opaque to text editing, and restores state plus both provider configurations', t => {
  const { root, directory } = fixture(t), store = createPortableStore({ directory }), original = state(); store.save(original);
  store.writeCredentials('vision', { apiKey: 'vision-fake' }); store.writeCredentials('speech', { apiKey: 'speech-fake' });
  const backup = store.exportData('all', { desktopSettings: { uac: true, uiAccess: false } });
  assert.equal(backup.data.subarray(0, 16).toString('ascii'), 'SLATERANDOM-BK1\n'); assert.equal(backup.data.includes(Buffer.from('fairnessStats')), false);
  const parsed = readBackup(backup.data, 'all'); assert.deepEqual(parsed.state, original); assert.equal(parsed.desktopSettings.uac, true);
  const destination = createPortableStore({ directory: path.join(root, 'fresh-computer', 'data') });
  const outcome = destination.restoreAll(backup.data);
  assert.deepEqual(outcome, { status: 'committed', generation: destination.info().generation }); assert.deepEqual(destination.load(), original);
  assert.equal(destination.readCredentials('vision').apiKey, 'vision-fake'); assert.equal(destination.readCredentials('speech').apiKey, 'speech-fake');
});

test('full backup frame interoperates with WebCrypto AES-GCM and browser gzip streams', async t => {
  const { directory } = fixture(t), store = createPortableStore({ directory }); store.save(state());
  const backup = store.exportData('all').data;
  const webKey = await crypto.webcrypto.subtle.importKey('raw', backup.subarray(16, 48), 'AES-GCM', false, ['decrypt']);
  const decrypted = await crypto.webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: backup.subarray(48, 60), additionalData: backup.subarray(0, 16) }, webKey, Buffer.concat([backup.subarray(76), backup.subarray(60, 76)]));
  const browserPayload = JSON.parse(zlib.gunzipSync(Buffer.from(decrypted)).toString('utf8'));
  assert.equal(browserPayload.format, 'SlateRandomBackup'); assert.equal(browserPayload.kind, 'all'); assert.deepEqual(browserPayload.state, store.load());
  const portablePayload = { ...browserPayload, credentials: { vision: { apiKey: 'browser-export' } } };
  const keyBytes = crypto.randomBytes(32), nonce = crypto.randomBytes(12), magic = Buffer.from('SLATERANDOM-BK1\n');
  const encryptionKey = await crypto.webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const encrypted = Buffer.from(await crypto.webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: magic }, encryptionKey, zlib.gzipSync(Buffer.from(JSON.stringify(portablePayload)))));
  const browserFrame = Buffer.concat([magic, keyBytes, nonce, encrypted.subarray(-16), encrypted.subarray(0, -16)]);
  assert.equal(readBackup(browserFrame).credentials.vision.apiKey, 'browser-export');
});

test('truncated, corrupted or unsupported complete backups leave the live class untouched', t => {
  const { directory } = fixture(t), store = createPortableStore({ directory }); store.save(state()); const original = store.load();
  const backup = store.exportData('all').data, damaged = Buffer.from(backup); damaged[damaged.length - 1] ^= 1;
  assert.throws(() => store.restoreAll(damaged), code('DATA_INTEGRITY'));
  assert.throws(() => store.restoreAll(backup.subarray(0, 70)), code('DATA_INTEGRITY'));
  const payload = { format: 'SlateRandomBackup', version: 99, kind: 'all', state: original, credentials: {} };
  const key = crypto.randomBytes(32), nonce = crypto.randomBytes(12), magic = backup.subarray(0, 16), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(magic);
  const ciphertext = Buffer.concat([cipher.update(zlib.gzipSync(Buffer.from(JSON.stringify(payload)))), cipher.final()]);
  assert.throws(() => store.restoreAll(Buffer.concat([magic, key, nonce, cipher.getAuthTag(), ciphertext])), code('DATA_VERSION'));
  assert.deepEqual(store.load(), original);
});

test('explicit validated full restore repairs corrupt statistics while preserving the restored seed and lifetime counts', t => {
  const { directory } = fixture(t), store = createPortableStore({ directory }); store.save(state()); const backup = readBackup(store.exportData('all').data);
  fs.writeFileSync(path.join(directory, FILES.statistics), Buffer.from('damaged statistics'));
  assert.throws(() => store.load(), code('DATA_VERSION'));
  const outcome = store.restorePayload({ state: backup.state, credentials: backup.credentials });
  assert.deepEqual(outcome, { status: 'committed', generation: store.info().generation });
  assert.deepEqual(store.load(), backup.state);
});

test('explicit restore of damaged originals remains committed to roll-forward when live replacement is blocked', t => {
  const { directory } = fixture(t), store = createPortableStore({ directory }); store.save(state());
  store.writeCredentials('vision', { apiKey: 'restored-vision' }); store.writeCredentials('speech', { apiKey: 'restored-speech' });
  const backup = store.exportData('all').data, expected = readBackup(backup);
  const statisticsFile = path.join(directory, FILES.statistics), damaged = Buffer.from('damaged statistics');
  fs.writeFileSync(statisticsFile, damaged);
  const failingFs = { ...fs, renameSync(source, target) {
    if (target === statisticsFile) throw Object.assign(new Error('statistics replacement blocked'), { code: 'EIO' });
    return fs.renameSync(source, target);
  } };
  const failingStore = createPortableStore({ directory, fileSystem: failingFs });
  assert.throws(() => failingStore.save(engine.createEmptyState()), code('DATA_VERSION'));
  const outcome = failingStore.restoreAll(backup);
  assert.equal(outcome.status, 'pending-recovery'); assert.deepEqual(fs.readFileSync(statisticsFile), damaged);
  assert.throws(() => failingStore.load(), code('DATA_IO'));
  assert.deepEqual(store.load(), expected.state); assert.equal(store.info().generation, outcome.generation);
  assert.deepEqual(store.readCredentials('vision'), expected.credentials.vision); assert.deepEqual(store.readCredentials('speech'), expected.credentials.speech);
  assert.equal(fs.existsSync(path.join(directory, '.state-transaction.json')), false);
});

test('invalid roster/state and invalid credential scopes are rejected before any files are written', t => {
  const { directory } = fixture(t), store = createPortableStore({ directory }), invalid = state(); invalid.students[0].col = 0;
  assert.throws(() => store.save(invalid), code('DATA_INVALID'));
  assert.throws(() => store.writeCredentials('../outside', {}), code('DATA_INVALID'));
  assert.equal(fs.existsSync(directory), false);
});
