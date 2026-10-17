import { readFile, writeFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// One isolated Edge instance, real offline DOM and file inputs. All model fetches
// are mocked before recognition; no API service is contacted or given a key.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'qa-output'), artifactPath = path.join(root, 'dist/index.html');
const artifact = await readFile(artifactPath);
const artifactBytes = artifact.length;
const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
const KEY = 'rollcall-studio:v1', checks = [], screenshots = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
await mkdir(output, { recursive: true });
const parent = await realpath(tmpdir()), profile = await mkdtemp(path.join(parent, 'SlateRandom-import-'));
let browser, client, lastLabel = 'startup';

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
      const id = ++this.next, timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timed out')); }, 15000);
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(fn, ...args) {
    const response = await this.send('Runtime.evaluate', { expression: '(' + fn.toString() + ').apply(null,' + JSON.stringify(args) + ')', awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  }
}

async function waitFor(fn, ms = 10000) {
  const started = Date.now();
  while (Date.now() - started < ms) { try { if (await fn()) return; } catch (_) {} await pause(60); }
  throw new Error('condition timed out after ' + lastLabel);
}
function check(label, value) { lastLabel = label; assert.ok(value, label); checks.push(label); console.log('PASS ' + label); }
async function settled(id, open = true) { await waitFor(() => client.evaluate((id, open) => { const dialog = document.getElementById(id); return dialog?.open === open && !dialog.dataset.motion; }, id, open)); }
async function click(id) { await client.evaluate(async id => { const element = document.getElementById(id); if (!element) throw new Error('Missing #' + id); element.focus({ preventScroll: true }); element.click(); await new Promise(resolve => setTimeout(resolve, 0)); }, id); }
async function trustedClick(selector) {
  const point = await client.evaluate(selector => { const e = document.querySelector(selector); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, selector);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
}
async function fields(values) { await client.evaluate(values => { for (const [id, value] of Object.entries(values)) { const element = document.getElementById(id); if (typeof value === 'boolean') element.checked = value; else element.value = String(value); } }, values); }
async function submit(id) { await client.evaluate(id => document.getElementById(id).requestSubmit(), id); }
async function picture(name) { const image = await client.send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(output, name), Buffer.from(image.data, 'base64')); screenshots.push(name); }
async function state() { return client.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY); }
async function preview() { return client.evaluate(() => Array.from(document.querySelectorAll('#importPreviewTable [data-preview-row]')).map(row => Object.fromEntries(Array.from(row.querySelectorAll('[data-field]')).map(input => [input.dataset.field, ['row', 'col'].includes(input.dataset.field) ? Number(input.value) : input.value])))); }
async function previewReady() { await waitFor(() => client.evaluate(() => !document.getElementById('importPreviewSection').hidden && document.querySelectorAll('#importPreviewTable [data-preview-row]').length > 0 && !document.getElementById('importLayoutDialog').open)); }
async function tab(name) { await client.evaluate(name => document.querySelector('[data-import-tab="' + name + '"]').click(), name); }
async function openImport() {
  const opened = await client.evaluate(() => document.getElementById('configDialog').open);
  if (!opened) {
    await client.evaluate(async () => {
      const button = document.getElementById('drawBtn'); button.focus({ preventScroll: true });
      button.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 540));
      button.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
    });
    await settled('configDialog');
  }
  await client.evaluate(async () => {
    document.querySelector('.navigation [data-nav="roster"]').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    document.querySelector('#view-roster [data-import]').click();
  });
  await settled('importDialog');
}
async function mockFetch() {
  await client.evaluate(() => {
    window.__importMockRequests = []; window.__importModelReplies = []; window.__importUnexpectedRequests = [];
    window.__importHoldResponses = false; window.__importHeldResponses = [];
    window.fetch = async (url, options = {}) => {
      if (String(url) !== 'http://127.0.0.1:9/v1/chat/completions') {
        window.__importUnexpectedRequests.push(String(url));
        throw new Error('QA blocks all non-mock requests.');
      }
      const body = JSON.parse(options.body);
      window.__importMockRequests.push({ endpoint: String(url), method: options.method, headers: options.headers, body });
      const reply = window.__importModelReplies.shift();
      if (!reply) throw new Error('No mock model reply was queued.');
      if (window.__importHoldResponses) await new Promise(resolve => window.__importHeldResponses.push(resolve));
      else { await new Promise(resolve => setTimeout(resolve, 400)); if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError'); }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  });
}
async function reload(snapshot) {
  snapshot.demo = false;
  snapshot.settings.theme = 'classic';
  snapshot.settings.radius = 0;
  await client.evaluate((key, value) => { localStorage.setItem(key, JSON.stringify(value)); window.__importOldPage = true; }, KEY, snapshot);
  await client.send('Page.reload');
  await waitFor(() => client.evaluate(() => !window.__importOldPage && document.querySelectorAll('[data-mode-row]').length === 5));
  await mockFetch();
}
async function emptyState(seed) { return client.evaluate(seed => DrawCore.createEmptyState(seed), seed); }
async function jsonPreview(value) { await tab('json'); await fields({ visionJson: JSON.stringify(value) }); await click('previewImportBtn'); }
async function fillLayout(rows, cols) { await fields({ importLayoutRows: rows, importLayoutCols: cols }); await submit('importLayoutForm'); }
async function applyPreview(reset = true) {
  const rebuilding = reset && Boolean((await state())?.students.length);
  await fields({ importResetInput: reset }); await click('applyImportBtn');
  if (rebuilding) { await settled('confirmDialog'); await click('confirmActionBtn'); await settled('confirmDialog', false); }
  await settled('importDialog', false);
}
async function queueReply(reply) { await client.evaluate(reply => window.__importModelReplies.push(reply), reply); }

try {
  browser = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-proxy-server', '--remote-debugging-port=0', '--window-size=1120,850', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let port;
  await waitFor(async () => { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return port > 0; }, 20000);
  const target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(value => value.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  client = new CDP(socket);
  await client.send('Page.enable'); await client.send('Runtime.enable'); await client.send('Network.enable');
  await client.send('Network.setBlockedURLs', { urls: ['https://*', 'http://*'] });
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1120, height: 850, deviceScaleFactor: 1, mobile: false });
  await client.send('Page.navigate', { url: pathToFileURL(artifactPath).href });
  await waitFor(() => client.evaluate(() => document.querySelectorAll('[data-mode-row]').length === 5));
  await mockFetch();
  check('新安装单文件页面没有自动填入示例学生', await client.evaluate(key => document.querySelectorAll('#rosterSeats [data-student]').length === 0 && (!localStorage.getItem(key) || JSON.parse(localStorage.getItem(key)).students.length === 0), KEY));

  await openImport();
  await fields({ importClassInput: '导入回归班', importColsInput: 2, rosterText: '按行甲\n按行乙\n按行丙' });
  await click('previewImportBtn'); await previewReady();
  assert.deepEqual(await preview(), [{ id: '1', name: '按行甲', row: 1, col: 1 }, { id: '2', name: '按行乙', row: 1, col: 2 }, { id: '3', name: '按行丙', row: 2, col: 1 }]);
  check('纯姓名按行导入直接生成可编辑预览，使用指定列数和本地连续学号', true);
  check('预览阶段不会提前写入学生名单', await client.evaluate(key => !localStorage.getItem(key) || JSON.parse(localStorage.getItem(key)).students.length === 0, KEY));
  await applyPreview();
  const textState = await state();
  check('确认按行导入后持久化班级与座位，自动学号有明确 auto 来源', textState.className === '导入回归班' && textState.students.length === 3 && textState.students.every(student => student.idSource === 'auto') && textState.cols === 2 && textState.round === 0);

  await reload(await emptyState(200)); await openImport();
  const rosterOnly = { students: [{ id: '12', name: '十二同学' }, { id: '2', name: '二号同学' }, { id: '30', name: '三十同学' }, { id: '4', name: '四号同学' }] };
  await jsonPreview(rosterOnly); await settled('importLayoutDialog');
  check('只有姓名和学号而没有座位时询问行列，不替用户猜教室尺寸', await client.evaluate(() => document.getElementById('importLayoutRows').value === '' && document.getElementById('importLayoutCols').value === '' && document.getElementById('importPreviewSection').hidden));
  await fillLayout(1, 3);
  check('座位容量不足时保留尺寸窗口并显示人数与容量错误', await client.evaluate(() => document.getElementById('importLayoutDialog').open && /容量.*3.*人数.*4/.test(document.getElementById('importLayoutError').textContent) && document.getElementById('applyImportBtn').hidden));
  await client.send('Emulation.setDeviceMetricsOverride', { width: 768, height: 432, deviceScaleFactor: 2.5, mobile: false }); await pause(400);
  check('768×432 / 2.5× 的尺寸确认窗口与两个输入框均完整显示', await client.evaluate(() => { const dialog = document.getElementById('importLayoutDialog'), box = dialog.getBoundingClientRect(); return box.left >= -.5 && box.top >= -.5 && box.right <= innerWidth + .5 && box.bottom <= innerHeight + .5 && dialog.scrollWidth <= dialog.clientWidth + 1 && ['importLayoutRows', 'importLayoutCols'].every(id => { const rect = document.getElementById(id).getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth + .5 && rect.top >= 0 && rect.bottom <= innerHeight + .5; }); }));
  await picture('import-layout-768x432.png');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1120, height: 850, deviceScaleFactor: 1, mobile: false });
  await fillLayout(2, 3); await settled('importLayoutDialog', false); await previewReady();
  assert.deepEqual(await preview(), [{ id: '2', name: '二号同学', row: 1, col: 1 }, { id: '4', name: '四号同学', row: 1, col: 2 }, { id: '12', name: '十二同学', row: 1, col: 3 }, { id: '30', name: '三十同学', row: 2, col: 1 }]);
  check('确认足够尺寸后按数值学号升序排座，2 排在 12 前', true);
  await picture('import-roster-layout-preview.png');
  await applyPreview();
  check('纯名单排座结果和用户指定列数一起保存', (await state()).cols === 3 && (await state()).students.map(student => student.id).join(',') === '2,4,12,30');

  // Dimensions are a classroom layout, not merely a capacity check. Preserve
  // an entirely empty final row through import, rendering and page reload.
  await reload(await emptyState(205)); await openImport();
  await jsonPreview(rosterOnly); await settled('importLayoutDialog');
  await fillLayout(3, 2); await settled('importLayoutDialog', false); await previewReady();
  assert.deepEqual(await preview(), [{ id: '2', name: '二号同学', row: 1, col: 1 }, { id: '4', name: '四号同学', row: 1, col: 2 }, { id: '12', name: '十二同学', row: 2, col: 1 }, { id: '30', name: '三十同学', row: 2, col: 2 }]);
  await applyPreview();
  const threeRowState = await state();
  check('4 人选择 3×2 教室时保存 seatRows=3，保留完整空白末行', threeRowState.seatRows === 3 && threeRowState.cols === 2 && threeRowState.students.length === 4);
  await waitFor(() => client.evaluate(() => document.querySelectorAll('#rosterSeats > .seat').length === 6));
  check('座位管理渲染指定的全部 6 个座位，其中末行 2 个为空座', await client.evaluate(() => { const seats = Array.from(document.querySelectorAll('#rosterSeats > .seat')); return seats.length === 6 && seats.slice(-2).every(seat => seat.classList.contains('empty')) && seats.filter(seat => seat.hasAttribute('data-student')).length === 4; }));
  await reload(threeRowState);
  await waitFor(() => client.evaluate(() => document.querySelectorAll('#rosterSeats > .seat').length === 6));
  check('刷新后 3×2 尺寸和空白末行仍保持，未缩成只含学生的 2 行', (await state()).seatRows === 3 && (await state()).cols === 2 && await client.evaluate(() => document.querySelectorAll('#rosterSeats > .seat').length === 6 && document.querySelectorAll('#rosterSeats > .seat.empty').length === 2));

  const identityFixture = await client.evaluate(() => {
    const students = ['按行甲', '按行乙', '按行丙'].map((name, index) => ({ id: String(index + 1), name, row: index < 2 ? 1 : 2, col: index === 1 ? 2 : 1, idSource: 'auto', friendTargets: ['1', '2', '3'].filter(id => id !== String(index + 1)) }));
    const snapshot = DrawCore.createState(students, 75013); snapshot.demo = false; snapshot.className = '保留身份测试';
    snapshot.settings = DrawCore.settings({ strategy: 'manual', manualMode: 'normal', modes: ['normal'], directionChance: 0, timeChance: 0, friendEnabled: false, friendChance: 100, endJumpChance: 0 });
    students.forEach((student, index) => snapshot.fairnessStats[student.id] = { draws: 10 + index, positionSum: 3 + index, positionSamples: 8 });
    DrawCore.draw(snapshot, new Date('2026-10-14T06:00:00.000Z'));
    DrawCore.draw(snapshot, new Date('2026-10-14T06:00:01.000Z'));
    snapshot.settings.friendEnabled = true;
    DrawCore.draw(snapshot, new Date('2026-10-14T06:00:02.000Z'));
    return DrawCore.restoreState(snapshot);
  });
  assert.equal(identityFixture.history.at(-1).mode, 'friend', 'The retained-history fixture must contain a real friend record');
  await reload(identityFixture); await openImport();
  await jsonPreview({ students: [{ id: '33', name: '按行丙' }, { id: '11', name: '按行甲' }, { id: '22', name: '按行乙' }] }); await previewReady();
  const retainedPreview = await preview();
  check('姓名完整匹配旧座位时直接更新学号，不再询问尺寸', !await client.evaluate(() => document.getElementById('importLayoutDialog').open) && retainedPreview.every(student => { const old = identityFixture.students.find(old => old.name === student.name); return student.row === old.row && student.col === old.col; }));
  check('姓名匹配导入默认保留已有记录与长期统计', await client.evaluate(() => !document.getElementById('importResetInput').checked));
  await applyPreview(false);
  const migrated = await state(), mapping = { '1': '11', '2': '22', '3': '33' };
  check('修改学号同时保留每个人的原座位和参与状态', migrated.students.every(student => { const old = identityFixture.students.find(old => old.name === student.name); return student.id === mapping[old.id] && student.row === old.row && student.col === old.col && student.active === old.active && student.idSource === 'provided'; }));
  check('姓名身份迁移完整保留累计公平统计和本轮计数', identityFixture.students.every(old => JSON.stringify(migrated.fairnessStats[mapping[old.id]]) === JSON.stringify(identityFixture.fairnessStats[old.id]) && Number(migrated.counts[mapping[old.id]] || 0) === Number(identityFixture.counts[old.id] || 0)) && Object.keys(migrated.fairnessStats).every(id => ['11', '22', '33'].includes(id)));
  check('历史、上一人、已抽状态与 PRNG 按同一身份映射保留', migrated.round === identityFixture.round && migrated.history.length === identityFixture.history.length && migrated.history.every((record, index) => record.studentId === mapping[identityFixture.history[index].studentId] && record.time === identityFixture.history[index].time && record.name === identityFixture.history[index].name && record.before.lastId === (mapping[identityFixture.history[index].before.lastId] || null)) && migrated.lastId === mapping[identityFixture.lastId] && migrated.cycleSeen.join(',') === identityFixture.cycleSeen.map(id => mapping[id]).join(',') && migrated.rngState === identityFixture.rngState);
  check('友尽目标与友尽历史来源/候选全部迁移到新学号', migrated.students.every(student => { const old = identityFixture.students.find(old => old.name === student.name); return student.friendTargets.join(',') === old.friendTargets.map(id => mapping[id]).join(','); }) && migrated.history.at(-1).friendSourceId === mapping[identityFixture.history.at(-1).friendSourceId] && migrated.history.at(-1).friendTargetIds.join(',') === identityFixture.history.at(-1).friendTargetIds.map(id => mapping[id]).join(','));
  await reload(migrated);
  check('更新学号后的长期统计、友尽和历史跨刷新仍然保留', JSON.stringify((await state()).fairnessStats) === JSON.stringify(migrated.fairnessStats) && JSON.stringify((await state()).history) === JSON.stringify(migrated.history) && JSON.stringify((await state()).students) === JSON.stringify(migrated.students));

  await reload(await emptyState(210)); await openImport();
  await jsonPreview({ rows: 6, cols: 6, orientation: { podiumSideInImage: 'bottom', normalized: true }, students: [{ name: '图后右', id: null, row: 5, col: 5 }, { name: '图前右', id: '2', row: 2, col: 5 }, { name: '图前左', row: 2, col: 2 }, { name: '图后左', id: null, row: 5, col: 2 }] }); await previewReady();
  const imagePreview = await preview();
  check('座位 JSON 允许省略或 null 学号，由本机按坐标行优先补号', ['图前左', '图前右', '图后左', '图后右'].every((name, index) => imagePreview.find(student => student.name === name)?.id === String(index + 1)));
  check('程序删除全空行列，并保留模型已确认的实际学号', imagePreview.every(student => student.row >= 1 && student.row <= 2 && student.col >= 1 && student.col <= 2) && imagePreview.find(student => student.name === '图前右').id === '2' && await client.evaluate(() => /移除 4 个全空行和 4 个全空列/.test(document.getElementById('importWarnings').textContent)));
  await applyPreview();
  const imageState = await state();
  check('自动补号与模型提供的学号保存不同来源，后续可安全更新', imageState.students.find(student => student.name === '图前右').idSource === 'provided' && imageState.students.filter(student => student.name !== '图前右').every(student => student.idSource === 'auto'));
  await openImport();
  await jsonPreview({ students: [{ name: '图新乙', id: null, row: 3, col: 3 }, { name: '图前右', row: 1, col: 1 }, { name: '图新甲', row: 1, col: 3 }, { name: '图新丙', id: null, row: 3, col: 1 }] }); await previewReady();
  const carried = await preview();
  check('新的座位识别遗漏学号时按姓名沿用已确认旧学号，并为其他人跳过保留号码', carried.find(student => student.name === '图前右').id === '2' && carried.find(student => student.name === '图新甲').id === '1' && carried.find(student => student.name === '图新丙').id === '3' && carried.find(student => student.name === '图新乙').id === '4');
  check('沿用旧学号的提示明确指出本机匹配依据', await client.evaluate(() => document.getElementById('importWarnings').textContent.includes('沿用已确认的旧学号')));
  await applyPreview();
  check('重新识别后保留学号仍为 provided，未被当作自动号重排', (await state()).students.find(student => student.name === '图前右').idSource === 'provided');

  await reload(await emptyState(220)); await openImport();
  await click('providerSettingsBtn'); await settled('providerDialog');
  await client.evaluate(() => { const select = document.getElementById('providerPreset'); select.value = 'custom'; select.dispatchEvent(new Event('change')); });
  await fields({ apiEndpoint: 'http://127.0.0.1:9/v1/chat/completions', apiModel: 'qa-text-model', apiKey: '' });
  await submit('providerForm'); await settled('providerDialog', false);
  check('识别测试使用真实提供商设置与本机数据库，配置免密 mock 地址', await client.evaluate(async () => { const config = await VisionProviders.getConfig(); return config.provider === 'custom' && config.endpoint === 'http://127.0.0.1:9/v1/chat/completions' && config.key === ''; }));
  await tab('image');
  await client.evaluate(() => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['姓名,学号\n表格丙,12\n表格乙,2\n表格甲,\n'], '学号参考.csv', { type: 'text/csv' }));
    const input = document.getElementById('referenceFile'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitFor(() => client.evaluate(() => document.getElementById('referenceFileSummary').textContent.includes('已读取 1 个文件')));
  check('CSV 通过真实文件输入和内嵌 SheetJS 读取，单独参考表即可识别', await client.evaluate(() => !document.getElementById('referenceDetails').hidden && document.getElementById('referencePreview').textContent.includes('表格丙') && document.getElementById('imagePreview').hidden && !document.getElementById('recognizeBtn').disabled));
  const beforeModel = await client.evaluate(key => localStorage.getItem(key), KEY);
  await queueReply({ students: [{ id: '12', name: '表格丙' }, { id: '2', name: '表格乙' }, { id: null, name: '表格甲' }] });
  await click('recognizeBtn');
  check('纯表格请求进行时显示提取名单状态并锁定资料输入', await client.evaluate(() => document.getElementById('recognitionStatus').textContent.includes('正在提取名单') && document.getElementById('recognizeBtn').disabled && document.getElementById('referenceFile').disabled && !document.getElementById('cancelRecognitionBtn').hidden));
  await settled('importLayoutDialog');
  const textRequest = await client.evaluate(() => window.__importMockRequests.at(-1));
  check('纯参考表模型请求只有文字，没有假图片或 image_url', textRequest.method === 'POST' && typeof textRequest.body.messages[0].content === 'string' && !JSON.stringify(textRequest.body).includes('image_url') && !JSON.stringify(textRequest.body).includes('data:image'));
  check('纯表格提示要求正确姓名、禁止猜学号或虚构坐标，并附真实参考内容', textRequest.body.messages[0].content.includes('禁止猜测、按顺序编号') && textRequest.body.messages[0].content.includes('禁止添加 row、col、rows、cols') && textRequest.body.messages[0].content.includes('本次只有表格，没有图片') && textRequest.body.messages[0].content.includes('学号参考.csv') && textRequest.body.messages[0].content.includes('表格丙'));
  check('模型返回无坐标名单后进入尺寸确认，识别完成但名单尚未提交', await client.evaluate((key, before) => document.getElementById('recognitionStatus').textContent.includes('识别完成') && document.getElementById('importPreviewSection').hidden && localStorage.getItem(key) === before, KEY, beforeModel));
  await fillLayout(2, 2); await settled('importLayoutDialog', false); await previewReady();
  assert.deepEqual(await preview(), [{ id: '1', name: '表格甲', row: 1, col: 1 }, { id: '2', name: '表格乙', row: 1, col: 2 }, { id: '12', name: '表格丙', row: 2, col: 1 }]);
  check('真实表格识别链路完成预览，缺失学号在本机补全后再数值排序', true);
  await picture('import-table-only-preview.png');

  await click('importBackBtn');
  await client.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 72;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 96, 72); context.fillStyle = '#000'; context.fillRect(72, 8, 14, 56); context.font = '12px sans-serif'; context.fillText('讲台', 50, 20);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const transfer = new DataTransfer(); transfer.items.add(new File([blob], '讲台朝向-QA.png', { type: 'image/png' }));
    const input = document.getElementById('imageFile'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitFor(() => client.evaluate(() => !document.getElementById('imagePreview').hidden && document.getElementById('imageFileLabel').textContent.includes('讲台朝向-QA.png')));
  check('图片可与已读取参考表同时保留，返回修改不会丢失 CSV', await client.evaluate(() => document.getElementById('referenceFileSummary').textContent.includes('已读取 1 个文件') && document.getElementById('referencePreview').textContent.includes('表格甲') && document.getElementById('imagePreview').src.startsWith('data:image/png;base64,')));
  await queueReply({ rows: 5, cols: 6, orientation: { podiumSideInImage: 'right', normalized: true }, students: [{ name: '表格甲', id: null, row: 4, col: 5 }, { name: '表格乙', id: '2', row: 2, col: 2 }], uncertain: ['请核对图片姓名与参考学号'] });
  await click('recognizeBtn'); await previewReady();
  const combined = await client.evaluate(() => window.__importMockRequests.at(-1)), content = combined.body.messages[0].content;
  const prompt = content.find(part => part.type === 'text').text;
  check('图片加表格请求包含真实上传的 PNG 与参考 CSV，而没有发起外部 API', Array.isArray(content) && content.filter(part => part.type === 'image_url').length === 1 && content.find(part => part.type === 'image_url').image_url.url.startsWith('data:image/png;base64,') && prompt.includes('学号参考.csv') && await client.evaluate(() => window.__importMockRequests.length === 2 && window.__importUnexpectedRequests.length === 0));
  check('图片识别提示明确讲台方向旋转、禁止镜像、删除全空行列与不猜学号', prompt.includes('不能默认图片上方就是讲台') && prompt.includes('旋转180度') && prompt.includes('不要镜像') && prompt.includes('最后删除没有任何学生的整行和整列') && prompt.includes('以图片决定实际座位位置') && prompt.includes('没有学号时id设为null'));
  const finalPreview = await preview();
  check('图片识别完成后移除全空轴、保留单个空座，并立即展示可编辑预览', finalPreview.length === 2 && finalPreview.find(student => student.name === '表格乙').row === 1 && finalPreview.find(student => student.name === '表格乙').col === 1 && finalPreview.find(student => student.name === '表格甲').row === 2 && finalPreview.find(student => student.name === '表格甲').col === 2 && await client.evaluate(() => /移除 3 个全空行和 4 个全空列/.test(document.getElementById('importWarnings').textContent) && !document.getElementById('applyImportBtn').hidden && !document.getElementById('referenceFile').disabled));
  await picture('import-image-table-preview.png');
  check('导入识别成功只有预览，确认前原始空名单与记录保持原样', await client.evaluate((key, before) => localStorage.getItem(key) === before, KEY, beforeModel));
  await trustedClick('#importBackBtn');
  const sourceImage = await client.evaluate(() => document.getElementById('imagePreview').src);
  const imageFixture = path.join(profile, 'drop-B.png');
  await writeFile(imageFixture, Buffer.from(sourceImage.split(',')[1], 'base64'));
  await client.evaluate(() => { window.__importHoldResponses = true; });
  for (const action of ['cancel', 'tab', 'close']) {
    await tab('image');
    const beforeLate = await client.evaluate(() => ({ json: document.getElementById('visionJson').value, image: document.getElementById('imagePreview').src, label: document.getElementById('imageFileLabel').textContent }));
    await queueReply({ students: [{ id: '999', name: '迟到结果' }] });
    await trustedClick('#recognizeBtn');
    await waitFor(() => client.evaluate(() => window.__importHeldResponses.length === 1));
    if (action === 'cancel') {
      const point = await client.evaluate(() => { const e = document.getElementById('imageDrop'); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      const data = { items: [], files: [imageFixture], dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop']) await client.send('Input.dispatchDragEvent', { type, ...point, data });
      check('识别 A 期间真实拖入 B 不更换图片来源或文件标签', await client.evaluate(before => document.getElementById('imagePreview').src === before.image && document.getElementById('imageFileLabel').textContent === before.label, beforeLate));
      await trustedClick('#cancelRecognitionBtn');
      await queueReply({ students: [{ id: '998', name: '新一轮结果' }] });
      await trustedClick('#recognizeBtn');
      await waitFor(() => client.evaluate(() => window.__importHeldResponses.length === 2));
      await client.evaluate(() => window.__importHeldResponses.shift()()); await pause(100);
      check('旧识别迟到 finally 不解除新一轮输入锁', await client.evaluate(() => document.getElementById('recognizeBtn').disabled && document.getElementById('referenceFile').disabled && !document.getElementById('cancelRecognitionBtn').hidden));
      await trustedClick('#cancelRecognitionBtn');
    } else if (action === 'tab') await trustedClick('[data-import-tab="json"]');
    else {
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await waitFor(() => client.evaluate(() => document.getElementById('importDialog').dataset.motion === 'exit' || !document.getElementById('importDialog').open));
    }
    await client.evaluate(() => window.__importHeldResponses.shift()()); await pause(150);
    check(action + ' 后迟到识别不能写 JSON、打开布局或提交名单', await client.evaluate((before, storageKey, stored) => document.getElementById('visionJson').value === before.json && !document.getElementById('importLayoutDialog').open && localStorage.getItem(storageKey) === stored, beforeLate, KEY, beforeModel));
    if (action === 'close') { await settled('importDialog', false); await openImport(); }
    await tab('image');
    check(action + ' 及时解除所属识别锁', await client.evaluate(() => !document.getElementById('referenceFile').disabled && document.getElementById('cancelRecognitionBtn').hidden));
  }
  // Delay the real FileReader completion, then use a trusted file-input update.
  // The decoded PNG still goes through the application's real Image loader.
  await client.evaluate(() => { window.__qaReadAsDataURL = FileReader.prototype.readAsDataURL; window.__qaPendingImageRead = null; FileReader.prototype.readAsDataURL = function(file) { window.__qaPendingImageRead = () => window.__qaReadAsDataURL.call(this, file); }; });
  const documentNode = await client.send('DOM.getDocument');
  const imageInput = await client.send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#imageFile' });
  await client.send('DOM.setFileInputFiles', { nodeId: imageInput.nodeId, files: [imageFixture] });
  await waitFor(() => client.evaluate(() => typeof window.__qaPendingImageRead === 'function'));
  check('图片加载阶段禁用识别并隐藏旧图', await client.evaluate(() => document.getElementById('recognizeBtn').disabled && document.getElementById('imagePreview').hidden));
  await client.evaluate(() => { window.__qaImage = window.Image; window.__qaPendingDecode = null; window.Image = function(...args) { const image = new window.__qaImage(...args); Object.defineProperty(image, 'onload', { set(callback) { image.addEventListener('load', event => { window.__qaPendingDecode = () => callback.call(image, event); }, { once: true }); } }); return image; }; });
  await client.evaluate(() => { FileReader.prototype.readAsDataURL = window.__qaReadAsDataURL; window.__qaPendingImageRead(); });
  await waitFor(() => client.evaluate(() => typeof window.__qaPendingDecode === 'function'));
  check('图片已读完但解码未交付时仍禁止开始识别', await client.evaluate(() => document.getElementById('recognizeBtn').disabled && document.getElementById('imagePreview').hidden));
  await client.evaluate(() => { window.Image = window.__qaImage; window.__qaPendingDecode(); });
  await waitFor(() => client.evaluate(() => !document.getElementById('imagePreview').hidden && !document.getElementById('recognizeBtn').disabled));
  check('真实 PNG 读取并解码成功后才重新允许识别', await client.evaluate(() => document.getElementById('imagePreview').complete && document.getElementById('imagePreview').naturalWidth > 0));
  check('整个导入浏览器检查没有未处理 JavaScript 异常', client.errors.length === 0);
  const finalArtifact = await readFile(artifactPath);
  check('浏览器检查期间构建产物保持一致，报告绑定实际单文件 SHA256', finalArtifact.length === artifactBytes && createHash('sha256').update(finalArtifact).digest('hex') === artifactSha256);
  await writeFile(path.join(output, 'import-report.json'), JSON.stringify({ completedAt: new Date().toISOString(), artifactBytes, artifactSha256, checks, runtimeErrors: client.errors, screenshots }, null, 2));
  console.log('Import browser QA complete: ' + checks.length + ' checks');
} catch (error) {
  let diagnostic;
  try {
    diagnostic = await client?.evaluate(key => ({ dialogs: Array.from(document.querySelectorAll('dialog')).map(dialog => ({ id: dialog.id, open: dialog.open, motion: dialog.dataset.motion || '' })), importError: document.getElementById('importError')?.textContent, layoutError: document.getElementById('importLayoutError')?.textContent, recognitionStatus: document.getElementById('recognitionStatus')?.textContent, previewHidden: document.getElementById('importPreviewSection')?.hidden, requests: window.__importMockRequests, unexpectedRequests: window.__importUnexpectedRequests, state: JSON.parse(localStorage.getItem(key)) }), KEY);
    if (client) await picture('import-failure.png');
  } catch (_) {}
  await writeFile(path.join(output, 'import-partial-report.json'), JSON.stringify({ completedAt: new Date().toISOString(), artifactBytes, artifactSha256, failedAfter: lastLabel, error: error.stack, checks, runtimeErrors: client?.errors || [], diagnostic, screenshots }, null, 2));
  throw error;
} finally {
  if (client) { try { await client.send('Browser.close'); } catch (_) {} client.ws.close(); }
  if (browser && !browser.killed) browser.kill();
  await pause(500);
  const resolved = await realpath(profile).catch(() => null);
  if (resolved && path.dirname(resolved) === parent && path.basename(resolved).startsWith('SlateRandom-import-')) await rm(resolved, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
