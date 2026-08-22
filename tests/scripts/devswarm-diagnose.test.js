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

  // HAZARD 2 — a 2-row group with ZERO live rows must report the DANGEROUS
  // split ("deadSplit"), not `splits: []` — the pre-fix blind spot: liveRows
  // is 0, so the old `liveRows >= 2` check reports clean while mail strands.
  test(`[${B.name}] diagnose on a 2-row ZERO-live group reports the dangerous deadSplit (not silent)`, () => {
    const home = tmpHome();
    const main = makeGitRepo('ddead-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const mainTop = topOf(main);
      const mainMesh = meshOf(main);
      // Two registry rows, NEITHER live: sessionId null, and the SYNTHETIC
      // unclaimed: prefix — both fail isLiveSessionId (matches the measured
      // primary-63f9261d field shape).
      seedB(home, repoKey, { id: 'row-a', worktreePath: mainTop, sessionId: null });
      seedB(home, repoKey, { id: 'row-b', worktreePath: mainTop, sessionId: 'unclaimed:row-b' });

      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.strictEqual(d.result.ok, true);
      // The old benign `splits` stays empty (liveRows is 0, correctly not a
      // "2 live tabs" split) — the danger is NOT reported through that field.
      assert.ok(!d.result.splits.includes(mainMesh), 'benign splits[] does not carry the zero-live case');
      // The NEW explicit field DOES report it.
      assert.ok(d.result.deadSplits.includes(mainMesh), 'deadSplits[] reports the zero-live danger — not silently clean');
      const mt = d.result.meshTargets.find((m) => m.meshId === mainMesh);
      assert.ok(mt, 'meshTargets entry present for the group');
      assert.strictEqual(mt.liveRows, 0, 'sanity: zero live rows');
      assert.strictEqual(mt.split, false, 'benign split flag stays false (unchanged meaning)');
      assert.strictEqual(mt.deadSplit, true, 'deadSplit flag reports the dangerous kind');
      assert.ok(mt.resolvesTo === 'row-a' || mt.resolvesTo === 'row-b', 'resolvesTo is still populated for the dangerous kind');
    } finally {
      rm(main); rm(home);
    }
  });

  // diagnose on a 2+ LIVE group still reports the benign split exactly as
  // before (deadSplits stays empty) — regression guard alongside the new case.
  test(`[${B.name}] diagnose on a 2+ live group reports the benign split, deadSplits stays empty`, () => {
    const home = tmpHome();
    const main = makeGitRepo('dbenign-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const mainTop = topOf(main);
      const mainMesh = meshOf(main);
      seedB(home, repoKey, { id: 'live-a', worktreePath: mainTop, sessionId: 'sa' });
      seedB(home, repoKey, { id: 'live-b', worktreePath: mainTop, sessionId: 'sb' });

      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.strictEqual(d.result.ok, true);
      assert.ok(d.result.splits.includes(mainMesh), 'benign split still reported as before');
      assert.ok(!d.result.deadSplits.includes(mainMesh), 'deadSplits stays empty for a live split');
    } finally {
      rm(main); rm(home);
    }
  });

  // healthcheck: the dangerous kind gates degraded AND the human line surfaces
  // it distinctly (not blended into the benign splits= count).
  test(`[${B.name}] healthcheck reports degraded with a distinct deadSplits warning on the human line`, () => {
    const home = tmpHome();
    const main = makeGitRepo('dhc-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const mainTop = topOf(main);
      seedB(home, repoKey, { id: 'row-a', worktreePath: mainTop, sessionId: null });
      seedB(home, repoKey, { id: 'row-b', worktreePath: mainTop, sessionId: 'unclaimed:row-b' });

      const h = cli.run(['healthcheck'], bctx(home, { cwd: main }));
      assert.strictEqual(h.result.ok, false, 'degraded — exit-signal fires for the dangerous kind');
      assert.strictEqual(h.result.status, 'degraded');
      assert.strictEqual(h.result.counts.splits, 0, 'benign splits count stays 0');
      assert.strictEqual(h.result.counts.deadSplits, 1, 'deadSplits count is 1');

      const line = cli.healthcheckHumanLine(h.result);
      assert.match(line, /deadSplits=1/, 'human line carries the deadSplits count');
      assert.match(line, /WARNING/, 'human line surfaces the dangerous kind distinctly (not blended into splits=)');
    } finally {
      rm(main); rm(home);
    }
  });
}

// HAZARD 2 fail-open: a throw inside the split computation (resolveMeshTarget,
// called per-group from computeDiagnosis) must never crash diagnose — it
// degrades that ONE group's target/split flags to neutral, never propagates.
// Exercises computeDiagnosis directly against a REAL store handle whose
// listRegistry() is wrapped to throw on its 3rd call — measured (via a
// one-off instrumented run of this exact fixture) to land on the per-group
// resolveMeshTarget() call inside computeDiagnosis's loop (call #1 =
// store.computeSummary's internal read, #2 = computeDiagnosis's own
// `s.listRegistry()`, #3 = resolveMeshTarget's internal
// `storeHandle.listRegistry()` for the one seeded group).
test('computeDiagnosis fail-open: a throw inside the split computation does not crash diagnose', () => {
  const home = tmpHome();
  const main = makeGitRepo('dfailopen');
  try {
    const repoKey = repokey.repoKeyForWorktree(main);
    const mainTop = topOf(main);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      s.upsertRegistry({ id: 'row-a', worktreePath: mainTop, sessionId: null });
      let calls = 0;
      const origListRegistry = s.listRegistry.bind(s);
      s.listRegistry = (...args) => {
        calls++;
        if (calls >= 3) throw new Error('boom — injected split-computation failure');
        return origListRegistry(...args);
      };
      let d;
      assert.doesNotThrow(() => { d = cli.computeDiagnosis(s, { home, env: {} }); },
        'computeDiagnosis must not throw when the per-group split computation throws');
      assert.ok(Array.isArray(d.meshTargets) && d.meshTargets.length === 1, 'the group is still present, degraded to neutral');
      assert.strictEqual(d.meshTargets[0].split, false, 'degraded liveSplit is neutral (false), not a crash');
      assert.strictEqual(d.meshTargets[0].deadSplit, false, 'degraded deadSplit is neutral (false), not a crash');
      assert.strictEqual(d.meshTargets[0].resolvesTo, null, 'degraded resolvesTo is neutral (null)');
      assert.deepStrictEqual(d.splits, [], 'no split falsely reported from a degraded group');
      assert.deepStrictEqual(d.deadSplits, [], 'no deadSplit falsely reported from a degraded group');
    } finally { s.close(); }
  } finally {
    rm(main); rm(home);
  }
});
