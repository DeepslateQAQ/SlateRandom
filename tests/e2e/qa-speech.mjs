import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, createDecipheriv } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// The exported HTML runs with fake classroom names and local-only TTS. Native
// speech/audio are replaced before the app starts; no remote API is contacted.
const root = fileURLToPath(new URL('../../', import.meta.url)), output = path.join(root, 'qa-output');
const KEY = 'rollcall-studio:v1', DB = 'rollcall-studio:speech-providers';
const artifact = await readFile(path.join(root, 'dist/index.html'));
const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
const checks = [], screenshots = [], requests = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(await realpath(tmpdir()), 'rollcall-speech-'));
let browser, client, server, site, lastLabel = 'startup';

class CDP {
  constructor(ws) {
    this.ws = ws; this.next = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timed out')); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(fn, ...args) {
    const result = await this.send('Runtime.evaluate', { expression: '(' + fn.toString() + ').apply(null,' + JSON.stringify(args) + ')', awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
}
async function waitFor(fn, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { try { if (await fn()) return; } catch (_) {} await pause(50); }
  throw new Error('condition timed out at ' + lastLabel);
}
function check(label, value) { lastLabel = label; assert.ok(value, label); checks.push(label); console.log('PASS ' + label); }
function decodeCompleteBackup(input) {
  const bytes = Buffer.from(input), magic = Buffer.from('SLATERANDOM-BK1\n');
  assert.deepEqual(bytes.subarray(0, 16), magic, 'Speech settings export uses the binary complete-backup format');
  const decipher = createDecipheriv('aes-256-gcm', bytes.subarray(16, 48), bytes.subarray(48, 60));
  decipher.setAAD(magic); decipher.setAuthTag(bytes.subarray(60, 76));
  return JSON.parse(gunzipSync(Buffer.concat([decipher.update(bytes.subarray(76)), decipher.final()])).toString('utf8'));
}
async function click(id) { await client.evaluate(async id => { const element = document.getElementById(id); if (!element) throw Error('Missing ' + id); const view = element.closest('section.view[hidden]'); if (view) { document.querySelector('.navigation [data-nav="' + view.id.replace('view-', '') + '"]').click(); await new Promise(resolve => setTimeout(resolve, 0)); } element.click(); await new Promise(resolve => setTimeout(resolve, 0)); }, id); }
async function settled(id, open = true) { await waitFor(() => client.evaluate((id, open) => { const element = document.getElementById(id); return element?.open === open && !element.dataset.motion; }, id, open), 5000); }
async function close(id) { await client.evaluate(id => DialogTransitions.close(document.getElementById(id)), id); await settled(id, false); }
async function openConfig() {
  if (await client.evaluate(() => document.getElementById('configDialog').open)) return;
  await client.evaluate(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 540));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
  });
  await settled('configDialog');
}
async function openSpeech() {
  await openConfig();
  if (!await client.evaluate(() => document.getElementById('settingsDialog').open)) { await click('settingsBtn'); await settled('settingsDialog'); }
  if (!await client.evaluate(() => document.getElementById('speechProviderDialog').open)) { await click('speechSettingsBtn'); await settled('speechProviderDialog'); }
}
async function pickProvider(provider) {
  await client.evaluate(provider => { const element = document.getElementById('speechProviderPreset'); element.value = provider; element.dispatchEvent(new Event('change', { bubbles: true })); }, provider);
  await pause(80);
}
async function saveSpeech(values) {
  await client.evaluate(values => {
    for (const [id, value] of Object.entries(values)) {
      const element = document.getElementById(id); if (!element) throw Error('Missing ' + id);
      if (element.type === 'checkbox') element.checked = value; else element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    document.getElementById('speechProviderForm').requestSubmit();
  }, values);
  await settled('speechProviderDialog', false);
}
async function config() { return client.evaluate(() => SpeechProviders.getConfig()); }
async function dbRecords() {
  return client.evaluate(async dbName => new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction(['providers', 'preferences'], 'readonly');
      const providers = transaction.objectStore('providers').getAll(), preferences = transaction.objectStore('preferences').getAll();
      transaction.oncomplete = () => { db.close(); resolve({ providers: providers.result, preferences: preferences.result }); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  }), DB);
}
async function reload(state) {
  if (state) { state.demo = false; state.settings.theme = 'classic'; state.settings.radius = 0; state.settings.onboardingCompleted = true; }
  await client.evaluate((key, state) => { if (state) localStorage.setItem(key, JSON.stringify(state)); window.__speechOldPage = true; }, KEY, state);
  await client.send('Page.reload');
  await waitFor(() => client.evaluate(() => !window.__speechOldPage && window.SpeechProviders && document.querySelectorAll('[data-mode-row]').length === 5));
  await config();
}
async function finished() { await waitFor(() => client.evaluate(() => document.getElementById('drawBtn').getAttribute('aria-busy') === 'false'), 22000); }
async function picture(name) { const data = await client.send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(output, name), Buffer.from(data.data, 'base64')); screenshots.push(name); }
async function counts() { return client.evaluate(() => ({ played: __speechMock.played.length, paused: __speechMock.paused.length, revoked: __speechMock.revoked.length, system: __speechMock.system.length, cancelled: __speechMock.cancelled, activeUrls: __speechMock.urls.size, forbidden: __speechMock.forbidden.length })); }
async function makeFixture(voice) {
  return client.evaluate(voice => {
    const students = ['测试甲', '测试乙', '测试丙', '测试丁'].map((name, i) => ({ id: String(i + 1), name, row: Math.floor(i / 2) + 1, col: i % 2 + 1, active: true }));
    const state = DrawCore.createState(students, 71023);
    state.demo = false;
    state.settings = DrawCore.settings({ strategy: 'manual', manualMode: 'normal', voice, friendEnabled: false, endJumpChance: 0, theme: 'classic', radius: 0 });
    return state;
  }, voice);
}

