'use strict';
// ARCHIVE MUST RETIRE THE WHOLE IDENTITY FAMILY (descriptor half).
//
// Defect reproduced here (live incident): ONE workspace was registered under TWO
// descriptor ids — a slug row (`fb-fix-…-a55f20ef`, whose `sessionId` was the
// UUID) and the builder-UUID row (`8f3d585d-…`). `cmdArchive` keys its tombstone
// as `archived/<id>.json`, so archiving the slug could never retire the UUID row.
// The UUID descriptor stayed in `workspaces/`, `readDescriptors`
// (companion/devswarm-supervisor.js) kept enumerating it (it cross-checks no
// tombstone), and hooks/devswarm-parent-gate.js kept nagging the Primary about a
// workspace that had already been archived and whose worktree was gone from disk.
//
// The grouping rule under test is NOT re-derived here: it lives in
// companion/lib/devswarm-identity-family.js (identityFamilyTwins), the same
// module that owns the read-time collapse — one identity rule in the tree, not
// two that can drift. It uses the STRONGEST link only (one row's sessionId IS the
// other row's id), which is why the no-over-collapse test below matters: bare
// worktree equality must NOT retire anything.
//
// Real git worktrees as cwd (repoKeyForWorktree spawns git). Mirrors
// tests/scripts/devswarm-archive-group.test.js's harness.

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

const BACKEND = 'journal';

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-archfam-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-archfam-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function seedReg(home, bucket, desc) {
  const s = storeLib.openStore({ home, hash: bucket, backend: BACKEND });
  try { s.upsertRegistry(desc); } finally { s.close(); }
}
function writeDesc(home, id, desc) {
  const p = cli.descriptorPath(home, id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(desc));
}
function archivedPathOf(home, id) { return path.join(cli.archivedDir(home), id + '.json'); }
const liveDesc = (home, id) => fs.existsSync(cli.descriptorPath(home, id));
const tombstoned = (home, id) => fs.existsSync(archivedPathOf(home, id));

// The live incident's exact shape: a SLUG row whose sessionId IS the UUID row's
// id, and a UUID row on a NESTED worktree path with a DIFFERENT repoKey.
const SLUG = 'fb-fix-esim-subscription-money-granting-entit-a55f20ef';
const UUID = '8f3d585d-8d9b-4214-94a3-23fbcf9b37d8';

test('LIVE INCIDENT: archiving the slug row also retires its cross-linked UUID twin descriptor (the un-retirable nag)', () => {
  const home = tmpHome();
  const W = makeGitRepo('fam');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const top = inst.resolveWorktree(W);
    const nested = path.join(top, 'skyfb');
    fs.mkdirSync(nested, { recursive: true });
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };

    // The archived row: slug id, sessionId === the UUID row's id.
    const slugDesc = { id: SLUG, worktreePath: top, sessionId: UUID, ownerKey: repoKey, repoKey };
    // The twin: UUID id, its OWN distinct sessionId, a NESTED worktreePath and a
    // DIFFERENT persisted repoKey — exactly the live pair. Neither the worktree
    // path nor the repoKey matches, so ONLY the id/sessionId cross-link can find it.
    const twinDesc = { id: UUID, worktreePath: nested, sessionId: 'ec774c7f-a095-445c-a3f0-69a9b43e43fa', ownerKey: 'modules-ba76c8', repoKey: 'modules-ba76c8' };
    seedReg(home, repoKey, slugDesc);
    writeDesc(home, SLUG, slugDesc);
    writeDesc(home, UUID, twinDesc);
    assert.ok(liveDesc(home, UUID), 'twin descriptor is live before archive');

    const r = cli.cmdArchive(SLUG, ctx);
    assert.strictEqual(r.ok, true, 'archive succeeds: ' + JSON.stringify(r));
    assert.deepStrictEqual(r.retiredFamilyDescriptors, [UUID], 'the twin is reported, not silently retired');

    assert.strictEqual(liveDesc(home, UUID), false, 'the twin descriptor no longer enumerates in workspaces/ — the nag source is gone');
    assert.strictEqual(tombstoned(home, UUID), true, 'the twin is TOMBSTONED, never deleted');
    // NO DATA LOSS: the tombstone holds the twin's bytes, verbatim.
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(archivedPathOf(home, UUID), 'utf8')), twinDesc);
    assert.strictEqual(tombstoned(home, SLUG), true, "the archived id's own tombstone is unchanged");
  } finally { rm(home); rm(W); }
});

