'use strict';
// anti-hall :: drift-baseline — shared mechanics for anti-hall's drift-probe
// family (SessionStart advisories that catch anti-hall's OWN knowledge going
// stale: DevSwarm CLI version, Claude Code CLI version, repo self-drift).
//
// This module holds ONLY the reusable MECHANICS (semver parsing/comparison,
// cache read/freshness, generic key-based dedupe, atomic cache writes, a
// detached-spawn helper). Each probe owns its OWN baseline value(s) and cache
// filename — this module never hardcodes a version or a path to a specific
// cache file, so it stays generic across all three probes:
//   - hooks/devswarm-version.js + devswarm-version-refresh.js (existing,
//     unchanged — predates this module, keeps its own local copies of the
//     same logic; not touched here to avoid destabilizing a shipped probe)
//   - hooks/claude-cli-version.js + claude-cli-version-refresh.js (new)
//   - hooks/repo-self-drift.js (new; synchronous, no refresh script needed)
//
// DESIGN NOTES (mirrors devswarm-version.js's shipped shape):
//   - Cache lives under ~/.anti-hall/<name>.json. Fresh cache (<TTL) is read
//     with no spawn/scan; stale/absent cache triggers a refresh (background
//     spawn for the two version probes; synchronous re-scan for repo-self-
//     drift, since a few fs.readdirSync calls are cheap enough not to need a
//     detached child).
//   - Dedupe is GENERIC: alreadyAdvisedKey/persistAdvisedKey take an arbitrary
//     plain-object key (e.g. {installed,baseline} or {claimedHooks,actualHooks})
//     and compare/persist it under cache.lastAdvised via a stable (sorted-key)
//     JSON serialization, so probes never repeat the same advisory forever
//     while nothing has changed. A malformed/missing lastAdvised NEVER
//     suppresses a genuine advisory (fail-open).
//   - FAIL-OPEN AND SILENT everywhere: malformed cache, missing source,
//     unparseable version, thrown error — every one of these returns quietly
//     rather than guessing or crashing. A drift probe that breaks a session
//     is worse than the drift it was meant to catch.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// cacheFilePath(name) -> ~/.anti-hall/<name>.json
function cacheFilePath(name) {
  return path.join(os.homedir(), '.anti-hall', name);
}

// parseSemver(v) -> [major, minor, patch] | null. Accepts an optional leading
// 'v' and an optional patch segment (treated as 0 when absent). Any
// non-numeric segment => unparseable => null. PURE.
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
// PURE. Same semver-aware contract as devswarm-version.js's copy: PATCH-only
// drift (including exact match) never advises; a MAJOR/MINOR difference in
// either direction does, labeled 'newer' or 'older' relative to baseline.
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

// readCache(cacheFile) -> parsed object, or throws (absent/malformed). Same
// contract as devswarm-version.js's readCache: caller treats a throw as
// "stale/absent, go refresh".
function readCache(cacheFile) {
  const raw = fs.readFileSync(cacheFile, 'utf8');
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== 'object') throw new Error('bad cache');
  if (!Number.isFinite(obj.checkedAt)) throw new Error('bad cache shape');
  return obj;
}

// isFresh(cache, now, ttlMs) -> boolean. age must be NON-NEGATIVE: a future
// checkedAt (clock rollback / manual edit) reads as stale, never as
// perpetually fresh.
function isFresh(cache, now, ttlMs) {
  if (!cache) return false;
  const age = now - cache.checkedAt;
  return age >= 0 && age < ttlMs;
}

// stableKeyString(key) -> a JSON string with object keys sorted, so equal
// key objects always serialize identically regardless of property order.
function stableKeyString(key) {
  if (!key || typeof key !== 'object') return JSON.stringify(key);
  const sorted = {};
  for (const k of Object.keys(key).sort()) sorted[k] = key[k];
  return JSON.stringify(sorted);
}

// alreadyAdvisedKey(cache, key) -> true when cache.lastAdvised already equals
// `key` (deep, order-independent). A malformed/missing lastAdvised NEVER
// suppresses a genuine advisory — fail-open.
function alreadyAdvisedKey(cache, key) {
  const la = cache && cache.lastAdvised;
  if (!la || typeof la !== 'object') return false;
  return stableKeyString(la) === stableKeyString(key);
}

// persistAdvisedKey(cacheFile, cache, key) — best-effort rewrite of the SAME
// cache file with cache.lastAdvised set to `key`. Fail-open: a write error is
// swallowed — worst case the advisory repeats once more next session, never a
// correctness bug, only extra noise.
function persistAdvisedKey(cacheFile, cache, key) {
  try {
    const next = Object.assign({}, cache, { lastAdvised: key });
    atomicWriteJSON(cacheFile, next);
  } catch (_) {
    // fail-open: dedupe is a nicety, not a correctness requirement.
  }
}

// atomicWriteJSON(cacheFile, data) — tmp file + rename so a session starting
// mid-write never reads a partial cache. Creates the parent dir if needed.
function atomicWriteJSON(cacheFile, data) {
  const dir = path.dirname(cacheFile);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* best effort */ }
  const tmp = cacheFile + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, cacheFile);
}

// emitAdvisory(text) — write the SessionStart hookSpecificOutput envelope.
// Synchronous fs.writeSync(1, …) avoids the macOS node 18/20 async-pipe-flush
// truncation that process.stdout.write can cause when the process exits
// immediately after writing.
function emitAdvisory(text) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: text,
    },
  };
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

// spawnDetachedRefresh(scriptPath, spawnFn) — spawn a background refresh
// script detached + unref'd so SessionStart returns immediately. Fails
// silently on any spawn error (no probe this session => cache stays stale =>
// next session retries). spawnFn is injectable for tests.
function spawnDetachedRefresh(scriptPath, spawnFn) {
  const { spawn } = require('child_process');
  const doSpawn = spawnFn || spawn;
  try {
    const child = doSpawn(process.execPath, [scriptPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (_) {
    // fail-open
  }
}

module.exports = {
  cacheFilePath,
  parseSemver,
  classifyVersionDrift,
  readCache,
  isFresh,
  alreadyAdvisedKey,
  persistAdvisedKey,
  atomicWriteJSON,
  emitAdvisory,
  spawnDetachedRefresh,
};
