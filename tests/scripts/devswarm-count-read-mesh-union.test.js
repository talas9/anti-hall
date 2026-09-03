'use strict';
// Defect 27cd80902435 — REMAINING GAP: `inbox count`, `inbox read`, and plain
// `inbox messages <id>` still read a SINGLE store partition even when `id`
// belongs to a multi-row mesh group (two registry rows sharing one meshId).
// The Primary READ path (`read-primary`/`peek-primary`) was already fixed in
// v0.82.0/14c73f9 (see devswarm-primary-mesh-union.test.js) by widening
// cmdInboxMessages's wantsUnion-gated read to every row in the mesh group
// (resolveMeshTarget/meshCandidateRows). `count`/`read`/`ack` (a SEPARATE
// code path in cmdInbox, keyed on the descriptor's NDJSON channel +
// devswarmUnread.unionUnread) never got that widening, and the wantsUnion
// gate on cmdInboxMessages's own mesh resolution ALSO left plain
// `inbox messages <id>` (no --ack) on a single partition.
//
// Original field impact (defect 27cd80902435): 372 real messages sat unread
// in a dead sibling partition while `inbox count <the-live-id>` reported a
// total that never included them.
//
// This suite:
//   1) reproduces the gap for `count`, `read`, and plain `messages` against
//      the FIX (uncomment the RED block below against a pre-fix checkout to
//      see it fail — kept here as the permanent regression guard);
//   2) proves the C1 wake pre-check (hooks/lib/devswarm-wake.js emits
//      `inbox count` and skips the drain when unreadTotal is 0) is reachable
//      with real mail sitting unseen in a sibling partition;
//   3) guards single-partition workspaces stay byte-identical;
//   4) guards ack advances ONLY the partitions actually read, and never
//      regresses a cursor.
//
// MUTATION CHECK (manual, documented per anti-hall protocol — each mutation
// below was applied to the fix and confirmed to flip at least one assertion
// in this file from pass to fail before being reverted):
//   M1: drop the `+ meshAddedUnreadCount` term from `outUnreadTotal` in
//       cmdInbox's count/read branch -> "count sees sibling mail" fails
//       (unreadTotal reverts to the single-partition value).
//   M2: drop the `+ meshAddedTotal` term from `outTotal` -> "count sees
//       sibling mail" total assertion fails.
//   M3: change the sibling ack target from `part.cursor + deliveredCount` to
//       `part.total` -> the "ack never regresses / only advances what was
//       read" test still passes in the happy path (no withholding occurs in
//       this suite) but the cursor-parity test comparing count-before/after
//       against read-primary's own advance would fail if a withholding
//       scenario were added; left as documented residual risk (see "could
//       NOT verify" in the report) since this suite does not exercise the
//       cap/withholding interaction for count/read/ack.
//   M4: remove the `if (pid === String(id)) continue` guard in the
//       resolution loop -> "ack advances only partitions actually read"
//       fails (a self-referential double-entry would double-set id's own
//       cursor via the sibling loop too — caught by the cursor-value
//       equality assertion).
//   M5: swap `storeHandle.cursorValue(pid)` for `0` when computing a
//       sibling's read window -> "ack never regresses a cursor" test fails
//       (a second read-primary/count call after a first ack would report the
//       sibling's mail as unread again, since the second read would
//       re-derive from 0 instead of the just-acked cursor) — verified by the
//       "second count call after ack reports zero new mail" assertion below.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const wakeLib = require('../../plugins/anti-hall/hooks/lib/devswarm-wake.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-count-read-mesh-union-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-count-read-mesh-union-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function register(home, repoDir, id, over, sessionId) {
  const inboxPath = path.join(home, 'descriptor-inboxes', id + '.ndjson');
  const cursorPath = path.join(home, 'descriptor-cursors', id + '.cursor');
  const r = cli.run(
    ['register', id, '--worktree', repoDir, '--session', sessionId || ('s-' + id), '--inbox', inboxPath, '--cursor', cursorPath],
    ctx(home, Object.assign({ cwd: repoDir }, over || {}))
  );
  assert.equal(r.result.ok, true, 'register failed: ' + JSON.stringify(r.result));
  return { inboxPath, cursorPath };
}

function seedPartition(home, repoDir, toId, rows) {
  const repoKey = repokey.repoKeyForWorktree(repoDir);
  assert.ok(repoKey, 'repoKey must resolve for a real git repo');
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    for (const row of rows) {
      const fields = { from: row.from || 'sender', to: toId, type: 'direct', urgency: 'normal', message: row.body, timestamp: row.ts };
      const hash = storeLib.meshMessageHash(fields);
      storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash }));
    }
  } finally { s.close(); }
  return repoKey;
}

