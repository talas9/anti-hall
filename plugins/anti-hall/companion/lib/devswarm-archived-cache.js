'use strict';
// anti-hall :: devswarm-archived-cache — APP-SIDE archive detection, by ABSENCE.
//
// ROOT CAUSE this closes (field report): the owner archived children in the
// DevSwarm app itself. anti-hall's own archive path (`devswarm archive <id>`,
// companion/lib/devswarm-archived.js) is what writes `archived/<id>.json`, and
// the app never calls it — so nothing on anti-hall's side ever learned those
// workspaces were put away, and every reader that keys off `isArchivedWorkspace`
// (the parent Stop gate's neglect classification, the UserPromptSubmit workspace
// table, `roster`) kept rendering them as escalated / stale / not-draining.
//
// WHY ABSENCE AND NOT A FLAG (the D3 redesign). The first cut of this feature
// probed for an `archived`/`isArchived`/`status`/`isHidden`/`isActive` FIELD on
// the app's own records. MEASURED against the installed CLI (hivecontrol 2.5.1),
// `hivecontrol workspace list all` emits a flat JSON array whose records carry
// EXACTLY {id, branch, sourceBranch, repositoryId, label, aiAgent, worktreePath,
// createdAt} — no archive field of any name, and the subcommand takes no filter
// flags. So the field-pinned probe was INERT: it could never write a single
// entry. What the list DOES express is membership: an archived workspace simply
// stops being listed (measured on this machine: 60 registry descriptors vs 16
// listed records). This file therefore caches the ACTIVE set and derives
// "archived" from ABSENCE.
//
// SHAPE: `<devswarmRoot>/hivecontrol-active.json`
//   { fetchedAt: <ms>, byRepoKey: { "<repoKey>": [{ id, worktreePath }, ...] },
//     recordCount: <n> }
// Written by the supervisor's reconcile sweep (companion/devswarm-supervisor.js
// reconcileSweepIfDue), which already runs one hivecontrol call per target — the
// probe rides inside that same cooldown-gated, single-flight sweep rather than
// adding a scheduler, and NO reader ever spawns hivecontrol itself (every reader
// here is on an every-turn hot path).
//
// KEYED BY repoKey, NOT repositoryId, deliberately: repoKey is the partition key
// EVERY reader already holds and passes (the gate's resolved `dKey`, the roster's
// `repoKey`, the sweep target's `t.repoKey`), whereas the app's `repositoryId`
// appears on the records but on no reader's row by that name. Keying by a value
// half the call sites would have to re-derive would only ADD failure modes; the
// bucket key exists purely to scope the search, and the actual match below is on
// worktreePath/id, which are the app's own identifiers.
//
// THE ABSENCE RULE — all four conjuncts must hold before a row is app-archived:
//   1. the cache is FRESH (resolveArchivedCacheMaxAgeMs, below);
//   2. the row's worktreePath is UNDER THE DEVSWARM REPOS ROOT. A row the app
//      never managed (the Primary's own checkout, a hand-made git worktree) is
//      absent from `workspace list all` because it was NEVER a workspace, not
//      because it was archived. Without this conjunct absence would silently
//      re-classify the Primary itself.
//   3. NO active record matches the row, by worktreePath OR by id. Either alone
//      is sufficient evidence the workspace is still live.
//   4. the row is OLDER than the snapshot by at least the GRACE
//      (ANTIHALL_DEVSWARM_ARCHIVED_GRACE_MS, default 10 min). A workspace
//      registered after the sweep ran is legitimately absent from a snapshot
//      taken before it existed; without the grace, every freshly-spawned child
//      would read as archived for one whole sweep interval. The row's age comes
//      from its registry descriptor file's mtime — the only durable "when did
//      anti-hall first learn about this row" signal the registry carries (the
//      descriptor JSON has no createdAt). An UNKNOWN age never suppresses.
//
// FRESHNESS IS THE OTHER HALF OF THE SAFETY ARGUMENT. A cache is a snapshot of
// another system's state, and the owner can un-archive/re-open a workspace at
// any time. So the absence rule applies ONLY while `fetchedAt` is younger than
// resolveArchivedCacheMaxAgeMs (default 2x the sweep interval that writes it —
// one missed sweep is tolerated, two is not). A STALE cache is IGNORED
// ENTIRELY: it never suppresses anything, so the worst a dead supervisor can do
// is return today's behavior, never silently mute a live workspace forever.
//
// SCOPE (mirrors how `archived` and `idleAlive` already behave in every reader):
// suppression applies ONLY to the LIVENESS axis (stale / escalated / dormant).
// It NEVER touches realUnread or `not-draining` — an archived-in-the-app row
// with a real aging unread backlog is still coordination neglect, and that is a
// different axis that archiving does not answer.
//
// FAIL-OPEN THROUGHOUT: a missing, unreadable, malformed, or stale cache — or an
// unknown row age — yields NO suppression. Nothing here throws.

const fs = require('fs');
const path = require('path');
const { devswarmRoot } = require('./liveness.js');

const CACHE_BASENAME = 'hivecontrol-active.json';

