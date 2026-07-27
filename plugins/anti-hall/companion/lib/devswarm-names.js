'use strict';
// anti-hall :: devswarm-names — cached workspace display-name projection.
//
// WHY: DevSwarm workspaces are addressed everywhere by a raw UUID (the
// registry's id / meshId). That is meaningless to a human reading the roster
// or the per-turn workspace table. hivecontrol itself carries a human title
// (`label`, live-verified via `workspace list all` / `workspace info <id>` —
// a free-text title that DEFAULTS to the branch name when `-t` was not
// passed at create) but anti-hall's own registry never captured it. This
// module is the ONE shared read/write surface for a per-id cached copy of
// that name, so the writers (scripts/devswarm.js's cmdSpawn seed +
// cmdReconcile backfill) and the reader (hooks/devswarm-parent-inbox.js's
// every-turn table render) can never drift on path or JSON shape — same
// posture as liveness.js's livenessPathFor/heartbeatPathFor.
//
// HOT-PATH CONTRACT: readName() is read ONLY from this fs projection — it
// NEVER spawns hivecontrol and NEVER throws. Every caller (especially the
// UserPromptSubmit hot-path hook) must treat a null return as "no cached
// name yet", falling back to the bare id, never as an error.

const fs = require('fs');
const path = require('path');
const { isSafeId, devswarmRoot } = require('./liveness.js');

// namePathFor(id, home) -> devswarmRoot/names/<id>.json. Same isSafeId gate
// as every other per-id projection path in this plugin (liveness/heartbeats)
// — never path.join an unsafe id.
function namePathFor(id, home) {
  if (!isSafeId(id)) throw new Error('unsafe workspace id: ' + JSON.stringify(id));
  return path.join(devswarmRoot(home), 'names', String(id) + '.json');
}

// readName(home, id) -> string | null. FAIL-OPEN: an unsafe id, a missing
// file, torn JSON, or a non-string/empty `name` field all read as "no cached
// name" — never throws. This is the ONLY function the hot-path hook may call.
function readName(home, id) {
  try {
    const p = namePathFor(id, home);
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (v && typeof v.name === 'string' && v.name) ? v.name : null;
  } catch (_) {
    return null;
  }
}

// writeName(home, id, name, now) -> bool (best-effort, never throws into the
// caller). Atomic tmp+rename, matching the other per-id projection writers in
// this plugin (e.g. devswarm-parent-inbox.js's markArchiveNudged). A
// non-string/empty name is a silent no-op — the caller (spawn/reconcile) must
// never fail because a name couldn't be cached.
function writeName(home, id, name, now) {
  if (typeof name !== 'string' || !name) return false;
  try {
    const p = namePathFor(id, home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ name, updatedAt: Number.isFinite(now) ? now : Date.now() }));
    fs.renameSync(tmp, p);
    return true;
  } catch (_) {
    return false;
  }
}

// shortId(id) -> the first 8 chars of the id (UUID short form), or the bare
// id verbatim when it is 8 chars or shorter. Never throws.
function shortId(id) {
  const s = (typeof id === 'string') ? id : String(id == null ? '' : id);
  return s.length > 8 ? s.slice(0, 8) : s;
}

// displayName(id, name) -> "name (shortid)" when a name is known, else the
// bare id. The ONE display-format rule for every human-facing surface
// (roster, hot-path table) so they can never render this differently.
function displayName(id, name) {
  if (typeof name === 'string' && name) return name + ' (' + shortId(id) + ')';
  return String(id == null ? '' : id);
}

module.exports = { namePathFor, readName, writeName, shortId, displayName };
