/* TTS credentials use portable desktop JSON or the HTML edition's IndexedDB. */
(function () {
  'use strict';
  const voices = Object.freeze([
    { id: '茉莉', name: '茉莉 · 中文' }, { id: '冰糖', name: '冰糖 · 中文' },
    { id: '苏打', name: '苏打 · 中文' }, { id: '白桦', name: '白桦 · 中文' },
    { id: 'mimo_default', name: 'MiMo 默认' }, { id: 'Mia', name: 'Mia · 英文' },
    { id: 'Chloe', name: 'Chloe · 英文' }, { id: 'Milo', name: 'Milo · 英文' }, { id: 'Dean', name: 'Dean · 英文' }
  ].map(voice => Object.freeze(voice)));
  const presets = Object.freeze([
    { id: 'system', name: window.slateDesktop?.role === 'main' ? '桌面 Edge 在线合成' : '浏览器设备朗读', endpoint: '', model: '', voice: '', protocol: 'system' },
    { id: 'mimo', name: 'Xiaomi MiMo', endpoint: 'https://api.xiaomimimo.com/v1/chat/completions', model: 'mimo-v2.5-tts', voice: '茉莉', protocol: 'mimo' },
    { id: 'custom', name: '自定义兼容 TTS／EdgeTTS 代理', endpoint: '', model: 'tts-1', voice: 'alloy', protocol: 'speech' }
  ].map(preset => Object.freeze(preset)));
  const $ = id => document.getElementById(id);
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const icon = name => '<span class="icon material-icon" aria-hidden="true">' + name + '</span>';
  const MAX_AUDIO = 16 * 1024 * 1024;
  let database = null, ready = null, storageReady = null, portableStorage = null, writeQueue = Promise.resolve(), databaseError = '', records = new Map(), active = 'system', selected = 'system';
  let saving = false, notify = () => {}, run = null, generation = 0;
  let migrationPending = false, migrationReady;

  function definition(id) {
    const preset = presets.find(value => value.id === id);
    if (!preset) throw new Error('请选择可用的朗读提供商。');
    return preset;
  }
  function field(value, label, maximum = 160) {
    const clean = String(value ?? '').trim();
    if (!clean || clean.length > maximum || /[\u0000-\u001f\u007f]/.test(clean)) throw new Error('请填写有效的' + label + '。');
    return clean;
  }
  function endpointURL(value) {
    let url;
    try { url = new URL(String(value || '').trim()); } catch (_) { throw new Error('请填写完整、有效的语音接口地址。'); }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('语音接口需使用 HTTPS；本机代理可使用 HTTP。');
    if (url.username || url.password || url.hash) throw new Error('接口地址不能包含账号、密码或片段。');
    for (const name of url.searchParams.keys()) if (/^(key|api[-_]?key|x(?:-api-key|_api_key)|token|access[-_]token|authorization|password|secret)$/i.test(name)) throw new Error('密钥请填写在 API 密钥栏中。');
    if (/\/v1\/?$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/$/, '') + '/audio/speech';
    return url.href;
  }
  function normalize(record = {}) {
    const preset = definition(record.provider || 'system');
    if (preset.id === 'system') return { provider: 'system', endpoint: '', model: '', voice: '', key: '', fallback: false };
    const key = String(record.key || '').trim();
    if (key.length > 4096 || /[\u0000-\u001f\u007f]/.test(key)) throw new Error('API 密钥格式无效。');
    const voice = field(record.voice || preset.voice, '音色');
    if (preset.id === 'mimo' && !voices.some(value => value.id === voice)) throw new Error('请选择 MiMo 的预置音色。');
    const model = preset.id === 'mimo' ? preset.model : field(record.model || preset.model, '语音模型');
    return { provider: preset.id, endpoint: preset.id === 'mimo' ? preset.endpoint : endpointURL(record.endpoint), model, voice, key, fallback: record.fallback === true };
  }
  function configuration(id = active) {
    const preset = definition(id);
    return { ...(records.get(id) || { provider: id, endpoint: preset.endpoint, model: preset.model, voice: preset.voice, key: '', fallback: false }) };
  }
  function portableBridge() {
    const bridge = window.slateDesktop;
    if (bridge?.role !== 'main' || bridge.data?.preview === true) return null;
    if (typeof bridge.data?.readCredentials !== 'function' || typeof bridge.data?.writeCredentials !== 'function') throw new Error('便携朗读存储不可用，请更新桌面程序后重试。');
    return bridge.data;
  }
  function snapshot(includeSecrets = true, source = records, provider = active) {
    return { active: provider, records: Array.from(source.values(), record => {
      const clean = { ...record }; if (!includeSecrets) delete clean.key; return clean;
    }) };
  }
  function validateSettings(payload, preserveKeys = true) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.records) || payload.records.length > presets.length) throw new Error('朗读设置文件格式无效。');
    definition(payload.active);
    const next = new Map();
    for (const record of payload.records) {
      if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.provider !== 'string' || next.has(record.provider)) throw new Error('朗读设置存在重复或无效记录。');
      const hasKey = Object.prototype.hasOwnProperty.call(record, 'key');
      if (hasKey && typeof record.key !== 'string') throw new Error('API 密钥格式无效。');
      const clean = normalize({ ...record, key: hasKey ? record.key : '' }), previous = records.get(clean.provider);
      if (!hasKey && preserveKeys && previous?.endpoint === clean.endpoint) clean.key = previous.key;
      next.set(clean.provider, clean);
    }
    if (payload.active !== 'system' && !next.has(payload.active)) throw new Error('朗读设置缺少当前提供商配置。');
    return { records: next, active: payload.active };
  }
  async function ensureStorage({ readOnly = false } = {}) {
    if (!storageReady) storageReady = (async () => {
      portableStorage = portableBridge();
      if (portableStorage) {
        const payload = await portableStorage.readCredentials('speech');
        if (payload !== null) {
          const clean = validateSettings(payload, false); records = clean.records; active = clean.active; return;
        }
      }
      database = await openDatabase();
      try {
        await loadRecords();
        migrationPending = !!portableStorage;
      } finally { if (portableStorage) { database.close(); database = null; } }
    })();
    await storageReady;
    if (migrationPending && !readOnly && !migrationReady) migrationReady = portableStorage.writeCredentials('speech', snapshot()).then(() => { migrationPending = false; });
    if (migrationReady) await migrationReady;
  }
  function buildRequest(config, name) {
    const clean = normalize(config), text = field(name, '姓名', 200);
    if (clean.provider === 'system') throw new Error('系统朗读无需网络请求。');
    if (clean.provider === 'mimo' && !clean.key) throw new Error('请在朗读设置中保存 MiMo API 密钥。');
    const headers = { 'Content-Type': 'application/json' };
    if (clean.key) headers.Authorization = 'Bearer ' + clean.key;
    const body = clean.provider === 'mimo' ? {
      model: clean.model, stream: false, messages: [{ role: 'assistant', content: text }], audio: { format: 'wav', voice: clean.voice }
    } : { model: clean.model, input: text, voice: clean.voice, response_format: 'mp3' };
    return { endpoint: clean.endpoint, headers, body, protocol: definition(clean.provider).protocol };
  }
  function responseAudio(data) {
    const encoded = data?.choices?.[0]?.message?.audio?.data;
    if (typeof encoded !== 'string' || !encoded || encoded.length > Math.ceil(MAX_AUDIO * 4 / 3) + 1024) throw new Error('MiMo 没有返回有效的姓名音频。');
    const clean = encoded.replace(/\s/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) throw new Error('MiMo 返回的音频编码无效。');
    let decoded;
    try { decoded = atob(clean); } catch (_) { throw new Error('MiMo 返回的音频编码无效。'); }
    if (!decoded.length || decoded.length > MAX_AUDIO) throw new Error('MiMo 返回的音频大小无效。');
    const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
    if (decoded.slice(0, 4) !== 'RIFF' || decoded.slice(8, 12) !== 'WAVE') throw new Error('MiMo 未返回预期的 WAV 音频。');
    return new Blob([bytes], { type: 'audio/wav' });
  }
  function abortError() {
    const error = new Error('姓名朗读已取消。'); error.name = 'AbortError'; return error;
  }
  async function requestAudio(config, name, options = {}) {
    const request = buildRequest(config, name), controller = new AbortController();
    const requestFetch = options.fetch || window.fetch?.bind(window) || globalThis.fetch;
    if (typeof requestFetch !== 'function') throw new Error('当前浏览器无法请求语音服务。');
    if (options.signal?.aborted) throw abortError();
    let timer, rejectCancel, timedOut = false;
    const cancelled = new Promise((_, reject) => { rejectCancel = reject; });
    const abort = () => { controller.abort(); rejectCancel(abortError()); };
    options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true; controller.abort(); reject(new Error('语音合成超时，请稍后重试。'));
      }, Math.max(1, Number(options.timeoutMs) || 20000));
    });
    const network = (async () => {
      let response;
      try {
        response = await requestFetch(request.endpoint, {
          method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: controller.signal,
          credentials: 'omit', cache: 'no-store', redirect: 'error'
        });
      } catch (error) { if (error?.name === 'TypeError') throw new Error('无法连接语音服务，请检查网络和接口的浏览器跨域设置。'); throw error; }
      if (controller.signal.aborted) throw abortError();
      if (!response.ok) {
        if ([401, 403].includes(response.status)) throw new Error('语音服务认证失败，请检查 API 密钥。');
        if (response.status === 429) throw new Error('语音服务暂时限流，请稍后重试。');
        throw new Error('语音服务请求失败（HTTP ' + response.status + '）。');
      }
      if (request.protocol === 'mimo') {
        const bytes = await window.ProviderTransport.readBoundedBody(response, { maxBytes: 24 * 1024 * 1024, signal: controller.signal });
        return responseAudio(JSON.parse(new TextDecoder().decode(bytes)));
      }
      const contentType = String(response.headers?.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (contentType && !contentType.startsWith('audio/') && contentType !== 'application/octet-stream') throw new Error('语音接口未返回音频文件，请检查兼容协议。');
      const bytes = await window.ProviderTransport.readBoundedBody(response, { maxBytes: MAX_AUDIO, signal: controller.signal });
      if (!bytes.byteLength) throw new Error('语音接口返回的音频大小无效。');
      return new Blob([bytes], { type: contentType.startsWith('audio/') ? contentType : 'audio/mpeg' });
    })();
    try { return await Promise.race([network, timeout, cancelled]); }
    catch (error) {
      if (timedOut) throw new Error('语音合成超时，请稍后重试。');
      if (options.signal?.aborted) throw abortError();
      if (error?.code === 'BODY_TOO_LARGE') { controller.abort(error); error.message = '语音接口返回的音频响应过大。'; throw error; }
      if (error?.name === 'SyntaxError') throw new Error('语音服务返回的内容无效。');
      throw error;
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    }
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('无法使用本机数据库，远程朗读配置尚未保存。')); return; }
      let request, finished = false;
      const fail = () => { if (finished) return; finished = true; clearTimeout(timer); reject(new Error('无法打开朗读设置数据库，请允许浏览器存储后重试。')); };
      const timer = setTimeout(fail, 5000);
      try { request = window.indexedDB.open('rollcall-studio:speech-providers', 1); } catch (_) { fail(); return; }
      request.onupgradeneeded = () => {
        request.result.createObjectStore('providers', { keyPath: 'provider' });
        request.result.createObjectStore('preferences', { keyPath: 'id' });
      };
      request.onerror = request.onblocked = fail;
      request.onsuccess = () => {
        if (finished) { request.result.close(); return; }
        finished = true; clearTimeout(timer); const db = request.result;
        db.onversionchange = () => { db.close(); databaseError = '朗读配置数据库已更新，请刷新页面。'; refreshSummary(); };
        resolve(db);
      };
    });
  }
  function loadRecords() {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['providers', 'preferences'], 'readonly');
      const providers = transaction.objectStore('providers').getAll(), preference = transaction.objectStore('preferences').get('active');
      transaction.oncomplete = () => {
        records = new Map();
        for (const record of providers.result || []) try { const clean = normalize(record); records.set(clean.provider, clean); } catch (_) { /* An invalid individual preset does not affect system speech. */ }
        active = presets.some(preset => preset.id === preference.result?.provider) && (preference.result.provider === 'system' || records.has(preference.result.provider)) ? preference.result.provider : 'system';
        resolve();
      };
      transaction.onerror = transaction.onabort = () => reject(new Error('读取朗读配置失败，请刷新后重试。'));
    });
  }
  async function saveSnapshot(next, nextActive) {
    if (portableStorage) await portableStorage.writeCredentials('speech', snapshot(true, next, nextActive));
    else await new Promise((resolve, reject) => {
      let transaction;
      try { transaction = database.transaction(['providers', 'preferences'], 'readwrite'); }
      catch (_) { reject(new Error('朗读设置数据库不可用，尚未保存。')); return; }
      transaction.objectStore('providers').clear();
      for (const config of next.values()) transaction.objectStore('providers').put(config);
      transaction.objectStore('preferences').put({ id: 'active', provider: nextActive });
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(new Error('朗读设置保存失败，请重试。'));
    });
    records = next; active = nextActive; refreshSummary();
  }
  function enqueueWrite(action) {
    const result = writeQueue.then(action, action); writeQueue = result.catch(() => {}); return result;
  }
  function persist(config, makeActive, canWrite) {
    return enqueueWrite(async () => {
      if (!canWrite()) return false;
      await ensureStorage();
      if (!canWrite()) return false;
      const next = new Map(records); next.set(config.provider, config);
      await saveSnapshot(next, makeActive ? config.provider : active);
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
      await saveSnapshot(clean.records, clean.active); stop();
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
      const clean = validateSettings(await portableStorage.readCredentials('speech'), false);
      records = clean.records; active = clean.active;
      migrationPending = false; migrationReady = undefined;
    } else { if (initializationError) throw initializationError; await loadRecords(); }
    databaseError = ''; storageReady = Promise.resolve();
    refreshSummary(); stop();
  }
  function refreshSummary() {
    if (!$('speechSummary')) return;
    const preset = definition(active), config = configuration();
    $('speechSummary').textContent = preset.id === 'system' ? preset.name + ' · 无需 API 密钥' : databaseError || preset.name + ' · ' + config.voice + (config.key ? ' · 密钥已保存' : preset.id === 'custom' ? ' · 已配置接口' : ' · 待配置密钥');
  }
  async function getConfig() {
    if (ready) await ready;
    try {
      if (storageReady) await storageReady;
      if (migrationReady) await migrationReady;
    } catch (error) { if (active !== 'system') throw error; }
    if (active !== 'system' && databaseError) throw new Error(databaseError);
    return normalize(configuration());
  }
  function renderForm() {
    const preset = definition(selected), config = configuration(selected), custom = selected === 'custom', remote = selected !== 'system';
    $('speechProviderPreset').value = selected;
    $('speechVoiceField').hidden = selected !== 'mimo'; $('speechVoiceSelect').disabled = selected !== 'mimo';
    $('speechVoiceSelect').innerHTML = voices.map(voice => '<option value="' + escape(voice.id) + '">' + escape(voice.name) + '</option>').join('');
    $('speechVoiceSelect').value = config.voice;
    $('speechCustomFields').hidden = !custom;
    for (const id of ['speechEndpoint', 'speechModel', 'speechCustomVoice']) $(id).disabled = !custom;
    $('speechEndpoint').value = config.endpoint; $('speechModel').value = config.model; $('speechCustomVoice').value = config.voice;
    $('speechApiKeyField').hidden = !remote; $('speechApiKey').disabled = !remote; $('speechApiKey').value = '';
    $('speechFallbackField').hidden = !remote; $('speechFallbackInput').disabled = !remote; $('speechFallbackInput').checked = config.fallback;
    $('speechClearKeyBtn').hidden = !remote; $('speechClearKeyBtn').disabled = !config.key;
    refreshEndpointHint();
    $('speechProviderError').textContent = databaseError;
  }
  function refreshEndpointHint() {
    const config = configuration(selected), custom = selected === 'custom';
    let changed = false;
    if (custom && config.key) {
      try { changed = endpointURL($('speechEndpoint').value) !== config.endpoint; } catch (_) { changed = true; }
    }
    $('speechApiKey').placeholder = changed ? '接口已更改；请重新填写，免密代理可留空' : config.key ? '已保存；留空保留，输入新密钥替换' : custom ? '免密代理可留空' : '填入 MiMo API 密钥';
    $('speechEndpointHint').textContent = changed ? '接口已更改；原密钥不会沿用。请重新填写，免密代理可留空。' : selected === 'system' ? (window.slateDesktop?.role === 'main' ? '使用晓晓音色在线合成，无需 API 密钥。姓名音频会缓存在本机，下次直接播放。' : '直接调用浏览器语音 API，使用浏览器可用的中文语音。') : custom ? '填写兼容 /audio/speech 的完整地址。EdgeTTS 自建代理的模型、音色按其说明填写。接口需允许浏览器跨域请求。' : 'mimo-v2.5-tts · WAV · 官方预置音色。接口需允许浏览器跨域请求。';
  }
  function lockForm(value) {
    saving = value;
    for (const id of ['speechProviderPreset', 'speechProviderSaveBtn', 'speechRestorePresetBtn']) $(id).disabled = value;
    $('speechVoiceSelect').disabled = value || selected !== 'mimo';
    for (const id of ['speechEndpoint', 'speechModel', 'speechCustomVoice']) $(id).disabled = value || selected !== 'custom';
    $('speechApiKey').disabled = $('speechFallbackInput').disabled = value || selected === 'system';
    $('speechClearKeyBtn').disabled = value || !configuration(selected).key;
  }
  async function open() { if (ready) await ready; selected = active; renderForm(); return window.DialogTransitions.open($('speechProviderDialog')); }
  async function init({ mount, toast, canWrite = () => true } = {}) {
    if (ready) return ready;
    notify = toast || (() => {});
    const label = mount?.closest?.('label') || (!mount && $('voiceInput')?.closest('label'));
    if (label) { mount = document.createElement('div'); label.after(mount); }
    if (!mount) throw new Error('找不到朗读设置的挂载位置。');
    mount.innerHTML = '<div class="speech-provider-toolbar"><button type="button" id="speechSettingsBtn" class="btn btn-plain">' + icon('tune') + '朗读设置</button><span id="speechSummary" class="field-hint" role="status">设备系统朗读 · 无需 API 密钥</span></div>';
    const dialog = document.createElement('dialog'); dialog.id = 'speechProviderDialog'; dialog.className = 'dialog speech-provider-dialog'; dialog.setAttribute('aria-labelledby', 'speechProviderTitle');
    dialog.innerHTML = '<form id="speechProviderForm"><div class="dialog-heading"><h2 id="speechProviderTitle">朗读设置</h2><button type="button" class="icon-btn" data-speech-close aria-label="关闭朗读设置">' + icon('close') + '</button></div><div class="dialog-body"><label>朗读提供商<select id="speechProviderPreset">' + presets.map(preset => '<option value="' + preset.id + '">' + escape(preset.name) + '</option>').join('') + '</select></label><label id="speechVoiceField">MiMo 音色<select id="speechVoiceSelect"></select></label><div id="speechCustomFields"><label>完整语音请求地址<input id="speechEndpoint" type="url" placeholder="http://localhost:8000/v1/audio/speech" autocomplete="off" required></label><div class="form-grid"><label>语音模型<input id="speechModel" maxlength="160" placeholder="按代理说明填写" autocomplete="off" required></label><label>音色 ID<input id="speechCustomVoice" maxlength="160" placeholder="例如 zh-CN-XiaoxiaoNeural" autocomplete="off" required></label></div></div><label id="speechApiKeyField">API 密钥<input id="speechApiKey" type="password" maxlength="4096" autocomplete="off" data-lpignore="true"></label><p id="speechEndpointHint" class="field-hint"></p><label id="speechFallbackField" class="checkbox-label"><input id="speechFallbackInput" type="checkbox" class="rect-switch" role="switch">远程失败时改用设备系统朗读</label><p class="field-hint">远程朗读仅发送当次抽中的姓名。桌面版配置与密钥保存在 data/settings.json；Lite HTML 版保存在当前浏览器的 IndexedDB。设置导出默认不含密钥，完整备份可按需包含。包含密钥的备份不受密码保护，请勿公开分享。</p><div class="speech-provider-actions"><button type="button" id="speechRestorePresetBtn" class="text-btn">恢复预设</button><button type="button" id="speechClearKeyBtn" class="text-btn danger-text">' + icon('close') + '移除此提供商密钥</button></div><p id="speechProviderError" class="error-message" role="alert"></p></div><div class="dialog-footer"><button type="button" class="btn btn-plain" data-speech-close>取消</button><button type="submit" id="speechProviderSaveBtn" class="btn btn-primary">保存朗读设置' + icon('check') + '</button></div></form>';
    document.body.appendChild(dialog);
    dialog.insertAdjacentHTML('afterbegin', '<div class="modal-toast-wrap"><div class="toast" data-toast-host role="status" aria-live="polite" aria-atomic="true" hidden></div></div>');
    $('speechSettingsBtn').addEventListener('click', open);
    if (window.slateDesktop?.role === 'main' && typeof window.slateDesktop.speech?.clearCache === 'function') {
      mount.insertAdjacentHTML('beforeend', '<button type="button" id="speechClearCacheBtn" class="btn btn-plain">清空姓名语音缓存</button>');
      $('speechClearCacheBtn').addEventListener('click', async () => {
        if (!canWrite()) return;
        const button = $('speechClearCacheBtn'); button.disabled = true; stop();
        try { await window.slateDesktop.speech.clearCache(); notify('姓名语音缓存已清空。'); }
        catch { notify('无法清空姓名语音缓存，请检查数据目录权限。'); }
        finally { button.disabled = false; }
      });
    }
    dialog.querySelectorAll('[data-speech-close]').forEach(button => button.addEventListener('click', () => { if (!saving) window.DialogTransitions.close(dialog); }));
    dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
    dialog.addEventListener('close', () => { $('speechApiKey').value = ''; });
    $('speechProviderPreset').addEventListener('change', () => { selected = $('speechProviderPreset').value; renderForm(); });
    $('speechEndpoint').addEventListener('input', refreshEndpointHint);
    $('speechRestorePresetBtn').addEventListener('click', () => {
      const preset = definition(selected); $('speechVoiceSelect').value = preset.voice;
      $('speechEndpoint').value = preset.endpoint; $('speechModel').value = preset.model; $('speechCustomVoice').value = preset.voice;
      $('speechFallbackInput').checked = false; $('speechApiKey').value = ''; $('speechProviderError').textContent = databaseError;
      refreshEndpointHint();
    });
    $('speechProviderForm').addEventListener('submit', async event => {
      event.preventDefault(); if (saving || !canWrite()) return; $('speechProviderError').textContent = '';
      try {
        await ready; if (databaseError) throw new Error(databaseError);
        const previous = configuration(selected);
        const config = normalize({ provider: selected, endpoint: $('speechEndpoint').value, model: $('speechModel').value,
          voice: selected === 'mimo' ? $('speechVoiceSelect').value : $('speechCustomVoice').value,
          key: $('speechApiKey').value, fallback: $('speechFallbackInput').checked });
        if (!config.key && previous.endpoint === config.endpoint) config.key = previous.key;
        if (selected === 'mimo' && !config.key) throw new Error('请填写 MiMo API 密钥。');
        if (!canWrite()) return;
        lockForm(true); if (!await persist(config, true, canWrite)) return; stop(); $('speechApiKey').value = '';
        await window.DialogTransitions.close(dialog); notify(portableStorage ? '朗读设置已保存到 data/settings.json。' : '朗读设置已保存到当前浏览器的 IndexedDB。');
      } catch (error) { $('speechProviderError').textContent = error.message; }
      finally { lockForm(false); }
    });
    $('speechClearKeyBtn').addEventListener('click', async () => {
      if (saving || !canWrite()) return;
      try { await ready; if (databaseError) throw new Error(databaseError); if (!canWrite()) return; lockForm(true);
        if (!await persist({ ...configuration(selected), key: '' }, false, canWrite)) return; stop(); renderForm(); notify('已移除此提供商的 API 密钥。');
      } catch (error) { $('speechProviderError').textContent = error.message; }
      finally { lockForm(false); }
    });
    window.DialogTransitions.register(dialog, { canClose: () => !saving });
    ready = (async () => { try { await ensureStorage(); } catch (error) { databaseError = error.message; notify(databaseError); } refreshSummary(); })();
    return ready;
  }

  function cleanRun(target, cancelled = false) {
    if (!target || target.closed) return;
    target.closed = true; target.controller.abort(); clearTimeout(target.timer);
    if (target.audio) {
      target.audio.onended = target.audio.onerror = null; target.audio.pause();
      target.audio.removeAttribute?.('src'); target.audio.load?.(); target.audio = null;
    }
    if (target.url) { URL.revokeObjectURL(target.url); target.url = null; }
    if (target.utterance) { target.utterance.onend = target.utterance.onerror = null; window.speechSynthesis?.cancel(); }
    target.resolveCancel({ cancelled });
    if (run === target) run = null;
  }
  function stop() {
    generation++; cleanRun(run, true);
    const native = window.slateDesktop?.role === 'main' ? window.slateDesktop.speech : null;
    if (typeof native?.cancelPending === 'function') void native.cancelPending().catch(() => {});
    window.speechSynthesis?.cancel();
  }
  function systemSpeech(target, name) {
    const Utterance = window.SpeechSynthesisUtterance || globalThis.SpeechSynthesisUtterance;
    if (!window.speechSynthesis || typeof Utterance !== 'function') throw new Error('此设备暂不支持姓名朗读。');
    return new Promise((resolve, reject) => {
      const utterance = new Utterance(name); target.utterance = utterance; utterance.lang = 'zh-CN'; utterance.rate = .9;
      utterance.onend = () => { if (!target.closed) resolve({ spoken: true, provider: 'system' }); };
      utterance.onerror = event => { if (!target.closed) reject(new Error(event.error === 'not-allowed' ? '浏览器阻止了声音播放，请与页面交互后重试。' : '设备系统朗读失败。')); };
      target.timer = setTimeout(() => reject(new Error('设备系统朗读超时。')), 30000);
      window.speechSynthesis.speak(utterance);
    });
  }
  async function remoteSpeech(target, config, name) {
    let blob;
    const nativeSpeech = window.slateDesktop?.role === 'main' && typeof window.slateDesktop.speech?.synthesize === 'function' && config.provider === 'system';
    if (nativeSpeech) {
      const bytes = await window.slateDesktop.speech.synthesize(name, config.voice || '茉莉');
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_AUDIO) throw new Error('桌面语音服务返回的音频无效。');
      blob = new Blob([bytes], { type: 'audio/mpeg' });
    } else blob = await requestAudio(config, name, { signal: target.controller.signal });
    if (target.closed) return { cancelled: true };
    const AudioElement = window.Audio || globalThis.Audio;
    if (typeof AudioElement !== 'function') throw new Error('此设备无法播放姓名音频。');
    target.url = URL.createObjectURL(blob); target.audio = new AudioElement(target.url); target.audio.preload = 'auto';
    return new Promise((resolve, reject) => {
      target.audio.onended = () => { if (!target.closed) resolve({ spoken: true, provider: config.provider }); };
      target.audio.onerror = () => { if (!target.closed) reject(new Error('姓名音频无法播放，请检查语音接口返回格式。')); };
      target.timer = setTimeout(() => reject(new Error('姓名音频播放超时。')), 30000);
      try {
        const playing = target.audio.play();
        playing?.catch(error => { if (!target.closed) reject(new Error(error?.name === 'NotAllowedError' ? '浏览器阻止了声音播放，请与页面交互后重试。' : '姓名音频播放失败。')); });
      } catch (_) { reject(new Error('姓名音频播放失败。')); }
    });
  }
  async function speak(name) {
    stop();
    let resolveCancel;
    const cancelled = new Promise(resolve => { resolveCancel = resolve; });
    const target = { generation, controller: new AbortController(), resolveCancel, cancelled, closed: false, timer: 0, audio: null, url: null, utterance: null };
    run = target; let config;
    try {
      const text = field(name, '姓名', 200);
      config = await Promise.race([getConfig(), cancelled]);
      if (target.closed || target.generation !== generation) return { cancelled: true };
      const result = await Promise.race([config.provider === 'system' && !(window.slateDesktop?.role === 'main' && typeof window.slateDesktop.speech?.synthesize === 'function') ? systemSpeech(target, text) : remoteSpeech(target, config, text), cancelled]);
      return result;
    } catch (error) {
      if (target.closed || error?.name === 'AbortError' || target.generation !== generation) return { cancelled: true };
      clearTimeout(target.timer);
      if (target.audio) { target.audio.onended = target.audio.onerror = null; target.audio.pause(); target.audio.removeAttribute?.('src'); target.audio.load?.(); target.audio = null; }
      if (target.url) { URL.revokeObjectURL(target.url); target.url = null; }
      notify(error.message || '姓名朗读失败。');
      if (config?.provider !== 'system' && config?.fallback === true) {
        try { return await Promise.race([systemSpeech(target, field(name, '姓名', 200)), cancelled]); }
        catch (fallbackError) { if (!target.closed) notify(fallbackError.message || '设备系统朗读失败。'); }
      }
      return { spoken: false, provider: config?.provider || active };
    } finally { cleanRun(target); }
  }
  window.SpeechProviders = Object.freeze({ init, open, getConfig, speak, stop, exportSettings, importSettings, prepareSettings, reloadSettings, presets, voices, normalize, buildRequest, responseAudio, requestAudio });
}());
