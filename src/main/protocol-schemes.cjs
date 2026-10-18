'use strict';
// The scheme groups are the only protocol identities this app may ever write,
// back up, restore or parse. Keep them frozen: every registry call asserts
// against these arrays before touching HKCU.
const PROTOCOL_GROUPS = Object.freeze({
  external: Object.freeze(['secrandom', 'namepicker']),
  app: Object.freeze(['slaterandom'])
});
const PROTOCOL_SCHEMES = Object.freeze([
  ...PROTOCOL_GROUPS.external,
  ...PROTOCOL_GROUPS.app
]);
module.exports = { PROTOCOL_GROUPS, PROTOCOL_SCHEMES };
