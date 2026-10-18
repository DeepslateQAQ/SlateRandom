import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { Hct, argbFromHex, hexFromArgb } from '@material/material-color-utilities';
import engine from '../../../../src/renderer/domain/engine';
import * as backup from '../../../../src/renderer/domain/backup';
import * as rosterImport from '../../../../src/renderer/domain/import';
import type { ClassState } from '../../../../src/shared/domain/model';
import { BrowserClassRepository, CLASS_STORAGE_KEY } from '../../../../src/renderer/platform/browser';
import type { BinaryDownload, ClassLoadResult, ClassRepository, StorageLike, TextDownload } from '../../../../src/renderer/platform/ports';
import { createAppStore } from '../../../../src/renderer/application/store';
import type { AppSnapshot, AppStore } from '../../../../src/renderer/application/store';
import * as initialState from '../../../../src/renderer/application/initial-state';
import * as pressIntent from '../../../../src/renderer/application/press-intent';
import type { ApplicationActions, ControllerDependencies } from '../../../../src/renderer/application/controller';
import type { DesktopSettings } from '../../../../src/renderer/desktop/types';

type Scope = 'vision' | 'speech';
type Credentials = Required<backup.BackupCredentials>;
type ProviderSettings = backup.ProviderSettings;
const copy = engine.clone;
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));
async function eventually(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await checkpoint();
  }
  assert.fail(message);
}
interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function configured(name = '原班级', rounds = 2) {
  const state = engine.createState(Array.from({ length: 4 }, (_, index) => ({ id: String(index + 1), name: name + (index + 1), row: 1, col: index + 1 })), 617);
  state.className = name; state.cols = 4; state.seatRows = 1;
  state.settings = engine.settings({ strategy: 'manual', manualMode: 'normal', friendEnabled: false, endJumpEnabled: false, voice: false });
  for (let round = 0; round < rounds; round++) engine.draw(state, new Date('2026-10-15T08:09:10Z'));
  return state;
}
export const oldCredentials: Credentials = { vision: { active: 'vision-fixture', records: [{ provider: 'vision-fixture', key: 'old-vision-fixture' }] }, speech: { active: 'speech-fixture', records: [{ provider: 'speech-fixture', key: 'old-speech-fixture' }] } };
export const nextCredentials: Credentials = { vision: { active: 'vision-fixture', records: [{ provider: 'vision-fixture', key: 'next-vision-fixture' }] }, speech: { active: 'speech-fixture', records: [{ provider: 'speech-fixture', key: 'next-speech-fixture' }] } };

