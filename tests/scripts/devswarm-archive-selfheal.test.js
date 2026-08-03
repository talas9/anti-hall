'use strict';
// ARCHIVE DESCRIPTOR SELF-HEAL — a stale `archived/<id>.json` left over from a PRIOR
// archive generation of the same id must not wedge re-archiving forever, while an
// archived path that is a hardlink of a GENUINE live descriptor must still be
// refused (never clobbered).
//
// Mechanism (scripts/devswarm.js, cmdArchive): linkSync(active -> archived) fails
// EEXIST, the EEXIST is swallowed, both paths are lstat'd, the inodes differ and the
// function throws 'archived descriptor already exists and is not the active
// descriptor'. Nothing ever removes the stale link, so the id can never be archived
// again. The fix unlinks+relinks ONLY when NO live descriptor under workspaces/
// shares the conflicting file's inode (archivedTombstoneIsOrphaned, which FAILS
// CLOSED), then re-stats both paths and re-verifies before declaring the link good.
//
// Fixture style mirrors devswarm-archive-group.test.js (real git worktrees as cwd —
// repoKeyForWorktree spawns git).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const inst = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');

const BACKEND = 'journal';

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-archheal-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-archheal-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
const openS = (home, bucket) => storeLib.openStore({ home, hash: bucket, backend: BACKEND });
function seedReg(home, bucket, desc) { const s = openS(home, bucket); try { s.upsertRegistry(desc); } finally { s.close(); } }
function regIds(home, bucket) { const s = openS(home, bucket); try { return s.listRegistry().map((d) => String(d.id)).sort(); } finally { s.close(); } }
function writeDesc(home, id, desc) {
  const p = cli.descriptorPath(home, id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(desc));
  return p;
}
function archivedPathFor(home, id) { return path.join(cli.archivedDir(home), id + '.json'); }
function ino(p) { const st = fs.lstatSync(p); return st.dev + ':' + st.ino; }

const UUID = 'b3f1c2d4-0000-4000-8000-abcdef012345';
const OTHER = 'c0ffee11-2222-4333-8444-555566667777';

// ---------------------------------------------------------------------------
// (1) THE BUG: a stale archived/<id>.json with a DIFFERENT inode is an orphaned
// tombstone -> self-heals -> the archive succeeds.
// ---------------------------------------------------------------------------
test('cmdArchive: an ORPHANED tombstone from a prior archive generation self-heals and the archive succeeds', () => {
  const home = tmpHome();
  const W = makeGitRepo('orphan');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const top = inst.resolveWorktree(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };

    const desc = { id: UUID, worktreePath: top, sessionId: 'sess-live', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, desc);
    const activeP = writeDesc(home, UUID, desc);

    // The remnant: a SEPARATE file (written independently, NOT hardlinked), so its
    // inode differs from the active descriptor's — exactly the shape a prior
    // archive generation of this same id leaves behind.
    const archP = archivedPathFor(home, UUID);
    fs.mkdirSync(path.dirname(archP), { recursive: true });
    fs.writeFileSync(archP, JSON.stringify({ id: UUID, worktreePath: top, sessionId: 'sess-OLD-generation' }));
    assert.notStrictEqual(ino(archP), ino(activeP), 'precondition: the remnant is a distinct inode');

    const activeIno = ino(activeP);
    const r = cli.cmdArchive(UUID, ctx);
    assert.strictEqual(r.ok, true, 'archive succeeds after self-heal: ' + JSON.stringify(r));
    assert.strictEqual(r.descriptorArchived, true, JSON.stringify(r));
    assert.strictEqual(ino(archP), activeIno,
      'archived/<id>.json now carries the inode the ACTIVE descriptor had (relinked, not the stale remnant)');
    assert.strictEqual(fs.existsSync(activeP), false, 'the active descriptor was unlinked LAST, as before');
    assert.deepStrictEqual(regIds(home, repoKey), [], 'the registry row is tombstoned');
    const back = JSON.parse(fs.readFileSync(archP, 'utf8'));
    assert.strictEqual(back.sessionId, 'sess-live', 'the archived content is the CURRENT descriptor, not the stale remnant');
  } finally { rm(W); rm(home); }
});

