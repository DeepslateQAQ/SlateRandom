'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { parseDrawRequest, hasDrawProtocolScheme } = require('../../../src/main/draw-protocol.cjs');

const parse = (...argv) => parseDrawRequest(['node', 'main.cjs', ...argv]);

test('secrandom accepts only the documented roll call and direct extraction routes', () => {
  assert.deepEqual(parse('secrandom://roll_call/quick_draw'), { protocol: 'secrandom', route: 'roll_call/quick_draw' });
  assert.deepEqual(parse('secrandom://roll_call/direct_extraction'), { protocol: 'secrandom', route: 'roll_call/direct_extraction' });
  assert.deepEqual(parse('secrandom://direct_extraction'), { protocol: 'secrandom', route: 'direct_extraction' });
  assert.deepEqual(parse('secrandom://direct_extraction/'), { protocol: 'secrandom', route: 'direct_extraction' });
  for (const rejected of [
    'secrandom://roll_call',
    'secrandom://roll_call/',
    'secrandom://roll_call/quick',
    'secrandom://roll_call/quick_draw/again',
    'secrandom://direct_extraction/more',
    'secrandom://roll_call/direct_extraction/more',
    'secrandom://elsewhere/quick_draw'
  ]) assert.equal(parse(rejected), null, rejected);
});

test('hosts and paths compare case-insensitively and queries are allowed', () => {
  assert.deepEqual(parse('secrandom://ROLL_CALL/QUICK_DRAW'), { protocol: 'secrandom', route: 'roll_call/quick_draw' });
  assert.deepEqual(parse('secrandom://Roll_Call/Direct_Extraction?class=1&round=2'), { protocol: 'secrandom', route: 'roll_call/direct_extraction' });
  assert.deepEqual(parse('SECRANDOM://direct_extraction/?from=icc'), { protocol: 'secrandom', route: 'direct_extraction' });
  assert.equal(hasDrawProtocolScheme(['SECRANDOM://direct_extraction']), true);
});

test('namepicker accepts any URL because the app defines no route grammar', () => {
  for (const url of ['namepicker://', 'namepicker://pick', 'namepicker://ANY/thing?class=3', 'NamePicker://roll_call/quick_draw']) {
    assert.deepEqual(parse(url), { protocol: 'namepicker', route: 'namepicker' }, url);
  }
});

test('URLs arrive as bare arguments or behind --url and --uri', () => {
  assert.deepEqual(parse('--url', 'namepicker://x'), { protocol: 'namepicker', route: 'namepicker' });
  assert.deepEqual(parse('--uri', 'secrandom://roll_call/quick_draw'), { protocol: 'secrandom', route: 'roll_call/quick_draw' });
  assert.deepEqual(parse('--url=namepicker://x'), null, 'the flag=value form is not a protocol argument');
  assert.deepEqual(parse('--url'), null, 'a flag without a value never matches');
  // A non-string neighbour is ignored instead of throwing.
  assert.deepEqual(parseDrawRequest(['--url', 7, 'namepicker://x']), { protocol: 'namepicker', route: 'namepicker' });
});

test('the first accepted URL wins and later noise is ignored', () => {
  assert.deepEqual(parse('slaterandom://pick', 'namepicker://x', 'secrandom://roll_call/quick_draw'), { protocol: 'namepicker', route: 'namepicker' });
  assert.deepEqual(parse('--slate-relaunched', 'secrandom://roll_call/quick_draw', '--url', 'namepicker://y'), { protocol: 'secrandom', route: 'roll_call/quick_draw' });
  assert.deepEqual(parse('--slate-user-data=/tmp/x', 'namepicker://x'), { protocol: 'namepicker', route: 'namepicker' });
});

test('unsafe or foreign URLs are rejected', () => {
  const rejected = [
    'https://roll_call/quick_draw',
    'slaterandom://pick',
    'classisland://plugin/call',
    'secrandom://user@roll_call/quick_draw',
    'secrandom://:secret@roll_call/quick_draw',
    'secrandom://roll_call:8080/quick_draw',
    'secrandom://roll_call/quick_draw#fragment',
    'namepicker://pick#fragment',
    'namepicker://pick\u0000',
    'namepicker://pi\nck',
    'namepicker://pick\u007f',
    '',
    '   ',
    'not a url',
    'secrandom://' + 'a'.repeat(8200)
  ];
  for (const url of rejected) assert.equal(parse(url), null, JSON.stringify(url.slice(0, 40)));
  assert.equal(parse('https://roll_call/quick_draw'), null);
});

test('hasDrawProtocolScheme separates a missing protocol from an invalid route', () => {
  assert.equal(hasDrawProtocolScheme(['--slate-show-main']), false);
  assert.equal(hasDrawProtocolScheme([]), false);
  assert.equal(hasDrawProtocolScheme(['--url', 'https://example.com']), false);
  assert.equal(hasDrawProtocolScheme(['secrandom://roll_call/unknown']), true);
  assert.equal(hasDrawProtocolScheme(['--uri', 'namepicker://anything']), true);
  assert.equal(hasDrawProtocolScheme(['slaterandom://pick']), false);
  assert.equal(parse('secrandom://roll_call/unknown'), null);
});

test('non-string argv entries and missing argv are harmless', () => {
  assert.equal(parseDrawRequest(undefined), null);
  assert.deepEqual(parseDrawRequest([1, null, {}, 'namepicker://x']), { protocol: 'namepicker', route: 'namepicker' });
  assert.equal(hasDrawProtocolScheme(undefined), false);
});
