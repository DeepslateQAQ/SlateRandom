'use strict';

/**
 * Decide whether the renderer will run the first-run flow, so the main window
 * can be shown immediately instead of starting hidden behind a floating ball.
 *
 * A missing portable state means a fresh install — unless the launch just
 * migrated an old profile, where the renderer owns the fallback. Anything that
 * exists is only a first run when the engine stored an explicit false; older
 * saves and backups never had the flag and normalize to completed.
 */
function needsOnboarding(saved, options = {}) {
  if (saved == null) return options.migrated !== true;
  return saved.settings?.onboardingCompleted === false;
}

module.exports = { needsOnboarding };
