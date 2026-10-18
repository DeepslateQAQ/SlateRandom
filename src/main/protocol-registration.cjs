'use strict';
// Applies or rolls back whole protocol groups. Every call is serialized so two
// settings saves can never interleave a get/mutate/write of the same backup file,
// and every failure is returned instead of thrown: the caller decides whether to
// compensate with the opposite state.
const { PROTOCOL_GROUPS } = require('./protocol-schemes.cjs');

const GROUP_LABELS = Object.freeze({ external: '外部点名协议', app: 'SlateRandom 协议' });
const EMPTY_BACKUPS = () => ({ version: 1, entries: {} });

function createProtocolRegistration({ store, registry, platform = process.platform, log = () => {} }) {
  let queue = Promise.resolve();

  function readBackups() {
    const current = store.protocols;
    return current && current.version === 1 && current.entries ? { version: 1, entries: { ...current.entries } } : EMPTY_BACKUPS();
  }

  async function applyInternal(group, enabled) {
    if (!Object.hasOwn(PROTOCOL_GROUPS, group)) return { ok: false, error: '未知的协议组。' };
    const schemes = PROTOCOL_GROUPS[group];
    if (platform !== 'win32') return enabled ? { ok: false, error: `${GROUP_LABELS[group]}仅在 Windows 桌面版可用。` } : { ok: true };
    if (!registry) return { ok: false, error: '协议注册服务不可用。' };
    let scheme = null;
    try {
      const backups = readBackups();
      if (enabled) {
        for (scheme of schemes) {
          const current = await registry.exportKey(scheme);
          if (!backups.entries[scheme]) {
            // The snapshot is persisted before the registry changes, so a crash
            // mid-write still leaves the caller able to restore the original.
            backups.entries[scheme] = current && !registry.ownsExport(current)
              ? { existed: true, reg: current.toString('base64') }
              : { existed: false };
            store.protocols = backups;
          }
          await registry.writeHandler(scheme);
        }
      } else {
        for (scheme of schemes) {
          const current = await registry.exportKey(scheme);
          const owned = current ? registry.ownsExport(current) : false;
          const entry = backups.entries[scheme];
          if (owned) {
            await registry.deleteKey(scheme);
            if (entry?.existed === true) await registry.importKey(scheme, Buffer.from(entry.reg, 'base64'));
          }
          // Another program took the association over: keep its handler, drop our backup.
          if (entry) { delete backups.entries[scheme]; store.protocols = backups; }
        }
      }
      return { ok: true };
    } catch (error) {
      log('protocol-registration-failed', { group, enabled, scheme, error: error.message });
      return { ok: false, error: error.message };
    }
  }

  return {
    /** Serialized apply; the returned promise never rejects. */
    apply(group, enabled) {
      const outcome = queue.then(() => applyInternal(group, enabled));
      queue = outcome.then(() => undefined, () => undefined);
      return outcome;
    }
  };
}

module.exports = { createProtocolRegistration };
