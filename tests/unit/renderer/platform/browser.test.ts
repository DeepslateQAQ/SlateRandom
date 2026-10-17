import test from 'node:test';
import assert from 'node:assert/strict';
import canonicalEngine from '../../../../src/shared/domain/engine.js';
import engine from '../../../../src/renderer/domain/engine';
import { BrowserClassRepository, CLASS_STORAGE_KEY } from '../../../../src/renderer/platform/browser';
import type { StorageLike } from '../../../../src/renderer/platform/ports';

const configured = () => {
  const state = engine.createState(Array.from({ length: 8 }, (_, index) => ({ id: String(index + 1), name: '学生' + (index + 1), row: Math.floor(index / 4) + 1, col: index % 4 + 1 })), 617);
  Object.assign(state.settings, { strategy: 'manual', manualMode: 'normal', endJumpChance: 0, friendEnabled: false });
  return state;
};

class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null { return this.items.get(key) ?? null; }
  setItem(key: string, value: string): void { this.items.set(key, value); }
}

test('浏览器仓库沿用旧 key/schema，保存的数据可用旧引擎完整恢复', () => {
  const storage = new MemoryStorage(), repository = new BrowserClassRepository(storage);
  const state = configured(); for (let count = 0; count < 10; count++) engine.draw(state);
  repository.save(state);
  assert.ok(storage.items.has('rollcall-studio:v1'));
  const loaded = repository.load(configured());
  assert.equal(loaded.warning, ''); assert.equal(loaded.fromStorage, true); assert.deepEqual(loaded.state, state);
  const saved = storage.getItem(CLASS_STORAGE_KEY); assert.ok(saved);
  assert.deepEqual(canonicalEngine.restoreState(JSON.parse(saved)), state);
  assert.ok(!saved.includes('apiKey'));
});

test('无效旧存储保留原文与恢复副本，存储不可用时返回独立可用状态', () => {
  const storage = new MemoryStorage(), repository = new BrowserClassRepository(storage);
  const raw = '{invalid original'; storage.setItem(CLASS_STORAGE_KEY, raw);
  const initial = configured(), loaded = repository.load(initial);
  assert.equal(storage.getItem(CLASS_STORAGE_KEY), raw);
  assert.equal(storage.getItem(CLASS_STORAGE_KEY + ':recovery'), raw);
  assert.equal(loaded.recovery?.saved, true); assert.match(loaded.warning, /恢复副本/);
  assert.equal(loaded.fromStorage, false);
  assert.deepEqual(loaded.state, initial); assert.notEqual(loaded.state, initial);
  const unavailable = new BrowserClassRepository({ getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
  const offline = unavailable.load(initial);
  assert.match(offline.warning, /未允许本机存储/); assert.deepEqual(offline.state, initial);
  assert.equal(offline.fromStorage, false); assert.equal(offline.recovery, undefined);
  assert.throws(() => unavailable.save(initial), /denied/);
});

test('missing storage is an independent fallback, not a successfully read document', () => {
  const storage = new MemoryStorage(), initial = configured();
  const loaded = new BrowserClassRepository(storage).load(initial);
  assert.equal(loaded.fromStorage, false); assert.equal(loaded.warning, '');
  assert.equal(loaded.recovery, undefined); assert.equal(loaded.saveError, undefined);
  assert.deepEqual(loaded.state, initial); assert.notEqual(loaded.state, initial);
  assert.equal(storage.items.size, 0);
});

test('empty and parseable invalid documents preserve their original content as corrupt storage', () => {
  for (const raw of ['', 'null', '{"version":1,"students":[]}']) {
    const storage = new MemoryStorage(); storage.setItem(CLASS_STORAGE_KEY, raw);
    const loaded = new BrowserClassRepository(storage).load(configured());
    assert.equal(loaded.fromStorage, false); assert.match(loaded.warning, /格式无效/);
    assert.deepEqual(loaded.recovery, { key: CLASS_STORAGE_KEY + ':recovery', raw, saved: true });
    assert.equal(storage.getItem(CLASS_STORAGE_KEY), raw);
    assert.equal(storage.getItem(CLASS_STORAGE_KEY + ':recovery'), raw);
  }
});

test('failed recovery-copy storage is reported without losing the corrupt original', () => {
  const raw = '{invalid original', initial = configured();
  const storage: StorageLike = {
    getItem: () => raw,
    setItem: () => { throw Error('recovery copy denied'); }
  };
  const loaded = new BrowserClassRepository(storage).load(initial);
  assert.equal(loaded.fromStorage, false); assert.equal(loaded.recovery?.saved, false);
  assert.equal(loaded.recovery?.raw, raw); assert.match(loaded.warning, /暂未覆盖/);
  assert.deepEqual(loaded.state, initial); assert.equal(storage.getItem(CLASS_STORAGE_KEY), raw);
});
