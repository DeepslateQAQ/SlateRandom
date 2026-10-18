'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const { buildProtocolCommand, isOwnedExport, createWindowsProtocolRegistry } = require('../../../../src/main/windows/protocol-registry.cjs');

const EXE = 'C:\\Program Files\\SlateRandom\\SlateRandom.exe';
const KEY = 'HKCU\\Software\\Classes\\slaterandom';

test('the handler command quotes the executable and always quotes %1', () => {
  assert.equal(buildProtocolCommand(EXE, []), '"C:\\Program Files\\SlateRandom\\SlateRandom.exe" "%1"');
  assert.equal(buildProtocolCommand(EXE, ['--slate-renderer=software']), '"C:\\Program Files\\SlateRandom\\SlateRandom.exe" --slate-renderer=software "%1"');
  assert.equal(buildProtocolCommand('/usr/bin/slate', []), '/usr/bin/slate "%1"');
  assert.equal(buildProtocolCommand(EXE, ['', 'plain']), '"C:\\Program Files\\SlateRandom\\SlateRandom.exe" "" plain "%1"');
});

test('inner quotes and trailing backslashes follow CommandLineToArgvW escaping', () => {
  assert.equal(buildProtocolCommand('C:\\a b\\x.exe', ['a"b']), '"C:\\a b\\x.exe" "a\\"b" "%1"');
  assert.equal(buildProtocolCommand('C:\\a b\\x.exe', ['C:\\my dir\\']), '"C:\\a b\\x.exe" "C:\\my dir\\\\" "%1"');
  assert.equal(buildProtocolCommand('C:\\a b\\x.exe', ['a\\"b']), '"C:\\a b\\x.exe" "a\\\\\\"b" "%1"');
  assert.equal(buildProtocolCommand('C:\\a b\\x.exe', ['名单 目录']), '"C:\\a b\\x.exe" "名单 目录" "%1"');
});

test('the ownership marker is read from a UTF-16LE export', () => {
  const owned = Buffer.from('[HKEY_CURRENT_USER\\Software\\Classes\\slaterandom]\r\n"SlateRandomProtocol"="1"\r\n', 'utf16le');
  const foreign = Buffer.from('[HKEY_CURRENT_USER\\Software\\Classes\\slaterandom]\r\n@="Other"\r\n', 'utf16le');
  assert.equal(isOwnedExport(owned), true);
  assert.equal(isOwnedExport(foreign), false);
  assert.equal(isOwnedExport(Buffer.alloc(0)), false);
  assert.equal(isOwnedExport(Buffer.from('"SlateRandomProtocol"="1"', 'utf8')), false);
  assert.equal(isOwnedExport(null), false);
});

function fakeFileSystem() {
  const files = new Map(), removed = [];
  return {
    files, removed,
    mkdtempSync: () => '/tmp/slate-protocol-test',
    rmSync(directory) { removed.push(directory); },
    readFileSync(file) {
      if (!files.has(file)) throw Object.assign(Error('ENOENT'), { code: 'ENOENT' });
      return files.get(file);
    },
    writeFileSync(file, buffer) { files.set(file, buffer); }
  };
}