function installMocks(origin) {
  const mock = window.__speechMock = { played: [], paused: [], revoked: [], system: [], cancelled: 0, urls: new Map(), downloads: [], forbidden: [], routeMode: 'ok', ignoreAbort: false, holdAudio: false, sequence: 0 };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    cancel() { mock.cancelled++; }, speak(utterance) { mock.system.push({ text: utterance.text, lang: utterance.lang, rate: utterance.rate }); setTimeout(() => utterance.onend?.(new Event('end')), 25); },
    getVoices() { return [{ name: 'QA Chinese', lang: 'zh-CN', default: true, localService: true }]; },
    addEventListener() {}, removeEventListener() {}, speaking: false, pending: false
  } });
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; this.lang = ''; this.rate = 1; } };
  URL.createObjectURL = blob => { const url = 'blob:qa-speech-' + ++mock.sequence; mock.urls.set(url, blob); return url; };
  URL.revokeObjectURL = url => { mock.revoked.push(url); mock.urls.delete(url); };
  window.Audio = class extends EventTarget {
    constructor(src = '') { super(); this.src = src; this.currentTime = 0; this.preload = ''; this.paused = true; }
    async play() {
      this.paused = false; mock.played.push({ url: this.src, type: mock.urls.get(this.src)?.type || '' });
      if (!mock.holdAudio) setTimeout(() => { if (this.paused) return; this.paused = true; const event = new Event('ended'); this.dispatchEvent(event); this.onended?.(event); }, 25);
    }
    pause() { this.paused = true; mock.paused.push(this.src); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() {}
  };
  const anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const blob = mock.urls.get(this.href);
    if (this.download && blob) { blob.arrayBuffer().then(buffer => mock.downloads.push({ name: this.download, bytes: Array.from(new Uint8Array(buffer)) })); return; }
    anchorClick.call(this);
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const inputUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(inputUrl, location.href);
    const requestInit = { ...init };
    if (mock.ignoreAbort) delete requestInit.signal;
    if (url.hostname === 'api.xiaomimimo.com') return nativeFetch(origin + '/mimo/' + mock.routeMode, requestInit);
    if (url.origin !== origin) { mock.forbidden.push(url.hostname); return Promise.reject(new Error('QA prevents external requests')); }
    if (url.pathname === '/custom/v1/audio/speech') return nativeFetch(origin + '/custom/' + mock.routeMode, requestInit);
    return nativeFetch(input, requestInit);
  };
}

