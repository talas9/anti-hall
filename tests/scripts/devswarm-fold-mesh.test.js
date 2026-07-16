'use strict';
// #70 — updater + doctor MIGRATE all prior mesh forms into one canonical survivor
// per worktree. `foldMeshDuplicates` generalizes the (already-hardened)
// retireWorktreeDuplicates over the WHOLE registry, canonicalizing each row to its
// GIT TOPLEVEL first (so a legacy SUBDIR-SPLIT row folds onto its toplevel — the
// case a plain-hash grouping misses).
//
// Acceptance (both backends): build an OLD-shape store with
//   - a phantom row (store-only, sessionId null) on a live worktree,
//   - a SUBDIR-split store-only row (registered from a git subdirectory),
//     each carrying a forwardable direct backlog,
//   - a dual descriptor-backed pair on ONE worktree (the un-resolvable case),
//   - a stale registry row (worktreePath gone) with unread,
//   - an orphan partition (unread, no registry row),
//   - a pre-orphans summary.json (missing orphans[]/staleRegistryPartitions[]),
// then fold -> duplicates collapse to one survivor per canonical worktree, real
// directs are forwarded (NO loss), phantom/store-only rows are tombstoned,
// descriptor-backed rows are LEFT, the subdir-split folds via toplevel, and
// summary.json is re-derived with orphans[]/stale[]. A RE-RUN is a no-op
// (idempotent). Also exercised via the doctor `fold-mesh-duplicates` repair.
//
// Real git worktrees as cwd (repoKeyForWorktree spawns git). Mirrors
// devswarm-retire-duplicate.test.js / devswarm-diagnose.test.js.

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fold-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fold-repo-' + tag + '-'));
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
  const seedMsg = (home, repoKey, id, body, hash) => { const s = openS(home, repoKey); try { s.appendMessage({ workspaceId: id, body, hash, ts: Date.now() }); } finally { s.close(); } };
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

  // Build the OLD-shape store described in the header; returns { home, repoKey, W1, W2, W3ghost }.
  function seedOldStore(tag) {
    const home = tmpHome();
    const W1 = makeGitRepo('w1-' + tag);
    const W2 = makeGitRepo('w2-' + tag);
    const repoKey = repokey.repoKeyForWorktree(W1);

    // W1: live descriptor-backed survivor + a store-only PHANTOM (sessionId null),
    //     both on the SAME toplevel. Phantom carries a forwardable direct.
    seedReg(home, repoKey, { id: 'w1-live', worktreePath: topOf(W1), sessionId: 's1' });
    descFile(home, 'w1-live', { id: 'w1-live', worktreePath: topOf(W1), sessionId: 's1' });
    seedReg(home, repoKey, { id: 'w1-phantom', worktreePath: topOf(W1), sessionId: null });
    seedDirect(home, repoKey, 'w1-phantom', 'payload-phantom');
    // W1 SUBDIR-split: a store-only row registered from a git subdirectory of W1.
    const sub = path.join(topOf(W1), 'pkg', 'inner');
    fs.mkdirSync(sub, { recursive: true });
    seedReg(home, repoKey, { id: 'w1-subdir', worktreePath: sub, sessionId: null });
    seedDirect(home, repoKey, 'w1-subdir', 'payload-subdir');

    // W2: two descriptor-backed LIVE rows on one worktree — the un-resolvable dual
    //     case (both look like distinct live children) -> one is LEFT, never tombstoned.
    seedReg(home, repoKey, { id: 'w2-a', worktreePath: topOf(W2), sessionId: 'sa' });
    descFile(home, 'w2-a', { id: 'w2-a', worktreePath: topOf(W2), sessionId: 'sa' });
    seedReg(home, repoKey, { id: 'w2-b', worktreePath: topOf(W2), sessionId: 'sb' });
    descFile(home, 'w2-b', { id: 'w2-b', worktreePath: topOf(W2), sessionId: 'sb' });

    // A STALE registry row: worktreePath gone from disk, still holds unread.
    seedReg(home, repoKey, { id: 'w3-stale', worktreePath: '/nonexistent/gone-' + tag, sessionId: 's3' });
    seedMsg(home, repoKey, 'w3-stale', 'stale-unread', 'native:stale1');

    // An ORPHAN partition: unread, NO registry row.
    seedMsg(home, repoKey, 'orphan-ws', 'orphan-unread', 'native:orphan1');

    // A PRE-orphans summary.json: seed a summary WITHOUT the v0.61 orphans/stale
    // fields (mimic an old cached projection). Written directly at the summary path.
    const sp = storeLib.summaryPathForHash(home, repoKey);
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify({ generatedAt: Date.now() - 999999, workspaces: {}, recent: [] }));

    return { home, repoKey, W1, W2 };
  }
  function cleanup(env) { rm(env.W1); rm(env.W2); rm(env.home); }

  test(`[${B.name}] foldMeshDuplicates folds phantom + subdir-split, leaves descriptor-backed, no message loss`, () => {
    const E = seedOldStore('accept-' + B.name);
    try {
      const before = regIds(E.home, E.repoKey);
      assert.deepStrictEqual(before, ['w1-live', 'w1-phantom', 'w1-subdir', 'w2-a', 'w2-b', 'w3-stale'].sort(),
        'sanity: all seeded REGISTRY rows present');
      // orphan-ws is a message-only partition (no registry row) — correctly absent here.
      assert.ok(!before.includes('orphan-ws'), 'orphan-ws is message-only, not in the registry');

      const r = cli.foldMeshDuplicates(E.home, { cwd: E.W1, env: {}, backend: B.backend });
      assert.strictEqual(r.ok, true);
      // phantom + subdir-split store-only rows retired (subdir folded via toplevel).
      assert.deepStrictEqual(r.retired.slice().sort(), ['w1-phantom', 'w1-subdir'], 'store-only phantom + subdir-split rows tombstoned');
      // descriptor-backed dual pair: exactly one LEFT (never tombstoned).
      assert.ok(Array.isArray(r.left) && r.left.length === 1, 'one descriptor-backed dual row LEFT');
      assert.ok(['w2-a', 'w2-b'].includes(r.left[0]), 'the LEFT row is one of the dual pair');
      // both directs forwarded (no loss).
      assert.ok(r.forwarded >= 2, 'both real directs forwarded');

      const after = regIds(E.home, E.repoKey);
      assert.ok(!after.includes('w1-phantom'), 'phantom row gone');
      assert.ok(!after.includes('w1-subdir'), 'subdir-split row gone (folded to toplevel)');
      assert.ok(after.includes('w1-live'), 'the canonical survivor remains');
      assert.ok(after.includes('w2-a') && after.includes('w2-b'), 'BOTH descriptor-backed dual rows remain (un-resolvable, left)');
      assert.ok(after.includes('w3-stale'), 'the stale row is untouched by the fold (surface-only)');

      // NO message loss: the forwarded payloads landed in the survivor partition.
      const survBodies = bodies(E.home, E.repoKey, 'w1-live');
      assert.ok(survBodies.includes('payload-phantom'), 'phantom direct forwarded to survivor');
      assert.ok(survBodies.includes('payload-subdir'), 'subdir-split direct forwarded to survivor');

      // summary.json re-derived WITH the v0.61 orphans[]/stale[] fields.
      const sum = storeLib.readSummaryForHash(E.home, E.repoKey);
      assert.ok(Array.isArray(sum.orphans) && sum.orphans.some((o) => o.id === 'orphan-ws'), 'summary re-derived with orphans[] (orphan-ws)');
      assert.ok(Array.isArray(sum.staleRegistryPartitions) && sum.staleRegistryPartitions.some((o) => o.id === 'w3-stale'), 'summary re-derived with staleRegistryPartitions[] (w3-stale)');

      // IDEMPOTENT: a re-run tombstones nothing new.
      const r2 = cli.foldMeshDuplicates(E.home, { cwd: E.W1, env: {}, backend: B.backend });
      assert.deepStrictEqual(r2.retired, [], 're-run retires nothing (idempotent)');
      assert.deepStrictEqual(regIds(E.home, E.repoKey), after, 'registry unchanged on re-run');
    } finally { cleanup(E); }
  });

  test(`[${B.name}] foldMeshDuplicates dryRun classifies without writing`, () => {
    const E = seedOldStore('dry-' + B.name);
    try {
      const before = regIds(E.home, E.repoKey);
      const survBefore = bodies(E.home, E.repoKey, 'w1-live');
      const r = cli.foldMeshDuplicates(E.home, { cwd: E.W1, env: {}, backend: B.backend, dryRun: true });
      assert.deepStrictEqual(r.retired.slice().sort(), ['w1-phantom', 'w1-subdir'], 'dryRun classifies would-retire rows');
      assert.ok(Array.isArray(r.left) && r.left.length === 1, 'dryRun classifies the LEFT row');
      // NOTHING mutated.
      assert.deepStrictEqual(regIds(E.home, E.repoKey), before, 'dryRun did not tombstone');
      assert.deepStrictEqual(bodies(E.home, E.repoKey, 'w1-live'), survBefore, 'dryRun did not forward');
    } finally { cleanup(E); }
  });
}

