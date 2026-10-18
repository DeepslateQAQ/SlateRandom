'use strict';
// slaterandom:// is this app's own control surface. Every command is reduced to a
// closed whitelist here; the main process receives plain command objects, never
// the URL, so logging a command can never leak a caller's path or payload.
const APP_SCHEME = 'slaterandom';
const APP_URL_LIMIT = 8192;
const COMMAND_LIMIT = 4096;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const APP_SCHEME_PATTERN = /^slaterandom:/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;
const ACTION_SETS = Object.freeze({
  main: Object.freeze(['show', 'hide', 'toggle']),
  settings: Object.freeze(['show', 'hide', 'toggle']),
  ball: Object.freeze(['show', 'hide', 'toggle', 'click'])
});
const IMPORT_KINDS = Object.freeze(['all', 'settings', 'roster']);
const IMPORT_SOURCES = Object.freeze(['picker', 'clipboard', 'path']);

function urlCandidates(argv) {
  const values = [];
  if (!Array.isArray(argv)) return values;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (typeof value !== 'string') continue;
    if (value === '--url' || value === '--uri') {
      const next = argv[index + 1];
      if (typeof next === 'string') values.push(next);
      continue;
    }
    values.push(value);
  }
  return values;
}
function readUrl(value) {
  const candidate = value.trim();
  if (!candidate || candidate.length > APP_URL_LIMIT || CONTROL_CHARACTERS.test(candidate)) return null;
  let url;
  try { url = new URL(candidate); } catch { return null; }
  if (url.username || url.password || url.port || url.hash) return null;
  return url;
}
/** Validates a command object and returns a normalized copy, or null. */
function normalizeAppCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.command === 'pick') return { command: 'pick' };
  if (Object.hasOwn(ACTION_SETS, value.command)) {
    const action = typeof value.action === 'string' ? value.action.toLowerCase() : '';
    return ACTION_SETS[value.command].includes(action) ? { command: value.command, action } : null;
  }
  if (value.command !== 'import') return null;
  const kind = value.kind === undefined ? 'all' : value.kind;
  if (!IMPORT_KINDS.includes(kind)) return null;
  const source = value.source === undefined ? 'picker' : value.source;
  if (!IMPORT_SOURCES.includes(source)) return null;
  const command = { command: 'import', kind, source };
  if (source === 'path') {
    if (typeof value.path !== 'string' || !value.path.trim()) return null;
    command.path = value.path;
  }
  if (value.name !== undefined) {
    if (typeof value.name !== 'string') return null;
    const name = value.name.trim();
    if (name.length > 255) return null;
    if (name) command.name = name;
  }
  return command;
}
function readCommand(url) {
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(segment => segment.length > 0);
  if (host === 'pick') return segments.length ? null : { command: 'pick' };
  if (Object.hasOwn(ACTION_SETS, host)) {
    if (segments.length > 1) return null;
    // A path segment wins over ?action=; the query stays as the shorthand form.
    return { command: host, action: segments.length ? segments[0] : url.searchParams.get('action') ?? '' };
  }
  if (host !== 'import') return null;
  // Import parameters are query-only; a path segment would silently change meaning.
  if (segments.length) return null;
  return { command: 'import', kind: url.searchParams.get('kind') ?? undefined, source: url.searchParams.get('source') ?? undefined,
    path: url.searchParams.get('path') ?? undefined, name: url.searchParams.get('name') ?? undefined };
}
/** Returns the first accepted command, or null when none is valid. */
function parseAppProtocol(argv) {
  for (const value of urlCandidates(argv)) {
    const url = readUrl(value);
    if (!url) continue;
    if (url.protocol.slice(0, -1).toLowerCase() !== APP_SCHEME) continue;
    const command = normalizeAppCommand(readCommand(url));
    if (command) return command;
  }
  return null;
}
function encodeAppCommand(command) {
  const normalized = normalizeAppCommand(command);
  if (!normalized) throw TypeError('无效的 SlateRandom 协议命令。');
  return Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64url');
}
/** Used only for the UIAccess relaunch hand-off, never for external callers. */
function decodeAppCommand(value) {
  if (typeof value !== 'string' || !value || value.length > COMMAND_LIMIT || !BASE64URL_PATTERN.test(value)) return null;
  try { return normalizeAppCommand(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))); }
  catch { return null; }
}
function hasAppProtocolScheme(argv) {
  return urlCandidates(argv).some(value => APP_SCHEME_PATTERN.test(value.trim()));
}
module.exports = { parseAppProtocol, normalizeAppCommand, encodeAppCommand, decodeAppCommand, hasAppProtocolScheme };
