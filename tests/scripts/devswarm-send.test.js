'use strict';
// v0.57 mesh CLI surface (send / roster / mesh read) — PLAN-v0.57-mesh.md Phase 4.
// Exercised in-process via cli.run(argv, ctx) with an injected tmp HOME + forced
// journal backend (deterministic on every node version — 18/20 have no
// node:sqlite), and a REAL git worktree as `ctx.cwd` (repoKeyForWorktree spawns a
// real `git rev-parse --git-common-dir`, unlike `primaryWorkspaceId` which is a
// pure path hash — see devswarm-repokey.test.js for the injectable-io unit tests
// of that primitive in isolation).

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-send-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

// makeGitRepo(tag) -> a real, committed git repo dir (git-common-dir resolution
// needs a real .git; a commit lets `git worktree add` branch off it below).
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-send-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function addLinkedWorktree(mainDir, tag) {
  const wt = path.join(path.dirname(mainDir), path.basename(mainDir) + '-wt-' + tag);
  cp.spawnSync('git', ['-C', mainDir, 'worktree', 'add', wt, '-b', 'branch-' + tag]);
  return wt;
}
// seedRegistry(home, repoKey, desc) — bypass cmdRegister (out of Phase 4 scope,
// D24 store-caller re-key lands in Phase 5) and seed the shared repoKey store's
// registry directly, as Phase 5's re-keyed register will do for real once wired.
function seedRegistry(home, repoKey, desc) {
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try { s.upsertRegistry(desc); } finally { s.close(); }
}
function fakeCwd(home) { return path.join(home, 'no-git-here'); }

// derivedId(dir) -> the meshId production's own callerIdentity() derives for a
// REAL git worktree at `dir`: resolveWorktree(dir) (a real `git rev-parse
// --show-toplevel` spawn) THEN primaryWorkspaceId() on that resolved toplevel
// — never primaryWorkspaceId(dir) directly on the raw path. On win32, git's
// MSYS/Cygwin layer expands a short-name %TEMP% path (what mkdtempSync/
// os.tmpdir() hand back on GH Actions windows-latest runners) to its long-name
// form before returning --show-toplevel, while primaryWorkspaceId's own
// fs.realpathSync (unlike devswarm-repokey.js's win32-aware gitCommonDir)
// PRESERVES whatever short/long-name form its input already had. So
// primaryWorkspaceId(rawDir) and primaryWorkspaceId(resolveWorktree(rawDir))
// hash to two DIFFERENT (but both internally-consistent) ids for the identical
// real directory on Windows. Production always derives via the resolved
// toplevel (callerIdentity, devswarm.js) — matching that exactly, instead of
// hashing the raw path, keeps the expectation correct on every platform.
function derivedId(dir) { return inst.primaryWorkspaceId(inst.resolveWorktree(dir)); }

// ---- repoKey null-cwd (D28 ordering pin) -----------------------------------

test('send from a non-git cwd returns {ok:false,reason:"no-project"} and never emits a from, even with a spoofed DEVSWARM_BUILDER_ID', () => {
  const home = tmpHome();
  try {
    const r = cli.run(
      ['send', '--to', 'primary-deadbeef', '--message', 'hi'],
      ctx(home, { cwd: fakeCwd(home), env: { DEVSWARM_BUILDER_ID: 'primary-spoofed' } })
    );
    assert.equal(r.code, 2);
    assert.equal(r.result.ok, false);
    assert.equal(r.result.reason, 'no-project');
    assert.equal(r.result.from, undefined, 'no-project must be returned BEFORE any identity is derived');
  } finally { rm(home); }
});

test('roster from a non-git cwd returns {ok:false,reason:"no-project"}', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['roster'], ctx(home, { cwd: fakeCwd(home) }));
    assert.equal(r.result.ok, false);
    assert.equal(r.result.reason, 'no-project');
  } finally { rm(home); }
});

// ---- --from spoofing (D18) --------------------------------------------------

