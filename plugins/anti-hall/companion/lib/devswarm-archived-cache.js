'use strict';
// anti-hall :: devswarm-archived-cache — APP-SIDE archive detection.
//
// ROOT CAUSE this closes (field report): the owner archived children in the
// DevSwarm app itself. anti-hall's own archive path (`devswarm archive <id>`,
// companion/lib/devswarm-archived.js) is what writes `archived/<id>.json`, and
// the app never calls it — so nothing on anti-hall's side ever learned those
// workspaces were put away, and every reader that keys off `isArchivedWorkspace`
// (the parent Stop gate's neglect classification, the UserPromptSubmit workspace
// table, `roster`) kept rendering them as escalated / stale / not-draining. The
// app's own view (`hivecontrol workspace list all`) DOES know; nothing was
// reading it on a live path.
//
// SHAPE: `<devswarmRoot>/hivecontrol-archived.json`
//   { fetchedAt: <ms>, byRepoKey: { "<repoKey>": ["<id>", ...] } }
// Written by the supervisor's reconcile sweep (companion/devswarm-supervisor.js
// reconcileSweepIfDue), which already runs one hivecontrol call per target — the
// probe rides inside that same cooldown-gated, single-flight sweep rather than
// adding a scheduler, and NO reader ever spawns hivecontrol itself (every reader
// here is on an every-turn hot path).
//
// FRESHNESS IS THE WHOLE SAFETY ARGUMENT. A cache is a snapshot of another
// system's state, and the owner can un-archive/re-open a workspace at any time.
// So an id counts as app-archived ONLY while the file's `fetchedAt` is younger
// than resolveArchivedCacheMaxAgeMs (default 2x the sweep interval that writes
// it — one missed sweep is tolerated, two is not). A STALE cache is IGNORED
// ENTIRELY: it never suppresses anything, so the worst a dead supervisor can do
// is return today's behavior, never silently mute a live workspace forever.
//
// SCOPE (mirrors how `archived` and `idleAlive` already behave in every reader):
// suppression applies ONLY to the LIVENESS axis (stale / escalated / dormant).
// It NEVER touches realUnread or `not-draining` — an archived-in-the-app row
// with a real aging unread backlog is still coordination neglect, and that is a
// different axis that archiving does not answer.
//
// FAIL-OPEN THROUGHOUT: a missing, unreadable, malformed, or stale cache yields
// an EMPTY id set. Nothing here throws.

const fs = require('fs');
const path = require('path');
const { devswarmRoot } = require('./liveness.js');

const CACHE_BASENAME = 'hivecontrol-archived.json';

// Fallback ONLY (see resolveArchivedCacheMaxAgeMs): the supervisor's
// DEFAULT_RECONCILE_SWEEP_COOLDOWN_MS. Not the authority — the live value is
// read from the supervisor itself so the two can never drift; this constant
// exists so a reader still gets a sane bound if that require ever fails.
const FALLBACK_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

function archivedCachePath(home) {
  return path.join(devswarmRoot(home), CACHE_BASENAME);
}

// sweepIntervalMs(env) -> the reconcile sweep's OWN cooldown, resolved from the
// supervisor's own resolver (so a tuned ANTIHALL_DEVSWARM_RECONCILE_SWEEP_SEC
// scales this bound automatically). LAZY require: companion/devswarm-supervisor.js
// requires this module, so a top-level require here would be circular.
function sweepIntervalMs(env) {
  try {
    const sup = require('../devswarm-supervisor.js');
    const ms = sup.resolveReconcileCooldownMs(env || process.env);
    if (Number.isFinite(ms) && ms > 0) return ms;
  } catch (_) { /* fall through to the fallback constant */ }
  return FALLBACK_SWEEP_INTERVAL_MS;
}

