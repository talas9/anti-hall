'use strict';
// jev-review.js — durable "time to review the Jev shadow numbers" tracking.
//
// WHY: most Jev integrations default to "shadow" mode (consulted + logged,
// never trusted) until an owner reviews `jev report` and explicitly promotes
// them to "on" or "off". The owner forgets to come back and check. A
// per-session cron/reminder is NOT durable (Session crons die with the
// session) so this lives in the plugin as durable on-disk state plus a
// SessionStart nudge — see jev-review-reminder.js.
//
// STATE: ~/.anti-hall/jev-review-state.json
//   {
//     "integrations": {
//       "<id>": {
//         "shadowSince": "<ISO>",       // when this id first entered shadow
//         "lastReviewedAt": "<ISO>|null",
//         "snoozedUntil": "<ISO>|null",
//         "dueSince": "<ISO>|null"      // when review-due FIRST went true
//                                       // (for the due->reviewed latency metric)
//       }
//     }
//   }
//
// A review is DUE for an integration when ALL of:
//   - it is currently in "shadow" mode (see hooks/lib/jev-assist.js getMode)
//   - shadow duration (now - shadowSince) >= jev.reviewAfterDays (default 7)
//   - decisions logged for it >= jev.reviewMinDecisions (default 30)
//   - it is not currently snoozed (snoozedUntil in the future)
//   - it has not been reviewed within the last jev.reviewAfterDays (i.e.
//     lastReviewedAt is null, or older than reviewAfterDays ago — this makes
//     the reminder recur periodically rather than firing exactly once ever).
//
// shadowSince, when unknown, is derived from the EARLIEST decision row seen
// for that id across the retained jev-assist.ndjson generations and the
// jev-daily rollups (never guessed) — falling back to "now" only when there
// is no evidence at all yet (a brand-new integration with zero decisions).
//
// METRICS (~/.anti-hall/logs/jev-review.ndjson, one row per event):
//   {ts, type:'reminder-shown', ids:[...]}
//   {ts, type:'reviewed', id, latencyMs|null}
// Never throws; best-effort append, same posture as jev-assist.js's log.

const fs = require('fs');
const path = require('path');
const testHomeGuard = require('../../companion/lib/test-home-guard.js');

function homeDir(home) {
  return testHomeGuard.resolveHome(typeof home === 'string' && home ? home : null);
}

function statePath(home) {
  return path.join(homeDir(home), '.anti-hall', 'jev-review-state.json');
}

function metricsLogPath(home) {
  return path.join(homeDir(home), '.anti-hall', 'logs', 'jev-review.ndjson');
}

function readState(home) {
  try {
    const raw = fs.readFileSync(statePath(home), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (!parsed.integrations || typeof parsed.integrations !== 'object') parsed.integrations = {};
      return parsed;
    }
  } catch (_) { /* absent/corrupt -> fresh state */ }
  return { integrations: {} };
}

// writeState(home, state) — atomic tmp+rename, same pattern as jev-setup.js's
// writeJevJsonMerged. Never throws (best-effort).
function writeState(home, state) {
  try {
    const p = statePath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, p);
  } catch (_) { /* best-effort only */ }
}

function appendMetric(home, row) {
  try {
    const p = metricsLogPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(Object.assign({ ts: new Date().toISOString() }, row)) + '\n', 'utf8');
  } catch (_) { /* best-effort only */ }
}