test('NO OVER-COLLAPSE: a same-worktree descriptor with NO id/sessionId cross-link is NEVER retired (two live tabs stay live)', () => {
  const home = tmpHome();
  const W = makeGitRepo('nocollapse');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const top = inst.resolveWorktree(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };

    const target = { id: 'tab-one-aaaa1111', worktreePath: top, sessionId: 'sess-tab-one', ownerKey: repoKey, repoKey };
    // IDENTICAL worktreePath, but a genuinely DIFFERENT identity: distinct id AND
    // distinct sessionId, with no cross-link. This is the legitimate "two live
    // tabs on one worktree" case the repo protects elsewhere; retiring it would
    // archive a workspace nobody asked to archive.
    const other = { id: 'tab-two-bbbb2222', worktreePath: top, sessionId: 'sess-tab-two', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, target);
    writeDesc(home, 'tab-one-aaaa1111', target);
    writeDesc(home, 'tab-two-bbbb2222', other);

    const r = cli.cmdArchive('tab-one-aaaa1111', ctx);
    assert.strictEqual(r.ok, true, 'archive succeeds: ' + JSON.stringify(r));
    assert.strictEqual(r.retiredFamilyDescriptors, undefined, 'nothing may be reported as family-retired');
    assert.strictEqual(liveDesc(home, 'tab-two-bbbb2222'), true, 'the unrelated live tab keeps its descriptor');
    assert.strictEqual(tombstoned(home, 'tab-two-bbbb2222'), false, 'and is never tombstoned');
  } finally { rm(home); rm(W); }
});

test('REVERSE LINK: the TWIN names the archived id in its own sessionId -> also retired (link is symmetric)', () => {
  const home = tmpHome();
  const W = makeGitRepo('reverse');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const top = inst.resolveWorktree(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };

    const target = { id: 'uuid-target-cccc3333', worktreePath: top, sessionId: 'sess-own', ownerKey: repoKey, repoKey };
    const twin = { id: 'slug-twin-dddd4444', worktreePath: path.join(top, 'nested'), sessionId: 'uuid-target-cccc3333', repoKey: 'other-key' };
    seedReg(home, repoKey, target);
    writeDesc(home, 'uuid-target-cccc3333', target);
    writeDesc(home, 'slug-twin-dddd4444', twin);

    const r = cli.cmdArchive('uuid-target-cccc3333', ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.retiredFamilyDescriptors, ['slug-twin-dddd4444']);
    assert.strictEqual(liveDesc(home, 'slug-twin-dddd4444'), false);
    assert.strictEqual(tombstoned(home, 'slug-twin-dddd4444'), true);
  } finally { rm(home); rm(W); }
});

test('IDEMPOTENT: re-archiving finds no live twin and reports nothing (no throw, no second write)', () => {
  const home = tmpHome();
  const W = makeGitRepo('idem');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const top = inst.resolveWorktree(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };
    const slugDesc = { id: SLUG, worktreePath: top, sessionId: UUID, ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, slugDesc);
    writeDesc(home, SLUG, slugDesc);
    writeDesc(home, UUID, { id: UUID, worktreePath: path.join(top, 'x'), sessionId: 'sess-x', repoKey });

    const first = cli.cmdArchive(SLUG, ctx);
    assert.deepStrictEqual(first.retiredFamilyDescriptors, [UUID]);
    const beforeBytes = fs.readFileSync(archivedPathOf(home, UUID), 'utf8');

    const second = cli.cmdArchive(SLUG, ctx);
    assert.strictEqual(second.ok, true, 'a re-archive still succeeds: ' + JSON.stringify(second));
    assert.strictEqual(second.retiredFamilyDescriptors, undefined, 'nothing left to retire on the second pass');
    assert.strictEqual(fs.readFileSync(archivedPathOf(home, UUID), 'utf8'), beforeBytes, "the twin's tombstone bytes are untouched");
  } finally { rm(home); rm(W); }
});

test('NEVER CLOBBER: a pre-existing tombstone holding DIFFERENT bytes -> the twin is LEFT LIVE and SURFACED, never overwritten', () => {
  const home = tmpHome();
  const W = makeGitRepo('clobber');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const top = inst.resolveWorktree(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };
    const slugDesc = { id: SLUG, worktreePath: top, sessionId: UUID, ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, slugDesc);
    writeDesc(home, SLUG, slugDesc);
    writeDesc(home, UUID, { id: UUID, worktreePath: path.join(top, 'x'), sessionId: 'sess-x', repoKey });

    // An UNRELATED archived generation of the same id already occupies the
    // tombstone path. Those bytes must survive untouched.
    const foreign = { id: UUID, worktreePath: '/somewhere/else', sessionId: 'older-generation', repoKey: 'old-key' };
    fs.mkdirSync(cli.archivedDir(home), { recursive: true });
    fs.writeFileSync(archivedPathOf(home, UUID), JSON.stringify(foreign));

    const r = cli.cmdArchive(SLUG, ctx);
    assert.strictEqual(r.ok, true, 'the primary archive still succeeds: ' + JSON.stringify(r));
    assert.strictEqual(r.retiredFamilyDescriptors, undefined, 'nothing was retired');
    assert.deepStrictEqual(r.leftFamilyDescriptors, [{ id: UUID, reason: 'archived-tombstone-differs' }],
      'the twin we refused to retire is surfaced with a real reason, never silently dropped');
    assert.strictEqual(liveDesc(home, UUID), true, 'the live twin descriptor is NOT unlinked when we could not tombstone it');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(archivedPathOf(home, UUID), 'utf8')), foreign, 'the pre-existing tombstone bytes are untouched');
  } finally { rm(home); rm(W); }
});

