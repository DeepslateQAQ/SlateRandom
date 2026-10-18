'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { parseAppProtocol, normalizeAppCommand, encodeAppCommand, decodeAppCommand, hasAppProtocolScheme } = require('../../../src/main/app-protocol.cjs');

const parse = (...argv) => parseAppProtocol(['node', 'main.cjs', ...argv]);

test('pick is the only draw command and rejects an action path', () => {
  assert.deepEqual(parse('slaterandom://pick'), { command: 'pick' });
  assert.deepEqual(parse('SLATERANDOM://PICK'), { command: 'pick' });
  assert.deepEqual(parse('slaterandom://pick?anything=1'), { command: 'pick' });
  assert.equal(parse('slaterandom://pick/now'), null);
});

test('main, settings and ball accept both path and query actions', () => {
  for (const command of ['main', 'settings']) {
    for (const action of ['show', 'hide', 'toggle']) {
      assert.deepEqual(parse(`slaterandom://${command}/${action}`), { command, action });
      assert.deepEqual(parse(`slaterandom://${command}?action=${action}`), { command, action });
    }
  }
  for (const action of ['show', 'hide', 'toggle', 'click']) {
    assert.deepEqual(parse(`slaterandom://ball/${action}`), { command: 'ball', action });
    assert.deepEqual(parse(`slaterandom://ball?action=${action}`), { command: 'ball', action });
  }
  assert.equal(parse('slaterandom://ball/draw'), null);
  assert.equal(parse('slaterandom://main'), null);
  assert.equal(parse('slaterandom://main?action=open'), null);
  assert.equal(parse('slaterandom://main/show/extra'), null);
});

test('a path segment wins over a conflicting action query', () => {
  assert.deepEqual(parse('slaterandom://main/show?action=hide'), { command: 'main', action: 'show' });
  assert.deepEqual(parse('slaterandom://ball/hide?action=toggle'), { command: 'ball', action: 'hide' });
  // An invalid path segment is not rescued by a valid query value.
  assert.equal(parse('slaterandom://main/boom?action=show'), null);
});

test('import defaults to a full picker import and validates its parameters', () => {
  assert.deepEqual(parse('slaterandom://import'), { command: 'import', kind: 'all', source: 'picker' });
  assert.deepEqual(parse('slaterandom://import?kind=roster'), { command: 'import', kind: 'roster', source: 'picker' });
  assert.deepEqual(parse('slaterandom://import?kind=settings&source=clipboard'), { command: 'import', kind: 'settings', source: 'clipboard' });
  assert.deepEqual(
    parse('slaterandom://import?kind=roster&source=path&path=' + encodeURIComponent('C:\\备份\\名单.json')),
    { command: 'import', kind: 'roster', source: 'path', path: 'C:\\备份\\名单.json' }
  );
  assert.deepEqual(
    parse('slaterandom://import?source=path&path=' + encodeURIComponent('/home/user/x.slate') + '&name=' + encodeURIComponent(' 覆盖.slate ')),
    { command: 'import', kind: 'all', source: 'path', path: '/home/user/x.slate', name: '覆盖.slate' }
  );
  // A path is only meaningful for source=path.
  assert.deepEqual(
    parse('slaterandom://import?source=clipboard&path=' + encodeURIComponent('/ignored')),
    { command: 'import', kind: 'all', source: 'clipboard' }
  );
  assert.equal(parse('slaterandom://import?source=path'), null);
  assert.equal(parse('slaterandom://import?source=path&path='), null);
  assert.equal(parse('slaterandom://import?source=path&path=%20'), null);
  assert.equal(parse('slaterandom://import?kind=bogus'), null);
  assert.equal(parse('slaterandom://import?source=usb'), null);
  assert.equal(parse('slaterandom://import?name=' + 'a'.repeat(256)), null);
});

