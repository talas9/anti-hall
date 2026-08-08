'use strict';
// anti-hall :: devswarm-liveness-select — the ONE freshest-LIVE registry-row
// selection primitive shared by scripts/devswarm.js (resolveMeshTarget,
// pickSurvivor) and companion/lib/devswarm-store.js (resolveSenderRegistryId).
// Extracted so all three call sites can never drift out of sync on what "the
// live row a session actually drains" means (SkyCrew field defect, 0.73.x:
// three independent copies of the same freshest-updatedAt loop disagreed on
// which duplicate registry row won a `send --to meshId`).
//
// GROUND-TRUTH CORRECTION (live SkyCrew store inspected 2026-08-07): a DEAD
// registry row's updatedAt can be refreshed indefinitely by an unidentified
// CLI-heartbeat caller (cmdHeartbeat invoked with no --session — heartbeat
// schema source:'cli-heartbeat', sessionId:null). A recency window alone can
// NEVER exclude such a row. This module ranks LIVE candidates (isLiveSessionId)
// on THREE evidence signals, in priority order, BEFORE falling back to
// updatedAt recency as the final tiebreak:
//   (a) SESSION-REFERENCE INTEGRITY — a row whose sessionId equals ANOTHER
//       row's id in the SAME candidate group is an alias/stale cross-reference
//       (observed in the field: the dead row's session_id held the live
//       sibling's registry id), ranked BELOW a row with a self-consistent
//       sessionId.
//   (b) DRAIN ACTIVITY — a row with a cursor row present (and/or advanced)
//       outranks a row with NO cursor row AND unread backlog (observed: the
//       live row had a cursors-table row draining; the dead row had neither a
//       cursor row nor any consumption despite 2 unread).
//   (c) SESSION-AUTHORED HEARTBEAT — a heartbeat file whose OWN schema carries
//       a real sessionId earns extra liveness credit; a bare
//       source:'cli-heartbeat' with sessionId:null (any process can produce
//       this — it is exactly what kept the dead row's updatedAt fresh in the
//       field) earns no credit.
// updatedAt (then cursor value) remains the FINAL tiebreak when all three are
// equal. Every signal is FAIL-OPEN: an unreadable/missing table or file
// degrades that ONE signal to neutral (no credit, no penalty) — never
// disqualifies a row, never throws. If every LIVE candidate ranks equally
// poorly the plain freshest-updatedAt row still wins (never strand a mesh).

const path = require('path');
const fsDefault = require('fs');

let devswarmRootFn = null;
try { ({ devswarmRoot: devswarmRootFn } = require('./liveness.js')); } catch (_) { devswarmRootFn = null; }

const SYNTHETIC_SESSION_PREFIX = 'unclaimed:';

// isLiveSessionId(sessionId) -> bool. The single source of truth for "a real
// session is running this workspace" (non-null, non-empty, not the synthetic
// auto-ensure marker). scripts/devswarm.js and devswarm-store.js each still
// keep their own byte-for-byte historical copy of this predicate (out of
// scope to collapse those — this module is the NEW shared selection logic,
// not a forced migration of every existing call site); this export exists so
// neither file needs to grow a THIRD copy for anything that only needs the
// predicate.
function isLiveSessionId(sessionId) {
  if (sessionId == null) return false;
  const s = String(sessionId);
  if (s === '') return false;
  return !s.startsWith(SYNTHETIC_SESSION_PREFIX);
}

function heartbeatPath(home, id) {
  const root = devswarmRootFn ? devswarmRootFn(home) : path.join(String(home || ''), '.anti-hall', 'devswarm');
  return path.join(root, 'heartbeats', String(id) + '.json');
}

// sessionAuthoredHeartbeat(home, id, io) -> true | false | null
//   true  = a heartbeat file exists for `id` and carries a real (non-null,
//           non-empty) sessionId — signal (c) credit.
//   false = a heartbeat file exists but its sessionId is null/empty (e.g.
//           source:'cli-heartbeat' with no --session) — no credit.
//   null  = missing/unreadable/unparseable heartbeat — UNKNOWN, neutral
//           (never disqualifying).
function sessionAuthoredHeartbeat(home, id, io) {
  const F = (io && io.fs) || fsDefault;
  try {
    const raw = F.readFileSync(heartbeatPath(home, id), 'utf8');
    const beat = JSON.parse(raw);
    if (!beat || typeof beat !== 'object') return null;
    const sid = beat.sessionId;
    return sid != null && String(sid) !== '';
  } catch (_) {
    return null;
  }
}

// cursorEvidence(storeHandle, id) -> { exists, value, unread }. Any throw from
// the store degrades the SPECIFIC field to its unknown sentinel (null/-1) —
// never disqualifying on its own; see pickFreshestLive's bOk gate, which only
// penalizes when BOTH `exists === false` and `unread === true` are POSITIVELY
// confirmed (an unknown value on either side is neutral).
function cursorEvidence(storeHandle, id) {
  let exists = null;
  let value = -1;
  let unread = null;
  try {
    const v = storeHandle.cursorValue(id);
    value = Number.isFinite(v) ? v : -1;
  } catch (_) { value = -1; }
  try {
    if (typeof storeHandle.hasCursorRow === 'function') exists = !!storeHandle.hasCursorRow(id);
  } catch (_) { exists = null; }
  try {
    if (typeof storeHandle.messageCount === 'function') {
      const total = storeHandle.messageCount(id);
      if (Number.isFinite(total)) unread = total > (value > 0 ? value : 0);
    }
  } catch (_) { unread = null; }
  return { exists, value, unread };
}

