'use strict';
// devswarm CLI (scripts/devswarm.js) — v0.58 "mesh-only messaging" lifecycle
// wrappers: PLAN.md CLI VERB CONTRACT's `reconcile` / `spawn` / `merge`, plus
// the `roster` native-children FOLD. Exercised in-process via cli.run(argv, ctx)
// with an injected tmp HOME + forced journal backend (deterministic on every
// node version — 18/20 have no node:sqlite), and REAL git repos as `ctx.cwd`
// (repoKeyForWorktree/resolveMainWorktree spawn real git).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const liveness = require('../../plugins/anti-hall/companion/lib/liveness.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-lifecycle-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-lifecycle-repo-' + tag + '-'));
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
function fakeCwd(home) { return path.join(home, 'no-git-here'); }

// ============================================================================
// reconcile
// ============================================================================

test('reconcile on a non-git cwd returns {ok:false,reason:"no-project"}', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['reconcile'], ctx(home, { cwd: fakeCwd(home) }));
    assert.equal(r.result.ok, false);
    assert.equal(r.result.reason, 'no-project');
  } finally { rm(home); }
});

test('reconcile drains every registered worktree via a per-id subprocess spawn, skips descriptors with no worktreePath, and sums imported', () => {
  const home = tmpHome();
  const repo = makeGitRepo('reconcile-unit');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'child-a', worktreePath: '/wt/a', sessionId: 's' });
    seedRegistry(home, repoKey, { id: 'child-b', worktreePath: '/wt/b', sessionId: 's' });
    seedRegistry(home, repoKey, { id: 'no-worktree', worktreePath: null, sessionId: 's' });
    const calls = [];
    const io = {
      spawnReconcile: (d) => {
        calls.push({ id: d.id, worktreePath: d.worktreePath });
        const payload = d.id === 'child-a' ? { ok: true, imported: 3, duplicate: 1 } : { ok: true, imported: 2, duplicate: 0 };
        return { status: 0, stdout: JSON.stringify(payload), error: null };
      },
    };
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo, io }));
    assert.equal(r.result.ok, true);
    assert.equal(r.result.count, 2, 'only worktree-bearing descriptors are targeted');
    assert.equal(r.result.imported, 5);
    assert.deepEqual(calls.map((c) => c.id).sort(), ['child-a', 'child-b']);
    const rowA = r.result.results.find((x) => x.id === 'child-a');
    assert.equal(rowA.ok, true);
    assert.equal(rowA.imported, 3);
    assert.equal(rowA.duplicate, 1);
  } finally { rm(home); rm(repo); }
});

test('reconcile surfaces a per-id lock-skip (locked:true, imported:0) rather than counting it as drained', () => {
  const home = tmpHome();
  const repo = makeGitRepo('reconcile-locked');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'child-locked', worktreePath: '/wt/locked', sessionId: 's' });
    // FAITHFUL stand-in for pullOnce's REAL genuine-contention shape
    // (devswarm-pull.js pullOnce, `!release` branch): `{ok:false, locked:false,
    // error:'another pull holds the lock'}` — `locked:false` means "did NOT
    // acquire, another consumer holds it" (same polarity as migrate-state.js's
    // `ds.locked===false` convention). pullOnce can NEVER emit `locked:true`
    // together with this error string (locked:true only appears once the lock
    // WAS acquired) — a `{locked:true, error:'another pull holds the lock'}`
    // fixture (the pre-fix version of this test) is an IMPOSSIBLE combination
    // the real code path never produces, making that assertion vacuous.
    const io = {
      spawnReconcile: () => ({
        status: 2, stdout: JSON.stringify({ ok: false, locked: false, error: 'another pull holds the lock' }), error: null,
      }),
    };
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo, io }));
    assert.equal(r.result.ok, true, 'reconcile itself still succeeds even when one target is lock-skipped');
    assert.equal(r.result.imported, 0);
    // cmdReconcile's OWN `locked` flag is recomputed with the intuitive polarity
    // (true = genuine contention detected), NOT a blind pass-through of the
    // subprocess's `locked` field.
    assert.equal(r.result.results[0].locked, true);
    assert.equal(r.result.results[0].ok, false);
    // P1 fix: benign contention must NEVER read as a loss — `lost` stays 0 both
    // per-target and in the aggregate.
    assert.equal(r.result.lost, 0, 'a merely-locked (contended) target is not a loss');
    assert.equal(r.result.results[0].lost, 0);
  } finally { rm(home); rm(repo); }
});

// P1 fix (v0.58.1): cmdReconcile used to copy only ok/imported/duplicate/locked/error
// from each per-target subprocess result — DROPPING `lost` and `nativeCount` entirely
// — and then ALWAYS returned aggregate ok:true regardless of what any target actually
// reported. A lossy child pull (pullOnce's real shortfall shape, devswarm-pull.js
// ~line 299: `{ok:false, locked:true, nativeCount:2, lost:2}`) therefore vanished
// without a trace: the aggregate said ok:true, the per-target row said ok:false with
// no `lost` field anywhere — the single worst failure mode for a substrate whose
// whole job is "never silently lose a message". This test reproduces that EXACT
// subprocess payload and proves it survives all the way to the top.
test('reconcile: a target that reports a REAL message loss (lost>0, pullOnce shortfall shape) is NEVER swallowed — aggregate ok:false, lost/nativeCount surfaced per-target AND summed at the top', () => {
  const home = tmpHome();
  const repo = makeGitRepo('reconcile-lossy');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'child-lossy', worktreePath: '/wt/lossy', sessionId: 's' });
    seedRegistry(home, repoKey, { id: 'child-clean', worktreePath: '/wt/clean', sessionId: 's' });
    const io = {
      spawnReconcile: (d) => {
        if (d.id === 'child-lossy') {
          // The REAL shape pullOnce/`inbox pull` emits on a genuine shortfall
          // (devswarm-pull.js's reconciliation check, ~line 299-306).
          return { status: 2, stdout: JSON.stringify({ ok: false, locked: true, imported: 0, duplicate: 0, nativeCount: 2, lost: 2 }), error: null };
        }
        return { status: 0, stdout: JSON.stringify({ ok: true, imported: 1, duplicate: 0, nativeCount: 1, locked: true, lost: 0 }), error: null };
      },
    };
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo, io }));
    assert.equal(r.result.ok, false, 'aggregate ok MUST be false when ANY target lost messages — this is the exact P1: pre-fix it was hardcoded true');
    assert.equal(r.result.lost, 2, 'the aggregate must surface the SUMMED loss, not silently drop it');
    const lossy = r.result.results.find((x) => x.id === 'child-lossy');
    assert.ok(lossy, 'the lossy target must still appear in the per-target results');
    assert.equal(lossy.lost, 2, 'per-target lost must be propagated from the subprocess JSON, not dropped');
    assert.equal(lossy.nativeCount, 2, 'per-target nativeCount must be propagated from the subprocess JSON, not dropped');
    assert.equal(lossy.ok, false);
    const clean = r.result.results.find((x) => x.id === 'child-clean');
    assert.equal(clean.lost, 0, 'a clean target reports lost:0, never contaminated by a sibling loss');
    assert.equal(clean.ok, true);
    // imported still sums correctly across both targets (unrelated to the loss fix).
    assert.equal(r.result.imported, 1);
  } finally { rm(home); rm(repo); }
});

test('reconcile does NOT flag a non-contention hard failure (e.g. message-count spawn error) as locked', () => {
  const home = tmpHome();
  const repo = makeGitRepo('reconcile-hardfail');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'child-hardfail', worktreePath: '/wt/hardfail', sessionId: 's' });
    // A real post-acquire failure (e.g. message-count failed) reports
    // locked:true (the lock WAS acquired) per pullOnce's own contract — this
    // must NOT be confused with genuine lock contention.
    const io = {
      spawnReconcile: () => ({
        status: 2, stdout: JSON.stringify({ ok: false, locked: true, error: 'message-count failed' }), error: null,
      }),
    };
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo, io }));
    assert.equal(r.result.results[0].ok, false);
    assert.equal(r.result.results[0].locked, false, 'a hard failure after successfully acquiring the lock is not contention');
  } finally { rm(home); rm(repo); }
});

