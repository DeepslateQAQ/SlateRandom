const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const context = { window: {}, document: {}, URL, Uint8Array, DOMException, TextDecoder, AbortController, setTimeout, clearTimeout };
const transport = fs.readFileSync(path.join(__dirname, '../../../../src/renderer/legacy/provider-transport.js'), 'utf8');
vm.runInNewContext(transport, context);
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../../../src/renderer/legacy/providers.js'), 'utf8'), context);
const P = context.window.VisionProviders, image = 'data:image/png;base64,aGVsbG8=';
const request = (id, model) => { const p = P.presets.find(p => p.id === id); return P.buildRequest({ provider: id, model: model || p.models[0], endpoint: p.endpoint, key: 'fixture-secret' }, '读取座位表和参考学号', image); };

for (const id of ['openai', 'claude', 'gemini']) test(id + ' 只有学号参考表时发送纯文字，不伪造图片或座位坐标', () => {
  const preset = P.presets.find(p => p.id === id), prompt = '仅提取姓名和学号，不输出坐标。';
  const r = P.buildRequest({ provider: id, model: preset.models[0], endpoint: preset.endpoint, key: 'fixture-secret' }, prompt, null);
  const body = JSON.stringify(r.body); assert.ok(body.includes(prompt));
  assert.ok(!body.includes('image_url') && !body.includes('inlineData') && !body.includes('base64') && !body.includes('media_type'));
});
test('GPT-6-Luna 与 GPT-5.6-Luna 按指定 ID 使用图片输入，密钥只进入认证 header', () => {
  for (const model of ['gpt-6-luna', 'gpt-5.6-luna']) {
    const r = request('openai', model);
    assert.equal(r.endpoint, 'https://api.openai.com/v1/chat/completions'); assert.equal(r.body.model, model);
    assert.equal(r.headers.Authorization, 'Bearer fixture-secret'); assert.equal(r.body.messages[0].content[1].image_url.url, image);
    assert.equal(r.body.reasoning_effort, 'low'); assert.equal(JSON.stringify(r.body).includes('fixture-secret'), false);
  }
});
test('DeepSeek/Kimi/MiMo 发送兼容的多模态内容，使用各自官方端点', () => {
  for (const id of ['deepseek', 'kimi', 'mimo']) {
    const r = request(id); assert.equal(r.body.stream, false); assert.equal(r.body.messages[0].role, 'user');
    assert.equal(r.body.messages[0].content[0].type, 'text'); assert.equal(r.body.messages[0].content[1].type, 'image_url');
    assert.equal(r.headers.Authorization, 'Bearer fixture-secret'); assert.equal(r.endpoint.includes('openai.com'), false);
  }
  assert.equal(request('deepseek').body.model, 'deepseek-flash');
});
test('Claude 使用 Messages 协议及纯 base64 图片，不把 data URL 当 source.data', () => {
  const r = request('claude'); assert.equal(r.endpoint, 'https://api.anthropic.com/v1/messages');
  assert.equal(r.headers['x-api-key'], 'fixture-secret'); assert.equal(r.headers['anthropic-version'], '2023-06-01');
  assert.equal(r.headers['anthropic-dangerous-direct-browser-access'], 'true'); assert.ok(r.body.max_tokens >= 4096);
  const part = r.body.messages[0].content[0]; assert.equal(part.type, 'image'); assert.equal(part.source.media_type, 'image/png'); assert.equal(part.source.data, 'aGVsbG8=');
  assert.equal(r.headers.Authorization, undefined);
});
test('Gemini 在 header 传密钥，模型 URL 编码且图片是 inlineData', () => {
  const r = request('gemini'); assert.equal(r.headers['x-goog-api-key'], 'fixture-secret');
  assert.equal(r.endpoint, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(r.endpoint.includes('fixture-secret'), false); assert.equal(r.body.contents[0].parts[0].inlineData.data, 'aGVsbG8=');
  assert.equal(r.body.contents[0].parts[0].inlineData.mimeType, 'image/png'); assert.equal(r.body.generationConfig.responseMimeType, 'application/json');
});
test('自定义免密兼容接口不会发送空认证 header', () => {
  const r = P.buildRequest({ provider: 'custom', model: 'local-vl', endpoint: 'http://localhost:8080/v1/chat/completions', key: '' }, '提示词', image);
  assert.equal(r.headers.Authorization, undefined); assert.equal(r.body.model, 'local-vl');
});
test('不同提供商响应只提取可见 text，排除 Gemini 思考和 Claude 非文本块', () => {
  assert.equal(P.responseText({ choices: [{ message: { content: [{ type: 'text', text: '{"students":[]}' }, { type: 'image', text: '忽略' }] } }] }, 'chat'), '{"students":[]}');
  assert.equal(P.responseText({ content: [{ type: 'thinking', thinking: '推理' }, { type: 'text', text: '结果' }] }, 'claude'), '结果');
  assert.equal(P.responseText({ candidates: [{ content: { parts: [{ thought: true, text: '推理' }, { text: '结果' }] } }] }, 'gemini'), '结果');
});
test('无输出或被拦截的响应明确失败，不把错误对象或隐藏推理当识别结果', () => {
  for (const protocol of ['chat', 'claude', 'gemini']) assert.throws(() => P.responseText({ error: { message: '失败' } }, protocol), /没有收到文字识别结果/);
  assert.throws(() => P.responseText({ candidates: [{ content: { parts: [{ thought: true, text: '推理' }] } }] }, 'gemini'), /没有收到文字识别结果/);
});
test('不支持的图片输入在发请求前被拒绝', () => {
  assert.throws(() => P.buildRequest({ provider: 'claude', model: 'claude-sonnet-5-5' }, '读取', 'https://example.com/image.png'), /图片内容无效/);
  assert.throws(() => P.buildRequest({ provider: 'gemini', model: 'gemini-3.8-flash' }, '读取', 'data:text/html;base64,aA=='), /图片内容无效/);
});

function credentialHarness({ portable, legacy = [], active = 'deepseek', preview = false, browser = false, failWrite = false, form = false } = {}) {
  const state = { portable, reads: [], writes: [], opened: 0, transactions: 0, failWrite };
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
    async readCredentials(scope) { state.reads.push(scope); return structuredClone(state.portable); },
    async writeCredentials(scope, payload) {
      state.writes.push({ scope, payload: JSON.parse(JSON.stringify(payload)) });
      if (state.failWrite) throw new Error('程序目录不可写，提供商设置尚未保存。');
      state.portable = JSON.parse(JSON.stringify(payload));
    }
  } };
  const context = { window, document, indexedDB, URL, Uint8Array, DOMException, TextDecoder, AbortController, setTimeout, clearTimeout };
  vm.runInNewContext(transport, context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../../../src/renderer/legacy/providers.js'), 'utf8'), context);
  return { provider: window.VisionProviders, state, stores, window, element: id => document.getElementById(id) };
}
const portableVision = key => ({ active: 'openai', records: [{ provider: 'openai', model: 'gpt-6-luna', endpoint: 'https://api.openai.com/v1/chat/completions', key }] });