function compareScore(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

// pickFreshestLive(candidates, opts) -> row | null
//   candidates: registry rows already scoped to ONE identity group (every row
//     that resolves to the same meshId / worktree) — this function does NO
//     matching of its own, only ranks what it is given (byte-identical
//     matching contract to the three call sites' pre-existing loops).
//   opts.storeHandle: must expose cursorValue(id); hasCursorRow(id) and
//     messageCount(id) are used opportunistically when present (fail-open —
//     their absence just neutralizes signal (b), never breaks selection).
//   opts.home: enables the heartbeat-credit signal (c); omit to skip it
//     (neutral for every row — never throws, never required).
//   opts.io: { fs } — injectable for tests.
// Returns the row whose (aOk, bOk, cCredit, updatedAt, cursorValue) tuple
// sorts highest, compared left-to-right (priority order per the header
// above); ties keep the first LIVE row encountered (stable). Falls back to
// the first candidate overall when none are live (pre-self-register phantom-
// only case) — a strict refinement of "prefer live", never worse.
function pickFreshestLive(candidates, opts) {
  const o = opts || {};
  const storeHandle = o.storeHandle || null;
  const home = o.home || null;
  const io = o.io || null;
  const list = candidates || [];

  const groupIds = new Set();
  for (const d of list) { if (d && d.id != null) groupIds.add(String(d.id)); }

  // (b) DRAIN ACTIVITY is COMPARATIVE, not an absolute veto: a row is only
  // penalized for "no cursor row" when ANOTHER live row in this SAME group has
  // GENUINE positive drain evidence (a cursor row present, or an advanced
  // cursor value). Without this, a freshly-registered live child whose first
  // message hasn't been read yet (no cursor row established, one unread —
  // completely normal right after registration) would be misjudged identically
  // to a truly dead/stranded duplicate that has sat un-drained for a long time,
  // which is a real regression this comparison closes (see
  // devswarm-archive-group.test.js's "builder-id keying survives" case: a
  // sibling with NOTHING to drain must never outrank a live child with its
  // first unread message just because the child's cursor hasn't advanced yet).
  let anyGenuineDrainEvidence = false;
  if (storeHandle) {
    for (const d of list) {
      if (!d || !isLiveSessionId(d.sessionId)) continue;
      const ce = cursorEvidence(storeHandle, d.id);
      if (ce.exists === true || ce.value > 0) { anyGenuineDrainEvidence = true; break; }
    }
  }

  let firstMatch = null;
  let best = null;
  let bestScore = null;

  for (const d of list) {
    if (!d) continue;
    if (firstMatch === null) firstMatch = d;
    if (!isLiveSessionId(d.sessionId)) continue;

    // (a) SESSION-REFERENCE INTEGRITY — alias iff sessionId equals ANOTHER
    // row's id in this same group (a row whose sessionId happens to equal its
    // OWN id is not an alias of anything).
    const sidStr = d.sessionId != null ? String(d.sessionId) : '';
    const isAlias = sidStr !== '' && sidStr !== String(d.id) && groupIds.has(sidStr);
    const aOk = !isAlias;

    // (b) DRAIN ACTIVITY — penalized ONLY when this row has NO cursor row AND
    // an unread backlog AND some OTHER row in the group has genuine positive
    // drain evidence (see anyGenuineDrainEvidence above); never penalized on
    // absolute absence alone.
    let bOk = true;
    if (storeHandle && anyGenuineDrainEvidence) {
      const ce = cursorEvidence(storeHandle, d.id);
      const cursorGood = ce.exists === true || ce.value > 0;
      const cursorBad = ce.exists === false && ce.value <= 0 && ce.unread === true;
      if (!cursorGood && cursorBad) bOk = false;
    }

    // (c) SESSION-AUTHORED HEARTBEAT credit.
    let cCredit = false;
    if (home) cCredit = sessionAuthoredHeartbeat(home, d.id, io) === true;

    const updatedAt = Number.isFinite(d.updatedAt) ? d.updatedAt : -1;
    let cursorTie = -1;
    if (storeHandle) {
      try { const v = storeHandle.cursorValue(d.id); cursorTie = Number.isFinite(v) ? v : -1; } catch (_) { cursorTie = -1; }
    }

    const score = [aOk ? 1 : 0, bOk ? 1 : 0, cCredit ? 1 : 0, updatedAt, cursorTie];

    if (best === null) { best = d; bestScore = score; continue; }
    if (compareScore(score, bestScore) > 0) { best = d; bestScore = score; }
  }
  return best || firstMatch;
}

module.exports = {
  SYNTHETIC_SESSION_PREFIX,
  isLiveSessionId,
  pickFreshestLive,
  heartbeatPath,
  sessionAuthoredHeartbeat,
  cursorEvidence,
};
