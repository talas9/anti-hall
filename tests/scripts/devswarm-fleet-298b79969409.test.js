'use strict';
// Regression test for defect 298b79969409 (P1, Group D): roster hints and
// diagnose disagreeing on the same row's liveness. Root cause: rosterHints'
// dormancy signal (companion/lib/liveness.js's rowLivenessState) never checked
// isLiveSessionId and read 'active' (no hint) the instant isDormantByActivity
// was false — regardless of whether the row even carried a real sessionId —
// while cmdDiagnose's `live` field DOES require isLiveSessionId (unless there
// is a FRESH heartbeat). hasFreshHeartbeat's freshness window is materially
// TIGHTER than isDormantByActivity's dormant/idle window, so a PHANTOM row (no
// real sessionId, heartbeat stale-by-freshness-standard but still inside the
// wider activity window) reads roster-active ([] hints) while diagnose reports
// live:false for the SAME row — the field report (twin row: roster hints [],
// diagnose live:false; a child trusted the hint and stranded mail).
//
// Fix under test (scripts/devswarm.js): cmdRoster and cmdDiagnose now derive
// liveness from ONE shared function, computeRowLive; rosterHints adds a
// 'phantom' hint whenever it would otherwise disagree with it.
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
const cp = require('node:child_process');

const ROOT = process.env.ANTIHALL_TEST_PLUGIN_ROOT
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');

const cliPath = path.join(ROOT, 'scripts', 'devswarm.js');
const storePath = path.join(ROOT, 'companion', 'lib', 'devswarm-store.js');
if (!fs.existsSync(cliPath) || !fs.existsSync(storePath)) {
  throw new Error(
    'ANTIHALL_TEST_PLUGIN_ROOT=' + JSON.stringify(ROOT) + ' is not a plugins/anti-hall-shaped '
    + 'tree — expected to find both:\n  ' + cliPath + '\n  ' + storePath
  );
}
const cli = require(cliPath);
const storeLib = require(storePath);
const inst = require(path.join(ROOT, 'companion', 'install-devswarm-ingest.js'));
const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));
const liveness = require(path.join(ROOT, 'companion', 'lib', 'liveness.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-298b79969409-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-298b79969409-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

// twinRowVerdict() — seeds a PHANTOM row (no real sessionId, heartbeat stale
// enough to fail hasFreshHeartbeat's tight freshness window but well inside
// isDormantByActivity's much wider idle window) and returns the roster hints
// + diagnose live verdict for it.
function twinRowVerdict() {
  const home = tmpHome();
  const main = makeGitRepo('twin');
  try {
    const repoKey = repokey.repoKeyForWorktree(main);
    const top = inst.resolveWorktree(main);
    const s = storeLib.openStore({ home, hash: repoKey });
    try {
      s.upsertRegistry({ id: 'twin-row', worktreePath: top, sessionId: null });
    } finally { s.close(); }
    const freshMs = Number.isFinite(liveness.DEFAULT_HEARTBEAT_FRESH_MS) ? liveness.DEFAULT_HEARTBEAT_FRESH_MS : 90 * 1000;
    const hbPath = liveness.heartbeatPathFor('twin-row', home);
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    const staleForFreshness = Date.now() - (freshMs * 20);
    fs.writeFileSync(hbPath, JSON.stringify({ id: 'twin-row', ts: staleForFreshness, state_ts: staleForFreshness, source: 'cli-heartbeat' }));

    const now = Date.now();
    const ctx = { home, cwd: main, env: {}, now };
    const roster = cli.cmdRoster({}, ctx);
    assert.strictEqual(roster.ok, true);
    const s2 = storeLib.openStore({ home, hash: repoKey });
    let diagRows;
    try { diagRows = cli.computeDiagnosis(s2, { home, env: {}, now }).registry; } finally { s2.close(); }
    const rosterRow = roster.workspaces.find((w) => w.id === 'twin-row');
    const diagnoseRow = diagRows.find((r) => r.id === 'twin-row');
    assert.ok(rosterRow, 'twin-row must appear on the roster');
    assert.ok(diagnoseRow, 'twin-row must appear on diagnose');
    return { rosterHints: rosterRow.hints, diagnoseLive: diagnoseRow.live };
  } finally { rm(main); rm(home); }
}

test('roster and diagnose agree on the phantom twin row: diagnose says not-live, roster surfaces a phantom hint', () => {
  const r = twinRowVerdict();
  assert.strictEqual(r.diagnoseLive, false, 'diagnose already knows this row is not live');
  assert.ok(r.rosterHints.includes('phantom'), 'roster must surface the disagreement instead of silently reading active');
});

// E fix regression: a native hivecontrol child (no registry row / mesh
// descriptor at all — cmdRoster's nativeChildren fold calls rosterHints with
// sessionId:null BY CONSTRUCTION, see plugins/anti-hall/scripts/devswarm.js
// ~:10700) must NEVER read `phantom` — that hint means "this registry row
// looks alive but computeRowLive disagrees", which is meaningless for a row
// with no registry entry to disagree about. Exercises rosterHints directly
// (exported) with registryBacked:false, the exact opts shape the native fold
// passes, and confirms computeRowLive alone (without the gate) WOULD have
// flagged this shape as not-live — i.e. the gate is load-bearing, not a
// no-op.
test('E: a native hivecontrol child (registryBacked:false, sessionId:null) never reads phantom, even though computeRowLive alone would call it not-live', () => {
  const home = tmpHome();
  try {
    const now = Date.now();
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-298b-native-'));
    const nativeId = 'native-child-1';

    // Sanity: computeRowLive (the SAME predicate the phantom gate consults)
    // reads this row as NOT live on its own — proving the gate, not an
    // unrelated liveness signal, is what suppresses the hint below.
    assert.strictEqual(
      cli.computeRowLive({ id: nativeId, worktreePath, sessionId: null }, home, { now }),
      false,
      'sanity: computeRowLive must call a no-session, no-heartbeat row not-live'
    );

    const hints = cli.rosterHints(home, nativeId, worktreePath, now, null, {
      env: {}, registryBacked: false,
    });
    assert.ok(!hints.includes('phantom'),
      'a native (registryBacked:false) row must never carry the phantom hint (got: ' + JSON.stringify(hints) + ')');
  } finally { rm(home); }
});

test('a genuinely live row (real sessionId, fresh heartbeat) is never mislabeled phantom, and both surfaces agree live', () => {
  const home = tmpHome();
  const main = makeGitRepo('alive');
  try {
    const repoKey = repokey.repoKeyForWorktree(main);
    const top = inst.resolveWorktree(main);
    const s = storeLib.openStore({ home, hash: repoKey });
    try { s.upsertRegistry({ id: 'alive-row', worktreePath: top, sessionId: 'real-session-id' }); } finally { s.close(); }
    const hbPath = liveness.heartbeatPathFor('alive-row', home);
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ id: 'alive-row', ts: Date.now(), state_ts: Date.now(), source: 'cli-heartbeat' }));

    const now = Date.now();
    const ctx = { home, cwd: main, env: {}, now };
    const roster = cli.cmdRoster({}, ctx);
    const s2 = storeLib.openStore({ home, hash: repoKey });
    let diagRows;
    try { diagRows = cli.computeDiagnosis(s2, { home, env: {}, now }).registry; } finally { s2.close(); }
    const rosterRow = roster.workspaces.find((w) => w.id === 'alive-row');
    const diagnoseRow = diagRows.find((r) => r.id === 'alive-row');
    assert.ok(!rosterRow.hints.includes('phantom'));
    assert.strictEqual(diagnoseRow.live, true);
  } finally { rm(main); rm(home); }
});
