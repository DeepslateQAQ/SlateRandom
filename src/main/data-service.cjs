'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const LIMIT = 64 * 1024 * 1024;

/** Fixed data operations only; renderers never choose application file paths. */
function installDataService({ ipcMain, trusted, isPreview, store, engine, location, dialog, getWindow }) {
  function check(event, writable = true) {
    trusted(event, 'main');
    if (writable && isPreview(event)) throw Error('交接预览不可写入正式数据。');
  }
  function sync(channel, operation) {
    ipcMain.on(channel, (event, value) => {
      try { check(event, false);event.returnValue = { ok: true, value: operation(event, value) }; }
      catch (error) { event.returnValue = { ok: false, error: error.message }; }
    });
  }
  function handle(channel, operation) {
    ipcMain.handle(channel, async (event, ...args) => { check(event);return operation(...args); });
  }
  function scope(value) {
    if (value !== 'vision' && value !== 'speech') throw Error('提供商分区无效。');
    return value;
  }
  function credentials(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('提供商设置格式无效。');
    if (Object.keys(value).some(key => key !== 'vision' && key !== 'speech')) throw Error('提供商分区无效。');
    for (const item of Object.values(value)) {
      if (!item || typeof item !== 'object' || typeof item.active !== 'string' || !Array.isArray(item.records) || item.records.length > 100) throw Error('提供商设置格式无效。');
    }
    if (Buffer.byteLength(JSON.stringify(value)) > LIMIT / 4) throw Error('提供商设置文件过大。');
    return value;
  }
  sync('slate:data-load', event => isPreview(event) ? null : (() => {
    const state = store.load();return state === null ? null : engine.restoreState(state);
  })());
  sync('slate:data-save', (event, state) => {
    check(event);store.save(engine.restoreState(state));return null;
  });
  handle('slate:data-info', () => {
    try { return { ...store.info(), browserDirectory: location.browserDirectory, portable: true, migrated: location.migrated }; }
    catch (error) { return { directory: location.directory, browserDirectory: location.browserDirectory, portable: true, migrated: location.migrated, error: error.message }; }
  });
  handle('slate:data-credentials-read', name => store.readCredentials(scope(name)));
  handle('slate:data-credentials-write', (name, value) => {
    scope(name);credentials({ [name]: value });store.writeCredentials(name, value);
  });
  handle('slate:data-restore', value => {
    if (!value || typeof value !== 'object') throw Error('完整备份格式无效。');
    return store.restorePayload({ state: engine.restoreState(value.state), credentials: credentials(value.credentials || {}) });
  });
  handle('slate:data-file-save', async value => {
    if (!value || typeof value.name !== 'string' || !value.name.trim() || typeof value.mime !== 'string') throw Error('导出文件参数无效。');
    const bytes = value.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.length > LIMIT) throw Error('导出文件过大或格式无效。');
    const name = value.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 200);
    const result = await dialog.showSaveDialog(getWindow(), { title: '导出 SlateRandom 数据', defaultPath: name,
      filters: [{ name: name.endsWith('.json') ? 'JSON 文件' : name.endsWith('.csv') ? 'CSV 文件' : 'SlateRandom 完整备份', extensions: [name.endsWith('.json') ? 'json' : name.endsWith('.csv') ? 'csv' : 'slate'] }] });
    if (result.canceled || !result.filePath) throw Error('已取消导出。');
    const target = path.resolve(result.filePath);
    const temporary = path.join(path.dirname(target), '.SlateRandom-export-' + crypto.randomBytes(12).toString('hex') + '.tmp');
    try { fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });fs.renameSync(temporary, target); }
    finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  });
}
module.exports = { installDataService };
