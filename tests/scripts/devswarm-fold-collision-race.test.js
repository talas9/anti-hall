'use strict';
// v0.61.0 mesh-migration money-path hardening — two defects in the project-wide
// `foldMeshDuplicates` fold (runs on EVERY store during /update + doctor repair):
//
//   P0 — 8-hex meshId COLLISION: the fold groups rows solely by canonicalMeshId
//        (`primary-<first 8 hex of sha256(git-toplevel realpath)>`). An 8-hex slice
//        can collide two DISTINCT worktrees onto one meshId, and the generalized
//        fold — unlike the per-register retireWorktreeDuplicates, which matches on
//        the canonical REAL PATH — folded the whole bucket, forwarding a message to
//        the wrong recipient and tombstoning a legitimate row. FIX: fold only rows
//        whose canonical git-toplevel REAL PATH string-matches (canonicalWorktreeRealPath).
//
//   P1 — DELETE RACE: foldGroupIntoSurvivor classified a row store-only ONCE then
//        removeRegistry'd it; a child that re-registered LIVE in the window lost its
//        row. FIX: re-read the live registry row as the LAST step before the
//        irreversible tombstone; delete only if it is STILL the same store-only
//        phantom (no descriptor, not re-registered).
//
// Both backends. Real git worktrees as cwd (repoKeyForWorktree spawns git).

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-colrace-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-colrace-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function topOf(dir) { return inst.resolveWorktree(dir); }

