'use strict';
// B1(b) fix — foldGroupIntoSurvivor's foldOne forwards a candidate's unread
// direct backlog into the survivor but, PRE-FIX, never advanced the
// CANDIDATE's own cursor afterward. A candidate that is classified `left`
// (a genuinely live, distinct child — never tombstoned, by design) therefore
// kept its PRE-fold cursor forever: its backlog had already safely reached
// the survivor, yet the candidate's own partition kept reporting the exact
// same "N unread / not draining" indefinitely, because nothing ever moved
// its read frontier forward.
//
// FIX (scripts/devswarm.js, foldOne, ~line 1611): after the forward loop
// completes with NO exception (forwardOk stays true — every appendMeshMessage
// call either inserted the row into the survivor or hit the hash-dedupe
// OR-IGNORE path because a prior pass already forwarded it; both count as
// "safely delivered"), advance the candidate's cursor:
//     const nowCount = s.messageCount(row.id);
//     if (nowCount > since) s.setCursor(row.id, nowCount);
// Gated on COMPLETE success: the `if (!forwardOk) return { outcome:
// 'forward-failed' };` line already returns BEFORE this code runs, so a
// partial/failed forward (an exception mid-loop) never touches the cursor —
// the next fold pass re-reads the whole unread range from the untouched
// cursor and re-forwards idempotently (hash dedupe), losing nothing.
//
// Two tests here:
//   1. SUCCESS CONDITION — the P1 "distinct live child" shape (own the
//      existing devswarm-retire-duplicate.test.js precedent: two genuinely
//      live children sharing a worktree; the fold forwards + LEFTs, never
//      tombstones). Pre-fix this test's own cursor assertion FAILS (the left
//      row's cursor never moves off 0 despite its backlog being fully
//      forwarded). Post-fix: cursorValue(leftId) === messageCount(leftId).
//   2. PARTIAL-FORWARD GUARD — foldGroupIntoSurvivor called directly with a
//      hand-rolled fake store handle whose SECOND appendMeshRow call throws.
//      Must report the candidate `forwardFailed`, never `retired`/`left`
//      with a cursor advance, and — the assertion that actually matters —
//      the candidate's cursor is UNTOUCHED (setCursor never called for it).
//
// MUTATION-CHECK (documented per the task's requirement; each actually run
// against this file to confirm it FAILS the relevant test before being
// reverted):
//   (i) advance the cursor even on a partial/failed forward (move the
//       `s.setCursor` call above the `if (!forwardOk) return ...` line, or
//       drop the `if (!forwardOk)` guard around it) -> KILLED by test 2
//       ("PARTIAL-FORWARD GUARD"), whose core assertion is
//       `setCursorCalls.length === 0` for the failed candidate.
//   (ii) tombstone without checking isStaleCrossReference (bypass the
//       descriptor gate unconditionally) -> already covered by the PRE-
//       EXISTING P1 test in devswarm-retire-duplicate.test.js ("a distinct
//       live child (own descriptor) sharing a worktree is forwarded + LEFT,
//       never tombstoned") and by devswarm-fold-stale-alias.test.js's own
//       "FOLD control (P1 precedent, unaffected)" test — both re-run green
//       below as an explicit guard-still-passes check.
//   (iii) remove the cooldown gate on the reconcile sweep -> KILLED by the
//       pre-existing test in devswarm-supervisor-reconcile-sweep.test.js
//       ("within cooldown -> {ran:false,...}; runReconcile NEVER called")
//       and by the new runFold-cooldown test added to that file for part
//       (a) of this fix.

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fold-cursor-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fold-cursor-repo-' + tag + '-'));
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
  cp.spawnSync('git', ['-C', mainDir, 'worktree', 'add', '-q', wt, '-b', 'branch-' + tag]);
  return wt;
}
function topOf(dir) { return inst.resolveWorktree(dir); }
function meshOf(dir) { return inst.primaryWorkspaceId(inst.resolveWorktree(dir)); }

