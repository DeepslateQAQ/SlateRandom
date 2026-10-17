const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '../../../../src/renderer/legacy/speech-providers.js'), 'utf8');
const transport = fs.readFileSync(path.join(__dirname, '../../../../src/renderer/legacy/provider-transport.js'), 'utf8');
function load(extra = {}) {
  const context = { window: {}, document: {}, URL, Blob, Uint8Array, DOMException, TextDecoder, atob, AbortController, setTimeout, clearTimeout, ...extra };
  vm.runInNewContext(transport, context);
  vm.runInNewContext(script, context); return { context, speech: context.window.SpeechProviders };
}
const { speech: S } = load();
const mimo = { provider: 'mimo', key: 'fixture-secret', voice: '茉莉' };
const custom = { provider: 'custom', endpoint: 'http://localhost:8000/v1/audio/speech', model: 'edge-tts', voice: 'zh-CN-XiaoxiaoNeural', key: '', fallback: false };
function wav() {
  const audio = Buffer.alloc(46); audio.write('RIFF', 0); audio.writeUInt32LE(38, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(24000, 24);
  audio.writeUInt32LE(48000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(2, 40);
  return audio;
}
const payload = () => ({ choices: [{ message: { audio: { data: wav().toString('base64') } } }] });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Speech operation did not settle')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}
function credentialHarness({ portable, legacy = [], active = 'system', preview = false, browser = false, failWrite = false, form = false, readGate, failRead = false, url = URL } = {}) {
  const state = { portable, reads: [], writes: [], opened: 0, transactions: 0, failWrite, failRead };
  const stores = { providers: new Map(legacy.map(record => [record.provider, structuredClone(record)])), preferences: new Map([['active', { id: 'active', provider: active }]]) };
  const database = {
    close() {},
    transaction(names, mode) {
      state.transactions++; const staged = Object.fromEntries(Object.entries(stores).map(([name, values]) => [name, new Map(values)]));
      const tx = { objectStore(name) { return {
        getAll() { const request = {}; queueMicrotask(() => { request.result = Array.from(staged[name].values(), value => structuredClone(value)); }); return request; },
        get(id) { const request = {}; queueMicrotask(() => { request.result = structuredClone(staged[name].get(id)); }); return request; },
        clear() { staged[name].clear(); }, put(value) { staged[name].set(name === 'providers' ? value.provider : value.id, structuredClone(value)); }
      }; } };
      setTimeout(() => {
        if (mode === 'readwrite' && state.failWrite) { tx.onabort?.(); return; }
        if (mode === 'readwrite') Object.assign(stores, staged);
        tx.oncomplete?.();
      }, 0);
      return tx;
    }
  };
  const indexedDB = { open() { state.opened++; const request = {}; queueMicrotask(() => { request.result = database; request.onsuccess?.(); }); return request; } };
  const elements = new Map();
  function createElement() {
    const listeners = new Map();
    return { value: '', textContent: '', checked: false, disabled: false,
      setAttribute() {}, insertAdjacentHTML() {}, querySelectorAll() { return []; },
      addEventListener(type, callback) { const callbacks = listeners.get(type) || []; callbacks.push(callback); listeners.set(type, callbacks); },
      async dispatch(type) { for (const callback of listeners.get(type) || []) await callback({ preventDefault() {} }); }
    };
  }
  const document = form ? {
    getElementById(id) { if (!elements.has(id)) elements.set(id, createElement()); return elements.get(id); },
    createElement, body: { appendChild(element) { elements.set(element.id, element); } }
  } : { getElementById() { return null; } };
  const window = { indexedDB, location: { href: 'file:///SlateRandom/index.html' + (preview ? '?slatePreview=true' : '') } };
  window.DialogTransitions = { async open() {}, async close() {}, register() {} };
  if (!browser) window.slateDesktop = { role: 'main', data: {
    preview,
    async readCredentials(scope) { state.reads.push(scope); if (readGate) await readGate; if (state.failRead) throw new Error('fixture storage unavailable'); return structuredClone(state.portable); },
    async writeCredentials(scope, payload) {
      state.writes.push({ scope, payload: JSON.parse(JSON.stringify(payload)) });
      if (state.failWrite) throw new Error('程序目录不可写，提供商设置尚未保存。');
      state.portable = JSON.parse(JSON.stringify(payload));
    }
  } };
  const context = { window, document, indexedDB, URL: url, Blob, Uint8Array, DOMException, TextDecoder, atob, AbortController, setTimeout, clearTimeout };
  vm.runInNewContext(transport, context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../../../src/renderer/legacy/speech-providers.js'), 'utf8'), context);
  return { provider: window.SpeechProviders, state, stores, window, element: id => document.getElementById(id) };
}
const portableSpeech = key => ({ active: 'mimo', records: [{ provider: 'mimo', endpoint: 'https://api.xiaomimimo.com/v1/chat/completions', model: 'mimo-v2.5-tts', voice: '茉莉', key, fallback: false }] });
function desktopPlaybackHarness() {
  const blobs = new Map(), created = [], played = [], started = deferred();
  let nextUrl = 0;
  const h = credentialHarness({ form: true, url: {
    createObjectURL(blob) { const url = 'blob:fixture-' + ++nextUrl; blobs.set(url, blob); return url; },
    revokeObjectURL(url) { blobs.delete(url); }
  } });
  h.window.Audio = class {
    constructor(url) { this.blob = blobs.get(url); created.push(this); }
    play() { played.push(this); started.resolve(this); return Promise.resolve(); }
    pause() { this.paused = true; }
    load() {}
    removeAttribute() {}
  };
  return { h, created, played, started: started.promise };
}

test('默认设备朗读不携带远程地址／密钥，音色预设来自官方且唯一', async () => {
  const config = await S.getConfig();
  assert.equal(config.provider, 'system'); assert.equal(config.endpoint, ''); assert.equal(config.key, ''); assert.equal(config.fallback, false);
  assert.equal(S.voices.length, 9); assert.equal(new Set(S.voices.map(voice => voice.id)).size, 9);
  assert.equal(S.presets.find(preset => preset.id === 'mimo').voice, '茉莉');
  assert.throws(() => S.buildRequest(config, '王同学'), /无需网络请求/);
});
test('MiMo 待念姓名仅放在 assistant；固定原生端点、模型、WAV，密钥仅在header', () => {
  const request = S.buildRequest({ ...mimo, endpoint: 'https://not-used.example/tts', model: 'not-used' }, ' 王同学 ');
  assert.equal(request.endpoint, 'https://api.xiaomimimo.com/v1/chat/completions'); assert.equal(request.body.model, 'mimo-v2.5-tts');
  assert.equal(request.headers.Authorization, 'Bearer fixture-secret'); assert.equal(request.body.stream, false);
  assert.equal(request.body.messages.length, 1); assert.equal(request.body.messages[0].role, 'assistant'); assert.equal(request.body.messages[0].content, '王同学');
  assert.equal(request.body.audio.format, 'wav'); assert.equal(request.body.audio.voice, '茉莉');
  assert.equal(JSON.stringify(request.body).includes('fixture-secret'), false); assert.equal(request.endpoint.includes('fixture-secret'), false);
});
test('自定义 EdgeTTS 兼容请求发送姓名 input、模型、音色和二进制 MP3 协议，支持免密', () => {
  const request = S.buildRequest(custom, '李同学');
  assert.equal(request.endpoint, custom.endpoint); assert.equal(request.headers.Authorization, undefined);
  assert.equal(request.body.input, '李同学'); assert.equal(request.body.model, 'edge-tts'); assert.equal(request.body.voice, 'zh-CN-XiaoxiaoNeural'); assert.equal(request.body.response_format, 'mp3');
  assert.equal(request.body.messages, undefined);
  assert.equal(S.normalize({ ...custom, endpoint: 'http://127.0.0.1:8000/v1/' }).endpoint, 'http://127.0.0.1:8000/v1/audio/speech');
});
test('非法接口、密钥、音色与姓名在发请求前拒绝；失败回退默认关闭', () => {
  for (const endpoint of ['file:///C:/secret', 'http://remote.example/tts', 'https://user:pass@example.com/tts', 'https://example.com/tts?api_key=secret', 'https://example.com/tts#secret']) assert.throws(() => S.normalize({ ...custom, endpoint }));
  assert.throws(() => S.normalize({ ...mimo, voice: '非预设音色' }), /预置音色/);
  assert.throws(() => S.normalize({ ...mimo, key: 'secret\r\nInjected' }), /密钥格式/);
  assert.throws(() => S.buildRequest({ ...mimo, key: '' }, '王同学'), /保存 MiMo API 密钥/);
  assert.throws(() => S.buildRequest(mimo, '\u0000'), /有效的姓名/);
  assert.equal(S.normalize(mimo).fallback, false); assert.equal(S.normalize({ ...mimo, fallback: true }).fallback, true);
});
test('MiMo base64 WAV 严格转换为 Blob，不接受错误对象、文本或其他格式', async () => {
  const audio = S.responseAudio(payload()); assert.equal(audio.type, 'audio/wav'); assert.equal(audio.size, wav().length);
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), wav());
  for (const data of [{ error: { message: '失败' } }, { choices: [{ message: { audio: { data: 'not*base64' } } }] }, { choices: [{ message: { audio: { data: Buffer.from('plain text').toString('base64') } } }] }]) assert.throws(() => S.responseAudio(data));
});
test('自定义语音拒绝 JSON 服务错误和空音频', async () => {
  await assert.rejects(() => S.requestAudio(custom, '李同学', { fetch: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) }), /未返回音频文件/);
  await assert.rejects(() => S.requestAudio(custom, '李同学', { fetch: async () => new Response('', { headers: { 'content-type': 'audio/mpeg' } }) }), /音频大小无效/);
});
test('远程认证／限流／网络错误明确失败，不输出服务端可能包含密钥的内容', async () => {
  for (const [status, message] of [[401, /认证失败/], [403, /认证失败/], [429, /限流/], [500, /HTTP 500/]]) {
    await assert.rejects(() => S.requestAudio(mimo, '王同学', { fetch: async () => new Response('fixture-secret', { status }) }), error => message.test(error.message) && !error.message.includes('fixture-secret'));
  }
  await assert.rejects(() => S.requestAudio(mimo, '王同学', { fetch: async () => { throw new TypeError('Failed to fetch fixture-secret'); } }), error => /跨域/.test(error.message) && !error.message.includes('fixture-secret'));
});
test('超时主动 abort，即使代理不响应 abort 也结束，不残留等待', async () => {
  let signal;
  const pending = S.requestAudio(custom, '王同学', { timeoutMs: 8, fetch: async (_, request) => { signal = request.signal; return new Promise(() => {}); } });
  await assert.rejects(pending, /超时/); assert.equal(signal.aborted, true);
});
test('外部取消主动 abort，并且已取消请求在发网络前结束', async () => {
  const controller = new AbortController(); let signal, calls = 0;
  const pending = S.requestAudio(custom, '王同学', { signal: controller.signal, fetch: async (_, request) => { calls++; signal = request.signal; return new Promise(() => {}); } });
  controller.abort(); await assert.rejects(pending, error => error.name === 'AbortError'); assert.equal(signal.aborted, true);
  await assert.rejects(() => S.requestAudio(custom, '王同学', { signal: controller.signal, fetch: async () => { calls++; } }), error => error.name === 'AbortError'); assert.equal(calls, 1);
});
test('系统朗读快速下一轮取消旧姓名，只让新姓名完成；stop 清理声音和计时器', async () => {
  const spoken = []; let cancels = 0;
  class Utterance { constructor(text) { this.text = text; } }
  const { speech } = load({ window: { SpeechSynthesisUtterance: Utterance, speechSynthesis: { cancel() { cancels++; }, speak(utterance) { spoken.push(utterance); } } } });
  const first = speech.speak('王同学'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(spoken[0].text, '王同学'); assert.equal(spoken[0].lang, 'zh-CN'); assert.equal(spoken[0].rate, .9);
  const second = speech.speak('李同学'); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await first).cancelled, true); assert.equal(spoken[0].onend, null);
  spoken[1].onend(); assert.equal((await second).spoken, true); assert.equal(spoken[1].onend, null);
  speech.stop(); assert.ok(cancels >= 3);
});

