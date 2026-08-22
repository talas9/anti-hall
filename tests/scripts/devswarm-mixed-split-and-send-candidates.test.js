'use strict';
// TRACED P0 — two coupled defects in DevSwarm's split detector and send/diagnose
// membership.
//
// DEFECT A: the pre-fix split predicate was two INDEPENDENT checks
// (`liveSplit = liveRows>=2`, `deadSplit = rows.length>=2 && liveRows===0`) that
// left EXACTLY ONE shape uncovered: `rows.length>=2 && liveRows===1` (one live
// row, one+ dead rows on the same meshId) — matched neither check, so it scored
// split:false/deadSplit:false/splits:[], invisible even though a `send` could
// still resolve to the dead row on a subsequent call. Fixed by classifying ALL
// partitioned shapes from ONE predicate (`kind`: 'live'|'mixed'|'dead'), adding
// `mixedSplit`/`mixedSplits` alongside the PRESERVED `split`/`deadSplit`/
// `splits`/`deadSplits` keys, and gating `healthcheck`'s `degraded` on the new
// mixed count too.
//
// DEFECT B: `send`'s only resolution path (resolveMeshTarget) matched registry
// rows by their RAW stored worktreePath hash, while `diagnose` groups by
// canonicalMeshId (git-toplevel-resolved) — so a subdir-registered row was
// inside diagnose's group but NOT a send candidate for that same meshId. Fixed
// by unifying resolveMeshTarget's matching on canonicalMeshId (a pure per-call
// read, no registry write/lock — see meshCandidateRows' header for why this was
// chosen over mutating the registry via rekeySubdirRegistryRows on the send
// path). `send` also now REPORTS (never blocks on) how many candidate rows its
// resolved meshId group had, plus the chosen `toId`.
//
// Real git worktrees as cwd (repoKeyForWorktree/canonicalMeshId spawn git).
// Mirrors devswarm-diagnose.test.js / devswarm-send.test.js / devswarm-fold-mesh.test.js.

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-mixed-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-mixed-repo-' + tag + '-'));
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
function addLinkedWorktree(mainDir, tag) {
  const wt = path.join(path.dirname(mainDir), path.basename(mainDir) + '-wt-' + tag);
  cp.spawnSync('git', ['-C', mainDir, 'worktree', 'add', wt, '-b', 'branch-' + tag]);
  return wt;
}