// ---------------------------------------------------------------------------
// (2) NEVER-CLOBBER: the archived path is a hardlink of ANOTHER live workspace's
// descriptor -> still refused, and that descriptor survives byte-for-byte.
// ---------------------------------------------------------------------------
test('cmdArchive: a tombstone hardlinked to a LIVE descriptor is NEVER unlinked — archive fails and no data is lost', () => {
  const home = tmpHome();
  const W = makeGitRepo('protected');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const top = inst.resolveWorktree(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };

    const desc = { id: UUID, worktreePath: top, sessionId: 'sess-live', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, desc);
    const activeP = writeDesc(home, UUID, desc);

    // A DIFFERENT live workspace whose active descriptor the archived path is
    // hardlinked to. Unlinking archived/<id>.json here would be one step away from
    // destroying a genuine live descriptor.
    const otherDesc = { id: OTHER, worktreePath: top, sessionId: 'sess-other', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, otherDesc);
    const otherP = writeDesc(home, OTHER, otherDesc);
    const otherBytes = fs.readFileSync(otherP, 'utf8');
    const otherIno = ino(otherP);

    const archP = archivedPathFor(home, UUID);
    fs.mkdirSync(path.dirname(archP), { recursive: true });
    fs.linkSync(otherP, archP);
    assert.strictEqual(ino(archP), otherIno, 'precondition: the tombstone IS the other live descriptor');

    const r = cli.cmdArchive(UUID, ctx);
    assert.strictEqual(r.ok, false, 'archive is refused: ' + JSON.stringify(r));
    assert.match(String(r.error), /not the active descriptor/, JSON.stringify(r));

    // NO DATA LOSS — the explicit assertion.
    assert.strictEqual(fs.existsSync(otherP), true, 'the OTHER live descriptor file still exists');
    assert.strictEqual(fs.readFileSync(otherP, 'utf8'), otherBytes, 'its content is intact');
    assert.strictEqual(ino(otherP), otherIno, 'its inode is unchanged (never unlinked/replaced)');
    assert.strictEqual(fs.existsSync(archP), true, 'the protected tombstone was NOT unlinked');
    assert.strictEqual(ino(archP), otherIno, 'and still points at the same inode');
    // And the subject of the archive is left exactly as it was — all-or-nothing.
    assert.strictEqual(fs.existsSync(activeP), true, 'the subject active descriptor is untouched');
    assert.deepStrictEqual(regIds(home, repoKey), [OTHER, UUID].sort(), 'no registry row was tombstoned');
  } finally { rm(W); rm(home); }
});

