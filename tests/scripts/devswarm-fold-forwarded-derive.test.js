'use strict';
// GAP B regression — the derive GATE in BOTH callers of foldGroupIntoSurvivor
// (foldMeshDuplicates + retireWorktreeDuplicates) used to key off `retired.length`
// alone. foldGroupIntoSurvivor FORWARDS a candidate's unread direct backlog into
// the survivor BEFORE the descriptor-file check that decides retire-vs-left
// (devswarm.js's foldGroupIntoSurvivor). A candidate that IS descriptor-backed is
// classified `left` (never retired) but its unread rows are still forwarded —
// so `forwarded > 0` with `retired` EMPTY delivered real messages into the
// survivor partition with NO projection refresh. Fixed: both gates now check
// `retired.length || forwarded` instead of `retired.length` alone.
//
// Real git worktree as cwd (repoKeyForWorktree spawns git). Mirrors
// devswarm-fold-mesh.test.js / devswarm-retire-duplicate.test.js.

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fold-fwd-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fold-fwd-repo-' + tag + '-'));
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

  test(`[${B.name}] foldMeshDuplicates: a descriptor-backed candidate (forwarded, never retired) still re-derives the projection`, () => {
    const home = tmpHome();
    const W = makeGitRepo('a-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(W);
      const survivorId = 'w-live';
      const candId = 'w-cand-descbacked';
      // survivor: live sessionId -> pickSurvivor always picks this row.
      seedReg(home, repoKey, { id: survivorId, worktreePath: topOf(W), sessionId: 'live-sess' });
      // candidate: DESCRIPTOR-BACKED (forces `left`, never `retired`), with a
      // forwardable unread direct.
      seedReg(home, repoKey, { id: candId, worktreePath: topOf(W), sessionId: null });
      descFile(home, candId, { id: candId, worktreePath: topOf(W), sessionId: null });
      seedDirect(home, repoKey, candId, 'payload-fwd');

      // Make "the summary was refreshed" unambiguous: no pre-existing summary.
      try { fs.unlinkSync(storeLib.summaryPathForHash(home, repoKey)); } catch (_) {}

      const r = cli.foldMeshDuplicates(home, { cwd: W, env: {}, backend: B.backend });
      assert.strictEqual(r.ok, true);

      // Precondition: we are in the exact regression window.
      assert.strictEqual(r.retired.length, 0, 'precondition: nothing was retired (descriptor-backed candidate is LEFT)');
      assert.ok(r.forwarded > 0, 'precondition: the unread direct WAS forwarded');
      assert.ok(Array.isArray(r.left) && r.left.includes(candId), 'the descriptor-backed candidate is LEFT, not retired');

      const sum = storeLib.readSummaryForHash(home, repoKey);
      assert.ok(sum, 'the projection was (re-)derived even though nothing was retired');
      const w = sum.workspaces && sum.workspaces[survivorId];
      assert.ok(w, 'the survivor appears in the projection');
      assert.ok((w.unread || 0) >= 1 || (w.directUnread || 0) >= 1, 'the survivor projection reflects the forwarded unread');
    } finally { rm(W); rm(home); }
  });

  test(`[${B.name}] retireWorktreeDuplicates: a descriptor-backed candidate (forwarded, never retired) still re-derives the projection`, () => {
    const home = tmpHome();
    const W = makeGitRepo('b-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(W);
      const keepMesh = inst.primaryWorkspaceId(topOf(W));
      const survivorId = 'builder-live-' + B.name;
      assert.notStrictEqual(survivorId, keepMesh, 'sanity: survivor id must differ from the worktree meshId (builder-id self-register gate)');
      const candId = 'w-cand-descbacked-2';

      seedReg(home, repoKey, { id: survivorId, worktreePath: topOf(W), sessionId: 'live-sess' });
      seedReg(home, repoKey, { id: candId, worktreePath: topOf(W), sessionId: null });
      descFile(home, candId, { id: candId, worktreePath: topOf(W), sessionId: null });
      seedDirect(home, repoKey, candId, 'payload-fwd-2');

      try { fs.unlinkSync(storeLib.summaryPathForHash(home, repoKey)); } catch (_) {}

      const keepDesc = { id: survivorId, worktreePath: topOf(W), sessionId: 'live-sess' };
      const r = cli.retireWorktreeDuplicates(home, keepDesc, { cwd: W, env: {}, backend: B.backend });
      assert.ok(r, 'retireWorktreeDuplicates returned a result (not null)');

      // Precondition: we are in the exact regression window.
      assert.strictEqual(r.retired.length, 0, 'precondition: nothing was retired (descriptor-backed candidate is LEFT)');
      assert.ok(r.forwarded > 0, 'precondition: the unread direct WAS forwarded');
      assert.ok(Array.isArray(r.left) && r.left.includes(candId), 'the descriptor-backed candidate is LEFT, not retired');

      const sum = storeLib.readSummaryForHash(home, repoKey);
      assert.ok(sum, 'the projection was (re-)derived even though nothing was retired');
      const w = sum.workspaces && sum.workspaces[survivorId];
      assert.ok(w, 'the survivor appears in the projection');
      assert.ok((w.unread || 0) >= 1 || (w.directUnread || 0) >= 1, 'the survivor projection reflects the forwarded unread');
    } finally { rm(W); rm(home); }
  });
}