// These DOM surfaces implement the controller's event contract, not its behavior.
// Only stage/camera presentation is replaced; import, draw, restore and save logic
// run unchanged in their own VM, without modifying browser globals or production APIs.
type Listener = (event: FakeEvent) => unknown;
interface FakeEvent { target: FakeElement | FakeDom; type: string; defaultPrevented: boolean; preventDefault(): void; stopPropagation(): void; [key: string]: unknown }
class FakeEvents {
  readonly listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); }
  removeEventListener(type: string, listener: Listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener)); }
  invoke(type: string, event: FakeEvent) { return (this.listeners.get(type) || []).map(listener => listener(event)); }
}
class FakeElement extends FakeEvents {
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly classNames = new Set<string>();
  readonly classList = {
    add: (...items: string[]) => items.forEach(item => this.classNames.add(item)),
    remove: (...items: string[]) => items.forEach(item => this.classNames.delete(item)),
    contains: (item: string) => this.classNames.has(item),
    toggle: (item: string, force?: boolean) => { const on = force ?? !this.classNames.has(item); if (on) this.classNames.add(item); else this.classNames.delete(item); return on; }
  };
  readonly style: Record<string, unknown> & { setProperty(key: string, value: unknown): void; removeProperty(key: string): void } = {
    setProperty(key, value) { this[key] = String(value); }, removeProperty(key) { delete this[key]; }
  };
  textContent = ''; hidden = false; disabled = false; checked = false; open = false; required = false; clicks = 0;
  files: unknown[] = []; children: FakeElement[] = []; parent: FakeElement | null = null;
  private fieldValue = ''; private markup = '';
  constructor(readonly id: string, readonly dom: FakeDom, readonly tagName = 'button') { super(); }
  get value() { return this.fieldValue; }
  set value(value: unknown) { this.fieldValue = String(value); }
  get innerHTML() { return this.markup; }
  set innerHTML(value: string) {
    this.markup = value;
    if (this.id !== 'importPreviewTable') return;
    const decode = (text: string) => text.replace(/&quot;|&#39;|&lt;|&gt;|&amp;/g, entity => ({ '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' })[entity]!);
    this.children = Array.from(value.matchAll(/<tr data-preview-row="(\d+)">([\s\S]*?)<\/tr>/g), row => {
      const element = new FakeElement('', this.dom, 'tr'); element.dataset.previewRow = row[1]!;
      element.children = Array.from(row[2]!.matchAll(/<input\b([^>]+)>/g), match => {
        const field = new FakeElement('', this.dom, 'input'); field.dataset.field = /data-field="([^"]+)"/.exec(match[1]!)![1]!;
        field.value = decode(/value="([^"]*)"/.exec(match[1]!)![1]!); field.parent = element; return field;
      });
      element.parent = this; return element;
    });
  }
  matches(selector: string): boolean {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part));
    if (selector === 'dialog[open]') return this.tagName === 'dialog' && this.open;
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    const data = /^\[data-([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (data) { const key = data[1]!.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()); return key in this.dataset && (data[2] === undefined || this.dataset[key] === data[2]); }
    return selector === this.tagName;
  }
  closest(selector: string): FakeElement | null { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
  querySelectorAll(selector: string): FakeElement[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  setAttribute(key: string, value: unknown) { this.attributes.set(key, String(value)); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  removeAttribute(key: string) { this.attributes.delete(key); }
  insertAdjacentHTML() {}
  getClientRects() { return [{}]; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100 }; }
  hasPointerCapture() { return false; }
  setPointerCapture() {}
  releasePointerCapture() {}
  focus() {}
  select() {}
  click() { this.clicks++; void this.dom.emit(this, 'click'); }
}
class FakeDom extends FakeEvents {
  readonly elements = new Map<string, FakeElement>();
  readonly screen = new FakeElement('drawScreen', this, 'main');
  hidden = false;
  getElementById = (id: string) => {
    let element = this.elements.get(id);
    if (!element) { element = new FakeElement(id, this, id.endsWith('Dialog') ? 'dialog' : id.endsWith('Form') ? 'form' : /Input$|File$/.test(id) ? 'input' : 'button'); this.elements.set(id, element); }
    return element;
  };
  querySelector = (selector: string) => selector === '.draw-screen' ? this.screen : this.querySelectorAll(selector)[0] || null;
  querySelectorAll = (selector: string): FakeElement[] => Array.from(this.elements.values()).flatMap(element => [...(element.matches(selector) ? [element] : []), ...element.querySelectorAll(selector)]);
  async emit(target: FakeElement | FakeDom, type: string, detail: Record<string, unknown> = {}, bubble = true) {
    let stopped = false;
    const event: FakeEvent = { target, type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { stopped = true; }, ...detail };
    const work = target.invoke(type, event); if (bubble && target !== this && !stopped) work.push(...this.invoke(type, event));
    await Promise.all(work);
  }
  async delegate(dataset: Record<string, string>) { const target = new FakeElement('', this); Object.assign(target.dataset, dataset); await this.emit(target, 'click'); }
}
class Clock {
  private sequence = 0;
  readonly timers = new Map<number, { callback: () => void; milliseconds: number; interval: boolean }>();
  setTimeout = (callback: () => void, milliseconds: number) => { const id = ++this.sequence; this.timers.set(id, { callback, milliseconds, interval: false }); return id; };
  setInterval = (callback: () => void, milliseconds: number) => { const id = ++this.sequence; this.timers.set(id, { callback, milliseconds, interval: true }); return id; };
  clear = (id: number) => { this.timers.delete(id); };
  fire(milliseconds: number) { for (const [id, timer] of Array.from(this.timers)) if (!timer.interval && timer.milliseconds === milliseconds) { this.timers.delete(id); timer.callback(); } }
}
class FaultStorage implements StorageLike {
  readonly items = new Map<string, string>();
  readonly classWrites: ClassState[] = [];
  failClassWrites = 0; failRecoveryWrites = false; readError: Error | null = null; readNull = false;
  afterClassWrite?: () => void;
  getItem(key: string) { if (this.readError) throw this.readError; return this.readNull ? null : this.items.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (key === CLASS_STORAGE_KEY) {
      this.classWrites.push(JSON.parse(value) as ClassState);
      if (this.failClassWrites > 0) { this.failClassWrites--; throw new Error('class-save fixture failure'); }
    } else if (this.failRecoveryWrites) throw new Error('recovery-copy fixture failure');
    this.items.set(key, value); if (key === CLASS_STORAGE_KEY) this.afterClassWrite?.();
  }
}
class Provider {
  readonly imports: ProviderSettings[] = [];
  readonly exports: { includeSecrets: boolean }[] = [];
  readonly faults = new Map<number, { before?: boolean; message: string }>();
  readonly importGates = new Map<number, Deferred<void>>();
  readonly importStarted = new Map<number, Deferred<void>>();
  readonly reloadStarted = deferred();
  readonly recognitionStarted = deferred<AbortSignal>();
  readonly presets: { id: string }[];
  initOptions!: { canWrite: () => boolean };
  reloadGate?: Deferred<void>;
  reloadError: Error | null = null;
  reloads = 0; stops = 0; playing = false;
  loaded: ProviderSettings;
  constructor(readonly scope: Scope, readonly vault: Credentials, readonly trace: string[]) { this.loaded = copy(vault[scope]); this.presets = [{ id: vault[scope].active }]; }
  init(options: { canWrite: () => boolean }) { this.initOptions = options; }
  async exportSettings(options: { includeSecrets: boolean }) {
    this.trace.push(this.scope + '.export'); this.exports.push(copy(options));
    const value = copy(this.vault[this.scope]);
    // Mirrors the real providers: keys are only part of the snapshot on request.
    if (!options.includeSecrets) value.records = value.records.map(record => { const clean = { ...record }; delete clean.key; return clean; });
    return value;
  }
  async prepareSettings(value: ProviderSettings) { return copy(value); }
  async importSettings(value: ProviderSettings) {
    const number = this.imports.push(copy(value)); this.trace.push(this.scope + '.import.' + number); this.importStarted.get(number)?.resolve();
    const fault = this.faults.get(number); if (fault?.before) throw new Error(fault.message);
    this.vault[this.scope] = copy(value); this.loaded = copy(value);
    await this.importGates.get(number)?.promise;
    if (fault) throw new Error(fault.message);
  }
  async reloadSettings() {
    this.reloads++; this.trace.push(this.scope + '.reload'); this.reloadStarted.resolve();
    await this.reloadGate?.promise;
    if (this.reloadError) throw this.reloadError;
    this.loaded = copy(this.vault[this.scope]);
  }
  stop() { this.stops++; this.playing = false; }
  async speak() { this.playing = true; }
  async getConfig() { return {}; }
  recognize({ signal }: { signal: AbortSignal }) {
    this.recognitionStarted.resolve(signal);
    return new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new Error('recognition aborted')), { once: true }));
  }
}
/** Contract of the real portable-data bridge; the smoke script injects its own adapter. */
export interface NativeDataInfo { directory: string; portable: boolean; generation?: string | null; error?: string }
export interface NativeDataPayload { state: ClassState; credentials: Credentials }
export type NativeDataOutcome = { status: 'committed'; generation: string } | { status: 'pending-recovery'; generation: string; message: string };
export interface NativeDataAdapter {
  readonly preview: boolean;
  loadClass(): ClassState;
  info(): Promise<NativeDataInfo>;
  restoreAll(payload: NativeDataPayload): Promise<NativeDataOutcome>;
}
export class NativeData implements NativeDataAdapter {
  readonly preview = false;
  readonly generation = 'fixture-generation';
  readonly restores: NativeDataPayload[] = [];
  readonly infoStarted = deferred();
  persisted: ClassState;
  pending: NativeDataPayload | null = null;
  committed = false; loadError: Error | null = null; restoreError: Error | null = null; infoError: Error | null = null;
  infoValue?: NativeDataInfo; infoGate?: Deferred<NativeDataInfo>;
  constructor(initial: ClassState, readonly vault: Credentials, readonly trace: string[], readonly status: 'committed' | 'pending-recovery') { this.persisted = copy(initial); }
  loadClass() {
    this.trace.push(this.committed ? 'native.load.forward' : 'native.load.before');
    if (this.committed && this.loadError) throw this.loadError;
    if (this.pending) { this.persisted = copy(this.pending.state); Object.assign(this.vault, copy(this.pending.credentials)); this.pending = null; }
    return copy(this.persisted);
  }
  async info(): Promise<NativeDataInfo> {
    if (!this.committed) return { directory: 'fixture/data', portable: true };
    this.trace.push('native.info'); this.infoStarted.resolve();
    if (this.infoError) throw this.infoError;
    return this.infoGate ? this.infoGate.promise : this.infoValue || { directory: 'fixture/data', portable: true, generation: this.generation };
  }
  async restoreAll(payload: NativeDataPayload): Promise<NativeDataOutcome> {
    this.restores.push(copy(payload)); this.trace.push('native.restore');
    if (this.restoreError) throw this.restoreError;
    this.committed = true;
    if (this.status === 'pending-recovery') this.pending = copy(payload);
    else { this.persisted = copy(payload.state); Object.assign(this.vault, copy(payload.credentials)); }
    return this.status === 'pending-recovery' ? { status: this.status, generation: this.generation, message: 'forward recovery required' } : { status: this.status, generation: this.generation };
  }
  get committedState() { return this.pending?.state || this.persisted; }
}

