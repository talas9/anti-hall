'use strict';
// devswarm CLI (scripts/devswarm.js) — Wave D9 `reconcile` budget/resume/skip
// additions. Root cause (defect f3c1bc827d89, field-confirmed twice):
// cmdReconcile spawned one serial 30s-timeout child PER registry row with NO
// total budget/cap, so a project with dozens of stale rows made `update.js`
// (which awaits reconcile synchronously) hang for minutes with zero progress.
// These tests exercise the new total wall-clock budget, the resume-marker
// rotation across runs, and the pre-spawn missing-worktree skip — in-process
// via cli.run(argv, ctx) with an injected tmp HOME + forced journal backend,
// same posture as devswarm-lifecycle.test.js.

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-reconcile-budget-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-reconcile-budget-repo-' + tag + '-'));
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
function resumePath(home) {
  return path.join(home, '.anti-hall', 'devswarm', 'reconcile-resume.json');
}
// Deterministic synchronous busy-wait (no real spawn/timer) — same idiom as
// mcp-reaper.js's own sleepSync (Atomics.wait on a throwaway SharedArrayBuffer)
// so the injected `spawnReconcile` test double can make the total wall-clock
// budget check actually trip after a controlled number of calls.
function sleepSync(ms) {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

test('cmdReconcile: a budget that allows exactly 2 children defers the remaining 3, writes a resume marker, and the next run drains the deferred ids FIRST', () => {
  const home = tmpHome();
  const repo = makeGitRepo('budget');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const ids = ['a', 'b', 'c', 'd', 'e'];
    for (const id of ids) {
      seedRegistry(home, repoKey, { id, worktreePath: '/wt/' + id, sessionId: 's' });
    }
    const calls1 = [];
    const io = {
      spawnReconcile: (d) => {
        calls1.push(d.id);
        sleepSync(30); // ~30ms per call — with a 50ms budget, 2 calls (~60ms) exhausts it
        return { status: 0, stdout: JSON.stringify({ ok: true, imported: 0 }), error: null };
      },
    };
    const r1 = cli.run(['reconcile'], ctx(home, { cwd: repo, io, reconcileBudgetMs: 50 }));
    assert.strictEqual(r1.result.budgetMs, 50);
    assert.strictEqual(r1.result.processed, 2, 'exactly 2 children must have been spawned before the budget tripped: ' + JSON.stringify(r1.result));
    assert.strictEqual(r1.result.deferred, 3);
    assert.strictEqual(calls1.length, 2);
    assert.strictEqual(r1.result.results.length, 2, 'a deferred row must NOT appear in this run\'s results — it was never attempted');

    const resumeRaw = JSON.parse(fs.readFileSync(resumePath(home), 'utf8'));
    assert.strictEqual(resumeRaw.repoKey, repoKey);
    assert.strictEqual(resumeRaw.ids.length, 3);
    const deferredIdsRun1 = resumeRaw.ids.slice();
    const processedIdsRun1 = calls1.slice();
    assert.deepStrictEqual(new Set(deferredIdsRun1.concat(processedIdsRun1)), new Set(ids), 'every id must be accounted for as either processed or deferred');

    // Second run: unlimited budget (0) — the deferred ids from run 1 must be
    // rotated to the FRONT, so calls2's first 3 entries equal deferredIdsRun1
    // in that same order.
    const calls2 = [];
    const io2 = {
      spawnReconcile: (d) => {
        calls2.push(d.id);
        return { status: 0, stdout: JSON.stringify({ ok: true, imported: 0 }), error: null };
      },
    };
    const r2 = cli.run(['reconcile'], ctx(home, { cwd: repo, io: io2, reconcileBudgetMs: 0 }));
    assert.strictEqual(r2.result.deferred, 0, 'an unlimited (0) budget must never defer anything');
    assert.strictEqual(calls2.length, 5);
    assert.deepStrictEqual(calls2.slice(0, 3), deferredIdsRun1, 'the previously-deferred ids must be processed FIRST, in their deferred order (rotation)');
    assert.deepStrictEqual(calls2.slice(3), processedIdsRun1, 'the previously-processed ids follow, in their original order');

    // Fully drained: the resume marker must be removed, not left stale.
    assert.strictEqual(fs.existsSync(resumePath(home)), false, 'a fully-drained sweep must remove the resume marker');
  } finally { rm(home); rm(repo); }
});

