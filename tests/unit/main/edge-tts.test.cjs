'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createEdgeTtsService } = require('../../../src/main/edge-tts.cjs');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('TTS operation did not settle')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'slate-tts-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { temporaryDirectory: directory, cacheDirectory: path.join(directory, 'cache') };
}

test('desktop Edge TTS validates input and cleans temporary audio without a cache', async t => {
  const options = await fixture(t);
  let calls = 0;
  const service = createEdgeTtsService({ temporaryDirectory: options.temporaryDirectory, ttsFactory: () => ({
    async ttsPromise(_text, file) { calls++; await fs.writeFile(file, Buffer.alloc(3, calls)); }
  }) });
  assert.equal((await service.synthesize('王同学')).byteLength, 3);
  await service.synthesize('王同学');
  assert.equal(calls, 2);
  assert.deepEqual(await fs.readdir(options.temporaryDirectory), []);
  for (const text of ['', '   ', '甲\u0000乙', '甲'.repeat(201)]) await assert.rejects(service.synthesize(text));
  assert.equal(calls, 2);
});

test('desktop Edge TTS serializes uncached requests and recovers after provider timeout', async t => {
  const { temporaryDirectory } = await fixture(t);
  const entered = deferred(), release = deferred();
  let active = 0, peak = 0, calls = 0;
  const service = createEdgeTtsService({ temporaryDirectory, ttsFactory: () => ({ async ttsPromise(_text, file) {
    const attempt = ++calls;
    active++; peak = Math.max(peak, active);
    try {
      if (attempt === 1) { entered.resolve(); await release.promise; throw 'Timed out'; }
      await fs.writeFile(file, Buffer.alloc(3));
    } finally { active--; }
  } }) });
  const first = service.synthesize('第一');
  const failed = assert.rejects(first, error => error instanceof Error && /超时/.test(error.message));
  let second;
  try {
    await within(entered.promise);
    second = service.synthesize('第二');
    release.resolve();
    await within(failed);
    assert.equal((await within(second)).byteLength, 3);
    assert.equal(calls, 2);
    assert.equal(peak, 1);
  } finally { release.resolve(); await Promise.allSettled([first, second]); }
});

test('cache identity uses trimmed text and resolved voice and survives service recreation', async t => {
  const options = await fixture(t);
  let calls = 0;
  options.ttsFactory = () => ({ async ttsPromise(_text, file) { calls++; await fs.writeFile(file, Buffer.alloc(3, calls)); } });
  const service = createEdgeTtsService(options);
  await service.synthesize(' 王同学 ');
  await service.synthesize('王同学', 'mimo_default');
  await service.synthesize('王同学', 'unknown-voice');
  assert.equal(calls, 1);
  const recreated = createEdgeTtsService(options);
  await recreated.synthesize('王同学');
  assert.equal(calls, 1);
  await recreated.synthesize('王同学', '冰糖');
  await recreated.synthesize('李同学');
  assert.equal(calls, 3);
  await recreated.synthesize('王同学', '冰糖');
  await recreated.synthesize('李同学');
  assert.equal(calls, 3);
  assert.equal((await fs.readdir(options.cacheDirectory)).length, 3);
});

test('same-key cache misses share synthesis while a different key retains its own audio', async t => {
  const options = await fixture(t);
  const entered = deferred(), release = deferred();
  let calls = 0;
  const service = createEdgeTtsService({ ...options, ttsFactory: () => ({ async ttsPromise(text, file) {
    calls++;
    if (text === '王同学') { entered.resolve(); await release.promise; }
    await fs.writeFile(file, Buffer.alloc(text === '王同学' ? 3 : 5));
  } }) });
  const requests = [service.synthesize('王同学'), service.synthesize(' 王同学 ', 'mimo_default'), service.synthesize('李同学')];
  try {
    await within(entered.promise);
    release.resolve();
    const results = await within(Promise.all(requests));
    assert.deepEqual(results.map(audio => audio.byteLength), [3, 3, 5]);
    assert.equal(calls, 2);
  } finally { release.resolve(); await Promise.allSettled(requests); }
});

test('a cache hit completes while unrelated network synthesis is blocked', async t => {
  const options = await fixture(t);
  const entered = deferred(), release = deferred();
  let calls = 0;
  const service = createEdgeTtsService({ ...options, ttsFactory: () => ({ async ttsPromise(text, file) {
    calls++;
    if (text === '等待') { entered.resolve(); await release.promise; }
    await fs.writeFile(file, Buffer.alloc(3));
  } }) });
  await service.synthesize('王同学');
  const pending = service.synthesize('等待');
  try {
    await within(entered.promise);
    assert.equal((await within(service.synthesize('王同学'))).byteLength, 3);
    assert.equal(calls, 2);
  } finally { release.resolve(); await within(pending); }
});