type LoadOverride = (fallback: ClassState) => ClassLoadResult;
interface FriendControls { commitTargets(source: string, targets: string[]): boolean; isBusy(): boolean }
interface RenderStyleControls { onChange(style: string): Promise<boolean> }
interface ImportRequest { kind: string; name?: string; bytes?: Uint8Array }
/** The controller reaches the host through `window`; tests need the same object. */
export interface FakeWindow extends FakeEvents {
  location: { href: string };
  __slateRendererReady?: boolean;
  __slateTriggerDraw?: () => boolean;
  slateDesktop?: { role?: string; onImportRequest?(callback: (payload: ImportRequest) => void): () => void; [key: string]: unknown };
  [key: string]: unknown;
}
/** Everything a behavioral test (or the /tmp smoke script) needs to drive and inspect a mounted controller. */
export interface Harness {
  previous: ClassState;
  next: ClassState;
  trace: string[];
  vault: Credentials;
  window: FakeWindow;
  dom: FakeDom;
  clock: Clock;
  storage: FaultStorage;
  native: NativeData | null;
  adapter: NativeDataAdapter | null;
  vision: Provider;
  speech: Provider;
  loadFallbacks: ClassState[];
  nativeSaves: ClassState[];
  store: AppStore;
  closed: string[];
  downloads: (TextDownload | BinaryDownload)[];
  desktopUpdates: Partial<DesktopSettings>[];
  desktopUpdateFlags: (boolean | undefined)[];
  importCallbacks: ((payload: ImportRequest) => void)[];
  clipboardWrites: string[];
  hostEvent(type: string, detail: unknown): Promise<void>;
  actions: ApplicationActions;
  element(id: string): FakeElement;
  click(id: string): Promise<void>;
  submit(id: string): Promise<void>;
  importDocument(kind: backup.BackupKind, value: unknown): Promise<void>;
  stageRestore(): Promise<void>;
  stagePartial(kind: 'roster' | 'settings'): Promise<void>;
  restore(): Promise<void>;
  readonly snapshot: AppSnapshot;
  readonly friend: FriendControls;
  readonly renderStyle: RenderStyleControls;
  overrideLoad(value: LoadOverride | null): void;
}
export function harness(options: { native?: 'committed' | 'pending-recovery'; nativeData?: NativeDataAdapter; recovery?: boolean; initial?: ClassState } = {}): Harness {
  const injected = options.nativeData;
  const previous = options.initial ? copy(options.initial) : injected ? copy(injected.loadClass()) : configured(), next = configured('恢复班级', 3), trace: string[] = [], vault = copy(oldCredentials);
  const dom = new FakeDom(), clock = new Clock(), storage = new FaultStorage(), downloads: (TextDownload | BinaryDownload)[] = [], desktopUpdates: Partial<DesktopSettings>[] = [], desktopUpdateFlags: (boolean | undefined)[] = [], importCallbacks: ((payload: ImportRequest) => void)[] = [], clipboardWrites: string[] = [];
  storage.items.set(CLASS_STORAGE_KEY, JSON.stringify(previous));
  const native = options.native ? new NativeData(previous, vault, trace, options.native) : null;
  const adapter: NativeDataAdapter | null = injected || native;
  const vision = new Provider('vision', vault, trace), speech = new Provider('speech', vault, trace);
  const browser = new BrowserClassRepository(storage), loadFallbacks: ClassState[] = [], nativeSaves: ClassState[] = [];
  let loadOverride: LoadOverride | null = null;
  const repository: ClassRepository = {
    load(fallback) {
      loadFallbacks.push(copy(fallback));
      if (loadOverride) return loadOverride(fallback);
      if (options.recovery && loadFallbacks.length === 1) return { state: copy(previous), fromStorage: false, warning: 'fixture requires full recovery', recoveryRequired: true, saveError: 'fixture requires full recovery' };
      return adapter ? { state: copy(adapter.loadClass()), fromStorage: true, warning: '' } : browser.load(fallback);
    },
    save(state) { if (adapter) nativeSaves.push(copy(state)); else browser.save(state); }
  };
  const store = createAppStore(previous), closed: string[] = [], modals: FakeElement[] = [];
  let friendOptions!: FriendControls;
  let renderStyleOptions!: RenderStyleControls;
  const friend = { init(value: FriendControls) { friendOptions = value; }, sync() {}, hide() {}, select() {} };
  const window = Object.assign(new FakeEvents(), {
    location: { href: 'https://slate.example/' }, VisionProviders: vision, SpeechProviders: speech, FriendSeatConfig: friend,
    DialogTransitions: {
      init() {}, register() {},
      topModal() { return modals.at(-1) || null; },
      async open(dialog: FakeElement) { dialog.open = true; if (!modals.includes(dialog)) modals.push(dialog); },
      async close(dialog: FakeElement) {
        dialog.open = false; closed.push(dialog.id);
        const index = modals.indexOf(dialog); if (index >= 0) modals.splice(index, 1);
        await dom.emit(dialog, 'close', {}, false);
      }
    },
    RenderStyleUI: { init(value: RenderStyleControls) { renderStyleOptions = value; }, sync() {} },
    SeatTransitions: { async enter() {}, async exit() {}, clear() {} }, FriendTransitions: { async play() {}, clear() {} },
    matchMedia: () => ({ matches: true }),
    ...(adapter ? { slateDesktop: { role: 'main', data: adapter, state: async () => ({ settings: {} }),
      updateSettings: async (patch: Partial<DesktopSettings>) => { desktopUpdates.push(copy(patch)); desktopUpdateFlags.push(nativeSaves.at(-1)?.settings.onboardingCompleted); return { settings: {}, runtime: {} }; },
      onImportRequest(callback: (payload: ImportRequest) => void) {
        importCallbacks.push(callback);
        return () => { const index = importCallbacks.indexOf(callback); if (index >= 0) importCallbacks.splice(index, 1); };
      } } } : {})
  }) as unknown as FakeWindow;
  const sandbox = vm.createContext({
    window, document: dom, FriendSeatConfig: friend, URL, Date, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, AbortController,
    btoa, atob, crypto: globalThis.crypto, Blob, CompressionStream, DecompressionStream,
    navigator: { clipboard: { writeText: async (text: string) => { clipboardWrites.push(text); } } }, console, queueMicrotask, performance: { now: () => 0 },
    setTimeout: clock.setTimeout, clearTimeout: clock.clear, setInterval: clock.setInterval, clearInterval: clock.clear,
    requestAnimationFrame: (callback: (time: number) => void) => { queueMicrotask(() => callback(0)); return 1; }, cancelAnimationFrame() {},
    getComputedStyle: () => ({ transform: 'none', backgroundColor: 'black', borderTopWidth: '0px', color: 'black' }),
    FileReader: class { result = 'data:image/png;base64,fixture'; onload?: () => void; readAsDataURL() { queueMicrotask(() => this.onload?.()); } },
    Image: class { onload?: () => void; set src(_: string) { queueMicrotask(() => this.onload?.()); } }
  });
  const modules: Record<string, unknown> = {
    '../domain/engine': { __esModule: true, default: engine }, '../domain/backup': backup, '../domain/import': rosterImport,
    '../domain/analysis': { buildAnalysisReport: () => ({ format: 'SlateRandom.analysis', version: 1 }) },
    './press-intent': pressIntent, './initial-state': initialState, vue: { nextTick: (callback: () => void) => Promise.resolve().then(callback) },
    '@material/material-color-utilities': { Hct, argbFromHex, hexFromArgb },
    '../scene/reference-markup.js': { referenceMarkup: '' }
  };
  function load(file: string): Record<string, unknown> {
    const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: file }).outputText;
    const module = { exports: {} };
    const evaluate = vm.runInContext('(function(require,module,exports){\n' + source + '\n})', sandbox, { filename: file }) as (require: (name: string) => unknown, module: { exports: object }, exports: object) => void;
    evaluate(name => { if (!(name in modules)) throw new Error('Uninjected controller dependency: ' + name); return modules[name]; }, module, module.exports);
    return module.exports;
  }
  const nothing = () => {};
  modules['../scene/stage.js'] = { createStage: () => Object.fromEntries(['renderStage', 'renderSeats', 'scrollCurrentSeat', 'fitLiveSeats', 'syncLiveLayout', 'renderSeatArrow', 'renderVisual', 'clearDirectionNotice', 'manageDirectionNotice', 'highlightTime'].map(name => [name, nothing])) };
  modules['../scene/camera.js'] = { createCamera: () => Object.fromEntries(['cameraSafeArea', 'cameraOverview', 'directionZoom', 'cameraTo', 'showVisualCandidate', 'cameraFitFriendGroup', 'focusFriendStudent', 'frameFriendGroup'].map(name => [name, nothing])) };
  modules['../scene/imports.js'] = load('src/renderer/scene/imports.js');
  modules['../scene/draw-sequence.js'] = load('src/renderer/scene/draw-sequence.js');
  modules['./appearance'] = load('src/renderer/application/appearance.ts');
  const mount = load('src/renderer/application/controller.js').mountController as (dependencies: ControllerDependencies) => ApplicationActions;
  const actions = mount({ store, repository, filePort: { save(file) { downloads.push(copy(file)); } }, fullscreenPort: { active: false, async toggle() {} } });
  const element = dom.getElementById;
  const click = (id: string) => dom.emit(element(id), 'click');
  const submit = (id: string) => dom.emit(element(id), 'submit');
  async function importDocument(kind: backup.BackupKind, value: unknown) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const target = element({ all: 'backupFile', settings: 'settingsBackupFile', roster: 'rosterBackupFile' }[kind]);
    target.files = [{ size: bytes.byteLength, async arrayBuffer() { return bytes.buffer; } }];
    await dom.emit(target, 'change');
  }
  const stageRestore = () => importDocument('all', { format: 'SlateRandomBackup', version: 1, kind: 'all', state: next, credentials: nextCredentials, desktop: null });
  const stagePartial = (kind: 'roster' | 'settings') => importDocument(kind, kind === 'roster'
    ? { format: 'SlateRandom.backup', version: 1, kind, roster: backup.rosterSnapshot(next) }
    : { format: 'SlateRandom.backup', version: 1, kind, settings: next.settings, credentials: nextCredentials, desktopSettings: null });
  async function restore() { await stageRestore(); assert.equal(element('confirmDialog').open, true, 'the real file-change handler requests confirmation'); await click('confirmActionBtn'); }
  const hostEvent = (type: string, detail: unknown) => dom.emit(dom, type, { detail });
  return {
    previous, next, trace, vault, window, dom, clock, storage, native, adapter, vision, speech, loadFallbacks, nativeSaves, store, closed, downloads, actions, element, click, submit, importDocument, stageRestore, stagePartial, restore,
    desktopUpdates, desktopUpdateFlags, importCallbacks, clipboardWrites, hostEvent,
    get snapshot() { return store.snapshot.value; }, get friend() { return friendOptions; }, get renderStyle() { return renderStyleOptions; },
    overrideLoad(value: LoadOverride | null) { loadOverride = value; }
  };
}
export function assertSettled(h: Harness, state: ClassState, recovery: boolean) {
  assert.deepEqual(h.snapshot.state, state); assert.equal(h.snapshot.busy, false); assert.equal(h.snapshot.recoveryRequired, recovery);
  if (recovery) assert.ok(h.snapshot.saveError); else assert.equal(h.snapshot.saveError, '');
}
export async function assertBusyUntilReleased(h: Harness, work: Promise<void>, gate: Deferred<void>) {
  let finished = false; void work.then(() => { finished = true; });
  await checkpoint(); assert.equal(finished, false); assert.equal(h.snapshot.busy, true);
  gate.resolve(); await work; assert.equal(h.snapshot.busy, false);
}