test('桌面合成开始后 stop 结算旧朗读，迟到音频不播放，下一次独立合成可以完成', async () => {
  const playback = desktopPlaybackHarness(), { h } = playback;
  await h.provider.init({ mount: {} });
  const firstEntered = deferred(), firstAudio = deferred(), secondEntered = deferred(), secondAudio = deferred();
  h.window.slateDesktop.speech = { async synthesize(name) {
    if (name === '王同学') { firstEntered.resolve(); await firstAudio.promise; return new Uint8Array(3); }
    secondEntered.resolve(); await secondAudio.promise; return new Uint8Array(5);
  } };
  const first = h.provider.speak('王同学');
  let second;
  try {
    await within(firstEntered.promise);
    h.provider.stop();
    assert.equal((await within(first)).cancelled, true);
    firstAudio.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(playback.created.length, 0);
    assert.equal(playback.played.length, 0);
    second = h.provider.speak('李同学');
    await within(secondEntered.promise);
    assert.equal(playback.played.length, 0);
    secondAudio.resolve();
    const audio = await within(playback.started);
    assert.equal(audio.blob.size, 5);
    assert.equal(playback.played.length, 1);
    audio.onended();
    assert.equal((await within(second)).spoken, true);
    assert.equal(audio.paused, true);
  } finally {
    h.provider.stop(); firstAudio.resolve(); secondAudio.resolve();
    await Promise.allSettled([first, second]);
  }
});