test('corrupted cache entries are synthesized again and repaired for later hits', async t => {
  const options = await fixture(t);
  let calls = 0;
  const service = createEdgeTtsService({ ...options, ttsFactory: () => ({ async ttsPromise(_text, file) {
    calls++; await fs.writeFile(file, Buffer.alloc(3));
  } }) });
  await service.synthesize('王同学');
  const [name] = await fs.readdir(options.cacheDirectory);
  const location = path.join(options.cacheDirectory, name);
  for (const damage of [Buffer.alloc(0), Buffer.alloc(35, 8), Buffer.alloc(16 * 1024 * 1024 + 33)]) {
    await fs.writeFile(location, damage);
    await service.synthesize('王同学');
    const afterRepair = calls;
    await service.synthesize('王同学');
    assert.equal(calls, afterRepair);
  }
  assert.equal(calls, 4);
});

test('an unavailable cache does not prevent synthesis or retain failed writes', async t => {
  const options = await fixture(t);
  await fs.writeFile(options.cacheDirectory, 'occupied');
  let calls = 0;
  const service = createEdgeTtsService({ ...options, ttsFactory: () => ({ async ttsPromise(_text, file) {
    calls++; await fs.writeFile(file, Buffer.alloc(3));
  } }) });
  assert.equal((await service.synthesize('王同学')).byteLength, 3);
  assert.equal((await service.synthesize('王同学')).byteLength, 3);
  assert.equal(calls, 2);
});

test('a read-only cache still serves hits and returns uncached synthesis', async t => {
  const options = await fixture(t);
  let calls = 0;
  const service = createEdgeTtsService({ ...options, ttsFactory: () => ({ async ttsPromise(_text, file) {
    calls++; await fs.writeFile(file, Buffer.alloc(3));
  } }) });
  await service.synthesize('已缓存');
  const writeFile = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (file, ...args) => {
    if (path.dirname(file) === options.cacheDirectory) throw Object.assign(new Error('read-only fixture'), { code: 'EROFS' });
    return writeFile(file, ...args);
  });
  t.mock.method(fs, 'utimes', async () => { throw Object.assign(new Error('read-only fixture'), { code: 'EROFS' }); });
  await service.synthesize('已缓存');
  assert.equal(calls, 1);
  assert.equal((await service.synthesize('新姓名')).byteLength, 3);
  await service.synthesize('新姓名');
  assert.equal(calls, 3);
  assert.equal((await fs.readdir(options.cacheDirectory)).length, 1);
});

test('failed same-key synthesis is shared but not cached and a retry can succeed', async t => {
  const options = await fixture(t);
  const entered = deferred(), release = deferred();
  const failure = new Error('provider unavailable');
  let calls = 0;
  const service = createEdgeTtsService({ ...options, ttsFactory: () => ({ async ttsPromise(_text, file) {
    if (++calls === 1) { entered.resolve(); await release.promise; throw failure; }
    await fs.writeFile(file, Buffer.alloc(3));
  } }) });
  const requests = [service.synthesize('王同学'), service.synthesize('王同学')];
  const results = Promise.allSettled(requests);
  try {
    await within(entered.promise);
    release.resolve();
    for (const result of await within(results)) {
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason, failure);
    }
    assert.equal(calls, 1);
    await service.synthesize('王同学');
    await service.synthesize('王同学');
    assert.equal(calls, 2);
  } finally { release.resolve(); await results; }
});

test('cache eviction stays within its byte budget and preserves the most recently used hit', async t => {
  const options = await fixture(t);
  const calls = [];
  const service = createEdgeTtsService({ ...options, maxCacheBytes: 70, ttsFactory: () => ({ async ttsPromise(text, file) {
    calls.push(text); await fs.writeFile(file, Buffer.alloc(3));
  } }) });
  await service.synthesize('甲');
  const [first] = await fs.readdir(options.cacheDirectory);
  await fs.utimes(path.join(options.cacheDirectory, first), new Date(0), new Date(0));
  await service.synthesize('乙');
  const second = (await fs.readdir(options.cacheDirectory)).find(name => name !== first);
  await fs.utimes(path.join(options.cacheDirectory, second), new Date(1000), new Date(1000));
  await service.synthesize('甲');
  await service.synthesize('丙');
  const names = await fs.readdir(options.cacheDirectory);
  const sizes = await Promise.all(names.map(async name => (await fs.stat(path.join(options.cacheDirectory, name))).size));
  assert.equal(names.length, 2);
  assert.ok(sizes.reduce((sum, size) => sum + size, 0) <= 70);
  await service.synthesize('甲');
  assert.deepEqual(calls, ['甲', '乙', '丙']);
  await service.synthesize('乙');
  assert.deepEqual(calls, ['甲', '乙', '丙', '乙']);
});

