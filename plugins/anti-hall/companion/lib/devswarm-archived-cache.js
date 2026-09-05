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
// alog — leaf module (fs/os/path only), safe at top level, no cycle risk (same
// posture as companion/devswarm-supervisor.js's own top-level alog require).
// Used only for the R17 item 2 partial-list-guard log line below.
const alog = require('./anti-hall-log.js');

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
//
// D11-B: normalize `p` (normalizeWorktreePath — path.resolve then
// fs.realpathSync, falling back to the resolved string) BEFORE the regex
// test, the SAME normalization conjunct 3's comparison already applies to
// every worktreePath on both sides (R17 item 1). Un-normalized, a trailing
// separator or a `.`/`..` segment on the RAW caller-supplied path can survive
// into the regex test itself, and this function is the first gate every row
// passes through — normalizing here means a caller never has to pre-normalize
// its own input just to be recognized as under the root.
function isUnderDevswarmReposRoot(p) {
  if (typeof p !== 'string' || !p) return false;
  const normalized = normalizeWorktreePath(p);
  return DEVSWARM_REPOS_ROOT_RE.test(typeof normalized === 'string' && normalized ? normalized : p);
}

// normalizeWorktreePath(p, fsi) -> string | null. R17 item 1 (Critic,
// reproduced): conjunct 3's match used to compare `worktreePath` by EXACT
// STRING. hivecontrol's own record for a workspace can carry a path that is
// LOGICALLY the same directory but not byte-identical to the anti-hall row's
// worktreePath — a trailing separator, or (macOS-specific: `/tmp` is itself a
// symlink to `/private/tmp`) a `/private`-prefixed vs unprefixed form of the
// same real path. Either divergence made a genuinely LIVE workspace fail
// every comparison in isAppArchived's conjunct 3, so absence-by-omission
// misclassified it as app-archived.
//
// Fix: normalize BOTH sides the SAME way before comparing — `path.resolve`
// (handles trailing separators/`.`/`..` segments) then
// `fs.realpathSync` to collapse a symlinked prefix (macOS `/tmp` ->
// `/private/tmp`) to its canonical form, falling back to the resolved string
// when the path does not exist on THIS machine (a row for a workspace whose
// worktree was since deleted must still compare, not silently stop matching —
// fail-open toward NOT losing a real match, never toward inventing one: this
// can only make two paths that were already logically the same START
// comparing equal, never make two DIFFERENT real paths collide, since
// realpath is injective over existing paths). Applied identically at WRITE
// time (writeActiveCache, so the cache stores normalized paths) and at READ
// time (every row's worktreePath, right before the conjunct-3 comparison) —
// symmetric normalization is what makes the comparison meaningful; normalizing
// only one side would just move the divergence rather than close it.
function normalizeWorktreePath(p, fsi) {
  if (typeof p !== 'string' || !p) return null;
  const F = fsi || fs;
  let resolved;
  try { resolved = path.resolve(p); } catch (_) { return p; }
  try { return F.realpathSync(resolved); } catch (_) { return resolved; }
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

// DEFAULT_ACTIVE_FLOOR_PCT — R17 item 2's partial-list guard (writeActiveCache
// below). 50: a hivecontrol answer for a repoKey that comes back at less than
// half its own previous snapshot's record count is treated as suspect (a
// truncated/partial list), not as "half the workspaces got archived at once".
const DEFAULT_ACTIVE_FLOOR_PCT = 50;

// resolveActiveFloorPct(env) -> 0-N (percent). Overridable with
// ANTIHALL_DEVSWARM_ACTIVE_FLOOR_PCT (non-negative integer; 0 disables the
// floor entirely, i.e. always trust the new snapshot).
function resolveActiveFloorPct(env) {
  const e = env || process.env;
  const raw = e.ANTIHALL_DEVSWARM_ACTIVE_FLOOR_PCT;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = parseInt(raw.trim(), 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_ACTIVE_FLOOR_PCT;
}

// readRawByRepoKeyForFloor(home, fsi) -> byRepoKey object read straight off
// disk, IGNORING freshness — this is a same-writer sanity comparison across
// consecutive sweeps (has this project's record count suddenly crashed?),
// never a suppression-eligibility check, so a STALE previous snapshot is
// still a valid basis for comparison here (unlike readActiveCache's `fresh`
// gate, which exists for a completely different reason — bounding how long
// an absence-inference may be trusted). Never throws; unreadable/malformed
// -> {} (no previous data -> the floor check above always accepts, the
// fail-open direction).
function readRawByRepoKeyForFloor(home, fsi) {
  const F = fsi || fs;
  try {
    const parsed = JSON.parse(String(F.readFileSync(cachePath(home), 'utf8')));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const raw = parsed.byRepoKey;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const k of Object.keys(raw)) {
      const recs = normalizeRecords(raw[k], F);
      if (recs && recs.length) out[k] = recs;
    }
    return out;
  } catch (_) { return {}; }
}

// normalizeRecords(v, fsi) -> [{id, worktreePath}]. Only entries carrying a
// non-empty string id survive; worktreePath is optional (null when absent)
// because an id-only match is still conclusive evidence of liveness.
// `worktreePath`, when present, is run through normalizeWorktreePath (R17
// item 1) so every record this module ever stores or hands to a comparison
// is ALREADY in canonical form — the comparison in isAppArchived below only
// has to normalize the ROW's own path to match this same convention.
function normalizeRecords(v, fsi) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const id = r.id != null ? String(r.id) : '';
    if (!id) continue;
    const rawWt = typeof r.worktreePath === 'string' && r.worktreePath ? r.worktreePath : null;
    const wt = rawWt ? normalizeWorktreePath(rawWt, fsi) : null;
    // repositoryId (D11-B, cross-repo id/path collision guard): passed through
    // verbatim when the raw record carries one (hivecontrol's `workspace list
    // all` DOES emit this field — see the module header — it is simply not
    // yet threaded through every producer of this shape). null when absent, so
    // isAppArchived's conjunct-3 guard can tell "no repositoryId available"
    // (fail toward the existing id/worktreePath-only match) apart from "these
    // two repositoryIds genuinely differ".
    const repositoryId = typeof r.repositoryId === 'string' && r.repositoryId ? r.repositoryId : null;
    out.push({ id, worktreePath: wt, repositoryId });
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
      const recs = normalizeRecords(raw[k], F);
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

// isAppArchived({home, repoKey, id, worktreePath, env, now, fsi, cache, firstSeenMs, repositoryId})
//   -> bool. The four-conjunct absence rule at the top of this file. Every
// unknown answers NO. Never throws. `repositoryId` (D11-B, optional) is this
// row's own ground-truth repo identity (e.g. devswarm.js's
// fetchTrustedRepositoryId); when supplied AND a candidate cached record also
// carries one, the two must agree before an id/worktreePath match counts as
// evidence of liveness — see conjunct 3 below for why (a bucket keyed by
// repoKey can still hold records spanning every repo hivecontrol knows about).
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
    // Conjunct 3. `wt` is normalized the SAME way normalizeRecords already
    // normalized every cached record's worktreePath (R17 item 1) — a
    // trailing-separator or macOS `/private`-prefix divergence between this
    // row's raw path and hivecontrol's own reported path must never itself
    // cause a live workspace to fail this match.
    const id = String(o.id);
    const wt = normalizeWorktreePath(o.worktreePath, o.fsi);
    // rowRepositoryId (D11-B): this row's OWN repositoryId, when the caller
    // has one to offer. `byRepoKey` is keyed by repoKey, NOT repositoryId (see
    // module header) precisely because the underlying `hivecontrol workspace
    // list all` answer feeding a bucket is GLOBAL/unscoped — it takes no repo
    // filter, so every repo's live records can end up in ONE bucket. A bare id
    // (or, in a moved/rehomed setup, even a worktreePath) can therefore
    // collide across two UNRELATED repos' rows.
    const rowRepositoryId = (typeof o.repositoryId === 'string' && o.repositoryId) ? o.repositoryId : null;
    for (const r of recs) {
      const idMatch = r.id === id;
      const wtMatch = !!(wt && r.worktreePath && r.worktreePath === wt);
      if (!idMatch && !wtMatch) continue;
      // REPOSITORY-ID GUARD: when BOTH sides carry a repositoryId, it must
      // ALSO agree before this counts as evidence the row is live — a
      // same-id/same-path record belonging to a DIFFERENT repositoryId proves
      // nothing about THIS row and must not short-circuit the loop. Fail
      // toward NEVER-suppress when either side lacks a repositoryId (older
      // hivecontrol, an un-migrated cache entry, or a caller that has not
      // threaded one through yet): the id/worktreePath match alone still
      // counts exactly as before — this guard can only turn an existing match
      // into "insufficient evidence", never invent a NEW suppression.
      if (r.repositoryId && rowRepositoryId && r.repositoryId !== rowRepositoryId) continue;
      return false;
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
  // PARTIAL-LIST GUARD (R17 item 2, P2 Auditor): admission into
  // reconcileSweepIfDue's activeByRepoKey today is `records.length >= 1` —
  // ANY non-empty hivecontrol answer is trusted whole. But `workspace list
  // all` is a single unauthenticated read of another process's live state;
  // a partial/truncated answer (paging cut short, a slow/interrupted list
  // call) can come back non-empty yet missing most of what a moment ago was
  // there — and under absence semantics EVERY omitted row silently archives.
  // Read the PREVIOUS on-disk snapshot's per-repoKey record count (ignoring
  // its own freshness — this is a same-writer sanity check across sweeps,
  // not a suppression-eligibility check) and refuse to overwrite a repoKey
  // whose new count falls below `floorPct`% of its own previous count,
  // keeping the previous entry for that key instead. `floorPct` is
  // ANTIHALL_DEVSWARM_ACTIVE_FLOOR_PCT (default 50; 0 disables the floor
  // entirely). A repoKey with NO previous entry (first snapshot ever, or a
  // project newly added to this sweep) has nothing to fall below, so it is
  // always accepted unconditionally.
  const floorPct = resolveActiveFloorPct(o.env);
  const prevByRepoKey = readRawByRepoKeyForFloor(o.home, F);
  const byRepoKey = {};
  let recordCount = 0;
  const src = o.byRepoKey || {};
  for (const k of Object.keys(src)) {
    let recs = normalizeRecords(src[k], F);
    if (!recs || !recs.length) continue;
    const prevRecs = prevByRepoKey[k];
    if (floorPct > 0 && prevRecs && prevRecs.length) {
      const floor = (prevRecs.length * floorPct) / 100;
      if (recs.length < floor) {
        try {
          alog.logEvent('devswarm-archived-cache', 'partial-list-guard', 'warn',
            'hivecontrol workspace list returned ' + recs.length + ' record(s) for ' + k
            + ', below the ' + floorPct + '% floor of the previous snapshot\'s ' + prevRecs.length
            + ' — refusing this write, keeping the previous snapshot for this project',
            { repoKey: k, newCount: recs.length, prevCount: prevRecs.length, floorPct });
        } catch (_) {}
        recs = prevRecs; // keep the previous entry for THIS key, unchanged
      }
    }
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
  DEFAULT_ACTIVE_FLOOR_PCT,
  DEVSWARM_REPOS_ROOT_RE, isUnderDevswarmReposRoot, normalizeWorktreePath,
  cachePath, archivedCachePath,
  resolveArchivedCacheMaxAgeMs, resolveArchivedGraceMs, resolveActiveFloorPct,
  readActiveCache, readArchivedCache,
  rowFirstSeenMs, activeRecordsFor, isAppArchived, writeActiveCache,
  // exported for direct unit coverage of the partial-list guard's read side.
  readRawByRepoKeyForFloor,
};
