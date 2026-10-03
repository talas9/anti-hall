'use strict';
// anti-hall :: devswarm-archive-gate — THE ONE "may this id's registry row be
// (re)written for an active workspaces/<id>.json descriptor?" decision, shared
// by companion/devswarm-migrate.js's one-time store migration AND
// scripts/devswarm.js's healOrphanPartitions doctor repair (defect
// df54edf54804, item 4 parity fix — both are BULK re-registration paths that
// iterate descriptor files and call upsertRegistry; before this extraction
// only migrate consulted archived state at all, so doctor would re-adopt
// exactly the group siblings migrate had just correctly refused).
//
// ---- WHY THIS EXISTS (defect df54edf54804) ----
// migrateOne/migrateToStore used to call s.upsertRegistry(descriptor) for
// EVERY id under workspaces/ unconditionally, never consulting archived/<id>.json
// (companion/lib/devswarm-archived.js) or the registry tombstone cmdArchive
// appended (scripts/devswarm.js's cmdArchive: removeRegistry BEFORE the final
// unlink of the active descriptor, ~scripts/devswarm.js:10884-10930).
//
// removeRegistry is NOT a permanent marker: the sqlite backend hard-DELETEs
// the row (devswarm-store.js ~:706-708) and the JSONL backend appends an
// unconditional `remove` op where "latest op per id wins" at read time
// (devswarm-store.js ~:1322-1323) — a later upsertRegistry (sqlite ON
// CONFLICT DO UPDATE, ~:626-696; JSONL append 'upsert', ~:1274-1319) simply
// becomes the new latest write and REVIVES the row. Nothing about
// removeRegistry itself stops that.
//
// So archiving an id is durable ONLY as long as no active workspaces/<id>.json
// descriptor exists to be swept up by a bulk reader again. That descriptor
// CAN reappear after a clean archive completes: scripts/devswarm.js's
// cmdRegister already carries a resurrection guard (field defect a48db2e0ea08)
// for the `ensure` verb (requireNew:true — the auto-ensure `inbox pull` runs
// every turn), but the EXPLICIT `register`/`register-primary` verb
// (requireNew:false, e.g. cmdRegisterPrimary at scripts/devswarm.js:10307, or
// the bare `register` CLI verb) is DELIBERATELY left unguarded — "an operator
// (or a child) that explicitly re-registers an archived id still revives it"
// (scripts/devswarm.js's own comment on that branch). A still-running child's
// terminal calling that path after its Primary archived the row is exactly
// how a fresh workspaces/<id>.json can exist again, usually under a DIFFERENT
// sessionId than the archived marker's (matching the archived-marker-
// superseded shape 7e1ae67 already handles on the READ side via
// devswarm-archived.js's isArchivedWorkspace — but a bulk re-register bypassed
// that predicate entirely on the WRITE side).
//
// ---- WORKTREE-GROUP SIBLINGS (second trace, team-lead clarification) ----
// cmdArchive's retireArchivedWorktreeGroup tombstones the STORE REGISTRY row
// of every SIBLING id sharing the archived id's physical worktree, but never
// writes those siblings their own archived/<id>.json marker or touches their
// workspaces/<id>.json descriptor file. Neither backend's removeRegistry
// leaves anything queryable to distinguish "tombstoned sibling" from "never
// registered" (see above), so the ONE surviving signal for a sibling with no
// marker of its own is a worktree-path MATCH against some OTHER id's marker.
//
// ---- LIVENESS PREDICATE (critic fix, replaces a bare heartbeat check) ----
// A bare `hasFreshHeartbeat` reuse-proof reproduces the EXACT root cause
// liveness.js's own header (isSiblingPartitionLive, ~line 586) documents and
// fixed elsewhere: a Primary never writes a heartbeat at all, `register`
// writes none, and a child mid-long-turn's heartbeat goes stale well before
// the session does. Using it here would SKIP (lose) a genuinely live
// Primary/long-turn-child reuse — the loss direction, not the resurrection
// direction, but still wrong. `isSiblingPartitionLive` (liveness.js:637) is
// reused instead: a fresh heartbeat OR a real (non-`unclaimed:`) sessionId
// that is not positively dormant (isDormantRow) counts as live.
// isSiblingPartitionLive itself fails OPEN (toward "live") on an internal
// throw — a documented tradeoff for ITS callers (an ack loop, where a
// spurious skip is cheap and a spurious ack is not). This gate's OWN
// contract is the opposite (fail toward skip/never-resurrect), but every
// value passed into it below is a plain, already-validated string, so that
// internal catch branch is not expected to fire in practice; this asymmetry
// is documented here rather than silently inherited.
//
// ---- MTIME PROOF: DIRECT-MARKER ONLY, NOT GROUP-SIBLING (critic fix) ----
// archived/<id>.json is a HARDLINK of id's own pre-archive descriptor
// (fs.linkSync(activePath, archivedPath), scripts/devswarm.js:10797). A
// literal re-registration of the SAME id always goes through
// writeDescriptorAtomic (tmp write + fs.renameSync(tmp, p),
// scripts/devswarm.js's writeDescriptorAtomic) — POSIX rename REPLACES the
// destination inode, so workspaces/<id>.json gets a brand-new inode/mtime
// while archived/<id>.json (still pointing at the OLD, now-detached inode)
// keeps its frozen archive-time mtime. Comparing the two is therefore a
// legitimate "was this re-registered AFTER the archive" proof for the DIRECT
// same-id case. It is NOT meaningful for a worktree-group sibling: that
// sibling's descriptor file is never touched by the archive of a DIFFERENT
// id at all, so its mtime has no relationship to the unrelated marker's — a
// sibling untouched since long before the archive and a sibling genuinely
// reused minutes ago can each land on either side of that comparison. The
// group branch therefore uses ONLY the liveness proof above.
//
// Fail-open only in the "no marker at all, no worktree-group hit" direction
// (nothing to gate); every other uncertainty (corrupt marker, unreadable
// mtimes/heartbeat, an internal predicate throw) fails toward SKIP (do not
// resurrect). This module never writes anything — it only reads archived/,
// workspaces/, and heartbeats/.

