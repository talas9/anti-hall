'use strict';
// Regression test for defect d386d8a610b7 (P2, Group D): heartbeat daemons
// started by the DevSwarm workspace app are disowned and keep running after
// app-side archive, producing false-live liveness reads. The app-side daemon
// launcher is EXTERNAL to anti-hall (not a file this repo ships or controls),
// so the fix is on the READ side: routing-liveness must ignore a heartbeat for
// a row this plugin already knows is archived (locally, via archived/<id>.json,
// or app-side, via the supervisor's cached active-set snapshot).
//
// Root cause: neither isRoutingLiveRow nor isRoutingLiveRowStrict
// (scripts/devswarm.js) checked archived state at all before trusting
// isSiblingPartitionLive's heartbeat-freshness signal — unlike the DISPLAY-only
// `live` field (cmdDiagnose) and rosterHints, which both already gate on
// archivedInApp/archived. That means an orphaned daemon's stale-but-still-
// beating heartbeat for an ARCHIVED row could win real routing decisions
// (pickSurvivor/resolveMeshTarget target selection, and groupRegistryByMeshId's
// split/kind classification `diagnose`/`reap-orphans` act on), not just
// cosmetic display.
//
// Fix under test: isArchivedForRouting (scripts/devswarm.js) — the SAME
// archived predicate rosterHints/cmdDiagnose already share — now gates BOTH
// isRoutingLiveRow and isRoutingLiveRowStrict before either ever consults the
// heartbeat.
//
// Points at ANTIHALL_TEST_PLUGIN_ROOT (a `plugins/anti-hall`-shaped tree) so
// this SAME file proves RED against HEAD (pre-fix) and GREEN against the live,
// already-fixed working tree without duplication. Defaults to the real repo
// tree (the current, already-patched working copy).

const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = process.env.ANTIHALL_TEST_PLUGIN_ROOT
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');

const cliPath = path.join(ROOT, 'scripts', 'devswarm.js');
const livenessPath = path.join(ROOT, 'companion', 'lib', 'liveness.js');
if (!fs.existsSync(cliPath) || !fs.existsSync(livenessPath)) {
  throw new Error(
    'ANTIHALL_TEST_PLUGIN_ROOT=' + JSON.stringify(ROOT) + ' is not a plugins/anti-hall-shaped '
    + 'tree — expected to find both:\n  ' + cliPath + '\n  ' + livenessPath
  );
}
const cli = require(cliPath);
const LIVENESS = require(livenessPath);

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-d386d8a610b7-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'archived'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// Seed a LOCALLY-archived row (archived/<id>.json) whose ORPHANED heartbeat
// daemon (the field-reported shape) is still beating with a completely FRESH
// timestamp — the worst case: nothing about the heartbeat itself looks stale.
function seedArchivedRowWithFreshHeartbeat(home, id, worktreePath) {
  const archivedPath = path.join(home, '.anti-hall', 'devswarm', 'archived', id + '.json');
  fs.writeFileSync(archivedPath, JSON.stringify({ id, worktreePath, sessionId: null }));
  const hbPath = LIVENESS.heartbeatPathFor(id, home);
  fs.mkdirSync(path.dirname(hbPath), { recursive: true });
  fs.writeFileSync(hbPath, JSON.stringify({ id, ts: Date.now(), state_ts: Date.now(), source: 'cli-heartbeat' }));
}

test('isRoutingLiveRow ignores an orphaned-daemon fresh heartbeat for an ARCHIVED row', () => {
  const home = tmpHome();
  try {
    const worktreePath = path.join(home, 'wt');
    seedArchivedRowWithFreshHeartbeat(home, 'archived-row', worktreePath);
    const row = { id: 'archived-row', worktreePath, sessionId: null };
    assert.strictEqual(cli.isArchivedForRouting(row, home), true, 'the row must be recognized as archived');
    assert.strictEqual(cli.isRoutingLiveRow(row, home), false, 'an archived row must never read live from a heartbeat alone');
  } finally { rm(home); }
});

test('isRoutingLiveRowStrict ALSO ignores the orphaned heartbeat for an archived row (fold/routing target selection stays safe)', () => {
  const home = tmpHome();
  try {
    const worktreePath = path.join(home, 'wt');
    seedArchivedRowWithFreshHeartbeat(home, 'archived-row2', worktreePath);
    const row = { id: 'archived-row2', worktreePath, sessionId: null };
    assert.strictEqual(cli.isRoutingLiveRowStrict(row, home), false, 'strict routing liveness must also ignore an archived row\'s orphaned heartbeat');
  } finally { rm(home); }
});

test('a genuinely live, NON-archived row with a fresh heartbeat is unaffected by the archive gate', () => {
  const home = tmpHome();
  try {
    const worktreePath = path.join(home, 'wt');
    const hbPath = LIVENESS.heartbeatPathFor('live-row', home);
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ id: 'live-row', ts: Date.now(), state_ts: Date.now(), source: 'cli-heartbeat' }));
    const row = { id: 'live-row', worktreePath, sessionId: null };
    assert.strictEqual(cli.isArchivedForRouting(row, home), false);
    assert.strictEqual(cli.isRoutingLiveRow(row, home), true, 'a non-archived, genuinely fresh-heartbeat row must still read live');
  } finally { rm(home); }
});
