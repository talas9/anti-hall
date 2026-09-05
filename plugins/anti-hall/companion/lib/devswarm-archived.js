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

// isArchivedWorkspace(home, id, worktreePath, opts) -> bool.
//   worktreePath is OPTIONAL. When given, the archived record's own
//   worktreePath must match it (or the archived record must carry none) — this
//   is what stops a REUSED id from inheriting a previous workspace's archive.
// opts: { fs } (injectable for tests).
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
    if (!worktreePath) return true; // caller has no path to disambiguate with
    const archivedWt = typeof desc.worktreePath === 'string' && desc.worktreePath ? desc.worktreePath : null;
    if (!archivedWt) return true; // archived record names no worktree — nothing to contradict
    return samePath(archivedWt, worktreePath, F);
  } catch (_) { return false; }
}

module.exports = { isArchivedWorkspace, devswarmRoot };
