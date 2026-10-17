'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const DEFAULT_TIMEOUT = 25000;
const MAX_MESSAGE_BYTES = 8192;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

class HandoffError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'HandoffError';
    this.code = code;
  }
}

const problem = (code, message, cause) => new HandoffError(code, message, cause ? { cause } : undefined);
const validPid = pid => Number.isSafeInteger(pid) && pid > 0;
const sameToken = (candidate, expected) => typeof candidate === 'string' && TOKEN_PATTERN.test(candidate)
  && crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(expected, 'hex'));
const errorText = error => (error instanceof Error ? error.message : String(error)).slice(0, 600);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function checkedTimeout(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0 || value > 300000) throw TypeError('A handoff timeout must be between 1 and 300000 milliseconds.');
  return value;
}

function defer() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A child can connect before the elevation helper returns its verified PID.
  // Keep early failures handled until waitForChild() is called by the parent.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function writeMessage(socket, message) {
  return new Promise((resolve, reject) => {
    if (socket.destroyed || !socket.writable) return reject(problem('HANDOFF_DISCONNECTED', 'The replacement instance disconnected.'));
    socket.write(JSON.stringify(message) + '\n', error => error ? reject(error) : resolve());
  });
}

function readMessages(socket, onMessage, onFailure) {
  let buffer = Buffer.alloc(0), failed = false;
  socket.setNoDelay(true);
  socket.on('data', data => {
    if (failed) return;
    buffer = Buffer.concat([buffer, data]);
    if (buffer.length > MAX_MESSAGE_BYTES) {
      failed = true;
      onFailure(problem('HANDOFF_PROTOCOL', 'The replacement instance sent an oversized handoff message.'));
      return;
    }
    let newline;
    while (!failed && (newline = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, newline).toString('utf8');
      buffer = buffer.subarray(newline + 1);
      try {
        const message = JSON.parse(line);
        if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') throw Error('Invalid message.');
        onMessage(message);
      } catch (cause) {
        failed = true;
        onFailure(problem('HANDOFF_PROTOCOL', 'The replacement instance sent an invalid handoff message.', cause));
      }
    }
  });
}

/**
 * Prepare an authenticated, one-use readiness channel before launching a child.
 * The original process retains its singleton lock until waitForChild(pid) has
 * matched the helper's verified PID to an authenticated renderer-ready child.
 */