// ---------------------------------------------------------------------------
// (3) FAIL CLOSED: if the liveness scan cannot complete, the tombstone is NOT
// unlinked. An unreadable workspaces dir must never read as "nothing is live".
// Mode 0o100 = owner --x: full paths inside are still stat-able/readable (so the
// archive gets as far as the link check) but readdirSync fails EACCES.
// ---------------------------------------------------------------------------
test('cmdArchive: fail-closed — an unreadable workspaces dir makes the orphan check say NOT orphaned, so nothing is unlinked', () => {
  const home = tmpHome();
  const W = makeGitRepo('failclosed');
  const wsDir = cli.workspacesDir(home);
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const top = inst.resolveWorktree(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };

    const desc = { id: UUID, worktreePath: top, sessionId: 'sess-live', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, desc);
    const activeP = writeDesc(home, UUID, desc);

    // An ORPHANED remnant — i.e. the case that WOULD self-heal if the scan could run.
    const archP = archivedPathFor(home, UUID);
    fs.mkdirSync(path.dirname(archP), { recursive: true });
    fs.writeFileSync(archP, JSON.stringify({ id: UUID, worktreePath: top, sessionId: 'sess-OLD-generation' }));
    const remnantBytes = fs.readFileSync(archP, 'utf8');
    const remnantIno = ino(archP);

    fs.chmodSync(wsDir, 0o100);
    let unreadable = false;
    try { fs.readdirSync(wsDir); } catch (_) { unreadable = true; }
    if (!unreadable) return; // running as root (or a permissive FS) — the premise cannot be staged

    // Direct check of the predicate itself: the scan cannot complete -> NOT orphaned.
    assert.strictEqual(cli.archivedTombstoneIsOrphaned(home, fs.lstatSync(archP)), false,
      'an unreadable workspaces dir must never be read as "nothing is live, safe to delete"');

    const r = cli.cmdArchive(UUID, ctx);
    assert.strictEqual(r.ok, false, 'the archive fails rather than deleting the tombstone: ' + JSON.stringify(r));
    assert.strictEqual(fs.existsSync(archP), true, 'the tombstone was NOT unlinked');
    assert.strictEqual(fs.readFileSync(archP, 'utf8'), remnantBytes, 'and is byte-identical');
    assert.strictEqual(ino(archP), remnantIno, 'and is the same inode (not relinked either)');
    fs.chmodSync(wsDir, 0o700);
    assert.strictEqual(fs.existsSync(activeP), true, 'the active descriptor is untouched');
    assert.deepStrictEqual(regIds(home, repoKey), [UUID], 'the registry row is still live — nothing was half-applied');
  } finally { try { fs.chmodSync(wsDir, 0o700); } catch (_) {} rm(W); rm(home); }
});

