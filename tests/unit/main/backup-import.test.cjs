'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { FORMAT, VERSION, MAX_BACKUP_BYTES, parseClipboardEnvelope, backupNameAllowed } = require('../../../src/main/backup-import.cjs');

function envelope(overrides = {}) {
  return JSON.stringify({ format: FORMAT, version: VERSION, kind: 'all', name: '班级-SlateRandom-all-2026.slate',
    data: Buffer.from('backup-payload', 'utf8').toString('base64'), ...overrides });
}

test('a well formed envelope yields the basename and the decoded bytes', () => {
  const parsed = parseClipboardEnvelope(envelope(), 'all');
  assert.equal(parsed.kind, 'all');
  assert.equal(parsed.name, '班级-SlateRandom-all-2026.slate');
  assert.equal(Buffer.from(parsed.bytes).toString('utf8'), 'backup-payload');
  assert.equal(parseClipboardEnvelope(envelope({ kind: 'roster', name: 'r.json' }), 'roster').name, 'r.json');
});

test('the envelope name is reduced to a basename', () => {
  assert.equal(parseClipboardEnvelope(envelope({ name: '../../etc/passwd.slate' }), 'all').name, 'passwd.slate');
});

test('missing, oversized and malformed input is refused with a useful message', () => {
  const cases = [
    [null, /剪贴板中没有备份数据/],
    [undefined, /剪贴板中没有备份数据/],
    ['   ', /剪贴板中没有备份数据/],
    [42, /剪贴板中没有备份数据/],
    ['x'.repeat(MAX_BACKUP_BYTES * 2 + 1), /64 MB/],
    ['{', /不是有效的 SlateRandom 备份信封/],
    ['[]', /不是有效的 SlateRandom 备份信封/],
    ['null', /不是有效的 SlateRandom 备份信封/],
    [envelope({ format: 'SlateRandom.backup' }), /不是有效的 SlateRandom 备份信封/],
    [envelope({ version: 2 }), /不是有效的 SlateRandom 备份信封/]
  ];
  for (const [text, pattern] of cases) assert.throws(() => parseClipboardEnvelope(text), pattern);
});

test('the declared kind must match the requested import type', () => {
  assert.throws(() => parseClipboardEnvelope(envelope({ kind: 'roster' }), 'all'), /备份类型与导入类型不一致/);
  assert.throws(() => parseClipboardEnvelope(envelope({ kind: 'nope' }), 'all'), /备份类型与导入类型不一致/);
  assert.throws(() => parseClipboardEnvelope(envelope(), 'settings'), /备份类型与导入类型不一致/);
});

test('names must survive trimming and stay within 255 characters', () => {
  assert.throws(() => parseClipboardEnvelope(envelope({ name: '' })), /文件名无效/);
  assert.throws(() => parseClipboardEnvelope(envelope({ name: '   ' })), /文件名无效/);
  assert.throws(() => parseClipboardEnvelope(envelope({ name: 7 })), /文件名无效/);
  assert.throws(() => parseClipboardEnvelope(envelope({ name: 'a'.repeat(256) })), /文件名无效/);
  assert.equal(parseClipboardEnvelope(envelope({ name: '  ok.slate  ' })).name, 'ok.slate');
});

test('data must be standard padded base64 within the size limit', () => {
  for (const data of ['', 'not base64!', 'abc', 'ab=c', 12, null]) {
    assert.throws(() => parseClipboardEnvelope(envelope({ data })), /base64|为空或超过 64 MB/, JSON.stringify(data));
  }
  const empty = Buffer.alloc(0).toString('base64');
  assert.throws(() => parseClipboardEnvelope(envelope({ data: empty })), /为空或超过 64 MB/);
});

test('backup names are limited to the extensions each kind can be read from', () => {
  for (const name of ['a.slate', 'a.SLATEBACKUP', 'a.json', '目录/a.slate']) assert.equal(backupNameAllowed(name, 'all'), true, name);
  for (const name of ['a.txt', 'a', '', 'a.', null, 7]) assert.equal(backupNameAllowed(name, 'all'), false, String(name));
  for (const kind of ['settings', 'roster']) {
    assert.equal(backupNameAllowed('a.json', kind), true, kind);
    assert.equal(backupNameAllowed('a.slate', kind), false, kind);
    assert.equal(backupNameAllowed('a.slatebackup', kind), false, kind);
  }
  assert.equal(backupNameAllowed('a.json', 'nope'), false);
});
