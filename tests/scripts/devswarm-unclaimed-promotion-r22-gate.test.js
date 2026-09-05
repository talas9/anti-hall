'use strict';
// R22 P2 (Wave D10b) — three hardening fixes on top of the `unclaimed:`
// promotion machinery (defect 54a6539e2d69):
//
// (1) GATE: realSessionIdFrom's process-tree fallback (a real `ps` per hop of
// the caller's parent chain, via defaultPpidOf) previously ran on EVERY
// inbox read/pull lacking --session/CLAUDE_CODE_SESSION_ID — even reads of a
// row already promoted to a real session id on BOTH the descriptor and the
// registry, where the walk's result can only ever be discarded. It now runs
// ONLY when the row (descriptor or registry) still carries the exact
// `unclaimed:<id>` marker or has no sessionId at all.
//
// (2) already covered by devswarm-unclaimed-promotion-parent-chain.test.js's
// (B1d) — pid-reuse/staleness guard on the session file the walk finds.
//
// (3) promoteUnclaimedSession's classic promotion path previously swallowed
// a registry-write failure completely: nothing told the caller the write
// failed. It now returns an additive `registryWriteError` field (the
// descriptor promotion itself, and `out.promoted`, are unaffected) and
// writes one stderr line.

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
const liveness = require('../../plugins/anti-hall/companion/lib/liveness.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-r22-gate-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-r22-gate-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function topOf(dir) { return inst.resolveWorktree(dir); }
function meshOf(dir) { return inst.primaryWorkspaceId(inst.resolveWorktree(dir)); }

function writeDescriptor(home, id, descriptor) {
  const wsDir = path.join(liveness.devswarmRoot(home), 'workspaces');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, id + '.json'), JSON.stringify(descriptor));
}

const backends = [{ name: 'journal', backend: 'journal' }];
if (storeLib.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

for (const B of backends) {
  const seedB = (home, repoKey, desc) => {
    const s = storeLib.openStore({ home, hash: repoKey, backend: B.backend });
    try { s.upsertRegistry(desc); } finally { s.close(); }
  };

  // (1a) GATE: a row ALREADY real on both descriptor and registry -> the
  // process-tree walk must NOT run at all (ppidOf counter stays 0).
  test(`[${B.name}] R22 gate: realSessionIdFrom skips the process-tree walk for a fully-promoted row`, () => {
    const home = tmpHome();
    const main = makeGitRepo('gate-promoted-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const wt = topOf(main);
      const id = meshOf(main);
      writeDescriptor(home, id, { id, worktreePath: wt, sessionId: 'already-real-both-sides' });
      seedB(home, repoKey, { id, worktreePath: wt, sessionId: 'already-real-both-sides' });

      let ppidCalls = 0;
      const ctx = {
        home, backend: B.backend, env: {}, cwd: main,
        sessionDeriveOpts: { pid: 9001, ppidOf: (p) => { ppidCalls++; return null; } },
      };
      const sid = cli.realSessionIdFrom({}, ctx, id);
      assert.strictEqual(sid, null, 'no real session named by --session/env, and the row is already promoted -> null');
      assert.strictEqual(ppidCalls, 0, 'the process-tree walk must never run for an already-promoted row');
    } finally { rm(main); rm(home); }
  });

  // (1b) GATE: a row still carrying the `unclaimed:` marker (either side) ->
  // the walk DOES run (ppidOf counter > 0).
  test(`[${B.name}] R22 gate: realSessionIdFrom runs the process-tree walk for a marker row`, () => {
    const home = tmpHome();
    const main = makeGitRepo('gate-marker-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const wt = topOf(main);
      const id = meshOf(main);
      writeDescriptor(home, id, { id, worktreePath: wt, sessionId: 'unclaimed:' + id });
      seedB(home, repoKey, { id, worktreePath: wt, sessionId: 'unclaimed:' + id });

      let ppidCalls = 0;
      const ctx = {
        home, backend: B.backend, env: {}, cwd: main,
        sessionDeriveOpts: { pid: 9001, ppidOf: (p) => { ppidCalls++; return null; } },
      };
      const sid = cli.realSessionIdFrom({}, ctx, id);
      assert.strictEqual(sid, null, 'nothing found in the (empty) chain -> null, but the walk must have run');
      assert.ok(ppidCalls > 0, 'the process-tree walk must run for a row still carrying the unclaimed: marker');
    } finally { rm(main); rm(home); }
  });

  // (3) promoteUnclaimedSession surfaces a registry-write failure instead of
  // swallowing it, while the descriptor promotion (and out.promoted) still
  // succeed.
  test(`[${B.name}] R22 P2: promoteUnclaimedSession surfaces a registryWriteError instead of swallowing it`, () => {
    const home = tmpHome();
    const main = makeGitRepo('registry-write-fail-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const wt = topOf(main);
      const id = meshOf(main);
      writeDescriptor(home, id, { id, worktreePath: wt, sessionId: 'unclaimed:' + id });
      seedB(home, repoKey, { id, worktreePath: wt, sessionId: 'unclaimed:' + id });

      // Inject a failing store write deterministically: monkeypatch the
      // SAME `devswarm-store.js` module object devswarm.js's upsertStoreRegistry
      // calls (`store.openStore(...)`, a property lookup at call time, not a
      // destructured local — so patching the shared, cached module object
      // here reaches it) to throw for exactly this workspace id, leaving
      // every other store open (including the descriptor's plain file
      // write, which does not go through this module) unaffected.
      const realOpenStore = storeLib.openStore;
      storeLib.openStore = function (opts) {
        if (opts && opts.workspaceId === id) throw new Error('injected registry write failure');
        return realOpenStore.apply(this, arguments);
      };
      let r;
      try {
        const ctx = { home, backend: B.backend, env: {}, cwd: main };
        r = cli.promoteUnclaimedSession(home, id, 'newly-real-session-id', ctx);
      } finally {
        storeLib.openStore = realOpenStore;
      }

      assert.strictEqual(r.promoted, true, 'descriptor promotion still succeeds even though the registry write fails');
      assert.strictEqual(r.to, 'newly-real-session-id');
      assert.ok(typeof r.registryWriteError === 'string' && r.registryWriteError.length > 0,
        'a failed registry write must be surfaced as an additive registryWriteError field, not swallowed');
    } finally { rm(main); rm(home); }
  });
}