for (const status of ['committed', 'pending-recovery'] as const) test('native ' + status + ' verifies forward load and generation before reloading both providers', { timeout: 10000 }, async () => {
  const h = harness({ native: status }), native = h.native!;
  native.infoGate = deferred<NativeDataInfo>(); h.vision.reloadGate = deferred(); h.speech.reloadGate = deferred();
  await h.stageRestore(); const work = h.click('confirmActionBtn');
  await native.infoStarted.promise;
  assert.ok(h.trace.indexOf('native.load.forward') > h.trace.indexOf('native.restore'));
  assert.equal(h.vision.reloads, 0); assert.equal(h.speech.reloads, 0); assert.equal(h.snapshot.busy, true);
  native.infoGate.resolve({ directory: 'fixture/data', portable: true, generation: native.generation });
  await Promise.all([h.vision.reloadStarted.promise, h.speech.reloadStarted.promise]);
  assert.ok(h.trace.indexOf('native.info') < h.trace.indexOf('vision.reload'));
  assert.ok(h.trace.indexOf('native.info') < h.trace.indexOf('speech.reload'));
  h.vision.reloadGate.resolve(); await assertBusyUntilReleased(h, work, h.speech.reloadGate);
  assertSettled(h, h.next, false); assert.deepEqual(native.persisted, h.next); assert.equal(native.pending, null);
  assert.equal(native.restores.length, 1); assert.deepEqual(native.restores[0]!.state, h.next); assert.equal(h.nativeSaves.length, 0);
  assert.deepEqual(h.vault, nextCredentials); assert.deepEqual(h.vision.loaded, nextCredentials.vision); assert.deepEqual(h.speech.loaded, nextCredentials.speech);
});

for (const failure of ['load', 'info-rejection', 'info-error', 'generation-mismatch', 'generation-missing'] as const) test('native postcommit ' + failure + ' retains restored state without any rollback', { timeout: 10000 }, async () => {
  const h = harness({ native: 'pending-recovery' }), native = h.native!;
  if (failure === 'load') native.loadError = new Error('forward-load fixture failure');
  if (failure === 'info-rejection') native.infoError = new Error('info fixture failure');
  if (failure === 'info-error') native.infoValue = { directory: 'fixture/data', portable: true, generation: native.generation, error: 'manifest still pending' };
  if (failure === 'generation-mismatch') native.infoValue = { directory: 'fixture/data', portable: true, generation: 'stale-generation' };
  if (failure === 'generation-missing') native.infoValue = { directory: 'fixture/data', portable: true };
  h.speech.playing = true; await h.restore();
  assertSettled(h, h.next, true); assert.deepEqual(native.committedState, h.next); assert.equal(native.restores.length, 1);
  assert.equal(h.nativeSaves.length, 0); assert.equal(h.vision.imports.length, 0); assert.equal(h.speech.imports.length, 0);
  assert.equal(h.vision.reloads, 0); assert.equal(h.speech.reloads, 0); assert.equal(h.speech.playing, false);
  assert.equal(h.vision.initOptions.canWrite(), false); assert.equal(h.speech.initOptions.canWrite(), false);
  if (failure === 'load') {
    const before = copy(h.snapshot.state); h.actions.strategy('auto'); await h.click('undoBtn');
    assert.deepEqual(h.snapshot.state, before); assert.equal(h.snapshot.busy, false);
    await h.restore(); assertSettled(h, h.next, true);
    assert.equal(native.restores.length, 2); assert.ok(native.restores.every(payload => payload.state.className === h.next.className));
  }
});

test('native precommit rejection preserves the old page and credentials', { timeout: 10000 }, async () => {
  const h = harness({ native: 'committed' }); h.native!.restoreError = new Error('precommit fixture rejection');
  await h.restore(); assertSettled(h, h.previous, false);
  assert.deepEqual(h.native!.persisted, h.previous); assert.deepEqual(h.vault, oldCredentials); assert.equal(h.native!.restores.length, 1);
  assert.equal(h.vision.reloads, 0); assert.equal(h.speech.reloads, 0); assert.match(h.element('backupDataStatus').textContent, /precommit fixture rejection/);
});

test('native provider failure waits for both reloads, retains the commit and aborts recognition and speech', { timeout: 10000 }, async () => {
  const h = harness({ native: 'committed' });
  await h.dom.delegate({ import: '' }); await h.dom.delegate({ importTab: 'image' });
  h.element('imageFile').files = [{ name: 'fixture.png', type: 'image/png', size: 1 }]; await h.dom.emit(h.element('imageFile'), 'change'); await checkpoint();
  const recognition = h.click('recognizeBtn'), signal = await h.vision.recognitionStarted.promise;
  h.speech.playing = true; h.vision.reloadError = new Error('vision reload fixture failure'); h.speech.reloadGate = deferred();
  await h.stageRestore(); const work = h.click('confirmActionBtn');
  await Promise.all([h.vision.reloadStarted.promise, h.speech.reloadStarted.promise]);
  await assertBusyUntilReleased(h, work, h.speech.reloadGate); await recognition;
  assertSettled(h, h.next, true); assert.match(h.snapshot.saveError, /vision reload fixture failure/);
  assert.equal(signal.aborted, true); assert.equal(h.speech.playing, false); assert.deepEqual(h.native!.persisted, h.next);
  assert.equal(h.native!.restores.length, 1); assert.deepEqual(h.vault, nextCredentials);
  assert.deepEqual(h.vision.loaded, oldCredentials.vision); assert.deepEqual(h.speech.loaded, nextCredentials.speech);
});

