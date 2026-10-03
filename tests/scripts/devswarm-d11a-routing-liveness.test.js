'use strict';
// D11-A (f56dcc08f048): resolveMeshTarget / pickSurvivor / groupRegistryByMeshId's
// liveRows used to read isLiveSessionId(sessionId) DIRECTLY — a bare "non-empty,
// non-synthetic" shape test with no heartbeat/dormancy correlation — for ROUTING/
// FOLD decisions, while fold (foldGroupIntoSurvivor) and siblingAckGate already use
// the heartbeat-freshness + harness-session-dormancy composed predicate
// (companion/lib/liveness.js's isSiblingPartitionLive). A registry row for a
// CRASHED sibling (a real sessionId, no live process behind it, stale/absent
// heartbeat) therefore still won `send --to <meshId>` / fold-survivor selection
// over a genuinely live sibling whenever it happened to sort first or carry a
// fresher `updatedAt` (kept fresh, in the field, by an unrelated cli-heartbeat
// caller) — silent message loss to a partition nothing drains.
//
// Fix: all three now route through isRoutingLiveRow (scripts/devswarm.js), which
// composes isSiblingPartitionLive with a descriptor-existence fallback (a
// just-registered row with no heartbeat file yet is not treated as dead).

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-d11a-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-d11a-repo-' + tag + '-'));
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

function writeHeartbeat(home, id, ts) {
  const p = liveness.heartbeatPathFor(id, home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ id, ts, state_ts: ts, source: 'cli-heartbeat' }));
}

const STALE_MS = 8 * 60 * 60 * 1000; // past both dormancy windows (30min tight, 6h wide)

const backends = [{ name: 'journal', backend: 'journal' }];
if (storeLib.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

for (const B of backends) {
  const seedB = (home, repoKey, desc) => {
    const s = storeLib.openStore({ home, hash: repoKey, backend: B.backend });
    try { s.upsertRegistry(desc); } finally { s.close(); }
  };
  const openS = (home, repoKey) => storeLib.openStore({ home, hash: repoKey, backend: B.backend });

  test(`[${B.name}] D11-A: resolveMeshTarget routes to the LIVE row, not a dead row with a real (stale) sessionId`, () => {
    const home = tmpHome();
    const main = makeGitRepo('resolve-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const top = topOf(main);
      const mesh = meshOf(main);
      // dead-shaped row: a real (non-synthetic) sessionId, but STALE heartbeat and
      // no harness session file behind it — this is exactly the crashed-sibling
      // shape the pre-fix bare isLiveSessionId test misread as live.
      seedB(home, repoKey, { id: 'dead-real-sid', worktreePath: top, sessionId: 'dead-session', updatedAt: Date.now() + 1000 });
      writeHeartbeat(home, 'dead-real-sid', Date.now() - STALE_MS);
      // genuinely live row: fresh heartbeat.
      seedB(home, repoKey, { id: 'alive-row', worktreePath: top, sessionId: 'alive-session', updatedAt: Date.now() - 1000 });
      writeHeartbeat(home, 'alive-row', Date.now());

      const s = openS(home, repoKey);
      try {
        const target = cli.resolveMeshTarget(s, mesh, home);
        assert.ok(target, 'a target must resolve');
        assert.strictEqual(target.id, 'alive-row', 'resolveMeshTarget must route to the genuinely live row, never the dead-but-real-sessionId one, even when the dead row sorts fresher on updatedAt');
      } finally { s.close(); }
    } finally { rm(main); rm(home); }
  });

  test(`[${B.name}] D11-A: pickSurvivor keeps the LIVE row, not a dead row with a real (stale) sessionId`, () => {
    const home = tmpHome();
    const main = makeGitRepo('survivor-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const top = topOf(main);
      seedB(home, repoKey, { id: 'dead-real-sid2', worktreePath: top, sessionId: 'dead-session2', updatedAt: Date.now() + 1000 });
      writeHeartbeat(home, 'dead-real-sid2', Date.now() - STALE_MS);
      seedB(home, repoKey, { id: 'alive-row2', worktreePath: top, sessionId: 'alive-session2', updatedAt: Date.now() - 1000 });
      writeHeartbeat(home, 'alive-row2', Date.now());

      const s = openS(home, repoKey);
      try {
        const rows = s.listRegistry();
        const survivor = cli.pickSurvivor(s, { rows }, home);
        assert.ok(survivor, 'a survivor must be picked');
        assert.strictEqual(survivor.id, 'alive-row2', 'pickSurvivor must keep the genuinely live row over a dead-but-real-sessionId row');
      } finally { s.close(); }
    } finally { rm(main); rm(home); }
  });

  test(`[${B.name}] D11-A: groupRegistryByMeshId's liveRows/kind classifies a dead-real-sessionId + live pair as 'mixed', not 'live'`, () => {
    const home = tmpHome();
    const main = makeGitRepo('group-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const top = topOf(main);
      const mesh = meshOf(main);
      seedB(home, repoKey, { id: 'dead-real-sid3', worktreePath: top, sessionId: 'dead-session3' });
      writeHeartbeat(home, 'dead-real-sid3', Date.now() - STALE_MS);
      seedB(home, repoKey, { id: 'alive-row3', worktreePath: top, sessionId: 'alive-session3' });
      writeHeartbeat(home, 'alive-row3', Date.now());

      const s = openS(home, repoKey);
      try {
        const byMesh = cli.groupRegistryByMeshId(s.listRegistry(), home);
        const g = byMesh.get(mesh);
        assert.ok(g, 'group must be present');
        assert.strictEqual(g.liveRows, 1, 'a stale/dead-real-sessionId sibling must not count toward liveRows once routing is heartbeat/dormancy-aware');
      } finally { s.close(); }
    } finally { rm(main); rm(home); }
  });

  test(`[${B.name}] D11-A: a freshly-registered row (synthetic sessionId, descriptor present, no heartbeat yet) is NOT treated as dead by isRoutingLiveRow (descriptor-only fallback)`, () => {
    const home = tmpHome();
    const main = makeGitRepo('fresh-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const top = topOf(main);
      // register writes BOTH the descriptor and the registry row; simulate the
      // window right after register, before the child's first heartbeat.
      const inboxPath = path.join(home, 'fresh-reg-inbox.ndjson');
      const cursorPath = path.join(home, 'fresh-reg-cursor');
      const r = cli.run(['register', 'fresh-reg', '--worktree', main, '--session', 'unclaimed:fresh-reg',
        '--inbox', inboxPath, '--cursor', cursorPath],
        { home, backend: B.backend, env: {}, cwd: main });
      assert.strictEqual(r.result.ok, true, 'register must succeed: ' + JSON.stringify(r.result));

      const live = cli.isRoutingLiveRow({ id: 'fresh-reg', worktreePath: top, sessionId: 'unclaimed:fresh-reg' }, home);
      assert.strictEqual(live, true, 'a just-registered row (descriptor present, no heartbeat yet) must read live via the descriptor-only fallback, mirroring how the fold treats it');
    } finally { rm(main); rm(home); }
  });
}
