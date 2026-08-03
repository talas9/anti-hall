'use strict';
// ARCHIVED-STILL-ACTIVE — archive retires the WHOLE same-worktree registry group,
// the roster can DEMOTE an archived row, and a forward-migration repairs registries
// already split by the old one-row-per-archive behavior.
//
// Mechanism under test (proven in scripts/devswarm.js's own comments): a registry
// row is keyed on the id of whoever registered it, while a worktree's mesh address
// is derived from its worktreePath — two id-spaces for ONE worktree, BY DESIGN (a
// child must own the partition it drains). So up to four ids can hold a live row
// for one worktree: a hivecontrol builder UUID, a `primary-<8hex>` spawn phantom, a
// legacy ingested `<label>-<repoId8>` row, and a `primary-<8hex>` derived from a
// SUBDIR pre-image. cmdArchive tombstoned exactly ONE of them, and computeSummary
// projects any surviving row as an ACTIVE workspace — so the archived workspace
// kept reading active.
//
// Real git worktrees as cwd (repoKeyForWorktree spawns git). Mirrors
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
const doctorRepair = require('../../plugins/anti-hall/hooks/lib/doctor-repair.js');
const U = require('../../plugins/anti-hall/skills/update/scripts/update.js');

const REPO_ROOT = path.join(__dirname, '..', '..');
const REAL_PLUGIN_SRC_DIR = path.join(REPO_ROOT, 'plugins', 'anti-hall');
const BACKEND = 'journal'; // deterministic + always available; the fold primitives are backend-agnostic

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-archgrp-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-archgrp-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function topOf(dir) { return inst.resolveWorktree(dir); }
// Synchronous sleep (no busy-spin) — the same Atomics.wait idiom devswarm.js's own
// acquireIdLock uses. Needed only to force a strictly greater registry updatedAt.
function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {} }

const openS = (home, bucket) => storeLib.openStore({ home, hash: bucket, backend: BACKEND });
function seedReg(home, bucket, desc) { const s = openS(home, bucket); try { s.upsertRegistry(desc); } finally { s.close(); } }
function seedDirect(home, bucket, toId, body, extra) {
  const s = openS(home, bucket);
  try {
    const f = Object.assign({ from: 'sender-x', to: toId, type: 'direct', message: body, timestamp: Date.now(), urgency: 'normal' }, extra || {});
    storeLib.appendMeshMessage(s, Object.assign({}, f, { hash: storeLib.meshMessageHash(f) }));
  } finally { s.close(); }
}
function regIds(home, bucket) { const s = openS(home, bucket); try { return s.listRegistry().map((d) => String(d.id)).sort(); } finally { s.close(); } }
function msgCount(home, bucket, id) { const s = openS(home, bucket); try { return s.listMessages(id, { sinceCursor: 0 }).length; } finally { s.close(); } }
function allMsgCount(home, bucket, ids) { return ids.reduce((n, id) => n + msgCount(home, bucket, id), 0); }
function activeIds(home, bucket) {
  const s = openS(home, bucket);
  try { return Object.keys(storeLib.computeSummary(s, { home }).workspaces || {}).sort(); }
  finally { s.close(); }
}
function writeDesc(home, id, desc) {
  const p = cli.descriptorPath(home, id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(desc));
}
function writeArchivedDesc(home, id, desc) {
  const p = path.join(cli.archivedDir(home), id + '.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(desc));
}

// The four REAL id forms one worktree can accumulate (see the header). `meshId` is
// the canonical `primary-<8hex>` form; `subdirMesh` is the SAME shape derived from
// a SUBDIR pre-image, i.e. a DIFFERENT 8-hex that still resolves to this toplevel.
function idForms(W) {
  const top = topOf(W);
  const sub = path.join(top, 'pkg', 'inner');
  fs.mkdirSync(sub, { recursive: true });
  return {
    top,
    sub,
    builderUuid: 'b3f1c2d4-0000-4000-8000-abcdef012345', // hivecontrol builder UUID
    meshId: inst.primaryWorkspaceId(top),               // primary-<8hex> canonical
    subdirMesh: inst.primaryWorkspaceId(sub),           // primary-<8hex> from a SUBDIR pre-image
    legacy: 'feature-login-ab12cd34',                   // legacy ingested <label>-<repoId8>
  };
}

// ---------------------------------------------------------------------------
// (1) + (2): archiving a workspace with 3 same-worktree rows leaves NO row
// projecting active, and the retired rows' unread is FORWARDED, never lost.
// ---------------------------------------------------------------------------
test('cmdArchive: retires the WHOLE same-worktree group — no row keeps projecting active, and unread is forwarded (no data loss)', () => {
  const home = tmpHome();
  const W = makeGitRepo('grp');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const F = idForms(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };

    // The archived workspace: a builder-UUID row WITH an active descriptor.
    const desc = { id: F.builderUuid, worktreePath: F.top, sessionId: 'sess-live', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, desc);
    writeDesc(home, F.builderUuid, desc);
    // Two OTHER store-only rows for the SAME worktree, each holding an unread direct.
    seedReg(home, repoKey, { id: F.meshId, worktreePath: F.top, sessionId: null });
    seedDirect(home, repoKey, F.meshId, 'payload-phantom');
    seedReg(home, repoKey, { id: F.legacy, worktreePath: F.top, sessionId: null });
    seedDirect(home, repoKey, F.legacy, 'payload-legacy', { needsReply: true });

    const partitions = [F.builderUuid, F.meshId, F.legacy];
    const before = allMsgCount(home, repoKey, partitions);
    assert.strictEqual(before, 2, 'two unread directs seeded');
    assert.deepStrictEqual(regIds(home, repoKey), [F.builderUuid, F.legacy, F.meshId].sort(), 'three live rows before archive');

    const r = cli.cmdArchive(F.builderUuid, ctx);
    assert.strictEqual(r.ok, true, 'archive succeeds: ' + JSON.stringify(r));

    // (1) NOTHING projects active any more.
    assert.deepStrictEqual(regIds(home, repoKey), [], 'every same-worktree registry row is retired');
    assert.deepStrictEqual(activeIds(home, repoKey), [], 'computeSummary projects no active workspace');
    assert.deepStrictEqual(r.retiredDuplicates.sort(), [F.legacy, F.meshId].sort(), 'both duplicates reported');

    // (2) NO DATA LOSS: the retired rows' unread was FORWARDED into the archived
    // id's partition (message rows are append-only and never deleted, so the
    // total can only GROW).
    const after = allMsgCount(home, repoKey, partitions);
    assert.ok(after >= before, 'no message row was ever deleted (' + after + ' >= ' + before + ')');
    assert.strictEqual(r.forwardedFromDuplicates, 2, 'both unread directs forwarded');
    assert.strictEqual(msgCount(home, repoKey, F.builderUuid), 2, 'both landed in the archived id partition');
  } finally { rm(W); rm(home); }
});