test('reconcile is idempotent on re-run: a second sweep against an already-drained queue reports zero new imports', () => {
  const home = tmpHome();
  const repo = makeGitRepo('reconcile-idempotent');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'child-x', worktreePath: '/wt/x', sessionId: 's' });
    let call = 0;
    const io = {
      spawnReconcile: () => {
        call += 1;
        const imported = call === 1 ? 4 : 0;
        return { status: 0, stdout: JSON.stringify({ ok: true, imported, duplicate: 0 }), error: null };
      },
    };
    const first = cli.run(['reconcile'], ctx(home, { cwd: repo, io }));
    const second = cli.run(['reconcile'], ctx(home, { cwd: repo, io }));
    assert.equal(first.result.ok, true);
    assert.equal(first.result.imported, 4);
    assert.equal(second.result.ok, true);
    assert.equal(second.result.imported, 0, 're-running reconcile against an already-drained queue imports nothing new');
  } finally { rm(home); rm(repo); }
});

test('reconcile spawns a REAL subprocess per worktree (default path, no injection) with cwd=worktreePath — valid JSON envelope, no crash', () => {
  const home = tmpHome();
  const repo = makeGitRepo('reconcile-real-subprocess');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'child-real', worktreePath: repo, sessionId: 's' });
    // A REAL environment (never {}) so the spawned node subprocess starts
    // cleanly on every platform (an empty env can break a real Node child
    // process on Windows, e.g. missing SystemRoot) — this test proves the
    // SUBPROCESS PLUMBING (spawn args/cwd), not native hivecontrol behavior.
    const r = cli.run(['reconcile'], ctx(home, { cwd: repo, env: process.env }));
    assert.equal(r.result.ok, true);
    assert.equal(r.result.count, 1);
    assert.equal(r.result.results[0].id, 'child-real');
    assert.equal(r.result.results[0].worktreePath, repo);
    assert.equal(typeof r.result.results[0].ok, 'boolean', 'the subprocess ran to completion and emitted a parseable JSON envelope');
  } finally { rm(home); rm(repo); }
});

// ============================================================================
// spawn
// ============================================================================

test('spawn requires a branch name', () => {
  const home = tmpHome();
  const repo = makeGitRepo('spawn-nobranch');
  try {
    const r = cli.run(['spawn'], ctx(home, { cwd: repo, io: { run: () => { throw new Error('must not spawn'); } } }));
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /branch/);
  } finally { rm(home); rm(repo); }
});

test('spawn is a THIN pass-through: every token after the branch forwards to `hivecontrol workspace create` untouched, including short flags', () => {
  const home = tmpHome();
  const repo = makeGitRepo('spawn-passthrough');
  try {
    const calls = [];
    const io = { run: (spec) => { calls.push(spec); return { ok: true, raw: '{}' }; } };
    const r = cli.run(['spawn', 'my-branch', '-p', 'do the thing', '-a', 'claude'], ctx(home, { cwd: repo, io }));
    assert.equal(r.result.ok, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['workspace', 'create', 'my-branch', '-p', 'do the thing', '-a', 'claude']);
  } finally { rm(home); rm(repo); }
});

test('spawn never re-parses or gates hivecontrol\'s own flags — an unrecognized/future flag still forwards verbatim', () => {
  const home = tmpHome();
  const repo = makeGitRepo('spawn-future-flag');
  try {
    const calls = [];
    const io = { run: (spec) => { calls.push(spec); return { ok: true, raw: '{}' }; } };
    const r = cli.run(['spawn', 'br', '--some-future-hivecontrol-flag', 'value'], ctx(home, { cwd: repo, io }));
    assert.equal(r.result.ok, true);
    assert.deepEqual(calls[0].args, ['workspace', 'create', 'br', '--some-future-hivecontrol-flag', 'value']);
  } finally { rm(home); rm(repo); }
});

test('spawn surfaces a hivecontrol create failure as-is (never re-implements the outcome)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('spawn-fails');
  try {
    const io = { run: () => ({ ok: false, error: 'workspace already exists' }) };
    const r = cli.run(['spawn', 'dup-branch'], ctx(home, { cwd: repo, io }));
    assert.equal(r.code, 2);
    assert.equal(r.result.ok, false);
    assert.equal(r.result.error, 'workspace already exists');
  } finally { rm(home); rm(repo); }
});

