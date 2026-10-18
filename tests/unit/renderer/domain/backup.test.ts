import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import native from '../../../../src/main/portable-data.cjs';
import engine from '../../../../src/renderer/domain/engine';
import { BACKUP_LIMIT, BACKUP_MAGIC, applyRosterBackup, applySettingsBackup, encodeBackup, readBackup, rosterSnapshot, verifyCurrentDataForRestore } from '../../../../src/renderer/domain/backup';

function configured() {
  const state = engine.createState(Array.from({ length: 4 }, (_, index) => ({ id: String(index + 1), name: '同学' + (index + 1), row: 1, col: index + 1 })), 92873);
  state.cols = 8; state.seatRows = 6; state.className = '便携测试'; state.settings = engine.settings({ strategy: 'manual', manualMode: 'normal', friendEnabled: false, endJumpChance: 0 });
  for (let round = 0; round < 3; round++) engine.draw(state, new Date('2026-10-15T08:09:10Z'));
  return state;
}
const credentials = { vision: { active: 'openai', records: [{ provider: 'openai', model: 'gpt-6-luna', key: 'fixture-vision-secret' }] }, speech: { active: 'system', records: [] } };
function payload() { return { format: 'SlateRandomBackup', version: 1, kind: 'all', createdAt: '2026-10-15T08:09:10Z', state: configured(), credentials, desktop: { autostart: false, uac: false, uiAccess: false, autostartElevation: 'uac' } }; }
function nativeFrame(value: unknown) {
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(BACKUP_MAGIC);
  const ciphertext = Buffer.concat([cipher.update(zlib.gzipSync(JSON.stringify(value))), cipher.final()]);
  return Buffer.concat([BACKUP_MAGIC, key, iv, cipher.getAuthTag(), ciphertext]);
}

test('browser binary backup uses the exact native frame and preserves class progress and credentials', async () => {
  const original = payload(), bytes = await encodeBackup(original);
  assert.equal(BACKUP_MAGIC.length, 16); assert.equal(new TextDecoder().decode(bytes.slice(0, 16)), 'SLATERANDOM-BK1\n');
  assert.equal(new TextDecoder().decode(bytes).includes('fixture-vision-secret'), false);
  const restored = await readBackup(bytes, 'all'); assert.equal(restored.kind, 'all');
  if (restored.kind !== 'all') throw new Error();
  assert.deepEqual(restored.state, original.state); assert.deepEqual(restored.credentials, credentials); assert.deepEqual(restored.desktopSettings, original.desktop);
  const nativeRestored = native.readBackup(Buffer.from(bytes), 'all');
  assert.deepEqual(nativeRestored.state, original.state); assert.deepEqual(nativeRestored.credentials, credentials);
});
test('manual elevation preferences round-trip while old backups remain readable', async () => {
  const original = payload();
  for (const manualElevation of ['uac', 'compatibility']) {
    const bytes = await encodeBackup({ ...original, desktop: { ...original.desktop, manualElevation } });
    const restored = await readBackup(bytes, 'all');
    assert.equal(restored.kind, 'all');
    if (restored.kind !== 'all') throw new Error('Expected full backup');
    assert.equal(restored.desktopSettings?.manualElevation, manualElevation);
    assert.equal(native.readBackup(Buffer.from(bytes), 'all').desktopSettings.manualElevation, manualElevation);
  }
  const legacy = await readBackup(await encodeBackup(original), 'all');
  assert.equal(legacy.kind, 'all');
  if (legacy.kind !== 'all') throw new Error('Expected full backup');
  assert.deepEqual(legacy.desktopSettings, original.desktop);
  await assert.rejects(readBackup(nativeFrame({ ...original, desktop: { manualElevation: 'task' } })), /完整备份校验失败/);
});
test('desktop protocol preferences round-trip while non-boolean values are rejected', async () => {
  const original = payload(), desktop = {
    ...original.desktop, drawOnBallClick: true, externalDrawProtocols: true, slaterandomProtocol: false
  };
  const bytes = await encodeBackup({ ...original, desktop });
  const restored = await readBackup(bytes, 'all');
  assert.equal(restored.kind, 'all');
  if (restored.kind !== 'all') throw new Error('Expected full backup');
  assert.deepEqual(restored.desktopSettings, desktop);
  assert.deepEqual(native.readBackup(Buffer.from(bytes), 'all').desktopSettings, desktop);
  // Binary full backups report desktop validation failures through the integrity wrapper.
  await assert.rejects(readBackup(nativeFrame({ ...original, desktop: { ...desktop, slaterandomProtocol: 'true' } })), /完整备份校验失败/);
  await assert.rejects(readBackup(nativeFrame({ ...original, desktop: { ...desktop, drawOnBallClick: 1 } })), /完整备份校验失败/);
  await assert.rejects(readBackup(nativeFrame({ ...original, desktop: { ...desktop, arbitrary: 'invalid' } })), /完整备份校验失败/);
});
test('native exported full backup can be restored by the HTML codec', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-codec-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = native.createPortableStore({ directory }); store.save(configured()); store.writeCredentials('vision', credentials.vision); store.writeCredentials('speech', credentials.speech);
  const exported = store.exportData('all', { desktopSettings: payload().desktop });
  const restored = await readBackup(exported.data, 'all'); assert.equal(restored.kind, 'all');
  if (restored.kind !== 'all') throw new Error();
  assert.deepEqual(restored.state, configured()); assert.deepEqual(restored.credentials, credentials); assert.deepEqual(restored.desktopSettings, payload().desktop);
});
test('10 to 12 digit student identities round-trip between Lite and portable backups', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slate-long-id-codec-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const id of ['9999999999', '10000000000', '999999999999']) {
    const original = payload();
    original.state = engine.createState([{ id, name: '合成学生', row: 1, col: 1 }], 7);
    const liteBytes = await encodeBackup(original);
    const nativePayload = native.readBackup(Buffer.from(liteBytes), 'all');
    const store = native.createPortableStore({ directory });
    assert.deepEqual(store.restorePayload(nativePayload), { status: 'committed', generation: store.info().generation });
    assert.deepEqual(store.load(), original.state);
    const litePayload = await readBackup(store.exportData('all').data, 'all');
    assert.equal(litePayload.kind, 'all');
    if (litePayload.kind !== 'all') throw new Error('Expected a full backup');
    assert.deepEqual(litePayload.state, original.state);
  }
});

