'use strict';
// v0.61.0 mesh-migration money-path re-critic fixes (run on EVERY store during
// `/update` + doctor repair). Three hardenings, both backends, isolated tmp HOME
// (NEVER ~/.anti-hall), fail-first/pass-after asserted in-test:
//
//   P1a — the fold delete is ATOMIC. removeRegistryIf tombstones a store-only
//         phantom ONLY if it is STILL that phantom (session_id null + snapshot
//         updatedAt match). A live re-register in the classify->delete window is
//         NOT deleted (surfaced as `left`), closing the TOCTOU.
//   P1b — a subdir-registered row is re-keyed to its git TOPLEVEL worktreePath at
//         migration time, so `send --to <toplevel meshId>` resolves it (was
//         unregistered-recipient); a DISTINCT toplevel (linked worktree) stays
//         distinct. In-place registry update — the partition (d.id) is unchanged,
//         so no message move.
//   P2  — a null snapshot updatedAt that gained a real timestamp counts as a
//         re-register -> conservative SKIP (folded into the P1a guard).
//
// Real git worktrees as cwd (repoKeyForWorktree spawns git). Mirrors
// devswarm-send.test.js / devswarm-fold-mesh.test.js.

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
const doctorRepair = require('../../plugins/anti-hall/hooks/lib/doctor-repair.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-foldrace-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-foldrace-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function addLinkedWorktree(mainDir, tag) {
  const wt = path.join(path.dirname(mainDir), path.basename(mainDir) + '-wt-' + tag);
  cp.spawnSync('git', ['-C', mainDir, 'worktree', 'add', wt, '-b', 'branch-' + tag]);
  return wt;
}
// derivedId(dir) — the meshId production derives for a REAL git worktree (resolved
// toplevel THEN primaryWorkspaceId — win32-correct; see devswarm-send.test.js).
function derivedId(dir) { return inst.primaryWorkspaceId(inst.resolveWorktree(dir)); }