for (const fault of ['unreadable', 'unpreserved-corruption', 'warning-only'] as const) test('Lite ' + fault + ' old read refuses restore before any provider writes', { timeout: 10000 }, async () => {
  const h = harness();
  if (fault === 'unreadable') h.storage.readError = new Error('old read denied');
  if (fault === 'unpreserved-corruption') { h.storage.items.set(CLASS_STORAGE_KEY, '{corrupt original'); h.storage.failRecoveryWrites = true; }
  if (fault === 'warning-only') h.overrideLoad(fallback => ({ state: copy(fallback), fromStorage: false, warning: 'unreadable fixture warning' }));
  const original = h.storage.items.get(CLASS_STORAGE_KEY), before = copy(h.snapshot.state); await h.restore();
  assert.deepEqual(h.snapshot.state, h.previous); assert.equal(h.snapshot.busy, false);
  assert.equal(h.vision.imports.length, 0); assert.equal(h.speech.imports.length, 0); assert.equal(h.storage.classWrites.length, 0);
  assert.deepEqual(h.vault, oldCredentials); assert.equal(h.storage.items.get(CLASS_STORAGE_KEY), original);
  assert.deepEqual(h.loadFallbacks[1], before, 'the safety read uses the current page state, not an empty state');
  assert.match(h.element('backupDataStatus').textContent, /失败/);
});

for (const oldRead of ['valid', 'empty', 'preserved-corruption'] as const) test('Lite ' + oldRead + ' old storage permits a complete coordinated restore', { timeout: 10000 }, async () => {
  const h = harness();
  if (oldRead === 'empty') h.storage.items.delete(CLASS_STORAGE_KEY);
  if (oldRead === 'preserved-corruption') h.storage.items.set(CLASS_STORAGE_KEY, '{preserved corrupt original');
  const before = copy(h.snapshot.state); await h.restore(); assertSettled(h, h.next, false);
  assert.deepEqual(JSON.parse(h.storage.items.get(CLASS_STORAGE_KEY)!), h.next); assert.deepEqual(h.vault, nextCredentials);
  assert.equal(h.storage.classWrites.length, 1); assert.equal(h.vision.reloads, 1); assert.equal(h.speech.reloads, 1);
  assert.deepEqual(h.loadFallbacks[1], before); assert.deepEqual(h.loadFallbacks.at(-1), h.next);
  if (oldRead === 'preserved-corruption') assert.equal(h.storage.items.get(CLASS_STORAGE_KEY + ':recovery'), '{preserved corrupt original');
});

test('Lite records an attempted import before it persists then rejects, and compensates only that attempted provider', { timeout: 10000 }, async () => {
  const h = harness(); h.vision.faults.set(1, { message: 'vision persisted then rejected' });
  await h.restore(); assertSettled(h, h.previous, false);
  assert.deepEqual(h.vision.imports, [nextCredentials.vision, oldCredentials.vision]); assert.equal(h.speech.imports.length, 0);
  assert.deepEqual(h.vault, oldCredentials); assert.equal(h.storage.classWrites.length, 0);
  const firstImport = h.trace.indexOf('vision.import.1');
  assert.ok(h.trace.lastIndexOf('vision.export', firstImport) >= 0); assert.ok(h.trace.lastIndexOf('speech.export', firstImport) >= 0);
  assert.ok(h.vision.exports.every(options => options.includeSecrets)); assert.ok(h.speech.exports.every(options => options.includeSecrets));
  assert.match(h.element('backupDataStatus').textContent, /vision persisted then rejected/);
});

test('Lite starts both attempted-provider compensations even if the first fails and fences busy until the second settles', { timeout: 10000 }, async () => {
  const h = harness(), speechCompensating = deferred(), speechGate = deferred();
  h.speech.faults.set(1, { message: 'speech persisted then rejected' });
  h.vision.faults.set(2, { before: true, message: 'vision compensation failed' });
  h.speech.importStarted.set(2, speechCompensating); h.speech.importGates.set(2, speechGate);
  await h.stageRestore(); const work = h.click('confirmActionBtn'); await speechCompensating.promise;
  assert.equal(h.vision.imports.length, 2); assert.equal(h.speech.imports.length, 2);
  await assertBusyUntilReleased(h, work, speechGate);
  assertSettled(h, h.previous, true); assert.equal(h.storage.classWrites.length, 0);
  assert.deepEqual(JSON.parse(h.storage.items.get(CLASS_STORAGE_KEY)!), h.previous);
  assert.deepEqual(h.vault.vision, nextCredentials.vision); assert.deepEqual(h.vault.speech, oldCredentials.speech);
  assert.equal(h.vision.initOptions.canWrite(), false); assert.equal(h.speech.initOptions.canWrite(), false);
});

test('Lite class-save rejection compensates credentials but never writes the previous class', { timeout: 10000 }, async () => {
  const h = harness(); h.storage.failClassWrites = 1;
  await h.restore(); assertSettled(h, h.previous, false);
  assert.deepEqual(h.storage.classWrites, [h.next]); assert.deepEqual(JSON.parse(h.storage.items.get(CLASS_STORAGE_KEY)!), h.previous);
  assert.deepEqual(h.vision.imports, [nextCredentials.vision, oldCredentials.vision]); assert.deepEqual(h.speech.imports, [nextCredentials.speech, oldCredentials.speech]);
  assert.deepEqual(h.vault, oldCredentials); assert.equal(h.vision.reloads, 0); assert.equal(h.speech.reloads, 0);
});

for (const fault of ['null-readback', 'warning-readback', 'recovery-copy-readback', 'provider-reload'] as const) test('Lite postcommit ' + fault + ' never rolls back and awaits both reloads', { timeout: 10000 }, async () => {
  const h = harness(); h.vision.reloadGate = deferred(); h.speech.reloadGate = deferred();
  if (fault === 'null-readback') h.storage.afterClassWrite = () => { h.storage.readNull = true; };
  if (fault === 'warning-readback') h.storage.afterClassWrite = () => { h.storage.readError = new Error('readback denied'); };
  if (fault === 'recovery-copy-readback') h.storage.afterClassWrite = () => h.overrideLoad(fallback => ({ state: copy(fallback), fromStorage: false, warning: 'readback corrupt', recovery: { key: 'fixture:recovery', raw: 'invalid', saved: true } }));
  if (fault === 'provider-reload') h.vision.reloadError = new Error('Lite provider reload rejected');
  await h.stageRestore(); const work = h.click('confirmActionBtn');
  await Promise.all([h.vision.reloadStarted.promise, h.speech.reloadStarted.promise]);
  h.vision.reloadGate.resolve(); await assertBusyUntilReleased(h, work, h.speech.reloadGate);
  assertSettled(h, h.next, true); assert.deepEqual(h.storage.classWrites, [h.next]);
  assert.deepEqual(JSON.parse(h.storage.items.get(CLASS_STORAGE_KEY)!), h.next); assert.deepEqual(h.vault, nextCredentials);
  assert.deepEqual(h.vision.imports, [nextCredentials.vision]); assert.deepEqual(h.speech.imports, [nextCredentials.speech]);
  assert.deepEqual(h.speech.loaded, nextCredentials.speech); assert.equal(h.vision.reloads, 1); assert.equal(h.speech.reloads, 1);
});

