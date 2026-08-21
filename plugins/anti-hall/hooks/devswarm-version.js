#!/usr/bin/env node
// anti-hall :: devswarm-version (SessionStart)
//
// Detects the installed DevSwarm CLI version and, when it differs from the
// version anti-hall's DevSwarm integration was last verified against, injects
// a ONE-LINE advisory additionalContext nudge. This is the drift alarm for
// plugins/anti-hall/hooks/command-guard.js's hardcoded DevSwarm CLI verb
// literals (`workspace monitor`, `read-messages`, `message-child`,
// `message-parent`) — a DevSwarm verb rename would otherwise make the guard
// fail open with no signal.
//
// DESIGN (non-blocking, cached — mirrors version-alert.js's shape exactly):
//   - Cache at ~/.anti-hall/devswarm-version.json =
//     { installed, baseline, checkedAt, source, lastAdvised? }.
//   - Fresh cache (<24 h)  => read and return, no spawn.
//   - Stale/absent cache   => spawn a DETACHED background refresh
//     (devswarm-version-refresh.js) then exit immediately. NEVER block
//     SessionStart on a spawn.
//   - installed === null (DevSwarm absent / unparseable) => FAIL-OPEN AND
//     SILENT. anti-hall must work perfectly on machines with no DevSwarm.
//   - Comparison is SEMVER-AWARE (see classifyVersionDrift below): MAJOR/MINOR
//     drift advises (that's where CLI verb renames ship); PATCH-only drift is
//     silent; unparseable either side is silent. NEVER blocks, never denies a
//     command, never gates anything — advisory only.
//   - DEDUPE: once an advisory has fired for a given (installed, baseline)
//     pair, it is not repeated while that exact pair holds — persisted as
//     cache.lastAdvised. Either value changing re-arms the advisory.
//
// Escape hatches:
//   - ANTIHALL_DEVSWARM_VERSION_ALERT=off disables the hook.
//   - skip.json { "devswarm-version": <future-ms> } (or "all") disables it.
//
// Contract (Claude Code SessionStart hook):
//   stdin  : JSON { hook_event_name, session_id, ... }
//   stdout : JSON { hookSpecificOutput: { hookEventName, additionalContext } } | nothing
//   exit 0 : always (fail-open on ANY error — never slow or block session start).

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawn } = require('child_process');
const { DEVSWARM_BASELINE } = require('./lib/devswarm-baseline.js');

const CACHE_FILE   = path.join(os.homedir(), '.anti-hall', 'devswarm-version.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// BASELINE — re-exported locally for readability; single source of truth is
// hooks/lib/devswarm-baseline.js (consumed by this hook, the refresh script,
// and doctor-devswarm.js so the three can never diverge).
const BASELINE = DEVSWARM_BASELINE;

// parseSemver(v) -> [major, minor, patch] | null. Accepts an optional leading
// 'v' and an optional patch segment (treated as 0 when absent — "2.5" reads
// as 2.5.0). Any non-numeric segment => unparseable => null.
function parseSemver(v) {
  if (typeof v !== 'string' || !v) return null;
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) return null;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  const patch = m[3] !== undefined ? parseInt(m[3], 10) : 0;
  if (![major, minor, patch].every(Number.isFinite)) return null;
  return [major, minor, patch];
}

// classifyVersionDrift(installed, baseline) -> {
//   advise: boolean,
//   reason: 'match' | 'patch' | 'newer' | 'older' | 'unparseable',
// }
//
// PURE — no I/O, exported for direct unit testing.
//   - Unparseable installed or baseline => { advise:false, reason:'unparseable' }
//     (fail-open: never guess, never throw).
//   - Equal MAJOR.MINOR (patch-only drift, including an exact match) =>
//     { advise:false, reason: installed===baseline ? 'match' : 'patch' }.
//     Patches don't rename CLI verbs, so this stays silent.
//   - installed's MAJOR.MINOR > baseline's => { advise:true, reason:'newer' }.
//   - installed's MAJOR.MINOR < baseline's => { advise:true, reason:'older' }
//     (a downgrade relative to the verified baseline — wording must reflect
//     "older", not "newer").
function classifyVersionDrift(installed, baseline) {
  const a = parseSemver(installed);
  const b = parseSemver(baseline);
  if (!a || !b) return { advise: false, reason: 'unparseable' };

  const [aMaj, aMin] = a;
  const [bMaj, bMin] = b;

  if (aMaj === bMaj && aMin === bMin) {
    return { advise: false, reason: installed === baseline ? 'match' : 'patch' };
  }
  if (aMaj > bMaj || (aMaj === bMaj && aMin > bMin)) {
    return { advise: true, reason: 'newer' };
  }
  return { advise: true, reason: 'older' };
}

