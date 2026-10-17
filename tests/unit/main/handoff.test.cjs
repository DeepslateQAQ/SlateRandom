'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs/promises');
const { once } = require('node:events');
const { createParentHandoff, connectChildHandoff } = require('../../../src/main/handoff.cjs');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hasCode = code => error => error?.code === code;

async function parentFor(t, callbacks = {}) {
  const events = [];
  const parent = await createParentHandoff({
    timeoutMs: 800,
    recoveryTimeoutMs: 120,
    releaseLock: () => { events.push('release'); },
    acquireLock: () => { events.push('restore'); return true; },
    ...callbacks
  });
  t.after(() => parent.dispose());
  return { parent, events };
}

function childFor(t, parent, options = {}) {
  const child = connectChildHandoff({ pipe: parent.pipe, token: parent.token, processId: 12345, timeoutMs: 800, ...options });
  t.after(() => child.dispose());
  return child;
}

async function rawPeer(t, parent) {
  const socket = net.createConnection(parent.pipe);
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const messages = [], pending = [];
  let buffer = '';
  socket.on('data', data => {
    buffer += data.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      messages.push(message);
      for (const waiter of [...pending]) {
        if (message.type === waiter.type) {
          pending.splice(pending.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
    }
  });
  return {
    socket, messages,
    send(message) { socket.write(JSON.stringify({ token: parent.token, processId: 12345, ...message }) + '\n'); },
    wait(type) {
      const previous = messages.find(message => message.type === type);
      if (previous) return Promise.resolve(previous);
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve, timer: setTimeout(() => reject(Error('No ' + type + ' message.')), 1000) };
        pending.push(waiter);
      });
    }
  };
}

test('real authenticated handoff retains the original lock until renderer readiness and verified PID, then shows before accepting', async t => {
  const { parent, events } = await parentFor(t);
  const child = childFor(t, parent);
  assert.match(parent.args[0], /^--slate-handoff-pipe=/);
  assert.match(parent.args[1], /^--slate-handoff-token=[a-f0-9]{64}$/);
  if (process.platform === 'win32') assert.match(parent.pipe, /^\\\\\.\\pipe\\slate-random-[a-f0-9]{32}$/);
  const shown = child.handover({
    acquireLock() { events.push('child-acquire'); return true; },
    async show() { events.push('show-start'); await pause(20); events.push('show-complete'); }
  });
  await pause(30);
  assert.deepEqual(events, [], 'an authenticated early-ready child cannot release the old lock before Windows verifies its PID');
  const result = await parent.waitForChild(12345);
  assert.deepEqual(result, { processId: 12345, shown: true });
  assert.deepEqual(await shown, result);
  assert.deepEqual(events, ['release', 'child-acquire', 'show-start', 'show-complete']);
  assert.deepEqual(await parent.dispose(), { succeeded: true });
  if (process.platform !== 'win32') await assert.rejects(fs.access(parent.pipe), { code: 'ENOENT' });
});

test('an incorrect nonce cannot release the original lock or consume the valid child slot', async t => {
  const { parent, events } = await parentFor(t);
  const wait = parent.waitForChild(12345);
  const impostor = childFor(t, parent, { token: 'f'.repeat(64) });
  await assert.rejects(impostor.handover({ acquireLock() { assert.fail('unauthenticated peer acquired a lock'); }, show() { assert.fail('unauthenticated peer showed a window'); } }), hasCode('HANDOFF_AUTH'));
  assert.deepEqual(events, []);
  const child = childFor(t, parent);
  const shown = child.handover({ acquireLock: () => true, show: () => {} });
  await wait;
  await shown;
  assert.deepEqual(events, ['release']);
});

test('a nonce-authenticated child with the wrong PID is rejected before any lock release', async t => {
  const { parent, events } = await parentFor(t);
  const child = childFor(t, parent, { processId: 67890 });
  const wait = parent.waitForChild(12345);
  const shown = child.handover({ acquireLock() { assert.fail('wrong PID reached commit'); }, show() {} });
  await assert.rejects(wait, hasCode('HANDOFF_PID_MISMATCH'));
  await assert.rejects(shown, hasCode('HANDOFF_PID_MISMATCH'));
  assert.deepEqual(events, []);
});

test('a connected child that never declares renderer readiness times out without releasing the original lock', async t => {
  const { parent, events } = await parentFor(t, { timeoutMs: 50 });
  await rawPeer(t, parent);
  await assert.rejects(parent.waitForChild(12345), hasCode('HANDOFF_TIMEOUT'));
  assert.deepEqual(events, []);
});