test('recovery blocks mutation handlers and partial confirmations but allows settings navigation, readonly exports and explicit full-restore confirmation', { timeout: 10000 }, async () => {
  const h = harness({ recovery: true }); assertSettled(h, h.previous, true);
  assert.equal(h.vision.initOptions.canWrite(), false); assert.equal(h.speech.initOptions.canWrite(), false);
  h.actions.openSettings(); await h.click('classBtn'); await h.click('reflowBtn'); await h.dom.delegate({ student: '1' }); await h.dom.delegate({ import: '' });
  for (const id of ['settingsDialog', 'classDialog', 'reflowDialog', 'studentDialog', 'importDialog']) assert.equal(h.element(id).open, false, id);
  h.element('classNameInput').value = 'blocked'; await h.submit('classForm'); await h.click('undoBtn'); await h.click('exitChainBtn'); await h.click('swapBtn');
  assert.equal(h.actions.toggleMode('friend', true), false); assert.equal(h.actions.manualMode('time'), false); assert.equal(h.actions.changeChance('direction', 20), false);
  h.actions.strategy('auto'); assert.equal(h.friend.commitTargets('1', ['2']), false); assert.equal(await h.renderStyle.onChange('overview'), false);
  await h.click('drawBtn'); await h.dom.emit(h.element('resetDrawBtn'), 'keydown', { code: 'Enter' }); h.clock.fire(pressIntent.HOLD_MS); await checkpoint();
  assert.deepEqual(h.snapshot.state, h.previous); assert.equal(h.snapshot.busy, false); assert.equal(h.storage.classWrites.length, 0);
  for (const kind of ['settings', 'roster'] as const) { await h.stagePartial(kind); assert.equal(h.element('confirmDialog').open, false); }
  await h.click('importSettingsBtn'); await h.click('importRosterBtn'); assert.equal(h.element('settingsBackupFile').clicks, 0); assert.equal(h.element('rosterBackupFile').clicks, 0);
  await h.dom.emit(h.element('drawBtn'), 'slate:open-settings'); assert.equal(h.element('configDialog').open, true);
  h.actions.setView('data'); assert.equal(h.snapshot.view, 'data');
  await h.click('exportRosterBtn'); await h.click('exportHistoryBtn'); assert.equal(h.downloads.length, 2);
  assert.ok(h.downloads.some(file => file.name.endsWith('.json'))); assert.ok(h.downloads.some(file => file.name.endsWith('.csv')));
  await h.click('exportAnalysisBtn'); await checkpoint();
  const analysis = h.downloads.find(file => file.name.includes('SlateRandom-analysis-') && 'text' in file) as TextDownload | undefined;
  assert.ok(analysis); assert.equal(JSON.parse(analysis.text).format, 'SlateRandom.analysis'); assert.equal(h.downloads.length, 3);
  assert.equal(h.snapshot.busy, false); assert.equal(h.snapshot.recoveryRequired, true); assert.equal(h.storage.classWrites.length, 0);
  await h.click('restoreBackupBtn'); assert.equal(h.element('backupFile').clicks, 1);
  await h.stageRestore(); assert.equal(h.element('confirmDialog').open, true);
  await h.click('confirmActionBtn'); assertSettled(h, h.next, false);
  assert.equal(h.vision.initOptions.canWrite(), true); assert.equal(h.speech.initOptions.canWrite(), true); assert.deepEqual(h.vault, nextCredentials);
});

const routineForms = [
  { kind: 'settings', dialog: 'settingsDialog', form: 'settingsForm', async edit(h: Harness) { h.actions.openSettings(); h.element('cooldownInput').value = h.previous.settings.cooldown + 1; }, changed(h: Harness) { assert.equal(h.snapshot.state.settings.cooldown, h.previous.settings.cooldown + 1); } },
  { kind: 'student', dialog: 'studentDialog', form: 'studentForm', async edit(h: Harness) { await h.dom.delegate({ student: '1' }); h.element('studentNameInput').value = '已修改姓名'; }, changed(h: Harness) { assert.equal(h.snapshot.state.students[0]!.name, '已修改姓名'); } },
  { kind: 'class', dialog: 'classDialog', form: 'classForm', async edit(h: Harness) { await h.click('classBtn'); h.element('classNameInput').value = '未保存新班名'; }, changed(h: Harness) { assert.equal(h.snapshot.state.className, '未保存新班名'); } },
  { kind: 'reflow', dialog: 'reflowDialog', form: 'reflowForm', async edit(h: Harness) { await h.click('reflowBtn'); h.element('reflowColsInput').value = 2; }, changed(h: Harness) { assert.equal(h.snapshot.state.cols, 2); assert.equal(h.snapshot.state.students[3]!.row, 2); } },
  { kind: 'import', dialog: 'importDialog', form: null, async edit(h: Harness) {
    await h.dom.delegate({ import: '' }); await h.dom.delegate({ importTab: 'json' }); h.element('importClassInput').value = '未保存导入班级';
    h.element('visionJson').value = JSON.stringify({ rows: 1, cols: 2, students: [{ id: '11', name: '导入甲', row: 1, col: 1 }, { id: '12', name: '导入乙', row: 1, col: 2 }] });
    await h.click('previewImportBtn'); assert.equal(h.element('applyImportBtn').hidden, false);
  }, changed(h: Harness) { assert.equal(h.snapshot.state.className, '未保存导入班级'); assert.deepEqual(h.snapshot.state.students.map(student => student.id), ['11', '12']); } }
];
for (const form of routineForms) test('routine ' + form.kind + ' save failure keeps the modified state, error and open form without a success toast', { timeout: 10000 }, async () => {
  const h = harness(); h.storage.failClassWrites = Infinity; await form.edit(h);
  assert.equal(h.element(form.dialog).open, true);
  if (form.form) await h.submit(form.form); else await h.click('applyImportBtn');
  form.changed(h); assert.equal(h.snapshot.busy, false); assert.equal(h.snapshot.recoveryRequired, false); assert.match(h.snapshot.saveError, /class-save fixture failure/);
  assert.equal(h.element(form.dialog).open, true); assert.equal(h.closed.includes(form.dialog), false); assert.match(h.element('toast').textContent, /class-save fixture failure/);
  assert.deepEqual(JSON.parse(h.storage.items.get(CLASS_STORAGE_KEY)!), h.previous); assert.equal(h.storage.classWrites.length, 1);
  if (form.kind === 'class') {
    h.storage.failClassWrites = 0; await h.submit('classForm'); assert.equal(h.element(form.dialog).open, false); assert.equal(h.snapshot.saveError, '');
    assert.deepEqual(JSON.parse(h.storage.items.get(CLASS_STORAGE_KEY)!), h.snapshot.state);
  }
});

test('failed Friend target and mode saves return false while retaining the modified next state and error', async () => {
  const h = harness(); h.storage.failClassWrites = Infinity;
  assert.equal(h.friend.commitTargets('1', ['2']), false); assert.deepEqual(h.snapshot.state.students[0]!.friendTargets, ['2']);
  assert.match(h.snapshot.saveError, /class-save fixture failure/); assert.match(h.element('toast').textContent, /class-save fixture failure/);
  assert.equal(h.actions.toggleMode('friend', true), false); assert.equal(h.snapshot.state.settings.friendEnabled, true);
  assert.equal(h.snapshot.recoveryRequired, false); assert.equal(h.snapshot.busy, false); assert.deepEqual(JSON.parse(h.storage.items.get(CLASS_STORAGE_KEY)!), h.previous);
});

test('roster backup save failure adopts the legal next roster without writing credentials or claiming success', { timeout: 10000 }, async () => {
  const h = harness(); h.storage.failClassWrites = 1;
  await h.stagePartial('roster'); assert.equal(h.element('confirmDialog').open, true); await h.click('confirmActionBtn');
  const expected = backup.applyRosterBackup(h.previous, backup.rosterSnapshot(h.next));
  assert.deepEqual(h.snapshot.state, expected); assert.equal(h.snapshot.busy, false); assert.equal(h.snapshot.recoveryRequired, false);
  assert.match(h.snapshot.saveError, /class-save fixture failure/); assert.match(h.element('toast').textContent, /class-save fixture failure/);
  assert.equal(h.vision.imports.length, 0); assert.equal(h.speech.imports.length, 0); assert.deepEqual(h.storage.classWrites, [expected]);
  assert.deepEqual(JSON.parse(h.storage.items.get(CLASS_STORAGE_KEY)!), h.previous);
});

