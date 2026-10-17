import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import engine from '../../../../src/renderer/domain/engine';
import * as importsDomain from '../../../../src/renderer/domain/import';
import type { ClassState } from '../../../../src/shared/domain/model';

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void }

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class Element {
  value = ''; textContent = ''; hidden = false; disabled = false; checked = false; open = false; src = ''; innerHTML = '';
  dataset: Record<string, string> = {};
  listeners = new Map<string, (() => unknown)[]>();
  addEventListener(type: string, callback: () => unknown) { this.listeners.set(type, [...this.listeners.get(type) || [], callback]); }
  emit(type: string) { for (const callback of this.listeners.get(type) || []) callback(); }
  removeAttribute() {}
}
function harness() {
  const elements = new Map<string, Element>();
  const $ = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const reads: { result: string; onload(): void; onerror(): void }[] = [];
  const decodes: { onload(): void; onerror(): void }[] = [];
  const requests: { imageData: string; signal: AbortSignal; result: Deferred<string> }[] = [];
  const config = { load: () => Promise.resolve({}) };
  const intervals = new Set<unknown>();
  let closeStart = () => {}, confirmation: { title: string; text: string; label: string; action(): void } | null = null;
  let previewRows: unknown[] = [], saves = 0, renders = 0, saved = true;
  const context = {
    $, $$: (selector: string) => selector === '[data-preview-row]' ? previewRows : [],
    state: engine.createState([{ id: '1', name: '甲', row: 1, col: 1 }, { id: '2', name: '乙', row: 1, col: 2 }], 41),
    busy: false, recoveryRequired: false, recognitionBusy: false, recognitionController: null as AbortController | null,
    referenceReadVersion: 0, imageReadVersion: 0, referenceLoading: false,
    referenceSheets: [] as { fileName: string; sheetName: string; rows: string[][] }[], imageData: null as string | null,
    activeImportTab: 'image', previewStudents: null as unknown, previewCols: 2,
    resultVisible: true, swapFirst: null, swapMode: false, historyPage: 0, saveError: '保存失败',
    available() { return !this.busy && !this.recoveryRequired; },
    show(dialog: Element) { dialog.open = true; }, escape: (value: unknown) => String(value),
    save() { saves++; return saved; }, render() { renders++; }, setView() {}, toast() {},
    requestConfirm(title: string, text: string, label: string, action: () => void) { confirmation = { title, text, label, action }; }
  };
  const exports: Record<string, (context: unknown) => any> = {};
  const source = ts.transpileModule(readFileSync('src/renderer/scene/imports.js', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  vm.runInNewContext(source, {
    exports, require: (name: string) => name.endsWith('/engine') ? engine : importsDomain,
    AbortController, Date, TextDecoder, Uint8Array,
    setInterval: (callback: unknown) => { intervals.add(callback); return callback; }, clearInterval: (id: unknown) => intervals.delete(id),
    FileReader: class { result = ''; onload = () => {}; onerror = () => {}; readAsDataURL() { reads.push(this); } },
    Image: class { onload = () => {}; onerror = () => {}; set src(_value: string) { decodes.push(this); } },
    window: {
      DialogTransitions: { register: (_dialog: Element, options: { onCloseStart(): void }) => { closeStart = options.onCloseStart; }, close: async (dialog: Element) => { dialog.open = false; dialog.emit('close'); } },
      VisionProviders: { getConfig: () => config.load(), recognize: (input: { imageData: string; signal: AbortSignal }) => { const result = deferred<string>(); requests.push({ ...input, result }); return result.promise; } },
      XLSX: { read: () => ({ SheetNames: ['名单'], Sheets: { 名单: { '!ref': 'A1:B1' } } }), utils: { decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }), sheet_to_json: () => [['1', '甲']] } }
    }
  });
  const api = exports.createImports!(context);
  $('importDialog').open = true;
  const image = (name = 'A.png') => ({ name, type: 'image/png', size: 100 });
  const finishRead = async (index: number, data: string) => { reads[index]!.result = data; reads[index]!.onload(); await tick(); decodes[decodes.length - 1]!.onload(); await tick(); };
  const preparePreview = () => {
    api.showImportPreview(engine.clone(context.state.students), 2, [], { '1': '1', '2': '2' });
    previewRows = context.state.students.map((student, index) => ({ dataset: { previewRow: String(index) }, querySelectorAll: () => Object.entries({ id: student.id, name: student.name, row: String(student.row), col: String(student.col) }).map(([field, value]) => ({ dataset: { field }, value })) }));
  };
  return { api, context, $, reads, decodes, requests, config, intervals, image, finishRead, preparePreview,
    closeStart: () => { $('importDialog').dataset.motion = 'exit'; closeStart(); },
    confirmation: () => confirmation, saves: () => saves, renders: () => renders, failSave: () => { saved = false; } };
}
const response = JSON.stringify({ rows: 1, cols: 1, students: [{ id: '3', name: '丙', row: 1, col: 1 }] });