test('spawn auto-registers the new worktree in the store when create\'s own JSON output carries a resolvable path', () => {
  const home = tmpHome();
  const repo = makeGitRepo('spawn-autoregister');
  try {
    const newWt = path.join(os.tmpdir(), 'never-exists-spawned-' + Date.now());
    const io = { run: () => ({ ok: true, raw: JSON.stringify({ branch: 'feature/x', path: newWt }) }) };
    const r = cli.run(['spawn', 'feature/x'], ctx(home, { cwd: repo, io }));
    assert.equal(r.result.ok, true);
    assert.equal(r.result.registered, true);
    assert.equal(r.result.worktreePath, newWt);
    const expectedMeshId = inst.primaryWorkspaceId(newWt);
    assert.equal(r.result.meshId, expectedMeshId);

    const repoKey = repokey.repoKeyForWorktree(repo);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const found = s.listRegistry().find((d) => d.id === expectedMeshId);
      assert.ok(found, 'the new worktree must be registered in the shared store');
      assert.equal(found.worktreePath, newWt);
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('spawn best-effort-skips registration (never fails the verb) when create\'s output carries no resolvable path', () => {
  const home = tmpHome();
  const repo = makeGitRepo('spawn-noregister');
  try {
    const io = { run: () => ({ ok: true, raw: 'not json at all' }) };
    const r = cli.run(['spawn', 'feature/y'], ctx(home, { cwd: repo, io }));
    assert.equal(r.result.ok, true, 'the create call itself succeeded — spawn never fails just because registration was skipped');
    assert.equal(r.result.registered, false);
    assert.equal(r.result.worktreePath, null);
  } finally { rm(home); rm(repo); }
});

// ============================================================================
// merge
// ============================================================================

test('merge runs check-merge THEN merge-into-source, forwarding <args> to merge-into-source untouched', () => {
  const home = tmpHome();
  const repo = makeGitRepo('merge-order');
  try {
    const calls = [];
    const io = {
      run: (spec) => {
        calls.push(spec.args);
        if (spec.args[1] === 'check-merge') return { ok: true, raw: JSON.stringify({ isMergeable: true, hasConflicts: false }) };
        return { ok: true, raw: '{}' };
      },
    };
    const r = cli.run(['merge', '--some-flag'], ctx(home, { cwd: repo, io }));
    assert.equal(r.result.ok, true);
    assert.equal(r.result.merged, true);
    assert.deepEqual(r.result.checkMerge, { isMergeable: true, hasConflicts: false });
    assert.equal(calls.length, 2, 'check-merge then merge-into-source');
    assert.deepEqual(calls[0], ['workspace', 'check-merge']);
    assert.deepEqual(calls[1], ['workspace', 'merge-into-source', '--some-flag']);
  } finally { rm(home); rm(repo); }
});

test('merge broadcasts a success summary to the mesh', () => {
  const home = tmpHome();
  const repo = makeGitRepo('merge-broadcast-ok');
  try {
    const io = { run: (spec) => ({ ok: true, raw: spec.args[1] === 'check-merge' ? JSON.stringify({ isMergeable: true }) : '{}' }) };
    const r = cli.run(['merge'], ctx(home, { cwd: repo, io }));
    assert.equal(r.result.ok, true);
    assert.equal(r.result.broadcast.ok, true);
    assert.equal(r.result.broadcast.sent, true);

    const repoKey = repokey.repoKeyForWorktree(repo);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const all = s.listMessages(storeLib.BROADCAST_PARTITION_ID);
      assert.equal(all.length, 1);
      assert.match(all[0].body, /merge-into-source completed/);
      assert.equal(all[0].urgency, 'normal');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('merge never gates on check-merge\'s own verdict — a hasConflicts:true report still attempts merge-into-source and broadcasts a high-urgency failure summary', () => {
  const home = tmpHome();
  const repo = makeGitRepo('merge-conflicts');
  try {
    const calls = [];
    const io = {
      run: (spec) => {
        calls.push(spec.args[1]);
        if (spec.args[1] === 'check-merge') return { ok: true, raw: JSON.stringify({ isMergeable: false, hasConflicts: true }) };
        return { ok: false, error: 'CONFLICT: merge failed' };
      },
    };
    const r = cli.run(['merge'], ctx(home, { cwd: repo, io }));
    assert.deepEqual(calls, ['check-merge', 'merge-into-source'], 'merge-into-source is still attempted despite hasConflicts:true');
    assert.equal(r.result.ok, false);
    assert.equal(r.result.merged, false);
    assert.match(r.result.error, /CONFLICT/);

    const repoKey = repokey.repoKeyForWorktree(repo);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const all = s.listMessages(storeLib.BROADCAST_PARTITION_ID);
      assert.equal(all.length, 1);
      assert.match(all[0].body, /merge-into-source failed/);
      assert.equal(all[0].urgency, 'high');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

// ============================================================================
// roster fold (v0.58: union `hivecontrol workspace list children`, read-only)
// ============================================================================

test('roster folds an unmatched native child (never registered with the store) into the projection as a minimal, read-only entry', () => {
  const home = tmpHome();
  const repo = makeGitRepo('roster-fold-unmatched');
  try {
    const io = {
      run: (spec) => {
        if (spec.args[1] === 'list' && spec.args[2] === 'children') {
          return { ok: true, raw: JSON.stringify([{ branch: 'feature/never-registered', path: '/wt/never-registered' }]) };
        }
        return { ok: true, raw: '{}' };
      },
    };
    const r = cli.run(['roster'], ctx(home, { cwd: repo, io }));
    assert.equal(r.result.ok, true);
    const row = r.result.workspaces.find((w) => w.id === 'feature/never-registered');
    assert.ok(row, 'the native-only child must be visible on the roster');
    assert.equal(row.source, 'native');
    assert.equal(row.worktreePath, '/wt/never-registered');
    assert.equal(row.directUnread, null);
  } finally { rm(home); rm(repo); }
});

test('roster does NOT duplicate a native child whose worktreePath already matches a store-registered entry', () => {
  const home = tmpHome();
  const repo = makeGitRepo('roster-fold-matched');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'child-known', worktreePath: '/wt/known', sessionId: 's' });
    const io = {
      run: (spec) => {
        if (spec.args[1] === 'list' && spec.args[2] === 'children') {
          return { ok: true, raw: JSON.stringify([{ branch: 'child-known-branch', path: '/wt/known' }]) };
        }
        return { ok: true, raw: '{}' };
      },
    };
    const r = cli.run(['roster'], ctx(home, { cwd: repo, io }));
    assert.equal(r.result.ok, true);
    const matches = r.result.workspaces.filter((w) => w.worktreePath === '/wt/known');
    assert.equal(matches.length, 1, 'a native child already represented via the store must not be duplicated');
    assert.equal(matches[0].source, 'store');
    assert.equal(matches[0].id, 'child-known');
  } finally { rm(home); rm(repo); }
});

// P2-2: cmdRoster used to dedup the native `list children` fold against the
// store registry by EXACT STRING equality on worktreePath — the same bug class
// as resolvePrimaryTarget's alias bug (see devswarm-send.test.js's `send
// --to-primary ... differently-SPELLED alias` test). Two different spellings of
// the SAME real directory (e.g. a raw `--show-toplevel` path vs a symlinked
// alias of it) therefore failed to dedup, producing a duplicate roster row for
// one real workspace. Reproduced portably (works on every CI platform, not just
// win32's short/long-name divergence) via a plain filesystem symlink, exactly
// like the send --to-primary alias test does.
test('roster dedups a native child against a store entry for the SAME real worktree even when the two spellings differ (symlink alias)', () => {
  const home = tmpHome();
  const mainRepo = makeGitRepo('roster-fold-alias');
  let alias = null;
  try {
    alias = mainRepo + '-alias';
    fs.symlinkSync(mainRepo, alias, 'dir');

    const repoKey = repokey.repoKeyForWorktree(mainRepo);
    // Store registry holds the REAL (non-aliased) spelling.
    seedRegistry(home, repoKey, { id: 'child-real', worktreePath: mainRepo, sessionId: 's' });
    const io = {
      run: (spec) => {
        if (spec.args[1] === 'list' && spec.args[2] === 'children') {
          // Native fold reports the ALIAS spelling of the identical real directory.
          return { ok: true, raw: JSON.stringify([{ branch: 'child-real-branch', path: alias }]) };
        }
        return { ok: true, raw: '{}' };
      },
    };
    const r = cli.run(['roster'], ctx(home, { cwd: mainRepo, io }));
    assert.equal(r.result.ok, true);
    const realId = inst.primaryWorkspaceId(mainRepo);
    const aliasId = inst.primaryWorkspaceId(alias);
    assert.equal(realId, aliasId, 'sanity: the alias must canonicalize to the SAME identity as the real path');
    const matches = r.result.workspaces.filter((w) => inst.primaryWorkspaceId(w.worktreePath) === realId);
    assert.equal(matches.length, 1, 'a native child spelled differently from its store entry must not produce a duplicate row');
    assert.equal(matches[0].source, 'store');
    assert.equal(matches[0].id, 'child-real');
  } finally { rm(home); rm(mainRepo); if (alias) rm(alias); }
});

test('roster fold fails open: a native `list children` spawn error never breaks or degrades the store-only projection', () => {
  const home = tmpHome();
  const repo = makeGitRepo('roster-fold-failopen');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'child-only', worktreePath: '/wt/only', sessionId: 's' });
    const io = { run: () => { throw new Error('hivecontrol not installed'); } };
    const r = cli.run(['roster'], ctx(home, { cwd: repo, io }));
    assert.equal(r.result.ok, true);
    assert.equal(r.result.workspaces.length, 1);
    assert.equal(r.result.workspaces[0].id, 'child-only');
  } finally { rm(home); rm(repo); }
});

// ============================================================================
// FEATURE 3: roster archive-candidate surfacing (read-only hints + archived/
// dir listing). No new heavy work, no subprocess beyond what cmdRoster
// already does; nothing is written back — the `archive`/`unarchive` verbs
// remain the only mutators.
// ============================================================================

test('roster hints a row `worktree-gone` when the descriptor worktreePath no longer exists on disk', () => {
  const home = tmpHome();
  const repo = makeGitRepo('roster-hint-gone');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const goneDir = path.join(os.tmpdir(), 'anti-hall-does-not-exist-' + Date.now());
    seedRegistry(home, repoKey, { id: 'child-gone', worktreePath: goneDir, sessionId: 's' });
    const io = { run: () => { throw new Error('hivecontrol not installed'); } };
    const r = cli.run(['roster'], ctx(home, { cwd: repo, io }));
    assert.equal(r.result.ok, true);
    const row = r.result.workspaces.find((w) => w.id === 'child-gone');
    assert.ok(row, 'row must be present');
    assert.ok(row.hints.includes('worktree-gone'), 'a missing worktreePath must be hinted');
  } finally { rm(home); rm(repo); }
});

test('roster does NOT hint `worktree-gone` when the worktreePath still exists on disk', () => {
  const home = tmpHome();
  const repo = makeGitRepo('roster-hint-present');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'child-live', worktreePath: repo, sessionId: 's' });
    const io = { run: () => { throw new Error('hivecontrol not installed'); } };
    const r = cli.run(['roster'], ctx(home, { cwd: repo, io }));
    const row = r.result.workspaces.find((w) => w.id === 'child-live');
    assert.ok(row);
    assert.ok(!row.hints.includes('worktree-gone'), 'an existing worktreePath must not be flagged');
  } finally { rm(home); rm(repo); }
});

