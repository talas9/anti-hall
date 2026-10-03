'use strict';
// Defect D (routing-path parity, part of the d386d8a610b7 archive-marker
// family): isArchivedForRouting (plugins/anti-hall/scripts/devswarm.js,
// isRoutingLiveRowStrict/isRoutingLiveRow's shared archive gate) called
// isArchivedWorkspace(home, row.id, row.worktreePath, {}) — an EMPTY opts
// object — instead of passing { sessionId: row.sessionId, log } the way the
// two other callers (hooks/devswarm-parent-gate.js:1078 and this file's own
// diagnose archived-check, cmdDiagnose) already do. isArchivedWorkspace's own
// v0.97.0 reused-id discriminator (7e1ae67) needs a caller-supplied
// `opts.sessionId` to compare against the archived marker's own sessionId —
// without it a marker left behind by a PRIOR occupant of a reused id could
// make a CURRENT, live occupant read as archived (and therefore non-routable)
// on this specific routing path, even though the roster/diagnose surfaces
// (which DID pass sessionId) already correctly treated the row as live.
//
// Exercises isRoutingLiveRowStrict (exported) directly against a real
// on-disk archived/<id>.json + workspaces/<id>.json pair — no CLI subprocess
// needed. Isolates HOME to a scratch temp dir.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'devswarm.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-d386-routing-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces'), { recursive: true });
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'archived'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function writeArchivedMarker(home, id, worktreePath, sessionId) {
  fs.writeFileSync(
    path.join(home, '.anti-hall', 'devswarm', 'archived', id + '.json'),
    JSON.stringify({ id, worktreePath, sessionId })
  );
}
function writeLiveDescriptor(home, id, worktreePath, sessionId) {
  fs.writeFileSync(
    path.join(home, '.anti-hall', 'devswarm', 'workspaces', id + '.json'),
    JSON.stringify({ id, worktreePath, sessionId })
  );
}

test('D: an archived marker from a PRIOR occupant (different sessionId) does not make a live row non-routable, even with no live descriptor file on disk', () => {
  const home = tmpHome();
  try {
    const id = 'reused-id-1';
    const worktreePath = '/tmp/does-not-need-to-exist-prior';
    // A prior occupant of this SAME id archived it under session-old.
    writeArchivedMarker(home, id, worktreePath, 'session-old');
    // NO workspaces/<id>.json on disk (e.g. a registry-only row, or the
    // descriptor file was since removed) — isArchivedWorkspace's own
    // self-derived readLiveSessionId fallback CANNOT see the current
    // occupant's sessionId in this case; only a caller-supplied
    // `opts.sessionId` (this fix) lets the discriminator still fire. The
    // caller (isRoutingLiveRowStrict) knows the CURRENT occupant's sessionId
    // independently (from its own registry row), which is exactly what
    // `row.sessionId` carries here.
    const row = { id, worktreePath, sessionId: 'session-new' };
    assert.strictEqual(
      cli.isArchivedForRouting(row, home), false,
      'a prior occupant\'s archive marker (different sessionId) must NOT read as THIS row\'s archive'
    );
  } finally { rm(home); }
});

test('D: an archived marker for the SAME sessionId DOES make the row archived-for-routing', () => {
  const home = tmpHome();
  try {
    const id = 'reused-id-2';
    const worktreePath = '/tmp/does-not-need-to-exist-same';
    writeArchivedMarker(home, id, worktreePath, 'session-same');
    writeLiveDescriptor(home, id, worktreePath, 'session-same');

    const row = { id, worktreePath, sessionId: 'session-same' };
    assert.strictEqual(
      cli.isArchivedForRouting(row, home), true,
      'a marker whose sessionId matches this row\'s OWN current sessionId must read as archived'
    );
  } finally { rm(home); }
});
