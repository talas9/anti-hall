'use strict';
// healOrphanPartitions — self-heal for a partition that has REAL messages but NO
// registry row: structurally invisible to every existing fold path
// (foldMeshDuplicates groups s.listRegistry(), so an unregistered id is never a
// candidate/survivor/forward target). deriveSummary's `orphans[]` already DETECTS
// this shape read-only (companion/lib/devswarm-store.js); this exercises the HEAL.
//
// Loss-free, additive-only contract under test:
//   - a descriptor-backed orphan is ADOPTED (s.upsertRegistry — purely additive)
//     and, when a live family exists (canonicalMeshId(desc.worktreePath) matches
//     an existing registry group), its unread is forwarded into that family's
//     pickSurvivor via foldGroupIntoSurvivor (which, because the descriptor still
//     exists, always LEAVES the adopted row — never tombstones it).
//   - a descriptor-LESS orphan is UNHEALABLE: detect-and-report only, ZERO writes.
//   - an orphan with an ALREADY-ARCHIVED counterpart is never re-adopted, but its
//     unread is still forwarded into the family survivor.
//   - cursor reconciliation across the three namespaces (primaryCursorPath JSON,
//     descriptor .cursor file, store cursorValue) is MIN-only — never raised.
//
// Real git worktrees as cwd (repoKeyForWorktree spawns git). Mirrors
// devswarm-fold-mesh.test.js's fixture conventions.

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
const inboxCursor = require('../../plugins/anti-hall/companion/lib/devswarm-inbox-cursor.js');
const doctorRepair = require('../../plugins/anti-hall/hooks/lib/doctor-repair.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-healorphan-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-healorphan-repo-' + tag + '-'));
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
  const archiveFile = (home, id) => {
    const p = path.join(cli.archivedDir(home), id + '.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ id }));
  };
  const regIds = (home, repoKey) => { const s = openS(home, repoKey); try { return s.listRegistry().map((d) => d.id).sort(); } finally { s.close(); } };
  const bodies = (home, repoKey, id) => { const s = openS(home, repoKey); try { return s.listMessages(id, {}).map((m) => m.body); } finally { s.close(); } };
  const cursorFilePath = (home, id) => path.join(liveness.devswarmRoot(home), 'cursors', id + '.cursor');

  test(`[${B.name}] LOSS-PROOF: orphan with N messages + a live family survivor -> every body retrievable, count >= N`, () => {
    const home = tmpHome();
    const W1 = makeGitRepo('lossproof-' + B.name);
    const repoKey = repokey.repoKeyForWorktree(W1);
    try {
      // Live family: a registered survivor on W1's toplevel.
      seedReg(home, repoKey, { id: 'fam-live', worktreePath: topOf(W1), sessionId: 's1' });
      descFile(home, 'fam-live', { id: 'fam-live', worktreePath: topOf(W1), sessionId: 's1' });

      // Orphan on the SAME worktree: messages, no registry row, but a descriptor
      // (so it derives the same familyKey as fam-live).
      descFile(home, 'orphan-a', { id: 'orphan-a', worktreePath: topOf(W1), sessionId: null });
      seedDirect(home, repoKey, 'orphan-a', 'orphan-msg-1');
      seedDirect(home, repoKey, 'orphan-a', 'orphan-msg-2');

      assert.ok(!regIds(home, repoKey).includes('orphan-a'), 'sanity: orphan-a has no registry row yet');

      const r = cli.healOrphanPartitions(home, { cwd: W1, env: {}, backend: B.backend });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.adopted, 1, 'orphan-a adopted');
      assert.ok(r.forwarded >= 2, 'both messages forwarded');

      // Adopted row is now in the registry (additive, not a replacement).
      assert.ok(regIds(home, repoKey).includes('orphan-a'), 'orphan-a is now a registry row');
      assert.ok(regIds(home, repoKey).includes('fam-live'), 'the survivor is untouched');

      // NO LOSS: every original body retrievable via the survivor partition.
      const survBodies = bodies(home, repoKey, 'fam-live');
      assert.ok(survBodies.includes('orphan-msg-1'), 'msg-1 retrievable via survivor');
      assert.ok(survBodies.includes('orphan-msg-2'), 'msg-2 retrievable via survivor');

      // The ORIGINAL orphan partition also still has its own rows (append-only,
      // never deleted) — total count across the union is >= N.
      const origBodies = bodies(home, repoKey, 'orphan-a');
      assert.strictEqual(origBodies.length, 2, 'original partition rows untouched (no delete)');
    } finally { rm(W1); rm(home); }
  });

  test(`[${B.name}] idempotency: second run adopts/forwards nothing new, message counts byte-identical`, () => {
    const home = tmpHome();
    const W1 = makeGitRepo('idem-' + B.name);
    const repoKey = repokey.repoKeyForWorktree(W1);
    try {
      seedReg(home, repoKey, { id: 'fam-live', worktreePath: topOf(W1), sessionId: 's1' });
      descFile(home, 'fam-live', { id: 'fam-live', worktreePath: topOf(W1), sessionId: 's1' });
      descFile(home, 'orphan-a', { id: 'orphan-a', worktreePath: topOf(W1), sessionId: null });
      seedDirect(home, repoKey, 'orphan-a', 'idem-msg');

      const r1 = cli.healOrphanPartitions(home, { cwd: W1, env: {}, backend: B.backend });
      assert.strictEqual(r1.adopted, 1);
      const survBodiesAfter1 = bodies(home, repoKey, 'fam-live');

      const r2 = cli.healOrphanPartitions(home, { cwd: W1, env: {}, backend: B.backend });
      assert.strictEqual(r2.adopted, 0, 're-run adopts nothing (already registered)');
      assert.strictEqual(r2.forwarded, 0, 're-run forwards nothing new');
      assert.deepStrictEqual(bodies(home, repoKey, 'fam-live'), survBodiesAfter1, 'message counts byte-identical after re-run');
    } finally { rm(W1); rm(home); }
  });

  test(`[${B.name}] orphan with NO descriptor -> unhealable, ZERO store writes`, () => {
    const home = tmpHome();
    const W1 = makeGitRepo('nodesc-' + B.name);
    const repoKey = repokey.repoKeyForWorktree(W1);
    try {
      // An unrelated LIVE registry row, to prove its write_seq is untouched.
      seedReg(home, repoKey, { id: 'unrelated-live', worktreePath: topOf(W1), sessionId: 's1' });
      descFile(home, 'unrelated-live', { id: 'unrelated-live', worktreePath: topOf(W1), sessionId: 's1' });
      const before = openS(home, repoKey);
      let beforeRow;
      try { beforeRow = before.listRegistry().find((d) => d.id === 'unrelated-live'); } finally { before.close(); }

      // Orphan with NO descriptor file at all.
      seedDirect(home, repoKey, 'orphan-nodesc', 'unreachable-msg');
      assert.ok(!cli.readDescriptorFile(home, 'orphan-nodesc'), 'sanity: no descriptor exists');

      const r = cli.healOrphanPartitions(home, { cwd: W1, env: {}, backend: B.backend });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.adopted, 0, 'nothing adopted');
      assert.strictEqual(r.unhealable, 1, 'the descriptor-less orphan is unhealable');
      assert.ok(!regIds(home, repoKey).includes('orphan-nodesc'), 'never adopted into the registry');

      const after = openS(home, repoKey);
      let afterRow;
      try { afterRow = after.listRegistry().find((d) => d.id === 'unrelated-live'); } finally { after.close(); }
      assert.strictEqual(afterRow.writeSeq, beforeRow.writeSeq, 'an unrelated registry row write_seq is UNCHANGED — zero store writes occurred');
      assert.strictEqual(afterRow.updatedAt, beforeRow.updatedAt, 'updatedAt unchanged too');
    } finally { rm(W1); rm(home); }
  });

  test(`[${B.name}] orphan WITH an archived counterpart: not re-adopted, unread still forwarded`, () => {
    const home = tmpHome();
    const W1 = makeGitRepo('archived-' + B.name);
    const repoKey = repokey.repoKeyForWorktree(W1);
    try {
      seedReg(home, repoKey, { id: 'fam-live', worktreePath: topOf(W1), sessionId: 's1' });
      descFile(home, 'fam-live', { id: 'fam-live', worktreePath: topOf(W1), sessionId: 's1' });

      descFile(home, 'orphan-arch', { id: 'orphan-arch', worktreePath: topOf(W1), sessionId: null });
      archiveFile(home, 'orphan-arch'); // already archived — must NOT be re-adopted
      seedDirect(home, repoKey, 'orphan-arch', 'archived-unread');

      const r = cli.healOrphanPartitions(home, { cwd: W1, env: {}, backend: B.backend });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.adopted, 0, 'the archived counterpart is NEVER re-adopted');
      assert.ok(r.forwarded >= 1, 'its unread is still forwarded');
      assert.ok(!regIds(home, repoKey).includes('orphan-arch'), 'still absent from the registry');

      // FIX B: a forward out of an ARCHIVED source now carries a provenance
      // marker (never a bare verbatim body), so a resurfaced message is never
      // mistaken for fresh traffic.
      const survBodies = bodies(home, repoKey, 'fam-live');
      assert.ok(
        survBodies.some((b) => b.includes('archived-unread') && b.startsWith('[forwarded from archived orphan-arch]')),
        'the archived id unread landed in the survivor, provenance-marked'
      );
    } finally { rm(W1); rm(home); }
  });

  test(`[${B.name}] cursor MIN: json=5, .cursor=2 -> both end at 2, never raised`, () => {
    const home = tmpHome();
    const W1 = makeGitRepo('cursor-' + B.name);
    const repoKey = repokey.repoKeyForWorktree(W1);
    try {
      descFile(home, 'orphan-cur', { id: 'orphan-cur', worktreePath: topOf(W1), sessionId: null, cursorPath: cursorFilePath(home, 'orphan-cur') });
      seedDirect(home, repoKey, 'orphan-cur', 'cur-msg-1');

      // Seed the two file-based cursor namespaces at DIFFERENT values, and the
      // store's own cursor row at the SAME floor (2) as the .cursor file — the
      // MIN is taken across all THREE namespaces (json/.cursor/store), so the
      // store cursor must not sit BELOW the intended floor or it would itself
      // become the (correct, but untested-here) minimum.
      const jsonPath = cli.primaryCursorPath(home, 'orphan-cur');
      fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
      fs.writeFileSync(jsonPath, '5');
      const fileCursorPath = cursorFilePath(home, 'orphan-cur');
      fs.mkdirSync(path.dirname(fileCursorPath), { recursive: true });
      fs.writeFileSync(fileCursorPath, '2');
      const sPre = openS(home, repoKey);
      try { sPre.setCursor('orphan-cur', 2); } finally { sPre.close(); }

      const r = cli.healOrphanPartitions(home, { cwd: W1, env: {}, backend: B.backend });
      assert.strictEqual(r.ok, true);

      assert.strictEqual(inboxCursor.readCursor(jsonPath), 2, 'json cursor lowered to the MIN (2), never raised');
      assert.strictEqual(inboxCursor.readCursor(fileCursorPath), 2, '.cursor file already at the MIN, unchanged');
    } finally { rm(W1); rm(home); }
  });

  test(`[${B.name}] fail-open: a store whose listWorkspaceIds throws -> errors:1, other stores still processed, no throw`, () => {
    const homeBad = tmpHome();
    const homeGood = tmpHome();
    const Wbad = makeGitRepo('failopen-bad-' + B.name);
    const Wgood = makeGitRepo('failopen-good-' + B.name);
    const repoKeyBad = repokey.repoKeyForWorktree(Wbad);
    const repoKeyGood = repokey.repoKeyForWorktree(Wgood);

    // Seed a genuine orphan in the "bad" store so it would otherwise be healed —
    // proving the throw truly short-circuits this store's work rather than the
    // fixture simply having nothing to do.
    descFile(homeBad, 'orphan-bad', { id: 'orphan-bad', worktreePath: topOf(Wbad), sessionId: null });
    seedDirect(homeBad, repoKeyBad, 'orphan-bad', 'bad-msg');
    descFile(homeGood, 'orphan-good', { id: 'orphan-good', worktreePath: topOf(Wgood), sessionId: null });
    seedDirect(homeGood, repoKeyGood, 'orphan-good', 'good-msg');

    // Monkey-patch openStore (the SAME cached module instance devswarm.js
    // requires) so the "bad" home's store throws from listWorkspaceIds, while
    // every other store call is untouched — restored in `finally`.
    const origOpenStore = storeLib.openStore;
    storeLib.openStore = function (opts) {
      const s = origOpenStore(opts);
      if (opts && opts.home === homeBad) {
        s.listWorkspaceIds = () => { throw new Error('simulated store corruption'); };
      }
      return s;
    };
    try {
      let rBad;
      assert.doesNotThrow(() => {
        rBad = cli.healOrphanPartitions(homeBad, { cwd: Wbad, env: {}, backend: B.backend, repoKey: repoKeyBad });
      });
      assert.strictEqual(rBad.ok, true, 'the throw is caught — never propagates');
      assert.strictEqual(rBad.errors, 1, 'the store-enumeration throw is counted as an error');
      assert.strictEqual(rBad.adopted, 0, 'nothing adopted from the errored store');

      // The OTHER (good) store is entirely unaffected — still healed normally.
      const rGood = cli.healOrphanPartitions(homeGood, { cwd: Wgood, env: {}, backend: B.backend, repoKey: repoKeyGood });
      assert.strictEqual(rGood.ok, true);
      assert.strictEqual(rGood.adopted, 1, 'the good store is still processed and healed');
    } finally {
      storeLib.openStore = origOpenStore;
      rm(Wbad); rm(Wgood); rm(homeBad); rm(homeGood);
    }
  });

  test(`[${B.name}] two-live-tabs regression: two self-consistent registered descriptors on one worktree BOTH survive`, () => {
    const home = tmpHome();
    const W1 = makeGitRepo('twotabs-' + B.name);
    const repoKey = repokey.repoKeyForWorktree(W1);
    try {
      seedReg(home, repoKey, { id: 'tab-a', worktreePath: topOf(W1), sessionId: 'sa' });
      descFile(home, 'tab-a', { id: 'tab-a', worktreePath: topOf(W1), sessionId: 'sa' });
      seedReg(home, repoKey, { id: 'tab-b', worktreePath: topOf(W1), sessionId: 'sb' });
      descFile(home, 'tab-b', { id: 'tab-b', worktreePath: topOf(W1), sessionId: 'sb' });

      // An unrelated orphan on the SAME worktree, to exercise the heal alongside
      // the existing dual-live-tab invariant.
      descFile(home, 'orphan-tabs', { id: 'orphan-tabs', worktreePath: topOf(W1), sessionId: null });
      seedDirect(home, repoKey, 'orphan-tabs', 'tabs-msg');

      const r = cli.healOrphanPartitions(home, { cwd: W1, env: {}, backend: B.backend });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.adopted, 1);

      const after = regIds(home, repoKey);
      assert.ok(after.includes('tab-a') && after.includes('tab-b'), 'BOTH live tabs still registered — the heal never retires a descriptor-backed row');
    } finally { rm(W1); rm(home); }
  });

  test(`[${B.name}] doctor dry-run parity: pending count equals what apply then heals, writes nothing on dry-run`, () => {
    const home = tmpHome();
    const W1 = makeGitRepo('doctorparity-' + B.name);
    const repoKey = repokey.repoKeyForWorktree(W1);
    try {
      descFile(home, 'orphan-parity', { id: 'orphan-parity', worktreePath: topOf(W1), sessionId: null });
      seedDirect(home, repoKey, 'orphan-parity', 'parity-msg');

      const before = regIds(home, repoKey);
      const dry = cli.healOrphanPartitions(home, { cwd: W1, env: {}, backend: B.backend, dryRun: true });
      assert.strictEqual(dry.adopted, 1, 'dry-run classifies the would-adopt orphan');
      assert.deepStrictEqual(regIds(home, repoKey), before, 'dry-run mutated the registry not at all');

      const applied = cli.healOrphanPartitions(home, { cwd: W1, env: {}, backend: B.backend });
      assert.strictEqual(applied.adopted, dry.adopted, 'apply heals exactly what dry-run reported pending');

      const dry2 = cli.healOrphanPartitions(home, { cwd: W1, env: {}, backend: B.backend, dryRun: true });
      assert.strictEqual(dry2.adopted, 0, 'second dry-run reports nothing pending — parity confirmed');
    } finally { rm(W1); rm(home); }
  });

  // REGRESSION: a message-only trace left behind in the WRONG store after
  // healRegistry (rehomeMiskeyedRow) moves a mis-keyed REGISTRY row to its
  // correct store must NEVER be adopted back into the wrong store — that would
  // recreate the exact mis-keyed condition healRegistry exists to fix, and the
  // two migrations would flip-flop against each other forever. Reproduces the
  // doctor-repair.test.js "heal-registry-rows ... IS IDEMPOTENT on a second
  // pass" fixture shape directly against healOrphanPartitions.
  test(`[${B.name}] cross-store guard: an orphan whose descriptor's real home is a DIFFERENT store is unhealable, never re-adopted into the wrong store`, () => {
    const home = tmpHome();
    const Wtrue = makeGitRepo('crossstore-true-' + B.name);
    const Wwrong = makeGitRepo('crossstore-wrong-' + B.name);
    const repoKeyTrue = repokey.repoKeyForWorktree(Wtrue);
    const repoKeyWrong = repokey.repoKeyForWorktree(Wwrong);
    try {
      // 'z' is correctly registered at its true home (Wtrue) — this also writes
      // the authoritative descriptor (worktreePath: Wtrue). Backend pinned to
      // B.backend so this matches the explicit backend the later store reads use.
      const reg = cli.run(['register', 'z', '--worktree', Wtrue, '--session', 's1'], { home, env: { ANTIHALL_DEVSWARM_STORE_BACKEND: B.backend }, cwd: Wtrue });
      assert.strictEqual(reg.result.ok, true);

      // A message-only trace of 'z' physically sits in the WRONG store (Wwrong)
      // — no registry row there, mirroring the post-rehome state.
      seedDirect(home, repoKeyWrong, 'z', 'stray-in-wrong-store');
      assert.ok(!regIds(home, repoKeyWrong).includes('z'), 'sanity: no registry row for z in the wrong store');

      const r = cli.healOrphanPartitions(home, { cwd: Wwrong, env: {}, backend: B.backend, repoKey: repoKeyWrong });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.adopted, 0, 'never adopted into the wrong store');
      assert.strictEqual(r.unhealable, 1, 'reported unhealable (wrong-store), not silently dropped');
      assert.ok(!regIds(home, repoKeyWrong).includes('z'), 'the wrong store still has no registry row for z');
      assert.ok(regIds(home, repoKeyTrue).includes('z'), 'the true home is untouched');
    } finally { rm(Wtrue); rm(Wwrong); rm(home); }
  });

  // ---------------------------------------------------------------------------
  // FIX A/B — archive-aware descriptor lookup + forward-only policy for an
  // orphan whose descriptor exists ONLY in archived/ (no workspaces/<id>.json at
  // all). Before this fix, readDescriptorFile resolved workspaces/ only, so the
  // `!desc -> unhealable/no-descriptor` bail ran BEFORE hasArchivedCounterpart
  // was ever consulted — the archived-forward branch below was reachable ONLY
  // when BOTH files existed (measured: 105/110 no-descriptor orphans on a real
  // machine had an archived/<id>.json this lookup never looked at).
  const seedDirectAt = (home, repoKey, toId, body, ts) => {
    const s = openS(home, repoKey);
    try {
      const f = { from: 'sender-x', to: toId, type: 'direct', message: body, timestamp: ts, urgency: 'normal' };
      storeLib.appendMeshMessage(s, Object.assign({}, f, { hash: storeLib.meshMessageHash(f) }));
    } finally { s.close(); }
  };
  // archiveDescFile — writes archived/<id>.json DIRECTLY (unlike archiveFile
  // above, which always writes the minimal {id} shape), so these tests can give
  // the archived descriptor a real worktreePath (needed to derive the same
  // familyKey as the live survivor).
  const archiveDescFile = (home, id, desc) => {
    const p = path.join(cli.archivedDir(home), id + '.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(desc));
  };

  test(`[${B.name}] archive-only orphan (descriptor ONLY in archived/), fresh unread: FORWARDED to the family survivor, never adopted, provenance-marked`, () => {
    const home = tmpHome();
    const W1 = makeGitRepo('archonly-fresh-' + B.name);
    const repoKey = repokey.repoKeyForWorktree(W1);
    try {
      seedReg(home, repoKey, { id: 'fam-live', worktreePath: topOf(W1), sessionId: 's1' });
      descFile(home, 'fam-live', { id: 'fam-live', worktreePath: topOf(W1), sessionId: 's1' });

      // NO workspaces/<id>.json for this id — archived/ is the ONLY descriptor.
      archiveDescFile(home, 'orphan-archonly', { id: 'orphan-archonly', worktreePath: topOf(W1), sessionId: null });
      assert.strictEqual(cli.readDescriptorFile(home, 'orphan-archonly'), null, 'sanity: no live workspaces/ descriptor');
      seedDirectAt(home, repoKey, 'orphan-archonly', 'archonly-fresh-msg', Date.now());

      const r = cli.healOrphanPartitions(home, { cwd: W1, env: {}, backend: B.backend });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.adopted, 0, 'archived id is never re-adopted, even archive-only');
      assert.ok(r.forwarded >= 1, 'unread forwarded');
      assert.ok(!regIds(home, repoKey).includes('orphan-archonly'), 'no registry row was created for it');

      const survBodies = bodies(home, repoKey, 'fam-live');
      assert.ok(
        survBodies.some((b) => b.includes('archonly-fresh-msg') && b.startsWith('[forwarded from archived orphan-archonly]')),
        'forwarded body carries the provenance marker'
      );
      // source row (message-only, never a registry row) is still present, untouched.
      assert.ok(bodies(home, repoKey, 'orphan-archonly').includes('archonly-fresh-msg'), 'source row still present');
    } finally { rm(W1); rm(home); }
  });

  test(`[${B.name}] archive-only orphan, unread past the age cap: archived-stale, detect-only, ZERO writes`, () => {
    const home = tmpHome();
    const W1 = makeGitRepo('archonly-stale-' + B.name);
    const repoKey = repokey.repoKeyForWorktree(W1);
    try {
      seedReg(home, repoKey, { id: 'fam-live', worktreePath: topOf(W1), sessionId: 's1' });
      descFile(home, 'fam-live', { id: 'fam-live', worktreePath: topOf(W1), sessionId: 's1' });
      archiveDescFile(home, 'orphan-stale', { id: 'orphan-stale', worktreePath: topOf(W1), sessionId: null });
      const veryOld = Date.now() - (45 * 24 * 60 * 60 * 1000); // 45d > the 30d default cap
      seedDirectAt(home, repoKey, 'orphan-stale', 'archonly-stale-msg', veryOld);

      const before = openS(home, repoKey);
      let beforeSurv;
      try { beforeSurv = before.listRegistry().find((d) => d.id === 'fam-live'); } finally { before.close(); }

      const r = cli.healOrphanPartitions(home, { cwd: W1, env: {}, backend: B.backend });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.adopted, 0, 'never adopted');
      assert.strictEqual(r.forwarded, 0, 'nothing forwarded — every unread row is past the age cap');
      assert.strictEqual(r.archivedStale, 1, 'classified archived-stale');
      assert.strictEqual(r.unhealable, 0, 'NOT counted as unhealable');
      assert.ok(!regIds(home, repoKey).includes('orphan-stale'), 'no registry row created');
      assert.ok(!bodies(home, repoKey, 'fam-live').includes('archonly-stale-msg'), 'stale message never forwarded');

      const after = openS(home, repoKey);
      let afterSurv;
      try { afterSurv = after.listRegistry().find((d) => d.id === 'fam-live'); } finally { after.close(); }
      assert.strictEqual(afterSurv.writeSeq, beforeSurv.writeSeq, 'zero writes to the survivor row');
    } finally { rm(W1); rm(home); }
  });

  test(`[${B.name}] archive-only orphan, unread == 0: archived-drained, NOT unhealable, zero writes`, () => {
    const home = tmpHome();
    const W1 = makeGitRepo('archonly-drained-' + B.name);
    const repoKey = repokey.repoKeyForWorktree(W1);
    try {
      seedReg(home, repoKey, { id: 'fam-live', worktreePath: topOf(W1), sessionId: 's1' });
      descFile(home, 'fam-live', { id: 'fam-live', worktreePath: topOf(W1), sessionId: 's1' });
      archiveDescFile(home, 'orphan-drained', { id: 'orphan-drained', worktreePath: topOf(W1), sessionId: null });
      // This id has NO messages at all -> listWorkspaceIds would not even surface
      // it as an orphan (no store trace). Give it a store trace with everything
      // already consumed (messageCount === cursorValue) so it IS an orphan (has
      // a store footprint) but genuinely drained (unread:0).
      seedDirectAt(home, repoKey, 'orphan-drained', 'already-read', Date.now());
      const sPre = openS(home, repoKey);
      try { sPre.setCursor('orphan-drained', 1); } finally { sPre.close(); }

      const r = cli.healOrphanPartitions(home, { cwd: W1, env: {}, backend: B.backend });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.adopted, 0);
      assert.strictEqual(r.forwarded, 0);
      assert.strictEqual(r.archivedDrained, 1, 'classified archived-drained');
      assert.strictEqual(r.unhealable, 0, 'a drained archived orphan is NOT unhealable');
      assert.ok(!regIds(home, repoKey).includes('orphan-drained'), 'no registry row created');
    } finally { rm(W1); rm(home); }
  });

  test(`[${B.name}] orphan with NO descriptor in EITHER workspaces/ or archived/: still unhealable/no-descriptor, zero writes`, () => {
    const home = tmpHome();
    const W1 = makeGitRepo('nodesc-' + B.name);
    const repoKey = repokey.repoKeyForWorktree(W1);
    try {
      seedDirect(home, repoKey, 'orphan-nodesc', 'nowhere-msg');
      assert.strictEqual(cli.readDescriptorFile(home, 'orphan-nodesc'), null);
      assert.ok(!fs.existsSync(path.join(cli.archivedDir(home), 'orphan-nodesc.json')));

      const r = cli.healOrphanPartitions(home, { cwd: W1, env: {}, backend: B.backend });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.adopted, 0);
      assert.strictEqual(r.forwarded, 0);
      assert.strictEqual(r.unhealable, 1, 'no descriptor anywhere -> unhealable');
      assert.strictEqual(r.detail.find((d) => d.id === 'orphan-nodesc').reason, 'no-descriptor');
      assert.ok(!regIds(home, repoKey).includes('orphan-nodesc'));
    } finally { rm(W1); rm(home); }
  });

  test(`[${B.name}] IDEMPOTENT: a second heal pass over an archive-only orphan forwards nothing new (hash dedup holds)`, () => {
    const home = tmpHome();
    const W1 = makeGitRepo('archonly-idem-' + B.name);
    const repoKey = repokey.repoKeyForWorktree(W1);
    try {
      seedReg(home, repoKey, { id: 'fam-live', worktreePath: topOf(W1), sessionId: 's1' });
      descFile(home, 'fam-live', { id: 'fam-live', worktreePath: topOf(W1), sessionId: 's1' });
      archiveDescFile(home, 'orphan-idem', { id: 'orphan-idem', worktreePath: topOf(W1), sessionId: null });
      seedDirectAt(home, repoKey, 'orphan-idem', 'idem-msg', Date.now());

      const r1 = cli.healOrphanPartitions(home, { cwd: W1, env: {}, backend: B.backend });
      assert.ok(r1.forwarded >= 1, 'first pass forwards the unread message');
      const countAfter1 = bodies(home, repoKey, 'fam-live').length;

      const r2 = cli.healOrphanPartitions(home, { cwd: W1, env: {}, backend: B.backend });
      assert.strictEqual(r2.forwarded, 0, 'second pass forwards nothing NEW — cursor + hash dedup holds');
      const countAfter2 = bodies(home, repoKey, 'fam-live').length;
      assert.strictEqual(countAfter2, countAfter1, 'survivor message count unchanged on the second pass');
    } finally { rm(W1); rm(home); }
  });
}