function readJevJson(home) {
  try {
    const raw = fs.readFileSync(path.join(homeDir(home), '.anti-hall', 'jev.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function jevSetting(home, key, dflt) {
  try {
    return require('./settings.js').get('jev', key, dflt, { home: homeDir(home) });
  } catch (_) {
    return dflt;
  }
}

// allKnownIntegrationIds(home, cfg) -> union of every jevIntegrations schema
// id plus any id present in jev.json's `integrations` map (a future id with
// no schema entry yet, same fallback jev-assist.js's own getMode uses).
function allKnownIntegrationIds(home, cfg) {
  const ids = new Set();
  try {
    const schema = require('./settings-schema.js');
    const section = schema.findSection ? schema.findSection('jevIntegrations') : null;
    if (section && Array.isArray(section.settings)) {
      for (const s of section.settings) ids.add(s.key);
    }
  } catch (_) { /* schema unavailable — fall back to jev.json only */ }
  const integrations = (cfg && cfg.integrations && typeof cfg.integrations === 'object') ? cfg.integrations : {};
  for (const id of Object.keys(integrations)) ids.add(id);
  return [...ids];
}

// shadowIntegrationIds(home) -> ids currently resolving to mode "shadow".
// Empty when Jev is not enabled at all (getMode returns 'off' for everything).
function shadowIntegrationIds(home) {
  const jevAssist = require('./jev-assist.js');
  const cfg = readJevJson(home);
  const ids = allKnownIntegrationIds(home, cfg);
  return ids.filter((id) => jevAssist.getMode(id, cfg, home) === 'shadow');
}

// --- decision-row scanning (dedup raw-vs-rollup by day, see jev-report.js's
// buildRollupHistory for the identical pattern this mirrors) ---------------

function dailyDir(home) {
  return path.join(homeDir(home), '.anti-hall', 'logs', 'jev-daily');
}

function readDailyRollups(home) {
  const dir = dailyDir(home);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const n of names.filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (r && typeof r.day === 'string' && Array.isArray(r.groups)) out.push(r);
    } catch (_) { /* skip corrupt file */ }
  }
  return out;
}

function readRawDecisionRows(home) {
  const jevAssist = require('./jev-assist.js');
  try {
    return jevAssist.readNdjsonFiles(jevAssist.retainedLogFiles(jevAssist.logPath(home)))
      .filter((r) => r && typeof r === 'object' && r.id && !r.type);
  } catch (_) {
    return [];
  }
}

// idStats(id, home) -> { decisions, earliestTs } counting every decision row
// for `id` (raw retained rows PLUS rollup-only days not covered by raw rows,
// never double-counted — mirrors jev-report.js's buildRollupHistory dedup).
function idStats(id, home) {
  const raw = readRawDecisionRows(home).filter((r) => r.id === id);
  let oldestRawTs = Infinity;
  let decisions = raw.length;
  let earliestTs = Infinity;
  for (const r of raw) {
    const t = Date.parse(r.ts);
    if (Number.isFinite(t)) {
      if (t < oldestRawTs) oldestRawTs = t;
      if (t < earliestTs) earliestTs = t;
    }
  }

  for (const rollup of readDailyRollups(home)) {
    const start = Date.parse(rollup.day + 'T00:00:00Z');
    const end = start + 86400000;
    if (!Number.isFinite(start) || end > oldestRawTs) continue; // covered by raw rows already
    for (const g of rollup.groups) {
      if (!g || g.id !== id) continue;
      decisions += g.n || 0;
      if (start < earliestTs) earliestTs = start;
    }
  }

  return { decisions, earliestTs: Number.isFinite(earliestTs) ? earliestTs : null };
}

// ensureShadowSince(state, id, home) -> ISO string, deriving + persisting
// (mutates `state` in place) it when absent per the module header contract.
function ensureShadowSince(state, id, home) {
  const entry = state.integrations[id] || (state.integrations[id] = {});
  if (typeof entry.shadowSince === 'string' && entry.shadowSince) return entry.shadowSince;
  const stats = idStats(id, home);
  entry.shadowSince = stats.earliestTs ? new Date(stats.earliestTs).toISOString() : new Date().toISOString();
  return entry.shadowSince;
}

// computeReviewDue(home, opts) -> { due: [{id, days, decisions}], checked: [id,...] }
// Persists any newly-derived shadowSince / newly-set dueSince as a side
// effect (best-effort — never throws even if the write fails).
function computeReviewDue(home, opts) {
  const now = Number.isFinite(opts && opts.now) ? opts.now : Date.now();
  const reviewAfterDays = Number(jevSetting(home, 'reviewAfterDays', 7)) || 7;
  const reviewMinDecisions = Number(jevSetting(home, 'reviewMinDecisions', 30));
  const minDecisions = Number.isFinite(reviewMinDecisions) ? reviewMinDecisions : 30;
  const windowMs = reviewAfterDays * 86400000;

  const ids = shadowIntegrationIds(home);
  const state = readState(home);
  const due = [];
  let dirty = false;

  for (const id of ids) {
    const shadowSince = ensureShadowSince(state, id, home);
    dirty = true; // ensureShadowSince may have just derived it
    const entry = state.integrations[id];
    const sinceMs = Date.parse(shadowSince);
    const days = Number.isFinite(sinceMs) ? (now - sinceMs) / 86400000 : 0;

    const stats = idStats(id, home);

    const snoozed = typeof entry.snoozedUntil === 'string' && Date.parse(entry.snoozedUntil) > now;
    const reviewedRecently = typeof entry.lastReviewedAt === 'string' &&
      Number.isFinite(Date.parse(entry.lastReviewedAt)) &&
      (now - Date.parse(entry.lastReviewedAt)) < windowMs;

    const isDue = days >= reviewAfterDays && stats.decisions >= minDecisions && !snoozed && !reviewedRecently;

    if (isDue) {
      if (!entry.dueSince) { entry.dueSince = new Date(now).toISOString(); dirty = true; }
      due.push({ id, days: Math.floor(days), decisions: stats.decisions });
    } else if (entry.dueSince) {
      // no longer due (reviewed/snoozed/demoted) — clear the latency marker.
      entry.dueSince = null;
      dirty = true;
    }
  }

  if (dirty) writeState(home, state);

  return { due, checked: ids, reviewAfterDays, reviewMinDecisions: minDecisions };
}

// markReviewed(id, home) -> { ok, latencyMs|null }. Sets lastReviewedAt=now,
// clears snoozedUntil, and logs the due->reviewed latency metric when a
// dueSince marker existed.
function markReviewed(id, home) {
  const state = readState(home);
  const entry = state.integrations[id] || (state.integrations[id] = {});
  const now = Date.now();
  let latencyMs = null;
  if (entry.dueSince) {
    const dueMs = Date.parse(entry.dueSince);
    if (Number.isFinite(dueMs)) latencyMs = now - dueMs;
  }
  entry.lastReviewedAt = new Date(now).toISOString();
  entry.dueSince = null;
  writeState(home, state);
  appendMetric(home, { type: 'reviewed', id, latencyMs });
  return { ok: true, latencyMs };
}

// snoozeIntegration(id, home, days) -> { ok, snoozedUntil } | { ok:false, error }
function snoozeIntegration(id, home, days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'snooze: --days must be a positive number' };
  const state = readState(home);
  const entry = state.integrations[id] || (state.integrations[id] = {});
  const until = new Date(Date.now() + n * 86400000).toISOString();
  entry.snoozedUntil = until;
  writeState(home, state);
  return { ok: true, snoozedUntil: until };
}

// recordReminderShown(home, ids) — metrics-only, best-effort.
function recordReminderShown(home, ids) {
  if (!Array.isArray(ids) || !ids.length) return;
  appendMetric(home, { type: 'reminder-shown', ids });
}

module.exports = {
  statePath,
  metricsLogPath,
  readState,
  writeState,
  shadowIntegrationIds,
  idStats,
  computeReviewDue,
  markReviewed,
  snoozeIntegration,
  recordReminderShown,
};