for (const action of ['stop', 'next']) {
  test(`桌面缓存即时音频不会越过 ${action} 播放，后续姓名仍可完成`, async () => {
    const playback = desktopPlaybackHarness(), { h } = playback;
    await h.provider.init({ mount: {} });
    const firstEntered = deferred();
    let second;
    // Interrupt in the first continuation after bridge entry, before its immediate bytes resume playback.
    const interrupted = firstEntered.promise.then(() => {
      if (action === 'stop') h.provider.stop();
      else second = h.provider.speak('李同学');
    });
    h.window.slateDesktop.speech = { synthesize(name) {
      if (name === '王同学') { firstEntered.resolve(); return Promise.resolve(new Uint8Array(3)); }
      return Promise.resolve(new Uint8Array(5));
    } };
    const first = h.provider.speak('王同学');
    try {
      await within(interrupted);
      if (action === 'stop') {
        assert.equal((await within(first)).cancelled, true);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(playback.created.length, 0);
        second = h.provider.speak('李同学');
      }
      assert.equal((await within(first)).cancelled, true);
      const audio = await within(playback.started);
      assert.equal(audio.blob.size, 5);
      assert.equal(playback.played.length, 1);
      audio.onended();
      assert.equal((await within(second)).spoken, true);
    } finally {
      h.provider.stop();
      await Promise.allSettled([first, second]);
    }
  });
}