// ---------------------------------------------------------------------------
// (3) SAFETY GATE: a same-worktree row backed by a DIFFERENT live descriptor is
// NEVER tombstoned (that would silently archive a workspace nobody asked to
// archive) and is SURFACED with a reason.
// ---------------------------------------------------------------------------
test('cmdArchive: a same-worktree row with its OWN live descriptor is NOT tombstoned and IS surfaced', () => {
  const home = tmpHome();
  const W = makeGitRepo('gate');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const F = idForms(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };

    const desc = { id: F.builderUuid, worktreePath: F.top, sessionId: 'sess-a', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, desc);
    writeDesc(home, F.builderUuid, desc);
    // A DISTINCT live child on the same worktree — descriptor-backed.
    const other = { id: 'other-live-child', worktreePath: F.top, sessionId: 'sess-b', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, other);
    writeDesc(home, 'other-live-child', other);
    // Plus a store-only phantom, which MUST still be retired.
    seedReg(home, repoKey, { id: F.meshId, worktreePath: F.top, sessionId: null });

    const r = cli.cmdArchive(F.builderUuid, ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(regIds(home, repoKey), ['other-live-child'], 'the distinct live child survives; the phantom does not');
    assert.deepStrictEqual(r.retiredDuplicates, [F.meshId]);
    assert.deepStrictEqual(r.leftDuplicates, [{ id: 'other-live-child', reason: 'live-descriptor' }],
      'the left row is reported with its reason, never silently dropped');
    assert.deepStrictEqual(activeIds(home, repoKey), ['other-live-child'], 'only the live child still projects active');
  } finally { rm(W); rm(home); }
});

// ---------------------------------------------------------------------------
// (4) + (5): the forward-migration repairs an ALREADY-split registry, covers all
// four id forms AND both store-bucket forms, and is idempotent.
// ---------------------------------------------------------------------------
test('foldArchivedRegistryRows: retires every id form in BOTH bucket forms, then a re-run reports nothing to do (idempotent)', () => {
  const home = tmpHome();
  const W = makeGitRepo('mig');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const F = idForms(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };

    // An ALREADY-archived workspace (archived descriptor present, active absent) —
    // exactly the on-disk state the OLD one-row-per-archive code left behind.
    const desc = { id: F.builderUuid, worktreePath: F.top, sessionId: 'sess-old', ownerKey: repoKey, repoKey };
    writeArchivedDesc(home, F.builderUuid, desc);

    // repoKey bucket: all four id forms still live.
    seedReg(home, repoKey, desc);                                                   // builder UUID
    seedReg(home, repoKey, { id: F.meshId, worktreePath: F.top, sessionId: null }); // primary-<8hex> canonical
    seedReg(home, repoKey, { id: F.subdirMesh, worktreePath: F.sub, sessionId: null }); // primary-<8hex> from a SUBDIR pre-image
    seedReg(home, repoKey, { id: F.legacy, worktreePath: F.top, sessionId: null }); // legacy <label>-<repoId8>
    seedDirect(home, repoKey, F.legacy, 'mig-unread', { needsReply: true });
    // LEGACY 8-hex bucket (hashFromWorkspaceId) — the other on-disk bucket form.
    const legacyBucket = storeLib.hashFromWorkspaceId(F.builderUuid);
    assert.notStrictEqual(legacyBucket, repoKey);
    seedReg(home, legacyBucket, desc);
    seedReg(home, legacyBucket, { id: F.meshId, worktreePath: F.top, sessionId: null });

    // dry-run classifies without writing.
    const dry = cli.foldArchivedRegistryRows(home, Object.assign({ dryRun: true }, ctx));
    assert.strictEqual(dry.ok, true, JSON.stringify(dry));
    assert.strictEqual(dry.pending, 6, 'all six rows across both buckets classified: ' + JSON.stringify(dry.retired));
    assert.strictEqual(regIds(home, repoKey).length, 4, 'dry-run mutated nothing');
    assert.strictEqual(regIds(home, legacyBucket).length, 2, 'dry-run mutated nothing (legacy bucket)');

    const before = msgCount(home, repoKey, F.legacy) + msgCount(home, repoKey, F.builderUuid);
    const r1 = cli.foldArchivedRegistryRows(home, ctx);
    assert.strictEqual(r1.ok, true, JSON.stringify(r1));
    assert.deepStrictEqual(regIds(home, repoKey), [], 'every id form retired in the repoKey bucket');
    assert.deepStrictEqual(regIds(home, legacyBucket), [], 'every id form retired in the LEGACY bucket');
    assert.deepStrictEqual(activeIds(home, repoKey), [], 'the archived workspace no longer projects active');
    assert.strictEqual(r1.forwarded, 1, 'the unread direct was forwarded, not lost');
    const after = msgCount(home, repoKey, F.legacy) + msgCount(home, repoKey, F.builderUuid);
    assert.ok(after >= before, 'NO-DELETE: message rows only ever grow (' + after + ' >= ' + before + ')');

    // (4) IDEMPOTENT: a second run finds nothing left to do.
    const r2 = cli.foldArchivedRegistryRows(home, ctx);
    assert.strictEqual(r2.ok, true, JSON.stringify(r2));
    assert.strictEqual(r2.pending, 0, 're-run has nothing to retire');
    assert.deepStrictEqual(r2.retired, []);
    assert.strictEqual(r2.forwarded, 0);
    const dry2 = cli.foldArchivedRegistryRows(home, Object.assign({ dryRun: true }, ctx));
    assert.strictEqual(dry2.pending, 0, 'the dry-run detect also reports nothing pending (doctor re-verify)');
  } finally { rm(W); rm(home); }
});

test('foldArchivedRegistryRows: a LIVE workspace is never touched (no archived descriptor -> no-op)', () => {
  const home = tmpHome();
  const W = makeGitRepo('live');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const F = idForms(W);
    const desc = { id: F.builderUuid, worktreePath: F.top, sessionId: 'sess-live', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, desc);
    writeDesc(home, F.builderUuid, desc);
    seedReg(home, repoKey, { id: F.meshId, worktreePath: F.top, sessionId: null });

    const r = cli.foldArchivedRegistryRows(home, { home, cwd: W, env: { HOME: home }, backend: BACKEND });
    assert.strictEqual(r.pending, 0);
    assert.deepStrictEqual(regIds(home, repoKey), [F.builderUuid, F.meshId].sort(), 'a live workspace keeps every row');
  } finally { rm(W); rm(home); }
});

test('foldArchivedRegistryRows: a mid-archive state (BOTH descriptors present) is left to applyRecoveryIntents, not retired here', () => {
  const home = tmpHome();
  const W = makeGitRepo('midarch');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const F = idForms(W);
    const desc = { id: F.builderUuid, worktreePath: F.top, sessionId: 'sess-x', ownerKey: repoKey, repoKey };
    writeDesc(home, F.builderUuid, desc);        // active STILL present
    writeArchivedDesc(home, F.builderUuid, desc); // archived anchor also present
    seedReg(home, repoKey, desc);

    const r = cli.foldArchivedRegistryRows(home, { home, cwd: W, env: { HOME: home }, backend: BACKEND });
    assert.strictEqual(r.pending, 0, 'not classified as archived while the active descriptor still exists');
    assert.deepStrictEqual(regIds(home, repoKey), [F.builderUuid]);
  } finally { rm(W); rm(home); }
});