test('SELF-LINK: a descriptor whose own sessionId equals its own id is never its own twin', () => {
  const home = tmpHome();
  const W = makeGitRepo('selflink');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const top = inst.resolveWorktree(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };
    const selfLinked = { id: 'self-eeee5555', worktreePath: top, sessionId: 'self-eeee5555', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, selfLinked);
    writeDesc(home, 'self-eeee5555', selfLinked);
    // A bystander that shares NOTHING with it.
    writeDesc(home, 'bystander-ffff6666', { id: 'bystander-ffff6666', worktreePath: path.join(top, 'b'), sessionId: 'sess-b', repoKey });

    const r = cli.cmdArchive('self-eeee5555', ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.retiredFamilyDescriptors, undefined);
    assert.strictEqual(liveDesc(home, 'bystander-ffff6666'), true, 'the bystander is untouched');
  } finally { rm(home); rm(W); }
});

// ---------------------------------------------------------------------------
// FORWARD MIGRATION — repairs installs already split by the OLD archive code.
// Required, not optional: the whole-family retire above runs only at archive
// TIME, so a twin orphaned by a pre-fix archive stays live in `workspaces/`
// forever and keeps the parent gate nagging. Verified against a real install:
// archived/fb-…-a55f20ef.json (sessionId 8f3d585d-…) sat beside a LIVE
// workspaces/8f3d585d-….json.
// ---------------------------------------------------------------------------

function writeArchivedDesc(home, id, desc) {
  const p = archivedPathOf(home, id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(desc));
}

test('MIGRATION: an ALREADY-orphaned twin (pre-fix archive) is retired retroactively; a re-run is a no-op', () => {
  const home = tmpHome();
  try {
    // The exact pre-fix end state: slug tombstoned, UUID twin still LIVE.
    writeArchivedDesc(home, SLUG, { id: SLUG, worktreePath: '/gone/wt', sessionId: UUID, repoKey: 'skycrew-a7a7a5' });
    const twin = { id: UUID, worktreePath: '/gone/wt/skyfb', sessionId: 'ec774c7f', repoKey: 'modules-ba76c8' };
    writeDesc(home, UUID, twin);

    // dryRun classifies WITHOUT writing.
    const dry = cli.foldArchivedFamilyDescriptors(home, { dryRun: true });
    assert.strictEqual(dry.ok, true, JSON.stringify(dry));
    assert.deepStrictEqual(dry.retired, [UUID]);
    assert.strictEqual(dry.pending, 1);
    assert.strictEqual(liveDesc(home, UUID), true, 'dryRun must not write');

    const r = cli.foldArchivedFamilyDescriptors(home, {});
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.retired, [UUID]);
    assert.strictEqual(liveDesc(home, UUID), false, 'the orphaned twin no longer enumerates');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(archivedPathOf(home, UUID), 'utf8')), twin, 'NO-DELETE: bytes preserved in the tombstone');

    const again = cli.foldArchivedFamilyDescriptors(home, {});
    assert.strictEqual(again.ok, true);
    assert.deepStrictEqual(again.retired, [], 'idempotent: nothing left to do');
  } finally { rm(home); }
});

test('MIGRATION: a MID-ARCHIVE state (both descriptors present for one id) is left alone', () => {
  const home = tmpHome();
  try {
    const d = { id: SLUG, worktreePath: '/gone/wt', sessionId: UUID };
    writeArchivedDesc(home, SLUG, d);
    writeDesc(home, SLUG, d); // BOTH present -> applyRecoveryIntents' job, not ours
    writeDesc(home, UUID, { id: UUID, worktreePath: '/gone/wt/skyfb', sessionId: 'other' });

    const r = cli.foldArchivedFamilyDescriptors(home, {});
    assert.deepStrictEqual(r.retired, [], 'a crashed/mid-archive id must not be swept here');
    assert.strictEqual(liveDesc(home, UUID), true, 'its twin stays live');
  } finally { rm(home); }
});

test('MIGRATION: an unrelated live descriptor sharing an archived workspace\'s worktree is NEVER retired', () => {
  const home = tmpHome();
  try {
    writeArchivedDesc(home, SLUG, { id: SLUG, worktreePath: '/shared/wt', sessionId: 'sess-slug' });
    // Same worktreePath, but NO id/sessionId cross-link -> a distinct workspace.
    writeDesc(home, UUID, { id: UUID, worktreePath: '/shared/wt', sessionId: 'sess-uuid' });

    const r = cli.foldArchivedFamilyDescriptors(home, {});
    assert.deepStrictEqual(r.retired, [], 'bare worktree equality must never justify a write');
    assert.strictEqual(liveDesc(home, UUID), true);
  } finally { rm(home); }
});

