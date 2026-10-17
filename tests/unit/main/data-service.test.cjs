'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createPortableStore } = require('../../../src/main/portable-data.cjs');
const { installDataService } = require('../../../src/main/data-service.cjs');
const engine = require('../../../src/shared/domain/engine.js');
function setup(t, fileSystem = fs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'SlateRandom-service-'));
  t.after(() => { const resolved = fs.realpathSync(directory);assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('SlateRandom-service-'));fs.rmSync(resolved, { recursive: true, force: true }); });
  const handlers = new Map(), listeners = new Map(), store = createPortableStore({ directory, fileSystem });
  const context = { directory, store, selection: null, dialogCalls: [] };
  installDataService({ ipcMain: { handle: (id, fn) => handlers.set(id, fn), on: (id, fn) => listeners.set(id, fn) },
    trusted(event, role) { if (event.role !== role) throw Error('Untrusted window.'); }, store, engine,
    isPreview: event => event.preview === true,
    location: { directory, browserDirectory: path.join(directory, 'browser'), migrated: true }, getWindow: () => 'main',
    dialog: { async showSaveDialog(win, options) { context.dialogCalls.push({ win, options });return context.selection || { canceled: true }; } } });
  const event = (preview = false, role = 'main') => ({ role, preview, senderFrame: { url: 'file:///app/index.html' + (preview ? '?slatePreview=true' : '') } });
  context.sync = (id, value, ev = event()) => { listeners.get(id)(ev, value);return ev.returnValue; };
  context.call = (id, args = [], ev = event()) => handlers.get(id)(ev, ...args);
  context.preview = event(true);context.untrusted = event(false, 'ball');
  return context;
}
function fixture() {
  const state = engine.createState([{ id: '1', name: '甲', row: 1, col: 1 }, { id: '2', name: '乙', row: 1, col: 2 }], 71);
  state.demo = false;Object.assign(state.settings, { strategy: 'manual', manualMode: 'normal', endJumpChance: 0 });engine.draw(state);return state;
}
test('native class IPC checkpoints pass the same engine validator and persist fairness', t => {
  const ctx = setup(t), state = fixture();
  assert.deepEqual(ctx.sync('slate:data-load'), { ok: true, value: null });
  assert.equal(ctx.sync('slate:data-save', state).ok, true);
  assert.deepEqual(ctx.sync('slate:data-load').value, engine.restoreState(state));
  const before = fs.readFileSync(path.join(ctx.directory, 'statistics.srstat'));
  assert.equal(ctx.sync('slate:data-save', { version: 999 }).ok, false);
  assert.deepEqual(fs.readFileSync(path.join(ctx.directory, 'statistics.srstat')), before);
});
test('normalized 10 to 12 digit student IDs survive IPC checkpoints and complete backups', async t => {
  for (const id of ['9999999999', '10000000000', '999999999999']) {
    const ctx = setup(t), state = engine.createState([{ id, name: '合成学生', row: 1, col: 1 }], 7);
    state.demo = false;
    assert.equal(ctx.sync('slate:data-save', state).ok, true);
    assert.deepEqual(ctx.sync('slate:data-load').value, state);
    const backup = ctx.store.readBackup(ctx.store.exportData('all').data);
    const outcome = await ctx.call('slate:data-restore', [backup]);
    assert.deepEqual(outcome, { status: 'committed', generation: (await ctx.call('slate:data-info')).generation });
    assert.deepEqual(ctx.store.load(), state);
  }
});

test('invalid student IDs cannot replace a saved checkpoint', t => {
  const ctx = setup(t), original = fixture();
  assert.equal(ctx.sync('slate:data-save', original).ok, true);
  for (const id of ['1000000000000', '0', '-1', '1.5']) {
    const invalid = structuredClone(original); invalid.students[0].id = id;
    assert.equal(ctx.sync('slate:data-save', invalid).ok, false, id);
    assert.deepEqual(ctx.store.load(), original);
  }
  const duplicate = structuredClone(original); duplicate.students[1].id = '01';
  assert.equal(ctx.sync('slate:data-save', duplicate).ok, false);
  assert.deepEqual(ctx.store.load(), original);
  const normalized = engine.createState([{ id: '000000000001', name: '合成学生', row: 1, col: 1 }], 7);
  assert.equal(ctx.sync('slate:data-save', normalized).ok, true);
  assert.equal(ctx.store.load().students[0].id, '1');
});