// ---------------------------------------------------------------------------
// (6) ROSTER DEMOTION.
// ---------------------------------------------------------------------------
test('cmdRoster: a store row whose workspace is genuinely archived reads as archived, not active', () => {
  const home = tmpHome();
  const W = makeGitRepo('roster');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const F = idForms(W);
    const desc = { id: F.builderUuid, worktreePath: F.top, sessionId: 'sess-r', ownerKey: repoKey, repoKey };
    // Archived on disk, but a duplicate registry row survived (the pre-fix state).
    writeArchivedDesc(home, F.builderUuid, desc);
    seedReg(home, repoKey, desc);
    // A genuinely LIVE workspace on another id must keep reading as 'store'.
    const live = { id: 'live-child', worktreePath: F.top, sessionId: 'sess-l', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, live);
    writeDesc(home, 'live-child', live);

    const r = cli.cmdRoster({}, { home, cwd: W, env: { HOME: home }, backend: BACKEND });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const archivedRow = r.workspaces.find((w) => w.id === F.builderUuid);
    const liveRow = r.workspaces.find((w) => w.id === 'live-child');
    assert.ok(archivedRow, 'the archived workspace is still VISIBLE (nothing is hidden)');
    assert.strictEqual(archivedRow.source, 'archived', 'demoted: it no longer reads as an active store row');
    assert.ok(archivedRow.hints.includes('archived'), 'hinted as archived');
    assert.ok(liveRow, 'the live workspace is present');
    assert.strictEqual(liveRow.source, 'store', 'a live workspace is NOT demoted');
    assert.ok(!liveRow.hints.includes('archived'));
  } finally { rm(W); rm(home); }
});

// ---------------------------------------------------------------------------
// HARD CONSTRAINT: builder-id keying is NOT perturbed. A registry row is keyed on
// the id of whoever registered it, and for a DevSwarm child that id IS the
// partition it drains (devswarm.js:1006-1044 — the v0.55.x P0 message-loss fix
// that REPLACED the meshId-keyed scheme). Neither archiving a SIBLING workspace
// nor the forward-migration may move, re-key, or retire a live child's row, and a
// `send` addressed to the worktree must still RESOLVE to that builder-id partition
// — otherwise the P0 is reintroduced.
// ---------------------------------------------------------------------------
test('builder-id keying survives: a live child still drains its OWN builder-id partition after a sibling archive AND after the migration', () => {
  const home = tmpHome();
  const W = makeGitRepo('builderid');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const F = idForms(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };
    const CHILD = 'c0ffee11-2222-4333-8444-555566667777'; // the child's hivecontrol builder UUID

    // A SIBLING workspace on the SAME worktree that the user archives, plus a phantom.
    const sib = { id: F.builderUuid, worktreePath: F.top, sessionId: 'sess-sib', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, sib);
    writeDesc(home, F.builderUuid, sib);
    seedReg(home, repoKey, { id: F.meshId, worktreePath: F.top, sessionId: null });
    // The LIVE child, keyed on its builder UUID, registered LAST so it is the
    // freshest live row — resolveMeshTarget's existing "freshest live wins" rule
    // (registry updatedAt is Date.now() at write time, not caller-settable), so the
    // sleep guarantees a strictly greater timestamp instead of a same-ms tiebreak.
    sleepMs(5);
    const child = { id: CHILD, worktreePath: F.top, sessionId: 'sess-child-live', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, child);
    writeDesc(home, CHILD, child);
    seedDirect(home, repoKey, CHILD, 'for-the-child-1');

    const readTarget = () => {
      const s = openS(home, repoKey);
      try { const t = cli.resolveMeshTarget(s, F.meshId); return t && t.id ? String(t.id) : null; }
      finally { s.close(); }
    };
    const childBodies = () => {
      const s = openS(home, repoKey);
      try { return s.listMessages(CHILD, { sinceCursor: 0 }).map((m) => m.body); }
      finally { s.close(); }
    };
    assert.strictEqual(readTarget(), CHILD, 'baseline: a send to the worktree resolves to the child builder-id partition');

    // --- after archiving the SIBLING ---
    const r = cli.cmdArchive(F.builderUuid, ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(regIds(home, repoKey).includes(CHILD), 'the live child row is NOT retired by a sibling archive');
    assert.deepStrictEqual(r.leftDuplicates, [{ id: CHILD, reason: 'live-descriptor' }], 'the child is reported as LEFT, with its reason');
    assert.strictEqual(readTarget(), CHILD, 'a send STILL resolves to the child builder-id partition');
    seedDirect(home, repoKey, CHILD, 'for-the-child-2');
    assert.deepStrictEqual(childBodies(), ['for-the-child-1', 'for-the-child-2'],
      'the child still drains its OWN builder-id partition — old and new traffic both readable');

    // --- after the forward-MIGRATION (the sibling is now archived on disk) ---
    const m = cli.foldArchivedRegistryRows(home, ctx);
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    assert.ok(regIds(home, repoKey).includes(CHILD), 'the migration does not retire the live child row either');
    assert.ok(m.left.some((x) => x.id === CHILD && x.reason === 'live-descriptor'),
      'the migration surfaces the child as safety-gated: ' + JSON.stringify(m.left));
    assert.strictEqual(readTarget(), CHILD, 'a send STILL resolves to the child builder-id partition after the migration');
    seedDirect(home, repoKey, CHILD, 'for-the-child-3');
    assert.deepStrictEqual(childBodies(), ['for-the-child-1', 'for-the-child-2', 'for-the-child-3'],
      'the child STILL drains its own builder-id partition after the migration — no row re-keyed, nothing lost');

    // The child's registry row is byte-identical in the fields that define its
    // keying: same id (== its partition) and same worktreePath.
    const s = openS(home, repoKey);
    try {
      const row = s.listRegistry().find((d) => String(d.id) === CHILD);
      assert.strictEqual(String(row.id), CHILD, 'row id (the partition it drains) is unchanged');
      assert.strictEqual(row.worktreePath, F.top, 'row worktreePath is unchanged');
    } finally { s.close(); }
  } finally { rm(W); rm(home); }
});