test('MIGRATION: fail-open — no archived dir at all -> clean no-op, never throws', () => {
  const home = tmpHome();
  try {
    const r = cli.foldArchivedFamilyDescriptors(home, {});
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.retired, []);
    assert.strictEqual(r.scanned, 0);
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// DUAL-PATH WIRING: doctor + update (this repo's persisted-shape rule — a shape
// change ships its forward-migration in BOTH).
// ---------------------------------------------------------------------------
const doctorRepair = require('../../plugins/anti-hall/hooks/lib/doctor-repair.js');
const U = require('../../plugins/anti-hall/skills/update/scripts/update.js');
const REAL_PLUGIN_SRC_DIR = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');

test('DOCTOR WIRING: fold-archived-family-descriptors detects (dry-run) and retires (apply), then is idempotent', () => {
  const home = tmpHome();
  const W = makeGitRepo('doctorfam');
  try {
    writeArchivedDesc(home, SLUG, { id: SLUG, worktreePath: '/gone/wt', sessionId: UUID });
    writeDesc(home, UUID, { id: UUID, worktreePath: '/gone/wt/skyfb', sessionId: 'ec774c7f' });
    const env = { HOME: home, ANTIHALL_DEVSWARM_STORE_BACKEND: BACKEND, PATH: process.env.PATH };
    const find = (res) => res.find((x) => x.id === 'fold-archived-family-descriptors');

    const d = find(doctorRepair.runRepairs({ cwd: W, env, home, dryRun: true }));
    assert.ok(d, 'doctor wires the repair');
    assert.strictEqual(d.status, 'skipped');
    assert.match(d.msg, /would migrate.*twin descriptor/);
    assert.strictEqual(liveDesc(home, UUID), true, 'dry-run mutated nothing');

    const a = find(doctorRepair.runRepairs({ cwd: W, env, home, dryRun: false }));
    assert.strictEqual(a.status, 'fixed', JSON.stringify(a));
    assert.strictEqual(liveDesc(home, UUID), false, 'the orphaned twin is retired');
    assert.strictEqual(tombstoned(home, UUID), true, 'NO-DELETE');

    const again = find(doctorRepair.runRepairs({ cwd: W, env, home, dryRun: false }));
    assert.strictEqual(again.status, 'skipped', 'a second run is a clean no-op, never FAILED');
    assert.match(again.msg, /nothing to migrate/);
  } finally { rm(W); rm(home); }
});

test('UPDATE WIRING: the post-update pass runs the family-descriptor migration and reports it', () => {
  const home = tmpHome();
  try {
    writeArchivedDesc(home, SLUG, { id: SLUG, worktreePath: '/gone/wt', sessionId: UUID });
    writeDesc(home, UUID, { id: UUID, worktreePath: '/gone/wt/skyfb', sessionId: 'ec774c7f' });
    const r = U.foldArchivedRowsPostUpdate({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'repo-1', HOME: home }, // gate OPEN
      cwd: process.cwd(),
      home,
    });
    assert.strictEqual(r.attempted, true, JSON.stringify(r));
    assert.strictEqual(r.familyDescriptorsRetired, 1, JSON.stringify(r));
    assert.match(r.detail, /orphaned twin descriptor/);
    assert.strictEqual(liveDesc(home, UUID), false);
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// WRITE-AUTHORITY SAFETY (P0-1 / P0-2 / P0-3, adversarial-review round).
//
// GOVERNING PRINCIPLE, restated because every test below is an instance of it:
//   A one-way historical identity link is NOT sufficient write authority to
//   retire a descriptor. When authority cannot be POSITIVELY PROVEN at the
//   moment of the write, the correct behavior is a SAFETY REFUSAL — leave the
//   descriptor ACTIVE and REPORT it. A false retirement destroys a live
//   workspace; a false refusal leaves a stale row a later run can handle.
//
// MUTATION CHECKS — a DISCOVERABLE, RE-RUNNABLE list, not a transcript claim.
// Each row names a specific WRONG implementation and the test that KILLS it.
// Every row below was verified by actually applying the mutation to the shipped
// source and observing the named test(s) go red, then restoring. To re-verify:
// apply the mutation the row describes, run the files named at the bottom of this
// block, and confirm ONLY the listed test(s) fail.
// M1  archive by copyFileSync + unlink instead of linkSync  -> V1
// M2  tombstone conflict detected by CONTENT only (same bytes, different inode
//     wrongly accepted)                                      -> V2
// M3  union fallback keyed on `repoKey` only, ignoring the ownerKey-only
//     rehomeCore shape                                       -> V3 (parent-gate)
// M4  worktreeIsGone treating ANY lstat error as gone (ENOTDIR/EACCES)
//                                                            -> V4 (parent-gate)
// M5  worktreeIsGone lstat'ing a RELATIVE path from the reader's own cwd
//                                                            -> P1 (parent-gate)
// M6  classify-then-write with NO re-read inside the lock    -> P0-1
// M7  re-read inside the lock that compares BYTES only (misses a same-content
//     atomic rename => new inode)                            -> P0-1b
// M8  a descriptor writer that skips the per-id lock         -> P0-2 (child-turn)
// M9  migration trusting a stale one-way tombstone link      -> P0-3
// M10 migration gate that accepts a RELATIVE worktreePath as "gone"
//                                                            -> P0-3b
// M11 migration gate reading a dangling symlink as "gone"    -> P0-3c
// M12 update.js folding only `retired.length`, dropping left/errors/ok
//                                                            -> V5a
// M13 doctor reporting "nothing to migrate" while `left` is non-empty
//                                                            -> V5b
// M14 archive-time path wrongly inheriting the migration's worktree-gone gate
//     (which would break the real live-incident repair)      -> P0-3d
// M15 buildDescriptorFromFlags persisting a RELATIVE worktreePath verbatim
//                                                            -> P1 WRITER
//
// FILES COVERED: this file (M1, M2, M6, M7, M9, M10, M11, M12, M13, M14, M15)
//   + tests/hooks/devswarm-parent-gate.test.js (M3, M4, M5)
//   + tests/hooks/devswarm-child-turn.test.js  (M8)
//
// A NEGATIVE RESULT WORTH KEEPING: M8 is NOT killed by asserting that
// locks/<id>.lock was touched during a child turn. Other parts of that same hook
// take per-id locks AFTER the descriptor write, so such a test passes for the
// unlocked variant too (observed, not assumed). Only the WRITE-TIMING observable
// discriminates — see the note above the P0-2 tests in that file.
// ---------------------------------------------------------------------------

// Atomic replace — the shape EVERY descriptor writer in the tree uses
// (writeFileSync(tmp) + renameSync). It installs a NEW INODE at the pathname,
// which is precisely why a pathname-keyed unlink is unsafe without a lock.
function writeDescAtomic(home, id, desc) {
  const p = cli.descriptorPath(home, id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(desc));
  fs.renameSync(tmp, p);
}
const inoOf = (p) => { const s = fs.lstatSync(p); return s.dev + ':' + s.ino; };

// interposeAtLockAcquire(id, fn) — run fn() exactly ONCE, at the instant the
// retirement reaches for `locks/<id>.lock`, i.e. AFTER the candidate scan has
// classified the twin and BEFORE the critical section opens. That window is the
// P0-1 defect verbatim; there is no other way to hit it deterministically.
// acquireLock's first act is openSync(<lockpath>, 'wx').
function interposeAtLockAcquire(id, fn) {
  const suffix = path.sep + 'locks' + path.sep + id + '.lock';
  const real = fs.openSync;
  const state = { fired: false };
  fs.openSync = function (p) {
    if (!state.fired && typeof p === 'string' && p.endsWith(suffix)) {
      state.fired = true;
      fn();
    }
    return real.apply(fs, arguments);
  };
  state.restore = () => { fs.openSync = real; };
  return state;
}

test('P0-1: a twin RE-REGISTERED between the scan and the lock is NOT retired — safety refusal, live descriptor intact', () => {
  const home = tmpHome();
  const W = makeGitRepo('p0race');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const top = inst.resolveWorktree(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };
    const slugDesc = { id: SLUG, worktreePath: top, sessionId: UUID, ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, slugDesc);
    writeDesc(home, SLUG, slugDesc);
    writeDesc(home, UUID, { id: UUID, worktreePath: path.join(top, 'old'), sessionId: 'sess-old', repoKey });

    const fresh = { id: UUID, worktreePath: path.join(top, 'fresh'), sessionId: 'REGISTERED_AFTER_SCAN', repoKey };
    const spy = interposeAtLockAcquire(UUID, () => writeDescAtomic(home, UUID, fresh));
    let r;
    try { r = cli.cmdArchive(SLUG, ctx); } finally { spy.restore(); }

    assert.ok(spy.fired, 'precondition: the re-registration actually landed in the scan->lock window');
    assert.strictEqual(r.ok, true, 'the primary archive still succeeds: ' + JSON.stringify(r));
    assert.strictEqual(r.retiredFamilyDescriptors, undefined, 'the re-registered descriptor must NOT be reported retired');
    assert.deepStrictEqual(r.leftFamilyDescriptors, [{ id: UUID, reason: 'descriptor-changed-since-scan' }],
      'the refusal is SURFACED with a real reason, never a silent drop');
    assert.strictEqual(liveDesc(home, UUID), true, 'the freshly-registered LIVE descriptor is still active');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(cli.descriptorPath(home, UUID), 'utf8')), fresh,
      'and still holds the NEW generation, unmodified');
    assert.strictEqual(tombstoned(home, UUID), false, 'nothing was hardlinked into archived/ either');
  } finally { rm(home); rm(W); }
});

test('P0-1b (kills the bytes-only variant): a SAME-CONTENT atomic re-registration still refuses — inode identity is checked', () => {
  const home = tmpHome();
  const W = makeGitRepo('p0race2');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const top = inst.resolveWorktree(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };
    const slugDesc = { id: SLUG, worktreePath: top, sessionId: UUID, ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, slugDesc);
    writeDesc(home, SLUG, slugDesc);
    const twin = { id: UUID, worktreePath: path.join(top, 'old'), sessionId: 'sess-old', repoKey };
    writeDesc(home, UUID, twin);
    const inoBefore = inoOf(cli.descriptorPath(home, UUID));

    // BYTE-IDENTICAL re-publish. A fingerprint that compares only content would
    // see "unchanged" and unlink a descriptor a live child just re-registered.
    const spy = interposeAtLockAcquire(UUID, () => writeDescAtomic(home, UUID, twin));
    let r;
    try { r = cli.cmdArchive(SLUG, ctx); } finally { spy.restore(); }

    assert.ok(spy.fired, 'precondition: the interposition fired');
    assert.notStrictEqual(inoOf(cli.descriptorPath(home, UUID)), inoBefore,
      'precondition: the atomic rename really did install a NEW inode at the same pathname');
    assert.deepStrictEqual(r.leftFamilyDescriptors, [{ id: UUID, reason: 'descriptor-changed-since-scan' }]);
    assert.strictEqual(liveDesc(home, UUID), true, 'the re-published descriptor survives');
  } finally { rm(home); rm(W); }
});