test('桌面视觉配置以便携 JSON 为准，导出默认省略密钥且不打开旧数据库', async () => {
  const { provider, state } = credentialHarness({ portable: portableVision('portable-secret'), legacy: portableVision('old-secret').records });
  const safe = await provider.exportSettings();
  assert.equal(safe.active, 'openai'); assert.equal(safe.records[0].model, 'gpt-6-luna'); assert.equal(Object.hasOwn(safe.records[0], 'key'), false);
  assert.equal((await provider.exportSettings({ includeSecrets: true })).records[0].key, 'portable-secret');
  assert.equal(state.opened, 0); assert.deepEqual(state.reads, ['vision']); assert.equal(state.writes.length, 0);
  safe.records[0].model = 'mutated'; assert.equal((await provider.getConfig()).model, 'gpt-6-luna');
});
test('便携视觉 JSON 缺失时仅迁移一次旧 IDB，保留活动提供商和密钥', async () => {
  const { provider, state } = credentialHarness({ portable: null, legacy: portableVision('legacy-secret').records, active: 'openai' });
  const result = await provider.exportSettings({ includeSecrets: true });
  assert.equal(result.records[0].key, 'legacy-secret'); assert.equal(result.active, 'openai');
  assert.equal(state.opened, 1); assert.equal(state.writes.length, 1); assert.equal(state.writes[0].scope, 'vision');
  await provider.exportSettings(); assert.equal(state.writes.length, 1);
});
test('视觉设置导入缺省保留已有密钥，显式密钥可替换或清空，移除的提供商不残留', async () => {
  const { provider, state } = credentialHarness({ portable: portableVision('existing-secret') });
  await provider.importSettings({ active: 'openai', records: [{ provider: 'openai', model: 'gpt-5.6-luna' }] });
  assert.equal(state.portable.records[0].key, 'existing-secret'); assert.equal(state.portable.records[0].model, 'gpt-5.6-luna');
  await provider.importSettings(portableVision('replacement')); assert.equal(state.portable.records[0].key, 'replacement');
  await provider.importSettings(portableVision('')); assert.equal(state.portable.records[0].key, '');
  await provider.importSettings({ active: 'deepseek', records: [] }); assert.equal(state.portable.records.length, 0); assert.equal((await provider.exportSettings()).active, 'deepseek');
});
test('视觉导入明确关闭保留密钥时删除旧密钥；并发写入顺序确定', async () => {
  const { provider, state } = credentialHarness({ portable: portableVision('existing-secret') });
  await provider.importSettings({ active: 'openai', records: [{ provider: 'openai' }] }, { preserveKeys: false });
  assert.equal(state.portable.records[0].key, '');
  const one = provider.importSettings(portableVision('ordered-secret'));
  const two = provider.importSettings({ active: 'openai', records: [{ provider: 'openai', model: 'gpt-5.6-luna' }] });
  await Promise.all([one, two]); assert.equal(state.portable.records[0].key, 'ordered-secret'); assert.equal(state.portable.records[0].model, 'gpt-5.6-luna');
});
test('视觉设置非法或重复记录在持久化前拒绝，不覆盖已有配置', async () => {
  const { provider, state } = credentialHarness({ portable: portableVision('safe-secret') });
  for (const payload of [null, [], { active: 'unknown', records: [] }, { active: 'openai', records: [{ provider: 'openai', key: null }] }, { active: 'openai', records: [{ provider: 'openai' }, { provider: 'openai' }] }, { active: 'custom', records: [{ provider: 'custom', model: 'vl', endpoint: 'http://remote.example/v1' }] }]) await assert.rejects(provider.importSettings(payload));
  assert.equal(state.writes.length, 0); assert.equal((await provider.exportSettings({ includeSecrets: true })).records[0].key, 'safe-secret');
});
test('便携视觉写入失败不提交内存配置且允许修正后重试；迁移失败也明确拒绝', async () => {
  const { provider, state } = credentialHarness({ portable: portableVision('safe-secret'), failWrite: true });
  await assert.rejects(provider.importSettings(portableVision('failed-secret')), /尚未保存/);
  assert.equal((await provider.exportSettings({ includeSecrets: true })).records[0].key, 'safe-secret');
  state.failWrite = false; await provider.importSettings(portableVision('retry-secret')); assert.equal(state.portable.records[0].key, 'retry-secret');
  const migration = credentialHarness({ portable: null, legacy: portableVision('legacy-secret').records, active: 'openai', failWrite: true });
  await assert.rejects(migration.provider.exportSettings(), /尚未保存/); await assert.rejects(migration.provider.exportSettings(), /尚未保存/);
  assert.equal(migration.state.writes.length, 1);
});
test('损坏的便携视觉配置不静默回退旧 IDB；预览窗口不迁移也不覆盖正式 JSON', async () => {
  const corrupt = credentialHarness({ portable: { active: 'invalid', records: [] }, legacy: portableVision('old-secret').records });
  await assert.rejects(corrupt.provider.exportSettings()); assert.equal(corrupt.state.opened, 0); assert.equal(corrupt.state.writes.length, 0);
  const preview = credentialHarness({ portable: portableVision('formal-secret'), legacy: portableVision('preview-secret').records, active: 'openai', preview: true });
  assert.equal((await preview.provider.exportSettings({ includeSecrets: true })).records[0].key, 'preview-secret');
  await preview.provider.importSettings(portableVision('preview-only'));
  assert.equal(preview.state.portable.records[0].key, 'formal-secret'); assert.equal(preview.state.reads.length, 0); assert.equal(preview.state.writes.length, 0);
});
test('HTML 浏览器版视觉设置仍使用 IDB，支持导入后的完整读回与写入失败回滚', async () => {
  const { provider, state, stores } = credentialHarness({ browser: true, legacy: portableVision('browser-secret').records, active: 'openai' });
  await provider.importSettings({ active: 'openai', records: [{ provider: 'openai', model: 'gpt-5.6-luna' }] });
  assert.equal(stores.providers.get('openai').key, 'browser-secret'); assert.equal(stores.providers.get('openai').model, 'gpt-5.6-luna');
  state.failWrite = true; await assert.rejects(provider.importSettings(portableVision('failed-secret')), /保存失败/);
  assert.equal(stores.providers.get('openai').key, 'browser-secret'); assert.equal((await provider.exportSettings({ includeSecrets: true })).records[0].key, 'browser-secret');
});
test('视觉备份预检规范化与密钥合并不写入；原子恢复后可只读刷新缓存', async () => {
  const { provider, state } = credentialHarness({ portable: portableVision('existing-secret') });
  const prepared = await provider.prepareSettings({ active: 'openai', records: [{ provider: 'openai', model: 'gpt-5.6-luna' }] });
  assert.equal(prepared.records[0].key, 'existing-secret'); assert.equal(prepared.records[0].model, 'gpt-5.6-luna'); assert.equal(state.writes.length, 0);
  assert.equal((await provider.getConfig()).model, 'gpt-6-luna');
  state.portable = JSON.parse(JSON.stringify(prepared)); await provider.reloadSettings();
  assert.equal((await provider.getConfig()).model, 'gpt-5.6-luna'); assert.equal(state.writes.length, 0);
  state.portable = { active: 'bad', records: [] }; await assert.rejects(provider.reloadSettings());
  assert.equal((await provider.getConfig()).key, 'existing-secret');
});
test('损坏视觉 JSON 可在明确恢复分支预检备份，修复后重载清除失败初始化且不伪造旧密钥', async () => {
  const { provider, state } = credentialHarness({ portable: { active: 'unknown', records: [] } });
  await assert.rejects(provider.exportSettings());
  await assert.rejects(provider.prepareSettings({ active: 'openai', records: [{ provider: 'openai' }] }));
  const prepared = await provider.prepareSettings({ active: 'openai', records: [{ provider: 'openai' }] }, { allowUnavailable: true });
  assert.equal(prepared.records[0].key, ''); assert.equal(state.writes.length, 0);
  state.portable = { active: 'openai', records: [{ ...prepared.records[0], key: 'restored-secret' }] };
  await provider.reloadSettings(); assert.equal((await provider.getConfig()).key, 'restored-secret');
  assert.equal((await provider.exportSettings({ includeSecrets: true })).records[0].key, 'restored-secret');
});