// doctor repair wiring (journal backend, isolated tmp HOME).
test('doctor repair: heal-orphan-partitions detects (dry-run) and heals (apply)', () => {
  const home = tmpHome();
  const W1 = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-healorphan-doc-'));
  cp.spawnSync('git', ['init', '-q', W1]);
  cp.spawnSync('git', ['-C', W1, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', W1, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(W1, 'README.md'), 'x');
  cp.spawnSync('git', ['-C', W1, 'add', '.']);
  cp.spawnSync('git', ['-C', W1, 'commit', '-q', '-m', 'init']);
  const repoKey = repokey.repoKeyForWorktree(W1);
  const openS = () => storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  const seedReg = (desc) => { const s = openS(); try { s.upsertRegistry(desc); } finally { s.close(); } };
  const descFile = (id, desc) => { const p = cli.descriptorPath(home, id); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(desc)); };
  const seedDirect = (toId, body) => {
    const s = openS();
    try {
      const f = { from: 'sender-x', to: toId, type: 'direct', message: body, timestamp: Date.now(), urgency: 'normal' };
      storeLib.appendMeshMessage(s, Object.assign({}, f, { hash: storeLib.meshMessageHash(f) }));
    } finally { s.close(); }
  };
  const regIds = () => { const s = openS(); try { return s.listRegistry().map((d) => d.id).sort(); } finally { s.close(); } };
  try {
    const top = inst.resolveWorktree(W1);
    seedReg({ id: 'fam-live', worktreePath: top, sessionId: 's1' });
    descFile('fam-live', { id: 'fam-live', worktreePath: top, sessionId: 's1' });
    descFile('orphan-doc', { id: 'orphan-doc', worktreePath: top, sessionId: null });
    seedDirect('orphan-doc', 'doc-msg');

    const env = { HOME: home, ANTIHALL_DEVSWARM_STORE_BACKEND: 'journal', PATH: process.env.PATH };
    const find = (res) => res.find((x) => x.id === 'heal-orphan-partitions');

    const dry = doctorRepair.runRepairs({ cwd: W1, env, home, dryRun: true });
    const dEntry = find(dry);
    assert.ok(dEntry, 'doctor wires a heal-orphan-partitions repair');
    assert.strictEqual(dEntry.status, 'skipped', 'dry-run reports skipped');
    assert.match(dEntry.msg, /orphan partition/, 'dry-run detail names the drift');
    assert.deepStrictEqual(regIds(), ['fam-live'], 'dry-run mutated nothing');

    const applied = doctorRepair.runRepairs({ cwd: W1, env, home, dryRun: false });
    const aEntry = find(applied);
    assert.ok(aEntry, 'heal-orphan-partitions entry present on apply');
    assert.strictEqual(aEntry.status, 'fixed', 'apply reports fixed');
    assert.deepStrictEqual(regIds(), ['fam-live', 'orphan-doc'], 'orphan-doc adopted');
  } finally { rm(W1); rm(home); }
});