test('preview and non-main windows cannot read/write portable secrets or class checkpoints', async t => {
  const ctx = setup(t);ctx.store.save(fixture());
  assert.equal(ctx.sync('slate:data-load', null, ctx.preview).value, null);
  assert.equal(ctx.sync('slate:data-save', fixture(), ctx.preview).ok, false);
  assert.equal(ctx.sync('slate:data-load', null, ctx.untrusted).ok, false);
  await assert.rejects(ctx.call('slate:data-credentials-read', ['vision'], ctx.preview), /预览/);
  await assert.rejects(ctx.call('slate:data-restore', [{ state: fixture(), credentials: {} }], ctx.untrusted), /Untrusted/);
});
test('immutable preview identity survives query removal, false values and role tampering', async t => {
  const ctx = setup(t), state = fixture();ctx.store.save(state);
  const credentials = { active: 'fixture', records: [] };
  ctx.store.writeCredentials('vision', credentials);
  for (const suffix of ['', '?slatePreview=false', '?slateRole=main', '?slatePreview=true']) {
    ctx.preview.senderFrame.url = 'file:///app/index.html' + suffix;
    assert.deepEqual(ctx.sync('slate:data-load', null, ctx.preview), { ok: true, value: null });
    assert.equal(ctx.sync('slate:data-save', state, ctx.preview).ok, false);
    for (const [id, args] of [
      ['slate:data-info', []], ['slate:data-credentials-read', ['vision']],
      ['slate:data-credentials-write', ['vision', { active: 'changed', records: [] }]],
      ['slate:data-restore', [{ state, credentials: {} }]],
      ['slate:data-file-save', [{ name: 'all.slate', mime: 'application/octet-stream', bytes: new Uint8Array([1]) }]]
    ]) await assert.rejects(ctx.call(id, args, ctx.preview), /预览/);
  }
  assert.deepEqual(ctx.store.readCredentials('vision'), credentials);
  assert.deepEqual(ctx.store.load(), state);assert.equal(ctx.dialogCalls.length, 0);
  const official = { role: 'main', preview: false, senderFrame: { url: 'file:///app/index.html?slatePreview=true' } };
  assert.deepEqual(ctx.sync('slate:data-load', null, official).value, state);
  assert.deepEqual(await ctx.call('slate:data-credentials-read', ['vision'], official), credentials);
});
test('corrupt statistics remain intact until an explicit validated full restore repairs them', async t => {
  const ctx = setup(t), state = fixture();ctx.store.save(state);
  const file = path.join(ctx.directory, 'statistics.srstat'), broken = fs.readFileSync(file);broken[broken.length - 8] ^= 1;fs.writeFileSync(file, broken);
  assert.equal(ctx.sync('slate:data-load').ok, false);
  const info = await ctx.call('slate:data-info');assert.equal(info.directory, ctx.directory);assert.match(info.error, /统计校验失败/);
  assert.equal(ctx.sync('slate:data-save', engine.createEmptyState()).ok, false);assert.deepEqual(fs.readFileSync(file), broken);
  const outcome = await ctx.call('slate:data-restore', [{ state, credentials: {} }]);
  assert.deepEqual(outcome, { status: 'committed', generation: (await ctx.call('slate:data-info')).generation }); assert.deepEqual(ctx.store.load(), state);
});
test('restore IPC returns the published generation while persistent I/O prevents its immediate recovery', async t => {
  let blocked = false;
  const fileSystem = { ...fs, renameSync(source, target) {
    if (blocked && path.basename(target) === 'settings.json') throw Object.assign(new Error('settings replacement blocked'), { code: 'EIO' });
    return fs.renameSync(source, target);
  } };
  const ctx = setup(t, fileSystem), before = fixture(); ctx.store.save(before);
  const after = structuredClone(before); after.className = '已提交恢复班级';
  const credentials = { vision: { active: 'vision-fixture', records: [] }, speech: { active: 'speech-fixture', records: [] } };
  blocked = true;
  const outcome = await ctx.call('slate:data-restore', [{ state: after, credentials }]);
  assert.equal(outcome.status, 'pending-recovery'); assert.match(outcome.generation, /^[a-f0-9]{32}$/); assert.match(outcome.message, /无法读写/);
  assert.equal(ctx.sync('slate:data-load').ok, false); assert.match((await ctx.call('slate:data-info')).error, /无法读写/);
  assert.equal(fs.existsSync(path.join(ctx.directory, '.state-transaction.json')), true);
  blocked = false;
  assert.deepEqual(ctx.sync('slate:data-load'), { ok: true, value: after });
  assert.equal((await ctx.call('slate:data-info')).generation, outcome.generation);
  assert.deepEqual(await ctx.call('slate:data-credentials-read', ['vision']), credentials.vision);
  assert.deepEqual(await ctx.call('slate:data-credentials-read', ['speech']), credentials.speech);
  assert.equal(fs.existsSync(path.join(ctx.directory, '.state-transaction.json')), false);
});
test('credential IPC accepts only known scopes and bounded records', async t => {
  const ctx = setup(t), payload = { active: 'deepseek', records: [{ provider: 'deepseek', key: 'fixture-only' }] };
  await ctx.call('slate:data-credentials-write', ['vision', payload]);
  assert.deepEqual(await ctx.call('slate:data-credentials-read', ['vision']), payload);
  await assert.rejects(ctx.call('slate:data-credentials-write', ['../../outside', payload]), /分区/);
  await assert.rejects(ctx.call('slate:data-restore', [{ state: fixture(), credentials: { arbitrary: payload } }]), /分区/);
});
test('export paths come exclusively from the native save dialog; cancel does not write', async t => {
  const ctx = setup(t), bytes = new Uint8Array([1, 2, 3]);
  await assert.rejects(ctx.call('slate:data-file-save', [{ name: '../backup.slate', mime: 'application/octet-stream', bytes }]), /已取消/);
  assert.equal(ctx.dialogCalls[0].options.defaultPath.includes('/'), false);
  const destination = path.join(ctx.directory, 'chosen.slate');ctx.selection = { canceled: false, filePath: destination };
  await ctx.call('slate:data-file-save', [{ name: 'backup.slate', mime: 'application/octet-stream', bytes }]);
  assert.deepEqual(fs.readFileSync(destination), Buffer.from(bytes));
  assert.deepEqual(fs.readdirSync(ctx.directory), ['chosen.slate']);
});

test('native export filters identify CSV, JSON and complete backups without writing on cancel', async t => {
  const ctx = setup(t), bytes = new Uint8Array([1]);
  for (const [name, label, extension] of [['history.csv', 'CSV 文件', 'csv'], ['roster.json', 'JSON 文件', 'json'], ['all.slate', 'SlateRandom 完整备份', 'slate']]) {
    await assert.rejects(ctx.call('slate:data-file-save', [{ name, mime: 'application/octet-stream', bytes }]), /已取消/);
    assert.deepEqual(ctx.dialogCalls.at(-1).options.filters, [{ name: label, extensions: [extension] }]);
  }
  assert.deepEqual(fs.readdirSync(ctx.directory), []);
});