// ---------------------------------------------------------------------------
// FORWARD SURVIVOR IS CHOSEN BY LIVENESS (P1 message-loss regression).
//
// The test above proves the child's ROW survives an archive. That is NOT the same
// as proving TRAFFIC reaches it: it seeds no message on the phantom row, so it
// passed just as happily while the fold forwarded every phantom's unread into the
// ARCHIVED id — a partition cmdArchive tombstones moments later, which computeSummary
// then stops projecting and no live session ever drains. The message row is not
// deleted, but it is unreachable and invisible: exactly the v0.55.x P0 message-loss
// class. These three tests pin WHERE the backlog lands, not just which rows survive.
// ---------------------------------------------------------------------------
test('cmdArchive: a phantom unread direct is forwarded to the LIVE child on the worktree — NOT into the partition being tombstoned', () => {
  const home = tmpHome();
  const W = makeGitRepo('survivor');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const F = idForms(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };
    const CHILD = 'd0d0cafe-1111-4222-8333-444455556666';

    // (i) SIB — the workspace the user archives, with its own live descriptor.
    const sib = { id: F.builderUuid, worktreePath: F.top, sessionId: 'sess-sib', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, sib);
    writeDesc(home, F.builderUuid, sib);
    // (ii) A store-only phantom row on the SAME worktree carrying ONE unread
    // needsReply direct — a real unanswered question with nobody to drain it.
    seedReg(home, repoKey, { id: F.meshId, worktreePath: F.top, sessionId: null });
    seedDirect(home, repoKey, F.meshId, 'PHANTOM-PAYLOAD', { needsReply: true });
    // (iii) CHILD — a DISTINCT live workspace still holding this worktree, freshest.
    sleepMs(5);
    const child = { id: CHILD, worktreePath: F.top, sessionId: 'sess-child-live', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, child);
    writeDesc(home, CHILD, child);

    const bodies = (id) => {
      const s = openS(home, repoKey);
      try { return s.listMessages(id, { sinceCursor: 0 }).map((m) => m.body); }
      finally { s.close(); }
    };

    const r = cli.cmdArchive(F.builderUuid, ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.retiredDuplicates, [F.meshId], 'the phantom is still retired');
    assert.strictEqual(r.forwardedFromDuplicates, 1, 'its unread direct was forwarded');
    assert.deepStrictEqual(r.leftDuplicates, [{ id: CHILD, reason: 'live-descriptor' }],
      'the live child survives and is surfaced with its reason: ' + JSON.stringify(r.leftDuplicates));

    // THE ASSERTION THAT WAS MISSING: the payload is readable by the LIVE child.
    assert.ok(bodies(CHILD).includes('PHANTOM-PAYLOAD'),
      'the phantom payload landed in the LIVE child partition: ' + JSON.stringify(bodies(CHILD)));
    // ...and NOT in the archived id's partition, whose registry row is now a
    // tombstone — anything forwarded there is undrainable and unprojected.
    assert.deepStrictEqual(bodies(F.builderUuid), [],
      'nothing was forwarded into the partition being tombstoned');
    assert.deepStrictEqual(activeIds(home, repoKey), [CHILD], 'only the live child projects active');

    // needsReply survives the forward (a question must stay a question), and the
    // ORIGINAL row is untouched — message rows are never deleted.
    const s = openS(home, repoKey);
    try {
      const fwd = s.listMessages(CHILD, { sinceCursor: 0 }).find((m) => m.body === 'PHANTOM-PAYLOAD');
      assert.strictEqual(!!fwd.needsReply, true, 'needsReply preserved through the forward');
    } finally { s.close(); }
    assert.strictEqual(msgCount(home, repoKey, F.meshId), 1, 'NO-DELETE: the original phantom row is still there');
  } finally { rm(W); rm(home); }
});

test('foldArchivedRegistryRows: the migration also forwards a phantom unread to the LIVE child, not into the archived id', () => {
  const home = tmpHome();
  const W = makeGitRepo('survivormig');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const F = idForms(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };
    const CHILD = 'facefeed-1111-4222-8333-444455556666';

    // The pre-fix on-disk state: SIB archived on disk, its row plus a phantom still
    // live in the registry, and a DISTINCT live child holding the same worktree.
    const sib = { id: F.builderUuid, worktreePath: F.top, sessionId: 'sess-old', ownerKey: repoKey, repoKey };
    writeArchivedDesc(home, F.builderUuid, sib);
    seedReg(home, repoKey, sib);
    seedReg(home, repoKey, { id: F.legacy, worktreePath: F.top, sessionId: null });
    seedDirect(home, repoKey, F.legacy, 'MIGRATION-PAYLOAD', { needsReply: true });
    sleepMs(5);
    const child = { id: CHILD, worktreePath: F.top, sessionId: 'sess-child-live', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, child);
    writeDesc(home, CHILD, child);

    const bodies = (id) => {
      const s = openS(home, repoKey);
      try { return s.listMessages(id, { sinceCursor: 0 }).map((m) => m.body); }
      finally { s.close(); }
    };

    // The dry-run detect must classify identically (one classifier, not two): the
    // phantom retires, the live child is surfaced — never counted as pending.
    const dry = cli.foldArchivedRegistryRows(home, Object.assign({ dryRun: true }, ctx));
    assert.strictEqual(dry.ok, true, JSON.stringify(dry));
    assert.ok(!dry.retired.some((x) => String(x).startsWith(CHILD + '@')),
      'the live child is never classified for retirement: ' + JSON.stringify(dry.retired));
    assert.ok(dry.left.some((x) => x.id === CHILD && x.reason === 'live-descriptor'),
      'the dry-run surfaces the live child: ' + JSON.stringify(dry.left));

    const m = cli.foldArchivedRegistryRows(home, ctx);
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    assert.strictEqual(m.forwarded, 1, 'the phantom unread was forwarded: ' + JSON.stringify(m));
    assert.deepStrictEqual(regIds(home, repoKey), [CHILD], 'archived id + phantom retired; the live child kept');
    assert.ok(m.left.some((x) => x.id === CHILD && x.reason === 'live-descriptor'),
      'the live child is surfaced as safety-gated: ' + JSON.stringify(m.left));

    assert.ok(bodies(CHILD).includes('MIGRATION-PAYLOAD'),
      'the migration delivered the payload to the LIVE child: ' + JSON.stringify(bodies(CHILD)));
    assert.deepStrictEqual(bodies(F.builderUuid), [],
      'nothing was forwarded into the archived id partition (its row is tombstoned here too)');
    assert.strictEqual(msgCount(home, repoKey, F.legacy), 1, 'NO-DELETE: the original phantom row is still there');
  } finally { rm(W); rm(home); }
});

test('cmdArchive: with NO live workspace left on the worktree, the archived id IS the survivor and its partition is SURFACED as an orphan (nothing lost, nothing deleted)', () => {
  const home = tmpHome();
  const W = makeGitRepo('lonely');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const F = idForms(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };

    // The ONLY workspace on this worktree, plus a store-only phantom holding an
    // unread question. There is no live row to forward to — the whole worktree is
    // retiring, so the archived id is the legitimate survivor.
    const only = { id: F.builderUuid, worktreePath: F.top, sessionId: 'sess-only', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, only);
    writeDesc(home, F.builderUuid, only);
    seedReg(home, repoKey, { id: F.meshId, worktreePath: F.top, sessionId: null });
    seedDirect(home, repoKey, F.meshId, 'lonely-payload', { needsReply: true });

    const r = cli.cmdArchive(F.builderUuid, ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.retiredDuplicates, [F.meshId]);
    assert.strictEqual(r.forwardedFromDuplicates, 1, 'still forwarded — into the archived id');
    assert.ok(!r.leftDuplicates, 'no row survived the fold: ' + JSON.stringify(r.leftDuplicates));
    assert.strictEqual(msgCount(home, repoKey, F.builderUuid), 1, 'the backlog is consolidated in the archived partition');
    assert.deepStrictEqual(activeIds(home, repoKey), [], 'nothing projects active');

    // SURFACED, never deleted: computeSummary reports the now-registry-less
    // partition as an orphan, which is the no-delete posture — not message loss.
    const s = openS(home, repoKey);
    try {
      const sum = storeLib.computeSummary(s, { home });
      const o = (sum.orphans || []).find((x) => String(x.id) === F.builderUuid);
      assert.ok(o, 'the archived partition is surfaced as an orphan: ' + JSON.stringify(sum.orphans));
      assert.strictEqual(o.messageCount, 1, JSON.stringify(o));
    } finally { s.close(); }
    assert.strictEqual(msgCount(home, repoKey, F.meshId), 1, 'NO-DELETE: the original phantom row is still there');
  } finally { rm(W); rm(home); }
});