test('show failure after commit rejects both sides and restores the original lock after the failed child exits', async t => {
  const events = [];
  let owner = 'parent';
  const { parent } = await parentFor(t, {
    releaseLock() { events.push('release'); owner = null; },
    acquireLock() { events.push('restore-attempt'); if (owner) return false; owner = 'parent'; return true; }
  });
  const child = childFor(t, parent);
  const wait = parent.waitForChild(12345);
  const shown = child.handover({
    acquireLock() { assert.equal(owner, null); owner = 'child'; return true; },
    show() { throw Error('renderer failed to present'); }
  });
  const childRejected = assert.rejects(shown, error => error.code === 'HANDOFF_SHOW_FAILED' && /renderer failed to present/.test(error.message));
  // The production child exits on handover rejection, releasing its singleton.
  void shown.catch(async () => { await pause(30); owner = null; });
  await assert.rejects(wait, error => error.code === 'HANDOFF_SHOW_FAILED' && /renderer failed to present/.test(error.message));
  await childRejected;
  assert.equal(owner, 'parent');
  assert.equal(events[0], 'release');
  assert.ok(events.filter(event => event === 'restore-attempt').length >= 2);
});

test('an unavailable child lock skips show and causes original-lock recovery', async t => {
  const { parent, events } = await parentFor(t);
  const child = childFor(t, parent);
  const wait = parent.waitForChild(12345);
  const shown = child.handover({ acquireLock: () => false, show() { assert.fail('show ran without the lock'); } });
  await assert.rejects(wait, hasCode('HANDOFF_LOCK_UNAVAILABLE'));
  await assert.rejects(shown, hasCode('HANDOFF_LOCK_UNAVAILABLE'));
  assert.deepEqual(events, ['release', 'restore']);
});

test('a child disconnecting after commit restores the original lock and never reports success', async t => {
  const { parent, events } = await parentFor(t);
  const peer = await rawPeer(t, parent);
  const wait = parent.waitForChild(12345);
  peer.send({ type: 'ready' });
  await peer.wait('commit');
  peer.socket.destroy();
  await assert.rejects(wait, hasCode('HANDOFF_DISCONNECTED'));
  assert.deepEqual(events, ['release', 'restore']);
});

test('a child disconnecting before Windows returns its PID cannot trigger lock release', async t => {
  const { parent, events } = await parentFor(t);
  const peer = await rawPeer(t, parent);
  peer.send({ type: 'ready' });
  await pause(20);
  peer.socket.destroy();
  await pause(20);
  await assert.rejects(parent.waitForChild(12345), hasCode('HANDOFF_DISCONNECTED'));
  assert.deepEqual(events, []);
});

test('a late shown message after timeout cannot complete or reverse an aborted handoff', async t => {
  const { parent, events } = await parentFor(t, { timeoutMs: 70 });
  const peer = await rawPeer(t, parent);
  const wait = parent.waitForChild(12345);
  peer.send({ type: 'ready' });
  await peer.wait('commit');
  await assert.rejects(wait, hasCode('HANDOFF_TIMEOUT'));
  await pause(25);
  if (!peer.socket.destroyed && peer.socket.writable) peer.send({ type: 'shown' });
  assert.equal(peer.messages.some(message => message.type === 'accepted'), false);
  assert.deepEqual(events, ['release', 'restore']);
  assert.deepEqual(await parent.dispose(), { succeeded: false });
});

test('an original-lock recovery failure is explicit and retains the original failure code', async t => {
  const { parent } = await parentFor(t, { recoveryTimeoutMs: 40, acquireLock: () => false });
  const child = childFor(t, parent);
  const wait = parent.waitForChild(12345);
  const shown = child.handover({ acquireLock: () => true, show() { throw Error('no desktop'); } });
  await assert.rejects(shown, hasCode('HANDOFF_SHOW_FAILED'));
  await assert.rejects(wait, error => error.code === 'HANDOFF_RECOVERY_FAILED' && error.originalCode === 'HANDOFF_SHOW_FAILED' && /restore its application lock/.test(error.message));
});

test('timeout during an asynchronous old-lock release waits for release before recovering', async t => {
  const events = [];
  const { parent } = await parentFor(t, {
    timeoutMs: 35,
    async releaseLock() { events.push('release-start'); await pause(70); events.push('release-complete'); },
    acquireLock() { events.push('restore'); return true; }
  });
  const child = childFor(t, parent);
  const wait = parent.waitForChild(12345);
  const shown = child.handover({ acquireLock() { assert.fail('a timed-out release sent commit'); }, show() {} });
  await assert.rejects(wait, hasCode('HANDOFF_TIMEOUT'));
  await assert.rejects(shown, hasCode('HANDOFF_TIMEOUT'));
  assert.deepEqual(events, ['release-start', 'release-complete', 'restore']);
});

test('disposal before helper PID verification aborts the child and is idempotent', async t => {
  const { parent, events } = await parentFor(t);
  const child = childFor(t, parent);
  const shown = child.handover({ acquireLock() { assert.fail('disposed handoff committed'); }, show() {} });
  await pause(25);
  await parent.dispose();
  await assert.rejects(shown, hasCode('HANDOFF_DISPOSED'));
  await assert.rejects(parent.waitForChild(12345), hasCode('HANDOFF_DISPOSED'));
  assert.deepEqual(await parent.dispose(), { succeeded: false });
  assert.deepEqual(events, []);
});