test('roster hints `idle Nd` from the persisted liveness verdict\'s lastOutboundTs (read-only reuse, no new computation)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('roster-hint-idle');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'child-idle', worktreePath: repo, sessionId: 's' });
    const now = Date.now();
    const threeDaysAgo = now - 3 * 86400000;
    liveness.writeVerdict('child-idle', { status: 'stale', lastOutboundTs: threeDaysAgo }, home);
    const io = { run: () => { throw new Error('hivecontrol not installed'); } };
    const r = cli.run(['roster'], ctx(home, { cwd: repo, io, now }));
    const row = r.result.workspaces.find((w) => w.id === 'child-idle');
    assert.ok(row);
    assert.ok(row.hints.includes('idle 3d'), 'expected an idle-days hint derived from lastOutboundTs, got: ' + JSON.stringify(row.hints));
  } finally { rm(home); rm(repo); }
});

test('roster lists an already-archived id (read-only archived/ dir scan) labeled [archived], never folding it back into the live projection', () => {
  const home = tmpHome();
  const repo = makeGitRepo('roster-archived-scan');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'child-live', worktreePath: repo, sessionId: 's' });
    // Simulate a prior `archive <id>` run: a descriptor moved into archived/,
    // with no store registry row for it (cmdArchive's own real end-state).
    fs.mkdirSync(cli.archivedDir(home), { recursive: true });
    fs.writeFileSync(path.join(cli.archivedDir(home), 'child-archived.json'),
      JSON.stringify({ id: 'child-archived', worktreePath: '/wt/gone', sessionId: 's', ownerKey: repoKey }));
    const io = { run: () => { throw new Error('hivecontrol not installed'); } };
    const r = cli.run(['roster'], ctx(home, { cwd: repo, io }));
    assert.equal(r.result.ok, true);
    const archivedRow = r.result.workspaces.find((w) => w.id === 'child-archived');
    assert.ok(archivedRow, 'an archived id must still be visible on the roster');
    assert.equal(archivedRow.source, 'archived');
    assert.ok(archivedRow.hints.includes('archived'));
    // never re-registered / written back into the store registry itself
    // (only the roster's OUTPUT array is annotated -- the read stays pure).
    const s2 = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let sum;
    try { sum = storeLib.computeSummary(s2, { home }); } finally { s2.close(); }
    assert.ok(!sum.workspaces || !sum.workspaces['child-archived'],
      'roster must never write an archived id back into the store registry');
  } finally { rm(home); rm(repo); }
});

test('roster archived-dir scan fails open when archived/ does not exist at all', () => {
  const home = tmpHome();
  const repo = makeGitRepo('roster-archived-absent');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    seedRegistry(home, repoKey, { id: 'child-live', worktreePath: repo, sessionId: 's' });
    assert.equal(fs.existsSync(cli.archivedDir(home)), false);
    const io = { run: () => { throw new Error('hivecontrol not installed'); } };
    const r = cli.run(['roster'], ctx(home, { cwd: repo, io }));
    assert.equal(r.result.ok, true);
    assert.equal(r.result.workspaces.length, 1);
  } finally { rm(home); rm(repo); }
});

// ============================================================================
// FIX 2 (Task 5): parent-driven reap + reconcile-active. Both are CONFIRM-FIRST
// (dry-run by default, --yes to apply), project-scoped, and reuse cmdArchive's
// proven move+tombstone. reap-stale must NEVER archive a fresh-heartbeat or a
// live-worktree+recent-activity workspace.
// FIX 3 (Task 6): a heartbeat CLEARS the persisted stale verdict (CLI level).
// ============================================================================

function regWs(home, repo, id, worktree) {
  return cli.run(['register', id, '--worktree', worktree, '--session', 's'], ctx(home, { cwd: repo }));
}
function writeHeartbeatFile(home, id, ts) {
  fs.mkdirSync(cli.heartbeatsDir(home), { recursive: true });
  fs.writeFileSync(path.join(cli.heartbeatsDir(home), id + '.json'), JSON.stringify({ id, ts }));
}

test('FIX 2: reap-stale dry-run lists stale-no-heartbeat workspaces only; a fresh-heartbeat stale workspace is skipped', () => {
  const home = tmpHome();
  const repo = makeGitRepo('reap-dry');
  try {
    const now = Date.now();
    regWs(home, repo, 'ws-stale', '/wt/stale');   // nonexistent worktree -> no recent activity
    regWs(home, repo, 'ws-fresh', '/wt/fresh');
    regWs(home, repo, 'ws-alive', '/wt/alive');
    liveness.writeVerdict('ws-stale', { status: 'stale', lastOutboundTs: 5 }, home);
    liveness.writeVerdict('ws-fresh', { status: 'stale', lastOutboundTs: 5 }, home);
    liveness.writeVerdict('ws-alive', { status: 'alive', lastOutboundTs: now }, home);
    writeHeartbeatFile(home, 'ws-fresh', now - 30 * 1000); // fresh -> proof of life
    const r = cli.run(['reap-stale'], ctx(home, { cwd: repo, now }));
    assert.equal(r.result.ok, true);
    assert.equal(r.result.dryRun, true);
    assert.deepEqual(r.result.candidates.map((c) => c.id), ['ws-stale']);
    assert.ok(r.result.skipped.some((s) => s.id === 'ws-fresh' && s.reason === 'fresh-heartbeat'),
      'a fresh-heartbeat stale workspace must be skipped, not reaped');
    // dry-run must NOT have archived anything
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'ws-stale')), true, 'dry-run must not move the descriptor');
  } finally { rm(home); rm(repo); }
});

test('FIX 2: reap-stale --yes archives the stale-no-heartbeat workspace and NEVER the fresh-heartbeat one', () => {
  const home = tmpHome();
  const repo = makeGitRepo('reap-apply');
  try {
    const now = Date.now();
    regWs(home, repo, 'ws-stale', '/wt/stale');
    regWs(home, repo, 'ws-fresh', '/wt/fresh');
    liveness.writeVerdict('ws-stale', { status: 'stale', lastOutboundTs: 5 }, home);
    liveness.writeVerdict('ws-fresh', { status: 'escalated', lastOutboundTs: 5 }, home);
    writeHeartbeatFile(home, 'ws-fresh', now - 30 * 1000);
    const r = cli.run(['reap-stale', '--yes'], ctx(home, { cwd: repo, now }));
    assert.equal(r.result.ok, true);
    assert.equal(r.result.dryRun, false);
    assert.deepEqual(r.result.archived.map((a) => a.id), ['ws-stale']);
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'ws-stale')), false, 'ws-stale descriptor must be moved out of workspaces/');
    assert.equal(fs.existsSync(path.join(cli.archivedDir(home), 'ws-stale.json')), true);
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'ws-fresh')), true, 'a fresh-heartbeat workspace must NEVER be reaped');
  } finally { rm(home); rm(repo); }
});

test('FIX 2: reap-stale on a non-git cwd returns no-project (project scoped)', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['reap-stale'], ctx(home, { cwd: fakeCwd(home) }));
    assert.equal(r.result.ok, false);
    assert.equal(r.result.reason, 'no-project');
  } finally { rm(home); }
});