const backends = [{ name: 'journal', backend: 'journal' }];
if (storeLib.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

for (const B of backends) {
  const bctx = (home, over) => Object.assign({ home, backend: B.backend, env: {} }, over || {});
  const seedB = (home, repoKey, desc) => {
    const s = storeLib.openStore({ home, hash: repoKey, backend: B.backend });
    try { s.upsertRegistry(desc); } finally { s.close(); }
  };

  // (1) 2 rows / 2 live -> `live` split, still reported as today (regression guard).
  test(`[${B.name}] 2 rows / 2 live -> kind 'live', split reported unchanged`, () => {
    const home = tmpHome();
    const main = makeGitRepo('live2-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const mainTop = topOf(main);
      const mainMesh = meshOf(main);
      seedB(home, repoKey, { id: 'live-a', worktreePath: mainTop, sessionId: 'sa' });
      seedB(home, repoKey, { id: 'live-b', worktreePath: mainTop, sessionId: 'sb' });

      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.strictEqual(d.result.ok, true);
      assert.ok(d.result.splits.includes(mainMesh), 'benign split still reported');
      assert.ok(!d.result.deadSplits.includes(mainMesh), 'not a dead split');
      assert.ok(!d.result.mixedSplits.includes(mainMesh), 'not a mixed split');
      const mt = d.result.meshTargets.find((m) => m.meshId === mainMesh);
      assert.strictEqual(mt.kind, 'live', 'kind is live');
      assert.strictEqual(mt.split, true);
      assert.strictEqual(mt.deadSplit, false);
      assert.strictEqual(mt.mixedSplit, false);
    } finally { rm(main); rm(home); }
  });

  // (2) 2 rows / 1 live -> the field-reported blind spot: `mixed`, reported,
  // and `degraded` is true.
  test(`[${B.name}] 2 rows / 1 live -> kind 'mixed', reported, healthcheck degraded`, () => {
    const home = tmpHome();
    const main = makeGitRepo('mixed-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const mainTop = topOf(main);
      const mainMesh = meshOf(main);
      seedB(home, repoKey, { id: 'live-a', worktreePath: mainTop, sessionId: 'sa' });
      seedB(home, repoKey, { id: 'dead-b', worktreePath: mainTop, sessionId: null });

      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.strictEqual(d.result.ok, true);
      // The pre-fix blind spot: neither `splits` nor `deadSplits` carries this shape.
      assert.ok(!d.result.splits.includes(mainMesh), 'not the benign 2+ live split');
      assert.ok(!d.result.deadSplits.includes(mainMesh), 'not the zero-live dead split');
      assert.ok(d.result.mixedSplits.includes(mainMesh), 'mixedSplits reports the previously-invisible shape');
      const mt = d.result.meshTargets.find((m) => m.meshId === mainMesh);
      assert.strictEqual(mt.kind, 'mixed');
      assert.strictEqual(mt.liveRows, 1);
      assert.strictEqual(mt.split, false);
      assert.strictEqual(mt.deadSplit, false);
      assert.strictEqual(mt.mixedSplit, true);
      assert.strictEqual(mt.resolvesTo, 'live-a', 'resolvesTo the live row');

      const h = cli.run(['healthcheck'], bctx(home, { cwd: main }));
      assert.strictEqual(h.result.ok, false, 'healthcheck is degraded — field case that used to report clean');
      assert.strictEqual(h.result.status, 'degraded');
      assert.strictEqual(h.result.counts.mixedSplits, 1);
      assert.strictEqual(h.result.counts.splits, 0);
      assert.strictEqual(h.result.counts.deadSplits, 0);
      const line = cli.healthcheckHumanLine(h.result);
      assert.match(line, /mixedSplits=1/, 'human line carries the mixedSplits count');
      assert.match(line, /WARNING/, 'human line warns on the mixed shape');
    } finally { rm(main); rm(home); }
  });

  // (3) 2 rows / 0 live -> `dead`, as v0.77.1 shipped (regression guard).
  test(`[${B.name}] 2 rows / 0 live -> kind 'dead', unchanged from v0.77.1`, () => {
    const home = tmpHome();
    const main = makeGitRepo('dead2-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const mainTop = topOf(main);
      const mainMesh = meshOf(main);
      seedB(home, repoKey, { id: 'row-a', worktreePath: mainTop, sessionId: null });
      seedB(home, repoKey, { id: 'row-b', worktreePath: mainTop, sessionId: 'unclaimed:row-b' });

      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.ok(d.result.deadSplits.includes(mainMesh));
      assert.ok(!d.result.splits.includes(mainMesh));
      assert.ok(!d.result.mixedSplits.includes(mainMesh));
      const mt = d.result.meshTargets.find((m) => m.meshId === mainMesh);
      assert.strictEqual(mt.kind, 'dead');
      assert.strictEqual(mt.deadSplit, true);
      assert.strictEqual(mt.mixedSplit, false);
    } finally { rm(main); rm(home); }
  });

  // (4) 1 row -> not partitioned.
  test(`[${B.name}] 1 row -> not partitioned (kind null, no split flags)`, () => {
    const home = tmpHome();
    const main = makeGitRepo('single-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const mainTop = topOf(main);
      const mainMesh = meshOf(main);
      seedB(home, repoKey, { id: 'only-a', worktreePath: mainTop, sessionId: 's' });

      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      assert.deepStrictEqual(d.result.splits, []);
      assert.deepStrictEqual(d.result.deadSplits, []);
      assert.deepStrictEqual(d.result.mixedSplits, []);
      const mt = d.result.meshTargets.find((m) => m.meshId === mainMesh);
      assert.strictEqual(mt.kind, null);
      assert.strictEqual(mt.split, false);
      assert.strictEqual(mt.deadSplit, false);
      assert.strictEqual(mt.mixedSplit, false);
      assert.strictEqual(mt.resolvesTo, 'only-a', 'resolvesTo still populated for a non-partitioned group');
    } finally { rm(main); rm(home); }
  });

  // (5) resolvesTo present for all three partitioned kinds — asserted inline
  // above for live/mixed/dead; this test double-checks all three together in
  // one registry so the assertion holds across the SAME computeDiagnosis call.
  test(`[${B.name}] resolvesTo is populated for live, mixed, and dead groups in one diagnose call`, () => {
    const home = tmpHome();
    const live2 = makeGitRepo('rt-live-' + B.name);
    const mixed2 = makeGitRepo('rt-mixed-' + B.name);
    const dead2 = makeGitRepo('rt-dead-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(live2);
      // NB: repoKeyForWorktree is per git-common-dir; each makeGitRepo is its
      // own independent repo, so each has its OWN repoKey. Seed each into its
      // own store and diagnose from its own cwd.
      const liveMesh = meshOf(live2);
      seedB(home, repokey.repoKeyForWorktree(live2), { id: 'l-a', worktreePath: topOf(live2), sessionId: 's1' });
      seedB(home, repokey.repoKeyForWorktree(live2), { id: 'l-b', worktreePath: topOf(live2), sessionId: 's2' });
      const dLive = cli.run(['diagnose'], bctx(home, { cwd: live2 }));
      assert.ok(['l-a', 'l-b'].includes(dLive.result.meshTargets.find((m) => m.meshId === liveMesh).resolvesTo));

      const mixedMesh = meshOf(mixed2);
      seedB(home, repokey.repoKeyForWorktree(mixed2), { id: 'm-a', worktreePath: topOf(mixed2), sessionId: 's1' });
      seedB(home, repokey.repoKeyForWorktree(mixed2), { id: 'm-b', worktreePath: topOf(mixed2), sessionId: null });
      const dMixed = cli.run(['diagnose'], bctx(home, { cwd: mixed2 }));
      assert.strictEqual(dMixed.result.meshTargets.find((m) => m.meshId === mixedMesh).resolvesTo, 'm-a');

      const deadMesh = meshOf(dead2);
      seedB(home, repokey.repoKeyForWorktree(dead2), { id: 'd-a', worktreePath: topOf(dead2), sessionId: null });
      seedB(home, repokey.repoKeyForWorktree(dead2), { id: 'd-b', worktreePath: topOf(dead2), sessionId: null });
      const dDead = cli.run(['diagnose'], bctx(home, { cwd: dead2 }));
      assert.ok(['d-a', 'd-b'].includes(dDead.result.meshTargets.find((m) => m.meshId === deadMesh).resolvesTo));
    } finally { rm(live2); rm(mixed2); rm(dead2); rm(home); }
  });

  // (6) send with a >1 candidate set reports the count and the chosen id, and
  // still DELIVERS (never blocks).
  test(`[${B.name}] send with a 2-row candidate set reports candidates:2 + toId, and still delivers`, () => {
    const home = tmpHome();
    const main = makeGitRepo('sendcand-' + B.name);
    // Sender must be a DIFFERENT registered worktree SHARING main's git-common-dir
    // (a real linked worktree) so repoKeyForWorktree resolves to the SAME store
    // and `send --to <meshId>` is not self-addressing — mirrors
    // devswarm-send.test.js's own addLinkedWorktree pattern.
    const sender = addLinkedWorktree(main, 'cand-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const mainTop = topOf(main);
      const mainMesh = meshOf(main);
      seedB(home, repoKey, { id: 'live-a', worktreePath: mainTop, sessionId: 'sa' });
      seedB(home, repoKey, { id: 'dead-b', worktreePath: mainTop, sessionId: null });

      const r = cli.run(
        ['send', '--to', mainMesh, '--message', 'hello'],
        bctx(home, { cwd: sender }),
      );
      assert.strictEqual(r.result.ok, true, 'send still delivers despite the 2-row candidate set');
      assert.strictEqual(r.result.candidates, 2, 'send reports the 2-row candidate set');
      assert.strictEqual(r.result.toId, 'live-a', 'delivered to the freshest-live candidate');
    } finally { rm(main); rm(sender); rm(home); }
  });

  // (7) send with exactly 1 candidate reports 1 and is unchanged.
  test(`[${B.name}] send with a 1-row candidate set reports candidates:1`, () => {
    const home = tmpHome();
    const main = makeGitRepo('sendone-' + B.name);
    const sender = addLinkedWorktree(main, 'one-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const mainTop = topOf(main);
      const mainMesh = meshOf(main);
      seedB(home, repoKey, { id: 'only-a', worktreePath: mainTop, sessionId: 'sa' });

      const r = cli.run(
        ['send', '--to', mainMesh, '--message', 'hi'],
        bctx(home, { cwd: sender }),
      );
      assert.strictEqual(r.result.ok, true);
      assert.strictEqual(r.result.candidates, 1);
      assert.strictEqual(r.result.toId, 'only-a');
    } finally { rm(main); rm(sender); rm(home); }
  });

  // (8) membership agreement: `send` and `diagnose` now agree on group
  // membership for a subdir-registered row — resolveMeshTarget was changed to
  // match on canonicalMeshId (same identity groupRegistryByMeshId uses), a pure
  // per-call read (no registry write), rather than mutating the row via
  // rekeySubdirRegistryRows on the send path (rejected: that requires a per-id
  // lock + write on every send for what is purely a read-side identity
  // mismatch, and already self-heals independently via foldMeshDuplicates).
  test(`[${B.name}] send and diagnose agree on membership for a subdir-registered row`, () => {
    const home = tmpHome();
    const main = makeGitRepo('subdiragree-' + B.name);
    const sender = addLinkedWorktree(main, 'subdir-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const mainTop = topOf(main);
      const mainMesh = meshOf(main);
      // A row registered from a git SUBDIRECTORY of `main`, not its toplevel —
      // its RAW-path hash differs from mainMesh, but its canonicalMeshId (via
      // git-toplevel resolution) equals mainMesh.
      const sub = path.join(mainTop, 'pkg', 'inner');
      fs.mkdirSync(sub, { recursive: true });
      seedB(home, repoKey, { id: 'subdir-row', worktreePath: sub, sessionId: 'ss' });

      // diagnose groups the subdir row under mainMesh (canonicalMeshId, unchanged behavior).
      const d = cli.run(['diagnose'], bctx(home, { cwd: main }));
      const mt = d.result.meshTargets.find((m) => m.meshId === mainMesh);
      assert.ok(mt, 'diagnose groups the subdir row under the toplevel meshId');
      assert.ok(mt.ids.includes('subdir-row'), 'the subdir row is a member of that group');
      assert.strictEqual(mt.resolvesTo, 'subdir-row', 'diagnose shows send would resolve here');

      // send --to <mainMesh> must resolve to the SAME row — this is the exact
      // disagreement DEFECT B reported (diagnose saw it, send did not).
      const r = cli.run(
        ['send', '--to', mainMesh, '--message', 'reach the subdir row'],
        bctx(home, { cwd: sender }),
      );
      assert.strictEqual(r.result.ok, true, 'send resolves the meshId diagnose already grouped it under');
      assert.strictEqual(r.result.toId, 'subdir-row', 'send and diagnose now agree on which row this is');
      assert.strictEqual(r.result.candidates, 1, 'exactly one candidate in this group');
    } finally { rm(main); rm(sender); rm(home); }
  });

  // fail-open: a throw inside classification leaves diagnose/send working.
  test(`[${B.name}] fail-open: a throw inside per-group classification does not crash diagnose or send`, () => {
    const home = tmpHome();
    const main = makeGitRepo('failopen-' + B.name);
    try {
      const repoKey = repokey.repoKeyForWorktree(main);
      const mainTop = topOf(main);
      const s = storeLib.openStore({ home, hash: repoKey, backend: B.backend });
      try {
        s.upsertRegistry({ id: 'row-a', worktreePath: mainTop, sessionId: 'sa' });
        s.upsertRegistry({ id: 'row-b', worktreePath: mainTop, sessionId: null });
        let calls = 0;
        const origListRegistry = s.listRegistry.bind(s);
        s.listRegistry = (...args) => {
          calls++;
          if (calls >= 3) throw new Error('boom — injected classification failure');
          return origListRegistry(...args);
        };
        let d;
        assert.doesNotThrow(() => { d = cli.computeDiagnosis(s, { home, env: {} }); },
          'computeDiagnosis must not throw when per-group classification throws');
        const mt = d.meshTargets.find((m) => m.ids.includes('row-a'));
        assert.strictEqual(mt.kind, null, 'degraded kind is neutral (null), not a crash');
        assert.strictEqual(mt.split, false);
        assert.strictEqual(mt.deadSplit, false);
        assert.strictEqual(mt.mixedSplit, false);
        assert.strictEqual(mt.resolvesTo, null);
        assert.deepStrictEqual(d.mixedSplits, [], 'no mixedSplit falsely reported from a degraded group');
      } finally { s.close(); }
    } finally { rm(main); rm(home); }
  });
}