test('桌面朗读配置优先读取便携 JSON，安全导出不泄露密钥也不访问旧 IDB', async () => {
  const { provider, state } = credentialHarness({ portable: portableSpeech('portable-secret'), legacy: portableSpeech('legacy-secret').records });
  const safe = await provider.exportSettings();
  assert.equal(safe.active, 'mimo'); assert.equal(Object.hasOwn(safe.records[0], 'key'), false);
  assert.equal((await provider.getConfig()).key, 'portable-secret'); assert.equal(state.opened, 0); assert.deepEqual(state.reads, ['speech']); assert.equal(state.writes.length, 0);
  safe.records[0].voice = '冰糖'; assert.equal((await provider.getConfig()).voice, '茉莉');
});
test('朗读便携配置为空时迁移旧 IDB 一次，保留音色、密钥和失败回退设置', async () => {
  const old = { ...portableSpeech('legacy-secret').records[0], voice: '冰糖', fallback: true };
  const { provider, state } = credentialHarness({ portable: null, legacy: [old], active: 'mimo' });
  const result = await provider.exportSettings({ includeSecrets: true });
  assert.equal(result.active, 'mimo'); assert.equal(result.records[0].key, 'legacy-secret'); assert.equal(result.records[0].voice, '冰糖'); assert.equal(result.records[0].fallback, true);
  await provider.exportSettings(); assert.equal(state.opened, 1); assert.equal(state.writes.length, 1); assert.equal(state.writes[0].scope, 'speech');
});
test('朗读设置导入保留缺省密钥，显式新密钥或空值优先；全量替换移除旧提供商', async () => {
  const { provider, state } = credentialHarness({ portable: portableSpeech('existing-secret') });
  await provider.importSettings({ active: 'mimo', records: [{ provider: 'mimo', voice: '冰糖', fallback: true }] });
  assert.equal(state.portable.records[0].key, 'existing-secret'); assert.equal(state.portable.records[0].voice, '冰糖'); assert.equal(state.portable.records[0].fallback, true);
  await provider.importSettings(portableSpeech('replacement')); assert.equal(state.portable.records[0].key, 'replacement');
  await provider.importSettings(portableSpeech('')); assert.equal(state.portable.records[0].key, '');
  await provider.importSettings({ active: 'system', records: [] }); assert.equal(state.portable.records.length, 0); assert.equal((await provider.getConfig()).provider, 'system');
});
test('朗读导入可明确清除未导出的密钥，并发写入串行保持后续缺省密钥', async () => {
  const { provider, state } = credentialHarness({ portable: portableSpeech('existing-secret') });
  await provider.importSettings({ active: 'mimo', records: [{ provider: 'mimo' }] }, { preserveKeys: false }); assert.equal(state.portable.records[0].key, '');
  await Promise.all([provider.importSettings(portableSpeech('ordered-secret')), provider.importSettings({ active: 'mimo', records: [{ provider: 'mimo', voice: '冰糖' }] })]);
  assert.equal(state.portable.records[0].key, 'ordered-secret'); assert.equal(state.portable.records[0].voice, '冰糖');
});
test('朗读导入拒绝重复、不完整、非法地址或音色，不损坏已有配置', async () => {
  const { provider, state } = credentialHarness({ portable: portableSpeech('safe-secret') });
  for (const payload of [null, [], { active: 'unknown', records: [] }, { active: 'mimo', records: [] }, { active: 'mimo', records: [{}] }, { active: 'mimo', records: [{ provider: 'mimo', key: null }] }, { active: 'mimo', records: [{ provider: 'mimo' }, { provider: 'mimo' }] }, { active: 'mimo', records: [{ provider: 'mimo', voice: 'invalid' }] }, { active: 'custom', records: [{ provider: 'custom', endpoint: 'https://secret@example.com/tts' }] }]) await assert.rejects(provider.importSettings(payload));
  assert.equal(state.writes.length, 0); assert.equal((await provider.exportSettings({ includeSecrets: true })).records[0].key, 'safe-secret');
});
test('朗读便携写入失败不更新内存，重试成功才提交；迁移失败不会静默伪保存', async () => {
  const { provider, state } = credentialHarness({ portable: portableSpeech('safe-secret'), failWrite: true });
  await assert.rejects(provider.importSettings(portableSpeech('failed-secret')), /尚未保存/); assert.equal((await provider.getConfig()).key, 'safe-secret');
  state.failWrite = false; await provider.importSettings(portableSpeech('retry-secret')); assert.equal((await provider.getConfig()).key, 'retry-secret');
  const migration = credentialHarness({ portable: null, legacy: portableSpeech('legacy-secret').records, active: 'mimo', failWrite: true });
  await assert.rejects(migration.provider.exportSettings(), /尚未保存/); await assert.rejects(migration.provider.exportSettings(), /尚未保存/); assert.equal(migration.state.writes.length, 1);
});
test('损坏朗读 JSON 不回退覆盖；slatePreview 不迁移且不修改正式便携设置', async () => {
  const corrupt = credentialHarness({ portable: { active: 'mimo', records: [] }, legacy: portableSpeech('legacy-secret').records });
  await assert.rejects(corrupt.provider.exportSettings()); assert.equal(corrupt.state.opened, 0); assert.equal(corrupt.state.writes.length, 0);
  const preview = credentialHarness({ portable: portableSpeech('formal-secret'), legacy: portableSpeech('preview-secret').records, active: 'mimo', preview: true });
  assert.equal((await preview.provider.getConfig()).provider, 'system');
  assert.equal((await preview.provider.exportSettings({ includeSecrets: true })).records[0].key, 'preview-secret');
  await preview.provider.importSettings(portableSpeech('preview-only')); assert.equal(preview.state.portable.records[0].key, 'formal-secret'); assert.equal(preview.state.reads.length, 0); assert.equal(preview.state.writes.length, 0);
});
test('HTML 浏览器朗读仍保存至 IDB，失败事务保持原配置', async () => {
  const { provider, state, stores } = credentialHarness({ browser: true, legacy: portableSpeech('browser-secret').records, active: 'mimo' });
  await provider.importSettings({ active: 'mimo', records: [{ provider: 'mimo', voice: '冰糖' }] });
  assert.equal(stores.providers.get('mimo').key, 'browser-secret'); assert.equal(stores.providers.get('mimo').voice, '冰糖');
  state.failWrite = true; await assert.rejects(provider.importSettings(portableSpeech('failed-secret')), /保存失败/);
  assert.equal(stores.providers.get('mimo').key, 'browser-secret'); assert.equal((await provider.getConfig()).voice, '冰糖');
});
test('朗读备份预检不持久化，原子恢复后只读重载并保持损坏前的缓存', async () => {
  const { provider, state } = credentialHarness({ portable: portableSpeech('existing-secret') });
  const prepared = await provider.prepareSettings({ active: 'mimo', records: [{ provider: 'mimo', voice: '冰糖', fallback: true }] });
  assert.equal(prepared.records[0].key, 'existing-secret'); assert.equal(prepared.records[0].voice, '冰糖'); assert.equal(state.writes.length, 0);
  assert.equal((await provider.getConfig()).voice, '茉莉');
  state.portable = JSON.parse(JSON.stringify(prepared)); await provider.reloadSettings();
  assert.equal((await provider.getConfig()).voice, '冰糖'); assert.equal(state.writes.length, 0);
  state.portable = { active: 'mimo', records: [] }; await assert.rejects(provider.reloadSettings());
  assert.equal((await provider.getConfig()).key, 'existing-secret');
});
test('损坏朗读 JSON 完整恢复后可重新初始化，未知旧密钥不会当作已知数据保留', async () => {
  const { provider, state } = credentialHarness({ portable: { active: 'mimo', records: [] } });
  await assert.rejects(provider.exportSettings());
  await assert.rejects(provider.prepareSettings({ active: 'mimo', records: [{ provider: 'mimo' }] }));
  const prepared = await provider.prepareSettings({ active: 'mimo', records: [{ provider: 'mimo' }] }, { allowUnavailable: true });
  assert.equal(prepared.records[0].key, ''); assert.equal(state.writes.length, 0);
  state.portable = { active: 'mimo', records: [{ ...prepared.records[0], key: 'restored-speech-secret' }] };
  await provider.reloadSettings(); assert.equal((await provider.getConfig()).key, 'restored-speech-secret');
  assert.equal((await provider.exportSettings({ includeSecrets: true })).records[0].key, 'restored-speech-secret');
});