test('JSON settings and roster documents share the native format and reject wrong import targets', async () => {
  const state = configured(), createdAt = '2026-10-15T08:09:10Z';
  const settings = JSON.stringify({ format: 'SlateRandom.backup', version: 1, kind: 'settings', createdAt, settings: state.settings, credentials, desktopSettings: null });
  const roster = JSON.stringify({ format: 'SlateRandom.backup', version: 1, kind: 'roster', createdAt, roster: rosterSnapshot(state) });
  assert.equal((await readBackup(settings, 'settings')).kind, 'settings'); assert.equal(native.readBackup(settings, 'settings').kind, 'settings');
  assert.equal((await readBackup(roster, 'roster')).kind, 'roster'); assert.equal(native.readBackup(roster, 'roster').roster.seatRows, 6);
  await assert.rejects(readBackup(settings, 'roster'), /类型/); await assert.rejects(readBackup(roster, 'all'), /类型/);
});
test('old ClassState JSON restores as a full backup without replacing provider credentials', async () => {
  const state = configured(), restored = await readBackup('\uFEFF' + JSON.stringify(state), 'all');
  assert.equal(restored.kind, 'all'); if (restored.kind !== 'all') throw new Error();
  assert.deepEqual(restored.state, state); assert.deepEqual(restored.credentials, {}); assert.equal(restored.legacy, true);
  await assert.rejects(readBackup(JSON.stringify(state), 'roster'), /旧版/);
});
test('settings-only import retains all fairness, history, RNG and current cycle state', () => {
  const state = configured(), before = structuredClone(state), next = applySettingsBackup(state, { ...state.settings, directionChance: 27, timeChance: 31, renderStyle: 'overview' });
  assert.equal(next.settings.directionChance, 27); assert.equal(next.settings.renderStyle, 'overview');
  const { settings: _one, ...actual } = next, { settings: _two, ...expected } = before;
  assert.deepEqual(actual, expected); assert.deepEqual(state, before);
  assert.throws(() => applySettingsBackup(state, { directionChance: 80, timeChance: 80 }), /100/);
});
test('外观字段随设置备份往返，旧设置补齐默认值', async () => {
  const state = configured(), before = structuredClone(state);
  Object.assign(state.settings, {
    theme: 'dark', accent: '#6366f1', radius: 0,
    customCss: ':root{--qa:1}', customCssEnabled: true, backgroundTint: true
  });
  const document = {
    format: 'SlateRandom.backup', version: 1, kind: 'settings', createdAt: '2026-10-15T08:09:10Z',
    settings: state.settings, credentials, desktopSettings: null
  };
  const parsed = await readBackup(JSON.stringify(document), 'settings');
  if (parsed.kind !== 'settings') throw new Error('Expected settings backup');
  const next = applySettingsBackup(state, parsed.settings);
  assert.equal(next.settings.theme, 'dark');
  assert.equal(next.settings.accent, '#6366f1');
  assert.equal(next.settings.radius, 0);
  assert.equal(next.settings.customCss, ':root{--qa:1}');
  assert.equal(next.settings.customCssEnabled, true);
  assert.equal(next.settings.backgroundTint, true);
  const { settings: _imported, ...importedRest } = next;
  const { settings: _original, ...originalRest } = before;
  assert.deepEqual(importedRest, originalRest);

  const legacySettings = { ...state.settings };
  delete (legacySettings as Partial<typeof state.settings>).theme;
  delete (legacySettings as Partial<typeof state.settings>).accent;
  delete (legacySettings as Partial<typeof state.settings>).radius;
  delete (legacySettings as Partial<typeof state.settings>).customCss;
  delete (legacySettings as Partial<typeof state.settings>).customCssEnabled;
  delete (legacySettings as Partial<typeof state.settings>).backgroundTint;
  const legacy = await readBackup(JSON.stringify({ ...document, settings: legacySettings }), 'settings');
  if (legacy.kind !== 'settings') throw new Error('Expected settings backup');
  const upgraded = applySettingsBackup(state, legacy.settings).settings;
  assert.equal(upgraded.theme, 'system');
  assert.equal(upgraded.accent, '#65dc99');
  assert.equal(upgraded.radius, 8);
  assert.equal(upgraded.customCss, '');
  assert.equal(upgraded.customCssEnabled, false);
  assert.equal(upgraded.backgroundTint, false);
});