test('image loading covers decoding; overlapping reads cannot unlock the latest decode', async () => {
  const h = harness();
  const first = h.api.readImage(h.image());
  h.reads[0]!.result = 'data:A'; h.reads[0]!.onload(); await tick();
  await h.api.recognizeImage();
  assert.equal(h.$('importError').textContent, '正在读取图片，请稍等。');
  assert.equal(h.requests.length, 0);
  const second = h.api.readImage(h.image('B.png'));
  h.decodes[0]!.onload(); await first;
  assert.equal(h.$('recognizeBtn').disabled, true);
  await h.finishRead(1, 'data:B'); await second;
  assert.equal(h.context.imageData, 'data:B');
  assert.equal(h.$('recognizeBtn').disabled, false);
});

test('recognition keeps its source; all image entry calls and reference clearing are refused while busy', async () => {
  const h = harness(); h.context.imageData = 'data:A';
  h.context.referenceSheets = [{ fileName: 'old.csv', sheetName: '名单', rows: [['甲']] }];
  const run = h.api.recognizeImage(); await tick();
  await h.api.readImage(h.image('drop-B.png'));
  h.api.clearReferenceSheets(); h.$('clearImageBtn').emit('click');
  assert.equal(h.reads.length, 0); assert.equal(h.context.imageData, 'data:A');
  assert.equal(h.context.referenceSheets.length, 1); assert.equal(h.requests[0]!.imageData, 'data:A');
  h.requests[0]!.result.resolve(response); await run;
  assert.equal(h.$('visionJson').value, response); assert.equal(h.context.recognitionBusy, false);
});

test('cancel releases immediately and late finally cannot unlock a new recognition', async () => {
  const h = harness(); h.context.imageData = 'data:A';
  const first = h.api.recognizeImage(); await tick(); h.api.cancelRecognition();
  assert.equal(h.requests[0]!.signal.aborted, true); assert.equal(h.context.recognitionBusy, false);
  const second = h.api.recognizeImage(); await tick();
  h.requests[0]!.result.resolve(response); await first;
  assert.equal(h.context.recognitionBusy, true); assert.equal(h.$('imageFile').disabled, true);
  assert.equal(h.$('visionJson').value, '');
  h.requests[1]!.result.resolve(response); await second;
  assert.equal(h.context.recognitionBusy, false); assert.equal(h.intervals.size, 0);
});

for (const exit of ['tab', 'exit', 'native-close'] as const) test(`recognition result after ${exit} is ignored`, async () => {
  const h = harness(); h.context.imageData = 'data:A';
  const run = h.api.recognizeImage(); await tick();
  if (exit === 'tab') h.api.switchImportTab('json');
  else if (exit === 'exit') h.closeStart();
  else { h.$('importDialog').open = false; h.$('importDialog').emit('close'); }
  h.requests[0]!.result.resolve(response); await run;
  assert.equal(h.requests[0]!.signal.aborted, true); assert.equal(h.$('visionJson').value, '');
  assert.equal(h.context.previewStudents, null); assert.equal(h.$('importLayoutDialog').open, false);
});

test('cancelling during config lookup prevents a late provider call', async () => {
  const h = harness(), config = deferred<object>(); h.config.load = () => config.promise;
  h.context.imageData = 'data:A'; const run = h.api.recognizeImage(); h.api.cancelRecognition();
  config.resolve({}); await run;
  assert.equal(h.requests.length, 0); assert.equal(h.context.recognitionBusy, false);
});

test('provider-owned timeout shows timeout copy and releases the run without a scene deadline', async () => {
  const h = harness(); h.context.imageData = 'data:A';
  const error = new Error('provider deadline'); error.name = 'TimeoutError';
  h.config.load = () => Promise.reject(error);
  await h.api.recognizeImage();
  assert.equal(h.$('recognitionStatus').textContent, '识别已超时，请重试或使用「识别结果」导入。');
  assert.equal(h.context.recognitionBusy, false); assert.equal(h.intervals.size, 0);
});

