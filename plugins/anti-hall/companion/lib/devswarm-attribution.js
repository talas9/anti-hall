'use strict';
// anti-hall :: devswarm-attribution — deterministic (liveness-free) row
// picker for SENDER ATTRIBUTION only (devswarm-store.js's
// resolveSenderRegistryId, leg C). NOT for liveness-based routing/selection —
// resolveMeshTarget, pickSurvivor, and the orphan policy in scripts/
// devswarm.js keep using devswarm-liveness-select.js's pickFreshestLive
// unchanged; do not repoint them at this module.
//
// DEFECT (D8, v0.94.0): resolveSenderRegistryId's old leg C delegated to
// pickFreshestLive, whose ranking reads PRESENT-TENSE mutable signals
// (updatedAt, cursor drain, heartbeat freshness). When a sender's
// worktree-derived meshId maps to N>1 sibling registry rows (e.g. a
// branch-slug row and a sub-agent row on the same worktree, distinct real
// sessionIds), those signals flip across successive computeSummary calls as
// the two rows heartbeat/drain independently — so pendingQuestions[].from
// flips between passes for the SAME stored message. Attribution must be a
// pure function of the row SET (field-shape + id), never of "which row is
// live right now".
//
// pickAttributionRow(rows) -> row | null. Ranks on:
//   C1 — a row whose sessionId is a real (non-empty, non-`unclaimed:`)
//        string beats one that is not (isLiveSessionId's field-shape check,
//        reused from devswarm-liveness-select.js — no fs/liveness read).
//   C2 — a row whose id starts with `basename(worktreePath) + '-'` (the
//        branch-slug row) beats a sub-agent row on the same worktree.
//        Trailing path separators ('/' or '\') on worktreePath are stripped
//        before basename() so a value like '/wt/x/' ranks identically to
//        '/wt/x'. This is a pure string-prefix rule on the row id with NO
//        row-provenance check (it does not verify the row actually
//        originated from that worktree) — acceptable because every row in
//        the candidate pool is already a valid `send --to` target (the
//        caller only ever passes rows resolved for the same meshId), and
//        attribution clearing here is family-wide, not row-specific.
//   D  — ascending lexical id, the final, always-available tiebreak (same
//        convention as pickDeterministicFallback in
//        devswarm-liveness-select.js).
// Depends only on row VALUES (id, sessionId, worktreePath) — shuffling the
// input array can never change the winner. Fail-open: a malformed row is
// skipped, never thrown on; an empty/absent list returns null.

const path = require('path');
const { isLiveSessionId } = require('./devswarm-liveness-select.js');

function hasRealSessionId(row) {
  return !!row && isLiveSessionId(row.sessionId);
}

function branchSlugMatch(row) {
  if (!row || !row.worktreePath || row.id == null) return false;
  let base = null;
  try {
    const trimmed = String(row.worktreePath).replace(/[/\\]+$/, '');
    base = path.basename(trimmed);
  } catch (_) { base = null; }
  if (!base) return false;
  return String(row.id).startsWith(base + '-');
}

function scoreOf(row) {
  return [hasRealSessionId(row) ? 1 : 0, branchSlugMatch(row) ? 1 : 0];
}

function compareScore(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

function pickAttributionRow(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let best = null;
  let bestScore = null;
  for (const row of list) {
    if (!row || row.id == null) continue;
    const score = scoreOf(row);
    if (best === null) { best = row; bestScore = score; continue; }
    const cmp = compareScore(score, bestScore);
    if (cmp > 0) { best = row; bestScore = score; continue; }
    if (cmp === 0 && String(row.id) < String(best.id)) { best = row; bestScore = score; }
  }
  return best;
}

module.exports = { pickAttributionRow };