const backends = [{ name: 'journal', backend: 'journal' }];
if (storeLib.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

for (const B of backends) {
  const openS = (home, repoKey) => storeLib.openStore({ home, hash: repoKey, backend: B.backend });
  const seedReg = (home, repoKey, desc) => { const s = openS(home, repoKey); try { s.upsertRegistry(desc); } finally { s.close(); } };
  const snapOf = (home, repoKey, id) => { const s = openS(home, repoKey); try { return s.listRegistry().find((d) => String(d.id) === String(id)) || null; } finally { s.close(); } };
  const regIds = (home, repoKey) => { const s = openS(home, repoKey); try { return s.listRegistry().map((d) => String(d.id)); } finally { s.close(); } };
  const worktreeOf = (home, repoKey, id) => { const s = openS(home, repoKey); try { const d = s.listRegistry().find((x) => String(x.id) === String(id)); return d ? d.worktreePath : null; } finally { s.close(); } };
  const bodies = (home, repoKey, id) => { const s = openS(home, repoKey); try { return s.listMessages(id, {}).map((m) => m.body); } finally { s.close(); } };
  const ctx = (home, over) => Object.assign({ home, backend: B.backend, env: {} }, over || {});

  // ---- P1a — atomic conditional tombstone --------------------------------
  test(`[${B.name}] P1a: removeRegistryIf tombstones a STABLE phantom but NOT one that re-registered live in the window`, () => {
    const home = tmpHome();
    const repo = makeGitRepo('p1a');
    try {
      const repoKey = repokey.repoKeyForWorktree(repo);

      // (1) genuinely stable store-only phantom IS removed with a matching snapshot.
      seedReg(home, repoKey, { id: 'ph-stable', worktreePath: repo, sessionId: null });
      const snap1 = snapOf(home, repoKey, 'ph-stable');
      {
        const s = openS(home, repoKey);
        try {
          assert.equal(s.removeRegistryIf('ph-stable', { sessionId: snap1.sessionId, updatedAt: snap1.updatedAt }), true,
            'a stable phantom matching the snapshot must be removed');
        } finally { s.close(); }
      }
      assert.equal(regIds(home, repoKey).includes('ph-stable'), false, 'stable phantom is gone');

      // (2) a phantom that RE-REGISTERED live after the snapshot is NOT removed
      // (the delete-race the fix closes). Guard: session_id is now set.
      seedReg(home, repoKey, { id: 'ph-race', worktreePath: repo, sessionId: null });
      const snap2 = snapOf(home, repoKey, 'ph-race'); // classified while store-only
      seedReg(home, repoKey, { id: 'ph-race', worktreePath: repo, sessionId: 'live-sess' }); // child re-registers LIVE
      {
        const s = openS(home, repoKey);
        try {
          assert.equal(s.removeRegistryIf('ph-race', { sessionId: snap2.sessionId, updatedAt: snap2.updatedAt }), false,
            'a row that went live in the window must NOT be tombstoned');
        } finally { s.close(); }
      }
      assert.equal(regIds(home, repoKey).includes('ph-race'), true, 'the now-live row survives (no message loss)');
      const live = snapOf(home, repoKey, 'ph-race');
      assert.equal(live.sessionId, 'live-sess', 'the surviving row is the LIVE re-registration');

      // (3) a store-only row that carries a STALE session_id (a legacy registration
      // whose descriptor is gone) IS still removable when the snapshot matches — the
      // guard pins session_id+updatedAt, it does NOT require session_id to be null.
      seedReg(home, repoKey, { id: 'ph-sess', worktreePath: repo, sessionId: 'stale-sess' });
      const snap3 = snapOf(home, repoKey, 'ph-sess');
      {
        const s = openS(home, repoKey);
        try {
          assert.equal(s.removeRegistryIf('ph-sess', { sessionId: snap3.sessionId, updatedAt: snap3.updatedAt }), true,
            'a session-bearing store-only row matching the snapshot must still be removed');
        } finally { s.close(); }
      }
      assert.equal(regIds(home, repoKey).includes('ph-sess'), false, 'session-bearing store-only row removed');
    } finally { rm(home); rm(repo); }
  });

  // ---- P2 — null snapshot updatedAt --------------------------------------
  test(`[${B.name}] P2: a null snapshot updatedAt that gained a real timestamp is treated as a re-register (NOT removed)`, () => {
    const home = tmpHome();
    const repo = makeGitRepo('p2');
    try {
      const repoKey = repokey.repoKeyForWorktree(repo);
      // The row now carries a real updatedAt (any live/upserted row does); the fold's
      // classification snapshot, however, saw updatedAt:null (a legacy descriptor).
      // The OLD reRegisteredSince MISSED this null->value transition and would delete.
      seedReg(home, repoKey, { id: 'ph-null', worktreePath: repo, sessionId: null });
      const cur = snapOf(home, repoKey, 'ph-null');
      assert.ok(Number.isFinite(cur.updatedAt), 'row has a real (finite) updatedAt now');
      {
        const s = openS(home, repoKey);
        try {
          assert.equal(s.removeRegistryIf('ph-null', { sessionId: cur.sessionId, updatedAt: null }), false,
            'a null-updatedAt snapshot must NULL-safe-mismatch a real timestamp -> conservative skip');
        } finally { s.close(); }
      }
      assert.equal(regIds(home, repoKey).includes('ph-null'), true, 'row preserved (P2 close)');
    } finally { rm(home); rm(repo); }
  });

  // ---- P1b — subdir singleton re-key -------------------------------------
  test(`[${B.name}] P1b: migration re-keys a subdir singleton to its toplevel so send --to <toplevel meshId> reaches it; a distinct toplevel stays distinct`, () => {
    const home = tmpHome();
    const T = makeGitRepo('p1b');
    const Tsub = path.join(T, 'sub');
    fs.mkdirSync(Tsub, { recursive: true });
    const WT2 = addLinkedWorktree(T, 'other'); // its OWN toplevel, SAME repoKey (shared git-common-dir)
    const sender = addLinkedWorktree(T, 'sender'); // a distinct-meshId caller in the same repoKey store
    try {
      const repoKey = repokey.repoKeyForWorktree(T);
      const toplevelMeshId = derivedId(T);
      const wt2MeshId = derivedId(WT2);

      // OLD-store shape: a LONE live row registered from the git SUBDIR (raw path),
      // plus a distinct-toplevel row on the linked worktree.
      seedReg(home, repoKey, { id: 'child-sub', worktreePath: Tsub, sessionId: 'sess-sub' });
      seedReg(home, repoKey, { id: 'child-wt2', worktreePath: WT2, sessionId: 'sess-wt2' });

      // FAIL-FIRST: before migration the subdir row is addressable only by its raw
      // subdir meshId, so a toplevel-meshId send fails closed.
      const before = cli.run(['send', '--to', toplevelMeshId, '--message', 'hi'], ctx(home, { cwd: sender }));
      assert.equal(before.result.ok, false, 'before migration: toplevel send does not resolve the subdir row');
      assert.equal(before.result.reason, 'unregistered-recipient');

      // Migrate (the exact call `/update` + doctor repair make).
      const r = cli.foldMeshDuplicates(home, ctx(home, { cwd: T }));
      assert.equal(r.ok, true);
      assert.equal(r.rekeyed, 1, 'exactly the subdir row is re-keyed');
      assert.deepEqual(r.retired, [], 'a subdir SINGLETON is re-keyed, not folded/tombstoned');

      // PASS-AFTER: the subdir row is now stored under the canonical toplevel path,
      // and a toplevel-meshId send reaches its partition (d.id unchanged -> no move).
      assert.equal(worktreeOf(home, repoKey, 'child-sub'), inst.resolveWorktree(Tsub),
        'subdir row worktreePath re-keyed to the git toplevel');
      const after = cli.run(['send', '--to', toplevelMeshId, '--message', 'reached'], ctx(home, { cwd: sender }));
      assert.equal(after.result.ok, true, 'after migration: toplevel send resolves');
      assert.ok(bodies(home, repoKey, 'child-sub').includes('reached'), 'message landed in the (formerly subdir) partition');

      // Distinct toplevel (linked worktree) is NOT merged/re-keyed and stays addressable on its OWN meshId.
      assert.equal(worktreeOf(home, repoKey, 'child-wt2'), WT2, 'distinct toplevel row untouched');
      assert.notEqual(wt2MeshId, toplevelMeshId, 'the two toplevels are distinct meshIds');
      const toWt2 = cli.run(['send', '--to', wt2MeshId, '--message', 'wt2'], ctx(home, { cwd: sender }));
      assert.equal(toWt2.result.ok, true);
      assert.ok(bodies(home, repoKey, 'child-wt2').includes('wt2'), 'wt2 send reached wt2, not the subdir row');
      assert.ok(!bodies(home, repoKey, 'child-sub').includes('wt2'), 'no cross-delivery between distinct toplevels');
    } finally { rm(home); rm(sender); rm(WT2); rm(T); }
  });

  // ---- P1b idempotency: a re-run re-keys nothing --------------------------
  test(`[${B.name}] P1b: re-key is idempotent (a second migration re-keys 0)`, () => {
    const home = tmpHome();
    const T = makeGitRepo('p1bidem');
    const Tsub = path.join(T, 'sub');
    fs.mkdirSync(Tsub, { recursive: true });
    try {
      const repoKey = repokey.repoKeyForWorktree(T);
      seedReg(home, repoKey, { id: 'child-sub', worktreePath: Tsub, sessionId: 'sess-sub' });
      const r1 = cli.foldMeshDuplicates(home, ctx(home, { cwd: T }));
      assert.equal(r1.rekeyed, 1);
      const r2 = cli.foldMeshDuplicates(home, ctx(home, { cwd: T }));
      assert.equal(r2.rekeyed, undefined, 'no rows left to re-key on re-run');
    } finally { rm(home); rm(Tsub); rm(T); }
  });

  // ---- P1b via DOCTOR REPAIR: a re-key-only store (nothing to retire) is repaired --
  test(`[${B.name}] P1b: doctor repair detects + applies a subdir re-key even when nothing is retired`, () => {
    const home = tmpHome();
    const T = makeGitRepo('p1bdoc');
    const Tsub = path.join(T, 'sub');
    fs.mkdirSync(Tsub, { recursive: true });
    try {
      const repoKey = repokey.repoKeyForWorktree(T);
      seedReg(home, repoKey, { id: 'child-sub', worktreePath: Tsub, sessionId: 'sess-sub' });
      const env = { HOME: home, ANTIHALL_DEVSWARM_STORE_BACKEND: B.backend, PATH: process.env.PATH };
      const find = (res) => res.find((x) => x.id === 'fold-mesh-duplicates');

      // dry-run detect: pending on the re-key alone (retired=0).
      const dry = doctorRepair.runRepairs({ cwd: T, env, home, dryRun: true });
      const dEntry = find(dry);
      assert.ok(dEntry, 'doctor wires fold-mesh-duplicates');
      assert.strictEqual(dEntry.status, 'skipped');
      assert.match(dEntry.msg, /re-key/, 'dry-run detail names the subdir re-key drift');
      assert.equal(worktreeOf(home, repoKey, 'child-sub'), Tsub, 'dry-run mutated nothing');

      // apply: re-keys for real.
      const applied = doctorRepair.runRepairs({ cwd: T, env, home, dryRun: false });
      const aEntry = find(applied);
      assert.strictEqual(aEntry.status, 'fixed', 'apply reports fixed');
      assert.equal(worktreeOf(home, repoKey, 'child-sub'), inst.resolveWorktree(Tsub),
        'doctor repair re-keyed the subdir row to its toplevel');
    } finally { rm(home); rm(Tsub); rm(T); }
  });
}