test('updateAppearance persists normalized appearance and keeps a zero radius', () => {
  const h = harness();
  assert.equal(h.actions.updateAppearance({ theme: 'dark', accent: '#ABC', radius: 0, customCss: ':root{--qa:1}', customCssEnabled: true, backgroundTint: true }), true);
  assert.equal(h.snapshot.state.settings.theme, 'dark');
  assert.equal(h.snapshot.state.settings.accent, '#aabbcc');
  assert.equal(h.snapshot.state.settings.radius, 0);
  assert.equal(h.snapshot.state.settings.customCss, ':root{--qa:1}');
  assert.equal(h.snapshot.state.settings.customCssEnabled, true);
  assert.equal(h.snapshot.state.settings.backgroundTint, true);
  const stored = JSON.parse(h.storage.items.get(CLASS_STORAGE_KEY)!) as ClassState;
  assert.equal(stored.settings.backgroundTint, true);
  assert.equal(stored.settings.radius, 0);
  assert.equal(stored.settings.accent, '#aabbcc');
});

test('updateAppearance rolls back and reports a failed save', () => {
  const h = harness();
  const before = copy(h.snapshot.state);
  h.storage.failClassWrites = 1;
  assert.equal(h.actions.updateAppearance({ theme: 'light', radius: 14 }), false);
  assert.deepEqual(h.snapshot.state, before);
  assert.match(h.element('toast').textContent, /class-save fixture failure/);
});

test('settings backup with enabled external CSS warns before restoring', async () => {
  const h = harness();
  const before = copy(h.snapshot.state);
  h.next.settings.customCss = '@import url(https://example.com/a.css);';
  h.next.settings.customCssEnabled = true;
  await h.stagePartial('settings');
  assert.equal(h.element('confirmDialog').open, true);
  const text = h.element('confirmText').textContent || '';
  assert.match(text, /外部资源/);
  assert.match(text, /example\.com/);
  assert.deepEqual(h.snapshot.state, before);
});

test('real draw sequence performs no work while recovery blocks availability', async () => {
  const domAccess: string[] = [], state = configured();
  const context = {
    available: () => false,
    $$: (selector: string) => { domAccess.push(selector); return []; },
    $: (id: string) => { domAccess.push(id); return null; },
    state, busy: false, drawButton: null, hasSeatBoard: () => true, setView() {}, showVisualCandidate() {}, delay: () => Promise.resolve(), toast() {}, render() {}
  };
  const file = 'src/renderer/scene/draw-sequence.js';
  const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: file }).outputText;
  const module: { exports: { createDrawSequence?(context: unknown): { startDraw(): Promise<void> } } } = { exports: {} };
  const window: Record<string, unknown> = {};
  const sandbox = vm.createContext({ window, document: {}, console, queueMicrotask });
  const evaluate = vm.runInContext('(function(require,module,exports){\n' + source + '\n})', sandbox, { filename: file }) as (require: (name: string) => unknown, module: { exports: object }, exports: object) => void;
  evaluate(name => { if (name === '../domain/engine') return { __esModule: true, default: engine }; throw new Error('unexpected module request: ' + name); }, module, module.exports);
  const sequence = module.exports.createDrawSequence!(context);
  const before = copy(state);
  await sequence.startDraw();
  assert.deepEqual(domAccess, []); assert.deepEqual(state, before);
  let stopped = 0;
  context.available = () => true;
  window.SpeechProviders = { stop() { stopped++; } }; window.FriendSeatConfig = { hide() {} }; window.matchMedia = () => ({ matches: true });
  await sequence.startDraw().catch(() => {});
  assert.equal(stopped, 1); assert.ok(domAccess.length > 0, 'availability alone lets the real sequence proceed to DOM work');
});

function freshNative(initial: ClassState = engine.createEmptyState(1)) {
  return new NativeData(initial, copy(oldCredentials), [], 'committed');
}

test('a brand-new portable state boots straight into the first-run flow', () => {
  const empty = engine.createEmptyState(1);
  const h = harness({ initial: empty, nativeData: freshNative(empty) });
  assert.equal(h.snapshot.booted, true);
  assert.equal(h.snapshot.onboarding, true);
  assert.equal(h.snapshot.state.settings.onboardingCompleted, false);
});

test('an already configured profile never enters the first-run flow', () => {
  const h = harness();
  assert.equal(h.snapshot.booted, true);
  assert.equal(h.snapshot.onboarding, false);
});

test('a legacy save without the flag counts as configured', () => {
  const legacy = configured();
  delete (legacy.settings as Partial<ClassState['settings']>).onboardingCompleted;
  const h = harness({ initial: legacy, nativeData: freshNative(engine.clone(legacy)) });
  assert.equal(h.snapshot.onboarding, false);
});

test('skipping the first run persists the completion flag and closes the flow', () => {
  const empty = engine.createEmptyState(1);
  const h = harness({ initial: empty, nativeData: freshNative(empty) });
  assert.equal(h.actions.skipOnboarding(), true);
  assert.equal(h.snapshot.onboarding, false);
  assert.equal(h.nativeSaves.at(-1)!.settings.onboardingCompleted, true);
  assert.deepEqual(h.desktopUpdates, []);
});

test('finishing applies the desktop draft only after the completion flag is durable', async () => {
  const empty = engine.createEmptyState(1);
  const h = harness({ initial: empty, nativeData: freshNative(empty) });
  await h.actions.finishOnboarding({ uac: true, uiAccess: true });
  assert.deepEqual(h.desktopUpdates, [{ uac: true, uiAccess: true }]);
  // The bridge call must happen with the flag already written: a UAC relaunch may
  // follow inside updateSettings, and the restarted process has to see it.
  assert.deepEqual(h.desktopUpdateFlags, [true]);
  assert.equal(h.nativeSaves.at(-1)!.settings.onboardingCompleted, true);
  assert.equal(h.snapshot.onboarding, false);
});

test('a failed save keeps the first-run flow open with its error', async () => {
  const h = harness({ initial: engine.createEmptyState(1) });
  h.storage.failClassWrites = 1;
  assert.equal(await h.actions.finishOnboarding({ uac: true }), false);
  assert.equal(h.snapshot.onboarding, true);
  assert.ok(h.snapshot.saveError);
  assert.equal(h.snapshot.state.settings.onboardingCompleted, false);
  // Without the flag there is no relaunch, so the desktop draft is never submitted.
  assert.deepEqual(h.desktopUpdates, []);
});

test('rerunning the flow stores the unfinished flag and dismissals stay session-only', async () => {
  const h = harness();
  assert.equal(await h.actions.restartOnboarding(), true);
  assert.equal(h.snapshot.onboarding, true);
  assert.equal(h.storage.classWrites.at(-1)!.settings.onboardingCompleted, false);
  assert.ok(h.closed.includes('configDialog'));

  h.actions.dismissOnboardingForSession();
  assert.equal(h.snapshot.onboarding, false);
  assert.equal(h.storage.classWrites.length, 1);
});

test('restoring any backup ends the first run instead of asking again', async () => {
  const h = harness({ initial: engine.createEmptyState(1) });
  assert.equal(h.snapshot.onboarding, true);
  // A backup captured mid-first-run carries the unfinished flag.
  h.next.settings.onboardingCompleted = false;
  await h.restore();
  assert.equal(h.snapshot.onboarding, false);
  assert.equal(h.storage.classWrites.at(-1)!.settings.onboardingCompleted, true);
  assert.equal(h.snapshot.state.settings.onboardingCompleted, true);
});

