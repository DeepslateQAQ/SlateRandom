import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import engine from '../../../../src/renderer/domain/engine';
import type { ClassState } from '../../../../src/shared/domain/model';
import type { SlateDesktopBridge } from '../../../../src/renderer/desktop/types';
import { DesktopClassRepository } from '../../../../src/renderer/platform/desktop';
import { BrowserClassRepository, CLASS_STORAGE_KEY } from '../../../../src/renderer/platform/browser';

function harness(initial: ClassState | null, corrupt = false) {
  let saved = initial, writes = 0;
  const data: NonNullable<SlateDesktopBridge['data']> = {
    preview: false,
    loadClass: () => { if (corrupt) throw Error('统计校验失败，原文件已保留。');return saved; },
    saveClass: value => { if (corrupt) throw Error('统计校验失败，原文件已保留。');saved = engine.clone(value);writes++; },
    info: async () => ({ directory: 'fixture/data', portable: true, generation: null }),
    readCredentials: async () => null, writeCredentials: async () => {},
    restoreAll: async () => ({ status: 'committed', generation: 'fixture' }), saveFile: async () => {}
  };
  return { data, get saved() { return saved; }, get writes() { return writes; } };
}
function fixture() {
  const state = engine.createState([{ id: '1', name: '迁移甲', row: 1, col: 1 }, { id: '2', name: '迁移乙', row: 1, col: 2 }], 42);
  state.demo = false;Object.assign(state.settings, { strategy: 'manual', manualMode: 'normal', endJumpChance: 0 });engine.draw(state);return state;
}
function legacyStorage(t: TestContext, raw: string | null) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const items = new Map<string, string>();
  if (raw !== null) items.set(CLASS_STORAGE_KEY, raw);
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); }
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  return storage;
}
test('portable state is authoritative and never replaced by stale browser localStorage', () => {
  const state = fixture(), ctx = harness(state);
  const legacy = { load() { throw Error('Stale browser data must not be read.'); } } as unknown as BrowserClassRepository;
  const loaded = new DesktopClassRepository(ctx.data, legacy).load(engine.createEmptyState());
  assert.deepEqual(loaded.state, state);assert.equal(loaded.fromStorage, true);assert.equal(ctx.writes, 0);
});
test('first-run migration checkpoints old browser history and long-term fairness exactly once', t => {
  const state = fixture(), raw = JSON.stringify(state), ctx = harness(null);
  const storage = legacyStorage(t, raw);
  const repository = new DesktopClassRepository(ctx.data, new BrowserClassRepository(storage));
  const migrated = repository.load(engine.createEmptyState());
  assert.deepEqual(migrated.state, state);assert.equal(migrated.fromStorage, true);assert.equal(ctx.writes, 1);
  assert.equal(storage.getItem(CLASS_STORAGE_KEY), null);
  const reopened = repository.load(engine.createEmptyState());
  assert.deepEqual(reopened.state, state);assert.equal(reopened.fromStorage, true);assert.equal(ctx.writes, 1);
});
test('damaged protected statistics produce a visible warning and cannot be overwritten by a fallback draw', () => {
  const ctx = harness(fixture(), true), repository = new DesktopClassRepository(ctx.data);
  const fallback = engine.createEmptyState();
  const loaded = repository.load(fallback);
  assert.match(loaded.warning, /统计校验失败/);assert.equal(ctx.writes, 0);
  assert.equal(loaded.fromStorage, false);assert.equal(loaded.recoveryRequired, true);
  assert.deepEqual(loaded.state, fallback);assert.notEqual(loaded.state, fallback);
  assert.throws(() => repository.save(fallback), /原文件已保留/);assert.equal(ctx.writes, 0);
});

test('migration of an empty legacy store retains fallback provenance until a native read', t => {
  const ctx = harness(null), fallback = engine.createEmptyState();
  const storage = legacyStorage(t, null);
  const repository = new DesktopClassRepository(ctx.data, new BrowserClassRepository(storage));
  const migrated = repository.load(fallback);
  assert.deepEqual(migrated.state, fallback);assert.equal(migrated.fromStorage, false);
  assert.equal(migrated.warning, '');assert.equal(ctx.writes, 1);
  assert.equal(repository.load(fallback).fromStorage, true);
});