// readCache() — returns { installed, baseline, checkedAt, source, lastAdvised? }
// or throws (absent / malformed).
function readCache() {
  const raw = fs.readFileSync(CACHE_FILE, 'utf8');
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== 'object') throw new Error('bad cache');
  if (!Number.isFinite(obj.checkedAt)) throw new Error('bad cache shape'); // reject NaN/Infinity too
  return obj;
}

// alreadyAdvised(cache, installed, baseline) -> true when cache.lastAdvised
// already matches this exact (installed, baseline) pair. A malformed/missing
// lastAdvised field must NEVER suppress a genuine advisory — any shape other
// than an exact match on both fields reads as "not yet advised".
function alreadyAdvised(cache, installed, baseline) {
  const la = cache && cache.lastAdvised;
  if (!la || typeof la !== 'object') return false;
  return la.installed === installed && la.baseline === baseline;
}

// persistAdvised(cache, installed, baseline) — best-effort rewrite of the SAME
// cache file with cache.lastAdvised updated, so the next session's identical
// pair is suppressed. Fail-open: any write error is swallowed — worst case the
// advisory repeats once more next session, which is never a correctness bug,
// only extra noise.
function persistAdvised(cache, installed, baseline) {
  try {
    const next = Object.assign({}, cache, { lastAdvised: { installed, baseline } });
    const tmp = CACHE_FILE + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(next), 'utf8');
    fs.renameSync(tmp, CACHE_FILE);
  } catch (_) {
    // fail-open: dedupe is a nicety, not a correctness requirement.
  }
}

// Spawn the background refresh script detached + unref'd so SessionStart
// returns immediately. Fails silently — no probe = no cache write = next
// session retries. spawnFn is injectable (defaults to the real child_process
// spawn) so tests can assert the ACTUAL spawn options (detached/unref'd)
// instead of a generous latency bound that a blocking spawn could still pass.
function spawnRefresh(spawnFn) {
  const doSpawn = spawnFn || spawn;
  try {
    const refreshScript = path.join(__dirname, 'devswarm-version-refresh.js');
    const child = doSpawn(process.execPath, [refreshScript], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (_) {
    // fail-open: process spawn failed, etc. — silent.
  }
}

function main() {
  // Env off-switch (case-insensitive).
  if ((process.env.ANTIHALL_DEVSWARM_VERSION_ALERT || '').toLowerCase() === 'off') return;

  // Skip-guard escape hatch.
  try {
    const sg = require('./skip-guard.js');
    if (sg.isSkipped('devswarm-version')) return;
  } catch (_) { /* skip-guard missing => no-op */ }

  const now = Date.now();

  let cache = null;
  try {
    cache = readCache();
  } catch (_) {
    cache = null; // absent or malformed => treat as stale
  }

  // age must be NON-NEGATIVE: a future checkedAt (clock rollback / manual edit)
  // would otherwise read as perpetually "fresh" and never re-probe. age<0 => stale.
  const age = cache !== null ? now - cache.checkedAt : Infinity;
  const fresh = cache !== null && age >= 0 && age < CACHE_TTL_MS;

  if (!fresh) {
    // Stale / absent: kick off background refresh; no alert this session.
    spawnRefresh();
    return;
  }

  // FAIL-OPEN AND SILENT: DevSwarm absent or unparseable => nothing to advise.
  if (cache.installed === null || typeof cache.installed !== 'string' || !cache.installed) return;

  // Cache is fresh and DevSwarm is present — advise only on a real major/minor
  // drift (patch-only drift and unparseable versions stay silent).
  const drift = classifyVersionDrift(cache.installed, BASELINE);
  if (!drift.advise) return;

  // Dedupe: don't repeat the same advisory every session while the pair holds.
  if (alreadyAdvised(cache, cache.installed, BASELINE)) return;

  const additionalContext = drift.reason === 'older'
    ? `DevSwarm ${cache.installed} installed; anti-hall's integration is verified against ` +
      `${BASELINE} (newer) — behavior may have drifted, see docs/KB-devswarm-hivecontrol.md`
    : `DevSwarm ${cache.installed} installed; anti-hall's integration is verified against ` +
      `${BASELINE} — behavior may have drifted, see docs/KB-devswarm-hivecontrol.md`;
  const out = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  };
  // Synchronous write: avoids the macOS node 18/20 async-pipe-flush truncation
  // that process.stdout.write can cause when the process exits immediately after.
  fs.writeSync(1, JSON.stringify(out) + '\n');

  persistAdvised(cache, cache.installed, BASELINE);
}

if (require.main === module) {
  try {
    main();
  } catch (_) {
    // Fail-open: unexpected throw, etc.
  }
  process.exit(0);
}

module.exports = {
  BASELINE,
  parseSemver,
  classifyVersionDrift,
  alreadyAdvised,
  spawnRefresh,
  CACHE_FILE,
};
