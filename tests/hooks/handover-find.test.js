'use strict';
// hooks/lib/handover-find.js -- repoRoot(cwd), the shared wrapper around the
// canonical identity.js resolver that hooks/handover-resume.js,
// hooks/precompact-snapshot.js, hooks/tasklist-guard.js,
// hooks/task-lifecycle-log.js, hooks/progress-prune.js and
// scripts/migrate-state.js all now route through so every .anti-hall/{
// handovers,progress,history} path is joined onto the resolved repo root,
// never the raw session cwd.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const find = require('../../plugins/anti-hall/hooks/lib/handover-find.js');

function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-repoRoot-')));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first commit');
  return dir;
}

test('repoRoot(cwd) resolves to the git toplevel for a normal repo cwd', () => {
  const repo = makeRepo();
  try {
    const deep = path.join(repo, 'src', 'nested');
    fs.mkdirSync(deep, { recursive: true });
    assert.strictEqual(find.repoRoot(deep), repo);
    assert.strictEqual(find.repoRoot(repo), repo);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('repoRoot(cwd) falls back to cwd unchanged for a non-git directory', () => {
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-repoRoot-nogit-')));
  try {
    assert.strictEqual(find.repoRoot(plain), plain);
  } finally { fs.rmSync(plain, { recursive: true, force: true }); }
});

// P2 (coordinator safety-review of 1a88abc, 2026-09-25): `missingPath:
// 'ancestor'` made a DELETED cwd resolve to the nearest SURVIVING ancestor's
// repo -- e.g. a removed nested DevSwarm child worktree would then resolve to
// the main checkout, and a write path would write this (gone) worktree's
// session state into the main checkout's .anti-hall/ instead. repoRoot() must
// NOT climb like that: a missing cwd falls back to the raw (nonexistent) cwd,
// so the caller's own fs call fails and its existing fail-open handling
// applies -- never a cross-repo write.
test('repoRoot(cwd): a cwd that no longer exists does NOT climb to a surviving ancestor repo', () => {
  const repo = makeRepo();
  try {
    // Never actually created on disk -- simulates a worktree/dir removed
    // after the session started (cwd string is still what the hook was told).
    const removedNestedWorktree = path.join(repo, 'child-worktrees', 'gone-worktree');
    const resolved = find.repoRoot(removedNestedWorktree);
    assert.strictEqual(resolved, removedNestedWorktree, 'must fall back to the raw missing cwd, not climb to the surviving repo root');
    assert.notStrictEqual(resolved, repo, 'must NOT resolve to the ancestor repo');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// P2 (coordinator safety-review of 1a88abc, 2026-09-25): a dotfiles repo
// checked out AT $HOME (`~/.git`) must not resolve toplevel === HOME --
// otherwise every handover/progress/history write from a subdir of HOME
// would land in ~/.anti-hall/{handovers,progress,history}, mixing into
// anti-hall's OWN global state directory (session state, skip.json, etc).
test('repoRoot(cwd): a dotfiles repo AT $HOME falls back to the raw cwd instead of returning HOME', () => {
  const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-repoRoot-fakehome-')));
  const g = (...a) => execFileSync('git', a, { cwd: fakeHome, stdio: 'ignore' });
  g('init', '-q');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'dotfiles init');
  const subdir = path.join(fakeHome, 'some-project');
  fs.mkdirSync(subdir, { recursive: true });

  const savedHome = process.env.HOME;
  try {
    process.env.HOME = fakeHome;
    // Sanity: the toplevel really does resolve to $HOME before the guard --
    // otherwise this test would pass vacuously.
    const identity = require('../../plugins/anti-hall/companion/lib/identity.js');
    identity.clearCache();
    const rawCtx = identity.resolveContext(subdir);
    assert.strictEqual(rawCtx.toplevel, fakeHome, 'test setup sanity: the dotfiles repo toplevel must equal $HOME');

    const resolved = find.repoRoot(subdir);
    assert.strictEqual(resolved, subdir, 'must fall back to the raw cwd, not return $HOME');
    assert.notStrictEqual(resolved, fakeHome);
  } finally {
    process.env.HOME = savedHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