test('audio larger than the cache budget is returned without evicting a useful cached entry', async t => {
  const options = await fixture(t);
  const calls = [];
  const service = createEdgeTtsService({ ...options, maxCacheBytes: 35, ttsFactory: () => ({ async ttsPromise(text, file) {
    calls.push(text); await fs.writeFile(file, Buffer.alloc(text === '大音频' ? 4 : 3));
  } }) });
  await service.synthesize('小音频');
  assert.equal((await service.synthesize('大音频')).byteLength, 4);
  assert.equal((await service.synthesize('大音频')).byteLength, 4);
  await service.synthesize('小音频');
  assert.deepEqual(calls, ['小音频', '大音频', '大音频']);
  assert.equal((await fs.readdir(options.cacheDirectory)).length, 1);
});

test('empty and oversized provider returns fail without becoming cache hits', async t => {
  const options = await fixture(t);
  for (const size of [0, 16 * 1024 * 1024 + 1]) {
    let calls = 0;
    const service = createEdgeTtsService({ ...options, ttsFactory: () => ({ async ttsPromise(_text, file) {
      calls++; await fs.writeFile(file, Buffer.alloc(calls === 1 ? size : 3));
    } }) });
    await assert.rejects(service.synthesize('大小' + size));
    await service.synthesize('大小' + size);
    await service.synthesize('大小' + size);
    assert.equal(calls, 2);
  }
});

test('clear removes persisted entries and rejects in-flight results without stale cache writes', async t => {
  const options = await fixture(t);
  const entered = deferred(), release = deferred();
  let calls = 0;
  const service = createEdgeTtsService({ ...options, ttsFactory: () => ({ async ttsPromise(text, file) {
    calls++;
    if (text === '等待' && calls === 2) { entered.resolve(); await release.promise; }
    await fs.writeFile(file, Buffer.alloc(3));
  } }) });
  await service.synthesize('已缓存');
  const pending = service.synthesize('等待');
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  try {
    await within(entered.promise);
    await service.clearCache();
    assert.deepEqual(await fs.readdir(options.cacheDirectory), []);
    release.resolve();
    await within(rejected);
    assert.deepEqual(await fs.readdir(options.cacheDirectory), []);
    await service.synthesize('等待');
    await service.synthesize('已缓存');
    assert.equal(calls, 4);
  } finally { release.resolve(); await Promise.allSettled([pending, rejected]); }
});

test('cancelPending skips queued work, rejects stale audio and allows a fresh same-key request', async t => {
  const options = await fixture(t);
  const entered = deferred(), release = deferred();
  const calls = [];
  const service = createEdgeTtsService({ ...options, ttsFactory: () => ({ async ttsPromise(text, file) {
    calls.push(text);
    if (calls.length === 1) { entered.resolve(); await release.promise; }
    await fs.writeFile(file, Buffer.alloc(3));
  } }) });
  const active = service.synthesize('正在合成');
  let queued, fresh;
  const activeRejected = assert.rejects(active, error => error.name === 'AbortError');
  let queuedRejected;
  try {
    await within(entered.promise);
    queued = service.synthesize('队列中');
    queuedRejected = assert.rejects(queued, error => error.name === 'AbortError');
    service.cancelPending();
    fresh = service.synthesize('正在合成');
    release.resolve();
    await within(Promise.all([activeRejected, queuedRejected]));
    assert.equal((await within(fresh)).byteLength, 3);
    assert.deepEqual(calls, ['正在合成', '正在合成']);
    const recreated = createEdgeTtsService({ ...options, ttsFactory: () => ({ async ttsPromise(text, file) {
      calls.push(text); await fs.writeFile(file, Buffer.alloc(3));
    } }) });
    await recreated.synthesize('正在合成');
    assert.equal(calls.length, 2);
    await recreated.synthesize('队列中');
    assert.deepEqual(calls, ['正在合成', '正在合成', '队列中']);
  } finally {
    release.resolve();
    await Promise.allSettled([active, queued, fresh, activeRejected, queuedRejected]);
  }
});

test('cancelPending preserves completed cache entries but never persists the canceled synthesis', async t => {
  const options = await fixture(t);
  const entered = deferred(), release = deferred();
  let calls = 0;
  const service = createEdgeTtsService({ ...options, ttsFactory: () => ({ async ttsPromise(text, file) {
    calls++;
    if (text === '待取消' && calls === 2) { entered.resolve(); await release.promise; }
    await fs.writeFile(file, Buffer.alloc(3));
  } }) });
  await service.synthesize('保留');
  const before = await fs.readdir(options.cacheDirectory);
  const pending = service.synthesize('待取消');
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  try {
    await within(entered.promise);
    service.cancelPending();
    release.resolve();
    await within(rejected);
    assert.deepEqual(await fs.readdir(options.cacheDirectory), before);
    await service.synthesize('保留');
    assert.equal(calls, 2);
    await service.synthesize('待取消');
    await service.synthesize('待取消');
    assert.equal(calls, 3);
    assert.deepEqual(await fs.readdir(options.temporaryDirectory), ['cache']);
  } finally { release.resolve(); await Promise.allSettled([pending, rejected]); }
});
