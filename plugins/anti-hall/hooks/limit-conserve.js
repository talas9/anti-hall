#!/usr/bin/env node
// anti-hall :: limit-conservation helper (shared, not a hook)
//
// Exported: isConserving() -> { active, reason, weekly, fiveHour, sonnetWeekly, source, stale, resetsAt }
//
// Reports whether OMC usage limits are high enough to warrant conservation mode
// so consuming hooks can route expensive work to Codex / cheaper models.
//
// Decision layers (evaluated in priority order):
//   1. ANTIHALL_LIMIT_CONSERVE=on  -> always active (manual-on, sticky)
//   2. ANTIHALL_LIMIT_CONSERVE=off -> always inactive (manual-off)
//   3. absent / 'auto'             -> read OMC usage cache
//
// Cache: ~/.claude/plugins/oh-my-claudecode/.usage-cache-anthropic.json
//   shape: { timestamp: <epoch ms>, data: { fiveHourPercent, fiveHourResetsAt,
//            weeklyPercent, weeklyResetsAt, sonnetWeeklyPercent, sonnetWeeklyResetsAt }, rateLimited }
//
// STALE: if now - cache.timestamp > STALE_MS, stale=true but we still evaluate
// the last-known percents (conservative: assume limits are still high).
//
// RESET-AWARE: if a bucket's resetsAt is a parseable ISO date in the PAST,
// treat its percent as 0 (the reset already happened — no longer tripped).
//
// STALENESS BOUND: a bucket with NO usable resetsAt (missing/unparseable) has
// no self-correcting signal, so a snapshot that stops refreshing (companion
// dead, machine asleep) would otherwise stay "active" forever off a last-known
// high percent. Once the whole snapshot's age exceeds MAX_STALE_MS, such a
// bucket's percent is treated as 0 too — the underlying 5h/weekly window has
// certainly rolled over by then even without a parseable reset time.
//
// FAIL-OPEN direction = inactive: a detection failure must never erroneously
// force conservation mode. An unreadable / malformed cache is source:'manual-only'.
//
// ACCOUNT-CHANGE GUARD: the usage cache carries no account id, so switching the
// logged-in Claude account (a different weekly bucket) can leave a stale HIGH
// reading from the OLD account applied to the NEW one. We track the current
// account's userID (~/.claude.json, no tokens/keychain ever touched) alongside
// the cache's mtime in a small state file. If the account changed since we last
// saw it AND the cache mtime has NOT advanced since (OMC hasn't refreshed it
// under the new account yet), the cache is stale-for-this-account and we
// deactivate — the safe direction, since the user's complaint is
// over-restriction after a switch, not under-restriction. Any read failure
// (missing userID, unreadable state) falls back to the plain cache behavior
// above. Disable via ANTIHALL_LIMIT_ACCOUNT_CHECK=off.
//
// Exports: isConserving, CACHE_FILE, THRESHOLD, STALE_MS (for tests).
//
// Pure Node built-ins only. Never throws.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const settings = require('./lib/settings.js');

const CACHE_FILE = path.join(
  os.homedir(), '.claude', 'plugins', 'oh-my-claudecode', '.usage-cache-anthropic.json'
);
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
const ACCOUNT_STATE_FILE = path.join(os.homedir(), '.anti-hall', 'limit-conserve-account.json');

const STALE_MS = 15 * 60 * 1000;

// pathsFor(home): the three home-derived files. No `home` -> the module-load
// constants above (byte-identical to the historical behaviour).
// An explicit `home` (a DevSwarm ctx.home / a test fixture home) resolves all
// three under THAT home, so an in-process caller with an isolated home never
// reads the real ~/.claude.json / usage cache or writes the real
// ~/.anti-hall/limit-conserve-account.json.
function pathsFor(home) {
  if (!home) return { cache: CACHE_FILE, claudeJson: CLAUDE_JSON, accountState: ACCOUNT_STATE_FILE };
  return {
    cache: path.join(home, '.claude', 'plugins', 'oh-my-claudecode', '.usage-cache-anthropic.json'),
    claudeJson: path.join(home, '.claude.json'),
    accountState: path.join(home, '.anti-hall', 'limit-conserve-account.json'),
  };
}

// MAX_STALE_MS: snapshot-age bound backstopping buckets with no usable
// resetsAt (see STALENESS BOUND above). Longer than the 5h window itself, so
// a snapshot this old means any window it describes has definitely reset.
const MAX_STALE_MS = 6 * 60 * 60 * 1000;