// ---------------------------------------------------------------------------
// A DESCRIPTOR FILE IS NOT LIVENESS (the residual half of the P1 above).
//
// The first liveness fix filtered forward-destination candidates by descriptor
// presence ONLY — the tombstone gate's test. Nothing purges a stale
// workspaces/<id>.json after a crash, so a CRASHED sibling keeps its descriptor while
// its registry sessionId is dead. pickSurvivor assigns firstMatch BEFORE its own
// liveness check and returns `bestLive || firstMatch`, so a candidate set with no live
// row yields a DEAD row — and the fold then forwarded a real unanswered direct into a
// partition nothing drains. Same message-loss class, different id; and it was reported
// as 'live-descriptor', so the operator saw a reassuring word instead of a warning.
// Tombstoning stays CONSERVATIVE (descriptor presence); the destination is STRICT
// (descriptor AND live session).
// ---------------------------------------------------------------------------
test('cmdArchive: a descriptor-backed but SESSION-DEAD sibling is NEVER the forward destination — the backlog stays with the archived id (orphan), not a dead partition', () => {
  const home = tmpHome();
  const W = makeGitRepo('deadsib');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const F = idForms(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };
    const DEAD = 'deadbeef-1111-4222-8333-444455556666';

    // (i) The workspace being archived, with its own live descriptor.
    const sib = { id: F.builderUuid, worktreePath: F.top, sessionId: 'sess-sib', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, sib);
    writeDesc(home, F.builderUuid, sib);
    // (ii) DEAD — a CRASHED sibling on the same worktree: its descriptor file is
    // still on disk (nothing purges it) but its registry sessionId is the synthetic
    // auto-ensure marker, i.e. no live session. It can drain NOTHING.
    sleepMs(5);
    const dead = { id: DEAD, worktreePath: F.top, sessionId: 'unclaimed:' + DEAD, ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, dead);
    writeDesc(home, DEAD, dead);
    // (iii) A store-only phantom carrying a real unanswered question.
    seedReg(home, repoKey, { id: F.meshId, worktreePath: F.top, sessionId: null });
    seedDirect(home, repoKey, F.meshId, 'DEADSIB-PAYLOAD', { needsReply: true });

    const bodies = (id) => {
      const s = openS(home, repoKey);
      try { return s.listMessages(id, { sinceCursor: 0 }).map((m) => m.body); }
      finally { s.close(); }
    };

    const r = cli.cmdArchive(F.builderUuid, ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.retiredDuplicates, [F.meshId], 'the phantom is retired; the descriptor-backed dead row is NOT (conservative gate)');
    assert.strictEqual(r.forwardedFromDuplicates, 1, 'the unread direct was forwarded');

    // THE REGRESSION: the payload must NOT land in the dead sibling's partition.
    assert.deepStrictEqual(bodies(DEAD), [],
      'nothing was forwarded into the SESSION-DEAD sibling partition: ' + JSON.stringify(bodies(DEAD)));
    assert.ok(bodies(F.builderUuid).includes('DEADSIB-PAYLOAD'),
      'the backlog consolidated in the archived id partition: ' + JSON.stringify(bodies(F.builderUuid)));

    // ...and that partition is SURFACED as an orphan — no registry row, never deleted.
    const s = openS(home, repoKey);
    try {
      const sum = storeLib.computeSummary(s, { home });
      const o = (sum.orphans || []).find((x) => String(x.id) === F.builderUuid);
      assert.ok(o, 'the archived partition is surfaced as an orphan: ' + JSON.stringify(sum.orphans));
      assert.strictEqual(o.messageCount, 1, JSON.stringify(o));
    } finally { s.close(); }

    // THE REPORT MUST NOT LIE: the dead row is left behind, but not under a reason
    // whose word is "live".
    const leftDead = (r.leftDuplicates || []).find((x) => x.id === DEAD);
    assert.ok(leftDead, 'the dead sibling is surfaced as left: ' + JSON.stringify(r.leftDuplicates));
    assert.notStrictEqual(leftDead.reason, 'live-descriptor',
      'a session-dead row must not be reported as live: ' + JSON.stringify(leftDead));
    assert.strictEqual(leftDead.reason, 'descriptor-no-live-session', JSON.stringify(leftDead));
    assert.strictEqual(msgCount(home, repoKey, F.meshId), 1, 'NO-DELETE: the original phantom row is still there');
  } finally { rm(W); rm(home); }
});

test('cmdArchive: with BOTH a descriptor-backed-dead row and a descriptor-backed LIVE row, the LIVE one is the forward destination', () => {
  const home = tmpHome();
  const W = makeGitRepo('mixed');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const F = idForms(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };
    const DEAD = 'deadbeef-2222-4222-8333-444455556666';
    const LIVE = 'l1vec0de-3333-4222-8333-444455556666';

    const sib = { id: F.builderUuid, worktreePath: F.top, sessionId: 'sess-sib', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, sib);
    writeDesc(home, F.builderUuid, sib);
    seedReg(home, repoKey, { id: F.meshId, worktreePath: F.top, sessionId: null });
    seedDirect(home, repoKey, F.meshId, 'MIXED-PAYLOAD', { needsReply: true });
    // The LIVE child registers FIRST; the DEAD row registers LAST, so it is the
    // FRESHEST row on the worktree. A destination rule that ranked before it filtered
    // for liveness (or that fell back to firstMatch) could pick it — liveness must win
    // over recency here.
    const live = { id: LIVE, worktreePath: F.top, sessionId: 'sess-live-child', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, live);
    writeDesc(home, LIVE, live);
    sleepMs(5);
    const dead = { id: DEAD, worktreePath: F.top, sessionId: '', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, dead);
    writeDesc(home, DEAD, dead);

    const bodies = (id) => {
      const s = openS(home, repoKey);
      try { return s.listMessages(id, { sinceCursor: 0 }).map((m) => m.body); }
      finally { s.close(); }
    };

    const r = cli.cmdArchive(F.builderUuid, ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(bodies(LIVE).includes('MIXED-PAYLOAD'),
      'the LIVE descriptor-backed row received the backlog: ' + JSON.stringify(bodies(LIVE)));
    assert.deepStrictEqual(bodies(DEAD), [], 'the session-dead row received nothing');
    assert.deepStrictEqual(bodies(F.builderUuid), [], 'nothing was forwarded into the partition being tombstoned');

    const byId = Object.fromEntries((r.leftDuplicates || []).map((x) => [x.id, x.reason]));
    assert.strictEqual(byId[LIVE], 'live-descriptor', JSON.stringify(r.leftDuplicates));
    assert.strictEqual(byId[DEAD], 'descriptor-no-live-session', JSON.stringify(r.leftDuplicates));
  } finally { rm(W); rm(home); }
});

