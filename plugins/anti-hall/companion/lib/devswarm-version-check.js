'use strict';
// anti-hall :: devswarm-version-check — item 4b's shared "is a recorded
// anti-hall version stale?" primitive.
//
// Root cause (field-proven, P0): a child session auto-resumed BEFORE the
// harness re-registered a newer anti-hall build keeps running the OLD build
// (its wake-watch process has the old cache path baked in). Pre-0.108.0,
// 0.105.3 is NDJSON-only and cannot see store-side mesh mail, so the Primary
// saw such a child as `not-draining` — a coordination-failure label — when
// the real cause was simply a stale build with no signal telling either side.
//
// This module answers ONE question — "what is the newest anti-hall version
// known on this machine, and is a given recorded version behind it?" — by
// reusing update.js's OWN version-resolution chain (installed_plugins.json ->
// newest cache dir -> marketplace plugin.json), the SAME three sources
// doctor.js's harness-registration check and devswarm-wake-watch.js's own
// checkStaleVersion already read independently. It does not re-derive
// semver comparison logic — update.js's isSemver/compareVersions are the one
// definition, required lazily (fail-open if update.js is unavailable/moved).
//
// Pure fs reads, no git spawn — cheap enough to call per-workspace on a
// UserPromptSubmit hot path (devswarm-parent-inbox.js) or per-doctor-run.

const path = require('path');
const os = require('os');
const fs = require('fs');

function updateLib() {
  return require(path.join(__dirname, '..', '..', 'skills', 'update', 'scripts', 'update.js'));
}

/**
 * newestKnownAntiHallVersion({ env, home }) -> semver string | null.
 * The highest of installed_plugins.json's registered version, the newest
 * cache/anti-hall/anti-hall/<version>/ dir, and the marketplace clone's own
 * plugin.json. Fail-open to null on any resolution error (missing update.js,
 * unreadable paths, etc.) — a caller must treat null as "unknown", never as
 * "nothing newer exists".
 */
function newestKnownAntiHallVersion(opts) {
  const o = opts || {};
  try {
    const upd = updateLib();
    const home = o.home || os.homedir();
    const paths = upd.resolvePaths(o.env || process.env, home);
    const candidates = [
      upd.versionFromInstalledJson(paths.installedJson),
      upd.newestCacheVersion(paths.cacheRoot),
      upd.versionFromMarketplace(paths.pluginJson),
    ];
    let newest = null;
    for (const v of candidates) {
      if (upd.isSemver(v) && (!newest || upd.compareVersions(v, newest) > 0)) newest = v;
    }
    return newest;
  } catch (_) {
    return null;
  }
}

/**
 * isVersionStale(recordedVersion, newestVersion) -> bool. True ONLY when
 * BOTH are valid semver AND recordedVersion is STRICTLY older. Unknown
 * (non-semver/null) on either side -> false, never a false "stale" — a
 * missing/legacy heartbeat record (pre-item-4a) must never be flagged.
 */
function isVersionStale(recordedVersion, newestVersion) {
  try {
    const upd = updateLib();
    if (!upd.isSemver(recordedVersion) || !upd.isSemver(newestVersion)) return false;
    return upd.compareVersions(recordedVersion, newestVersion) < 0;
  } catch (_) {
    return false;
  }
}

/**
 * newestCliPath({ env, home, newestVersion, segments }) -> absolute path
 * string | null. Builds `<cacheRoot>/<newestVersion>/<...segments>` — e.g.
 * `segments: ['scripts', 'devswarm.js']` for the CLI entry point, or
 * `['companion', 'lib', 'devswarm-wake-watch.js']` for the watcher itself.
 * `newestVersion` may be passed in (already resolved by the caller) to avoid
 * a redundant newestKnownAntiHallVersion() call; resolved fresh otherwise.
 * Null (never a guessed/partial path) when the version cannot be resolved OR
 * when the resulting path does not actually exist on disk.
 *
 * Root cause this guards against (field repro 2026-09-25, same class as
 * devswarm-wake-watch.js's own checkStaleVersion): `newest` is the MAX of
 * three independent sources (installed_plugins.json, the newest CACHE dir,
 * and the marketplace clone's plugin.json). The marketplace clone can
 * fast-forward via a plain `git pull` well before anything mirrors that
 * version into the plugin cache — `newest` can legitimately name a version
 * with NO cache dir on disk yet. A caller that blindly builds and surfaces
 * `<cacheRoot>/<newest>/...` then hands out a `node <path>` command that
 * crashes the instant it runs. Verify the exact target FILE exists before
 * returning it, never just the version directory.
 */
function newestCliPath(opts) {
  const o = opts || {};
  try {
    const upd = updateLib();
    const home = o.home || os.homedir();
    const paths = upd.resolvePaths(o.env || process.env, home);
    const newest = o.newestVersion || newestKnownAntiHallVersion(o);
    if (!upd.isSemver(newest)) return null;
    const target = path.join(paths.cacheRoot, newest, ...(o.segments || []));
    try {
      if (!fs.statSync(target).isFile()) return null;
    } catch (_) {
      return null; // the version dir (or the file inside it) does not exist yet
    }
    return target;
  } catch (_) {
    return null;
  }
}

/**
 * staleAntiHallMessage(recordedVersion, newestVersion, cliPath) -> string.
 * The ONE wording used across the roster label, the parent-inbox nag, and
 * doctor's per-workspace report (item 4b) — a single source so the three
 * surfaces can never drift into disagreeing phrasing for the same fact.
 */
function staleAntiHallMessage(recordedVersion, newestVersion, cliPath) {
  const cmd = cliPath ? ('node ' + cliPath) : 'the newest anti-hall CLI';
  return 'stale anti-hall ' + (recordedVersion || 'unknown') + ': restart this session (or drain with `' + cmd + '`)';
}

module.exports = {
  newestKnownAntiHallVersion,
  isVersionStale,
  newestCliPath,
  staleAntiHallMessage,
};