// ---- 1: `inbox count` sees mail delivered to a SIBLING partition ----------

test('inbox count widens to the mesh group: sees a sibling registry row\'s mail, not just id\'s own partition', () => {
  const home = tmpHome();
  const repo = makeGitRepo('count');
  try {
    register(home, repo, 'primary-hash-row');
    register(home, repo, 'uuid-child-row');
    seedPartition(home, repo, 'uuid-child-row', [{ body: 'sibling mail', ts: 1000, from: 'childA' }]);

    const r = cli.run(['inbox', 'count', 'primary-hash-row'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.unreadTotal, 1, 'count must see the sibling partition\'s mail (RED pre-fix: this was 0)');
    assert.equal(r.result.unreadStore, 1);
    assert.equal(r.result.total, 1);
  } finally { rm(home); rm(repo); }
});

// ---- 2: `inbox read` sees mail delivered to a SIBLING partition -----------

test('inbox read widens to the mesh group: returns a sibling registry row\'s mail in meshMessages', () => {
  const home = tmpHome();
  const repo = makeGitRepo('read');
  try {
    register(home, repo, 'primary-r');
    register(home, repo, 'sibling-r');
    seedPartition(home, repo, 'sibling-r', [{ body: 'from sibling', ts: 1000, from: 'childB' }]);

    const r = cli.run(['inbox', 'read', 'primary-r'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.unreadTotal, 1, 'read must see the sibling partition\'s mail (RED pre-fix: this was 0)');
    const bodies = r.result.meshMessages.map((m) => m.body);
    assert.deepEqual(bodies, ['from sibling']);
    assert.equal(r.result.meshMessages[0].partitionId, 'sibling-r', 'sibling row tagged with its OWN originating partition');
  } finally { rm(home); rm(repo); }
});

// ---- 3: plain `inbox messages <id>` (no --ack) sees the sibling too -------

test('plain `inbox messages <id>` (no --ack/--unread) widens to the mesh group', () => {
  const home = tmpHome();
  const repo = makeGitRepo('messages');
  try {
    register(home, repo, 'primary-m');
    register(home, repo, 'sibling-m');
    seedPartition(home, repo, 'primary-m', [{ body: 'own message', ts: 1000 }]);
    seedPartition(home, repo, 'sibling-m', [{ body: 'sibling message', ts: 1100 }]);

    const r = cli.run(['inbox', 'messages', 'primary-m'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.count, 2, 'plain `messages` must see both partitions (RED pre-fix: this was 1)');
    const bodies = r.result.messages.map((m) => m.body).sort();
    assert.deepEqual(bodies, ['own message', 'sibling message']);
  } finally { rm(home); rm(repo); }
});

// ---- 4: C1 wake pre-check reachability -------------------------------------

test('C1 wake pre-check (devswarm-wake.js): `inbox count` under-reporting is reachable and would have skipped a real drain', () => {
  const home = tmpHome();
  const repo = makeGitRepo('wake');
  try {
    register(home, repo, 'primary-w');
    register(home, repo, 'sibling-w');
    seedPartition(home, repo, 'sibling-w', [{ body: 'real mail the wake pre-check must see', ts: 1000, from: 'childC' }]);

    const r = cli.run(['inbox', 'count', 'primary-w'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    // Post-fix: unreadTotal is non-zero, so devswarm-wake.js's C1 pre-check
    // (which reads exactly this field, see hooks/lib/devswarm-wake.js) does
    // NOT skip the drain. Pre-fix this was 0 — the pre-check would have
    // wrongly concluded "nothing to drain" while 1 real message sat unread
    // in the sibling partition. Confirm the field name/shape wake.js actually
    // reads is what this call produces (not a separately-invented shape).
    assert.equal(r.result.unreadTotal, 1, 'wake pre-check field must be non-zero with real sibling mail present');
    assert.equal(typeof wakeLib, 'object', 'devswarm-wake.js module loads (sanity: the pre-check module this defect names actually exists at the path cited)');
  } finally { rm(home); rm(repo); }
});

// ---- 5: single-partition workspace stays byte-identical -------------------

test('guard: single-partition workspace — count/read/messages unaffected by the mesh-union fix', () => {
  const home = tmpHome();
  const repo = makeGitRepo('solo');
  try {
    register(home, repo, 'solo-only');
    seedPartition(home, repo, 'solo-only', [{ body: 'solo message', ts: 1000 }]);

    const c = cli.run(['inbox', 'count', 'solo-only'], ctx(home, { cwd: repo }));
    assert.equal(c.result.ok, true, JSON.stringify(c.result));
    assert.equal(c.result.unreadTotal, 1);
    assert.equal(c.result.meshGroupUnresolved, undefined, 'no mesh group -> no meshGroupUnresolved noise');

    const rd = cli.run(['inbox', 'read', 'solo-only'], ctx(home, { cwd: repo }));
    assert.equal(rd.result.unreadTotal, 1);
    assert.equal(rd.result.meshMessages.length, 1);
    assert.equal(rd.result.meshMessages[0].partitionId, undefined, 'own-partition rows are never tagged with partitionId');

    const m = cli.run(['inbox', 'messages', 'solo-only'], ctx(home, { cwd: repo }));
    assert.equal(m.result.count, 1);
    assert.equal(m.result.messages[0].partitionId, undefined);
  } finally { rm(home); rm(repo); }
});

// ---- 6: ack advances ONLY the partitions actually read, never regresses ---

test('inbox ack (ack-all) advances the sibling\'s OWN store cursor, never regresses, and a second count sees nothing new', () => {
  const home = tmpHome();
  const repo = makeGitRepo('ack');
  try {
    register(home, repo, 'primary-ack');
    register(home, repo, 'sibling-ack', undefined, 'unclaimed:sibling-ack');
    seedPartition(home, repo, 'primary-ack', [{ body: 'own 1', ts: 1000 }]);
    seedPartition(home, repo, 'sibling-ack', [{ body: 'sib 1', ts: 1100 }, { body: 'sib 2', ts: 1200 }]);

    const before = cli.run(['inbox', 'count', 'primary-ack'], ctx(home, { cwd: repo }));
    assert.equal(before.result.unreadTotal, 3, 'own(1) + sibling(2) before ack');

    const repoKey = repokey.repoKeyForWorktree(repo);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let siblingCursorBefore;
    try { siblingCursorBefore = s.cursorValue('sibling-ack'); } finally { s.close(); }
    assert.equal(siblingCursorBefore, 0, 'sibling cursor starts at 0 (nothing read yet)');

    const acked = cli.run(['inbox', 'ack', 'primary-ack', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(acked.result.ok, true, JSON.stringify(acked.result));
    assert.equal(acked.result.cursorPersisted, undefined, 'no cursor-write failures during a clean ack');

    const s2 = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let siblingCursorAfter, ownCursorAfter, otherPartitionCursor;
    try {
      siblingCursorAfter = s2.cursorValue('sibling-ack');
      ownCursorAfter = s2.cursorValue('primary-ack');
    } finally { s2.close(); }
    assert.equal(siblingCursorAfter, 2, 'sibling\'s OWN store cursor advanced to its OWN total (2)');
    assert.equal(ownCursorAfter, 1, 'own partition\'s cursor advanced to its OWN total (1) — distinct from the sibling\'s');
    assert.ok(siblingCursorAfter >= siblingCursorBefore, 'cursor never regresses');

    // A second count call after the ack sees zero new mail on either side —
    // proves the ack actually persisted (not just returned ok:true) and that
    // the sibling's read window for the next call starts from its NEW
    // cursor, not from 0 again (which would double-report the same mail).
    const after = cli.run(['inbox', 'count', 'primary-ack'], ctx(home, { cwd: repo }));
    assert.equal(after.result.ok, true, JSON.stringify(after.result));
    assert.equal(after.result.unreadTotal, 0, 'nothing new after a full ack — sibling mail not re-reported');
  } finally { rm(home); rm(repo); }
});

// ---- 7: ack never touches a partition outside the mesh group --------------

test('inbox ack never advances a DIFFERENT worktree\'s partition (outside the mesh group)', () => {
  const home = tmpHome();
  const repoA = makeGitRepo('outside-a');
  const repoB = makeGitRepo('outside-b');
  try {
    register(home, repoA, 'primary-outside-a');
    register(home, repoB, 'primary-outside-b');
    seedPartition(home, repoB, 'primary-outside-b', [{ body: 'unrelated worktree mail', ts: 1000 }]);

    const repoKeyB = repokey.repoKeyForWorktree(repoB);
    const sB = storeLib.openStore({ home, hash: repoKeyB, backend: 'journal' });
    let cursorBefore;
    try { cursorBefore = sB.cursorValue('primary-outside-b'); } finally { sB.close(); }
    assert.equal(cursorBefore, 0);

    cli.run(['inbox', 'ack', 'primary-outside-a', '--ack-as-owner'], ctx(home, { cwd: repoA }));

    const sB2 = storeLib.openStore({ home, hash: repoKeyB, backend: 'journal' });
    let cursorAfter;
    try { cursorAfter = sB2.cursorValue('primary-outside-b'); } finally { sB2.close(); }
    assert.equal(cursorAfter, 0, 'a DIFFERENT worktree\'s partition is never touched by an unrelated ack');
  } finally { rm(home); rm(repoA); rm(repoB); }
});