test('V1 (kills copy-then-unlink): the tombstone is the SAME INODE as the retired descriptor — a HARDLINK, not a copy', () => {
  const home = tmpHome();
  const W = makeGitRepo('hardlink');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const top = inst.resolveWorktree(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };
    const slugDesc = { id: SLUG, worktreePath: top, sessionId: UUID, ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, slugDesc);
    writeDesc(home, SLUG, slugDesc);
    writeDesc(home, UUID, { id: UUID, worktreePath: path.join(top, 'x'), sessionId: 'sess-x', repoKey });
    const inoBefore = inoOf(cli.descriptorPath(home, UUID));

    const r = cli.cmdArchive(SLUG, ctx);
    assert.deepStrictEqual(r.retiredFamilyDescriptors, [UUID], JSON.stringify(r));
    // copyFileSync-then-unlink would preserve the BYTES but allocate a NEW inode.
    // Only a hardlink keeps the original inode reachable, which is what makes the
    // sequence NO-DELETE: the bytes are never at risk of existing in zero places.
    assert.strictEqual(inoOf(archivedPathOf(home, UUID)), inoBefore,
      'archived/ must hold the ORIGINAL inode — a copy would be a delete-and-rewrite');
  } finally { rm(home); rm(W); }
});

test('V2 (kills content-only conflict detection): a tombstone with the SAME BYTES at a DIFFERENT INODE is refused, not clobbered', () => {
  const home = tmpHome();
  const W = makeGitRepo('sameBytes');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const top = inst.resolveWorktree(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };
    const slugDesc = { id: SLUG, worktreePath: top, sessionId: UUID, ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, slugDesc);
    writeDesc(home, SLUG, slugDesc);
    const twin = { id: UUID, worktreePath: path.join(top, 'x'), sessionId: 'sess-x', repoKey };
    writeDesc(home, UUID, twin);

    // An INDEPENDENT file holding byte-identical content. It is NOT the twin's
    // inode, so it is NOT proof the twin's bytes are safely tombstoned: unlinking
    // the active path on the strength of a content match would be a real delete
    // of a distinct inode's only link.
    fs.mkdirSync(cli.archivedDir(home), { recursive: true });
    fs.writeFileSync(archivedPathOf(home, UUID), JSON.stringify(twin));
    assert.strictEqual(
      fs.readFileSync(archivedPathOf(home, UUID), 'utf8'),
      fs.readFileSync(cli.descriptorPath(home, UUID), 'utf8'),
      'precondition: identical bytes');
    assert.notStrictEqual(inoOf(archivedPathOf(home, UUID)), inoOf(cli.descriptorPath(home, UUID)),
      'precondition: DIFFERENT inodes');

    const r = cli.cmdArchive(SLUG, ctx);
    assert.strictEqual(r.retiredFamilyDescriptors, undefined, 'nothing may be retired on a bare content match');
    assert.deepStrictEqual(r.leftFamilyDescriptors, [{ id: UUID, reason: 'archived-tombstone-differs' }]);
    assert.strictEqual(liveDesc(home, UUID), true, 'the twin stays live');
  } finally { rm(home); rm(W); }
});