test('FIX 2: reconcile-active dry-run archives only ids OUTSIDE the active set, never one inside it', () => {
  const home = tmpHome();
  const repo = makeGitRepo('reconcile-active-dry');
  try {
    regWs(home, repo, 'ws-a', '/wt/a');
    regWs(home, repo, 'ws-b', '/wt/b');
    regWs(home, repo, 'ws-c', '/wt/c');
    const r = cli.run(['reconcile-active', '--active', 'ws-a,ws-b'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true);
    assert.equal(r.result.dryRun, true);
    assert.deepEqual(r.result.candidates.map((c) => c.id).sort(), ['ws-c']);
    assert.deepEqual(r.result.kept.sort(), ['ws-a', 'ws-b']);
  } finally { rm(home); rm(repo); }
});

test('FIX 2: reconcile-active --yes archives only the non-active workspace; active ones are untouched', () => {
  const home = tmpHome();
  const repo = makeGitRepo('reconcile-active-apply');
  try {
    regWs(home, repo, 'ws-a', '/wt/a');
    regWs(home, repo, 'ws-b', '/wt/b');
    regWs(home, repo, 'ws-c', '/wt/c');
    const r = cli.run(['reconcile-active', '--active', 'ws-a', '--active', 'ws-b', '--yes'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true);
    assert.deepEqual(r.result.archived.map((a) => a.id), ['ws-c']);
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'ws-c')), false, 'the non-active workspace must be archived');
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'ws-a')), true, 'an active workspace must NEVER be archived');
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'ws-b')), true, 'an active workspace must NEVER be archived');
  } finally { rm(home); rm(repo); }
});

test('FIX 2: reconcile-active matches an active id by SHORT PREFIX (spares it), never archiving a prefixed active workspace', () => {
  const home = tmpHome();
  const repo = makeGitRepo('reconcile-active-prefix');
  try {
    regWs(home, repo, 'ws-keepme', '/wt/keep');
    regWs(home, repo, 'ws-dropme', '/wt/drop');
    // supply only a short prefix of the id we want to KEEP
    const r = cli.run(['reconcile-active', '--active', 'ws-keep', '--yes'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true);
    assert.deepEqual(r.result.archived.map((a) => a.id), ['ws-dropme']);
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'ws-keepme')), true, 'a prefix-matched active workspace must be spared');
  } finally { rm(home); rm(repo); }
});

test('FIX 2: reconcile-active REFUSES an empty active set unless --allow-empty (no accidental archive-everything)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('reconcile-active-empty');
  try {
    regWs(home, repo, 'ws-a', '/wt/a');
    const r = cli.run(['reconcile-active'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /non-empty --active/);
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'ws-a')), true, 'nothing must be archived on a refused empty set');
  } finally { rm(home); rm(repo); }
});

test('FIX 3: a heartbeat CLEARS a persisted stale verdict -> the workspace reads active (CLI level)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('hb-clears');
  try {
    const now = Date.now();
    regWs(home, repo, 'ws-hb', '/wt/hb');
    liveness.writeVerdict('ws-hb', { status: 'stale', lastOutboundTs: 5, staleSince: 5, nudgeAttempts: 2 }, home);
    const r = cli.run(['heartbeat', 'ws-hb'], ctx(home, { cwd: repo, now }));
    assert.equal(r.result.ok, true);
    const v = JSON.parse(fs.readFileSync(liveness.livenessPathFor('ws-hb', home), 'utf8'));
    assert.equal(v.status, 'alive', 'a heartbeat must clear the stale verdict to alive');
    assert.equal(v.staleSince, null);
    assert.equal(v.nudgeAttempts, 0, 'the nudge budget is reset by proof-of-life');
  } finally { rm(home); rm(repo); }
});

// ============================================================================
// FIX WAVE: P1-3 / P1-5 / P1-6 / P2-9 (P1-1/P1-2 covered in devswarm-send.test.js;
// P1-7 in tests/companion/liveness.test.js)
// ============================================================================

// P1-6: register --worktree pointing into a DIFFERENT git project than the
// invoking cwd is REFUSED (both repo keys resolve and differ) — otherwise repoA
// could register repoB's descriptor with ownerKey=A and later reap/reconcile
// repoB out from under it.
test('P1-6: cross-project register --worktree (repoB from repoA cwd) is rejected', () => {
  const home = tmpHome();
  const repoA = makeGitRepo('xproj-a');
  const repoB = makeGitRepo('xproj-b');
  try {
    const r = cli.run(['register', 'ws-x', '--worktree', repoB, '--session', 's'], ctx(home, { cwd: repoA }));
    assert.equal(r.result.ok, false, 'a cross-project register must be refused');
    assert.match(r.result.error, /different project|cross-project/);
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'ws-x')), false, 'no descriptor may be written on a refused cross-project register');
  } finally { rm(home); rm(repoA); rm(repoB); }
});

test('P1-6: register --worktree of the SAME project as cwd is still accepted', () => {
  const home = tmpHome();
  const repo = makeGitRepo('xproj-same');
  try {
    const r = cli.run(['register', 'ws-same', '--worktree', repo, '--session', 's'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, 'same-project register must still work');
  } finally { rm(home); rm(repo); }
});

// P1-3: a tombstone-write failure mid-archive (simulated ENOSPC — the summary
// path is a directory so deriveSummary's atomic rename fails) must ROLL BACK:
// the active descriptor stays, and the registry row is revived (all-or-nothing).
test('P1-3: archive rolls back on a tombstone-write failure — descriptor + registry left intact', () => {
  const home = tmpHome();
  const repo = makeGitRepo('archive-rollback');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const reg = cli.run(['register', 'ws-roll', '--worktree', repo, '--session', 's'], ctx(home, { cwd: repo }));
    assert.equal(reg.result.ok, true);
    assert.equal(reg.result.descriptor.ownerKey, repoKey);
    // Sabotage the summary write path: replace summaries/<repoKey>.json with a
    // NON-EMPTY directory so deriveSummary's rename-onto-target fails (portable
    // stand-in for the ENOSPC this machine actually hit).
    const sumPath = storeLib.summaryPathForHash(home, repoKey);
    fs.mkdirSync(path.dirname(sumPath), { recursive: true });
    try { fs.rmSync(sumPath, { force: true }); } catch (_) {}
    fs.mkdirSync(sumPath, { recursive: true });
    fs.writeFileSync(path.join(sumPath, 'blocker'), 'x');

    const r = cli.run(['archive', 'ws-roll'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, false, 'archive must fail when the tombstone write fails');
    assert.equal(r.result.descriptorArchived, false);
    assert.match(r.result.error, /rolled back|nothing archived/);

    // ROLLBACK invariants: active descriptor still present, NOT moved to archived/.
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'ws-roll')), true, 'the active descriptor must survive a rolled-back archive');
    assert.equal(fs.existsSync(path.join(cli.archivedDir(home), 'ws-roll.json')), false, 'nothing may be left in archived/ after rollback');

    // Registry row revived (undo the directory sabotage first so we can read it).
    fs.rmSync(sumPath, { recursive: true, force: true });
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { assert.ok(s.listRegistry().some((w) => w.id === 'ws-roll'), 'the registry row must be revived (all-or-nothing)'); }
    finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

// P1-5: the archive critical section re-validates INSIDE the per-id lock,
// immediately before the mutation. When the revalidate predicate reports the
// workspace went live, the archive is SKIPPED — nothing is moved or tombstoned.
// This is the exact seam cmdReapStale wires to close the reap TOCTOU.
test('P1-5: cmdArchive SKIPS (no move, no tombstone) when the in-lock revalidate reports the workspace went live', () => {
  const home = tmpHome();
  const repo = makeGitRepo('reap-revalidate');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const reg = cli.run(['register', 'ws-live', '--worktree', repo, '--session', 's'], ctx(home, { cwd: repo }));
    assert.equal(reg.result.ok, true);
    let called = 0;
    const r = cli.cmdArchive('ws-live', ctx(home, { cwd: repo }), { revalidate: () => { called++; return 'fresh-heartbeat'; } });
    assert.equal(called, 1, 'revalidate must run exactly once, inside the critical section');
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true, 'a workspace that went live must be skipped');
    assert.equal(r.reason, 'fresh-heartbeat');
    assert.equal(r.descriptorArchived, false);
    // Nothing archived: descriptor stays active, registry row survives.
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'ws-live')), true);
    assert.equal(fs.existsSync(path.join(cli.archivedDir(home), 'ws-live.json')), false);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { assert.ok(s.listRegistry().some((w) => w.id === 'ws-live'), 'the registry row must survive a skipped archive'); }
    finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('P1-5: cmdArchive PROCEEDS when the revalidate returns falsy (no skip)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('reap-proceed');
  try {
    cli.run(['register', 'ws-go', '--worktree', repo, '--session', 's'], ctx(home, { cwd: repo }));
    const r = cli.cmdArchive('ws-go', ctx(home, { cwd: repo }), { revalidate: () => null });
    assert.equal(r.ok, true);
    assert.ok(!r.skipped, 'a null revalidate must not skip');
    assert.equal(r.descriptorArchived, true, 'the archive must proceed');
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'ws-go')), false, 'the descriptor must be moved out of workspaces/');
  } finally { rm(home); rm(repo); }
});

