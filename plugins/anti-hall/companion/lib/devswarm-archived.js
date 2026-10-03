'use strict';
// anti-hall :: devswarm-archived — THE ONE read-side "is this workspace
// archived?" predicate, shared by the roster (scripts/devswarm.js) and the
// parent Stop-gate's neglect classification (hooks/devswarm-parent-gate.js).
//
// WHY IT EXISTS (field report): after the owner archived workspaces in the
// DevSwarm app, their rows kept rendering as `escalated` / `not-draining` in
// the parent-gate header and in the roster. Nothing in the neglect
// classification consulted the archive state at all, so a workspace that is
// DONE AND PUT AWAY was still nagged about as neglected coordination.
//
// THE PREDICATE IS archived/<id>.json + A WORKTREE MATCH — deliberately NOT
// "archived record exists" and deliberately NOT scripts/devswarm.js's stricter
// `isArchivedOnlyWorkspace` (archived record present AND active descriptor
// GONE). Both boundaries are load-bearing:
//   * Why not bare presence: ids are commonly REUSED after a workspace is
//     archived (scripts/devswarm.js's archivedCounterpartInfo documents that
//     P1-b field defect), so a bare archived/<id>.json can belong to a
//     completely different, long-gone workspace. The archived record's own
//     `worktreePath` is the one field that discriminates, so it is required to
//     match the row's whenever both are known.
//   * Why not isArchivedOnlyWorkspace: hooks/devswarm-parent-gate.js classifies
//     rows from `readDescriptors`, which by construction only yields ids whose
//     ACTIVE workspaces/<id>.json still exists. Requiring the active descriptor
//     to be gone would make this check unreachable on exactly the surface the
//     field report is about — an inert guard. The mid-archive window (cmdArchive
//     hardlinks into archived/ before unlinking the active descriptor) resolves
//     to "archived" here, which is the correct answer for ALERTING: a workspace
//     being archived right now should not be nagged about as neglected.
// isArchivedOnlyWorkspace remains the right (stricter) test for its own caller,
// which DEMOTES a row's projection rather than merely suppressing an alert.
//
// KNOWN, DELIBERATE GAP (documented, not silently assumed away): archiving a
// workspace in the DevSwarm APP does not write anti-hall's archived/<id>.json
// and does not remove anti-hall's descriptor — closing is not deleting
// (liveness.js header). This predicate therefore covers workspaces archived
// through anti-hall's own `archive` verb, and does NOT detect an app-side-only
// archive. Detecting that would require spawning `hivecontrol workspace list`
// per row, which is not affordable on the Stop hook's cheap-read budget.
//
// FAIL-CLOSED (returns false) on every uncertainty: unsafe id, unreadable
// directory, unparseable descriptor. A false here means "classify exactly as
// today" — this module can only ever SUPPRESS an alert on positive proof, never
// create one.

const fs = require('fs');
const os = require('os');
const path = require('path');

function isSafeId(id) {
  if (typeof id !== 'string' || id === '') return false;
  if (id === '.' || id === '..') return false;
  if (id.includes('..')) return false;
  return /^[A-Za-z0-9._-]+$/.test(id);
}

function devswarmRoot(home) {
  return path.join(home || os.homedir(), '.anti-hall', 'devswarm');
}

// samePath(a, b) — realpath-normalized comparison, degrading to the raw string
// when a path no longer resolves (an archived worktree is routinely gone).
function samePath(a, b, F) {
  if (!a || !b) return false;
  let x = String(a); let y = String(b);
  try { x = F.realpathSync(x); } catch (_) {}
  try { y = F.realpathSync(y); } catch (_) {}
  return x === y;
}

// realSid(v) -> string | null. A "real" session id: present, non-empty,
// distinguishable from a placeholder. Shared shape for both the archived
// marker's own sessionId and the live descriptor's.
function realSid(v) {
  if (v == null) return null;
  const s = String(v);
  return s !== '' ? s : null;
}

// readLiveSessionId(root, sid, F) -> string | null. Reads
// workspaces/<id>.json's sessionId, fail-open to null on any error (no
// descriptor, unreadable, unparseable, absent field) — mirrors this module's
// own fail-closed contract: a read failure here means "nothing to
// contradict with", never a fabricated identity.
function readLiveSessionId(root, sid, F) {
  try {
    const raw = F.readFileSync(path.join(root, 'workspaces', sid + '.json'), 'utf8');
    const d = JSON.parse(raw);
    if (d && typeof d === 'object') return realSid(d.sessionId);
  } catch (_) { /* no live descriptor / unreadable — fail-open */ }
  return null;
}

// isArchivedWorkspace(home, id, worktreePath, opts) -> bool.
//   worktreePath is OPTIONAL. When given, the archived record's own
//   worktreePath must match it (or the archived record must carry none) — this
//   is what stops a REUSED id from inheriting a previous workspace's archive
//   ACROSS DIFFERENT WORKTREES.
//
//   SESSION-IDENTITY DISCRIMINATOR (P0 field fix): worktreePath alone cannot
//   discriminate a REUSED id whose new occupant sits at the SAME worktree
//   path — which is exactly the anchor-row shape, since a repo's anchor
//   always sits at the repo root. When the archived record carries a real
//   sessionId AND the live descriptor (or `opts.sessionId`, when the caller
//   already has it cheaply) carries a real, DIFFERENT sessionId, the marker
//   belongs to a PRIOR occupant of this id and is NOT this row's archive —
//   returns false. Every other case (no marker sessionId, no live sessionId
//   knowable, or matching sessionId) is unchanged from before this fix.
// opts: { fs, sessionId, log } (all injectable/optional).
//   opts.sessionId: the caller's already-known live sessionId, skipping this
//     function's own workspaces/<id>.json read. When omitted, this function
//     reads it itself (cheap: one small JSON file, same directory family
//     this call already touches).
//   opts.log(event, details): optional, called once when a marker is
//     dismissed as superseded — never called for any other return path.
function isArchivedWorkspace(home, id, worktreePath, opts) {
  const F = (opts && opts.fs) || fs;
  try {
    const sid = id != null ? String(id) : '';
    if (!isSafeId(sid)) return false;
    const root = devswarmRoot(home);
    const archivedPath = path.join(root, 'archived', sid + '.json');
    let raw = null;
    try { raw = F.readFileSync(archivedPath, 'utf8'); } catch (_) { return false; }
    let desc = null;
    try { desc = JSON.parse(raw); } catch (_) { return false; }
    if (!desc || typeof desc !== 'object') return false;

    if (worktreePath) {
      const archivedWt = typeof desc.worktreePath === 'string' && desc.worktreePath ? desc.worktreePath : null;
      if (archivedWt && !samePath(archivedWt, worktreePath, F)) return false;
    }

    const markerSid = realSid(desc.sessionId);
    if (markerSid) {
      const liveSid = (opts && realSid(opts.sessionId)) || readLiveSessionId(root, sid, F);
      if (liveSid && liveSid !== markerSid) {
        if (opts && typeof opts.log === 'function') {
          try { opts.log('archived-marker-superseded', { id: sid }); } catch (_) {}
        }
        return false;
      }
    }
    return true;
  } catch (_) { return false; }
}

module.exports = { isArchivedWorkspace, devswarmRoot, isSafeId, realSid, readLiveSessionId };