test('P0-3: MIGRATION refuses to retire a REUSED id that is a genuinely LIVE workspace (stale one-way tombstone is not authority)', () => {
  const home = tmpHome();
  const liveWt = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-livewt-'));
  try {
    // archived/A names B in its sessionId — a HISTORICAL link, written long ago.
    writeArchivedDesc(home, SLUG, { id: SLUG, worktreePath: '/gone/wt', sessionId: UUID, repoKey: 'skycrew-a7a7a5' });
    // B is TODAY an unrelated, LIVE workspace: its own session, its own worktree
    // that EXISTS on disk. Descriptor ids get reused; A's memory of a B is not
    // evidence about THIS B.
    const liveB = { id: UUID, worktreePath: liveWt, sessionId: 'live-session-not-a', repoKey: 'other-project' };
    writeDesc(home, UUID, liveB);

    const dry = cli.foldArchivedFamilyDescriptors(home, { dryRun: true });
    assert.strictEqual(dry.pending, 0, 'detect must not claim there is anything to migrate: ' + JSON.stringify(dry));
    assert.deepStrictEqual(dry.retired, []);
    assert.deepStrictEqual(dry.left, [{ id: UUID, reason: 'live-or-unprovable-worktree' }],
      'the refusal is surfaced, not silently dropped');

    const r = cli.foldArchivedFamilyDescriptors(home, {});
    assert.deepStrictEqual(r.retired, [], 'apply must retire nothing');
    assert.deepStrictEqual(r.left, [{ id: UUID, reason: 'live-or-unprovable-worktree' }]);
    assert.strictEqual(liveDesc(home, UUID), true, 'the LIVE workspace keeps its descriptor');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(cli.descriptorPath(home, UUID), 'utf8')), liveB, 'unmodified');
    assert.strictEqual(fs.existsSync(liveWt), true, 'its worktree is still there — this was never a dead workspace');
  } finally { rm(home); rm(liveWt); }
});