const customSpeech = (endpoint, key) => ({ active: 'custom', records: [{ provider: 'custom', endpoint, model: 'fixture-tts', voice: 'fixture-voice', ...(key === undefined ? {} : { key }) }] });
const speechEndpoint = 'https://localhost:8443/v1/audio/speech?route=one';
const speechEndpointChanges = [
  'https://127.0.0.1:8443/v1/audio/speech?route=one',
  'https://localhost:8444/v1/audio/speech?route=one',
  'http://localhost:8443/v1/audio/speech?route=one',
  'https://localhost:8443/v2/audio/speech?route=one',
  'https://localhost:8443/v1/audio/speech?route=two',
  'https://localhost:8443/v1/audio/speech?route=one&extra=1'
];
test('自定义朗读密钥只保留给同一提供商的完整规范化接口，预检不写入', async () => {
  for (const endpoint of speechEndpointChanges) {
    const { provider, state } = credentialHarness({ portable: customSpeech(speechEndpoint, 'fixture-old-key') });
    const candidate = customSpeech(endpoint);
    assert.equal((await provider.prepareSettings(candidate)).records[0].key, '', endpoint);
    assert.equal(state.writes.length, 0); assert.equal((await provider.getConfig()).key, 'fixture-old-key');
    await provider.importSettings(candidate);
    const request = provider.buildRequest(await provider.getConfig(), '合成同学');
    assert.equal(request.endpoint, endpoint); assert.equal(request.headers.Authorization, undefined);
  }
  const { provider, state } = credentialHarness({ portable: customSpeech(speechEndpoint, 'fixture-old-key') });
  const equivalent = customSpeech(' HTTPS://LOCALHOST:8443/v1/./audio/speech?route=one ');
  assert.equal((await provider.prepareSettings(equivalent)).records[0].key, 'fixture-old-key');
  assert.equal((await provider.prepareSettings(equivalent, { preserveKeys: false })).records[0].key, '');
  assert.equal(state.writes.length, 0);
  await provider.importSettings(equivalent); assert.equal((await provider.getConfig()).key, 'fixture-old-key');
  await provider.importSettings(customSpeech(speechEndpoint, '')); assert.equal((await provider.getConfig()).key, '');
  await provider.importSettings(customSpeech(speechEndpointChanges[0], 'fixture-new-key'));
  assert.equal(provider.buildRequest(await provider.getConfig(), '合成同学').headers.Authorization, 'Bearer fixture-new-key');
});
test('朗读内置接口与模型固定，相同接口的另一提供商不能借用旧密钥', async () => {
  const { provider, state } = credentialHarness({ portable: portableSpeech('fixture-old-key') });
  const endpoint = portableSpeech('').records[0].endpoint;
  assert.equal((await provider.prepareSettings(customSpeech(endpoint))).records[0].key, '');
  const pinned = await provider.prepareSettings({ active: 'mimo', records: [{ provider: 'mimo', endpoint: 'https://other.example/redirect', model: 'other-model' }] });
  assert.equal(pinned.records[0].endpoint, endpoint); assert.equal(pinned.records[0].model, 'mimo-v2.5-tts');
  assert.equal(pinned.records[0].key, 'fixture-old-key'); assert.equal(state.writes.length, 0);
  await provider.importSettings(pinned);
  assert.equal(provider.buildRequest(await provider.getConfig(), '合成同学').endpoint, endpoint);
});
test('朗读接口拒绝全部凭据查询名及大小写变体，保留本机 HTTP 代理能力', async () => {
  const { provider, state } = credentialHarness({ portable: customSpeech(speechEndpoint, 'fixture-old-key') });
  for (const name of ['key', 'api-key', 'api_key', 'apikey', 'x-api-key', 'x_api_key', 'token', 'access_token', 'access-token', 'authorization', 'password', 'secret']) {
    for (const variant of [name, name.toUpperCase()]) await assert.rejects(provider.prepareSettings(customSpeech('https://example.test/v1?' + variant + '=fixture')), /密钥请填写/);
  }
  for (const endpoint of ['https://user:pass@example.test/v1', 'https://example.test/v1#fragment', 'http://remote.example/v1']) await assert.rejects(provider.prepareSettings(customSpeech(endpoint)));
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const endpoint = 'http://' + host + ':8000/v1/?route=safe';
    assert.equal((await provider.prepareSettings(customSpeech(endpoint))).records[0].endpoint, 'http://' + host + ':8000/v1/audio/speech?route=safe');
  }
  assert.equal(state.writes.length, 0); assert.equal(state.portable.records[0].key, 'fixture-old-key');
});
test('朗读冷预检不迁移写入，失败或取消后正常读取仍迁移；恢复重载不覆盖新配置', async () => {
  const old = customSpeech(speechEndpoint, 'fixture-old-key');
  const { provider, state } = credentialHarness({ portable: null, legacy: old.records, active: 'custom' });
  await assert.rejects(provider.prepareSettings({ active: 'invalid', records: [] }));
  const prepared = await provider.prepareSettings(customSpeech(speechEndpoint));
  assert.equal(prepared.records[0].key, 'fixture-old-key'); assert.equal(state.writes.length, 0); assert.equal(state.portable, null);
  await provider.exportSettings(); assert.equal(state.writes.length, 1); assert.equal(state.portable.records[0].key, 'fixture-old-key');
  const restored = credentialHarness({ portable: null, legacy: old.records, active: 'custom' });
  await restored.provider.prepareSettings(customSpeech(speechEndpointChanges[0]));
  restored.state.portable = customSpeech(speechEndpointChanges[0], 'fixture-restored-key');
  await restored.provider.reloadSettings(); await restored.provider.exportSettings();
  assert.equal((await restored.provider.getConfig()).key, 'fixture-restored-key'); assert.equal(restored.state.writes.length, 0);
});
test('朗读表单空密码仅在完整接口未变时保留，更改接口不借用旧密钥', async () => {
  for (const endpoint of [' HTTPS://LOCALHOST:8443/v1/./audio/speech?route=one ', ...speechEndpointChanges]) {
    const { provider, state, element } = credentialHarness({ portable: customSpeech(speechEndpoint, 'fixture-old-key'), form: true });
    await provider.init({ mount: {} }); await provider.open();
    element('speechEndpoint').value = endpoint; await element('speechEndpoint').dispatch('input');
    const changed = endpoint !== ' HTTPS://LOCALHOST:8443/v1/./audio/speech?route=one ';
    await element('speechProviderForm').dispatch('submit');
    assert.equal(state.writes.length, 1); assert.equal(state.portable.records[0].key, changed ? '' : 'fixture-old-key');
  }
});
test('朗读表单保存和清除都尊重写入守卫，协调恢复导入仍然可用', async () => {
  const { provider, state, element } = credentialHarness({ portable: customSpeech(speechEndpoint, 'fixture-old-key'), form: true });
  let allowed = false;
  await provider.init({ mount: {}, canWrite: () => allowed }); await provider.open();
  element('speechApiKey').value = 'fixture-manual-key';
  await element('speechProviderForm').dispatch('submit'); await element('speechClearKeyBtn').dispatch('click');
  assert.equal(state.writes.length, 0); assert.equal(element('speechApiKey').value, 'fixture-manual-key');
  await provider.importSettings(customSpeech(speechEndpoint, 'fixture-import-key')); assert.equal(state.writes.length, 1);
  allowed = true; await element('speechClearKeyBtn').dispatch('click');
  assert.equal((await provider.getConfig()).key, ''); assert.equal(state.writes.length, 2);
  const delayed = credentialHarness({ portable: customSpeech(speechEndpoint, 'fixture-old-key'), form: true });
  let checks = 0; await delayed.provider.init({ mount: {}, canWrite: () => ++checks % 2 === 1 }); await delayed.provider.open();
  await delayed.element('speechProviderForm').dispatch('submit'); await delayed.element('speechClearKeyBtn').dispatch('click');
  assert.equal(delayed.state.writes.length, 0); assert.equal(checks, 4);
});

