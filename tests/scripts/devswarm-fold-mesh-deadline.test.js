'use strict';
// D11-C, defect e7307778b614 — foldMeshDuplicates' mesh-id group loop had NO
// budget of its own: it read `ctx.deadline` nowhere, so update.js's own
// per-store sweep budget (sweepBudgetMs) could not actually bound how long a
// SINGLE call spent inside this function once a store had many duplicate
// groups to fold. The fix threads `ctx.deadline` through the group loop,
// stopping BEFORE starting the next group (never mid-group) once it has
// passed — except the very first group, which always runs (forward-progress
// guarantee), matching update.js's own runThrottledSweep contract.
//
// MUTATION CHECK: removing the deadline check from the group loop must turn
// the first test below RED — both groups would fold instead of only the first.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fold-deadline-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fold-deadline-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function topOf(dir) { return inst.resolveWorktree(dir); }
function addLinkedWorktree(mainDir, tag) {
  const wt = path.join(path.dirname(mainDir), path.basename(mainDir) + '-wt-' + tag);
  cp.spawnSync('git', ['-C', mainDir, 'worktree', 'add', wt, '-b', 'branch-' + tag]);
  return wt;
}

test('foldMeshDuplicates: an already-spent ctx.deadline folds only the FIRST duplicate group, defers the rest (budgetExhausted, skipped)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('folddl');
  let wtDup1 = null;
  let wtDup2 = null;
  try {
    // TWO distinct worktrees, each carrying its OWN duplicate pair (2 rows
    // sharing that worktree's canonicalMeshId) — two independent mesh-id
    // groups, so the loop has more than one item to defer.
    wtDup1 = addLinkedWorktree(repo, 'folddl1');
    wtDup2 = addLinkedWorktree(repo, 'folddl2');
    const repoKey = repokey.repoKeyForWorktree(wtDup1);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      s.upsertRegistry({ id: 'dup1-live', worktreePath: topOf(wtDup1), sessionId: 's1a' });
      s.upsertRegistry({ id: 'dup1-live-b', worktreePath: topOf(wtDup1), sessionId: 's1b' });
      s.upsertRegistry({ id: 'dup2-live', worktreePath: topOf(wtDup2), sessionId: 's2a' });
      s.upsertRegistry({ id: 'dup2-live-b', worktreePath: topOf(wtDup2), sessionId: 's2b' });
    } finally { s.close(); }

    const result = cli.foldMeshDuplicates(home, { cwd: wtDup1, env: {}, backend: 'journal', deadline: Date.now() - 1 });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.budgetExhausted, true, 'the second group must be deferred by the deadline');
    assert.strictEqual(result.skipped, 1, 'exactly one group (the second) deferred');
    assert.strictEqual(result.folded, 1, 'only the FIRST group folded this pass');

    const s2 = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let rows;
    try { rows = s2.listRegistry().map((d) => d.id).sort(); } finally { s2.close(); }
    // The FIRST group's duplicate was folded away (one survivor left); the
    // SECOND group's duplicate is UNTOUCHED (deferred, not folded).
    assert.strictEqual(rows.filter((id) => id === 'dup1-live' || id === 'dup1-live-b').length, 1,
      'first group folded to one survivor');
    assert.strictEqual(rows.filter((id) => id === 'dup2-live' || id === 'dup2-live-b').length, 2,
      'second group deferred — both rows still present, untouched');
  } finally {
    rm(home);
    if (wtDup1) cp.spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', wtDup1]);
    if (wtDup2) cp.spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', wtDup2]);
    rm(repo);
  }
});

test('foldMeshDuplicates: no ctx.deadline set still folds every group (unchanged default behavior)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('foldnodl');
  let wtDup1 = null;
  let wtDup2 = null;
  try {
    wtDup1 = addLinkedWorktree(repo, 'foldnodl1');
    wtDup2 = addLinkedWorktree(repo, 'foldnodl2');
    const repoKey = repokey.repoKeyForWorktree(wtDup1);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      s.upsertRegistry({ id: 'dup1-live', worktreePath: topOf(wtDup1), sessionId: 's1a' });
      s.upsertRegistry({ id: 'dup1-live-b', worktreePath: topOf(wtDup1), sessionId: 's1b' });
      s.upsertRegistry({ id: 'dup2-live', worktreePath: topOf(wtDup2), sessionId: 's2a' });
      s.upsertRegistry({ id: 'dup2-live-b', worktreePath: topOf(wtDup2), sessionId: 's2b' });
    } finally { s.close(); }

    const result = cli.foldMeshDuplicates(home, { cwd: wtDup1, env: {}, backend: 'journal' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.budgetExhausted || false, false);
    assert.strictEqual(result.folded, 2, 'both groups fold when no deadline bounds this pass');
  } finally {
    rm(home);
    if (wtDup1) cp.spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', wtDup1]);
    if (wtDup2) cp.spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', wtDup2]);
    rm(repo);
  }
});