const fs = require('fs');
const path = require('path');
const {
  devswarmRoot, isSafeId, heartbeatPathFor, DEFAULT_HEARTBEAT_FRESH_MS, isSiblingPartitionLive,
} = require('./liveness.js');

function archivedDescriptorPath(home, id) {
  return path.join(devswarmRoot(home), 'archived', String(id) + '.json');
}
function activeDescriptorPathFor(home, id) {
  return path.join(devswarmRoot(home), 'workspaces', String(id) + '.json');
}

// realWorktreePath(p, F) -> a realpath-resolved worktree string, degrading to
// the raw string when it no longer resolves (an archived worktree is
// routinely gone by the time this gate runs) — mirrors devswarm-archived.js's
// own samePath helper so this file's worktree comparisons agree with the
// read-side predicate's.
function realWorktreePath(p, F) {
  if (typeof p !== 'string' || !p) return null;
  try { return F.realpathSync(p); } catch (_) { return p; }
}

// buildArchivedWorktreeIndex(home, F) -> Map<realWorktreePath, [{id, marker}]>.
// Scans archived/ ONCE (not per-descriptor) and groups every readable marker
// by its resolved worktreePath. Fail-open to an empty Map on any read error
// (never blocks the caller).
function buildArchivedWorktreeIndex(home, F) {
  const idx = new Map();
  let names = [];
  try { names = F.readdirSync(path.join(devswarmRoot(home), 'archived')); } catch (_) { return idx; }
  for (const n of names) {
    if (!/\.json$/.test(n)) continue;
    const id = n.slice(0, -5);
    if (!isSafeId(id)) continue;
    let marker = null;
    try { marker = JSON.parse(F.readFileSync(path.join(devswarmRoot(home), 'archived', n), 'utf8')); } catch (_) { continue; }
    const wt = marker && typeof marker.worktreePath === 'string' && marker.worktreePath ? marker.worktreePath : null;
    if (!wt) continue;
    const real = realWorktreePath(wt, F);
    if (!real) continue;
    if (!idx.has(real)) idx.set(real, []);
    idx.get(real).push({ id, marker });
  }
  return idx;
}

