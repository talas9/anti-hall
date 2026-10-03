'use strict';
// A DevSwarm Primary's report (0.115.2): update.js's post-pull `reconcile` step
// reported 17 worktree records as FAILURES — 14 "unknown error" and 9
// "worktree not found on disk" (overlapping) — when every one of them was an
// ARCHIVED workspace (isActive=0/isHidden=1 in the DevSwarm app, or already
// carrying anti-hall's own archived/<id>.json marker). Root cause:
//   (1) cmdReconcile had no pre-spawn archived check, so an archived-but-
//       still-on-disk row reached `inbox pull` -> cmdRegister's APP-DB
//       ARCHIVE GUARD, which refuses the ensure with `{ok:false, reason:...}`
//       (no `.error` field) — cmdReconcile's error-field fallback then
//       discarded that reason entirely and printed "unknown error".
//   (2) an archived row whose worktree was ALSO pruned from disk already hit
//       the pre-spawn missing-worktree skip, but that skip had no concept of
//       "archived" and always reported it as a bare failure.
// Fix: classify both cases as `skipped:true` with a `skipReason`, and surface
// the real per-target cause (parsed.reason, or the hivecontrol exit/stderr)
// instead of ever falling through to a bare "unknown error".
//
// MUTATION CHECK: reverting the pre-spawn archived check (keeping only the
// missing-worktree/git-root skips) must turn the first two tests below RED —
// an archived-but-present row would spawn `inbox pull` for real.

require('../helpers/isolate-home.js'); // HOME -> empty temp dir: this file reads home-dir state
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const appDb = require('../../plugins/anti-hall/companion/lib/devswarm-app-db.js');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skipNoSqlite = sqlite ? false : 'node:sqlite unavailable';

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-reconcile-archived-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-reconcile-archived-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function seedRegistry(home, repoKey, desc) {
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try { s.upsertRegistry(desc); } finally { s.close(); }
}
// writeArchivedMarker: anti-hall's own archived/<id>.json marker
// (hasArchivedCounterpart's contract) — the local-marker half of
// reconcileRowArchived's two signals (app DB is the other, tested
// separately with a real sqlite fixture in devswarm-app-db.test.js).
function writeArchivedMarker(home, id, extra) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'archived');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(Object.assign({ id, at: Date.now() }, extra || {})));
}
// appDbFixture(base, id, worktreePath) -> env pointing ANTIHALL_DEVSWARM_APP_DB
// at a fresh sqlite file holding one ACTIVE builder row for `id`/`worktreePath`
// (isActive=1, isHidden=0) — the "app DB live and says this row is live" case.
function appDbFixture(base, id, worktreePath) {
  const dbFile = path.join(base, 'app', 'devswarm.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec('CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, worktreePath TEXT, isHidden INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1)');
  db.prepare('INSERT INTO builders (id, repositoryId, worktreePath, isHidden, isActive) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'r1', worktreePath, 0, 1);
  db.close();
  return { ANTIHALL_DEVSWARM_APP_DB: dbFile, ANTIHALL_DEVSWARM_APP_DB_CACHE_MS: '0' };
}

test('cmdReconcile: an archived row whose worktree still exists is skipped (never spawned), not a failure', () => {
  const home = tmpHome();
  const repo = makeGitRepo('archived-present');
  const childRepo = makeGitRepo('archived-present-child');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'arch1', worktreePath: childRepo, sessionId: 's' });
    writeArchivedMarker(home, 'arch1');
    // Deliberately NOT injecting io.spawnReconcile — the archived pre-check
    // must fire on the REAL defaultSpawnReconcile gate (usingDefaultSpawn),
    // so it never even reaches a spawn to observe.
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo }));
    assert.strictEqual(r.result.ok, true, 'an archived skip is benign, not a failure');
    const row = r.result.results.find((x) => x.id === 'arch1');
    assert.ok(row, 'row present in results');
    assert.strictEqual(row.skipped, true);
    assert.match(row.skipReason, /archived/i);
    assert.strictEqual(row.worktreeMissing, false);
    assert.strictEqual(r.result.processed, 0, 'a pre-spawn-skipped row must not count toward processed');
  } finally { rm(home); rm(repo); rm(childRepo); }
});