test('foldArchivedRegistryRows: the migration also refuses a SESSION-DEAD descriptor-backed destination, and dryRun agrees with apply', () => {
  const home = tmpHome();
  const W = makeGitRepo('deadsibmig');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const F = idForms(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };
    const DEAD = 'deadbeef-4444-4222-8333-444455556666';

    // The pre-fix on-disk state: SIB archived on disk with its row still in the
    // registry, a CRASHED sibling (descriptor present, session dead), and a phantom
    // holding a real unanswered question.
    const sib = { id: F.builderUuid, worktreePath: F.top, sessionId: 'sess-old', ownerKey: repoKey, repoKey };
    writeArchivedDesc(home, F.builderUuid, sib);
    seedReg(home, repoKey, sib);
    seedReg(home, repoKey, { id: F.legacy, worktreePath: F.top, sessionId: null });
    seedDirect(home, repoKey, F.legacy, 'MIG-DEADSIB-PAYLOAD', { needsReply: true });
    sleepMs(5);
    const dead = { id: DEAD, worktreePath: F.top, sessionId: 'unclaimed:' + DEAD, ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, dead);
    writeDesc(home, DEAD, dead);

    const bodies = (id) => {
      const s = openS(home, repoKey);
      try { return s.listMessages(id, { sinceCursor: 0 }).map((m) => m.body); }
      finally { s.close(); }
    };

    // ONE policy, both paths: the dry run must classify the dead row the same way and
    // must never claim it is live.
    const dry = cli.foldArchivedRegistryRows(home, Object.assign({ dryRun: true }, ctx));
    assert.strictEqual(dry.ok, true, JSON.stringify(dry));
    assert.ok(!dry.retired.some((x) => String(x).startsWith(DEAD + '@')),
      'the conservative gate still keeps the descriptor-backed dead row: ' + JSON.stringify(dry.retired));
    const dryDead = dry.left.find((x) => x.id === DEAD);
    assert.ok(dryDead, 'the dry run surfaces the dead row: ' + JSON.stringify(dry.left));
    assert.strictEqual(dryDead.reason, 'descriptor-no-live-session', JSON.stringify(dryDead));

    const m = cli.foldArchivedRegistryRows(home, ctx);
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    assert.strictEqual(m.forwarded, 1, 'the phantom unread was forwarded: ' + JSON.stringify(m));
    assert.deepStrictEqual(bodies(DEAD), [],
      'the migration forwarded NOTHING into the session-dead partition: ' + JSON.stringify(bodies(DEAD)));
    assert.ok(bodies(F.builderUuid).includes('MIG-DEADSIB-PAYLOAD'),
      'the backlog stayed with the archived id: ' + JSON.stringify(bodies(F.builderUuid)));
    const applyDead = m.left.find((x) => x.id === DEAD);
    assert.ok(applyDead, 'the apply path surfaces the dead row too: ' + JSON.stringify(m.left));
    assert.strictEqual(applyDead.reason, dryDead.reason, 'dryRun and apply agree on the reason');

    // SURFACED, never deleted.
    const s = openS(home, repoKey);
    try {
      const sum = storeLib.computeSummary(s, { home });
      assert.ok((sum.orphans || []).some((x) => String(x.id) === F.builderUuid),
        'the archived partition is surfaced as an orphan: ' + JSON.stringify(sum.orphans));
    } finally { s.close(); }
    assert.strictEqual(msgCount(home, repoKey, F.legacy), 1, 'NO-DELETE: the original phantom row is still there');
  } finally { rm(W); rm(home); }
});

// ---------------------------------------------------------------------------
// (7) SHARED ROW-COPY HELPER: one field table, both call shapes, needsReply
// preserved at BOTH sites (the historical drop-a-field bug class).
// ---------------------------------------------------------------------------
test('meshRowCopy: one canonical field table drives BOTH copy shapes (needsReply carried at both sites)', () => {
  const row = {
    sender: 'from-id', recipient: 'to-id', body: 'hello', ts: 1234,
    mtype: 'direct', urgency: 'high', needsReply: true, hash: 'mesh:abc', isHeartbeat: false,
  };
  // Verbatim (rehomeAcrossStores -> store.appendMeshRow).
  const verbatim = cli.meshRowCopy(row, 'row', { workspaceId: 'w1' });
  assert.deepStrictEqual(verbatim, {
    sender: 'from-id', recipient: 'to-id', body: 'hello', ts: 1234, mtype: 'direct',
    urgency: 'high', needsReply: true, hash: 'mesh:abc', isHeartbeat: false, workspaceId: 'w1',
  }, 'the verbatim shape carries every field, hash and heartbeat flag included');

  // Forward (foldGroupIntoSurvivor -> store.appendMeshMessage).
  const forward = cli.meshRowCopy(row, 'message', { to: 'survivor', type: 'direct', urgency: row.urgency || 'normal' });
  assert.deepStrictEqual(forward, {
    from: 'from-id', to: 'survivor', message: 'hello', timestamp: 1234,
    type: 'direct', urgency: 'high', needsReply: true,
  }, 'the forward shape re-addresses the row; hash is recomputed by the caller and a heartbeat can never reach here');

  // The table is the SINGLE source of truth: every canonical field appears in the
  // verbatim shape, and any field marked forwardable appears in the forward shape.
  for (const f of cli.MESH_ROW_COPY_FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(verbatim, f.row), 'verbatim shape carries ' + f.row);
    if (f.msg) assert.ok(Object.prototype.hasOwnProperty.call(forward, f.msg), 'forward shape carries ' + f.msg);
  }
});

test('needsReply survives BOTH real copy sites (fold forward + cross-store re-home)', () => {
  const home = tmpHome();
  const W = makeGitRepo('fields');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const F = idForms(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };

    // Site A — foldGroupIntoSurvivor's forward (through the real archive path).
    const desc = { id: F.builderUuid, worktreePath: F.top, sessionId: 'sess-f', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, desc);
    writeDesc(home, F.builderUuid, desc);
    seedReg(home, repoKey, { id: F.meshId, worktreePath: F.top, sessionId: null });
    seedDirect(home, repoKey, F.meshId, 'question-body', { needsReply: true });
    const r = cli.cmdArchive(F.builderUuid, ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const s = openS(home, repoKey);
    let forwarded;
    try { forwarded = s.listMessages(F.builderUuid, { sinceCursor: 0 }).find((m) => m.body === 'question-body'); }
    finally { s.close(); }
    assert.ok(forwarded, 'the question was forwarded into the archived partition');
    assert.strictEqual(!!forwarded.needsReply, true, 'needsReply survives the FORWARD copy site');

    // Site B — rehomeAcrossStores' verbatim move between two stores.
    const otherKey = storeLib.hashFromWorkspaceId('rehome-subject');
    const rdesc = { id: 'rehome-subject', worktreePath: F.top, sessionId: 'sess-rh', ownerKey: otherKey };
    seedReg(home, otherKey, rdesc);
    writeDesc(home, 'rehome-subject', rdesc);
    seedDirect(home, otherKey, 'rehome-subject', 'rehome-question', { needsReply: true });
    const rh = cli.rehomeAcrossStores(home, 'rehome-subject', otherKey, repoKey, ctx);
    assert.strictEqual(rh.rehomed, true, JSON.stringify(rh));
    const s2 = openS(home, repoKey);
    let moved;
    try { moved = s2.listMessages('rehome-subject', { sinceCursor: 0 }).find((m) => m.body === 'rehome-question'); }
    finally { s2.close(); }
    assert.ok(moved, 'the row was moved into the destination store');
    assert.strictEqual(!!moved.needsReply, true, 'needsReply survives the VERBATIM copy site');
  } finally { rm(W); rm(home); }
});

