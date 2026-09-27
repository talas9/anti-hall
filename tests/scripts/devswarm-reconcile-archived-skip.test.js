'use strict';
// SkyCrew Primary report (0.115.2): update.js's post-pull `reconcile` step
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

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

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
function writeArchivedMarker(home, id) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'archived');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, at: Date.now() }));
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
    assert.match(row.error, /worktree not found on disk/);
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