function createRegistry({ codes = {}, onRun, files } = {}) {
  const fs = fakeFileSystem();
  const calls = [];
  const run = async args => {
    calls.push(args);
    const action = args[0];
    if (onRun) onRun(args, fs);
    const code = typeof codes[action] === 'function' ? codes[action](args) : codes[action] ?? 0;
    return { code, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  if (files) for (const [file, buffer] of files) fs.files.set(file, buffer);
  return { registry: createWindowsProtocolRegistry({ executable: EXE, baseArgs: [], run, fs, os: { tmpdir: () => '/tmp' }, path }), calls, fs };
}

test('writeHandler writes the marker first, the command last and ignores absent cleanup keys', async () => {
  const { registry, calls } = createRegistry();
  await registry.writeHandler('slaterandom');
  assert.equal(calls.length, 6);
  assert.deepEqual(calls[0], ['add', KEY, '/v', 'SlateRandomProtocol', '/t', 'REG_SZ', '/d', '1', '/f']);
  assert.deepEqual(calls[1], ['add', KEY, '/ve', '/t', 'REG_SZ', '/d', 'URL:SlateRandom Protocol', '/f']);
  assert.deepEqual(calls[2], ['add', KEY, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f']);
  assert.deepEqual(calls[3], ['delete', KEY + '\\shell\\open\\command', '/v', 'DelegateExecute', '/f']);
  assert.deepEqual(calls[4], ['delete', KEY + '\\shell\\open\\ddeexec', '/f']);
  assert.deepEqual(calls[5], ['add', KEY + '\\shell\\open\\command', '/ve', '/t', 'REG_SZ', '/d', buildProtocolCommand(EXE, []), '/f']);
});

test('writeHandler tolerates exit code 1 only for the removals', async () => {
  const tolerated = createRegistry({ codes: { delete: 1 } });
  await tolerated.registry.writeHandler('slaterandom');
  assert.equal(tolerated.calls.length, 6);

  const markerFailure = createRegistry({ codes: { add: 1 } });
  await assert.rejects(markerFailure.registry.writeHandler('slaterandom'), /无法注册 slaterandom:\/\/（标记 退出码 1）/);
  assert.equal(markerFailure.calls.length, 1, 'the marker is the only write attempted');

  const commandFailure = createRegistry({ codes: { add: args => args[2] === '/ve' && args[1].endsWith('\\command') ? 2 : 0 } });
  await assert.rejects(commandFailure.registry.writeHandler('slaterandom'), /命令 退出码 2/);
  assert.equal(commandFailure.calls.length, 6);
});

test('exportKey returns the snapshot, treats a missing key as null and always cleans up', async () => {
  const present = createRegistry({
    onRun(args, fs) { fs.files.set(args[2], Buffer.from('snapshot', 'utf8')); }
  });
  const buffer = await present.registry.exportKey('slaterandom');
  assert.equal(buffer.toString('utf8'), 'snapshot');
  assert.deepEqual(present.calls[0], ['export', KEY, path.join('/tmp/slate-protocol-test', 'slaterandom.reg'), '/y']);
  assert.deepEqual(present.fs.removed, ['/tmp/slate-protocol-test']);

  const missing = createRegistry({ codes: { export: 1 } });
  assert.equal(await missing.registry.exportKey('slaterandom'), null);
  assert.deepEqual(missing.fs.removed, ['/tmp/slate-protocol-test']);

  for (const code of [2, -1]) {
    const failed = createRegistry({ codes: { export: code } });
    await assert.rejects(failed.registry.exportKey('namepicker'), new RegExp(`无法读取 namepicker:// 的现有注册`));
    assert.deepEqual(failed.fs.removed, ['/tmp/slate-protocol-test']);
  }
});

test('importKey restores the exact bytes and cleans up', async () => {
  const { registry, calls, fs } = createRegistry();
  const payload = Buffer.from('restored-snapshot', 'utf8');
  await registry.importKey('secrandom', payload);
  assert.deepEqual(calls[0], ['import', path.join('/tmp/slate-protocol-test', 'secrandom.reg')]);
  assert.equal(fs.files.get(path.join('/tmp/slate-protocol-test', 'secrandom.reg')).toString('utf8'), 'restored-snapshot');
  assert.deepEqual(fs.removed, ['/tmp/slate-protocol-test']);

  const failed = createRegistry({ codes: { import: 1 } });
  await assert.rejects(failed.registry.importKey('secrandom', payload), /无法恢复 secrandom:\/\/ 的原有关联/);
  assert.deepEqual(failed.fs.removed, ['/tmp/slate-protocol-test']);
});

test('deleteKey accepts 0 and 1 and reports anything else', async () => {
  for (const code of [0, 1]) {
    const { registry, calls } = createRegistry({ codes: { delete: code } });
    await registry.deleteKey('namepicker');
    assert.deepEqual(calls[0], ['delete', 'HKCU\\Software\\Classes\\namepicker', '/f']);
  }
  const failed = createRegistry({ codes: { delete: 5 } });
  await assert.rejects(failed.registry.deleteKey('namepicker'), /无法移除 namepicker:\/\//);
});

test('every method refuses a scheme outside the frozen allowlist', async () => {
  const { registry, calls } = createRegistry();
  for (const scheme of ['classisland', 'http', '', 'SlateRandom']) {
    await assert.rejects(registry.exportKey(scheme), /不支持的协议标识/);
    await assert.rejects(registry.writeHandler(scheme), /不支持的协议标识/);
    await assert.rejects(registry.deleteKey(scheme), /不支持的协议标识/);
    await assert.rejects(registry.importKey(scheme, Buffer.from('x')), /不支持的协议标识/);
  }
  assert.deepEqual(calls, []);
});