// ---------------------------------------------------------------------------
// DUAL-PATH WIRING: doctor + update.
// ---------------------------------------------------------------------------
test('doctor repair: fold-archived-rows detects (dry-run) and retires (apply)', () => {
  const home = tmpHome();
  const W = makeGitRepo('doc');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const F = idForms(W);
    const desc = { id: F.builderUuid, worktreePath: F.top, sessionId: 'sess-d', ownerKey: repoKey, repoKey };
    writeArchivedDesc(home, F.builderUuid, desc);
    seedReg(home, repoKey, desc);
    seedReg(home, repoKey, { id: F.meshId, worktreePath: F.top, sessionId: null });

    // Gate CLOSED (no DEVSWARM_REPO_ID) — this repair is AUTO-SAFE, so it must
    // still run; every write lands under the isolated tmp HOME.
    const env = { HOME: home, ANTIHALL_DEVSWARM_STORE_BACKEND: BACKEND, PATH: process.env.PATH };
    const find = (res) => res.find((x) => x.id === 'fold-archived-rows');

    const dry = doctorRepair.runRepairs({ cwd: W, env, home, dryRun: true });
    const d = find(dry);
    assert.ok(d, 'doctor wires a fold-archived-rows repair');
    assert.strictEqual(d.status, 'skipped');
    assert.match(d.msg, /would migrate.*registry row\(s\) of archived workspace/);
    assert.strictEqual(regIds(home, repoKey).length, 2, 'dry-run mutated nothing');

    const applied = doctorRepair.runRepairs({ cwd: W, env, home, dryRun: false });
    const a = find(applied);
    assert.ok(a, 'entry present on apply');
    assert.strictEqual(a.status, 'fixed', JSON.stringify(a));
    assert.deepStrictEqual(regIds(home, repoKey), [], 'both rows retired');

    // Re-verify: a second doctor run is a clean idempotent no-op, never FAILED.
    const again = find(doctorRepair.runRepairs({ cwd: W, env, home, dryRun: false }));
    assert.strictEqual(again.status, 'skipped');
    assert.match(again.msg, /nothing to migrate/);
  } finally { rm(W); rm(home); }
});

test('foldArchivedRowsPostUpdate: not a DevSwarm session -> attempted:false, gate closed', () => {
  const result = U.foldArchivedRowsPostUpdate({
    paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
    env: {},
    cwd: process.cwd(),
    devswarm: { foldArchivedRegistryRows: () => { throw new Error('must not run when the gate is closed'); } },
  });
  assert.strictEqual(result.attempted, false);
  assert.match(result.detail, /not a DevSwarm session/);
});

test('foldArchivedRowsPostUpdate: pulled plugin tree missing scripts/companion files -> fail-open, never throws', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-archgrp-empty-'));
  try {
    const result = U.foldArchivedRowsPostUpdate({
      paths: { pluginSrcDir: empty },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: process.cwd(),
      home: empty,
    });
    assert.strictEqual(result.attempted, false);
    assert.match(result.detail, /expected plugin files not found/);
  } finally { rm(empty); }
});

test('foldArchivedRowsPostUpdate: gate OPEN -> retires the archived workspace rows through the real plugin source', () => {
  const home = tmpHome();
  const W = makeGitRepo('upd');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const F = idForms(W);
    const desc = { id: F.builderUuid, worktreePath: F.top, sessionId: 'sess-u', ownerKey: repoKey, repoKey };
    writeArchivedDesc(home, F.builderUuid, desc);
    seedReg(home, repoKey, desc);
    seedReg(home, repoKey, { id: F.meshId, worktreePath: F.top, sessionId: null });

    const result = U.foldArchivedRowsPostUpdate({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'r1', HOME: home, ANTIHALL_DEVSWARM_STORE_BACKEND: BACKEND },
      cwd: W,
      home,
    });
    assert.strictEqual(result.attempted, true, JSON.stringify(result));
    assert.strictEqual(result.retired, 2, JSON.stringify(result));
    assert.deepStrictEqual(regIds(home, repoKey), []);

    // Idempotent through this entry point too.
    const again = U.foldArchivedRowsPostUpdate({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'r1', HOME: home, ANTIHALL_DEVSWARM_STORE_BACKEND: BACKEND },
      cwd: W,
      home,
    });
    assert.strictEqual(again.attempted, true);
    assert.strictEqual(again.retired, 0);
  } finally { rm(W); rm(home); }
});

// ---------------------------------------------------------------------------
// CANDIDATE LOCKING (archive paths only). The atomic conditional tombstone
// (removeRegistryIf on the exact snapshot) refuses every interleaving where a
// candidate's re-register lands BEFORE it — but NOT the one where it lands
// AFTER. cmdRegister writes the descriptor and upserts the registry row as two
// separate steps, both under withIdLock(id); a fold that samples the row, sees
// no descriptor yet, and CASes before the upsert tombstones a live child that is
// at that instant coming back. So the archive paths now hold the CANDIDATE's own
// lock across the descriptor-check + tombstone.
//
// The interleaving is driven DETERMINISTICALLY (no timing): the test itself
// holds the candidate's per-id lock — exactly what an in-flight cmdRegister for
// that id holds — while the archive runs inside that window.
// ---------------------------------------------------------------------------
test('cmdArchive: a candidate MID-RE-REGISTER is not tombstoned and nothing is forwarded into the archived partition', () => {
  const home = tmpHome();
  const W = makeGitRepo('midreg');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const F = idForms(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };
    const Y = 'aa11bb22-3333-4444-8555-666677778888'; // the restarting child's builder UUID

    // X: the workspace being archived (descriptor-backed, its own live row).
    const x = { id: F.builderUuid, worktreePath: F.top, sessionId: 'sess-x', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, x);
    writeDesc(home, F.builderUuid, x);
    // Y: SAME worktree, a LIVE registry row but NO descriptor on disk yet — the
    // exact shape of a child restarting under the same builder UUID, caught after
    // its previous descriptor is gone and before cmdRegister has written the new
    // one. Its unread direct sits in ITS OWN partition.
    seedReg(home, repoKey, { id: Y, worktreePath: F.top, sessionId: 'sess-y', ownerKey: repoKey, repoKey });
    seedDirect(home, repoKey, Y, 'payload-for-y');

    let r = null;
    // The whole in-flight cmdRegister(Y) window: its lock is held across BOTH of
    // its writes, and the archive runs inside it.
    const held = cli.withIdLock(Y, home, () => {
      r = cli.cmdArchive(F.builderUuid, ctx);
      // ...and only NOW does the re-register land (descriptor first, then the row),
      // which is precisely the ordering the CAS alone cannot defend against.
      const ydesc = { id: Y, worktreePath: F.top, sessionId: 'sess-y2', ownerKey: repoKey, repoKey };
      writeDesc(home, Y, ydesc);
      seedReg(home, repoKey, ydesc);
      return true;
    });
    assert.strictEqual(held, true, 'the test held the candidate lock for the whole window');

    assert.strictEqual(r.ok, true, 'the archive itself still succeeds: ' + JSON.stringify(r));
    // NOT STRANDED (asserted first — this is the substantive harm): no copy of Y's
    // backlog was forwarded into X's partition, whose own registry row cmdArchive
    // tombstones moments later, so nothing would ever drain it.
    assert.strictEqual(msgCount(home, repoKey, F.builderUuid), 0, 'no forwarded copy stranded in the archived partition');
    assert.ok(!r.forwardedFromDuplicates, 'the archive reports no forward: ' + JSON.stringify(r.forwardedFromDuplicates));
    assert.ok(!r.retiredDuplicates, 'the live child was never tombstoned: ' + JSON.stringify(r.retiredDuplicates));
    assert.strictEqual(msgCount(home, repoKey, Y), 1, "Y's own unread is untouched in its own partition");

    // Y was SKIPPED, not tombstoned, and is surfaced with the real reason.
    assert.ok(regIds(home, repoKey).includes(Y), 'the re-registering child keeps its registry row');
    assert.deepStrictEqual(r.leftDuplicates, [{ id: Y, reason: 'lock-busy' }],
      'the skipped candidate is surfaced, never silently dropped: ' + JSON.stringify(r.leftDuplicates));

    // End state: X archived, Y live again and still addressable.
    assert.deepStrictEqual(activeIds(home, repoKey), [Y], 'only the re-registered child projects active');
    const s = openS(home, repoKey);
    try {
      assert.deepStrictEqual(s.listMessages(Y, { sinceCursor: 0 }).map((m) => m.body), ['payload-for-y'],
        'the live child still drains its own partition');
    } finally { s.close(); }
  } finally { rm(W); rm(home); }
});