try {
  const wav = Buffer.alloc(52);
  wav.write('RIFF'); wav.writeUInt32LE(44, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(8, 40); wav.fill(128, 44);
  server = createServer(async (request, response) => {
    if (request.url === '/' && request.method === 'GET') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(artifact); return; }
    if (request.url === '/favicon.ico') { response.statusCode = 204; response.end(); return; }
    if (request.method !== 'POST' || !/^\/(mimo|custom)\/(ok|slow|fail)$/.test(request.url)) { response.statusCode = 404; response.end(); return; }
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ path: request.url, headers: request.headers, body });
      if (request.url.endsWith('/slow')) await pause(450);
      if (request.url.endsWith('/fail')) { response.statusCode = 503; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ error: { message: 'QA local speech unavailable' } })); return; }
      if (request.url.startsWith('/mimo/')) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { audio: { data: wav.toString('base64'), transcript: body.messages?.[0]?.content || '' } } }] }));
      } else { response.setHeader('content-type', 'audio/mpeg'); response.end(wav); }
    } catch (_) { if (!response.headersSent) response.statusCode = 400; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  site = 'http://127.0.0.1:' + server.address().port;
  browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-proxy-server', '--remote-debugging-port=0', '--window-size=1000,800', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let port;
  await waitFor(async () => { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return port > 0; }, 20000);
  const target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(target => target.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  client = new CDP(socket); await client.send('Page.enable'); await client.send('Runtime.enable'); await client.send('Network.enable');
  await client.send('Network.setBlockedURLs', { urls: ['https://*'] });
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: '(' + installMocks.toString() + ')(' + JSON.stringify(site) + ')' });
  await client.send('Page.navigate', { url: site });
  await waitFor(() => client.evaluate(() => window.SpeechProviders && document.querySelectorAll('[data-mode-row]').length === 5));
  check('默认使用系统朗读且独立语音设置不会改变默认普通渲染', (await config()).provider === 'system' && await client.evaluate(() => document.querySelector('.draw-screen').dataset.renderStyle === 'normal'));

  await client.evaluate(() => {
    const state = DrawCore.createEmptyState(4242);
    state.settings = DrawCore.settings({ ...state.settings, theme: 'classic', radius: 0, onboardingCompleted: true });
    localStorage.setItem('rollcall-studio:v1', JSON.stringify(state));
  });
  await reload();
  await openSpeech();
  check('真实语音配置弹窗使用白底黑字直角样式并提供系统、MiMo与自建兼容服务', await client.evaluate(() => {
    const dialog = document.getElementById('speechProviderDialog'), style = getComputedStyle(dialog);
    return dialog.open && dialog.matches(':modal') && style.backgroundColor === 'rgb(255, 255, 255)' && parseFloat(style.borderTopLeftRadius) === 0 && ['system', 'mimo', 'custom'].every(value => Array.from(document.getElementById('speechProviderPreset').options).some(option => option.value === value));
  }));
  await pickProvider('mimo');
  check('MiMo预设只需填入密钥，固定模型与官方音色下拉正确显示', await client.evaluate(() => {
    const key = document.getElementById('speechApiKey'), voice = document.getElementById('speechVoiceSelect'), endpoint = document.getElementById('speechEndpoint');
    return key.type === 'password' && key.getClientRects().length > 0 && voice.options.length >= 9 && voice.value === '茉莉' && (!endpoint.getClientRects().length || endpoint.disabled || endpoint.readOnly);
  }));
  await picture('speech-provider-mimo.png');
  await saveSpeech({ speechApiKey: 'qa-key-mimo', speechVoiceSelect: '茉莉', speechFallbackInput: false });
  const mimo = await config(), records = await dbRecords();
  check('密钥与提供商配置保存于独立 IndexedDB，不进入课堂状态', mimo.provider === 'mimo' && mimo.key === 'qa-key-mimo' && records.providers.some(record => record.provider === 'mimo' && record.key === 'qa-key-mimo') && records.preferences.some(record => record.id === 'active' && record.provider === 'mimo') && await client.evaluate(key => !(localStorage.getItem(key) || '').includes('qa-key-mimo') && !(localStorage.getItem(key) || '').includes('speech-providers'), KEY));
  await reload();
  check('刷新恢复MiMo提供商、密钥和音色，读取配置不发起TTS请求', (await config()).provider === 'mimo' && (await config()).key === 'qa-key-mimo' && requests.length === 0);
  const first = await counts();
  await client.evaluate(() => SpeechProviders.speak('测试甲'));
  await waitFor(async () => (await counts()).revoked > first.revoked);
  const mimoRequest = requests.at(-1);
  check('MiMo调用使用assistant姓名、mimo-v2.5-tts与wav音色，且不发送名单', mimoRequest.path === '/mimo/ok' && mimoRequest.headers.authorization === 'Bearer qa-key-mimo' && JSON.stringify(mimoRequest.body) === JSON.stringify({ model: 'mimo-v2.5-tts', stream: false, messages: [{ role: 'assistant', content: '测试甲' }], audio: { format: 'wav', voice: '茉莉' } }));
  check('MiMo返回的base64音频仅播放一次，并在结束后释放ObjectURL', await client.evaluate(() => __speechMock.played.length === 1 && __speechMock.played[0].type === 'audio/wav' && __speechMock.urls.size === 0 && __speechMock.revoked.length === 1 && __speechMock.system.length === 0));

  await openSpeech(); await pickProvider('custom');
  await saveSpeech({ speechApiKey: 'qa-key-custom', speechEndpoint: site + '/custom/v1/audio/speech', speechModel: 'qa-edge-tts', speechCustomVoice: 'zh-CN-XiaoxiaoNeural', speechFallbackInput: false });
  await client.evaluate(() => SpeechProviders.speak('测试乙'));
  await waitFor(async () => (await counts()).revoked >= 2);
  const customRequest = requests.at(-1);
  check('自建兼容TTS仅发送当前姓名、模型与音色并支持二进制音频', customRequest.path === '/custom/ok' && customRequest.headers.authorization === 'Bearer qa-key-custom' && JSON.stringify(customRequest.body) === JSON.stringify({ model: 'qa-edge-tts', input: '测试乙', voice: 'zh-CN-XiaoxiaoNeural', response_format: 'mp3' }) && await client.evaluate(() => __speechMock.played.at(-1).type === 'audio/mpeg' && __speechMock.urls.size === 0));
  await openSpeech(); await pickProvider('mimo');
  check('切换提供商恢复各自音色并隐藏已保存密钥，取消配置不会改变当前服务', await client.evaluate(() => document.getElementById('speechApiKey').value === '' && /已保存/.test(document.getElementById('speechApiKey').placeholder) && document.getElementById('speechVoiceSelect').value === '茉莉'));
  await close('speechProviderDialog');
  check('关闭未保存弹窗继续使用已保存的自建TTS配置', (await config()).provider === 'custom' && (await config()).key === 'qa-key-custom');

  const beforeStop = await counts();
  await client.evaluate(() => { __speechMock.routeMode = 'slow'; window.__speechPending = SpeechProviders.speak('测试取消'); });
  await waitFor(() => requests.at(-1)?.path === '/custom/slow');
  await client.evaluate(() => SpeechProviders.stop()); await pause(650);
  await client.evaluate(() => window.__speechPending);
  check('快速取消中止远程朗读，并且不会播放音频或自动回退系统朗读', (await counts()).played === beforeStop.played && (await counts()).system === beforeStop.system && (await counts()).activeUrls === 0);
  const beforeLate = await counts(), requestCount = requests.length;
  await client.evaluate(() => { __speechMock.ignoreAbort = true; window.__speechLate = SpeechProviders.speak('测试旧请求'); });
  await waitFor(() => requests.length > requestCount);
  await client.evaluate(() => SpeechProviders.stop()); await pause(650); await client.evaluate(() => window.__speechLate);
  check('代理即使忽略abort且旧请求迟到，旧响应也不会重新播放', (await counts()).played === beforeLate.played && (await counts()).system === beforeLate.system && (await counts()).activeUrls === 0);
  await client.evaluate(() => { __speechMock.ignoreAbort = false; __speechMock.routeMode = 'ok'; __speechMock.holdAudio = true; });
  const beforePlaying = await counts();
  await client.evaluate(() => { window.__speechPlaying = SpeechProviders.speak('测试播放中'); });
  await waitFor(async () => (await counts()).played > beforePlaying.played);
  const playing = await counts(); await client.evaluate(() => { SpeechProviders.stop(); SpeechProviders.stop(); });
  await client.evaluate(() => window.__speechPlaying);
  check('停止正在播放的音频会pause并释放URL，多次停止保持幂等', (await counts()).paused > playing.paused && (await counts()).revoked === playing.revoked + 1 && (await counts()).activeUrls === 0);
  const beforeFailure = await counts();
  await client.evaluate(() => { __speechMock.holdAudio = false; __speechMock.routeMode = 'fail'; return SpeechProviders.speak('测试失败'); });
  check('远程失败时明确提示错误，未开启回退不会擅自调用系统朗读', (await counts()).system === beforeFailure.system && await client.evaluate(() => /朗读|语音|TTS|失败|503/i.test((DialogTransitions.topModal() || document).querySelector('[data-toast-host]').textContent)));
  await openSpeech(); await saveSpeech({ speechFallbackInput: true });
  await client.evaluate(() => SpeechProviders.speak('测试回退'));
  check('明确开启失败回退后，仅将失败姓名交给系统朗读一次', await client.evaluate(() => __speechMock.system.at(-1)?.text === '测试回退') && (await counts()).system === beforeFailure.system + 1);

  await openSpeech(); await pickProvider('system'); await saveSpeech({});
  await close('settingsDialog'); await close('configDialog');
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await reload(await makeFixture(false));
  const disabledVoice = await counts(), noRequests = requests.length;
  await click('drawBtn'); await finished();
  check('朗读关闭时新抽选先清理旧声音，且不会触发系统或远程朗读', (await counts()).system === disabledVoice.system && (await counts()).cancelled > disabledVoice.cancelled && requests.length === noRequests);
  await reload(await makeFixture(true));
  await click('drawBtn'); await finished();
  await waitFor(async () => (await counts()).system === 1);
  check('系统服务仅朗读真实抽选最终姓名，采用中文且启动新抽选前清理旧声音', await client.evaluate(key => { const state = JSON.parse(localStorage.getItem(key)); return __speechMock.system.length === 1 && __speechMock.system[0].text === state.history.at(-1).name && __speechMock.system[0].lang === 'zh-CN' && __speechMock.cancelled > 0; }, KEY));
  const beforeReset = await counts();
  await client.evaluate(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', key: 'r', bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 540));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR', key: 'r', bubbles: true }));
  });
  await finished();
  check('真实长按重置清理声音、重置记录且不会误发新的朗读', (await counts()).cancelled > beforeReset.cancelled && (await counts()).system === beforeReset.system && await client.evaluate(key => JSON.parse(localStorage.getItem(key)).round === 0, KEY));

  await openSpeech(); await pickProvider('custom'); await click('speechClearKeyBtn');
  await waitFor(async () => !(await dbRecords()).providers.find(record => record.provider === 'custom')?.key);
  check('移除密钥只清除选定提供商，不切换已保存的系统朗读，MiMo密钥和课堂备份保持独立', (await dbRecords()).providers.find(record => record.provider === 'mimo')?.key === 'qa-key-mimo' && await client.evaluate(async key => !localStorage.getItem(key).includes('qa-key-custom') && (await SpeechProviders.getConfig()).provider === 'system', KEY));
  await close('speechProviderDialog'); await close('settingsDialog');
  await client.evaluate(() => document.querySelector('[data-nav="data"]').click()); await click('backupBtn');
  await waitFor(() => client.evaluate(() => __speechMock.downloads.length > 0));
  const speechBackup = await client.evaluate(() => __speechMock.downloads.at(-1)), speechArchive = decodeCompleteBackup(speechBackup.bytes);
  check('实际导出 .slate 全部备份通过完整性校验，保留名单与已保存的系统朗读及远程配置，默认排除全部语音密钥', speechBackup.name.endsWith('.slate') && speechArchive.state.students.length === 4 && speechArchive.credentials.speech.active === 'system' && speechArchive.credentials.speech.records.some(record => record.provider === 'custom' && record.model === 'qa-edge-tts') && speechArchive.credentials.speech.records.some(record => record.provider === 'mimo') && !JSON.stringify(speechArchive.credentials).includes('qa-key-'));
  await close('configDialog');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 780, deviceScaleFactor: 1, mobile: true });
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await openConfig(); await click('settingsBtn'); await settled('settingsDialog');
  const point = await client.evaluate(() => { const button = document.getElementById('speechSettingsBtn'); button.scrollIntoView({ block: 'center' }); const r = button.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await settled('speechProviderDialog');
  check('320px触屏能打开白色语音配置，各控件不溢出且按钮宽度至少等于高度', await client.evaluate(() => {
    const dialog = document.getElementById('speechProviderDialog'), box = dialog.getBoundingClientRect();
    return box.left >= -1 && box.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1 && Array.from(dialog.querySelectorAll('button,input,select')).filter(element => element.getClientRects().length).every(element => { const r = element.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && (element.tagName !== 'BUTTON' || r.width + 1 >= r.height); });
  }));
  await picture('speech-provider-touch.png');
  check('系统与本地mock朗读检查没有运行错误，且没有尝试访问外部服务', client.errors.length === 0 && (await counts()).forbidden === 0);
  check('语音QA全程构建文件保持一致', (await readFile(path.join(root, 'dist/index.html'))).equals(artifact));
  await writeFile(path.join(output, 'speech-report.json'), JSON.stringify({ completedAt: new Date().toISOString(), artifactBytes: artifact.length, artifactSha256, checks, runtimeErrors: client.errors, speechTest: 'localhost HTTP mock, fake system speech and audio; no external API call', screenshots }, null, 2));
  console.log(JSON.stringify({ checkCount: checks.length, artifactBytes: artifact.length, screenshots }));
} catch (error) {
  if (client) { try { await picture('speech-failure.png'); } catch (_) {} }
  await writeFile(path.join(output, 'speech-partial-report.json'), JSON.stringify({ completedAt: new Date().toISOString(), artifactBytes: artifact.length, artifactSha256, checks, failedCheck: lastLabel, error: String(error), runtimeErrors: client?.errors || [], screenshots }, null, 2));
  throw error;
} finally {
  if (client) { try { await client.send('Browser.close'); } catch (_) {} client.ws.close(); }
  if (browser) { try { browser.kill(); } catch (_) {} }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  const absolute = await realpath(profile).catch(() => null), parent = await realpath(tmpdir());
  if (absolute && absolute.startsWith(parent + path.sep) && path.basename(absolute).startsWith('rollcall-speech-')) { await pause(700); await rm(absolute, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
}
