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

const STALE_MS = 15 * 60 * 1000;

// Compute THRESHOLD at load time from the child process env (each spawned hook
// process reads its own env). parseInt('', 10) is NaN so || 85 fires correctly.
const THRESHOLD = parseInt(process.env.ANTIHALL_LIMIT_THRESHOLD, 10) || 85;

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

    const active = trips.length > 0;

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

module.exports = { isConserving, CACHE_FILE, THRESHOLD, STALE_MS };