test('cmdArchive: a lock-busy candidate is SKIPPED and surfaced, and a later pass still retires it (idempotent)', () => {
  const home = tmpHome();
  const W = makeGitRepo('lockbusy');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const F = idForms(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };

    const x = { id: F.builderUuid, worktreePath: F.top, sessionId: 'sess-x', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, x);
    writeDesc(home, F.builderUuid, x);
    // A genuine store-only phantom on the same worktree, holding an unread direct.
    seedReg(home, repoKey, { id: F.meshId, worktreePath: F.top, sessionId: null });
    seedDirect(home, repoKey, F.meshId, 'payload-phantom', { needsReply: true });

    let r = null;
    cli.withIdLock(F.meshId, home, () => { r = cli.cmdArchive(F.builderUuid, ctx); });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.leftDuplicates, [{ id: F.meshId, reason: 'lock-busy' }], JSON.stringify(r.leftDuplicates));
    assert.ok(regIds(home, repoKey).includes(F.meshId), 'the locked candidate is NOT tombstoned');
    assert.strictEqual(msgCount(home, repoKey, F.builderUuid), 0, 'and NOT forwarded while skipped');

    // The lock is released; the migration pass (same primitive) now retires it and
    // forwards its unread — nothing was lost by the skip.
    const m = cli.foldArchivedRegistryRows(home, ctx);
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    assert.deepStrictEqual(regIds(home, repoKey), [], 'the retry retires the previously locked row');
    assert.strictEqual(m.forwarded, 1, 'its unread direct is forwarded on the retry: ' + JSON.stringify(m));
    const s = openS(home, repoKey);
    try {
      const fwd = s.listMessages(F.builderUuid, { sinceCursor: 0 }).find((mm) => mm.body === 'payload-phantom');
      assert.ok(fwd, 'the forwarded copy landed in the archived partition');
      assert.strictEqual(!!fwd.needsReply, true, 'needsReply preserved through the retry forward');
    } finally { s.close(); }
    assert.strictEqual(msgCount(home, repoKey, F.meshId), 1, 'NO-DELETE: the original row is still there');
  } finally { rm(W); rm(home); }
});

test('retireArchivedWorktreeGroup: reported left-reason reflects the IN-LOCK re-read, not the pre-lock snapshot, when a candidate\'s liveness diverges inside the lock window', () => {
  const home = tmpHome();
  const W = makeGitRepo('divergeleft');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const F = idForms(W);
    const CAND = 'cccccccc-1111-4222-8333-444455556666';

    const archivedRow = { id: F.builderUuid, worktreePath: F.top, sessionId: 'sess-archived', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, archivedRow);

    // Descriptor-backed sibling on the SAME worktree, registry sessionId DEAD —
    // never a forward-survivor candidate, and the PRE-LOCK snapshot would derive
    // 'descriptor-no-live-session' from it.
    const candDead = { id: CAND, worktreePath: F.top, sessionId: '', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, candDead);
    writeDesc(home, CAND, candDead);

    const s = openS(home, repoKey);
    try {
      // Deterministically simulate the divergence: the FIRST listRegistry() call
      // is the pre-lock snapshot retireArchivedWorktreeGroup builds candidates/
      // rowOf from (CAND dead); every call AFTER that — the in-lock re-read
      // foldOne actually classifies against — sees CAND now LIVE.
      let calls = 0;
      const realListRegistry = s.listRegistry.bind(s);
      s.listRegistry = () => {
        calls++;
        const rows = realListRegistry();
        if (calls === 1) return rows;
        return rows.map((d) => (d && String(d.id) === CAND
          ? Object.assign({}, d, { sessionId: 'sess-cand-now-live' })
          : d));
      };

      const r = cli.retireArchivedWorktreeGroup(s, home, F.builderUuid, F.top);
      const left = (r.left || []).find((x) => x.id === CAND);
      assert.ok(left, 'candidate is surfaced as left: ' + JSON.stringify(r.left));
      // The decision (never tombstoned — descriptor-backed) is unaffected either
      // way; only the REPORTED reason must track what the pass actually acted on.
      assert.strictEqual(left.reason, 'live-descriptor',
        'reason must reflect the in-lock re-read (now live), not the stale pre-lock snapshot ' +
        '(which would have said descriptor-no-live-session): ' + JSON.stringify(r.left));
    } finally { s.close(); }
  } finally { rm(W); rm(home); }
});

test('candidate locking is OPT-IN: retireWorktreeDuplicates and foldMeshDuplicates are unchanged (no candidate lock on their path)', () => {
  const home = tmpHome();
  const W = makeGitRepo('optin');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const F = idForms(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };

    // --- retireWorktreeDuplicates (called from cmdRegister, under the REGISTERING
    // id's lock — it carries the same pre-existing race, deliberately untouched).
    const keep = { id: F.builderUuid, worktreePath: F.top, sessionId: 'sess-keep', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, keep);
    writeDesc(home, F.builderUuid, keep);
    seedReg(home, repoKey, { id: F.meshId, worktreePath: F.top, sessionId: null });

    // Hold the CANDIDATE's lock. If this caller had started locking candidates, the
    // row would be skipped; it is retired instead, proving behaviour is unchanged.
    let a = null;
    cli.withIdLock(F.meshId, home, () => { a = cli.retireWorktreeDuplicates(home, keep, ctx); });
    assert.ok(a, 'retireWorktreeDuplicates acted');
    assert.deepStrictEqual(a.retired.map(String), [F.meshId],
      'the locked candidate is STILL retired on the pre-existing path: ' + JSON.stringify(a));
    assert.deepStrictEqual(regIds(home, repoKey), [F.builderUuid]);

    // --- foldMeshDuplicates (doctor/migration sweep over the whole registry).
    seedReg(home, repoKey, { id: F.legacy, worktreePath: F.top, sessionId: null });
    let b = null;
    cli.withIdLock(F.legacy, home, () => { b = cli.foldMeshDuplicates(home, ctx); });
    assert.strictEqual(b.ok, true, JSON.stringify(b));
    assert.ok(b.retired.map(String).includes(F.legacy),
      'the locked candidate is STILL retired by foldMeshDuplicates: ' + JSON.stringify(b));
    assert.deepStrictEqual(regIds(home, repoKey), [F.builderUuid]);
  } finally { rm(W); rm(home); }
});