test('MiMo JSON 和二进制音频在流内执行各自字节限额并 abort', async () => {
  for (const [config, limit, type] of [[mimo, 24 * 1024 * 1024, 'application/json'], [custom, 16 * 1024 * 1024, 'audio/mpeg']]) {
    let signal, cancelled = false;
    await assert.rejects(S.requestAudio(config, '王同学', { fetch: async (_, request) => { signal = request.signal; return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(limit)); c.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': type, 'content-length': '1' } }); } }), error => error.code === 'BODY_TOO_LARGE' && !/跨域/.test(error.message));
    assert.equal(signal.aborted, true); assert.equal(cancelled, true);
  }
});
test('MiMo 大 padding 仍受 JSON 总量限制而非仅音频字段限制', async () => {
  await assert.rejects(S.requestAudio(mimo, '王同学', { fetch: async () => new Response(JSON.stringify({ ...payload(), padding: ' '.repeat(24 * 1024 * 1024) })) }), error => error.code === 'BODY_TOO_LARGE');
});
test('语音挂起 body 由 deadline 和取消及时终止', async () => {
  const fetch = async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { headers: { 'content-type': 'audio/mpeg' } });
  await assert.rejects(S.requestAudio(custom, '王同学', { fetch, timeoutMs: 8 }), /超时/);
  const controller = new AbortController();
  const pending = S.requestAudio(custom, '王同学', { fetch, signal: controller.signal });
  controller.abort(); await assert.rejects(pending, error => error.name === 'AbortError');
});
test('系统朗读容忍凭据读取失败，已知远程配置失败不隐式回退', async () => {
  const system = credentialHarness({ form: true, failRead: true });
  await system.provider.init({ mount: {} });
  assert.equal((await system.provider.getConfig()).provider, 'system');
  system.window.SpeechSynthesisUtterance = class {};
  system.window.speechSynthesis = { cancel() {}, speak(utterance) { queueMicrotask(() => utterance.onend?.()); } };
  assert.equal((await system.provider.speak('王同学')).spoken, true);
  const remote = credentialHarness({ form: true, portable: null, legacy: portableSpeech('fixture').records, active: 'mimo', failWrite: true });
  await remote.provider.init({ mount: {} });
  await assert.rejects(remote.provider.getConfig(), /不可写/);
  let fallbackSpoken = 0;
  remote.window.SpeechSynthesisUtterance = class {};
  remote.window.speechSynthesis = { cancel() {}, speak() { fallbackSpoken++; } };
  assert.equal((await remote.provider.speak('王同学')).spoken, false);
  assert.equal(fallbackSpoken, 0);
});
test('配置获取期间 stop 立即结算，迟到配置不会朗读', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = credentialHarness({ form: true, portable: { active: 'system', records: [] }, readGate: gate });
  const spoken = [];
  h.window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  h.window.speechSynthesis = { cancel() {}, speak(value) { spoken.push(value); } };
  const initialization = h.provider.init({ mount: {} });
  const pending = h.provider.speak('王同学'); h.provider.stop();
  let timer;
  const result = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('stop 未及时结算')), 100); })]).finally(() => clearTimeout(timer));
  assert.equal(result.cancelled, true); release(); await initialization;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(spoken.length, 0);
});

