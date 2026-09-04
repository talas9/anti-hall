'use strict';
// anti-hall :: devswarm row-select — the ONE freshest-live-row selection
// primitive, shared by scripts/devswarm.js's resolveMeshTarget (send
// addressing) and pickSurvivor (fold-duplicate survivor pick) AND companion/
// lib/devswarm-store.js's resolveSenderRegistryId (question-sender
// normalization). Those three used to be three independent copies of the
// same tie-break loop — a mismatch between them let a `send --to meshId`
// land on a DIFFERENT row than the one heartbeat-ownership/question-
// correlation agreed was "the" live row for a worktree, because each copy
// only agreed on "greatest registry updatedAt among LIVE rows, cursor-value
// tiebreak" and NOT on what counts as a live CANDIDATE in the first place.
//
// Lives in its OWN module (not required by either scripts/devswarm.js or
// companion/lib/devswarm-store.js from one another) specifically to avoid a
// require cycle: scripts/devswarm.js already requires devswarm-store.js
// (`const store = require('../companion/lib/devswarm-store.js')`), so a
// devswarm-store.js -> scripts/devswarm.js require would be circular. This
// module has ZERO requires of its own (pure functions over caller-supplied
// data + caller-supplied callbacks), so both files can require it freely.
//
// OBSERVED-LIVENESS FIX (field evidence: `send --to meshId` landed on a dead
// SLUG row whose registry `updatedAt` was, by chance, more recent than the
// UUID row a live session was actually draining — the dead row was never
// "live" in the isLiveSessionId sense, so it never should have been a
// candidate for "freshest live" at all; the OLD three copies had no
// staleness dimension, only a liveness (non-empty sessionId) dimension, so a
// dead-but-recently-touched row's updatedAt could still outrank a genuinely
// draining row that simply hadn't re-registered as recently). This module
// adds a SECOND dimension — registry `updatedAt` FRESHNESS — on top of the
// caller-supplied liveness predicate:
//   - among rows that are BOTH live (isLive(sessionId)) AND fresh (updatedAt
//     within `staleMs` of `now`), pick the freshest (byte-identical tie-break
//     to the pre-existing algorithm: greatest updatedAt, then greater
//     cursorValue(id) on an exact tie);
//   - if NO row is both live and fresh, fall BACK to the pre-existing
//     algorithm over every LIVE row regardless of freshness — a mesh must
//     never be stranded with zero targets just because every live candidate
//     happens to be stale (e.g. a genuinely wedged-but-still-running child);
//   - if NO row is live at all, fall back to the first matching row (the
//     phantom, pre-self-register) — unchanged from every prior copy.
// Fail-open on the freshness check itself: an unparseable/non-finite
// `updatedAt` is treated as FRESH (never lets a parse hiccup silently demote
// a genuinely live row out of the preferred bucket).

// DEFAULT_ROW_STALE_MS — deliberately generous (24h): this is a "is this row
// still worth PREFERRING" signal, not a liveness/health check (that is what
// ingest-health.js's HEARTBEAT_STALE_MS, a much tighter 3-minute window, is
// for — the two are unrelated conventions for unrelated questions and are
// not meant to share a value). A row that hasn't updated in under a day is
// still very plausibly the live session's own partition; the window exists
// to stop a row that will NEVER update again (a genuinely dead/leftover
// registration) from shadowing a fresher live row forever, not to punish
// ordinary multi-hour idle gaps.
const DEFAULT_ROW_STALE_MS = 24 * 60 * 60 * 1000;

// resolveRowStaleMs(env) -> positive finite ms. Absent/non-numeric/non-
// positive env value falls back to the default (fail-open: a typo never
// tightens or disables the window unexpectedly).
function resolveRowStaleMs(env) {
  const raw = (env || {}).ANTIHALL_DEVSWARM_ROW_STALE_MS;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_ROW_STALE_MS;
}

// isFreshRow(row, now, staleMs) -> bool. Fail-open: a non-finite/absent
// updatedAt is treated as fresh (never demotes a row it cannot evaluate).
function isFreshRow(row, now, staleMs) {
  const updatedAt = row && row.updatedAt;
  if (!Number.isFinite(updatedAt)) return true;
  return (now - updatedAt) <= staleMs;
}

// betterOf(best, candidate, cursorValue) -> the winner of the SAME tie-break
// every prior copy used: strictly greater `updatedAt` wins outright; an exact
// tie (including both absent, both coerced to -1) is broken by a strictly
// greater `cursorValue(id)`; otherwise `best` is kept (first-seen-wins,
// matching the pre-existing id-ASC iteration order every caller already
// provides via listRegistry()/group.rows).
function betterOf(best, candidate, cursorValue) {
  if (best === null) return candidate;
  const a = Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : -1;
  const b = Number.isFinite(best.updatedAt) ? best.updatedAt : -1;
  if (a > b) return candidate;
  if (a === b && cursorValue(candidate.id) > cursorValue(best.id)) return candidate;
  return best;
}

// pickFreshestLiveRow(rows, opts) -> row | null. `rows` is the CALLER's own
// already-filtered candidate list (e.g. every registry row whose derived
// meshId matches, or a canonical group's own rows) — this function does no
// filtering of its own beyond liveness/freshness. `opts`:
//   isLive(sessionId) -> bool          (default: always true)
//   cursorValue(id) -> finite number   (default: always -1, i.e. no tiebreak)
//   now                                (default: Date.now())
//   staleMs                            (default: DEFAULT_ROW_STALE_MS)
// Never throws: a malformed row is skipped defensively where it would
// otherwise be dereferenced.
function pickFreshestLiveRow(rows, opts) {
  const o = opts || {};
  const isLive = typeof o.isLive === 'function' ? o.isLive : () => true;
  const cursorValue = typeof o.cursorValue === 'function' ? o.cursorValue : () => -1;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const staleMs = Number.isFinite(o.staleMs) && o.staleMs > 0 ? o.staleMs : DEFAULT_ROW_STALE_MS;

  let firstMatch = null;
  let bestFreshLive = null;
  let bestAnyLive = null;

  for (const d of (rows || [])) {
    if (!d) continue;
    if (firstMatch === null) firstMatch = d;
    let live = false;
    try { live = isLive(d.sessionId); } catch (_) { live = false; }
    if (!live) continue;
    bestAnyLive = betterOf(bestAnyLive, d, cursorValue);
    if (isFreshRow(d, now, staleMs)) bestFreshLive = betterOf(bestFreshLive, d, cursorValue);
  }
  return bestFreshLive || bestAnyLive || firstMatch;
}

module.exports = {
  DEFAULT_ROW_STALE_MS,
  resolveRowStaleMs,
  isFreshRow,
  pickFreshestLiveRow,
};
