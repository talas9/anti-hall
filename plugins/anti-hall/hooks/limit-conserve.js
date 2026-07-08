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

const CACHE_FILE = path.join(
  os.homedir(), '.claude', 'plugins', 'oh-my-claudecode', '.usage-cache-anthropic.json'
);
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
const ACCOUNT_STATE_FILE = path.join(os.homedir(), '.anti-hall', 'limit-conserve-account.json');

const STALE_MS = 15 * 60 * 1000;

// Compute THRESHOLD at load time from the child process env (each spawned hook
// process reads its own env). parseInt('', 10) is NaN so || 85 fires correctly.
const THRESHOLD = parseInt(process.env.ANTIHALL_LIMIT_THRESHOLD, 10) || 85;

// readCurrentUserID(): bounded read of ~/.claude.json's top-level `userID`
// field only. Never touches the keychain or any token. null on any error.
function readCurrentUserID() {
  try {
    const raw = fs.readFileSync(CLAUDE_JSON, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed.userID === 'string') ? parsed.userID : null;
  } catch (_) {
    return null;
  }
}

// readCacheMtimeMs(): mtime of the usage cache file, or null if unreadable.
function readCacheMtimeMs() {
  try {
    return fs.statSync(CACHE_FILE).mtimeMs;
  } catch (_) {
    return null;
  }
}

function readAccountState() {
  try {
    const raw = fs.readFileSync(ACCOUNT_STATE_FILE, 'utf8');
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
function writeAccountState(userID, usageCacheMtime) {
  try {
    fs.mkdirSync(path.dirname(ACCOUNT_STATE_FILE), { recursive: true });
    fs.writeFileSync(ACCOUNT_STATE_FILE, JSON.stringify({ userID, usageCacheMtime }), 'utf8');
  } catch (_) {
    /* best-effort */
  }
}

// isAccountSwitchStale(cacheMtimeMs): true when the logged-in account changed
// since our last observation AND the cache has not been refreshed since (its
// mtime did not advance past what we last recorded) — i.e. the cache still
// reflects the OLD account. Updates the stored state whenever a fresh
// reading (matching account, or an advanced mtime post-switch) is observed.
function isAccountSwitchStale(cacheMtimeMs) {
  if ((process.env.ANTIHALL_LIMIT_ACCOUNT_CHECK || '').toLowerCase().trim() === 'off') {
    return false;
  }

  const currentUserID = readCurrentUserID();
  if (currentUserID === null) return false; // can't determine account -> no override

  const stored = readAccountState();
  if (!stored) {
    writeAccountState(currentUserID, cacheMtimeMs);
    return false;
  }

  if (stored.userID !== currentUserID) {
    if (cacheMtimeMs !== null && cacheMtimeMs <= stored.usageCacheMtime) {
      // Account switched but the cache is still the pre-switch reading.
      return true;
    }
    // Cache has advanced since the switch (or mtime is unavailable) -> trust it.
    writeAccountState(currentUserID, cacheMtimeMs);
    return false;
  }

  // Same account: keep the recorded mtime current so a future switch compares
  // against the freshest reading we've seen.
  if (cacheMtimeMs !== null && cacheMtimeMs !== stored.usageCacheMtime) {
    writeAccountState(currentUserID, cacheMtimeMs);
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
 * isConserving() -> result object
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
function isConserving() {
  try {
    const envVal = (process.env.ANTIHALL_LIMIT_CONSERVE || '').toLowerCase().trim();

    // --- Layer 1 & 2: explicit env override ---
    if (envVal === 'on') {
      return {
        active: true,
        reason: 'manual-on',
        weekly: null,
        fiveHour: null,
        sonnetWeekly: null,
        source: 'env',
        stale: false,
        resetsAt: null,
      };
    }
    if (envVal === 'off') {
      return {
        active: false,
        reason: '',
        weekly: null,
        fiveHour: null,
        sonnetWeekly: null,
        source: 'env',
        stale: false,
        resetsAt: null,
      };
    }

    // --- Layer 3: cache path ---
    let raw;
    try {
      raw = fs.readFileSync(CACHE_FILE, 'utf8');
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
      }
      return typeof pct === 'number' ? pct : 0;
    }

    const fiveHour = effectivePct(d.fiveHourPercent, d.fiveHourResetsAt);
    const weekly = effectivePct(d.weeklyPercent, d.weeklyResetsAt);
    const sonnetWeekly = effectivePct(d.sonnetWeeklyPercent, d.sonnetWeeklyResetsAt);

    const trips = [];
    if (fiveHour >= THRESHOLD) trips.push('5h');
    if (weekly >= THRESHOLD) trips.push('weekly');
    if (sonnetWeekly >= THRESHOLD) trips.push('sonnetWeekly');

    // ACCOUNT-CHANGE GUARD: an account switch with a not-yet-refreshed cache
    // means these trips belong to the OLD account -> force inactive.
    const accountSwitchStale = trips.length > 0 && isAccountSwitchStale(readCacheMtimeMs());

    const active = !accountSwitchStale && trips.length > 0;

    // Earliest upcoming reset time among tripped buckets.
    let resetsAt = null;
    if (active) {
      const candidates = [];
      if (fiveHour >= THRESHOLD && d.fiveHourResetsAt) candidates.push(d.fiveHourResetsAt);
      if (weekly >= THRESHOLD && d.weeklyResetsAt) candidates.push(d.weeklyResetsAt);
      if (sonnetWeekly >= THRESHOLD && d.sonnetWeeklyResetsAt) candidates.push(d.sonnetWeeklyResetsAt);
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

module.exports = { isConserving, CACHE_FILE, THRESHOLD, STALE_MS, CLAUDE_JSON, ACCOUNT_STATE_FILE };