test('朗读便携选择只由桥接 preview 决定，不受 URL 查询修改影响', async () => {
  const preview = credentialHarness({ portable: portableSpeech('formal'), legacy: portableSpeech('isolated').records, active: 'mimo', preview: true });
  preview.window.location.href = 'file:///SlateRandom/index.html';
  assert.equal((await preview.provider.exportSettings({ includeSecrets: true })).records[0].key, 'isolated');
  assert.equal(preview.state.reads.length, 0);
  const main = credentialHarness({ portable: portableSpeech('formal') });
  main.window.location.href = 'file:///SlateRandom/index.html?slatePreview=true';
  assert.equal((await main.provider.exportSettings({ includeSecrets: true })).records[0].key, 'formal');
  assert.equal(main.state.opened, 0);
});
test('stop 后迟到的音频响应不会建立或播放音频', async () => {
  const h = credentialHarness({ form: true, portable: portableSpeech('fixture') });
  await h.provider.init({ mount: {} });
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  let audioCreated = 0, played = 0;
  h.window.fetch = async () => { entered(); return response; };
  h.window.Audio = class { constructor() { audioCreated++; } play() { played++; } };
  const pending = h.provider.speak('王同学'); await started;
  h.provider.stop(); assert.equal((await pending).cancelled, true);
  release(new Response(JSON.stringify(payload())));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(audioCreated, 0); assert.equal(played, 0);
});
