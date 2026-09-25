'use strict';
// anti-hall :: stop-version-gate — downgrade a NUDGE-class Stop hook's block
// to advisory (skip it) once `claude plugin update` has re-registered a newer
// anti-hall version than the one THIS hook process is still executing.
//
// PEER COMPLAINT this addresses (SkyCrew + tf3 Primaries, 2026-09-26): about
// 40 Stops were blocked in one session by an already-fixed old nudge, because
// `installed_plugins.json` (harness-owned) was re-registered at the newer
// version but the running session's hooks kept executing the OLD build until
// a full restart — /reload-plugins does not pick this up (doctor.js's own
// harness-registration check, `claude plugin update --help` documents
// "restart required to apply", field-verified 2026-09-24).
//
// VERIFIED FIRST (before writing this file): can a running old hook actually
// know a newer version is registered? YES — doctor.js already does exactly
// this comparison, read-only, cheap (sync fs reads, no network): it reuses
// skills/update/scripts/update.js's own `resolvePaths` /
// `versionFromInstalledJson` / `isSemver` / `compareVersions` exports to
// compare installed_plugins.json's registered version against THIS process's
// own ../.claude-plugin/plugin.json version. This module reuses the SAME
// exports (no reimplementation) rather than parsing installed_plugins.json
// itself.
//
// LIMITATION (explicit, not glossed over): a hook build that PREDATES this
// file has no way to run this check — it cannot self-downgrade. This only
// helps sessions running this version (the one that shipped the check) or
// later. Old builds already in the field gain nothing retroactively.
//
// SCOPE: opt-in per call site. NEVER applied to a safety guard (command-
// guard/edit-guard/git-guard stay out of scope) — only to nudge-class Stop
// hooks that call isStale() themselves (silent-agent-nudge.js,
// tasklist-guard.js, devswarm-parent-gate.js's NEGLECT nag).
//
// Settings: guards.stopHookVersionDowngrade (boolean, default true) —
// ANTIHALL_STOP_HOOK_VERSION_DOWNGRADE=off disables (kill switch; a disabled
// check means isStale() always returns false, i.e. hooks block normally,
// exactly like before this feature existed).
//
// FAIL-OPEN TO "NOT STALE": any error (update.js missing/throws, malformed
// installed_plugins.json, missing plugin.json) -> isStale() returns false ->
// the caller blocks exactly as it always has. A broken version check must
// never silently suppress a real, still-relevant nudge.

const path = require('path');

// isStale(pluginRoot, opts?) -> boolean. `pluginRoot` is the anti-hall plugin
// root directory (the one containing .claude-plugin/plugin.json and
// skills/update/scripts/update.js) — callers pass path.join(__dirname, '..')
// from hooks/*.js. opts: { env, home } injectable for tests.
function isStale(pluginRoot, opts) {
  try {
    const o = opts || {};
    const env = o.env || process.env;
    const home = o.home || require('os').homedir();

    try {
      const enabled = require('./settings.js').get('guards', 'stopHookVersionDowngrade', true, { env, home });
      if (enabled === false) return false;
    } catch (_) { /* settings unavailable -> proceed with the check */ }

    const upd = require(path.join(pluginRoot, 'skills', 'update', 'scripts', 'update.js'));
    const updPaths = upd.resolvePaths(env, home);
    const harnessVersion = upd.versionFromInstalledJson(updPaths.installedJson);
    const running = require(path.join(pluginRoot, '.claude-plugin', 'plugin.json')).version;
    if (!upd.isSemver(harnessVersion) || !upd.isSemver(running)) return false;
    return upd.compareVersions(running, harnessVersion) < 0;
  } catch (_) {
    return false;
  }
}

module.exports = { isStale };