async function createParentHandoff(options = {}) {
  const timeoutMs = checkedTimeout(options.timeoutMs, DEFAULT_TIMEOUT);
  const recoveryTimeoutMs = checkedTimeout(options.recoveryTimeoutMs, 2500);
  if (typeof options.releaseLock !== 'function' || typeof options.acquireLock !== 'function') throw TypeError('Parent handoff requires releaseLock and acquireLock callbacks.');
  const token = crypto.randomBytes(32).toString('hex');
  const identifier = crypto.randomBytes(16).toString('hex');
  const pipe = process.platform === 'win32' ? '\\\\.\\pipe\\slate-random-' + identifier : path.join(os.tmpdir(), 'slate-random-' + identifier + '.sock');
  const outcome = defer();
  const sockets = new Set();
  let peer = null, readyPid = null, expectedPid = null;
  let phase = 'waiting', stopped = false, succeeded = false, waited = false;
  let deadline = 0, timer = null, lockTouched = false, releasePromise = null;
  let failureTask = null, disposalTask = null, closingTask = null;

  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      if (socket === peer && !stopped) void fail(problem('HANDOFF_DISCONNECTED', 'The replacement instance disconnected before its windows were confirmed.'));
    });
    socket.on('error', cause => {
      if (socket === peer && !stopped) void fail(problem('HANDOFF_DISCONNECTED', 'The replacement instance connection failed: ' + errorText(cause), cause));
      else socket.destroy();
    });
    const rejectPeer = (code, message) => {
      void writeMessage(socket, { type: 'abort', code, message }).catch(() => {}).finally(() => socket.destroySoon());
    };
    readMessages(socket, message => {
      if (stopped) return rejectPeer('HANDOFF_CLOSED', 'This handoff is already closed.');
      if (!sameToken(message.token, token)) {
        if (socket === peer) void fail(problem('HANDOFF_AUTH', 'The replacement instance changed its handoff credentials.'));
        else rejectPeer('HANDOFF_AUTH', 'The replacement instance could not authenticate its handoff.');
        return;
      }
      if (!peer) {
        if (message.type !== 'ready' || !validPid(message.processId)) return rejectPeer('HANDOFF_PROTOCOL', 'The first authenticated handoff message must identify a ready process.');
        peer = socket;
        readyPid = message.processId;
        phase = 'ready';
        void commit();
        return;
      }
      if (socket !== peer) return rejectPeer('HANDOFF_BUSY', 'A replacement instance is already connected.');
      if (message.processId !== readyPid) return void fail(problem('HANDOFF_PID_MISMATCH', 'The replacement instance changed its process ID.'));
      if (message.type === 'failed') {
        const code = typeof message.code === 'string' && /^HANDOFF_[A-Z_]+$/.test(message.code) ? message.code : 'HANDOFF_CHILD_FAILED';
        return void fail(problem(code, 'The replacement instance could not show its windows: ' + errorText(message.message || 'Unknown child failure.')));
      }
      if (message.type !== 'shown' || phase !== 'awaiting-shown') return void fail(problem('HANDOFF_PROTOCOL', 'The replacement instance sent a handoff message out of order.'));
      if (Date.now() >= deadline) return void fail(problem('HANDOFF_TIMEOUT', 'Timed out waiting for the replacement instance to show its windows.'));
      phase = 'accepting';
      clearTimeout(timer);
      // The final acknowledgement prevents a child from treating a late shown
      // message as success after the parent has already rolled back.
      void writeMessage(socket, { type: 'accepted', token, processId: readyPid }).then(() => {
        if (stopped) return;
        succeeded = true;
        stopped = true;
        clearTimeout(timer);
        outcome.resolve({ processId: readyPid, shown: true });
        socket.end();
        void closeServer();
      }).catch(cause => fail(problem('HANDOFF_DISCONNECTED', 'The replacement instance disconnected during handoff acknowledgement.', cause)));
    }, error => {
      if (socket === peer) void fail(error);
      else rejectPeer(error.code, error.message);
    });
  });

  async function closeServer() {
    if (closingTask) return closingTask;
    closingTask = new Promise(resolve => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    }).then(async () => {
      if (process.platform !== 'win32') await fs.unlink(pipe).catch(error => { if (error.code !== 'ENOENT') throw error; });
    });
    return closingTask;
  }

  async function restoreLock(original) {
    if (!lockTouched) return original;
    // A cancellation can arrive while the caller's async release is running.
    // Wait for that release before attempting to restore the original lock.
    await releasePromise.catch(() => {});
    const recoveryDeadline = Date.now() + recoveryTimeoutMs;
    let recoveryError;
    do {
      try {
        if (await options.acquireLock() !== false) return original;
        recoveryError = Error('Another process still owns the application lock.');
      } catch (error) { recoveryError = error; }
      if (Date.now() >= recoveryDeadline) break;
      await pause(Math.min(40, Math.max(1, recoveryDeadline - Date.now())));
    } while (true);
    const error = problem('HANDOFF_RECOVERY_FAILED', original.message + ' The original instance could not restore its application lock: ' + errorText(recoveryError), original);
    error.originalCode = original.code;
    return error;
  }

  function fail(error) {
    if (failureTask) return failureTask;
    if (stopped) return Promise.resolve();
    stopped = true;
    clearTimeout(timer);
    failureTask = (async () => {
      if (peer && !peer.destroyed) {
        await writeMessage(peer, { type: 'abort', token, processId: readyPid, code: error.code, message: error.message }).catch(() => {});
      }
      for (const socket of sockets) socket.destroySoon();
      const closing = closeServer();
      const recovered = await restoreLock(error);
      outcome.reject(recovered);
      await closing;
    })();
    return failureTask;
  }

  async function commit() {
    if (stopped || !waited || phase !== 'ready') return;
    if (readyPid !== expectedPid) return fail(problem('HANDOFF_PID_MISMATCH', 'The ready process does not match the replacement process verified by Windows.'));
    if (Date.now() >= deadline) return fail(problem('HANDOFF_TIMEOUT', 'Timed out waiting for the replacement instance to become ready.'));
    phase = 'releasing';
    lockTouched = true;
    releasePromise = Promise.resolve().then(() => options.releaseLock());
    try {
      if (await releasePromise === false) throw problem('HANDOFF_RELEASE_FAILED', 'The original instance could not release its application lock.');
      if (stopped) return;
      phase = 'awaiting-shown';
      await writeMessage(peer, { type: 'commit', token, processId: readyPid });
    } catch (cause) {
      await fail(cause instanceof HandoffError ? cause : problem('HANDOFF_RELEASE_FAILED', 'Unable to commit the replacement instance: ' + errorText(cause), cause));
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, () => { server.removeListener('error', reject); resolve(); });
  });
  server.on('error', cause => { void fail(problem('HANDOFF_CONNECTION_FAILED', 'The replacement instance handoff server failed: ' + errorText(cause), cause)); });

  return Object.freeze({
    pipe, token,
    args: Object.freeze(['--slate-handoff-pipe=' + pipe, '--slate-handoff-token=' + token]),
    waitForChild(processId) {
      if (!validPid(processId)) return Promise.reject(problem('HANDOFF_PID_INVALID', 'A verified replacement process ID is required.'));
      if (waited && expectedPid !== processId) return Promise.reject(problem('HANDOFF_STATE', 'This handoff is already waiting for another process.'));
      if (!waited) {
        waited = true;
        expectedPid = processId;
        deadline = Date.now() + timeoutMs;
        if (!stopped) {
          timer = setTimeout(() => { void fail(problem('HANDOFF_TIMEOUT', 'Timed out waiting for the replacement instance to show its windows.')); }, timeoutMs);
          void commit();
        }
      }
      return outcome.promise;
    },
    dispose() {
      if (disposalTask) return disposalTask;
      disposalTask = (async () => {
        if (!stopped) await fail(problem('HANDOFF_DISPOSED', 'The replacement instance handoff was cancelled.'));
        else if (failureTask) await failureTask;
        clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        await closeServer();
        return { succeeded };
      })();
      return disposalTask;
    }
  });
}