// P2-9: the roster's read-only split-brain fallback must NOT materialize a store.
// With no hash-bucket primary present, the fallback probes via a summary READ
// (readSummaryForHash) and creates nothing.
test('P2-9: roster fallback does not create the hash-bucket store dir when no split-brain primary exists', () => {
  const home = tmpHome();
  const repo = makeGitRepo('roster-nocreate');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const mainWorktree = inst.resolveMainWorktree(repo);
    const primaryMeshId = inst.primaryWorkspaceId(mainWorktree);
    const fallbackHash = storeLib.hashFromWorkspaceId(primaryMeshId);
    assert.notEqual(fallbackHash, repoKey, 'precondition: fallback hash differs from repoKey');
    const fallbackDir = storeLib.storeDirForHash(home, fallbackHash);
    assert.equal(fs.existsSync(fallbackDir), false, 'precondition: fallback store dir absent');

    const io = { run: () => { throw new Error('hivecontrol not installed'); } };
    const r = cli.run(['roster'], ctx(home, { cwd: repo, io }));
    assert.equal(r.result.ok, true);
    assert.equal(fs.existsSync(fallbackDir), false, 'the roster fallback must NOT materialize the hash-bucket store dir');
  } finally { rm(home); rm(repo); }
});

// P1-8: the ownerKey forward-migration backfills a descriptor missing ownerKey and
// is idempotent (a re-run changes nothing). Fail-open, no-delete.
test('P1-8: migrateOwnerKeys backfills a missing ownerKey and is idempotent', () => {
  const home = tmpHome();
  const repo = makeGitRepo('ownerkey-migrate');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    // Register normally, then STRIP ownerKey to simulate a pre-migration descriptor.
    cli.run(['register', 'ws-mig', '--worktree', repo, '--session', 's'], ctx(home, { cwd: repo }));
    const dp = cli.descriptorPath(home, 'ws-mig');
    const d = JSON.parse(fs.readFileSync(dp, 'utf8'));
    delete d.ownerKey;
    fs.writeFileSync(dp, JSON.stringify(d));

    const first = cli.migrateOwnerKeys(home, { cwd: repo });
    assert.equal(first.backfilled, 1, 'the missing ownerKey must be backfilled');
    const after = JSON.parse(fs.readFileSync(dp, 'utf8'));
    assert.equal(after.ownerKey, repoKey, 'ownerKey must be backfilled to the resolved repoKey');

    const second = cli.migrateOwnerKeys(home, { cwd: repo });
    assert.equal(second.backfilled, 0, 'a re-run must backfill nothing (idempotent)');
    assert.equal(second.rehomed, 0);
  } finally { rm(home); rm(repo); }
});

// P2-11: cmdHeartbeat must compute `pending` from the descriptor's real unread
// backlog (mirroring computeLiveness's `hbBacklog.known && lines.length>0`), not
// hardcode pending:false — so the two verdict-write paths agree.
test('P2-11: heartbeat writes pending computed from the real backlog, not a hardcoded false', () => {
  const home = tmpHome();
  const repo = makeGitRepo('hb-pending');
  try {
    const inbox = path.join(home, 'inbox.ndjson');
    const cursor = path.join(home, 'cursor');
    fs.writeFileSync(inbox, JSON.stringify({ m: 1 }) + '\n' + JSON.stringify({ m: 2 }) + '\n');
    fs.writeFileSync(cursor, '0');
    cli.run(['register', 'ws-p', '--worktree', repo, '--session', 's', '--inbox', inbox, '--cursor', cursor], ctx(home, { cwd: repo }));

    cli.run(['heartbeat', 'ws-p'], ctx(home, { cwd: repo }));
    const v = JSON.parse(fs.readFileSync(liveness.livenessPathFor('ws-p', home), 'utf8'));
    assert.equal(v.pending, true, 'pending must reflect the 2 unread messages past the cursor');

    // Cursor caught up -> pending false on the next heartbeat.
    fs.writeFileSync(cursor, '2');
    cli.run(['heartbeat', 'ws-p'], ctx(home, { cwd: repo }));
    const v2 = JSON.parse(fs.readFileSync(liveness.livenessPathFor('ws-p', home), 'utf8'));
    assert.equal(v2.pending, false, 'a caught-up cursor must yield pending:false');
  } finally { rm(home); rm(repo); }
});

// P2-10: concurrent heartbeats must not collide on a shared <id>.json.tmp — each
// write uses a unique temp name, so a burst of heartbeats all succeed and the
// final durable file is intact.
test('P2-10: a burst of heartbeats (unique temp names) all succeed with an intact final file', () => {
  const home = tmpHome();
  const repo = makeGitRepo('hb-tmp');
  try {
    cli.run(['register', 'ws-b', '--worktree', repo, '--session', 's'], ctx(home, { cwd: repo }));
    for (let i = 0; i < 20; i++) {
      const r = cli.run(['heartbeat', 'ws-b', '--progress', String(i)], ctx(home, { cwd: repo }));
      assert.equal(r.result.ok, true);
    }
    const beat = JSON.parse(fs.readFileSync(path.join(cli.heartbeatsDir(home), 'ws-b.json'), 'utf8'));
    assert.equal(beat.id, 'ws-b');
    // No stray .tmp files left behind in the heartbeats dir.
    const leftovers = fs.readdirSync(cli.heartbeatsDir(home)).filter((n) => n.includes('.tmp'));
    assert.equal(leftovers.length, 0, 'no staged temp files may leak');
  } finally { rm(home); rm(repo); }
});

// ============================================================================
// Consolidated fix pass (feat/devswarm-primary-lifecycle re-review):
// G1 fail-closed per-id lock, G2 crash-safe archive recovery-intent, G3
// ensure/archive hash-bucket-vs-cross-project, GH1 stranded-workspace
// visibility, GH2 migrateOwnerKeys raw active enumeration.
// ============================================================================
const recovery = require('../../plugins/anti-hall/companion/lib/recovery.js');
function writeActiveDesc(home, id, d) {
  const p = cli.descriptorPath(home, id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(d));
  return p;
}