test('cmdReconcile: budget 0 (unlimited) never defers, regardless of elapsed time', () => {
  const home = tmpHome();
  const repo = makeGitRepo('budget-unlimited');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'only', worktreePath: '/wt/only', sessionId: 's' });
    const io = {
      spawnReconcile: (d) => {
        sleepSync(20);
        return { status: 0, stdout: JSON.stringify({ ok: true, imported: 0 }), error: null };
      },
    };
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo, io, reconcileBudgetMs: 0 }));
    assert.strictEqual(r.result.deferred, 0);
    assert.strictEqual(r.result.processed, 1);
    assert.strictEqual(fs.existsSync(resumePath(home)), false);
  } finally { rm(home); rm(repo); }
});

test('cmdReconcile: a default budget applies when none is given (ANTIHALL_RECONCILE_BUDGET_MS unset, no ctx.reconcileBudgetMs)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('budget-default');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'only', worktreePath: '/wt/only', sessionId: 's' });
    const io = { spawnReconcile: () => ({ status: 0, stdout: JSON.stringify({ ok: true, imported: 0 }), error: null }) };
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo, io }));
    assert.strictEqual(r.result.budgetMs, 60000, 'the documented default (60s) must apply when nothing overrides it');
  } finally { rm(home); rm(repo); }
});

test('cmdReconcile: ANTIHALL_RECONCILE_BUDGET_MS env overrides the default', () => {
  const home = tmpHome();
  const repo = makeGitRepo('budget-env');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'only', worktreePath: '/wt/only', sessionId: 's' });
    const io = { spawnReconcile: () => ({ status: 0, stdout: JSON.stringify({ ok: true, imported: 0 }), error: null }) };
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo, io, env: { ANTIHALL_RECONCILE_BUDGET_MS: '5000' } }));
    assert.strictEqual(r.result.budgetMs, 5000);
  } finally { rm(home); rm(repo); }
});

test('cmdReconcile: a row whose worktreePath does not exist on disk is skipped BEFORE spawning (skippedMissingWorktree), costing zero budget', () => {
  const home = tmpHome();
  const repo = makeGitRepo('missing-worktree-presp');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const goneWorktree = path.join(os.tmpdir(), 'anti-hall-reconcile-budget-gone-' + Date.now());
    seedRegistry(home, repoKey, { id: 'gone', worktreePath: goneWorktree, sessionId: 's' });
    // No `io` injection: defaultSpawnReconcile is the real spawn function, so
    // the pre-spawn existsSync skip applies (see doc comment on cmdReconcile).
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo }));
    assert.strictEqual(r.result.ok, true);
    assert.strictEqual(r.result.skippedMissingWorktree, 1);
    assert.strictEqual(r.result.processed, 0, 'a pre-spawn-skipped row must not count toward `processed`');
    const row = r.result.results.find((x) => x.id === 'gone');
    assert.ok(row);
    assert.strictEqual(row.worktreeMissing, true);
  } finally { rm(home); rm(repo); }
});

test('cmdReconcile: elapsedMs is a real, non-negative number in the output', () => {
  const home = tmpHome();
  const repo = makeGitRepo('elapsed');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'only', worktreePath: '/wt/only', sessionId: 's' });
    const io = { spawnReconcile: () => ({ status: 0, stdout: JSON.stringify({ ok: true, imported: 0 }), error: null }) };
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo, io }));
    assert.strictEqual(typeof r.result.elapsedMs, 'number');
    assert.ok(r.result.elapsedMs >= 0);
  } finally { rm(home); rm(repo); }
});