// A missing workspaces dir is the same class of "I cannot see anything live".
test('archivedTombstoneIsOrphaned: an ABSENT workspaces dir also fails closed (never "safe to delete")', () => {
  const home = tmpHome();
  try {
    const archP = archivedPathFor(home, UUID);
    fs.mkdirSync(path.dirname(archP), { recursive: true });
    fs.writeFileSync(archP, '{}');
    assert.strictEqual(fs.existsSync(cli.workspacesDir(home)), false, 'precondition: no workspaces dir');
    assert.strictEqual(cli.archivedTombstoneIsOrphaned(home, fs.lstatSync(archP)), false);
    assert.strictEqual(cli.archivedTombstoneIsOrphaned(home, null), false, 'a missing stat also fails closed');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// (5) ATOMIC HEAL: link-to-temp + rename must leave no `.tmp-heal` artifact
// behind, whether the heal succeeds or fails, and a leftover `.tmp-heal` from a
// prior crashed heal must not block a later one.
// ---------------------------------------------------------------------------
function seedOrphan(home, W) {
  const repoKey = repokey.repoKeyForWorktree(W);
  const top = inst.resolveWorktree(W);
  const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };
  const desc = { id: UUID, worktreePath: top, sessionId: 'sess-live', ownerKey: repoKey, repoKey };
  seedReg(home, repoKey, desc);
  const activeP = writeDesc(home, UUID, desc);
  const archP = archivedPathFor(home, UUID);
  fs.mkdirSync(path.dirname(archP), { recursive: true });
  fs.writeFileSync(archP, JSON.stringify({ id: UUID, worktreePath: top, sessionId: 'sess-OLD-generation' }));
  return { ctx, repoKey, activeP, archP };
}
function tmpHealArtifacts(archP) {
  const dir = path.dirname(archP);
  const base = path.basename(archP);
  return fs.readdirSync(dir).filter((f) => f === base + '.tmp-heal');
}

test('self-heal leaves no .tmp-heal artifact behind on success', () => {
  const home = tmpHome();
  const W = makeGitRepo('healtmp-ok');
  try {
    const { ctx, archP } = seedOrphan(home, W);
    const r = cli.cmdArchive(UUID, ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(tmpHealArtifacts(archP), [], 'no .tmp-heal file remains after a successful self-heal');
  } finally { rm(W); rm(home); }
});

test('self-heal leaves no .tmp-heal artifact behind on failure', () => {
  const home = tmpHome();
  const W = makeGitRepo('healtmp-fail');
  try {
    const { ctx, archP } = seedOrphan(home, W);
    // Induce a failure inside the rename step itself (link-to-temp succeeds,
    // then the atomic rename fails) — this is the exact window the fix closes,
    // so the recovery/cleanup branch (unlink the temp link, rethrow) is exercised.
    const origRename = fs.renameSync;
    fs.renameSync = function (src, dest) {
      if (typeof src === 'string' && src.endsWith('.tmp-heal') && dest === archP) {
        throw Object.assign(new Error('EACCES: induced for test'), { code: 'EACCES' });
      }
      return origRename.apply(fs, arguments);
    };
    let r;
    try { r = cli.cmdArchive(UUID, ctx); } finally { fs.renameSync = origRename; }
    assert.strictEqual(r.ok, false, 'archive fails when the rename step fails: ' + JSON.stringify(r));
    assert.deepStrictEqual(tmpHealArtifacts(archP), [], 'no .tmp-heal file remains after a failed self-heal');
  } finally { rm(W); rm(home); }
});

test('a leftover .tmp-heal from a prior crashed heal does not block a later self-heal', () => {
  const home = tmpHome();
  const W = makeGitRepo('healtmp-stale');
  try {
    const { ctx, activeP, archP } = seedOrphan(home, W);
    // Simulate a heal that crashed after linkSync(active -> healTmp) but before
    // the rename ever ran: a stale .tmp-heal sits next to the orphaned tombstone.
    const healTmp = archP + '.tmp-heal';
    fs.writeFileSync(healTmp, 'stale partial link from a crashed heal');
    assert.strictEqual(fs.existsSync(healTmp), true, 'precondition: stale .tmp-heal exists');

    const activeIno = ino(activeP);
    const r = cli.cmdArchive(UUID, ctx);
    assert.strictEqual(r.ok, true, 'the stale .tmp-heal does not wedge a later self-heal: ' + JSON.stringify(r));
    assert.strictEqual(ino(archP), activeIno, 'archived/<id>.json now carries the active descriptor inode');
    assert.deepStrictEqual(tmpHealArtifacts(archP), [], 'the stale .tmp-heal was cleared, and no new one remains');
  } finally { rm(W); rm(home); }
});

// ---------------------------------------------------------------------------
// (4) REGRESSION: the ordinary path — no pre-existing archived/<id>.json — is
// byte-for-byte the behavior it had before the self-heal was added.
// ---------------------------------------------------------------------------
test('cmdArchive: with NO pre-existing archived descriptor the plain archive still works exactly as before', () => {
  const home = tmpHome();
  const W = makeGitRepo('plain');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const top = inst.resolveWorktree(W);
    const ctx = { home, cwd: W, env: { HOME: home }, backend: BACKEND };

    const desc = { id: UUID, worktreePath: top, sessionId: 'sess-live', ownerKey: repoKey, repoKey };
    seedReg(home, repoKey, desc);
    const activeP = writeDesc(home, UUID, desc);
    const activeIno = ino(activeP);
    const archP = archivedPathFor(home, UUID);
    assert.strictEqual(fs.existsSync(archP), false, 'precondition: no archived descriptor');

    const r = cli.cmdArchive(UUID, ctx);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.descriptorArchived, true, JSON.stringify(r));
    assert.ok(!('retiredDuplicates' in r), 'return shape unchanged for a single-row worktree: ' + JSON.stringify(r));
    assert.strictEqual(ino(archP), activeIno, 'the archived file is the SAME inode the active descriptor had');
    assert.strictEqual(fs.existsSync(activeP), false, 'the active descriptor was unlinked last');
    assert.deepStrictEqual(regIds(home, repoKey), [], 'the registry row is tombstoned');
  } finally { rm(W); rm(home); }
});
