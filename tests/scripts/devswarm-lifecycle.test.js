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

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

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