test('SUCCESS CONDITION: a distinct-live-child candidate that the fold LEFT (never tombstoned) has its cursor advanced to messageCount — its already-forwarded backlog stops rendering as unread forever', () => {
  const home = tmpHome();
  const main = makeGitRepo('cursor-success');
  const child = addLinkedWorktree(main, 'cursor-success-c');
  try {
    const repoKey = repokey.repoKeyForWorktree(child);
    const childTop = topOf(child);
    const childMesh = meshOf(child);
    const bctx = (over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

    const A = 'child-a-live-uuid';
    const Bid = 'child-b-live-uuid';
    const rA = cli.run(['register', A, '--worktree', childTop, '--session', 'sess-a'], bctx({ cwd: child }));
    assert.strictEqual(rA.result.ok, true);
    assert.ok(fs.existsSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces', A + '.json')));

    // Unread backlog sitting in A's own partition before B ever registers.
    cli.run(['send', '--to', childMesh, '--message', 'for-whoever-drains-1'], bctx({ cwd: main }));
    cli.run(['send', '--to', childMesh, '--message', 'for-whoever-drains-2'], bctx({ cwd: main }));

    const sPre = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let preCursor, preCount;
    try { preCursor = sPre.cursorValue(A); preCount = sPre.messageCount(A); } finally { sPre.close(); }
    assert.strictEqual(preCursor, 0, 'precondition: A has not been drained yet');
    assert.ok(preCount >= 2, 'precondition: A actually holds the unread backlog');

    // B registers -> fold runs (retireWorktreeDuplicates -> foldGroupIntoSurvivor).
    // A is a genuinely distinct live child (own descriptor, self-consistent
    // sessionId) -> forwarded + LEFT, never tombstoned (P1 precedent).
    const rB = cli.run(['register', Bid, '--worktree', childTop, '--session', 'sess-b'], bctx({ cwd: child }));
    assert.strictEqual(rB.result.ok, true);
    assert.ok(!(rB.result.retiredDuplicates || []).includes(A), 'A must NOT be tombstoned');
    assert.ok((rB.result.leftDuplicates || []).includes(A), 'A must be reported LEFT');

    const sPost = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let postCursor, postCount;
    try { postCursor = sPost.cursorValue(A); postCount = sPost.messageCount(A); } finally { sPost.close(); }
    // THE FIX: A's cursor must now equal its messageCount — its fully-
    // forwarded backlog is no longer "unread" on the source partition, even
    // though the row itself correctly still exists (LEFT, not tombstoned).
    assert.strictEqual(postCursor, postCount,
      `A's cursor must advance to messageCount after a fully-successful forward (cursor=${postCursor}, count=${postCount}) — otherwise its already-forwarded backlog renders as unread forever`);
  } finally {
    cp.spawnSync('git', ['-C', main, 'worktree', 'remove', '--force', child]);
    rm(main); rm(child); rm(home);
  }
});

test('PARTIAL-FORWARD GUARD: foldGroupIntoSurvivor never advances a candidate\'s cursor when its forward loop throws mid-way — reported forwardFailed, nothing tombstoned, cursor untouched', () => {
  // A hand-rolled fake store handle: the FIRST appendMeshRow call (via
  // store.appendMeshMessage) succeeds, the SECOND throws — simulating a
  // real-world partial forward (e.g. a store write that fails after some,
  // not all, of a candidate's unread rows were already appended to the
  // survivor). setCursor calls are recorded so the guard assertion is a
  // direct, non-inferential proof: the candidate's cursor must NEVER be
  // touched when forwardOk ends up false.
  const setCursorCalls = [];
  let appendCalls = 0;
  const CANDIDATE = 'candidate-partial';
  const SURVIVOR = 'survivor-uuid';
  const rows = [
    { hash: 'h1', ts: 1000, body: 'msg-1', sender: 'x', recipient: CANDIDATE, mtype: 'direct', urgency: 'normal', needsReply: false, isHeartbeat: false },
    { hash: 'h2', ts: 2000, body: 'msg-2', sender: 'x', recipient: CANDIDATE, mtype: 'direct', urgency: 'normal', needsReply: false, isHeartbeat: false },
  ];
  const fakeS = {
    cursorValue(id) { return id === CANDIDATE ? 0 : 0; },
    listMessages(id /*, opts */) { return id === CANDIDATE ? rows.slice() : []; },
    messageCount(id) { return id === CANDIDATE ? rows.length : 0; },
    setCursor(id, val) { setCursorCalls.push({ id, val }); },
    appendMeshRow(/* fields */) {
      appendCalls++;
      if (appendCalls === 1) return { inserted: true, seq: 1 };
      throw new Error('simulated store write failure on the second forwarded row');
    },
    removeRegistryIf() { throw new Error('must never be reached — forwardOk is false'); },
  };

  const candidateRow = { id: CANDIDATE, worktreePath: '/wt/fake', sessionId: 'sess-candidate', updatedAt: 1, writeSeq: 1 };
  const res = cli.foldGroupIntoSurvivor(fakeS, /* home */ '/nonexistent-home-fixture', SURVIVOR, [candidateRow], {});

  assert.deepStrictEqual(res.forwardFailed, [CANDIDATE], 'the candidate must be reported forwardFailed');
  assert.deepStrictEqual(res.retired, [], 'nothing tombstoned on a partial forward');
  assert.deepStrictEqual(res.left, [], 'a forward-failed candidate is reported via forwardFailed, not left');
  assert.strictEqual(appendCalls, 2, 'precondition: the second (throwing) row was actually attempted, proving this is a genuine partial forward, not a zero-attempt no-op');
  assert.deepStrictEqual(setCursorCalls, [], 'THE GUARD: setCursor must NEVER be called for a candidate whose forward loop threw — a partial fold must never lose the un-forwarded remainder off the read frontier');
});
