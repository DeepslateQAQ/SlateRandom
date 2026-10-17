(function () {
  'use strict';
  // The desktop keeps credentials in portable JSON; the HTML edition uses IndexedDB.
  const presets = Object.freeze([
    { id: 'deepseek', name: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions', protocol: 'chat', models: ['deepseek-flash'] },
    { id: 'kimi', name: 'Kimi', endpoint: 'https://api.moonshot.cn/v1/chat/completions', protocol: 'chat', models: ['kimi-k3', 'kimi-k2.6'] },
    { id: 'mimo', name: 'Xiaomi MiMo', endpoint: 'https://api.xiaomimimo.com/v1/chat/completions', protocol: 'chat', models: ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed', 'mimo-v2.5'] },
    { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', protocol: 'chat', models: ['gpt-6-luna', 'gpt-5.6-luna'] },
    { id: 'claude', name: 'Anthropic Claude', endpoint: 'https://api.anthropic.com/v1/messages', protocol: 'claude', models: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-4-6'] },
    { id: 'gemini', name: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/', protocol: 'gemini', models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'] },
    { id: 'custom', name: '自定义 OpenAI 兼容', endpoint: '', protocol: 'chat', models: [] }
  ].map(p => Object.freeze({ ...p, models: Object.freeze(p.models) })));
  const $ = id => document.getElementById(id);
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const symbol = name => '<span class="icon material-icon" aria-hidden="true">' + name + '</span>';
  let database, ready, storageReady, portableStorage, writeQueue = Promise.resolve(), databaseError = '', active = 'deepseek', records = new Map(), selected = active, saving = false, notify = () => {};
  let migrationPending = false, migrationReady;
  function definition(id) { const preset = presets.find(p => p.id === id); if (!preset) throw new Error('请选择可用的提供商。'); return preset; }
  function endpointURL(value) {
    let url; try { url = new URL(value.trim()); } catch (_) { throw new Error('请输入完整、有效的接口地址。'); }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('接口需使用 HTTPS；本机转发服务可使用 HTTP。');
    if (url.username || url.password || url.hash) throw new Error('接口地址不能包含账号、密码或片段。');
    for (const key of url.searchParams.keys()) if (/^(key|api[-_]?key|x(?:-api-key|_api_key)|token|access[-_]token|authorization|password|secret)$/i.test(key)) throw new Error('密钥请填写在 API 密钥栏中。');
    if (/\/(v1|v1beta)\/?$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/$/, '') + '/chat/completions';
    return url.href;
  }
  function normalize(record) {
    const preset = definition(record.provider), custom = preset.id === 'custom';
    const model = String(record.model || preset.models[0] || '').trim(), key = String(record.key || '').trim();
    if (!model || model.length > 160 || /[\r\n\u0000]/.test(model)) throw new Error('请填写有效的模型名称。');
    if (!custom && !preset.models.includes(model)) throw new Error('请选择此提供商的模型。');
    if (key.length > 4096 || /[\r\n\u0000]/.test(key)) throw new Error('API 密钥格式无效。');
    return { provider: preset.id, model, key, endpoint: custom ? endpointURL(record.endpoint || '') : preset.endpoint };
  }
  function portableBridge() {
    const bridge = window.slateDesktop;
    if (bridge?.role !== 'main' || bridge.data?.preview === true) return null;
    if (typeof bridge.data?.readCredentials !== 'function' || typeof bridge.data?.writeCredentials !== 'function') throw new Error('便携提供商存储不可用，请更新桌面程序后重试。');
    return bridge.data;
  }
  function snapshot(includeSecrets = true, source = records, provider = active) {
    return { active: provider, records: Array.from(source.values(), record => {
      const clean = { ...record }; if (!includeSecrets) delete clean.key; return clean;
    }) };
  }
  function validateSettings(payload, preserveKeys = true) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.records) || payload.records.length > presets.length) throw new Error('提供商设置文件格式无效。');
    definition(payload.active);
    const next = new Map();
    for (const record of payload.records) {
      if (!record || typeof record !== 'object' || Array.isArray(record) || next.has(record.provider)) throw new Error('提供商设置存在重复或无效记录。');
      const hasKey = Object.prototype.hasOwnProperty.call(record, 'key');
      if (hasKey && typeof record.key !== 'string') throw new Error('API 密钥格式无效。');
      const clean = normalize({ ...record, key: hasKey ? record.key : '' }), previous = records.get(clean.provider);
      if (!hasKey && preserveKeys && previous?.endpoint === clean.endpoint) clean.key = previous.key;
      next.set(clean.provider, clean);
    }
    return { records: next, active: payload.active };
  }
  async function ensureStorage({ readOnly = false } = {}) {
    if (!storageReady) storageReady = (async () => {
      portableStorage = portableBridge();
      if (portableStorage) {
        const payload = await portableStorage.readCredentials('vision');
        if (payload !== null) {
          const clean = validateSettings(payload, false); records = clean.records; active = clean.active; return;
        }
      }
      database = await openDatabase();
      try {
        await loadRecords();
        migrationPending = !!portableStorage;
      } finally { if (portableStorage) { database.close(); database = undefined; } }
    })();
    await storageReady;
    if (migrationPending && !readOnly && !migrationReady) migrationReady = portableStorage.writeCredentials('vision', snapshot()).then(() => { migrationPending = false; });
    if (migrationReady) await migrationReady;
  }
  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('当前浏览器无法使用本机数据库，提供商设置尚未保存。')); return; }
      let request, finished = false;
      const fail = () => { if (finished) return; finished = true; clearTimeout(timer); reject(new Error('无法打开本机数据库，请允许此页面使用浏览器存储后重试。')); };
      const timer = setTimeout(fail, 5000);
      try { request = indexedDB.open('rollcall-studio:providers', 1); } catch (_) { fail(); return; }
      request.onupgradeneeded = () => { const db = request.result; db.createObjectStore('providers', { keyPath: 'provider' }); db.createObjectStore('preferences', { keyPath: 'id' }); };
      request.onerror = fail; request.onblocked = fail;
      request.onsuccess = () => {
        if (finished) { request.result.close(); return; }
        finished = true; clearTimeout(timer); const db = request.result;
        db.onversionchange = () => { db.close(); databaseError = '提供商数据库已更新，请刷新页面。'; refreshSummary(); };
        resolve(db);
      };
    });
  }
  function loadRecords() {
    return new Promise((resolve, reject) => {
      const tx = database.transaction(['providers', 'preferences'], 'readonly');
      const all = tx.objectStore('providers').getAll(), preference = tx.objectStore('preferences').get('active');
      tx.oncomplete = () => {
        records = new Map();
        for (const record of all.result) try { const clean = normalize(record); records.set(clean.provider, clean); } catch (_) { /* Ignore an invalid individual setting. */ }
        active = presets.some(p => p.id === preference.result?.provider) ? preference.result.provider : 'deepseek'; resolve();
      };
      tx.onerror = tx.onabort = () => reject(new Error('无法读取已保存的提供商设置，请重试。'));
    });
  }
  async function saveSnapshot(next, nextActive) {
    if (portableStorage) await portableStorage.writeCredentials('vision', snapshot(true, next, nextActive));
    else await new Promise((resolve, reject) => {
      let tx; try { tx = database.transaction(['providers', 'preferences'], 'readwrite'); } catch (_) { reject(new Error('本机数据库不可用，设置尚未保存。')); return; }
      tx.objectStore('providers').clear();
      for (const record of next.values()) tx.objectStore('providers').put(record);
      tx.objectStore('preferences').put({ id: 'active', provider: nextActive });
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new Error('保存失败，提供商设置尚未写入本机数据库。'));
    });
    records = next; active = nextActive; refreshSummary();
  }
  function enqueueWrite(action) {
    const result = writeQueue.then(action, action); writeQueue = result.catch(() => {}); return result;
  }
  function persist(record, makeActive, canWrite) {
    return enqueueWrite(async () => {
      if (!canWrite()) return false;
      await ensureStorage();
      if (!canWrite()) return false;
      const next = new Map(records); next.set(record.provider, record);
      await saveSnapshot(next, makeActive ? record.provider : active);
      return true;
    });
  }
  async function exportSettings({ includeSecrets = false } = {}) {
    await ensureStorage(); await writeQueue;
    if (databaseError) throw new Error(databaseError);
    return snapshot(includeSecrets === true);
  }
  function importSettings(payload, { preserveKeys = true } = {}) {
    return enqueueWrite(async () => {
      await ensureStorage();
      if (databaseError) throw new Error(databaseError);
      const clean = validateSettings(payload, preserveKeys !== false);
      await saveSnapshot(clean.records, clean.active);
    });
  }
  async function prepareSettings(payload, { preserveKeys = true, allowUnavailable = false } = {}) {
    let unavailable = false;
    try { await ensureStorage({ readOnly: true }); }
    catch (error) { if (!allowUnavailable || !portableStorage) throw error; unavailable = true; }
    await writeQueue;
    if (databaseError && !unavailable) throw new Error(databaseError);
    const clean = validateSettings(payload, preserveKeys !== false && !unavailable);
    return snapshot(true, clean.records, clean.active);
  }
  async function reloadSettings() {
    let initializationError;
    try { await ensureStorage({ readOnly: true }); } catch (error) { initializationError = error; }
    await writeQueue;
    if (portableStorage) {
      const clean = validateSettings(await portableStorage.readCredentials('vision'), false);
      records = clean.records; active = clean.active;
      migrationPending = false; migrationReady = undefined;
    } else { if (initializationError) throw initializationError; await loadRecords(); }
    databaseError = ''; storageReady = Promise.resolve();
    refreshSummary();
  }
  function configuration(id = active) {
    const preset = definition(id), saved = records.get(id);
    return saved ? { ...saved } : { provider: id, endpoint: preset.endpoint, model: preset.models[0] || '', key: '' };
  }
  function refreshSummary() {
    const preset = definition(active), saved = records.get(active);
    const description = databaseError || preset.name + ' · ' + (saved?.model || preset.models[0] || '未设置模型') + (saved?.key ? ' · 密钥已保存' : preset.id === 'custom' && saved ? ' · 已配置接口' : ' · 待配置密钥');
    if ($('providerSummary')) $('providerSummary').textContent = description;
    if ($('visionProviderSummary')) $('visionProviderSummary').textContent = description;
  }
  function renderForm() {
    const preset = definition(selected), saved = configuration(selected), custom = selected === 'custom';
    $('providerPreset').value = selected;
    $('providerModelSelect').innerHTML = preset.models.map(model => '<option value="' + esc(model) + '">' + esc(model) + (model === 'gpt-6-luna' || model === 'gpt-5.6-luna' ? ' · 推荐' : '') + '</option>').join('');
    $('providerModelSelect').value = saved.model; $('providerModelField').hidden = custom; $('providerModelSelect').disabled = preset.models.length < 2;
    $('providerCustomFields').hidden = !custom; $('apiEndpoint').value = saved.endpoint; $('apiModel').value = saved.model;
    $('apiKey').value = '';
    refreshEndpointHint();
    $('providerClearKeyBtn').disabled = !saved.key;
    $('providerError').textContent = databaseError;
  }
  function refreshEndpointHint() {
    const saved = configuration(selected), preset = definition(selected), custom = selected === 'custom';
    let changed = false;
    if (custom && saved.key) {
      try { changed = endpointURL($('apiEndpoint').value) !== saved.endpoint; } catch (_) { changed = true; }
    }
    $('apiKey').placeholder = changed ? '接口已更改；请重新填写，免密代理可留空' : saved.key ? '已保存；留空保留，输入新密钥可替换' : custom ? '代理免密时可留空' : '填入此提供商的 API 密钥';
    $('providerEndpointHint').textContent = changed ? '接口已更改；原密钥不会沿用。请重新填写，免密代理可留空。' : custom ? '填写 Chat Completions 接口；图片识别需要模型支持图片输入。' : '接口已预设：' + preset.endpoint;
  }
  async function open() {
    await ready; selected = active; renderForm(); return window.DialogTransitions.open($('providerDialog'));
  }
  async function getConfig() {
    await ready;
    if (storageReady) await storageReady;
    if (migrationReady) await migrationReady;
    if (databaseError) throw new Error(databaseError);
    const config = normalize(configuration());
    if (!config.key && config.provider !== 'custom') throw new Error('请在提供商设置中保存 API 密钥。');
    return config;
  }
  function lockForm(value) {
    saving = value;
    ['providerPreset', 'providerSaveBtn', 'apiKey', 'apiEndpoint', 'apiModel'].forEach(id => $(id).disabled = value);
    $('providerModelSelect').disabled = value || definition(selected).models.length < 2;
    $('providerClearKeyBtn').disabled = value || !configuration(selected).key;
  }
  async function init({ mount, toast, canWrite = () => true } = {}) {
    if (ready) return ready;
    notify = toast || (() => {});
    mount.innerHTML = '<div class="provider-toolbar"><button type="button" id="providerSettingsBtn" class="btn btn-plain">' + symbol('tune') + '提供商设置</button><span id="providerSummary" class="field-hint" role="status">正在读取提供商设置…</span></div>';
    const dialog = document.createElement('dialog'); dialog.id = 'providerDialog'; dialog.className = 'dialog provider-dialog'; dialog.setAttribute('aria-labelledby', 'providerTitle');
    dialog.innerHTML = '<form id="providerForm"><div class="dialog-heading"><div><span class="eyebrow">AI 服务</span><h2 id="providerTitle">提供商设置</h2></div><button type="button" class="icon-btn" data-provider-close aria-label="关闭提供商设置">' + symbol('close') + '</button></div><div class="dialog-body"><label>提供商<select id="providerPreset">' + presets.map(p => '<option value="' + p.id + '">' + esc(p.name) + '</option>').join('') + '</select></label><label id="providerModelField">模型<select id="providerModelSelect"></select></label><div id="providerCustomFields"><label>完整请求地址<input id="apiEndpoint" type="url" placeholder="https://服务地址/v1/chat/completions" autocomplete="off"></label><label>模型名称<input id="apiModel" placeholder="模型 ID（图片识别需要支持图片输入）" maxlength="160" autocomplete="off"></label></div><label>API 密钥<input id="apiKey" type="password" maxlength="4096" autocomplete="off" data-lpignore="true"></label><p id="providerEndpointHint" class="field-hint"></p><p class="field-hint">桌面版配置与密钥保存在 data/settings.json；Lite HTML 版保存在当前浏览器的 IndexedDB。设置导出默认不含密钥，完整备份可按需包含。包含密钥的备份不受密码保护，请勿公开分享。</p><button type="button" id="providerClearKeyBtn" class="text-btn danger-text">' + symbol('close') + '移除此提供商密钥</button><p id="providerError" class="error-message" role="alert"></p></div><div class="dialog-footer"><button type="button" class="btn btn-plain" data-provider-close>取消</button><button type="submit" id="providerSaveBtn" class="btn btn-primary">保存提供商' + symbol('check') + '</button></div></form>';
    document.body.appendChild(dialog);
    dialog.insertAdjacentHTML('afterbegin', '<div class="modal-toast-wrap"><div class="toast" data-toast-host role="status" aria-live="polite" aria-atomic="true" hidden></div></div>');
    $('providerSettingsBtn').addEventListener('click', open);
    dialog.querySelectorAll('[data-provider-close]').forEach(button => button.addEventListener('click', () => { if (!saving) window.DialogTransitions.close(dialog); }));
    dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
    dialog.addEventListener('close', () => { $('apiKey').value = ''; });
    $('providerPreset').addEventListener('change', () => { selected = $('providerPreset').value; renderForm(); });
    $('apiEndpoint').addEventListener('input', refreshEndpointHint);
    $('providerForm').addEventListener('submit', async event => {
      event.preventDefault(); if (saving || !canWrite()) return; $('providerError').textContent = '';
      try {
        await ready; if (databaseError) throw new Error(databaseError);
        const previous = configuration(selected);
        const config = normalize({ provider: selected, model: selected === 'custom' ? $('apiModel').value : $('providerModelSelect').value, endpoint: $('apiEndpoint').value, key: $('apiKey').value });
        if (!config.key && previous.endpoint === config.endpoint) config.key = previous.key;
        if (!config.key && selected !== 'custom') throw new Error('请填写此提供商的 API 密钥。');
        if (!canWrite()) return;
        lockForm(true); if (!await persist(config, true, canWrite)) return; $('apiKey').value = ''; await window.DialogTransitions.close(dialog); notify(portableStorage ? '提供商设置与密钥已保存到 data/settings.json。' : '提供商设置与密钥已保存到当前浏览器的 IndexedDB。');
      } catch (error) { $('providerError').textContent = error.message; }
      finally { lockForm(false); }
    });
    $('providerClearKeyBtn').addEventListener('click', async () => {
      if (saving || !canWrite()) return;
      try { await ready; if (databaseError) throw new Error(databaseError); if (!canWrite()) return; lockForm(true); if (!await persist({ ...configuration(selected), key: '' }, false, canWrite)) return; renderForm(); notify('已移除此提供商的 API 密钥。'); }
      catch (error) { $('providerError').textContent = error.message; }
      finally { lockForm(false); }
    });
    window.DialogTransitions.register(dialog, { canClose: () => !saving });
    ready = (async () => { try { await ensureStorage(); } catch (error) { databaseError = error.message; notify(databaseError); } refreshSummary(); })();
    return ready;
  }
  function buildRequest(config, prompt, imageData) {
    const preset = definition(config.provider), hasImage = imageData != null && imageData !== '';
    const match = hasImage && /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(imageData);
    if (hasImage && !match) throw new Error('图片内容无效，请重新选择 PNG、JPG 或 WebP 图片。');
    const headers = { 'Content-Type': 'application/json' }; let endpoint = config.endpoint, body;
    if (preset.protocol === 'claude') {
      headers['x-api-key'] = config.key; headers['anthropic-version'] = '2023-06-01'; headers['anthropic-dangerous-direct-browser-access'] = 'true';
      body = { model: config.model, max_tokens: 8192, stream: false, messages: [{ role: 'user', content: [...(hasImage ? [{ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }] : []), { type: 'text', text: prompt }] }] };
    } else if (preset.protocol === 'gemini') {
      headers['x-goog-api-key'] = config.key; endpoint += encodeURIComponent(config.model) + ':generateContent';
      body = { contents: [{ role: 'user', parts: [...(hasImage ? [{ inlineData: { mimeType: match[1], data: match[2] } }] : []), { text: prompt }] }], generationConfig: { maxOutputTokens: 8192, responseMimeType: 'application/json' } };
    } else {
      if (config.key) headers.Authorization = 'Bearer ' + config.key;
      body = { model: config.model, stream: false, messages: [{ role: 'user', content: hasImage ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageData } }] : prompt }] };
      if (config.provider === 'openai') body.reasoning_effort = 'low';
    }
    return { endpoint, headers, body, protocol: preset.protocol };
  }
  function responseText(data, protocol, emptyMessage = '没有收到文字识别结果，请检查视觉模型与接口配置。') {
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const invalid = () => { throw new Error('模型响应格式无效，请检查接口协议与模型配置。'); };
    const blocks = (value, gemini = false) => {
      if (!Array.isArray(value)) return invalid();
      return value.map(part => {
        if (!object(part) || (part.type !== undefined && typeof part.type !== 'string') || (part.text !== undefined && typeof part.text !== 'string') || (gemini && part.thought !== undefined && typeof part.thought !== 'boolean')) return invalid();
        if (!gemini && typeof part.type !== 'string') return invalid();
        if (!gemini && part.type === 'text' && typeof part.text !== 'string') return invalid();
        return (gemini ? !part.thought : part.type === 'text') && typeof part.text === 'string' ? part.text : '';
      }).filter(Boolean).join('\n');
    };
    if (!object(data)) return invalid();
    let content;
    if (protocol === 'claude') {
      if (data.content !== undefined) content = blocks(data.content);
    } else if (protocol === 'gemini') {
      if (data.candidates !== undefined) {
        if (!Array.isArray(data.candidates) || data.candidates.some(candidate => !object(candidate))) return invalid();
        for (const [index, candidate] of data.candidates.entries()) {
          if (candidate.content !== undefined && !object(candidate.content)) return invalid();
          if (candidate.content?.parts !== undefined) { const text = blocks(candidate.content.parts, true); if (index === 0) content = text; }
        }
      }
    } else if (data.choices !== undefined) {
      if (!Array.isArray(data.choices) || data.choices.some(choice => !object(choice))) return invalid();
      for (const [index, choice] of data.choices.entries()) {
        if (choice.message !== undefined && !object(choice.message)) return invalid();
        const value = choice.message?.content;
        if (value !== undefined && value !== null && typeof value !== 'string' && !Array.isArray(value)) return invalid();
        const text = Array.isArray(value) ? blocks(value) : value;
        if (index === 0) content = text;
      }
    }
    if (typeof content !== 'string' || !content.trim()) throw new Error(emptyMessage);
    return content;
  }
  const TASK_COPY = {
    recognize: { cancel: '图片识别已取消。', timeout: '图片识别超时，请稍后重试。', empty: '没有收到文字识别结果，请检查视觉模型与接口配置。', network: '无法连接模型服务，请检查网络和接口的浏览器跨域设置。' },
    theme: { cancel: '主题生成已取消。', timeout: '主题生成超时，请稍后重试。', empty: '没有收到主题结果，请检查模型与接口配置。', network: '无法连接 AI 服务，请检查网络和接口的浏览器跨域设置。' }
  };
  async function requestText({ prompt, imageData, signal, config, task = 'recognize' }, options = {}) {
    const copy = TASK_COPY[task] || TASK_COPY.recognize;
    const controller = new AbortController();
    let timer, rejectCancel;
    const cancelled = new Promise((_, reject) => { rejectCancel = reject; });
    const abort = () => { const error = new Error(copy.cancel); error.name = 'AbortError'; controller.abort(error); rejectCancel(error); };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { const error = new Error(copy.timeout); error.name = 'TimeoutError'; controller.abort(error); rejectCancel(error); }, Math.max(1, Number(options.timeoutMs) || 90000));
    const network = (async () => {
      const request = buildRequest(config || await getConfig(), prompt, imageData);
      if (controller.signal.aborted) throw controller.signal.reason;
      const requestFetch = options.fetch || window.fetch?.bind(window) || globalThis.fetch;
      let response;
      try { response = await requestFetch(request.endpoint, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: controller.signal, credentials: 'omit', redirect: 'error' }); }
      catch (error) { if (error?.name === 'TypeError') throw new Error(copy.network); throw error; }
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!response.ok) throw new Error('模型服务返回 HTTP ' + response.status + '，请检查密钥、模型或账户额度。');
      const bytes = await window.ProviderTransport.readBoundedBody(response, { maxBytes: 1024 * 1024, signal: controller.signal });
      let data; try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { throw new Error('模型接口没有返回有效的 JSON 响应。'); }
      return responseText(data, request.protocol, copy.empty);
    })();
    try { return await Promise.race([network, cancelled]); }
    catch (error) { if (error?.code === 'BODY_TOO_LARGE') { controller.abort(error); error.message = '模型响应过大，请检查接口配置。'; } throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function recognize({ prompt, imageData, signal, config }, options = {}) {
    return requestText({ prompt, imageData, signal, config, task: 'recognize' }, options);
  }
  async function completeTheme(prompt, options = {}) {
    return requestText({ prompt, imageData: null, signal: options.signal, config: options.config, task: 'theme' }, options);
  }
  window.VisionProviders = { init, open, getConfig, recognize, completeTheme, exportSettings, importSettings, prepareSettings, reloadSettings, presets, buildRequest, responseText };
})();
