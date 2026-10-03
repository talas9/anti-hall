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
// Deterministic fake clock — cmdReconcile accepts an injectable `ctx.reconcileNow`
// clock function (see devswarm.js resolveReconcileClock) used for BOTH the
// budget's start stamp and every per-iteration elapsed check, plus the
// reported `elapsedMs`. makeFakeClock() returns a `now()` reader and an
// `advance(ms)` mutator; driving `advance` from inside an injected
// `spawnReconcile` test double makes "a budget that allows exactly N
// children" exact BY CONSTRUCTION — no real sleep, no wall-clock race against
// a contended CI runner (root cause of the prior flake).
function makeFakeClock(startMs) {
  let t = startMs || 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
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
    const clock1 = makeFakeClock();
    const io = {
      spawnReconcile: (d) => {
        calls1.push(d.id);
        clock1.advance(30); // exact 30ms/call — with a 50ms budget, exactly 2 calls (60ms) trips it
        return { status: 0, stdout: JSON.stringify({ ok: true, imported: 0 }), error: null };
      },
    };
    const r1 = cli.run(['reconcile'], ctx(home, { cwd: repo, io, reconcileBudgetMs: 50, reconcileNow: clock1.now }));
    assert.strictEqual(r1.result.budgetMs, 50);
    assert.strictEqual(r1.result.processed, 2, 'exactly 2 children must have been spawned before the budget tripped: ' + JSON.stringify(r1.result));
    assert.strictEqual(r1.result.deferred, 3);
    assert.strictEqual(calls1.length, 2);
    assert.strictEqual(r1.result.results.length, 2, 'a deferred row must NOT appear in this run\'s results — it was never attempted');
    assert.strictEqual(r1.result.elapsedMs, 60, 'elapsedMs must be computed off the injected clock (2 calls x 30ms), not real wall-clock time');

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
    const clock2 = makeFakeClock();
    const r2 = cli.run(['reconcile'], ctx(home, { cwd: repo, io: io2, reconcileBudgetMs: 0, reconcileNow: clock2.now }));
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
    const clock = makeFakeClock();
    const io = {
      spawnReconcile: (d) => {
        clock.advance(20);
        return { status: 0, stdout: JSON.stringify({ ok: true, imported: 0 }), error: null };
      },
    };
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo, io, reconcileBudgetMs: 0, reconcileNow: clock.now }));
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

test('cmdReconcile: D11-C2 — the git-root probe itself counts against the budget and never runs once the deadline has already passed', () => {
  // Root cause: the git-root probe (repokey.defaultRun, a real bounded child
  // spawn up to ~10s per broken worktree — see devswarm-reconcile-gitroot.test.js)
  // ran UNCONDITIONALLY for every remaining target, with the budget check only
  // sitting right before spawnFn — AFTER the probe already executed. So N
  // broken worktrees each burned a full probe timeout while none of that wall
  // time counted as "budget spent" until the very end: a sweep could blow well
  // past budgetMs before the first deferral ever triggered. Monkey-patch
  // repokey.defaultRun (the same injectable-by-property primitive it already
  // exports) to simulate a 10s-per-call probe and always fail to resolve a
  // git root, so every attempted row lands in skippedNotGitRoot (zero-cost,
  // never reaching the real spawn) and only the probe's own advertised cost
  // shows up in the fake clock.
  const home = tmpHome();
  const repo = makeGitRepo('probe-budget');
  const dirs = ['r1', 'r2', 'r3', 'r4', 'r5'].map((tag) =>
    fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-reconcile-probe-' + tag + '-')));
  const origDefaultRun = repokey.defaultRun;
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const ids = ['a', 'b', 'c', 'd', 'e'];
    ids.forEach((id, i) => seedRegistry(home, repoKey, { id, worktreePath: dirs[i], sessionId: 's' }));

    const clock = makeFakeClock();
    let probeCalls = 0;
    repokey.defaultRun = () => {
      probeCalls++;
      clock.advance(10000); // each probe "takes" 10s, per the real GIT_SPAWN_TIMEOUT_MS ceiling
      return { ok: false, raw: '' }; // unresolved git root -> row is skipped, never reaches spawnFn
    };

    // No io.spawnReconcile injected: usingDefaultSpawn stays true so the real
    // pre-spawn git-root check (and the patched probe above) actually runs.
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo, reconcileBudgetMs: 25000, reconcileNow: clock.now }));

    assert.strictEqual(probeCalls, 3,
      'with a 25s budget and a 10s-per-call probe, at most 3 probes may run (30s) before the budget check ' +
      'defers the rest WITHOUT paying for their probes; a budget check placed only before spawnFn (the pre-fix ' +
      'shape) would let all 5 probes run — 50s of unbudgeted probe time — before the first deferral.');
    assert.strictEqual(r.result.skippedNotGitRoot, 3);
    assert.strictEqual(r.result.deferred, 2);
    assert.strictEqual(r.result.processed, 0, 'no row may reach the real spawn in this scenario');
  } finally {
    repokey.defaultRun = origDefaultRun;
    rm(home); rm(repo); dirs.forEach(rm);
  }
});

test('cmdReconcile: elapsedMs is a real, non-negative number in the output', () => {
  const home = tmpHome();
  const repo = makeGitRepo('elapsed');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'only', worktreePath: '/wt/only', sessionId: 's' });
    const clock = makeFakeClock();
    const io = { spawnReconcile: () => { clock.advance(7); return { status: 0, stdout: JSON.stringify({ ok: true, imported: 0 }), error: null }; } };
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo, io, reconcileNow: clock.now }));
    assert.strictEqual(typeof r.result.elapsedMs, 'number');
    assert.strictEqual(r.result.elapsedMs, 7, 'elapsedMs must reflect the injected clock deterministically');
  } finally { rm(home); rm(repo); }
});