// Fallback ONLY (see resolveArchivedCacheMaxAgeMs): the supervisor's
// DEFAULT_RECONCILE_SWEEP_COOLDOWN_MS. Not the authority — the live value is
// read from the supervisor itself so the two can never drift; this constant
// exists so a reader still gets a sane bound if that require ever fails.
const FALLBACK_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

// DEFAULT_ARCHIVED_GRACE_MS — conjunct 4 above. 10 minutes: comfortably longer
// than the register -> app-list-visibility window, far shorter than the
// freshness bound, so a genuinely archived row is still detected on the very
// next sweep after the grace elapses.
const DEFAULT_ARCHIVED_GRACE_MS = 10 * 60 * 1000;

// The DevSwarm app's own worktree root segment. Every record the app emitted on
// the measured machine lives under `~/.devswarm/repos/<n>/<hash>/<slug>`; this
// matches that path segment, separator-normalized so a Windows-shaped path is
// recognized identically.
const DEVSWARM_REPOS_ROOT_RE = /[\\/]\.devswarm[\\/]repos[\\/]/;

function cachePath(home) {
  return path.join(devswarmRoot(home), CACHE_BASENAME);
}
// Back-compat alias: the exported name several call sites already use.
const archivedCachePath = cachePath;

// isUnderDevswarmReposRoot(p) -> bool. Conjunct 2. A non-string / empty path is
// NOT under the root (fail-open: never app-archived).
function isUnderDevswarmReposRoot(p) {
  if (typeof p !== 'string' || !p) return false;
  return DEVSWARM_REPOS_ROOT_RE.test(p);
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

function positiveIntEnv(env, name) {
  const e = env || process.env;
  const raw = e[name];
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = parseInt(raw.trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// resolveArchivedCacheMaxAgeMs(env) -> ms. How old the cache may be and still
// be believed. Default 2x the sweep interval; overridable with
// ANTIHALL_DEVSWARM_ARCHIVED_CACHE_MAX_AGE_MS (positive integer ms).
function resolveArchivedCacheMaxAgeMs(env) {
  const e = env || process.env;
  return positiveIntEnv(e, 'ANTIHALL_DEVSWARM_ARCHIVED_CACHE_MAX_AGE_MS') || (2 * sweepIntervalMs(e));
}

// resolveArchivedGraceMs(env) -> ms. Conjunct 4's bound. Overridable with
// ANTIHALL_DEVSWARM_ARCHIVED_GRACE_MS (positive integer ms).
function resolveArchivedGraceMs(env) {
  return positiveIntEnv(env, 'ANTIHALL_DEVSWARM_ARCHIVED_GRACE_MS') || DEFAULT_ARCHIVED_GRACE_MS;
}

// normalizeRecords(v) -> [{id, worktreePath}]. Only entries carrying a non-empty
// string id survive; worktreePath is optional (null when absent) because an
// id-only match is still conclusive evidence of liveness.
function normalizeRecords(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const id = r.id != null ? String(r.id) : '';
    if (!id) continue;
    const wt = typeof r.worktreePath === 'string' && r.worktreePath ? r.worktreePath : null;
    out.push({ id, worktreePath: wt });
  }
  return out;
}

// readActiveCache({home, env, now, fsi, maxAgeMs}) ->
//   { present, fresh, fetchedAt, ageMs, maxAgeMs, recordCount, byRepoKey }
// `byRepoKey` is ALWAYS an object and is EMPTY unless the file is present,
// well-formed AND fresh — so a caller that ignores `fresh` still cannot be
// misled by a stale snapshot. Never throws.
function readActiveCache(opts) {
  const o = opts || {};
  const F = o.fsi || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const maxAgeMs = Number.isFinite(o.maxAgeMs) ? o.maxAgeMs : resolveArchivedCacheMaxAgeMs(o.env);
  const empty = {
    present: false, fresh: false, fetchedAt: null, ageMs: null, maxAgeMs,
    recordCount: 0, byRepoKey: {},
  };
  let parsed;
  try {
    parsed = JSON.parse(String(F.readFileSync(cachePath(o.home), 'utf8')));
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
  let recordCount = 0;
  if (fresh && raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of Object.keys(raw)) {
      const recs = normalizeRecords(raw[k]);
      if (recs === null) continue; // malformed entry: ignored, never guessed at
      // An entry that normalizes to ZERO usable records is NOT evidence that
      // every row in that project is archived — it is evidence of a malformed
      // or empty write, which the writer already refuses to produce. Drop it so
      // absence-against-nothing can never suppress a whole project.
      if (!recs.length) continue;
      byRepoKey[k] = recs;
      recordCount += recs.length;
    }
  }
  return { present: true, fresh, fetchedAt, ageMs, maxAgeMs, recordCount, byRepoKey };
}
// Back-compat alias for the reader name the hooks already import.
const readArchivedCache = readActiveCache;

// rowFirstSeenMs(home, id, fsi) -> ms | null. Conjunct 4's age source: the mtime
// of the row's own registry descriptor (`<devswarmRoot>/workspaces/<id>.json`),
// the only durable timestamp the registry carries for "when anti-hall first
// learned about this row". A re-registration rewrites the file and RESETS this
// age, which pushes the row back below the grace and therefore toward NOT
// suppressing — the fail-open direction. null (unknown) never suppresses.
function rowFirstSeenMs(home, id, fsi) {
  const F = fsi || fs;
  if (id == null || String(id) === '') return null;
  try {
    const st = F.statSync(path.join(devswarmRoot(home), 'workspaces', String(id) + '.json'));
    return Number.isFinite(st.mtimeMs) ? st.mtimeMs : null;
  } catch (_) { return null; }
}

// activeRecordsFor({home, repoKey, env, now, fsi, cache}) -> [{id, worktreePath}].
// `cache` (optional) lets a hot-path caller read the file ONCE per invocation
// and classify N rows against it.
function activeRecordsFor(opts) {
  const o = opts || {};
  if (!o.repoKey) return []; // no project -> no snapshot -> no suppression
  const cache = o.cache || readActiveCache(o);
  const recs = cache && cache.byRepoKey ? cache.byRepoKey[String(o.repoKey)] : null;
  return Array.isArray(recs) ? recs : [];
}

// isAppArchived({home, repoKey, id, worktreePath, env, now, fsi, cache, firstSeenMs})
//   -> bool. The four-conjunct absence rule at the top of this file. Every
// unknown answers NO. Never throws.
function isAppArchived(opts) {
  const o = opts || {};
  try {
    if (o.id == null || String(o.id) === '') return false;
    // Conjunct 2 FIRST — it is pure and needs no file read, and it is the one
    // that protects the Primary's own row.
    if (!isUnderDevswarmReposRoot(o.worktreePath)) return false;
    const cache = o.cache || readActiveCache(o);
    // Conjunct 1. readActiveCache already empties byRepoKey when stale, but the
    // check is explicit here so the rule reads as written.
    if (!cache || !cache.fresh) return false;
    const recs = activeRecordsFor(Object.assign({}, o, { cache }));
    if (!recs.length) return false; // no snapshot for this project -> no evidence
    // Conjunct 3.
    const id = String(o.id);
    const wt = String(o.worktreePath);
    for (const r of recs) {
      if (r.id === id) return false;
      if (r.worktreePath && r.worktreePath === wt) return false;
    }
    // Conjunct 4.
    const firstSeen = Number.isFinite(o.firstSeenMs)
      ? o.firstSeenMs
      : rowFirstSeenMs(o.home, id, o.fsi);
    if (!Number.isFinite(firstSeen)) return false; // unknown age -> never suppress
    const graceMs = Number.isFinite(o.graceMs) ? o.graceMs : resolveArchivedGraceMs(o.env);
    if ((cache.fetchedAt - firstSeen) < graceMs) return false;
    return true;
  } catch (_) { return false; }
}

// writeActiveCache({home, byRepoKey, now, fsi}) -> path | null (supervisor
// side). Atomic tmp+rename, same shape as every other small state file here.
//
// REFUSES AN EMPTY WRITE. Under absence semantics an empty snapshot is not a
// harmless no-op the way an empty archived-id list was — it would assert "this
// project has no live workspaces", i.e. that EVERY row is archived. So a
// repoKey with zero usable records is dropped, and a call left with nothing to
// write returns null having written nothing. The supervisor gates on the same
// fact before calling; this is the second, independent guard.
//
// WHOLE-FILE REPLACE, deliberately: only the repoKeys probed in THIS sweep are
// written. Merging an earlier tick's entries forward would let one global
// `fetchedAt` vouch for a snapshot that is actually much older (the sweep caps
// projects per tick, so some are deferred) — and under absence semantics a
// stale-but-vouched-for snapshot MISSES workspaces created since, which is
// over-suppression, the one failure direction this feature must not have.
function writeActiveCache(opts) {
  const o = opts || {};
  const F = o.fsi || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const file = cachePath(o.home);
  const byRepoKey = {};
  let recordCount = 0;
  const src = o.byRepoKey || {};
  for (const k of Object.keys(src)) {
    const recs = normalizeRecords(src[k]);
    if (!recs || !recs.length) continue;
    byRepoKey[k] = recs;
    recordCount += recs.length;
  }
  if (!recordCount) return null;
  try {
    F.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    F.writeFileSync(tmp, JSON.stringify({ fetchedAt: now, byRepoKey, recordCount }) + '\n');
    F.renameSync(tmp, file);
    return file;
  } catch (_) { return null; }
}

module.exports = {
  CACHE_BASENAME, FALLBACK_SWEEP_INTERVAL_MS, DEFAULT_ARCHIVED_GRACE_MS,
  DEVSWARM_REPOS_ROOT_RE, isUnderDevswarmReposRoot,
  cachePath, archivedCachePath,
  resolveArchivedCacheMaxAgeMs, resolveArchivedGraceMs,
  readActiveCache, readArchivedCache,
  rowFirstSeenMs, activeRecordsFor, isAppArchived, writeActiveCache,
};