// --- G1: withIdLock fails CLOSED (mutation must NOT run under a held lock) ---
test('G1: cmdArchive does NOT mutate when the per-id lock is held by another op (fail-closed)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('g1-archive');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    writeActiveDesc(home, 'ws1', { id: 'ws1', worktreePath: repo, sessionId: 's', ownerKey: repoKey });
    seedRegistry(home, repoKey, { id: 'ws1', worktreePath: repo, sessionId: 's' });
    const release = recovery.acquireLock('ws1', home);
    assert.equal(typeof release, 'function', 'precondition: the lock is held');
    try {
      const r = cli.cmdArchive('ws1', ctx(home, { cwd: repo }));
      assert.equal(r.ok, false);
      assert.equal(r.lockBusy, true, 'a held lock must surface lockBusy, not run unlocked');
      assert.equal(fs.existsSync(cli.descriptorPath(home, 'ws1')), true,
        'the active descriptor must remain — the mutation did NOT proceed');
    } finally { release(); }
    // Once the lock is released the same archive proceeds normally.
    const r2 = cli.cmdArchive('ws1', ctx(home, { cwd: repo }));
    assert.equal(r2.ok, true);
    assert.equal(r2.descriptorArchived, true);
  } finally { rm(home); rm(repo); }
});

test('G1: cmdRegister ensure returns lockBusy (no descriptor write) under a held lock', () => {
  const home = tmpHome();
  const repo = makeGitRepo('g1-reg');
  try {
    const release = recovery.acquireLock('ws-new', home);
    try {
      const r = cli.run(['register', 'ws-new', '--worktree', repo, '--session', 's'], ctx(home, { cwd: repo }));
      assert.equal(r.result.ok, false);
      assert.equal(r.result.lockBusy, true);
      assert.equal(fs.existsSync(cli.descriptorPath(home, 'ws-new')), false,
        'no descriptor may be written while the lock is held');
    } finally { release(); }
  } finally { rm(home); rm(repo); }
});

// --- G3: archive re-homes a hash-bucket stranded ws; rejects a real repoKey ---
test('G3: cmdArchive RE-HOMES a hash-bucket-stranded workspace (not rejected) and archives it', () => {
  const home = tmpHome();
  const repo = makeGitRepo('g3-hb');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const hashKey = storeLib.hashFromWorkspaceId('ws-hb');
    assert.notEqual(hashKey, repoKey);
    writeActiveDesc(home, 'ws-hb', { id: 'ws-hb', worktreePath: repo, sessionId: 's', ownerKey: hashKey });
    seedRegistry(home, hashKey, { id: 'ws-hb', worktreePath: repo, sessionId: 's' });
    const r = cli.cmdArchive('ws-hb', ctx(home, { cwd: repo }));
    assert.equal(r.ok, true, 'hash-bucket-stranded archive must heal, not reject: ' + JSON.stringify(r));
    assert.equal(r.descriptorArchived, true);
    // the row must be tombstoned in the RE-HOMED (repoKey) store, not left live in the hash bucket
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let sum; try { sum = storeLib.computeSummary(s, { home }); } finally { s.close(); }
    assert.ok(!sum.workspaces || !sum.workspaces['ws-hb'], 'the re-homed row must be tombstoned');
  } finally { rm(home); rm(repo); }
});

test('G3: cmdArchive REJECTS a descriptor whose ownerKey is a REAL different repoKey (genuine cross-project)', () => {
  const home = tmpHome();
  const repoA = makeGitRepo('g3-A');
  const repoB = makeGitRepo('g3-B');
  try {
    const keyB = repokey.repoKeyForWorktree(repoB);
    writeActiveDesc(home, 'ws-x', { id: 'ws-x', worktreePath: repoB, sessionId: 's', ownerKey: keyB, repoKey: keyB });
    seedRegistry(home, keyB, { id: 'ws-x', worktreePath: repoB, sessionId: 's' });
    const r = cli.cmdArchive('ws-x', ctx(home, { cwd: repoA }));
    assert.equal(r.ok, false);
    assert.match(String(r.error), /does not belong to the current project/);
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'ws-x')), true, 'cross-project archive must not remove the descriptor');
  } finally { rm(home); rm(repoA); rm(repoB); }
});

test('G3: ensure RE-HOMES a hash-bucket-stranded descriptor and REJECTS a real cross-project ownerKey', () => {
  const home = tmpHome();
  const repo = makeGitRepo('g3e');
  const repoB = makeGitRepo('g3eB');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const keyB = repokey.repoKeyForWorktree(repoB);
    const hashKey = storeLib.hashFromWorkspaceId('ws-e');
    // (a) hash-bucket stranded -> ensure heals
    writeActiveDesc(home, 'ws-e', { id: 'ws-e', worktreePath: repo, sessionId: 's', ownerKey: hashKey });
    seedRegistry(home, hashKey, { id: 'ws-e', worktreePath: repo, sessionId: 's' });
    const r = cli.run(['ensure', 'ws-e'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, 'ensure must heal the hash bucket: ' + JSON.stringify(r.result));
    assert.equal(r.result.descriptor.ownerKey, repoKey);
    // (b) real cross-project ownerKey (worktree in project B) -> ensure from A rejects
    writeActiveDesc(home, 'ws-e2', { id: 'ws-e2', worktreePath: repoB, sessionId: 's', ownerKey: keyB, repoKey: keyB });
    seedRegistry(home, keyB, { id: 'ws-e2', worktreePath: repoB, sessionId: 's' });
    const r2 = cli.run(['ensure', 'ws-e2'], ctx(home, { cwd: repo }));
    assert.equal(r2.result.ok, false, 'ensure must reject a genuine cross-project descriptor');
    assert.match(String(r2.result.error), /different project|does not belong/);
  } finally { rm(home); rm(repo); rm(repoB); }
});

// --- GH1: a hash-bucket-stranded workspace becomes visible to the mesh callers ---
test('GH1: a hash-bucket-stranded workspace is visible to reconcile, workspaces-list, and gate', () => {
  const home = tmpHome();
  const repo = makeGitRepo('gh1');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const hashKey = storeLib.hashFromWorkspaceId('ws-str');
    writeActiveDesc(home, 'ws-str', { id: 'ws-str', worktreePath: repo, sessionId: 's', ownerKey: hashKey });
    seedRegistry(home, hashKey, { id: 'ws-str', worktreePath: repo, sessionId: 's' });
    // reconcile: the stranded child's pull IS spawned
    const spawned = [];
    const io = { spawnReconcile: (d) => { spawned.push(d.id); return { status: 0, stdout: JSON.stringify({ ok: true, imported: 0 }), error: null }; } };
    const rr = cli.run(['reconcile'], ctx(home, { cwd: repo, io }));
    assert.equal(rr.result.count, 1);
    assert.deepEqual(spawned, ['ws-str'], 'reconcile must spawn the stranded child pull');
    // workspaces-list: counted (not undercounted). Re-strand first to prove list ALSO heals.
    const home2 = tmpHome();
    try {
      writeActiveDesc(home2, 'ws-str2', { id: 'ws-str2', worktreePath: repo, sessionId: 's', ownerKey: storeLib.hashFromWorkspaceId('ws-str2') });
      seedRegistry(home2, storeLib.hashFromWorkspaceId('ws-str2'), { id: 'ws-str2', worktreePath: repo, sessionId: 's' });
      const wl = cli.cmdWorkspacesList({}, ctx(home2, { cwd: repo }));
      assert.equal(wl.count, 1, 'workspaces-list must not undercount a stranded workspace');
      assert.ok((wl.workspaces || []).some((w) => w.id === 'ws-str2'));
    } finally { rm(home2); }
    // gate: tracked:true (heals per-id before opening the store)
    const home3 = tmpHome();
    try {
      writeActiveDesc(home3, 'ws-str3', { id: 'ws-str3', worktreePath: repo, sessionId: 's', ownerKey: storeLib.hashFromWorkspaceId('ws-str3') });
      seedRegistry(home3, storeLib.hashFromWorkspaceId('ws-str3'), { id: 'ws-str3', worktreePath: repo, sessionId: 's' });
      const g = cli.cmdGate('ws-str3', { set: ['done'] }, ctx(home3, { cwd: repo }));
      assert.equal(g.tracked, true, 'gate must see the re-homed stranded workspace');
    } finally { rm(home3); }
  } finally { rm(home); rm(repo); }
});

