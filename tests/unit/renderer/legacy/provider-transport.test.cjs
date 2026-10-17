const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { window: {}, Uint8Array, DOMException };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../../../src/renderer/legacy/provider-transport.js'), 'utf8'), context);
const { readBoundedBody } = context.window.ProviderTransport;
const encode = text => new TextEncoder().encode(text);
const oversized = error => error.code === 'BODY_TOO_LARGE' && error.name === 'Error';

function observedResponse(source, headers, { releaseError, cancelError } = {}) {
  const stream = new ReadableStream(source);
  const response = new Response(stream, { headers });
  const state = { reads: 0, cancels: [], releases: 0 };
  const getReader = stream.getReader.bind(stream);
  stream.getReader = (...args) => {
    const reader = getReader(...args);
    const read = reader.read.bind(reader), cancel = reader.cancel.bind(reader), release = reader.releaseLock.bind(reader);
    reader.read = () => { state.reads++; return read(); };
    reader.cancel = reason => {
      state.cancels.push(reason);
      if (cancelError) throw cancelError;
      return cancel(reason);
    };
    reader.releaseLock = () => {
      state.releases++;
      release();
      if (releaseError) throw releaseError;
    };
    return reader;
  };
  return { response, stream, state };
}

function observedSignal() {
  const controller = new AbortController();
  const { signal } = controller;
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  const listeners = new Set();
  signal.addEventListener = (type, listener, options) => {
    if (type === 'abort') listeners.add(listener);
    return add(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    if (type === 'abort') listeners.delete(listener);
    return remove(type, listener, options);
  };
  return { controller, signal, listeners };
}

// A hung stream must fail this deadline instead of hanging the entire test runner.
async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Body reader did not settle promptly')), 500);
    })]);
  } finally { clearTimeout(timer); }
}

test('provider-transport counts UTF-8 bytes across chunks and permits the exact limit', async () => {
  const bytes = encode('名册🙂');
  const { response, stream, state } = observedResponse({ start(controller) {
    controller.enqueue(bytes.slice(0, 2));
    controller.enqueue(bytes.slice(2, 6));
    controller.enqueue(bytes.slice(6));
    controller.close();
  } });
  const { signal, listeners } = observedSignal();
  assert.deepEqual(await readBoundedBody(response, { maxBytes: bytes.length, signal }), bytes);
  assert.equal(state.cancels.length, 0);
  assert.equal(state.releases, 1);
  assert.equal(stream.locked, false);
  assert.equal(listeners.size, 0);
});

test('provider-transport rejects oversized headers before reading and cancels without waiting', async () => {
  const { response, stream, state } = observedResponse({ cancel() { return new Promise(() => {}); } }, { 'content-length': '1025' });
  await assert.rejects(promptly(readBoundedBody(response, { maxBytes: 1024 })), oversized);
  assert.equal(state.reads, 0);
  assert.equal(state.cancels.length, 1);
  assert.equal(state.cancels[0].code, 'BODY_TOO_LARGE');
  assert.equal(state.releases, 1);
  assert.equal(stream.locked, false);
});

for (const length of [undefined, '1', 'invalid']) {
  test(`provider-transport enforces streamed bytes with Content-Length ${length}`, async () => {
    const { response, stream, state } = observedResponse({ start(controller) {
      controller.enqueue(encode('名'));
      controller.enqueue(encode('册'));
    }, cancel() { return Promise.reject(new Error('Cancellation failed')); } }, length === undefined ? {} : { 'content-length': length });
    await assert.rejects(promptly(readBoundedBody(response, { maxBytes: 5 })), oversized);
    assert.equal(state.reads, 2);
    assert.equal(state.cancels.length, 1);
    assert.equal(state.releases, 1);
    assert.equal(stream.locked, false);
  });
}

test('provider-transport treats a short body as complete even when Content-Length overstates it within the cap', async () => {
  assert.deepEqual(await readBoundedBody(new Response('ok', { headers: { 'content-length': '10' } }), { maxBytes: 10 }), encode('ok'));
});

test('provider-transport returns empty bytes for empty body without text/blob fallback', async () => {
  const response = new Response(null);
  response.text = response.blob = () => { throw new Error('Full-buffer fallback must not be called'); };
  assert.deepEqual(await readBoundedBody(response, { maxBytes: 0 }), new Uint8Array());
  await assert.rejects(readBoundedBody(new Response(null, { headers: { 'content-length': '1' } }), { maxBytes: 0 }), oversized);
});

test('provider-transport abort interrupts a hung read and hung cancellation, removing listener and lock', async () => {
  let startRead;
  const reading = new Promise(resolve => { startRead = resolve; });
  const { response, stream, state } = observedResponse({
    pull() { startRead(); return new Promise(() => {}); },
    cancel() { return new Promise(() => {}); }
  });
  const { controller, signal, listeners } = observedSignal();
  const reason = new Error('User cancelled');
  const result = readBoundedBody(response, { maxBytes: 8, signal });
  await reading;
  controller.abort(reason);
  await assert.rejects(promptly(result), error => error === reason);
  assert.equal(state.cancels.length, 1);
  assert.equal(state.cancels[0], reason);
  assert.equal(state.releases, 1);
  assert.equal(stream.locked, false);
  assert.equal(listeners.size, 0);
});

test('provider-transport already-aborted reads cancel without reading or leaking listeners', async () => {
  const { response, stream, state } = observedResponse({ cancel() { throw new Error('Cancel rejected'); } });
  const { controller, signal, listeners } = observedSignal();
  controller.abort();
  await assert.rejects(promptly(readBoundedBody(response, { maxBytes: 8, signal })), error => error.name === 'AbortError');
  assert.equal(state.reads, 0);
  assert.equal(state.cancels.length, 1);
  assert.equal(stream.locked, false);
  assert.equal(listeners.size, 0);
});

test('provider-transport read failure preserves original error through rejected cancel and failed release', async () => {
  const original = new Error('Network stream failed');
  const { response, stream, state } = observedResponse({ start(controller) { controller.error(original); } }, {}, { releaseError: new Error('Release failed') });
  const { signal, listeners } = observedSignal();
  await assert.rejects(promptly(readBoundedBody(response, { maxBytes: 8, signal })), error => error === original);
  assert.deepEqual(state.cancels, [original]);
  assert.equal(state.releases, 1);
  assert.equal(stream.locked, false);
  assert.equal(listeners.size, 0);
});

test('provider-transport synchronous cancel failure cannot replace oversize error', async () => {
  const { response, state, stream } = observedResponse({ start(controller) { controller.enqueue(encode('too big')); } }, {}, { cancelError: new Error('Cancel threw') });
  await assert.rejects(readBoundedBody(response, { maxBytes: 1 }), oversized);
  assert.equal(state.cancels.length, 1);
  assert.equal(state.releases, 1);
  assert.equal(stream.locked, false);
});
