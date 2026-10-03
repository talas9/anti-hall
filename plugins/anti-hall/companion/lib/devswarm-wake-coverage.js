'use strict';
// anti-hall :: devswarm-wake-coverage — "does this Primary have ANY way to be
// woken by a child's mailbox message right now?" One shared read for the
// per-prompt warning (hooks/devswarm-parent-inbox.js), the Stop gate
// (hooks/devswarm-parent-gate.js), `spawn` (scripts/devswarm-lib/spawn.js) and
// the watcher's own idle-skip line (devswarm-wake-watch.js).
//
// ROOT CAUSE this closes: a Primary's session cron dies with its harness
// (session crons do not survive a restart) and the watcher Monitor exits by
// design when no child is live. Spawning workspaces afterwards re-armed
// neither, because the only re-arm cue lived inside the cron turn that no
// longer existed.
//
// Two independent wake paths:
//   - watcher: the wake-watch lock file (lockPathFor) with `ts` fresher than
//     WATCH_LOCK_STALE_MS and a live pid — the SAME rule `inbox tick`'s
//     `watcherArmed` uses.
//   - cron: for a Primary only the cron runs `inbox tick`, so the wake-tick
//     marker's age IS cron liveness. Older than devswarm.cronMissingWarnMin
//     (default 60), or no marker at all => cronLikelyMissing.
//
// wakeCoverage({home, cwd, id, now, env}) ->
//   { liveChildren, watcherLive, lastTickAgeMin, cronLikelyMissing, unknown }
// FAIL-OPEN: any error => unknown:true and every flag false/null, so callers
// (which only act on a positive finding) emit nothing.

const fs = require('fs');
const path = require('path');

function cronWarnMin(env) {
  let n = 60;
  try { n = require('../../hooks/lib/settings.js').getWithEnv('devswarm', 'cronMissingWarnMin', 60, env || process.env); }
  catch (_) { n = 60; }
  return Number.isFinite(n) && n > 0 ? n : 60;
}

function wakeCoverage(opts) {
  const o = opts || {};
  const unknown = { liveChildren: false, watcherLive: false, lastTickAgeMin: null, cronLikelyMissing: false, unknown: true };
  try {
    const home = o.home;
    const id = o.id;
    if (!home || typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id)) return unknown;
    const now = Number.isFinite(o.now) ? o.now : Date.now();

    // Positive proof only: held / archive-ignored children are not live, and an
    // undeterminable answer is `unknown` (never a live child).
    const lc = require('./devswarm-live-children.js').liveChildState(home, o.cwd || process.cwd(),
      { env: o.env, excludeHeldIgnored: true, ...(o.liveChildOpts || {}) });
    if (!lc.known) return unknown;
    const liveChildren = lc.live;

    // Watcher: fresh lock ts + a pid that is not provably dead.
    let watcherLive = false;
    try {
      const wake = require('./devswarm-wake-watch.js');
      const lock = JSON.parse(fs.readFileSync(wake.lockPathFor(home, id), 'utf8'));
      const ts = lock && Number(lock.ts);
      const fresh = Number.isFinite(ts) && (now - ts) <= wake.WATCH_LOCK_STALE_MS;
      const pid = lock && Number.isInteger(lock.pid) ? lock.pid : null;
      const alive = pid != null ? require('./liveness.js').pidIsAlive(pid) : null;
      watcherLive = !!(fresh && alive !== false);
    } catch (_) { watcherLive = false; } // no/garbled lock => not live

    // Cron: tick marker age.
    let lastTickAgeMin = null;
    try {
      const marker = JSON.parse(fs.readFileSync(
        path.join(require('./liveness.js').devswarmRoot(home), 'wake-tick', id + '.json'), 'utf8'));
      if (marker && Number.isFinite(marker.ts)) lastTickAgeMin = Math.max(0, Math.floor((now - marker.ts) / 60000));
    } catch (_) { lastTickAgeMin = null; } // absent/garbled => never ticked
    const cronLikelyMissing = lastTickAgeMin === null || lastTickAgeMin > cronWarnMin(o.env);

    // devswarm.wakeWatch off => no watcher is expected, so its absence is not a gap.
    let watcherWanted = true;
    try { watcherWanted = require('../../hooks/lib/settings.js').getWithEnv('devswarm', 'wakeWatch', true, o.env || process.env) !== false; }
    catch (_) { watcherWanted = true; }

    return { liveChildren: !!liveChildren, watcherLive, lastTickAgeMin, cronLikelyMissing, watcherWanted, unknown: false };
  } catch (_) {
    return unknown;
  }
}

module.exports = { wakeCoverage };