test('read errors release loading and busy/recovery guards reject all new import reads', async () => {
  const h = harness();
  const read = h.api.readImage(h.image()); h.reads[0]!.onerror(); await read;
  assert.equal(h.$('recognizeBtn').disabled, false);
  assert.equal(h.$('importError').textContent, '无法读取这张图片');
  for (const guard of ['busy', 'recoveryRequired'] as const) {
    h.context[guard] = true;
    await h.api.readImage(h.image());
    let attempted = false;
    await h.api.readReferenceFiles([{ name: 'roster.csv', size: 1, arrayBuffer: () => { attempted = true; return Promise.resolve(new ArrayBuffer(0)); } }]);
    await h.api.recognizeImage();
    assert.equal(attempted, false); assert.equal(h.reads.length, 1); assert.equal(h.requests.length, 0);
    h.context[guard] = false;
  }
});

test('restore invalidation rejects image and reference reads even after busy clears', async () => {
  const h = harness(), bytes = deferred<ArrayBuffer>();
  const image = h.api.readImage(h.image());
  const reference = h.api.readReferenceFiles([{ name: 'roster.csv', size: 10, arrayBuffer: () => bytes.promise }]);
  h.context.busy = true; h.api.invalidatePendingReads(); h.context.busy = false;
  bytes.resolve(new TextEncoder().encode('1,甲').buffer); await reference;
  await h.finishRead(0, 'data:old'); await image;
  assert.equal(h.context.imageData, null); assert.equal(h.context.referenceSheets.length, 0);
  assert.equal(h.$('imagePreview').hidden, true); assert.equal(h.$('recognizeBtn').disabled, false);
});

test('shared availability keeps recognition disabled until image and reference reads both finish', async () => {
  const h = harness(), bytes = deferred<ArrayBuffer>();
  const image = h.api.readImage(h.image());
  const reference = h.api.readReferenceFiles([{ name: 'roster.csv', size: 10, arrayBuffer: () => bytes.promise }]);
  bytes.resolve(new TextEncoder().encode('1,甲').buffer); await reference;
  assert.equal(h.$('recognizeBtn').disabled, true);
  await h.finishRead(0, 'data:A'); await image;
  assert.equal(h.$('recognizeBtn').disabled, false);
});

function withStatistics(h: { context: { state: ClassState } }) {
  h.context.state.settings = engine.settings({ strategy: 'manual', manualMode: 'normal', friendEnabled: false, endJumpEnabled: false });
  engine.draw(h.context.state, new Date('2026-10-17T12:00:00Z'));
}
test('existing roster defaults to preserving confirmed identities and long-term statistics', () => {
  const h = harness(); withStatistics(h);
  const fairness = engine.clone(h.context.state.fairnessStats);
  h.api.openImport(); assert.equal(h.$('importResetInput').checked, false);
  h.preparePreview(); h.api.applyImport();
  assert.deepEqual(h.context.state.fairnessStats, fairness); assert.equal(h.saves(), 1); assert.equal(h.confirmation(), null);
  h.context.state = engine.createEmptyState(); h.api.openImport(); assert.equal(h.$('importResetInput').checked, true);
});

test('explicit rebuild prepares a legal state but cancellation leaves all actual state untouched', () => {
  const h = harness(); withStatistics(h); h.api.openImport(); h.preparePreview();
  h.$('importResetInput').checked = true;
  const before = engine.clone(h.context.state), identity = h.context.state;
  h.api.applyImport();
  assert.equal(h.context.state, identity); assert.deepEqual(h.context.state, before); assert.equal(h.saves(), 0); assert.equal(h.renders(), 0);
  const confirmation = h.confirmation()!;
  assert.equal(confirmation.text, '将替换当前名单，并清空当前班级的抽取记录、当前进度和长期公平统计。此操作无法撤销，请先导出全部备份。');
  assert.equal(confirmation.label, '清空统计并导入');
  // Invoking no action is cancellation. A later explicit confirmation commits the already prepared roster.
  h.$('importClassInput').value = '不应迟到读取的名称';
  confirmation.action();
  assert.equal(h.context.state.history.length, 0); assert.equal(h.context.state.round, 0); assert.equal(h.saves(), 1);
  assert.notEqual(h.context.state.className, '不应迟到读取的名称');
  assert.notDeepEqual(h.context.state.fairnessStats, before.fairnessStats);
});

test('failed regular import save preserves the import form and error', () => {
  const h = harness(); h.api.openImport(); h.preparePreview(); h.failSave(); h.api.applyImport();
  assert.equal(h.saves(), 1); assert.equal(h.$('importDialog').open, true);
  assert.equal(h.$('importError').textContent, '保存失败');
});
