'use strict';
// ICC-CE style callers hand the app a protocol URL on the command line or via a
// second instance. Only the documented routes below are accepted; the full URL
// never leaves this module so logs can stay free of query data.
// namepicker has no route grammar to honour: neither the PyQt lineage nor the
// Flutter remake (unDefFtr/NamePicker) registers or parses the scheme, so every
// namepicker:// URL counts as one pick request.
const DRAW_SCHEMES = new Set(['secrandom', 'namepicker']);
const DRAW_URL_LIMIT = 8192;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DRAW_SCHEME_PATTERN = /^(?:secrandom|namepicker):/i;

/** Candidates in argv order: an explicit --url/--uri value is not repeated. */
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
  if (!candidate || candidate.length > DRAW_URL_LIMIT || CONTROL_CHARACTERS.test(candidate)) return null;
  let url;
  try { url = new URL(candidate); } catch { return null; }
  if (url.username || url.password || url.port || url.hash) return null;
  return url;
}
function readSecRandomRoute(url) {
  const host = url.hostname.toLowerCase(), route = url.pathname.toLowerCase().replace(/\/+$/, '');
  if (host === 'roll_call' && route === '/quick_draw') return 'roll_call/quick_draw';
  if (host === 'roll_call' && route === '/direct_extraction') return 'roll_call/direct_extraction';
  if (host === 'direct_extraction' && route === '') return 'direct_extraction';
  return null;
}
/** Returns { protocol, route } for the first accepted URL, or null. */
function parseDrawRequest(argv) {
  for (const value of urlCandidates(argv)) {
    const url = readUrl(value);
    if (!url) continue;
    const scheme = url.protocol.slice(0, -1).toLowerCase();
    if (!DRAW_SCHEMES.has(scheme)) continue;
    if (scheme === 'namepicker') return { protocol: 'namepicker', route: 'namepicker' };
    const route = readSecRandomRoute(url);
    if (route) return { protocol: 'secrandom', route };
  }
  return null;
}
/** Distinguishes "no protocol argument at all" from "protocol present but rejected". */
function hasDrawProtocolScheme(argv) {
  return urlCandidates(argv).some(value => DRAW_SCHEME_PATTERN.test(value.trim()));
}
module.exports = { parseDrawRequest, hasDrawProtocolScheme };