const customVision = (endpoint, key) => ({ active: 'custom', records: [{ provider: 'custom', endpoint, model: 'fixture-vl', ...(key === undefined ? {} : { key }) }] });
const visionEndpoint = 'https://localhost:8443/v1/chat/completions?route=one';
const visionEndpointChanges = [
  'https://127.0.0.1:8443/v1/chat/completions?route=one',
  'https://localhost:8444/v1/chat/completions?route=one',
  'http://localhost:8443/v1/chat/completions?route=one',
  'https://localhost:8443/v2/chat/completions?route=one',
  'https://localhost:8443/v1/chat/completions?route=two',
  'https://localhost:8443/v1/chat/completions?route=one&extra=1'
];
test('自定义视觉密钥仅随同一提供商的完整规范化接口保留，预检不写入', async () => {
  for (const endpoint of visionEndpointChanges) {
    const { provider, state } = credentialHarness({ portable: customVision(visionEndpoint, 'fixture-old-key') });
    const candidate = customVision(endpoint);
    assert.equal((await provider.prepareSettings(candidate)).records[0].key, '', endpoint);
    assert.equal(state.writes.length, 0);
    assert.equal((await provider.getConfig()).key, 'fixture-old-key');
    await provider.importSettings(candidate);
    const request = provider.buildRequest(await provider.getConfig(), '合成输入', null);
    assert.equal(request.endpoint, endpoint); assert.equal(request.headers.Authorization, undefined);
  }
  const { provider, state } = credentialHarness({ portable: customVision(visionEndpoint, 'fixture-old-key') });
  const equivalent = customVision(' HTTPS://LOCALHOST:8443/v1/./chat/completions?route=one ');
  assert.equal((await provider.prepareSettings(equivalent)).records[0].key, 'fixture-old-key');
  assert.equal((await provider.prepareSettings(equivalent, { preserveKeys: false })).records[0].key, '');
  assert.equal(state.writes.length, 0);
  await provider.importSettings(equivalent); assert.equal((await provider.getConfig()).key, 'fixture-old-key');
  await provider.importSettings(customVision(visionEndpoint, '')); assert.equal((await provider.getConfig()).key, '');
  await provider.importSettings(customVision(visionEndpointChanges[0], 'fixture-new-key'));
  assert.equal(provider.buildRequest(await provider.getConfig(), '合成输入', null).headers.Authorization, 'Bearer fixture-new-key');
});
test('视觉内置接口始终固定，不同提供商即使接口相同也不借用密钥', async () => {
  const { provider, state } = credentialHarness({ portable: portableVision('fixture-old-key') });
  const endpoint = portableVision('').records[0].endpoint;
  assert.equal((await provider.prepareSettings(customVision(endpoint))).records[0].key, '');
  const pinned = await provider.prepareSettings({ active: 'openai', records: [{ provider: 'openai', endpoint: 'https://other.example/redirect' }] });
  assert.equal(pinned.records[0].endpoint, endpoint); assert.equal(pinned.records[0].key, 'fixture-old-key');
  assert.equal(state.writes.length, 0);
  await provider.importSettings(pinned);
  assert.equal(provider.buildRequest(await provider.getConfig(), '合成输入', null).endpoint, endpoint);
});
test('视觉接口拒绝全部凭据查询名及大小写变体，仍允许本机 HTTP 和普通查询', async () => {
  const { provider, state } = credentialHarness({ portable: customVision(visionEndpoint, 'fixture-old-key') });
  for (const name of ['key', 'api-key', 'api_key', 'apikey', 'x-api-key', 'x_api_key', 'token', 'access_token', 'access-token', 'authorization', 'password', 'secret']) {
    for (const variant of [name, name.toUpperCase()]) await assert.rejects(provider.prepareSettings(customVision('https://example.test/v1?' + variant + '=fixture')), /密钥请填写/);
  }
  for (const endpoint of ['https://user:pass@example.test/v1', 'https://example.test/v1#fragment', 'http://remote.example/v1']) await assert.rejects(provider.prepareSettings(customVision(endpoint)));
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const endpoint = 'http://' + host + ':8000/v1/?route=safe';
    assert.equal((await provider.prepareSettings(customVision(endpoint))).records[0].endpoint, 'http://' + host + ':8000/v1/chat/completions?route=safe');
  }
  assert.equal(state.writes.length, 0); assert.equal(state.portable.records[0].key, 'fixture-old-key');
});
test('视觉冷预检不迁移写入，取消或失败后正常读取仍迁移旧配置；恢复重载不覆盖新配置', async () => {
  const old = customVision(visionEndpoint, 'fixture-old-key');
  const { provider, state } = credentialHarness({ portable: null, legacy: old.records, active: 'custom' });
  await assert.rejects(provider.prepareSettings({ active: 'invalid', records: [] }));
  const prepared = await provider.prepareSettings(customVision(visionEndpoint));
  assert.equal(prepared.records[0].key, 'fixture-old-key'); assert.equal(state.writes.length, 0); assert.equal(state.portable, null);
  await provider.exportSettings(); assert.equal(state.writes.length, 1); assert.equal(state.portable.records[0].key, 'fixture-old-key');
  const restored = credentialHarness({ portable: null, legacy: old.records, active: 'custom' });
  await restored.provider.prepareSettings(customVision(visionEndpointChanges[0]));
  restored.state.portable = customVision(visionEndpointChanges[0], 'fixture-restored-key');
  await restored.provider.reloadSettings(); await restored.provider.exportSettings();
  assert.equal((await restored.provider.getConfig()).key, 'fixture-restored-key'); assert.equal(restored.state.writes.length, 0);
});
test('视觉表单空密码只在接口未变时保留，接口变动提示且不发送旧密钥', async () => {
  for (const endpoint of [' HTTPS://LOCALHOST:8443/v1/./chat/completions?route=one ', ...visionEndpointChanges]) {
    const { provider, state, element } = credentialHarness({ portable: customVision(visionEndpoint, 'fixture-old-key'), form: true });
    await provider.init({ mount: {} }); await provider.open();
    element('apiEndpoint').value = endpoint; await element('apiEndpoint').dispatch('input');
    const changed = endpoint !== ' HTTPS://LOCALHOST:8443/v1/./chat/completions?route=one ';
    assert.equal(element('providerEndpointHint').textContent.includes('原密钥不会沿用'), changed);
    assert.equal(element('providerEndpointHint').textContent.includes('fixture-old-key'), false);
    await element('providerForm').dispatch('submit');
    assert.equal(state.writes.length, 1); assert.equal(state.portable.records[0].key, changed ? '' : 'fixture-old-key');
  }
});
test('视觉表单写入守卫覆盖保存和清除，协调导入不受手动守卫阻拦', async () => {
  const { provider, state, element } = credentialHarness({ portable: customVision(visionEndpoint, 'fixture-old-key'), form: true });
  let allowed = false;
  await provider.init({ mount: {}, canWrite: () => allowed }); await provider.open();
  element('apiKey').value = 'fixture-manual-key';
  await element('providerForm').dispatch('submit'); await element('providerClearKeyBtn').dispatch('click');
  assert.equal(state.writes.length, 0); assert.equal(element('apiKey').value, 'fixture-manual-key');
  await provider.importSettings(customVision(visionEndpoint, 'fixture-import-key')); assert.equal(state.writes.length, 1);
  allowed = true; await element('providerClearKeyBtn').dispatch('click');
  assert.equal((await provider.getConfig()).key, ''); assert.equal(state.writes.length, 2);
  const delayed = credentialHarness({ portable: customVision(visionEndpoint, 'fixture-old-key'), form: true });
  let checks = 0; await delayed.provider.init({ mount: {}, canWrite: () => ++checks % 2 === 1 }); await delayed.provider.open();
  await delayed.element('providerForm').dispatch('submit'); await delayed.element('providerClearKeyBtn').dispatch('click');
  assert.equal(delayed.state.writes.length, 0); assert.equal(checks, 4);
});

