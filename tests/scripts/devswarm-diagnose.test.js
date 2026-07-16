'use strict';
// #62 — read-only `diagnose` verb + read-verb purity.
//
// (a) `diagnose` is a READ-ONLY mesh-health projection built on the PURE
//     store.computeSummary (Phase A): it surfaces per-worktree registry rows,
//     which partition a `send` resolves to (resolveMeshTarget), orphan partitions,
//     stale-registry rows, and any worktree with 2+ LIVE rows flagged as a "split".
//     It NEVER writes summary.json (an orchestrator can SEE state without mutating).
// (b) `roster` / `workspaces list` previously called deriveSummary, which WROTE
//     summary.json as a side effect of a READ — a surprise. They now read via the
//     pure computeSummary, so a read verb no longer mutates on disk.
//
// Exercised in-process via cli.run(argv, ctx) with an injected tmp HOME + REAL git
// worktrees as ctx.cwd (repoKeyForWorktree spawns a real git). Both backends
// (journal always; sqlite when node:sqlite is present). Mirrors
// devswarm-retire-duplicate.test.js.

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-diagnose-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function tick() { const t = Date.now(); while (Date.now() === t) { /* spin */ } }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-diagnose-repo-' + tag + '-'));
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

const backends = [{ name: 'journal', backend: 'journal' }];
if (storeLib.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

for (const B of backends) {
  const bctx = (home, over) => Object.assign({ home, backend: B.backend, env: {} }, over || {});
  const seedB = (home, repoKey, desc) => {
    const s = storeLib.openStore({ home, hash: repoKey, backend: B.backend });
    try { s.upsertRegistry(desc); } finally { s.close(); }
  };
  const seedMsg = (home, repoKey, id, body, hash) => {
    const s = storeLib.openStore({ home, hash: repoKey, backend: B.backend });
    try { s.appendMessage({ workspaceId: id, body, hash, ts: Date.now() }); } finally { s.close(); }
  };
  // A native `hivecontrol` binary is never present in tests — inject a failing run
  // so roster's best-effort native-children fold is a clean no-op (never a spawn).
  const noNative = { run: () => ({ ok: false, error: 'no hivecontrol' }) };

  // (b) roster no longer writes summary.json (fail-first: pre-fix deriveSummary wrote it).
  test(`[${B.name}] roster is a pure read — it does NOT write summary.json`, () => {
    const home = tmpHome();
    const main = makeGitRepo('rost-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      seedB(home, repoKey, { id: 'ws-a', worktreePath: topOf(main), sessionId: 's' });
      const sp = storeLib.summaryPathForHash(home, repoKey);
      assert.ok(!fs.existsSync(sp), 'no summary.json before roster');
      const r = cli.run(['roster'], bctx(home, { cwd: main, io: noNative }));
      assert.strictEqual(r.result.ok, true);
      assert.ok(r.result.workspaces.some((w) => w.id === 'ws-a'), 'roster still surfaces the registry row');
      assert.ok(!fs.existsSync(sp), 'roster did NOT write summary.json (read verb no longer mutates)');
    } finally {
      rm(main); rm(home);
    }
  });

  // (a) diagnose purity — it changes no summary.json mtime.
  test(`[${B.name}] diagnose is pure — it changes no summary.json mtime`, () => {
    const home = tmpHome();
    const main = makeGitRepo('dpure-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      seedB(home, repoKey, { id: 'ws-a', worktreePath: topOf(main), sessionId: 's' });
      // Seed a summary.json via the WRITING path, then assert diagnose leaves it untouched.
      const s0 = storeLib.openStore({ home, hash: repoKey, backend: B.backend });
      try { storeLib.deriveSummary(s0, { home, env: {}, now: Date.now() }); } finally { s0.close(); }
      const sp = storeLib.summaryPathForHash(home, repoKey);
      assert.ok(fs.existsSync(sp), 'summary.json seeded');
      const before = fs.statSync(sp).mtimeMs;
      tick();
      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.strictEqual(d.result.ok, true);
      assert.strictEqual(fs.statSync(sp).mtimeMs, before, 'diagnose did not touch summary.json');
    } finally {
      rm(main); rm(home);
    }
  });

  // (a) diagnose surfaces an injected orphan + a 2-live-row split.
  test(`[${B.name}] diagnose surfaces an orphan partition and a 2-live-row split`, () => {
    const home = tmpHome();
    const main = makeGitRepo('dsurf-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const mainTop = topOf(main);
      const mainMesh = meshOf(main);
      // Two LIVE registry rows for the SAME worktree -> a split.
      seedB(home, repoKey, { id: 'live-a', worktreePath: mainTop, sessionId: 'sa' });
      seedB(home, repoKey, { id: 'live-b', worktreePath: mainTop, sessionId: 'sb' });
      // An orphan partition: unread messages, NO registry row.
      seedMsg(home, repoKey, 'orphan-ws', 'stuck-message', 'native:orphan1');

      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.strictEqual(d.result.ok, true);
      assert.strictEqual(d.result.action, 'diagnose');
      // Split: the 2-live-row worktree is flagged.
      assert.ok(d.result.splits.includes(mainMesh), 'the 2-live-row worktree meshId is flagged as a split');
      const mt = d.result.meshTargets.find((m) => m.meshId === mainMesh);
      assert.ok(mt && mt.liveRows === 2 && mt.split === true, 'meshTargets reports 2 live rows + split');
      assert.ok(mt.resolvesTo === 'live-a' || mt.resolvesTo === 'live-b', 'meshTargets shows which partition send resolves to');
      // Orphan surfaced.
      assert.ok(d.result.orphans.some((o) => o.id === 'orphan-ws' && o.unread >= 1), 'the orphan partition is surfaced with unread');
      // Registry rows present.
      assert.ok(d.result.registry.some((r) => r.id === 'live-a' && r.live === true), 'registry row live-a surfaced as live');
      assert.ok(d.result.registry.some((r) => r.id === 'live-b' && r.live === true), 'registry row live-b surfaced as live');
    } finally {
      rm(main); rm(home);
    }
  });
}