test('unreadable protected statistics block partial restore and cannot become a full-restore rollback snapshot', () => {
  const failure = new Error('公平统计校验失败，原文件已保留。');
  const damaged = () => { throw failure; };
  assert.throws(() => verifyCurrentDataForRestore(damaged, false), error => error === failure);
  assert.equal(verifyCurrentDataForRestore(damaged, true), false);
  assert.equal(verifyCurrentDataForRestore(() => configured(), false), true);
  assert.equal(verifyCurrentDataForRestore(() => null, true), true);
});
for (const style of ['cinema', 'cinematic']) test('retired '+style+' backup restores as normal without changing fairness or history', async () => {
  const original=configured(), legacy={...original,settings:{...original.settings,renderStyle:style}};
  const json=await readBackup(JSON.stringify(legacy),'all');
  assert.equal(json.kind,'all');if(json.kind!=='all')throw new Error();
  assert.deepEqual(json.state,original);
  const full=await readBackup(nativeFrame({...payload(),state:legacy}),'all');
  assert.equal(full.kind,'all');if(full.kind!=='all')throw new Error();
  assert.deepEqual(full.state,original);
});
test('roster-only import remaps matching names and retains their fairness, progress and imported friendship targets', () => {
  const state = configured(), before = structuredClone(state), mapping = Object.fromEntries(state.students.map(student => [student.id, String(Number(student.id) + 20)]));
  const roster = rosterSnapshot(state); roster.className = '新座位'; roster.students = roster.students.map(student => ({ ...student, id: mapping[student.id]!, friendTargets: student.id === '1' ? [mapping['2']!] : [] }));
  const next = applyRosterBackup(state, roster);
  assert.equal(next.className, '新座位'); assert.equal(next.round, state.round); assert.equal(next.rngState, state.rngState); assert.equal(next.seatRows, 6);
  for (const student of state.students) assert.deepEqual(next.fairnessStats[mapping[student.id]!], state.fairnessStats[student.id]);
  assert.deepEqual(next.cycleSeen, state.cycleSeen.map(id => mapping[id])); assert.deepEqual(next.students[0]!.friendTargets, ['22']); assert.deepEqual(next.settings, state.settings);
  assert.deepEqual(state, before);
});
test('corrupt, truncated, tampered or oversized backups fail before returning a candidate state', async () => {
  const bytes = await encodeBackup(payload());
  for (const index of [16, 48, 60, 76, bytes.length - 1]) { const modified = bytes.slice(); modified[index] = modified[index]! ^ 0x80; await assert.rejects(readBackup(modified), /校验失败/); }
  await assert.rejects(readBackup(bytes.slice(0, 76)), /不完整/);
  await assert.rejects(readBackup(new Uint8Array(BACKUP_LIMIT * 2 + 1)), /大小/);
  await assert.rejects(readBackup(new Uint8Array([0xff, 0xfe])), /UTF-8/);
  await assert.rejects(readBackup('{"version":2}'), /版本/);
  await assert.rejects(readBackup(nativeFrame({ ...payload(), padding: '0'.repeat(BACKUP_LIMIT) })), /校验失败/);
});
test('invalid credentials, desktop prerequisites, duplicate seats and future versions are rejected', async () => {
  for (const document of [
    { ...payload(), credentials: null },
    { ...payload(), credentials: { vision: { active: 'openai', records: [{ provider: 'openai', key: null }] } } },
    { ...payload(), desktop: { uiAccess: true, uac: false } },
    { ...payload(), desktop: { arbitrary: 'invalid' } },
    { ...payload(), version: 2 },
    { ...payload(), state: { ...configured(), students: [configured().students[0], configured().students[0]] } }
  ]) await assert.rejects(readBackup(nativeFrame(document)));
  const roster = { ...rosterSnapshot(configured()), counts: { '1': 0 } };
  await assert.rejects(readBackup(JSON.stringify({ format: 'SlateRandom.backup', version: 1, kind: 'roster', roster }), 'roster'), /不支持/);
});