test('failed first migration keeps readable legacy state and the exact original until saving succeeds', t => {
  const state = fixture(), raw = JSON.stringify(state, null, 2), ctx = harness(null);
  const storage = legacyStorage(t, raw), saveClass = ctx.data.saveClass;
  ctx.data.saveClass = () => { throw Error('迁移保存失败：EACCES'); };
  const repository = new DesktopClassRepository(ctx.data, new BrowserClassRepository(storage));
  const fallback = engine.createEmptyState(), loaded = repository.load(fallback);
  assert.deepEqual(loaded.state, state);assert.equal(loaded.fromStorage, true);
  assert.equal(loaded.warning, '');assert.match(loaded.saveError ?? '', /EACCES/);
  assert.notEqual(loaded.recoveryRequired, true);assert.equal(ctx.saved, null);
  assert.equal(storage.getItem(CLASS_STORAGE_KEY), raw);
  ctx.data.saveClass = saveClass;
  const retried = repository.load(fallback);
  assert.deepEqual(retried.state, state);assert.equal(retried.saveError, undefined);
  assert.equal(storage.getItem(CLASS_STORAGE_KEY), null);assert.equal(ctx.writes, 1);
});

test('a migration journal failure retains the target state and legacy original while later native load rolls forward', t => {
  const state = fixture(), raw = JSON.stringify(state), ctx = harness(null);
  const storage = legacyStorage(t, raw);
  let journal: ClassState | null = null, writes = 0, unavailable = false;
  ctx.data.saveClass = next => {
    writes++;journal = engine.clone(next);unavailable = true;
    throw Error('事务日志已发布；DATA_IO，等待恢复。');
  };
  ctx.data.loadClass = () => {
    if (unavailable) throw Error('DATA_IO：前滚暂未完成。');
    return journal === null ? null : engine.clone(journal);
  };
  const repository = new DesktopClassRepository(ctx.data, new BrowserClassRepository(storage));
  const loaded = repository.load(engine.createEmptyState());
  assert.deepEqual(loaded.state, state);assert.equal(loaded.fromStorage, true);
  assert.match(loaded.saveError ?? '', /DATA_IO/);assert.equal(loaded.warning, '');
  assert.notEqual(loaded.recoveryRequired, true);
  assert.equal(storage.getItem(CLASS_STORAGE_KEY), raw);assert.equal(writes, 1);
  const blocked = repository.load(loaded.state);
  assert.deepEqual(blocked.state, state);assert.equal(blocked.fromStorage, false);
  assert.equal(blocked.recoveryRequired, true);assert.match(blocked.warning, /DATA_IO/);
  assert.equal(storage.getItem(CLASS_STORAGE_KEY), raw);assert.equal(writes, 1);
  unavailable = false;
  const recovered = repository.load(engine.createEmptyState());
  assert.deepEqual(recovered.state, state);assert.equal(recovered.fromStorage, true);
  assert.equal(recovered.saveError, undefined);assert.equal(recovered.recoveryRequired, undefined);
  assert.equal(storage.getItem(CLASS_STORAGE_KEY), raw);assert.equal(writes, 1);
});

for (const canSaveRecovery of [true, false]) {
  test(`corrupt legacy storage is never migrated or deleted (recovery saved: ${canSaveRecovery})`, t => {
    const raw = '{invalid original', ctx = harness(null), storage = legacyStorage(t, raw);
    const legacy = new BrowserClassRepository({
      getItem: storage.getItem,
      setItem: (key, value) => {
        if (!canSaveRecovery) throw Error('recovery write denied');
        storage.setItem(key, value);
      }
    });
    const loaded = new DesktopClassRepository(ctx.data, legacy).load(engine.createEmptyState());
    assert.equal(loaded.fromStorage, false);assert.match(loaded.warning, /格式无效/);
    assert.equal(loaded.recovery?.saved, canSaveRecovery);
    assert.equal(storage.getItem(CLASS_STORAGE_KEY), raw);assert.equal(ctx.writes, 0);
  });
}

test('native documents rejected by engine validation block recovery instead of migrating stale legacy data', () => {
  const ctx = harness(null);
  ctx.data.loadClass = () => ({ ...fixture(), version: 2 });
  const legacy = { load() { throw Error('Stale browser data must not be read.'); } } as unknown as BrowserClassRepository;
  const fallback = engine.createEmptyState();
  const loaded = new DesktopClassRepository(ctx.data, legacy).load(fallback);
  assert.equal(loaded.fromStorage, false);assert.equal(loaded.recoveryRequired, true);
  assert.match(loaded.warning, /备份版本无效/);assert.deepEqual(loaded.state, fallback);
  assert.equal(ctx.writes, 0);
});

test('unreadable legacy storage cannot be checkpointed as an empty native class', () => {
  const ctx = harness(null);
  const legacy = new BrowserClassRepository({
    getItem: () => { throw Error('storage denied'); },
    setItem: () => { throw Error('storage denied'); }
  });
  const loaded = new DesktopClassRepository(ctx.data, legacy).load(engine.createEmptyState());
  assert.equal(loaded.fromStorage, false);assert.match(loaded.warning, /未允许本机存储/);
  assert.equal(ctx.writes, 0);assert.equal(loaded.recovery, undefined);
});