test('the welcome page can restore a backup and open the roster importer', async () => {
  const h = harness({ initial: engine.createEmptyState(1) });
  h.actions.openRosterImport();
  assert.equal(h.element('importDialog').open, true);

  const bytes = new TextEncoder().encode(JSON.stringify({
    format: 'SlateRandomBackup', version: 1, kind: 'all', state: h.next, credentials: nextCredentials, desktop: null
  }));
  await h.actions.restoreAllFile({ size: bytes.byteLength, arrayBuffer: async () => bytes.buffer } as unknown as File);
  assert.equal(h.element('confirmDialog').open, true);
  assert.match(h.element('confirmText').textContent, /恢复全部数据|将恢复/);
});

test('the first-run roster step restores a roster backup without ending the flow', async () => {
  const h = harness({ initial: engine.createEmptyState(1) });
  assert.equal(h.snapshot.onboarding, true);
  const backup = {
    format: 'SlateRandom.backup', version: 1, kind: 'roster', createdAt: '2026-10-18T00:00:00Z',
    roster: {
      className: '备份班级', demo: false, cols: 3, seatRows: 4,
      students: [
        { id: '3', name: '丙', row: 1, col: 2, active: true, friendTargets: ['1'] },
        { id: '1', name: '甲', row: 1, col: 1, active: false },
        { id: '7', name: '丁', row: 3, col: 2, active: true }
      ]
    }
  };
  const bytes = new TextEncoder().encode(JSON.stringify(backup));
  await h.actions.restoreRosterFile({ size: bytes.byteLength, arrayBuffer: async () => bytes.buffer } as unknown as File);
  // Replacing a roster always asks first, exactly like the data page.
  assert.equal(h.element('confirmDialog').open, true);
  assert.equal(h.element('confirmTitle').textContent, '导入名单');
  await h.click('confirmActionBtn');

  const stored = h.storage.classWrites.at(-1)!;
  assert.equal(stored.className, '备份班级');
  assert.equal(stored.cols, 3);
  assert.equal(stored.seatRows, 4);
  assert.deepEqual(stored.students.map(student => [student.id, student.row, student.col, student.active]),
    [['3', 1, 2, true], ['1', 1, 1, false], ['7', 3, 2, true]]);
  assert.deepEqual(stored.students.find(student => student.id === '3')?.friendTargets, ['1']);
  // The roster is not a configuration: the first-run flow stays open and unfinished.
  assert.equal(stored.settings.onboardingCompleted, false);
  assert.equal(h.snapshot.onboarding, true);
  assert.equal(h.snapshot.state.students.length, 3);
  assert.match(h.element('backupDataStatus').textContent, /名单已导入/);
});

test('the tray settings command stays out of the way while the first-run flow owns the window', async () => {
  const h = harness({ initial: engine.createEmptyState(1) });
  assert.equal(h.snapshot.onboarding, true);
  await h.dom.emit(h.element('drawBtn'), 'slate:open-settings');
  assert.equal(h.element('configDialog').open, false);

  h.actions.dismissOnboardingForSession();
  await h.dom.emit(h.element('drawBtn'), 'slate:open-settings');
  assert.equal(h.element('configDialog').open, true);
});

test('mount installs the protocol hooks and marks the renderer ready', () => {
  const h = harness();
  assert.equal(h.window.__slateRendererReady, true);
  assert.equal(typeof h.window.__slateTriggerDraw, 'function');
});

test('the host draw hook accepts one idle draw then refuses while busy, with a dialog open or in recovery', async () => {
  const h = harness();
  assert.equal(h.window.__slateTriggerDraw!(), true);
  await checkpoint();
  assert.equal(h.snapshot.busy, true);
  assert.equal(h.window.__slateTriggerDraw!(), false);

  const blocked = harness();
  blocked.element('configDialog').open = true;
  assert.equal(blocked.window.__slateTriggerDraw!(), false);

  const recovery = harness({ recovery: true });
  assert.equal(recovery.window.__slateTriggerDraw!(), false);
});

test('host settings commands open and close the settings dialog including nested dialogs', async () => {
  const h = harness();
  await h.hostEvent('slate:settings-command', { action: 'open' });
  assert.equal(h.element('configDialog').open, true);
  assert.equal(h.snapshot.view, 'general');

  h.actions.openSettings();
  assert.equal(h.element('settingsDialog').open, true);
  await h.hostEvent('slate:settings-command', { action: 'close' });
  await checkpoint();
  assert.equal(h.element('settingsDialog').open, false);
  assert.equal(h.element('configDialog').open, false);
  assert.deepEqual(h.closed.filter(id => id === 'settingsDialog' || id === 'configDialog'), ['settingsDialog', 'configDialog']);
});

test('host settings toggle opens a closed dialog and closes an open one', async () => {
  const h = harness();
  await h.hostEvent('slate:settings-command', { action: 'toggle' });
  assert.equal(h.element('configDialog').open, true);
  await h.hostEvent('slate:settings-command', { action: 'toggle' });
  assert.equal(h.element('configDialog').open, false);
  assert.ok(h.closed.includes('configDialog'));
});

test('desktop import requests open the standard confirmation and invalid payloads are ignored', async () => {
  const h = harness({ native: 'committed' });
  assert.equal(h.importCallbacks.length, 1);
  const bytes = await backup.encodeBackup({ format: 'SlateRandomBackup', version: 1, kind: 'all', state: h.next, credentials: nextCredentials, desktop: null });
  h.importCallbacks[0]!({ kind: 'all', name: '恢复.slate', bytes });
  await eventually(() => h.element('confirmDialog').open, 'the host import asks for confirmation');
  assert.match(h.element('confirmText').textContent, /恢复班级/);
  await h.click('confirmActionBtn');
  assertSettled(h, h.next, false);
  assert.equal(h.element('confirmDialog').open, false);
  assert.equal(h.native!.restores.length, 1);

  const ignored = harness({ native: 'committed' });
  ignored.importCallbacks[0]!({ kind: 'bogus', name: '恢复.slate', bytes });
  ignored.importCallbacks[0]!({ kind: 'all', name: '恢复.slate', bytes: new Uint8Array() });
  await checkpoint();
  assert.equal(ignored.element('confirmDialog').open, false);
  assert.equal(ignored.snapshot.busy, false);
});

test('a host protocol notice becomes a toast', async () => {
  const h = harness();
  await h.hostEvent('slate:protocol-notice', { message: '备份无法读取' });
  assert.equal(h.element('toast').textContent, '备份无法读取');
});

test('Lite send-to-desktop writes an import envelope without or with provider keys', async () => {
  async function send(h: Harness, includeSecrets: boolean) {
    h.element('includeSecretsToggle').checked = includeSecrets;
    await h.click('sendToDesktopBtn');
    await eventually(() => h.clipboardWrites.length === 1 && !h.snapshot.busy, 'send-to-desktop finishes');
    const payload = JSON.parse(h.clipboardWrites[0]!) as { format: string; version: number; kind: string; name: string; data: string };
    assert.equal(payload.format, 'SlateRandom.protocol-import');
    assert.equal(payload.version, 1);
    assert.equal(payload.kind, 'all');
    assert.match(payload.name, /\.slate$/);
    assert.equal(h.window.location.href, 'slaterandom://import?kind=all&source=clipboard');
    return backup.readBackup(Uint8Array.from(Buffer.from(payload.data, 'base64')));
  }

  const withoutSecrets = await send(harness(), false);
  if (withoutSecrets.kind !== 'all') assert.fail('the envelope carries a full backup');
  assert.equal(withoutSecrets.state.className, '原班级');
  assert.equal(Object.hasOwn(withoutSecrets.credentials.vision!.records[0]!, 'key'), false);
  assert.equal(Object.hasOwn(withoutSecrets.credentials.speech!.records[0]!, 'key'), false);

  const withSecrets = await send(harness(), true);
  if (withSecrets.kind !== 'all') assert.fail('the envelope carries a full backup');
  assert.equal(withSecrets.credentials.vision!.records[0]!.key, oldCredentials.vision.records[0]!.key);
  assert.equal(withSecrets.credentials.speech!.records[0]!.key, oldCredentials.speech.records[0]!.key);
});
