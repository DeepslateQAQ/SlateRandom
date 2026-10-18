'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createProtocolRegistration } = require('../../../src/main/protocol-registration.cjs');

const base64 = text => Buffer.from(text, 'utf8').toString('base64');
const decode = text => Buffer.from(text, 'base64').toString('utf8');

function createStore(initial = null, events = []) {
  let value = initial;
  return {
    get protocols() { return value == null ? null : JSON.parse(JSON.stringify(value)); },
    set protocols(next) {
      value = next == null ? null : JSON.parse(JSON.stringify(next));
      events.push(['store', 'set']);
    },
    get raw() { return value; },
    get entries() { return value?.entries ?? {}; }
  };
}

function createRegistry(initial = {}, options = {}) {
  const keys = new Map(Object.entries(initial));
  const calls = options.events ? options.events : [];
  const fail = options.fail || {};
  const delay = options.delay;
  async function step(entry, scheme) {
    if (delay) await delay();
    calls.push(entry);
    if (fail[entry[0]] === scheme) throw Error(`${entry[0]} ${scheme} denied`);
  }
  return {
    calls, keys,
    async exportKey(scheme) { await step(['export', scheme], scheme); return keys.get(scheme) ?? null; },
    ownsExport: buffer => Buffer.from(buffer).toString('utf8').startsWith('OWNED'),
    async writeHandler(scheme) { await step(['write', scheme], scheme); keys.set(scheme, Buffer.from('OWNED:' + scheme)); },
    async deleteKey(scheme) { await step(['delete', scheme], scheme); keys.delete(scheme); },
    async importKey(scheme, buffer) {
      await step(['import', scheme, Buffer.from(buffer).toString('utf8')], scheme);
      keys.set(scheme, Buffer.from(buffer));
    }
  };
}

function service({ store = createStore(), registry = createRegistry(), platform = 'win32', log } = {}) {
  return { store, registry, registration: createProtocolRegistration({ store, registry, platform, log: log || (() => {}) }) };
}

test('enabling an untouched group records an empty backup and writes each scheme', async () => {
  const { store, registry, registration } = service();
  assert.deepEqual(await registration.apply('app', true), { ok: true });
  assert.deepEqual(store.protocols, { version: 1, entries: { slaterandom: { existed: false } } });
  assert.deepEqual(registry.calls, [['export', 'slaterandom'], ['write', 'slaterandom']]);
  assert.equal(registry.keys.get('slaterandom').toString('utf8'), 'OWNED:slaterandom');
});

test('an existing association is captured before the handler is overwritten', async () => {
  const events = [];
  const store = createStore(null, events);
  const registry = createRegistry({ secrandom: Buffer.from('FOREIGN-REG') }, { events });
  const registration = createProtocolRegistration({ store, registry, platform: 'win32' });
  // The backup must be durable before the first registry write of that scheme.
  await registration.apply('external', true);
  const persisted = events.findIndex(entry => entry[0] === 'store');
  const firstWrite = events.findIndex(entry => entry[0] === 'write');
  assert.ok(persisted >= 0 && persisted < firstWrite);
  assert.deepEqual(store.entries.secrandom, { existed: true, reg: base64('FOREIGN-REG') });
  assert.equal(decode(store.entries.secrandom.reg), 'FOREIGN-REG');
  assert.deepEqual(store.entries.namepicker, { existed: false });
});

test('a stale association left by this app is never mistaken for a foreign one', async () => {
  const { store, registration } = service({ registry: createRegistry({ slaterandom: Buffer.from('OWNED:old') }) });
  await registration.apply('app', true);
  assert.deepEqual(store.entries.slaterandom, { existed: false });
});

test('re-enabling keeps the first captured snapshot', async () => {
  const { store, registry, registration } = service({ registry: createRegistry({ secrandom: Buffer.from('FOREIGN-REG') }) });
  await registration.apply('external', true);
  await registration.apply('external', true);
  assert.deepEqual(store.entries.secrandom, { existed: true, reg: base64('FOREIGN-REG') });
  assert.equal(registry.calls.filter(entry => entry[0] === 'write').length, 4);
});

test('disabling restores the snapshot it replaced and clears the entry', async () => {
  const { store, registry, registration } = service({ registry: createRegistry({ secrandom: Buffer.from('FOREIGN-REG') }) });
  await registration.apply('external', true);
  registry.calls.length = 0;
  assert.deepEqual(await registration.apply('external', false), { ok: true });
  assert.deepEqual(registry.calls, [['export', 'secrandom'], ['delete', 'secrandom'], ['import', 'secrandom', 'FOREIGN-REG'], ['export', 'namepicker'], ['delete', 'namepicker']]);
  assert.equal(registry.keys.get('secrandom').toString('utf8'), 'FOREIGN-REG');
  assert.deepEqual(store.protocols, { version: 1, entries: {} });
});