test('P0-3b (kills the relative-path variant): a twin whose worktreePath is RELATIVE is never "provably gone"', () => {
  const home = tmpHome();
  try {
    writeArchivedDesc(home, SLUG, { id: SLUG, worktreePath: '/gone/wt', sessionId: UUID });
    // Relative — meaningless without the cwd it was registered under. Resolving
    // it against THIS process's cwd answers a different question entirely.
    writeDesc(home, UUID, { id: UUID, worktreePath: 'some/relative/wt-' + Date.now(), sessionId: 'sess-rel' });

    const r = cli.foldArchivedFamilyDescriptors(home, {});
    assert.deepStrictEqual(r.retired, [], 'an unresolvable path is not proof of death');
    assert.deepStrictEqual(r.left, [{ id: UUID, reason: 'live-or-unprovable-worktree' }]);
    assert.strictEqual(liveDesc(home, UUID), true);
  } finally { rm(home); }
});

test('P0-3c (kills the any-error-is-gone variant): a DANGLING SYMLINK worktree is a real entry -> refused', () => {
  const home = tmpHome();
  try {
    const link = path.join(home, 'dangling-wt');
    fs.symlinkSync(path.join(home, 'no-such-target'), link);
    writeArchivedDesc(home, SLUG, { id: SLUG, worktreePath: '/gone/wt', sessionId: UUID });
    writeDesc(home, UUID, { id: UUID, worktreePath: link, sessionId: 'sess-dangling' });

    const r = cli.foldArchivedFamilyDescriptors(home, {});
    assert.deepStrictEqual(r.retired, [], 'lstat succeeds on a dangling symlink -> not gone');
    assert.deepStrictEqual(r.left, [{ id: UUID, reason: 'live-or-unprovable-worktree' }]);
    assert.strictEqual(liveDesc(home, UUID), true);
  } finally { rm(home); }
});

test('P0-3d (kills over-tightening): the ARCHIVE-TIME path still retires a twin whose worktree EXISTS — the live-incident repair is intact', () => {
  const home = tmpHome();
  const W = makeGitRepo('archivetime');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const top = inst.resolveWorktree(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };
    // The twin's worktree EXISTS (it is a real dir under a real repo). The
    // migration gate would refuse this — the archive-time path must NOT, because
    // there the cross-link is read from the LIVE descriptor the operator is
    // archiving right now: contemporaneous authority, not a stale tombstone.
    const nested = path.join(top, 'nested-live');
    fs.mkdirSync(nested, { recursive: true });
    const slugDesc = { id: SLUG, worktreePath: top, sessionId: UUID, ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, slugDesc);
    writeDesc(home, SLUG, slugDesc);
    writeDesc(home, UUID, { id: UUID, worktreePath: nested, sessionId: 'sess-nested', repoKey });

    const r = cli.cmdArchive(SLUG, ctx);
    assert.deepStrictEqual(r.retiredFamilyDescriptors, [UUID], JSON.stringify(r));
    assert.strictEqual(liveDesc(home, UUID), false);
  } finally { rm(home); rm(W); }
});

// ---------------------------------------------------------------------------
// V5 — CALLERS MUST NOT SWALLOW A SAFETY REFUSAL.
// docs/KB-devswarm-hivecontrol.md §28: "success while dropping part of the job".
// A refusal that reaches the operator as a clean no-op is the worst possible
// outcome of this whole fix, so both callers are asserted directly.
// ---------------------------------------------------------------------------

// A fixture whose migration MUST refuse: archived A -> live B on a live worktree.
function seedRefusalFixture(home, liveWt) {
  writeArchivedDesc(home, SLUG, { id: SLUG, worktreePath: '/gone/wt', sessionId: UUID });
  writeDesc(home, UUID, { id: UUID, worktreePath: liveWt, sessionId: 'live-session-not-a' });
}

test('V5a UPDATE WIRING: a family safety refusal is propagated as left/errors/ok, never reported as a clean no-op', () => {
  const home = tmpHome();
  const liveWt = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-livewt-u-'));
  try {
    seedRefusalFixture(home, liveWt);
    const r = U.foldArchivedRowsPostUpdate({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'repo-1', HOME: home },
      cwd: process.cwd(),
      home,
    });
    assert.strictEqual(r.attempted, true, JSON.stringify(r));
    assert.strictEqual(r.familyDescriptorsRetired, 0, JSON.stringify(r));
    assert.strictEqual(r.familyDescriptorsLeft, 1, 'the refusal must reach the caller: ' + JSON.stringify(r));
    assert.strictEqual(r.familyDescriptorsErrors, 0, JSON.stringify(r));
    assert.strictEqual(r.familyDescriptorsOk, true, JSON.stringify(r));
    assert.match(r.detail, /twin descriptor\(s\) left in place \(safety-gated\)/,
      'and must be VISIBLE in the human-readable detail line');
    assert.strictEqual(liveDesc(home, UUID), true, 'the live workspace is untouched');
  } finally { rm(home); rm(liveWt); }
});