// resolveArchiveGate(home, id, descriptor, F, opts) ->
//   { archived: bool, migrateAsLive: bool, reason: string|null }.
//   archived:false        -> no marker of its own and no worktree-group hit
//                             (or its own marker turned out to be a
//                             different-worktree id-reuse) — not our concern,
//                             the caller should proceed normally.
//   archived:true,  migrateAsLive:false -> do NOT (re)write the registry row
//                             for this id; keep it tombstoned/absent.
//   archived:true,  migrateAsLive:true  -> proceed normally (registry write
//                             included); the caller should log it. Only
//                             reached with POSITIVE reuse proof — see header.
// opts: { now, freshMs, worktreeIndex } — worktreeIndex is an optional
// pre-built buildArchivedWorktreeIndex() Map, so a caller iterating many ids
// in one run only scans archived/ once.
function resolveArchiveGate(home, id, descriptor, F, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const freshMs = Number.isFinite(o.freshMs) ? o.freshMs : DEFAULT_HEARTBEAT_FRESH_MS;
  const result = { archived: false, migrateAsLive: false, reason: null };
  if (!isSafeId(id)) return result;

  const descWt = descriptor && typeof descriptor.worktreePath === 'string' && descriptor.worktreePath ? descriptor.worktreePath : null;

  const markerPath = archivedDescriptorPath(home, id);
  let raw = null;
  let ownMarkerMissing = false;
  try { raw = F.readFileSync(markerPath, 'utf8'); }
  catch (_) { ownMarkerMissing = true; }

  let marker = null;
  if (!ownMarkerMissing) {
    try { marker = JSON.parse(raw); } catch (_) { marker = null; }
    if (!marker || typeof marker !== 'object') {
      // Corrupt/unreadable marker: a marker FILE exists (this id WAS archived at
      // some point) but its content can't prove anything either way. Fail toward
      // SKIP (never resurrect on ambiguity), never throw.
      return { archived: true, migrateAsLive: false, reason: 'archived-marker-unreadable' };
    }
  }

  if (marker) {
    const markerWt = typeof marker.worktreePath === 'string' && marker.worktreePath ? marker.worktreePath : null;
    if (markerWt && descWt) {
      let a = markerWt; let b = descWt;
      try { a = F.realpathSync(markerWt); } catch (_) { /* worktree may be gone */ }
      try { b = F.realpathSync(descWt); } catch (_) { /* not yet materialized */ }
      if (a !== b) marker = null; // different worktree -> a NEW workspace reusing this id, not this marker's row
    }
  }

  // WORKTREE-GROUP FALLBACK — see header. This id has no marker of its own
  // (or its own marker was just ruled out as a different-worktree reuse);
  // check whether its worktree was archived under a DIFFERENT id.
  let groupMarkerId = null;
  if (!marker && descWt) {
    const idx = (o.worktreeIndex instanceof Map) ? o.worktreeIndex : buildArchivedWorktreeIndex(home, F);
    const real = realWorktreePath(descWt, F);
    const hits = real ? idx.get(real) : null;
    if (hits && hits.length) {
      // Prefer a hit that isn't `id` itself (defensive; `id` would already
      // have been handled by the direct-marker path above) and is otherwise
      // the first recorded — there is no ordering signal among siblings.
      const hit = hits.find((h) => String(h.id) !== String(id)) || hits[0];
      groupMarkerId = hit.id;
      marker = hit.marker;
    }
  }
  if (!marker) return result; // no marker of its own AND no worktree-group hit -> not our concern

  const markerSid = marker.sessionId != null && String(marker.sessionId) !== '' ? String(marker.sessionId) : null;
  const descSid = descriptor && descriptor.sessionId != null && String(descriptor.sessionId) !== '' ? String(descriptor.sessionId) : null;

  // Sibling ids in an identity family are cross-linked by sessionId, not
  // equal by it (see devswarm.js's family-retire header: "one row's
  // sessionId IS the other row's id") — a group-matched sibling's sessionId
  // is therefore EXPECTED to differ from the archived marker's, and that
  // difference alone must NOT be read as reuse proof the way it is for a
  // direct same-id marker.
  if (groupMarkerId) {
    if (!markerSid || !descSid || markerSid === descSid) {
      return { archived: true, migrateAsLive: false, reason: 'archived-worktree-group-sibling' };
    }
  } else if (!markerSid || !descSid || markerSid === descSid) {
    // No discriminating identity on one side, or the identities MATCH: this is
    // the archived workspace's own (leftover/not-yet-swept) descriptor, not a
    // reuse. Never resurrect.
    return { archived: true, migrateAsLive: false, reason: 'archived-marker-match' };
  }

  // Candidate true reuse. Require POSITIVE proof of CURRENT liveness before
  // ever proceeding — see header for why isSiblingPartitionLive (not a bare
  // heartbeat check) and why the mtime proof applies to the direct-marker
  // case only.
  let live = false;
  try { live = isSiblingPartitionLive({ id, sessionId: descSid, worktreePath: descWt }, home, { now, freshMs }); }
  catch (_) { live = false; } // this gate fails toward skip, never toward resurrect

  if (groupMarkerId) {
    if (live) {
      return { archived: true, migrateAsLive: true, reason: 'archived-worktree-group-live-sibling' };
    }
    return { archived: true, migrateAsLive: false, reason: 'archived-worktree-group-sibling' };
  }

  let markerMtime = null; let descMtime = null;
  try { markerMtime = F.statSync(markerPath).mtimeMs; } catch (_) { /* unreadable -> no proof */ }
  try { descMtime = F.statSync(activeDescriptorPathFor(home, id)).mtimeMs; } catch (_) { /* unreadable -> no proof */ }
  const descriptorIsNewer = Number.isFinite(markerMtime) && Number.isFinite(descMtime) && descMtime > markerMtime;

  if (descriptorIsNewer && live) {
    return { archived: true, migrateAsLive: true, reason: 'archived-marker-superseded-live-reuse' };
  }
  return { archived: true, migrateAsLive: false, reason: 'archived-marker-superseded-unconfirmed' };
}

module.exports = {
  archivedDescriptorPath, activeDescriptorPathFor, buildArchivedWorktreeIndex, resolveArchiveGate,
  realWorktreePath,
};