const visionConfig = { provider: 'custom', model: 'fixture', endpoint: 'http://localhost:8000/chat/completions', key: '' };
const recognize = options => P.recognize({ config: visionConfig, prompt: '读取', imageData: null, signal: options.signal }, options);
test('响应形状错误使用格式提示，合法空结果保持空结果提示', () => {
  const invalid = [[null, 'chat'], [[], 'claude'], [{ content: {} }, 'claude'], [{ content: [null] }, 'claude'], [{ content: [{ type: 'text', text: 4 }] }, 'claude'], [{ candidates: {} }, 'gemini'], [{ candidates: [null] }, 'gemini'], [{ candidates: [{ content: { parts: [null] } }] }, 'gemini'], [{ choices: [null] }, 'chat'], [{ choices: [{ message: 3 }] }, 'chat'], [{ choices: [{ message: { content: [false] } }] }, 'chat'], [{ choices: [{ message: { content: 42 } }] }, 'chat']];
  for (const [data, protocol] of invalid) assert.throws(() => P.responseText(data, protocol), error => error.name === 'Error' && error.message === '模型响应格式无效，请检查接口协议与模型配置。');
  for (const [data, protocol] of [[{ content: [] }, 'claude'], [{ candidates: [] }, 'gemini'], [{ choices: [{ message: { content: null } }] }, 'chat']]) assert.throws(() => P.responseText(data, protocol), /没有收到文字识别结果/);
});
test('视觉读取真实分块 UTF-8 响应并按字节拒绝越限，主动 abort', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: '中文结果' } }] }));
  assert.equal(await recognize({ fetch: async () => new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 13)); c.enqueue(bytes.slice(13)); c.close(); } })) }), '中文结果');
  let signal, cancelled = false;
  await assert.rejects(recognize({ fetch: async (_, request) => { signal = request.signal; return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1024 * 1024)); c.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } }), { headers: { 'content-length': '1' } }); } }), error => error.code === 'BODY_TOO_LARGE' && !/跨域/.test(error.message));
  assert.equal(signal.aborted, true); assert.equal(cancelled, true);
});
test('视觉 deadline 和取消涵盖忽略 abort 的 fetch 与挂起 body', async () => {
  for (const body of [false, true]) {
    let signal;
    await assert.rejects(recognize({ timeoutMs: 8, fetch: async (_, request) => { signal = request.signal; return body ? new Response(new ReadableStream({ pull() { return new Promise(() => {}); } })) : new Promise(() => {}); } }), error => error.name === 'TimeoutError');
    assert.equal(signal.aborted, true);
  }
  const controller = new AbortController();
  const pending = recognize({ signal: controller.signal, fetch: async () => new Promise(() => {}) });
  controller.abort(); await assert.rejects(pending, error => error.name === 'AbortError');
});
const completeTheme = options => P.completeTheme('请生成主题', { config: visionConfig, ...options });
test('主题生成只发送文字提示词并返回模型文本', async () => {
  let captured;
  const text = await completeTheme({
    fetch: async (url, init) => {
      captured = { url, init };
      return new Response('{"choices":[{"message":{"content":"{\\"theme\\":\\"dark\\"}"}}]}');
    }
  });
  assert.equal(text, '{"theme":"dark"}');
  const body = JSON.parse(captured.init.body);
  assert.deepEqual(body.messages, [{ role: 'user', content: '请生成主题' }]);
  assert.equal(JSON.stringify(body).includes('image_url'), false);
  assert.equal(JSON.stringify(body).includes('inlineData'), false);
  assert.equal(JSON.stringify(body).includes('base64'), false);
});
test('主题生成超时与取消使用主题文案', async () => {
  await assert.rejects(completeTheme({ timeoutMs: 8, fetch: async () => new Promise(() => {}) }),
    error => error.name === 'TimeoutError' && /主题生成超时/.test(error.message));
  const controller = new AbortController();
  const pending = completeTheme({ signal: controller.signal, fetch: async () => new Promise(() => {}) });
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError' && /主题生成已取消/.test(error.message));
});
test('主题空结果使用主题文案而不是图片识别文案', async () => {
  await assert.rejects(completeTheme({ fetch: async () => new Response('{"choices":[{"message":{"content":""}}]}') }),
    /没有收到主题结果/);
});
test('视觉 fetch 连接错误与解析格式错误不混淆', async () => {
  await assert.rejects(recognize({ fetch: async () => { throw new TypeError('fixture'); } }), /跨域/);
  await assert.rejects(recognize({ fetch: async () => new Response('{') }), /有效的 JSON/);
  await assert.rejects(recognize({ fetch: async () => new Response('{"choices":[null]}') }), /模型响应格式无效/);
});

