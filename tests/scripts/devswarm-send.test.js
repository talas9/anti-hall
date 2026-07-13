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
    // worktreePath MUST be the git-RESOLVED toplevel (inst.resolveWorktree),
    // matching what production's cmdRegisterPrimary always stores (devswarm.js
    // cmdRegisterPrimary: `worktree = ... || inst.resolveWorktree(cwd)`) and what
    // derivedId()/callerIdentity() derive from — NOT the raw pre-resolution repo
    // dir. On win32, `git rev-parse --show-toplevel` expands a short-name %TEMP%
    // path (what mkdtempSync/`git worktree add` hand back here) to its long-name
    // form, while worktreeHash's plain fs.realpathSync does not further normalize
    // it — so seeding the raw (short-name) path would hash to a DIFFERENT meshId
    // than resolveMeshTarget expects, purely a test-setup artifact, not a
    // production divergence (production never stores an unresolved worktree).
    seedRegistry(home, repoKeyMain, { id: primaryId, worktreePath: inst.resolveWorktree(mainRepo), sessionId: 's-primary' });
    seedRegistry(home, repoKeyMain, { id: childId, worktreePath: inst.resolveWorktree(childWt), sessionId: 's-child' });

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

// ---- ack-ownership + broadcast-cursor identity fix (P0 + P1, v0.57 mesh) ---
// `callerIdentity()` (the caller's worktree-derived meshId) and a workspace's
// own registered store-partition id (`d.id`) coincide ONLY for a self-registered
// Primary. A CHILD registers under its hivecontrol DEVSWARM_BUILDER_ID (a UUID
// unrelated to meshId, per docs/KB-devswarm-hivecontrol.md:215) — so before the
// fix, every real child was refused reading/acking its own mesh direct inbox via
// the EXACT command its own D26 nudge told it to run, and `roster --ack`/`mesh
// read` never cleared its own broadcastUnread even though it reported
// `ok:true`. These tests reproduce both with a REAL linked worktree (never a
// hardcoded/short-name path — worktreePath is always `inst.resolveWorktree(...)`,
// the same production-derived value `derivedId`/`callerIdentity` use) and prove
// the fix without weakening the cross-workspace ack-hazard protection (bug #2).

test('inbox read-primary: a CHILD (registered under a DEVSWARM_BUILDER_ID different from its own meshId, cwd = its own worktree) can read+ack its OWN mesh direct inbox (P0)', () => {
  const home = tmpHome();
  const mainRepo = makeGitRepo('childack');
  let childWt = null;
  try {
    childWt = addLinkedWorktree(mainRepo, 'childack');
    const repoKey = repokey.repoKeyForWorktree(childWt);
    const childMeshId = derivedId(childWt);
    const builderId = 'sess-child-builder-abc'; // hivecontrol-assigned id, NEVER equal to childMeshId
    assert.notEqual(childMeshId, builderId, 'sanity: the two id-spaces really do diverge for a child');
    seedRegistry(home, repoKey, { id: builderId, worktreePath: inst.resolveWorktree(childWt), sessionId: 's-child' });

    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { s.appendMessage({ workspaceId: builderId, body: 'hello child', hash: 'h1' }); } finally { s.close(); }

    // The exact command buildMeshDirectSegment (devswarm-child-turn.js, D26)
    // nudges: `devswarm.js inbox read-primary <DEVSWARM_BUILDER_ID>`.
    const r = cli.run(
      ['inbox', 'read-primary', builderId],
      ctx(home, { cwd: childWt, env: { DEVSWARM_BUILDER_ID: builderId } })
    );
    assert.equal(r.code, 0, 'the child must be able to read+ack its own inbox via the exact D26-nudged command');
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.count, 1);
    assert.equal(r.result.cursor, 1);
  } finally {
    rm(home);
    if (childWt) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', childWt]);
    rm(mainRepo);
  }
});

test('inbox read-primary: a caller CANNOT ack a DIFFERENT workspace\'s registered partition (cross-workspace ack hazard, bug #2, stays closed)', () => {
  const home = tmpHome();
  const mainRepo = makeGitRepo('childack2');
  let childWtA = null;
  let childWtB = null;
  try {
    childWtA = addLinkedWorktree(mainRepo, 'childackA');
    childWtB = addLinkedWorktree(mainRepo, 'childackB');
    const repoKey = repokey.repoKeyForWorktree(childWtA);
    const builderIdA = 'sess-child-builder-a';
    const builderIdB = 'sess-child-builder-b';
    seedRegistry(home, repoKey, { id: builderIdA, worktreePath: inst.resolveWorktree(childWtA), sessionId: 's-a' });
    seedRegistry(home, repoKey, { id: builderIdB, worktreePath: inst.resolveWorktree(childWtB), sessionId: 's-b' });

    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { s.appendMessage({ workspaceId: builderIdB, body: 'for B only', hash: 'h1' }); } finally { s.close(); }

    // Caller is running as A (its OWN cwd/env) but tries to ack B's partition.
    const r = cli.run(
      ['inbox', 'read-primary', builderIdB],
      ctx(home, { cwd: childWtA, env: { DEVSWARM_BUILDER_ID: builderIdA } })
    );
    assert.equal(r.code, 2);
    assert.equal(r.result.ok, false);
    assert.match(r.result.error, /ack refused/);
    assert.equal(r.result.callerIdentity, derivedId(childWtA));
  } finally {
    rm(home);
    if (childWtA) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', childWtA]);
    if (childWtB) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', childWtB]);
    rm(mainRepo);
  }
});

test('roster --ack (mesh read) for a CHILD registered under a DEVSWARM_BUILDER_ID different from its meshId clears its OWN broadcastUnread (P1: cursor keyed by registered d.id, not raw meshId)', () => {
  const home = tmpHome();
  const mainRepo = makeGitRepo('childbcast');
  let childWt = null;
  try {
    childWt = addLinkedWorktree(mainRepo, 'childbcast');
    const repoKey = repokey.repoKeyForWorktree(childWt);
    const senderId = derivedId(mainRepo);
    const builderId = 'sess-child-builder-xyz';
    seedRegistry(home, repoKey, { id: senderId, worktreePath: inst.resolveWorktree(mainRepo), sessionId: 's-sender' });
    seedRegistry(home, repoKey, { id: builderId, worktreePath: inst.resolveWorktree(childWt), sessionId: 's-child' });

    const sent = cli.run(['send', '--broadcast', '--message', 'everyone look'], ctx(home, { cwd: mainRepo }));
    assert.equal(sent.result.ok, true);

    const before = cli.run(['roster'], ctx(home, { cwd: mainRepo }));
    const childRowBefore = before.result.workspaces.find((w) => w.id === builderId);
    assert.equal(childRowBefore.broadcastUnread, 1, 'the child has not acked yet');

    const acked = cli.run(
      ['roster', '--ack'],
      ctx(home, { cwd: childWt, env: { DEVSWARM_BUILDER_ID: builderId } })
    );
    assert.equal(acked.result.ok, true, JSON.stringify(acked.result));
    assert.equal(acked.result.count, 1);

    const after = cli.run(['roster'], ctx(home, { cwd: mainRepo }));
    const childRowAfter = after.result.workspaces.find((w) => w.id === builderId);
    assert.equal(
      childRowAfter.broadcastUnread, 0,
      'the child\'s OWN broadcastUnread must clear — before this fix the cursor was written under the '
        + 'raw meshId, a key deriveSummary never reads back for this child, so it grew unboundedly forever'
    );
  } finally {
    rm(home);
    if (childWt) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', childWt]);
    rm(mainRepo);
  }
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