test('cmdReconcile: an archived row whose worktree is ALSO missing on disk is skipped, not "worktree not found" failure', () => {
  const home = tmpHome();
  const repo = makeGitRepo('archived-missing');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const goneDir = path.join(os.tmpdir(), 'anti-hall-reconcile-archived-gone-' + Date.now());
    seedRegistry(home, repoKey, { id: 'arch2', worktreePath: goneDir, sessionId: 's' });
    writeArchivedMarker(home, 'arch2');
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo }));
    assert.strictEqual(r.result.ok, true, 'an archived+pruned row is benign, not a failure');
    const row = r.result.results.find((x) => x.id === 'arch2');
    assert.ok(row);
    assert.strictEqual(row.worktreeMissing, true);
    assert.strictEqual(row.skipped, true);
    assert.match(row.skipReason, /archived/i);
    // Terminal, expected state: not a failure, so no ok:false and no error text.
    assert.strictEqual(row.ok, true);
    assert.strictEqual(row.error, null);
  } finally { rm(home); rm(repo); }
});

test('cmdReconcile: a LIVE (not archived) row with a missing worktree is still a real failure, with a clear reason', () => {
  const home = tmpHome();
  const repo = makeGitRepo('live-missing');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const goneDir = path.join(os.tmpdir(), 'anti-hall-reconcile-live-gone-' + Date.now());
    seedRegistry(home, repoKey, { id: 'live1', worktreePath: goneDir, sessionId: 's' });
    // No archived marker, no app DB configured -> reconcileRowArchived must
    // resolve to false (fail-closed toward "not archived").
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo }));
    const row = r.result.results.find((x) => x.id === 'live1');
    assert.ok(row);
    assert.strictEqual(row.worktreeMissing, true);
    assert.strictEqual(row.skipped, false, 'a live row is never classified as skipped');
    assert.match(row.error, /worktree not found on disk/, 'the failure carries a clear, specific reason');
  } finally { rm(home); rm(repo); }
});

test('cmdReconcile: a subprocess result with no `.error` field (e.g. a reason-only refusal) never renders as "unknown error"', () => {
  const home = tmpHome();
  const repo = makeGitRepo('reason-only');
  const childRepo = makeGitRepo('reason-only-child');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'reasonly', worktreePath: childRepo, sessionId: 's' });
    const io = {
      spawnReconcile: () => ({
        status: 0,
        // No `.error` key at all — the exact shape cmdRegister's own
        // app-archived-skip / no-project / reserved-token refusals return.
        stdout: JSON.stringify({ ok: false, action: 'app-archived-skip', reason: 'workspace reasonly is archived in the DevSwarm app' }),
        error: null,
      }),
    };
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo, io }));
    const row = r.result.results.find((x) => x.id === 'reasonly');
    assert.ok(row);
    assert.strictEqual(row.ok, false);
    assert.notStrictEqual(row.error, null, 'must never silently drop the real cause');
    assert.doesNotMatch(String(row.error), /unknown error/);
    assert.match(row.error, /archived in the DevSwarm app/);
  } finally { rm(home); rm(repo); rm(childRepo); }
});

// fix-wave-3 P1 (R3-RV1-1 / R3A1-RECON-1): reconcileRowArchived used to OR
// the bare, non-discriminated hasArchivedCounterpart existsSync check onto
// the canonical row-eligibility.js verdict. A reused id — a LIVE row whose id
// carries a SUPERSEDED archived/<id>.json marker from a PRIOR occupant of
// that same id — was misclassified as archived and skipped by cmdReconcile,
// even though isArchivedWorkspace itself (the marker's own discriminator)
// says the marker does not belong to this row. Each case below must NOT be
// skipped, with the app DB both off (no override) and live (app DB says the
// row is genuinely active) — the app-DB verdict must never resurrect a stale
// marker's bare-existence skip either.
//
// MUTATION CHECK: re-adding `|| hasArchivedCounterpart(home, d.id)` to
// reconcileRowArchived must turn both cases below RED (skipped:true).