// resolveArchivedCacheMaxAgeMs(env) -> ms. How old the cache may be and still
// be believed. Default 2x the sweep interval; overridable with
// ANTIHALL_DEVSWARM_ARCHIVED_CACHE_MAX_AGE_MS (positive integer ms).
function resolveArchivedCacheMaxAgeMs(env) {
  const e = env || process.env;
  const raw = e.ANTIHALL_DEVSWARM_ARCHIVED_CACHE_MAX_AGE_MS;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = parseInt(raw.trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 2 * sweepIntervalMs(e);
}

// readArchivedCache({home, env, now, fsi}) ->
//   { present, fresh, fetchedAt, ageMs, maxAgeMs, byRepoKey }
// `byRepoKey` is ALWAYS an object and is EMPTY unless the file is present,
// well-formed AND fresh — so a caller that ignores `fresh` still cannot be
// misled by a stale snapshot. Never throws.
function readArchivedCache(opts) {
  const o = opts || {};
  const F = o.fsi || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const maxAgeMs = Number.isFinite(o.maxAgeMs) ? o.maxAgeMs : resolveArchivedCacheMaxAgeMs(o.env);
  const empty = { present: false, fresh: false, fetchedAt: null, ageMs: null, maxAgeMs, byRepoKey: {} };
  let parsed;
  try {
    parsed = JSON.parse(String(F.readFileSync(archivedCachePath(o.home), 'utf8')));
  } catch (_) { return empty; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
  const fetchedAt = Number.isFinite(parsed.fetchedAt) ? parsed.fetchedAt : null;
  if (fetchedAt === null) return Object.assign({}, empty, { present: true });
  const ageMs = now - fetchedAt;
  // A FUTURE fetchedAt (clock skew, a hand-edited file) is not evidence of
  // freshness — same posture as liveness.js's isFreshBeat. Treat it as stale.
  const fresh = ageMs >= 0 && ageMs <= maxAgeMs;
  const raw = parsed.byRepoKey;
  const byRepoKey = {};
  if (fresh && raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of Object.keys(raw)) {
      const ids = raw[k];
      if (!Array.isArray(ids)) continue; // malformed entry: ignored, never guessed at
      byRepoKey[k] = ids.filter((v) => typeof v === 'string' && v !== '');
    }
  }
  return { present: true, fresh, fetchedAt, ageMs, maxAgeMs, byRepoKey };
}

// appArchivedIdsFor({home, repoKey, env, now, fsi, cache}) -> Set<string>.
// `cache` (optional) lets a hot-path caller read the file ONCE per invocation
// and classify N rows against it.
function appArchivedIdsFor(opts) {
  const o = opts || {};
  const out = new Set();
  if (!o.repoKey) return out; // no project -> no suppression (fail-open)
  const cache = o.cache || readArchivedCache(o);
  const ids = cache && cache.byRepoKey ? cache.byRepoKey[String(o.repoKey)] : null;
  if (Array.isArray(ids)) for (const id of ids) out.add(String(id));
  return out;
}

// isAppArchived({home, repoKey, id, env, now, fsi, cache}) -> bool.
function isAppArchived(opts) {
  const o = opts || {};
  if (o.id == null) return false;
  try { return appArchivedIdsFor(o).has(String(o.id)); } catch (_) { return false; }
}

// writeArchivedCache({home, byRepoKey, now, fsi}) -> path | null (supervisor
// side). Atomic tmp+rename, same shape as every other small state file here.
//
// WHOLE-FILE REPLACE, deliberately: only the repoKeys probed in THIS sweep are
// written. Merging an earlier tick's entries forward would let one global
// `fetchedAt` vouch for a snapshot that is actually much older (the sweep caps
// projects per tick, so some are deferred) — over-suppression, the one failure
// direction this feature must not have. A project with no entry is simply not
// suppressed this cycle.
function writeArchivedCache(opts) {
  const o = opts || {};
  const F = o.fsi || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const file = archivedCachePath(o.home);
  const byRepoKey = {};
  const src = o.byRepoKey || {};
  for (const k of Object.keys(src)) {
    const ids = src[k];
    if (!Array.isArray(ids)) continue;
    byRepoKey[k] = ids.filter((v) => typeof v === 'string' && v !== '').map(String);
  }
  try {
    F.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    F.writeFileSync(tmp, JSON.stringify({ fetchedAt: now, byRepoKey }) + '\n');
    F.renameSync(tmp, file);
    return file;
  } catch (_) { return null; }
}

module.exports = {
  CACHE_BASENAME, FALLBACK_SWEEP_INTERVAL_MS,
  archivedCachePath, resolveArchivedCacheMaxAgeMs,
  readArchivedCache, appArchivedIdsFor, isAppArchived, writeArchivedCache,
};