test('disabling a group that never had an association only deletes the handler', async () => {
  const { store, registry, registration } = service();
  await registration.apply('app', true);
  registry.calls.length = 0;
  await registration.apply('app', false);
  assert.deepEqual(registry.calls, [['export', 'slaterandom'], ['delete', 'slaterandom']]);
  assert.deepEqual(store.protocols, { version: 1, entries: {} });
});

test('disabling leaves a foreign takeover of the key untouched', async () => {
  const { store, registry, registration } = service({ registry: createRegistry({ slaterandom: Buffer.from('FOREIGN-REG') }) });
  await registration.apply('app', true);
  // Another program took the association over while this app was idle.
  registry.keys.set('slaterandom', Buffer.from('SOMEONE-ELSE'));
  registry.calls.length = 0;
  await registration.apply('app', false);
  assert.deepEqual(registry.calls, [['export', 'slaterandom']]);
  assert.equal(registry.keys.get('slaterandom').toString('utf8'), 'SOMEONE-ELSE');
  assert.deepEqual(store.entries, {});
});

test('disabling an already deleted key still clears the recorded backup', async () => {
  const { store, registry, registration } = service();
  store.protocols = { version: 1, entries: { slaterandom: { existed: false } } };
  await registration.apply('app', false);
  assert.deepEqual(registry.calls, [['export', 'slaterandom']]);
  assert.deepEqual(store.entries, {});
});

test('a partial failure reports the scheme and keeps the backups it already captured', async () => {
  const log = [];
  const { store, registration } = service({
    registry: createRegistry({}, { fail: { write: 'namepicker' } }),
    log: (...entry) => log.push(entry)
  });
  const outcome = await registration.apply('external', true);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /write namepicker denied/);
  assert.deepEqual(store.entries.secrandom, { existed: false });
  // The second backup is persisted before its write is attempted, so a failed
  // write still leaves a restorable (empty) record for the next disable.
  assert.deepEqual(store.entries.namepicker, { existed: false });
  assert.deepEqual(log.at(-1), ['protocol-registration-failed', { group: 'external', enabled: true, scheme: 'namepicker', error: 'write namepicker denied' }]);
});

test('a failed export stops the group before any registry write', async () => {
  const { store, registration } = service({ registry: createRegistry({}, { fail: { export: 'secrandom' } }) });
  const outcome = await registration.apply('external', true);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /export secrandom denied/);
  assert.deepEqual(store.protocols, null);
});

test('non-Windows refuses enabling but accepts disabling; a missing service refuses both', async () => {
  for (const platform of ['linux', 'darwin']) {
    const { registration } = service({ platform });
    const enabled = await registration.apply('app', true);
    assert.equal(enabled.ok, false);
    assert.match(enabled.error, /SlateRandom 协议仅在 Windows 桌面版可用/);
    assert.deepEqual(await registration.apply('app', false), { ok: true });
  }
  const { registration } = service({ registry: null });
  assert.deepEqual(await registration.apply('app', true), { ok: false, error: '协议注册服务不可用。' });
  assert.deepEqual(await registration.apply('app', false), { ok: false, error: '协议注册服务不可用。' });
});

test('concurrent applies are serialized so one group never loses another group backup', async () => {
  let active = 0, peak = 0;
  const { store, registration } = service({
    registry: createRegistry({ secrandom: Buffer.from('FOREIGN-REG') }, {
      delay: async () => { active += 1; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active -= 1; }
    })
  });
  const results = await Promise.all([registration.apply('external', true), registration.apply('app', true), registration.apply('external', false)]);
  assert.deepEqual(results.map(result => result.ok), [true, true, true]);
  assert.equal(peak, 1);
  assert.deepEqual(Object.keys(store.entries).sort(), ['slaterandom']);
  assert.deepEqual(store.entries.slaterandom, { existed: false }, 'the last command re-enabled the app group');
});

test('an unknown group is refused without touching the store', async () => {
  const { store, registry, registration } = service();
  assert.deepEqual(await registration.apply('classisland', true), { ok: false, error: '未知的协议组。' });
  assert.deepEqual(registry.calls, []);
  assert.equal(store.raw, null);
});

test('a throwing store or registry never rejects the queued call', async () => {
  const broken = {
    get protocols() { throw Error('settings unreadable'); },
    set protocols(_) { throw Error('settings unwritable'); }
  };
  const outcome = await createProtocolRegistration({ store: broken, registry: createRegistry(), platform: 'win32' }).apply('app', true);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /settings unreadable/);
});