test('cmdReconcile: a LIVE row whose id carries a marker for a FOREIGN worktree is never skipped', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-reconcile-reused-wt-')));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-reconcile-reused-wt-base-'));
  const repo = makeGitRepo('reused-wt');
  const liveWorktree = makeGitRepo('reused-wt-live');
  const foreignWorktree = makeGitRepo('reused-wt-foreign');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'reused1', worktreePath: liveWorktree, sessionId: 'live-session' });
    // The PRIOR occupant of id "reused1" archived at a DIFFERENT worktree.
    writeArchivedMarker(home, 'reused1', { worktreePath: foreignWorktree, sessionId: 'old-session' });

    // (1) app DB off.
    const r1 = cli.run(['reconcile'], ctx(home, { cwd: repo }));
    const row1 = r1.result.results.find((x) => x.id === 'reused1');
    assert.ok(row1, 'row present (app DB off)');
    assert.strictEqual(row1.skipped, false, 'app DB off: a live row must not be skipped off a foreign-worktree marker');

    // (2) app DB live, says the row is genuinely active at liveWorktree.
    const env2 = { env: appDbFixture(base, 'reused1', liveWorktree) };
    appDb.resetCache();
    const r2 = cli.run(['reconcile'], ctx(home, Object.assign({ cwd: repo }, env2)));
    const row2 = r2.result.results.find((x) => x.id === 'reused1');
    assert.ok(row2, 'row present (app DB live)');
    assert.strictEqual(row2.skipped, false, 'app DB live: a live row must not be skipped off a foreign-worktree marker');
  } finally {
    appDb.resetCache();
    rm(home); rm(base); rm(repo); rm(liveWorktree); rm(foreignWorktree);
  }
}, { skip: skipNoSqlite });

test('cmdReconcile: a LIVE row at the SAME worktree as a marker for a DIFFERENT sessionId is never skipped', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-reconcile-reused-sid-')));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-reconcile-reused-sid-base-'));
  const repo = makeGitRepo('reused-sid');
  const liveWorktree = makeGitRepo('reused-sid-live');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'reused2', worktreePath: liveWorktree, sessionId: 'new-session' });
    // The PRIOR occupant of id "reused2" archived at the SAME worktree (an
    // anchor-row-shaped reuse) but under a DIFFERENT sessionId.
    writeArchivedMarker(home, 'reused2', { worktreePath: liveWorktree, sessionId: 'old-session' });

    // (1) app DB off.
    const r1 = cli.run(['reconcile'], ctx(home, { cwd: repo }));
    const row1 = r1.result.results.find((x) => x.id === 'reused2');
    assert.ok(row1, 'row present (app DB off)');
    assert.strictEqual(row1.skipped, false, 'app DB off: a live row must not be skipped off a same-worktree, different-session marker');

    // (2) app DB live, says the row is genuinely active at liveWorktree.
    const env2 = { env: appDbFixture(base, 'reused2', liveWorktree) };
    appDb.resetCache();
    const r2 = cli.run(['reconcile'], ctx(home, Object.assign({ cwd: repo }, env2)));
    const row2 = r2.result.results.find((x) => x.id === 'reused2');
    assert.ok(row2, 'row present (app DB live)');
    assert.strictEqual(row2.skipped, false, 'app DB live: a live row must not be skipped off a same-worktree, different-session marker');
  } finally {
    appDb.resetCache();
    rm(home); rm(base); rm(repo); rm(liveWorktree);
  }
}, { skip: skipNoSqlite });

test('cmdReconcile: a GENUINE archive (marker matches worktree + session) still skips', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-reconcile-genuine-'));
  const repo = makeGitRepo('genuine-archive');
  const childRepo = makeGitRepo('genuine-archive-child');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'genuine1', worktreePath: childRepo, sessionId: 's' });
    writeArchivedMarker(home, 'genuine1', { worktreePath: childRepo, sessionId: 's' });
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo }));
    const row = r.result.results.find((x) => x.id === 'genuine1');
    assert.ok(row);
    assert.strictEqual(row.skipped, true, 'a genuine archive (same worktree + session) must still be skipped');
  } finally { rm(home); rm(repo); rm(childRepo); }
});