const backends = [{ name: 'journal', backend: 'journal' }];
if (storeLib.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

for (const B of backends) {
  const openS = (home, repoKey) => storeLib.openStore({ home, hash: repoKey, backend: B.backend });
  const seedReg = (home, repoKey, desc) => { const s = openS(home, repoKey); try { s.upsertRegistry(desc); } finally { s.close(); } };
  const seedDirect = (home, repoKey, toId, body) => {
    const s = openS(home, repoKey);
    try {
      const f = { from: 'sender-x', to: toId, type: 'direct', message: body, timestamp: Date.now(), urgency: 'normal' };
      storeLib.appendMeshMessage(s, Object.assign({}, f, { hash: storeLib.meshMessageHash(f) }));
    } finally { s.close(); }
  };
  const descFile = (home, id, desc) => {
    const p = cli.descriptorPath(home, id);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(desc));
  };
  const regIds = (home, repoKey) => { const s = openS(home, repoKey); try { return s.listRegistry().map((d) => d.id).sort(); } finally { s.close(); } };
  const bodies = (home, repoKey, id) => { const s = openS(home, repoKey); try { return s.listMessages(id, {}).map((m) => m.body); } finally { s.close(); } };

  // ---- P0: distinct worktrees colliding on the 8-hex meshId must NOT fold ----
  test(`[${B.name}] foldMeshDuplicates does NOT merge two DISTINCT worktrees that collide on the 8-hex meshId`, () => {
    const home = tmpHome();
    const WA = makeGitRepo('colA-' + B.name);
    const WB = makeGitRepo('colB-' + B.name);
    const repoKey = repokey.repoKeyForWorktree(WA);
    const topA = topOf(WA);
    const topB = topOf(WB);
    const realA = inst.worktreeRealPath(topA);
    const realB = inst.worktreeRealPath(topB);
    assert.notStrictEqual(realA, realB, 'sanity: the two worktrees have DISTINCT canonical real paths');

    // Force an 8-hex meshId COLLISION deterministically: stub primaryWorkspaceId so
    // BOTH distinct toplevels map to ONE meshId (exactly what a real sha256-slice
    // collision does), while their canonical REAL PATHS stay distinct
    // (worktreeRealPath is NOT stubbed — the collision-proof discriminator).
    const origPWID = inst.primaryWorkspaceId;
    inst.primaryWorkspaceId = (wt) => {
      const real = inst.worktreeRealPath(wt);
      if (real === realA || real === realB) return 'primary-collide';
      return origPWID(wt);
    };
    try {
      // One store-only phantom per worktree, each with its OWN direct backlog.
      seedReg(home, repoKey, { id: 'a-store', worktreePath: topA, sessionId: null });
      seedDirect(home, repoKey, 'a-store', 'payload-a');
      seedReg(home, repoKey, { id: 'b-store', worktreePath: topB, sessionId: null });
      seedDirect(home, repoKey, 'b-store', 'payload-b');

      const r = cli.foldMeshDuplicates(home, { cwd: WA, env: {}, backend: B.backend });
      assert.strictEqual(r.ok, true);
      // NO cross-tombstone: neither distinct-worktree row is retired.
      assert.deepStrictEqual(r.retired.slice().sort(), [], 'collision: neither distinct-worktree row tombstoned');
      // BOTH rows survive.
      const after = regIds(home, repoKey);
      assert.ok(after.includes('a-store') && after.includes('b-store'), 'both distinct-worktree rows survive the fold');
      // NO cross-forward: each partition still holds ONLY its own payload.
      assert.deepStrictEqual(bodies(home, repoKey, 'a-store'), ['payload-a'], 'a-store keeps only its own direct (no cross-forward)');
      assert.deepStrictEqual(bodies(home, repoKey, 'b-store'), ['payload-b'], 'b-store keeps only its own direct (no cross-forward)');
      // Surfaced as a diagnosable anomaly.
      assert.ok(Number(r.meshIdCollisions) >= 1, 'collision surfaced as a diagnosable anomaly count');
    } finally {
      inst.primaryWorkspaceId = origPWID;
      rm(WA); rm(WB); rm(home);
    }
  });

  // ---- P1: a row re-registered LIVE in the delete window must NOT be tombstoned ----
  test(`[${B.name}] foldGroupIntoSurvivor does NOT tombstone a row re-registered LIVE in the delete window`, () => {
    const home = tmpHome();
    const W = makeGitRepo('race-' + B.name);
    const repoKey = repokey.repoKeyForWorktree(W);
    const top = topOf(W);
    // survivor (descriptor-backed live) + a store-only phantom candidate with a backlog.
    seedReg(home, repoKey, { id: 'surv', worktreePath: top, sessionId: 's-surv' });
    descFile(home, 'surv', { id: 'surv', worktreePath: top, sessionId: 's-surv' });
    seedReg(home, repoKey, { id: 'cand', worktreePath: top, sessionId: null });
    seedDirect(home, repoKey, 'cand', 'payload-cand');

    const s = openS(home, repoKey);
    let res;
    try {
      const snapshot = s.listRegistry().find((d) => String(d.id) === 'cand');
      assert.ok(snapshot && (snapshot.sessionId == null || snapshot.sessionId === ''), 'sanity: candidate is store-only at snapshot');
      // Wrap listMessages so that DURING the forward step — the window between our
      // snapshot classification and the tombstone — the candidate row is re-registered
      // LIVE (a child writes its store row), WITHOUT an on-disk descriptor. The final
      // tombstone gate must re-read the row, see it went live, and LEAVE it.
      let fired = false;
      const realListMessages = s.listMessages.bind(s);
      s.listMessages = (id, opts) => {
        if (!fired && String(id) === 'cand') {
          fired = true;
          s.upsertRegistry({ id: 'cand', worktreePath: top, sessionId: 'cand-live-now' });
        }
        return realListMessages(id, opts);
      };
      res = cli.foldGroupIntoSurvivor(s, home, 'surv', [snapshot]);
    } finally { s.close(); }
    assert.deepStrictEqual(res.retired, [], 'a row re-registered live in the window is NOT tombstoned');
    assert.ok(Array.isArray(res.left) && res.left.includes('cand'), 'the re-registered row is LEFT, not deleted');
    // The candidate row still exists in the store (the live child was not deleted).
    assert.ok(regIds(home, repoKey).includes('cand'), 'candidate row survives (live child not deleted)');
    rm(W); rm(home);
  });
}