// --- GH2: migrateOwnerKeys enumerates ACTIVE descriptors lacking sessionId ---
test('GH2: migrateOwnerKeys migrates an ACTIVE descriptor that has no sessionId', () => {
  const home = tmpHome();
  const repo = makeGitRepo('gh2');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const hashKey = storeLib.hashFromWorkspaceId('ws-ns');
    // active descriptor, hash-bucket ownerKey, NO sessionId (readDescriptors would skip it)
    writeActiveDesc(home, 'ws-ns', { id: 'ws-ns', worktreePath: repo, ownerKey: hashKey });
    seedRegistry(home, hashKey, { id: 'ws-ns', worktreePath: repo });
    const r = cli.migrateOwnerKeys(home, { cwd: repo });
    assert.equal(r.scanned, 1, 'the sessionId-less active descriptor must be enumerated');
    assert.equal(r.rehomed, 1, 'and re-homed out of the hash bucket');
    const after = JSON.parse(fs.readFileSync(cli.descriptorPath(home, 'ws-ns'), 'utf8'));
    assert.equal(after.ownerKey, repoKey);
  } finally { rm(home); rm(repo); }
});

// --- G2: crash-safe archive rollback persists a recovery-intent on double failure ---
test('G2: cmdArchive persists a recovery-intent and reports failure when tombstone AND revive both fail; applyRecoveryIntents revives', () => {
  const home = tmpHome();
  const repo = makeGitRepo('g2');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    writeActiveDesc(home, 'ws-crash', { id: 'ws-crash', worktreePath: repo, sessionId: 's', ownerKey: repoKey });
    seedRegistry(home, repoKey, { id: 'ws-crash', worktreePath: repo, sessionId: 's' });

    // Force: removeRegistry lands (tombstone), the module-level deriveSummary
    // (what cmdArchive calls after removeRegistry) throws (ENOSPC-like), and the
    // rollback revive s.upsertRegistry ALSO throws -> split-brain averted only by
    // the durable recovery-intent marker. listRegistry stays real so
    // registryRowPresent correctly reports the row as tombstoned (absent).
    const origOpen = storeLib.openStore;
    const origDerive = storeLib.deriveSummary;
    let failWrites = true;
    storeLib.deriveSummary = (...a) => { if (failWrites) throw new Error('ENOSPC (simulated)'); return origDerive(...a); };
    storeLib.openStore = (opts) => {
      const s = origOpen(opts);
      const realUpsert = s.upsertRegistry.bind(s);
      s.upsertRegistry = (...a) => { if (failWrites) throw new Error('ENOSPC (simulated)'); return realUpsert(...a); };
      return s;
    };
    let r;
    try {
      r = cli.cmdArchive('ws-crash', ctx(home, { cwd: repo }));
    } finally { storeLib.openStore = origOpen; storeLib.deriveSummary = origDerive; }

    assert.equal(r.ok, false, 'archive must report failure, not success');
    assert.equal(r.recoveryIntent, true, 'a lingering recovery-intent must be flagged');
    assert.equal(fs.existsSync(cli.recoveryIntentPath(home, 'ws-crash')), true,
      'the recovery-intent marker must persist on disk');
    assert.equal(fs.existsSync(cli.descriptorPath(home, 'ws-crash')), true,
      'the active descriptor must remain (rollback dropped the archived link)');

    // Now the store writes work again: doctor/next-run discharges the intent.
    const rec = cli.applyRecoveryIntents(home, { cwd: repo, backend: 'journal' });
    assert.equal(rec.revived, 1, 'the tombstoned row must be revived from the marker');
    assert.equal(fs.existsSync(cli.recoveryIntentPath(home, 'ws-crash')), false, 'the marker is cleared after a verified revive');
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let rows; try { rows = s.listRegistry(); } finally { s.close(); }
    assert.ok(rows.some((x) => x && x.id === 'ws-crash'), 'the registry row is live again');
  } finally { rm(home); rm(repo); }
});

test('G2: a successful archive leaves NO recovery-intent marker behind', () => {
  const home = tmpHome();
  const repo = makeGitRepo('g2-clean');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    writeActiveDesc(home, 'ws-ok', { id: 'ws-ok', worktreePath: repo, sessionId: 's', ownerKey: repoKey });
    seedRegistry(home, repoKey, { id: 'ws-ok', worktreePath: repo, sessionId: 's' });
    const r = cli.cmdArchive('ws-ok', ctx(home, { cwd: repo }));
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(cli.recoveryIntentPath(home, 'ws-ok')), false, 'the marker must be discharged on success');
  } finally { rm(home); rm(repo); }
});

// --- P1: a stale recovery-intent marker must NOT clobber a legitimately
// re-registered workspace's fresh registry row ---
// Repro: a marker is captured from descriptor A (pre-archive), but the archive
// never actually finished tombstoning+clearing (crash between the two). Before
// doctor/next-run gets to applyRecoveryIntents, the SAME id is legitimately
// re-registered with fresh descriptor B (ids are deterministic — e.g. the
// inbox-pull ensure-path recreates the same id every turn) and its own correct
// registry row. `activeExists` alone can't distinguish "archive never finished"
// from "archive finished, then id was re-registered" — both leave an active
// descriptor at `id`. Without a fingerprint check, applyRecoveryIntents would
// upsert the STALE marker.descriptor (A), clobbering the fresh row (B).
test('G2/P1: a stale recovery-intent marker does NOT clobber a re-registered workspace with fresh content', () => {
  const home = tmpHome();
  const repo = makeGitRepo('g2-p1-clobber');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const id = 'ws-reregistered';

    // Descriptor A: the pre-archive snapshot captured into the marker.
    const descA = { id, worktreePath: repo, sessionId: 'session-A', ownerKey: repoKey };
    const fpA = crypto.createHash('sha256').update(JSON.stringify(descA)).digest('hex');

    // Simulate cmdArchive crashing AFTER writing the recovery-intent marker but
    // BEFORE clearing it (marker on disk, referencing descriptor A).
    fs.mkdirSync(path.dirname(cli.recoveryIntentPath(home, id)), { recursive: true });
    fs.writeFileSync(cli.recoveryIntentPath(home, id), JSON.stringify({
      id, ownerKey: repoKey, op: 'archive', descriptor: descA, fingerprint: fpA, ts: Date.now(),
    }));

    // The SAME id is now legitimately re-registered with FRESH descriptor B and
    // its own correct (fresh) registry row — unrelated to the crashed archive.
    const descB = { id, worktreePath: repo, sessionId: 'session-B', ownerKey: repoKey };
    writeActiveDesc(home, id, descB);
    seedRegistry(home, repoKey, descB);

    const rec = cli.applyRecoveryIntents(home, { cwd: repo, backend: 'journal' });
    assert.equal(rec.revived, 0, 'the stale marker must NOT be treated as a revive');
    assert.equal(fs.existsSync(cli.recoveryIntentPath(home, id)), false, 'the stale marker must be cleared');

    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let rows; try { rows = s.listRegistry(); } finally { s.close(); }
    const live = rows.filter((x) => x && x.id === id);
    assert.equal(live.length, 1, 'exactly one live row for this id');
    assert.equal(live[0].sessionId, 'session-B', 'the FRESH registry row (B) must survive untouched — NOT clobbered by the stale marker (A: session-A)');
  } finally { rm(home); rm(repo); }
});
