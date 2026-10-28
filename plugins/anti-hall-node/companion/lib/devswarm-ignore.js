'use strict';
// anti-hall :: devswarm-ignore — a simple, user-editable per-workspace ignore
// list for the URGENT/"not draining" nag (hooks/devswarm-parent-inbox.js's
// buildUrgentUnreadSegment/buildUnreadSegment, and the parent Stop gate's
// neglect block, hooks/devswarm-parent-gate.js).
//
// WHY THIS EXISTS: some workspaces nag every turn for a reason the automatic
// classifiers (row-state.js / liveness.js / the archive-ready gate) cannot
// resolve on their own — e.g. a deliberately-held test specimen, or a row the
// owner has already triaged by hand and wants silenced without archiving it
// (archiving changes its ROSTER status; this changes only whether it nags).
// A user-editable ignore file is the simplest fix that does not require
// teaching every classifier a new heuristic per-row.
//
// SHAPE (deliberately the plainest thing that could work — same
// tmp+rename-free "just read a small JSON file" convention as
// archive-ignore/<id>.json, but ONE shared file instead of one-file-per-id
// since this list is short-lived/hand-edited, not per-id state a workflow
// writes):
//   <home>/.anti-hall/devswarm/ignore.json
//   { "ids": ["8a81d9aa-...", "primary-68f24b6b"] }
//
// SCOPE: suppresses ONLY the imperative nag surfaces (the urgent/attention
// segments in the parent-inbox hook, and the neglect block in the parent Stop
// gate). It does NOT hide the id from the roster/workspace table — "ignored"
// means "stop shouting about it", not "stop tracking it". It also never
// suppresses a message that came FROM a child/peer (real work) — callers are
// responsible for applying this only to the axes documented at their own
// call site.
//
// FAIL-OPEN: an absent/malformed/unreadable file reads as "nothing ignored"
// (empty list), never as a crash and never as "ignore everything".

const fs = require('fs');
const os = require('os');
const path = require('path');

function ignoreFilePath(home) {
  return path.join(home || os.homedir(), '.anti-hall', 'devswarm', 'ignore.json');
}

// readIgnoreIds(home, fsi) -> Set<string>. Pure read; never throws.
function readIgnoreIds(home, fsi) {
  const F = fsi || fs;
  const out = new Set();
  try {
    const raw = F.readFileSync(ignoreFilePath(home), 'utf8');
    const parsed = JSON.parse(raw);
    const ids = parsed && Array.isArray(parsed.ids) ? parsed.ids : [];
    for (const id of ids) {
      if (typeof id === 'string' && id !== '') out.add(id);
    }
  } catch (_) { /* absent/malformed -> empty (fail-open toward NOT ignoring) */ }
  return out;
}

// isNagIgnored(home, id, fsi) -> bool.
function isNagIgnored(home, id, fsi) {
  if (id == null) return false;
  try { return readIgnoreIds(home, fsi).has(String(id)); } catch (_) { return false; }
}

module.exports = { ignoreFilePath, readIgnoreIds, isNagIgnored };