test('视觉便携选择只由桥接 preview 决定，不受 URL 查询修改影响', async () => {
  const preview = credentialHarness({ portable: portableVision('formal'), legacy: portableVision('isolated').records, active: 'openai', preview: true });
  preview.window.location.href = 'file:///SlateRandom/index.html';
  assert.equal((await preview.provider.exportSettings({ includeSecrets: true })).records[0].key, 'isolated');
  assert.equal(preview.state.reads.length, 0);
  const main = credentialHarness({ portable: portableVision('formal') });
  main.window.location.href = 'file:///SlateRandom/index.html?slatePreview=true';
  assert.equal((await main.provider.exportSettings({ includeSecrets: true })).records[0].key, 'formal');
  assert.equal(main.state.opened, 0);
});
test('视觉上限按 UTF-8 字节而不是字符串字符数计算', async () => {
  const prefix = '{"choices":[{"message":{"content":"', suffix = '"}}]}';
  const count = Math.floor((1024 * 1024 - Buffer.byteLength(prefix + suffix)) / 3);
  const text = '中'.repeat(count);
  assert.equal(await recognize({ fetch: async () => new Response(prefix + text + suffix) }), text);
  await assert.rejects(recognize({ fetch: async () => new Response(prefix + text + '中文' + suffix) }), error => error.code === 'BODY_TOO_LARGE');
});
