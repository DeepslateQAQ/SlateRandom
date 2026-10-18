'use strict';
// Clipboard envelopes are the only way browser Lite can hand a backup to the
// desktop build, so they are parsed as untrusted input and never committed here.
const path = require('node:path');
const FORMAT = 'SlateRandom.protocol-import';
const VERSION = 1;
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
const KINDS = Object.freeze(['all', 'settings', 'roster']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ENVELOPE_ERROR = '剪贴板内容不是有效的 SlateRandom 备份信封。';

function parseClipboardEnvelope(text, expectedKind = 'all') {
  if (typeof text !== 'string' || !text.trim()) throw Error('剪贴板中没有备份数据。');
  if (text.trim().length > MAX_BACKUP_BYTES * 2) throw Error('剪贴板备份超过 64 MB。');
  let value;
  try { value = JSON.parse(text); } catch { throw Error(ENVELOPE_ERROR); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(ENVELOPE_ERROR);
  if (value.format !== FORMAT || value.version !== VERSION) throw Error(ENVELOPE_ERROR);
  if (!KINDS.includes(value.kind) || value.kind !== expectedKind) throw Error('备份类型与导入类型不一致。');
  if (typeof value.name !== 'string') throw Error('剪贴板备份的文件名无效。');
  const trimmed = value.name.trim();
  const name = path.basename(trimmed);
  if (trimmed.length < 1 || trimmed.length > 255 || !name || name === '.' || name === '..') throw Error('剪贴板备份的文件名无效。');
  const data = value.data;
  if (typeof data !== 'string') throw Error('剪贴板备份数据不是有效的 base64。');
  if (!data.trim()) throw Error('剪贴板备份为空或超过 64 MB。');
  if (data.length % 4 !== 0 || !BASE64.test(data)) throw Error('剪贴板备份数据不是有效的 base64。');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > MAX_BACKUP_BYTES) throw Error('剪贴板备份为空或超过 64 MB。');
  return { kind: value.kind, name, bytes };
}

function backupNameAllowed(name, kind) {
  if (typeof name !== 'string' || !name) return false;
  const extension = path.extname(name).toLowerCase();
  if (!extension) return false;
  if (kind === 'all') return ['.slate', '.slatebackup', '.json'].includes(extension);
  if (kind === 'settings' || kind === 'roster') return extension === '.json';
  return false;
}

module.exports = { FORMAT, VERSION, MAX_BACKUP_BYTES, parseClipboardEnvelope, backupNameAllowed };