test('V5b DOCTOR WIRING: a family safety refusal is NOT reported as "nothing to migrate"', () => {
  const home = tmpHome();
  const W = makeGitRepo('doctorrefuse');
  const liveWt = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-livewt-d-'));
  try {
    seedRefusalFixture(home, liveWt);
    const env = { HOME: home, ANTIHALL_DEVSWARM_STORE_BACKEND: BACKEND, PATH: process.env.PATH };
    const found = doctorRepair.runRepairs({ cwd: W, env, home, dryRun: false })
      .find((x) => x.id === 'fold-archived-family-descriptors');
    assert.ok(found, 'doctor wires the repair');
    assert.match(found.msg, /left in place \(safety-gated/, 'the refusal must be surfaced: ' + JSON.stringify(found));
    assert.match(found.msg, /live-or-unprovable-worktree/, 'with the REASON, not a bare count');
    assert.strictEqual(liveDesc(home, UUID), true, 'and nothing was retired');
  } finally { rm(home); rm(W); rm(liveWt); }
});

// ---------------------------------------------------------------------------
// P1 (writer half) — descriptors persist an ABSOLUTE worktreePath.
//
// A relative value is only meaningful against the cwd it was registered from, a
// fact the descriptor does not carry. Every consumer resolves it against its OWN
// cwd instead: hooks/devswarm-parent-gate.js lstats it from the Primary's repo
// root, gets ENOENT for a LIVE workspace registered elsewhere, and suppresses the
// missing-inbox block for it (the reader half of this fix is asserted in
// tests/hooks/devswarm-parent-gate.test.js). Fixing only the reader would leave
// every NEW descriptor carrying an ambiguous value; fixing only the writer would
// leave every legacy one unreadable. Both halves ship. Mutation check M5.
// ---------------------------------------------------------------------------

test('P1 WRITER: a RELATIVE --worktree is persisted ABSOLUTE (resolved once, at the one place descriptors are built)', () => {
  const rel = 'some' + path.sep + 'relative' + path.sep + 'wt';
  const built = cli.buildDescriptorFromFlags('abs-wt-id', { worktree: [rel] }, null, {});
  assert.strictEqual(path.isAbsolute(built.worktreePath), true,
    'a persisted worktreePath must never be relative: ' + built.worktreePath);
  assert.strictEqual(built.worktreePath, path.resolve(rel));
});

test('P1 WRITER: an ALREADY-absolute --worktree is passed through byte-for-byte, and null stays null', () => {
  const abs = path.join(os.tmpdir(), 'already-absolute-wt');
  assert.strictEqual(cli.buildDescriptorFromFlags('abs-id', { worktree: [abs] }, null, {}).worktreePath, abs);
  // No --worktree flag at all: the field normalizes to null, unchanged behavior.
  assert.strictEqual(cli.buildDescriptorFromFlags('none-id', {}, null, {}).worktreePath, null);
  // An existing descriptor's value is PRESERVED when no flag is passed (the
  // merge-preserve posture the other fields use) — resolution must not fire here.
  assert.strictEqual(
    cli.buildDescriptorFromFlags('keep-id', {}, { worktreePath: 'legacy/relative' }, {}).worktreePath,
    'legacy/relative');
});

// ---------------------------------------------------------------------------
// NO DUPLICATE TOP-LEVEL FUNCTION DECLARATIONS in scripts/devswarm.js.
//
// Not style policing — a REAL defect caught during this fix. A new helper was
// added as `descriptorFingerprint(path)` while a `descriptorFingerprint(desc)`
// (sha256 of a descriptor OBJECT, used by the recovery-intent stale-marker
// guard) already existed ~150 lines above. Two `function f(){}` declarations of
// one name do not coexist: the LATER one wins for the entire module scope. So
// every recovery-intent call site silently started passing an object to a
// path-taking function, got `null` back, and the guard that stops a stale
// archive marker from clobbering a re-registered workspace's fresh registry row
// quietly stopped working. The file is 7k+ lines and nothing failed — the whole
// suite stayed green. This test is the cheap, mechanical check that would have
// caught it, and catches the next one.
// ---------------------------------------------------------------------------
test('scripts/devswarm.js declares no top-level function name twice (a later duplicate SILENTLY replaces the earlier)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'devswarm.js'), 'utf8');
  const seen = new Map();
  const dupes = [];
  const re = /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm; // column 0 => top-level scope
  let m;
  while ((m = re.exec(src)) !== null) {
    const line = src.slice(0, m.index).split('\n').length;
    if (seen.has(m[1])) dupes.push(m[1] + ' (lines ' + seen.get(m[1]) + ' and ' + line + ')');
    else seen.set(m[1], line);
  }
  assert.deepStrictEqual(dupes, [], 'duplicate top-level function declarations: ' + dupes.join('; '));
  assert.ok(seen.size > 100, 'sanity: the scanner actually found the file\'s functions (' + seen.size + ')');
});