test('send rejects an explicit --from that mismatches the cwd-derived identity (spoofing rejected)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('spoof');
  try {
    const r = cli.run(
      ['send', '--from', 'primary-notme', '--to', 'primary-deadbeef', '--message', 'hi'],
      ctx(home, { cwd: repo, env: { DEVSWARM_BUILDER_ID: 'primary-notme' } })
    );
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /spoofing rejected/);
  } finally { rm(home); rm(repo); }
});

test('send accepts an explicit --from that MATCHES the derived identity (redundant declaration, not an override)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('redundant');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const from = derivedId(repo);
    seedRegistry(home, repoKey, { id: 'peer', worktreePath: path.join(repo, 'nope'), sessionId: 's' });
    const r = cli.run(
      ['send', '--from', from, '--broadcast', '--message', 'hi'],
      ctx(home, { cwd: repo })
    );
    assert.equal(r.result.ok, true);
    assert.equal(r.result.from, from);
  } finally { rm(home); rm(repo); }
});

// ---- validation edge cases --------------------------------------------------

test('send rejects both --to and --broadcast together', () => {
  const home = tmpHome();
  const repo = makeGitRepo('bothflags');
  try {
    const r = cli.run(['send', '--to', 'primary-x', '--broadcast', '--message', 'hi'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /--to.*OR.*--broadcast/);
  } finally { rm(home); rm(repo); }
});

test('send rejects neither --to nor --broadcast', () => {
  const home = tmpHome();
  const repo = makeGitRepo('neitherflag');
  try {
    const r = cli.run(['send', '--message', 'hi'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /requires --to/);
  } finally { rm(home); rm(repo); }
});

test('send rejects an urgency outside the enum, reporting the allowed set', () => {
  const home = tmpHome();
  const repo = makeGitRepo('badurgency');
  try {
    const r = cli.run(['send', '--broadcast', '--message', 'hi', '--urgency', 'critical'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, false);
    assert.deepEqual(r.result.allowed, ['low', 'normal', 'high', 'urgent']);
  } finally { rm(home); rm(repo); }
});

test('send --to self is rejected', () => {
  const home = tmpHome();
  const repo = makeGitRepo('self');
  try {
    const self = derivedId(repo);
    const r = cli.run(['send', '--to', self, '--message', 'hi'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /cannot address the sender itself/);
  } finally { rm(home); rm(repo); }
});

test('send --to an unregistered meshId is rejected fail-closed (D12a)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('unregistered');
  try {
    const r = cli.run(['send', '--to', 'primary-doesnotexist', '--message', 'hi'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, false);
    assert.equal(r.result.reason, 'unregistered-recipient');
  } finally { rm(home); rm(repo); }
});

test('send requires --message', () => {
  const home = tmpHome();
  const repo = makeGitRepo('nomessage');
  try {
    const r = cli.run(['send', '--broadcast'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /requires --message/);
  } finally { rm(home); rm(repo); }
});

// ---- direct send: lands in the recipient's directUnread --------------------

test('a direct send appears in the recipient\'s directUnread (roster projection)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('direct');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    assert.ok(repoKey, 'repoKey must resolve for a real git repo');
    const peerWt = path.join(os.tmpdir(), 'never-exists-peer-' + Date.now());
    const peerMeshId = inst.primaryWorkspaceId(peerWt);
    seedRegistry(home, repoKey, { id: 'child-peer', worktreePath: peerWt, sessionId: 's' });

    const r = cli.run(['send', '--to', peerMeshId, '--message', 'hello peer', '--urgency', 'high'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true);
    assert.equal(r.result.sent, true);
    assert.equal(r.result.type, 'direct');
    assert.ok(Number.isFinite(r.result.seq));

    const roster = cli.run(['roster'], ctx(home, { cwd: repo }));
    assert.equal(roster.result.ok, true);
    const peerRow = roster.result.workspaces.find((w) => w.id === 'child-peer');
    assert.ok(peerRow, 'peer must be projected in the roster');
    assert.equal(peerRow.directUnread, 1);
    assert.equal(peerRow.urgencyMax, 'high');
  } finally { rm(home); rm(repo); }
});

// ---- round trip: reply to a meshId a peer sent as its `from` (D19) ---------

test('round trip: sending --to <the meshId a peer sent as its from> succeeds and lands in that peer\'s real read partition', () => {
  const home = tmpHome();
  const mainRepo = makeGitRepo('roundtrip-main');
  let childWt = null;
  try {
    childWt = addLinkedWorktree(mainRepo, 'roundtrip');
    const repoKeyMain = repokey.repoKeyForWorktree(mainRepo);
    const repoKeyChild = repokey.repoKeyForWorktree(childWt);
    assert.equal(repoKeyMain, repoKeyChild, 'linked worktrees of ONE project share the SAME repoKey (D1)');

    const primaryId = derivedId(mainRepo);
    const childId = derivedId(childWt);
    assert.notEqual(primaryId, childId, 'distinct worktrees derive distinct meshIds');

    // Seed BOTH sides' registry entries under their OWN builder-id (the read
    // partition each side actually reads) with their OWN worktreePath (the D19
    // derivation input) — simulating what Phase 5's re-keyed register will do.
    seedRegistry(home, repoKeyMain, { id: primaryId, worktreePath: mainRepo, sessionId: 's-primary' });
    seedRegistry(home, repoKeyMain, { id: childId, worktreePath: childWt, sessionId: 's-child' });

    // Leg 1: Primary -> child, addressed by the child's meshId.
    const leg1 = cli.run(['send', '--to', childId, '--message', 'ping from primary'], ctx(home, { cwd: mainRepo }));
    assert.equal(leg1.result.ok, true, JSON.stringify(leg1.result));
    assert.equal(leg1.result.from, primaryId);

    // Leg 2 (round trip): child replies using leg1's `from` AS its `--to`.
    const leg2 = cli.run(['send', '--to', leg1.result.from, '--message', 'pong from child'], ctx(home, { cwd: childWt }));
    assert.equal(leg2.result.ok, true, JSON.stringify(leg2.result));
    assert.equal(leg2.result.from, childId);

    // Both rows land in the RIGHT builder-id partition (not the meshId).
    const s = storeLib.openStore({ home, hash: repoKeyMain, backend: 'journal' });
    try {
      const childInbox = s.listMessages(childId);
      const primaryInbox = s.listMessages(primaryId);
      assert.equal(childInbox.length, 1);
      assert.equal(childInbox[0].body, 'ping from primary');
      assert.equal(childInbox[0].sender, primaryId);
      assert.equal(primaryInbox.length, 1);
      assert.equal(primaryInbox[0].body, 'pong from child');
      assert.equal(primaryInbox[0].sender, childId);
    } finally { s.close(); }
  } finally {
    rm(home);
    if (childWt) { cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', childWt]); }
    rm(mainRepo);
  }
});

// ---- broadcast + mesh read / roster --ack (D23) -----------------------------

test('a broadcast appears in every workspace\'s broadcastUnread; after mesh read the caller\'s returns to 0 while an un-acked peer still shows it unread (D23)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('broadcast');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const sender = derivedId(repo);
    seedRegistry(home, repoKey, { id: sender, worktreePath: repo, sessionId: 's' });
    seedRegistry(home, repoKey, { id: 'peer-1', worktreePath: path.join(os.tmpdir(), 'peer-1-never'), sessionId: 's' });

    const sent = cli.run(['send', '--broadcast', '--message', 'everyone look', '--urgency', 'normal'], ctx(home, { cwd: repo }));
    assert.equal(sent.result.ok, true);
    assert.equal(sent.result.type, 'broadcast');

    const before = cli.run(['roster'], ctx(home, { cwd: repo }));
    const peerRowBefore = before.result.workspaces.find((w) => w.id === 'peer-1');
    assert.equal(peerRowBefore.broadcastUnread, 1, 'peer-1 has not acked yet');

    // The SENDER acks via `roster --ack` (alias of `mesh read`, D23).
    const acked = cli.run(['roster', '--ack'], ctx(home, { cwd: repo }));
    assert.equal(acked.result.ok, true);
    assert.equal(acked.result.acked, true);
    assert.equal(acked.result.count, 1);
    assert.equal(acked.result.broadcasts[0].message, 'everyone look');

    const after = cli.run(['roster'], ctx(home, { cwd: repo }));
    const senderRowAfter = after.result.workspaces.find((w) => w.id === sender);
    const peerRowAfter = after.result.workspaces.find((w) => w.id === 'peer-1');
    assert.equal(senderRowAfter.broadcastUnread, 0, 'the acking caller\'s broadcastUnread returns to 0');
    assert.equal(peerRowAfter.broadcastUnread, 1, 'an un-acked peer still shows the broadcast unread');
  } finally { rm(home); rm(repo); }
});

test('`mesh read` is the same verb as `roster --ack` (D23 alias)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('meshread-alias');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const sender = inst.primaryWorkspaceId(repo);
    seedRegistry(home, repoKey, { id: sender, worktreePath: repo, sessionId: 's' });
    cli.run(['send', '--broadcast', '--message', 'via mesh read'], ctx(home, { cwd: repo }));
    const r = cli.run(['mesh', 'read'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true);
    assert.equal(r.result.action, 'mesh-read');
    assert.equal(r.result.count, 1);
  } finally { rm(home); rm(repo); }
});

// ---- heartbeat --summary (D11/D22) ------------------------------------------

test('heartbeat --summary writes a mesh broadcast heartbeat row: tiered as broadcast, sets working_on, and does NOT increment broadcastUnread', () => {
  const home = tmpHome();
  const repo = makeGitRepo('heartbeat');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const id = 'w-heartbeat';
    seedRegistry(home, repoKey, { id, worktreePath: repo, sessionId: 's' });
    seedRegistry(home, repoKey, { id: 'observer', worktreePath: path.join(os.tmpdir(), 'observer-never'), sessionId: 's' });

    const hb = cli.run(['heartbeat', id, '--summary', 'implementing Phase 4'], ctx(home, { cwd: repo }));
    assert.equal(hb.result.ok, true);
    assert.equal(hb.result.meshBroadcast.ok, true);
    assert.equal(hb.result.meshBroadcast.sent, true);

    const roster = cli.run(['roster'], ctx(home, { cwd: repo }));
    const row = roster.result.workspaces.find((w) => w.id === id);
    assert.equal(row.working_on, 'implementing Phase 4');

    const observerRow = roster.result.workspaces.find((w) => w.id === 'observer');
    assert.equal(observerRow.broadcastUnread, 0, 'a heartbeat row must NEVER increment broadcastUnread (D22)');

    // recent[] surfaces the heartbeat as roster state.
    assert.ok(roster.result.recent.some((r) => r.summary === 'implementing Phase 4'));
  } finally { rm(home); rm(repo); }
});

test('heartbeat without --summary is a legacy no-op for the mesh (meshBroadcast:null, base heartbeat still succeeds)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('heartbeat-nosummary');
  try {
    const r = cli.run(['heartbeat', 'w1', '--progress', '50'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true);
    assert.equal(r.result.meshBroadcast, null);
  } finally { rm(home); rm(repo); }
});

test('heartbeat --summary from a non-git cwd does not fail the base heartbeat, reports meshBroadcast no-project', () => {
  const home = tmpHome();
  try {
    const r = cli.run(['heartbeat', 'w1', '--summary', 'x'], ctx(home, { cwd: fakeCwd(home) }));
    assert.equal(r.result.ok, true);
    assert.equal(r.result.meshBroadcast.ok, false);
    assert.equal(r.result.meshBroadcast.reason, 'no-project');
  } finally { rm(home); }
});