/** Connect only when both renderers have loaded and are ready to be shown. */
function connectChildHandoff(options = {}) {
  const timeoutMs = checkedTimeout(options.timeoutMs, DEFAULT_TIMEOUT);
  const processId = options.processId === undefined ? process.pid : options.processId;
  if (!validPid(processId)) throw TypeError('A valid child process ID is required.');
  if (typeof options.pipe !== 'string' || !options.pipe || options.pipe.length > 240 || options.pipe.includes('\0')) throw TypeError('A handoff pipe is required.');
  if (typeof options.token !== 'string' || !TOKEN_PATTERN.test(options.token)) throw TypeError('A valid handoff token is required.');
  let socket = null, timer = null, stopped = false, started = false, phase = 'idle', deadline = 0, failureTask = null;
  const outcome = defer();
  const envelope = message => ({ ...message, token: options.token, processId });

  function finish(error, result) {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    if (error) outcome.reject(error);
    else outcome.resolve(result);
    if (socket && !socket.destroyed) socket.end();
  }

  function fail(error, notify = false) {
    if (failureTask) return failureTask;
    if (stopped) return Promise.resolve();
    // Stop processing commit/show before the asynchronous error notification.
    phase = 'failed';
    failureTask = (async () => {
      if (notify && socket && !socket.destroyed) await writeMessage(socket, envelope({ type: 'failed', code: error.code, message: error.message })).catch(() => {});
      finish(error);
    })();
    return failureTask;
  }

  return Object.freeze({
    handover(callbacks = {}) {
      if (started) return outcome.promise;
      if (stopped) return outcome.promise;
      if (typeof callbacks.acquireLock !== 'function' || typeof callbacks.show !== 'function') return Promise.reject(TypeError('Child handoff requires acquireLock and show callbacks.'));
      started = true;
      phase = 'connecting';
      deadline = Date.now() + timeoutMs;
      timer = setTimeout(() => { void fail(problem('HANDOFF_TIMEOUT', 'Timed out completing the replacement instance handoff.'), true); }, timeoutMs);
      socket = net.createConnection(options.pipe);
      socket.on('connect', () => {
        if (stopped) return socket.destroy();
        phase = 'awaiting-commit';
        void writeMessage(socket, envelope({ type: 'ready' })).catch(cause => fail(problem('HANDOFF_CONNECTION_FAILED', 'Unable to send replacement instance readiness.', cause)));
      });
      socket.on('error', cause => { void fail(problem('HANDOFF_CONNECTION_FAILED', 'Unable to contact the original instance: ' + errorText(cause), cause)); });
      socket.on('close', () => { if (!stopped) void fail(problem('HANDOFF_DISCONNECTED', 'The original instance disconnected before accepting the replacement windows.')); });
      readMessages(socket, message => {
        if (stopped || phase === 'failed') return;
        if (message.type === 'abort') {
          const code = typeof message.code === 'string' && /^HANDOFF_[A-Z_]+$/.test(message.code) ? message.code : 'HANDOFF_ABORTED';
          return void fail(problem(code, typeof message.message === 'string' ? message.message.slice(0, 600) : 'The original instance cancelled the handoff.'));
        }
        if (!sameToken(message.token, options.token) || message.processId !== processId) return void fail(problem('HANDOFF_AUTH', 'The original instance returned invalid handoff credentials.'), true);
        if (Date.now() >= deadline) return void fail(problem('HANDOFF_TIMEOUT', 'The original instance replied after the handoff deadline.'), true);
        if (message.type === 'accepted' && phase === 'awaiting-acceptance') return finish(null, { processId, shown: true });
        if (message.type !== 'commit' || phase !== 'awaiting-commit') return void fail(problem('HANDOFF_PROTOCOL', 'The original instance sent a handoff message out of order.'), true);
        phase = 'showing';
        void (async () => {
          try {
            if (await callbacks.acquireLock() === false) throw problem('HANDOFF_LOCK_UNAVAILABLE', 'The replacement instance could not acquire its application lock.');
            if (stopped || phase !== 'showing') return;
            try { await callbacks.show(); }
            catch (cause) { throw problem('HANDOFF_SHOW_FAILED', 'Unable to show the replacement windows: ' + errorText(cause), cause); }
            if (stopped || phase !== 'showing') return;
            if (Date.now() >= deadline) throw problem('HANDOFF_TIMEOUT', 'The replacement windows became visible after the handoff deadline.');
            phase = 'awaiting-acceptance';
            await writeMessage(socket, envelope({ type: 'shown' }));
          } catch (cause) {
            await fail(cause instanceof HandoffError ? cause : problem('HANDOFF_CHILD_FAILED', 'The replacement instance failed to complete its handoff: ' + errorText(cause), cause), true);
          }
        })();
      }, error => { void fail(error, true); });
      return outcome.promise;
    },
    dispose() {
      if (!stopped) finish(problem('HANDOFF_DISPOSED', 'The replacement instance handoff was cancelled.'));
      if (socket) socket.destroy();
    }
  });
}

module.exports = { HandoffError, createParentHandoff, connectChildHandoff };
