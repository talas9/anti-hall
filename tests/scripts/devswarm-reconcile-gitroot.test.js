'use strict';
// D11-C, defect 6ef55fd42cc9 — cmdReconcile's pre-spawn skip only checked
// `fs.existsSync(d.worktreePath)`. A submodule worktree whose gitdir link is
// gone (or any other directory that exists on disk but is not a resolvable
// git root) passed that check and reached hivecontrol as the spawned child's
// cwd, which fails "Repository not found. Make sure to pass the git root
// path." The fix requires `git -C <worktreePath> rev-parse --show-toplevel`
// to succeed BEFORE spawning, skipping (and counting `skippedNotGitRoot`,
// zero budget cost) a row whose path exists but isn't a git root — a plain,
// real, non-git tmp directory reproduces this without needing a fake git
// binary.
//
// MUTATION CHECK: removing the git-root pre-check (only keeping the
// existsSync skip) must turn the first test below RED — the row would then
// actually spawn `inbox pull` with a non-git cwd.

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-reconcile-gitroot-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-reconcile-gitroot-repo-' + tag + '-'));
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

test('cmdReconcile: a worktree that EXISTS on disk but is not a git root is skipped (skippedNotGitRoot), never spawned, costs zero budget, and stays ok:true (benign)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('notgitroot');
  // A REAL directory that exists on disk but was never `git init`'d — the
  // exact shape a submodule worktree with a broken/gone gitdir link takes:
  // existsSync passes, `git rev-parse --show-toplevel` fails.
  const notGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-reconcile-notgit-'));
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'stray', worktreePath: notGitDir, sessionId: 's' });
    // No `io` injection: defaultSpawnReconcile is the REAL spawn function, so
    // the pre-spawn git-root check applies (an injected spawnReconcile test
    // double is deliberately never subject to it — same posture as the
    // pre-existing missing-worktree skip).
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo }));
    assert.strictEqual(r.result.ok, true, 'a notGitRoot skip is a recognized BENIGN skip, not a failure');
    assert.strictEqual(r.result.skippedNotGitRoot, 1);
    assert.strictEqual(r.result.processed, 0, 'a pre-spawn-skipped row must not count toward `processed`');
    const row = r.result.results.find((x) => x.id === 'stray');
    assert.ok(row);
    assert.strictEqual(row.notGitRoot, true);
    assert.strictEqual(row.worktreeMissing, false, 'this is a DIFFERENT skip reason than missing-worktree');
    assert.match(row.error, /not a resolvable git root/);
  } finally { rm(home); rm(repo); rm(notGitDir); }
});

test('cmdReconcile: a worktree that IS a real git root is unaffected (spawns normally via the injected spawn double)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('isgitroot');
  const childRepo = makeGitRepo('isgitroot-child');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'real', worktreePath: childRepo, sessionId: 's' });
    const calls = [];
    const io = { spawnReconcile: (d) => { calls.push(d.worktreePath); return { status: 0, stdout: JSON.stringify({ ok: true, imported: 0 }), error: null }; } };
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo, io }));
    assert.strictEqual(r.result.ok, true);
    assert.strictEqual(r.result.skippedNotGitRoot || 0, 0);
    assert.strictEqual(r.result.processed, 1);
    assert.deepStrictEqual(calls, [childRepo]);
  } finally { rm(home); rm(repo); rm(childRepo); }
});