// Doctor entrypoint (journal backend, isolated tmp HOME): the AUTO-SAFE
// `fold-mesh-duplicates` repair sees the drift (dry-run detect) and applies it.
// Gate stays CLOSED (no DEVSWARM_REPO_ID) so no daemon/scheduler is ever spawned;
// every write lands under the tmp HOME.
test('doctor repair: fold-mesh-duplicates detects (dry-run) and folds (apply)', () => {
  const home = tmpHome();
  const W1 = makeGitRepo('doc-w1');
  const W2 = makeGitRepo('doc-w2');
  const repoKey = repokey.repoKeyForWorktree(W1);
  const openS = () => storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  const seedReg = (desc) => { const s = openS(); try { s.upsertRegistry(desc); } finally { s.close(); } };
  const descFile = (id, desc) => { const p = cli.descriptorPath(home, id); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(desc)); };
  const regIds = () => { const s = openS(); try { return s.listRegistry().map((d) => d.id).sort(); } finally { s.close(); } };
  try {
    seedReg({ id: 'live', worktreePath: topOf(W1), sessionId: 's1' });
    descFile('live', { id: 'live', worktreePath: topOf(W1), sessionId: 's1' });
    seedReg({ id: 'phantom', worktreePath: topOf(W1), sessionId: null });

    // env: gate CLOSED (no DEVSWARM_REPO_ID) + force journal backend + HOME=tmp so
    // any AUTO-SAFE installer spawn writes only under the isolated HOME.
    const env = { HOME: home, ANTIHALL_DEVSWARM_STORE_BACKEND: 'journal', PATH: process.env.PATH };
    const find = (res) => res.find((x) => x.id === 'fold-mesh-duplicates');

    // dry-run detect: reports it WOULD fold the phantom.
    const dry = doctorRepair.runRepairs({ cwd: W1, env, home, dryRun: true });
    const dEntry = find(dry);
    assert.ok(dEntry, 'doctor wires a fold-mesh-duplicates repair');
    assert.strictEqual(dEntry.status, 'skipped', 'dry-run reports skipped');
    assert.match(dEntry.msg, /would migrate.*duplicate mesh row/, 'dry-run detail names the drift');
    assert.deepStrictEqual(regIds(), ['live', 'phantom'], 'dry-run mutated nothing');

    // apply: folds the phantom for real.
    const applied = doctorRepair.runRepairs({ cwd: W1, env, home, dryRun: false });
    const aEntry = find(applied);
    assert.ok(aEntry, 'fold entry present on apply');
    assert.strictEqual(aEntry.status, 'fixed', 'apply reports fixed');
    assert.deepStrictEqual(regIds(), ['live'], 'phantom folded away, survivor kept');
  } finally { rm(W1); rm(W2); rm(home); }
});