test('unknown commands and unsafe URLs are rejected', () => {
  const rejected = [
    'slaterandom://',
    'slaterandom://unknown',
    'slaterandom://import/extra',
    'secrandom://roll_call/quick_draw',
    'namepicker://pick',
    'https://example.com/main/show',
    'slaterandom://user@main/show',
    'slaterandom://main:8080/show',
    'slaterandom://main/show#x',
    'slaterandom://main/show\u0001',
    'slaterandom://' + 'a'.repeat(8200),
    'slaterandom:'
  ];
  for (const url of rejected) assert.equal(parse(url), null, JSON.stringify(url.slice(0, 40)));
});

test('the first valid command wins and --url/--uri are honoured', () => {
  assert.deepEqual(parse('--url', 'slaterandom://ball/click'), { command: 'ball', action: 'click' });
  assert.deepEqual(parse('--uri', 'slaterandom://main/hide'), { command: 'main', action: 'hide' });
  assert.deepEqual(parse('slaterandom://nope', 'slaterandom://pick'), { command: 'pick' });
  assert.equal(parseAppProtocol(undefined), null);
});

test('hasAppProtocolScheme distinguishes missing from invalid commands', () => {
  assert.equal(hasAppProtocolScheme([]), false);
  assert.equal(hasAppProtocolScheme(['--slate-show-main']), false);
  assert.equal(hasAppProtocolScheme(['slaterandom://nope']), true);
  assert.equal(hasAppProtocolScheme(['--url', 'slaterandom://pick']), true);
  assert.equal(hasAppProtocolScheme(['secrandom://roll_call/quick_draw']), false);
  assert.equal(parse('slaterandom://nope'), null);
});

test('normalizeAppCommand copies only known fields', () => {
  assert.deepEqual(normalizeAppCommand({ command: 'main', action: 'SHOW', extra: 'ignored' }), { command: 'main', action: 'show' });
  assert.deepEqual(normalizeAppCommand({ command: 'import', kind: 'roster', source: 'path', path: '/x.json', name: 'x.json' }),
    { command: 'import', kind: 'roster', source: 'path', path: '/x.json', name: 'x.json' });
  assert.deepEqual(normalizeAppCommand({ command: 'pick', action: 'now' }), { command: 'pick' }, 'pick has no action; stray fields are dropped');
  for (const value of [null, [], 'pick', {}, { command: 'ball', action: 'draw' },
    { command: 'import', kind: 'nope' }, { command: 'import', source: 'path' }, { command: 'import', name: 7 }]) {
    assert.equal(normalizeAppCommand(value), null, JSON.stringify(value));
  }
});

test('encode and decode round-trip through base64url', () => {
  const commands = [
    { command: 'pick' },
    { command: 'main', action: 'toggle' },
    { command: 'import', kind: 'settings', source: 'clipboard' },
    { command: 'import', kind: 'roster', source: 'path', path: 'C:\\a b\\名单.json', name: '名单.json' }
  ];
  for (const command of commands) {
    const encoded = encodeAppCommand(command);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeAppCommand(encoded), command);
  }
  assert.throws(() => encodeAppCommand({ command: 'nope' }), /协议命令/);
});

test('decode rejects damaged payloads instead of guessing', () => {
  assert.equal(decodeAppCommand(''), null);
  assert.equal(decodeAppCommand('%%%'), null);
  assert.equal(decodeAppCommand('a'.repeat(5000)), null);
  assert.equal(decodeAppCommand(7), null);
  assert.equal(decodeAppCommand(Buffer.from('not json', 'utf8').toString('base64url')), null);
  assert.equal(decodeAppCommand(Buffer.from('{}', 'utf8').toString('base64url')), null);
  assert.equal(decodeAppCommand(Buffer.from(JSON.stringify({ command: 'main', action: 'open' }), 'utf8').toString('base64url')), null);
  assert.equal(decodeAppCommand(Buffer.from(JSON.stringify({ command: 'import', source: 'path' }), 'utf8').toString('base64url')), null);
});