// THRESHOLD: load-time snapshot kept ONLY as an exported value for tests/callers
// that read it. isConserving() does NOT use it: it resolves the threshold at
// call time through the unified settings store (env override >
// ~/.anti-hall/settings.json > default 85), so a setting or HOME change after
// require() takes effect.
const THRESHOLD = settings.get('limitConserve', 'threshold');

// readCurrentUserID(): bounded read of ~/.claude.json's top-level `userID`
// field only. Never touches the keychain or any token. null on any error.
function readCurrentUserID(p) {
  try {
    const raw = fs.readFileSync(p.claudeJson, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed.userID === 'string') ? parsed.userID : null;
  } catch (_) {
    return null;
  }
}

// readCacheMtimeMs(): mtime of the usage cache file, or null if unreadable.
function readCacheMtimeMs(p) {
  try {
    return fs.statSync(p.cache).mtimeMs;
  } catch (_) {
    return null;
  }
}

function readAccountState(p) {
  try {
    const raw = fs.readFileSync(p.accountState, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.userID !== 'string' || typeof parsed.usageCacheMtime !== 'number') return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

// writeAccountState: best-effort; a write failure must never surface (state is
// advisory, not load-bearing for the fail-open direction).
function writeAccountState(p, userID, usageCacheMtime) {
  try {
    fs.mkdirSync(path.dirname(p.accountState), { recursive: true });
    fs.writeFileSync(p.accountState, JSON.stringify({ userID, usageCacheMtime }), 'utf8');
  } catch (_) {
    /* best-effort */
  }
}

// isAccountSwitchStale(cacheMtimeMs): true when the logged-in account changed
// since our last observation AND the cache has not been refreshed since (its
// mtime did not advance past what we last recorded) — i.e. the cache still
// reflects the OLD account. Updates the stored state whenever a fresh
// reading (matching account, or an advanced mtime post-switch) is observed.
function isAccountSwitchStale(p, sopts, cacheMtimeMs) {
  if (settings.get('limitConserve', 'accountCheck', undefined, sopts) === false) {
    return false;
  }

  const currentUserID = readCurrentUserID(p);
  if (currentUserID === null) return false; // can't determine account -> no override

  const stored = readAccountState(p);
  if (!stored) {
    writeAccountState(p, currentUserID, cacheMtimeMs);
    return false;
  }

  if (stored.userID !== currentUserID) {
    if (cacheMtimeMs !== null && cacheMtimeMs <= stored.usageCacheMtime) {
      // Account switched but the cache is still the pre-switch reading.
      return true;
    }
    // Cache has advanced since the switch (or mtime is unavailable) -> trust it.
    writeAccountState(p, currentUserID, cacheMtimeMs);
    return false;
  }

  // Same account: keep the recorded mtime current so a future switch compares
  // against the freshest reading we've seen.
  if (cacheMtimeMs !== null && cacheMtimeMs !== stored.usageCacheMtime) {
    writeAccountState(p, currentUserID, cacheMtimeMs);
  }
  return false;
}

// Inactive sentinel for cache-absent / malformed cases.
const ABSENT = {
  active: false,
  reason: 'cache-absent',
  weekly: null,
  fiveHour: null,
  sonnetWeekly: null,
  source: 'manual-only',
  stale: false,
  resetsAt: null,
};

/**
 * isConserving({ home }?) -> result object (optional `home` isolates every
 * home-derived read/write; default = the process home)
 *
 * @returns {{
 *   active: boolean,
 *   reason: string,
 *   weekly: number|null,
 *   fiveHour: number|null,
 *   sonnetWeekly: number|null,
 *   source: 'env'|'cache'|'manual-only',
 *   stale: boolean,
 *   resetsAt: string|null
 * }}
 */
function isConserving(opts) {
  try {
    const home = opts && opts.home;
    const p = pathsFor(home);
    const sopts = home ? { home } : undefined;
    const threshold = settings.get('limitConserve', 'threshold', undefined, sopts);
    // Layer 1 & 2: explicit override — env > settings.json > default 'auto'
    // (v0.108.0 unified settings; see hooks/lib/settings.js). `source` still
    // reports 'env' only when the value actually came from the env var, so
    // existing env-driven assertions are unaffected; a settings.json-driven
    // override reports 'settings' instead.
    const mode = settings.get('limitConserve', 'mode', undefined, sopts);
    const modeSource = settings.source('limitConserve', 'mode', sopts) === 'env' ? 'env' : 'settings';

    if (mode === 'on') {
      return {
        active: true,
        reason: 'manual-on',
        weekly: null,
        fiveHour: null,
        sonnetWeekly: null,
        source: modeSource,
        stale: false,
        resetsAt: null,
      };
    }
    if (mode === 'off') {
      return {
        active: false,
        reason: '',
        weekly: null,
        fiveHour: null,
        sonnetWeekly: null,
        source: modeSource,
        stale: false,
        resetsAt: null,
      };
    }

    // --- Layer 3: cache path ---
    let raw;
    try {
      raw = fs.readFileSync(p.cache, 'utf8');
    } catch (_) {
      return Object.assign({}, ABSENT);
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      return Object.assign({}, ABSENT);
    }

    // Validate shape: must have a top-level data object.
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !parsed.data ||
      typeof parsed.data !== 'object'
    ) {
      return Object.assign({}, ABSENT);
    }

    const now = Date.now();
    const ts = typeof parsed.timestamp === 'number' ? parsed.timestamp : 0;
    const stale = ts > 0 ? (now - ts) > STALE_MS : true;

    const d = parsed.data;

    // effectivePct: if the bucket's resetsAt is a parseable ISO date in the PAST,
    // treat the percent as 0 (reset already happened — no longer consuming limit).
    function effectivePct(pct, resetsAt) {
      if (resetsAt && typeof resetsAt === 'string') {
        const resetTs = new Date(resetsAt).getTime();
        if (Number.isFinite(resetTs) && resetTs < now) return 0;
      } else if (ts > 0 && (now - ts) > MAX_STALE_MS) {
        // No usable resetsAt AND the snapshot itself is well past MAX_STALE_MS
        // -> don't trust a last-known-high percent indefinitely.
        return 0;
      }
      return typeof pct === 'number' ? pct : 0;
    }

    const fiveHour = effectivePct(d.fiveHourPercent, d.fiveHourResetsAt);
    const weekly = effectivePct(d.weeklyPercent, d.weeklyResetsAt);
    const sonnetWeekly = effectivePct(d.sonnetWeeklyPercent, d.sonnetWeeklyResetsAt);

    const trips = [];
    if (fiveHour >= threshold) trips.push('5h');
    if (weekly >= threshold) trips.push('weekly');
    if (sonnetWeekly >= threshold) trips.push('sonnetWeekly');

    // ACCOUNT-CHANGE GUARD: an account switch with a not-yet-refreshed cache
    // means these trips belong to the OLD account -> force inactive.
    const accountSwitchStale = trips.length > 0 && isAccountSwitchStale(p, sopts, readCacheMtimeMs(p));

    const active = !accountSwitchStale && trips.length > 0;

    // Earliest upcoming reset time among tripped buckets.
    let resetsAt = null;
    if (active) {
      const candidates = [];
      if (fiveHour >= threshold && d.fiveHourResetsAt) candidates.push(d.fiveHourResetsAt);
      if (weekly >= threshold && d.weeklyResetsAt) candidates.push(d.weeklyResetsAt);
      if (sonnetWeekly >= threshold && d.sonnetWeeklyResetsAt) candidates.push(d.sonnetWeeklyResetsAt);
      if (candidates.length) {
        const finite = candidates.filter(s => Number.isFinite(new Date(s).getTime()));
        finite.sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
        resetsAt = finite.length ? finite[0] : null;
      }
    }

    return {
      active,
      reason: active ? trips.join('+') : '',
      weekly: typeof d.weeklyPercent === 'number' ? d.weeklyPercent : null,
      fiveHour: typeof d.fiveHourPercent === 'number' ? d.fiveHourPercent : null,
      sonnetWeekly: typeof d.sonnetWeeklyPercent === 'number' ? d.sonnetWeeklyPercent : null,
      source: 'cache',
      stale,
      resetsAt,
    };
  } catch (_) {
    // Fail-open: never throw, always return inactive.
    return Object.assign({}, ABSENT);
  }
}

module.exports = { isConserving, CACHE_FILE, THRESHOLD, STALE_MS, MAX_STALE_MS, CLAUDE_JSON, ACCOUNT_STATE_FILE };
