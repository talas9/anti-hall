'use strict';
// P0 fix: parent->child DIRECT MESSAGES were silently undeliverable.
//
// ROOT CAUSE (confirmed against the actual code, live-evidence-reproduced below):
//   - `send --to <meshId>` (cmdSend, scripts/devswarm.js) is a STORE-ONLY write
//     (store.appendMeshMessage) — it never touches a recipient's descriptor NDJSON.
//   - `inbox read <id>` / `inbox count <id>` / `inbox ack <id>` (cmdInbox's
//     descriptor-path branches) read ONLY the descriptor's durable NDJSON
//     (workspaces/<id>.json -> inboxPath/cursorPath), via
//     companion/lib/devswarm-inbox-cursor.js's readUnread/ackTo.
//   - That NDJSON is populated ONLY by `inbox pull` draining the NATIVE
//     hivecontrol queue (companion/lib/devswarm-pull.js pullOnce).
//   => when native hivecontrol messaging is unavailable (or simply never pulled),
//      a mesh-direct `send --to` message is durably in the STORE, `inbox messages
//      <id>` sees it immediately, but the recipient's OWN `inbox read/count`
//      reports 0 forever — exactly the live incident (summary projection said
//      unread:3, `inbox messages` returned all 3, `inbox read` returned count:0
//      against a genuinely 0-byte NDJSON file).
//
// FIX (scripts/devswarm.js, cmdInbox's count/read/ack branches): a LOSS-FREE
// UNION — merge the STORE's messages for `id` into the descriptor NDJSON's own
// unread/total, deduped by content hash (a native-drained message carries the
// SAME `native:`-prefixed hash in both channels; a mesh-direct `send --to`
// message exists only in the store, `mesh:`-prefixed, so it is always additive).
// `ack` (ack-all only, never `--to N`) now also advances the STORE's own cursor
// for `id` (ownership-gated, mirroring `inbox messages --ack`'s existing
// cross-workspace-ack-hazard guard) and re-derives the persisted summary
// projection, so the parent-gate banner and this read path agree afterwards.
//
// Exercised in-process via cli.run(argv, ctx), same pattern as
// devswarm-cli.test.js / devswarm-send.test.js, with a REAL git worktree pair
// (repoKeyForWorktree spawns real git) so the D24 mesh store-caller re-key path
// is genuinely exercised, not the non-git per-id legacy fallback.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-inbox-union-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-inbox-union-repo-' + tag + '-'));
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
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

// registerChild(home, childWt, id) -> { inboxPath, cursorPath }. A REAL register
// (not a seedRegistry bypass) so this exercises the exact descriptor cmdInbox's
// count/read/ack branches require (desc.inboxPath) — precreated as an empty
// (0-byte) NDJSON, matching the live incident's "exists, 0 bytes" evidence.
function registerChild(home, childWt, id) {
  const inboxPath = path.join(home, 'descriptor-inboxes', id + '.ndjson');
  const cursorPath = path.join(home, 'descriptor-cursors', id + '.cursor');
  const r = cli.run(
    ['register', id, '--worktree', childWt, '--session', 's-' + id, '--inbox', inboxPath, '--cursor', cursorPath],
    ctx(home, { cwd: childWt })
  );
  assert.equal(r.result.ok, true, 'register failed: ' + JSON.stringify(r.result));
  return { inboxPath, cursorPath };
}

test('P0 fix: a mesh direct `send --to` is visible via the recipient\'s OWN `inbox read`/`count`, and `ack` advances the cursor so it stops being unread', () => {
  // RED PROOF (recorded, not re-asserted here — see files_changed report): run
  // against the pre-fix devswarm.js, this exact repro produced:
  //   inbox count: {"ok":true,...,"unread":0,"cursor":0,"total":0,"known":true}
  //   inbox read:  {"ok":true,...,"lines":[],"count":0,"cursor":0,"total":0,...}
  // while `inbox messages` (store path) already returned the message with
  // total:1 — i.e. `assert.equal(rCount.result.unread, 1)` THREW
  // "Expected values to be strictly equal: 1 !== 0" on pre-fix code.
  const home = tmpHome();
  const mainRepo = makeGitRepo('p0fix');
  let childWt = null;
  try {
    childWt = addLinkedWorktree(mainRepo, 'p0fix');
    const { inboxPath } = registerChild(home, childWt, 'child-p0');

    // sanity: the durable NDJSON is genuinely empty — nothing native-drained it,
    // matching the live incident exactly (0-byte file despite real unread).
    assert.equal(fs.readFileSync(inboxPath, 'utf8'), '');

    const rSend = cli.run(
      ['send', '--to', 'child-p0', '--message', 'please commit your work', '--urgency', 'high'],
      ctx(home, { cwd: mainRepo })
    );
    assert.equal(rSend.result.ok, true, JSON.stringify(rSend.result));

    // `inbox count`/`inbox read` (the recipient's OWN read path) must now see it.
    const rCount = cli.run(['inbox', 'count', 'child-p0'], ctx(home, { cwd: childWt }));
    assert.equal(rCount.result.ok, true);
    assert.equal(rCount.result.unread, 1, 'the recipient\'s own inbox count must see the store-only direct');
    assert.equal(rCount.result.total, 1);

    const rRead = cli.run(['inbox', 'read', 'child-p0'], ctx(home, { cwd: childWt }));
    assert.equal(rRead.result.ok, true);
    assert.equal(rRead.result.count, 1);
    assert.equal(rRead.result.meshMessages.length, 1);
    assert.equal(rRead.result.meshMessages[0].body, 'please commit your work');
    // `lines` (the legacy NDJSON-only field) stays untouched/empty — nothing was
    // ever native-drained; the new content arrives ONLY via the additive
    // `meshMessages` field, never faked into the old field's shape.
    assert.deepEqual(rRead.result.lines, []);

    // the NDJSON on disk is STILL untouched (0 bytes) — proves the surfaced
    // message came from the store union, not a hidden write to the file.
    assert.equal(fs.readFileSync(inboxPath, 'utf8'), '');

    // `count`/`messages` must stay PURE — re-reading does not consume anything.
    const rCountAgain = cli.run(['inbox', 'count', 'child-p0'], ctx(home, { cwd: childWt }));
    assert.equal(rCountAgain.result.unread, 1, 'inbox count must stay non-mutating');

    // ack clears it...
    const rAck = cli.run(['inbox', 'ack', 'child-p0'], ctx(home, { cwd: childWt }));
    assert.equal(rAck.result.ok, true, JSON.stringify(rAck.result));

    // ...and it must actually stop being reported unread (not just locally, but
    // via the SAME read path used above).
    const rCount2 = cli.run(['inbox', 'count', 'child-p0'], ctx(home, { cwd: childWt }));
    assert.equal(rCount2.result.unread, 0, 'unread must be 0 after ack');

    // second read after ack: the already-read message must NOT reappear.
    const rRead2 = cli.run(['inbox', 'read', 'child-p0'], ctx(home, { cwd: childWt }));
    assert.equal(rRead2.result.count, 0, 'an already-acked message must not reappear on a later read');
    assert.equal(rRead2.result.meshMessages.length, 0);
  } finally {
    rm(home);
    if (childWt) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', childWt]);
    rm(mainRepo);
  }
});

test('P0 fix: a message present in BOTH the durable NDJSON and the store (same content hash) is returned ONCE, not twice', () => {
  // Simulates a native-drained message that landed in BOTH channels (exactly
  // what devswarm-pull.js's pullOnce + its best-effort "store parity feed" do
  // for a REAL native drain — same messageHash in both places) to prove the
  // union is deduped, not additive-by-default.
  const home = tmpHome();
  const mainRepo = makeGitRepo('p0dedup');
  let childWt = null;
  try {
    childWt = addLinkedWorktree(mainRepo, 'p0dedup');
    const { inboxPath } = registerChild(home, childWt, 'child-dedup');
    const repoKey = repokey.repoKeyForWorktree(childWt);
    assert.ok(repoKey, 'repoKey must resolve for a real git worktree');

    const sharedHash = 'native:shared-dedup-hash-1';
    // 1) the NDJSON side (as pullOnce's appendFileSync would write).
    fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
    fs.appendFileSync(inboxPath, JSON.stringify({
      _h: sharedHash, fromBranch: null, message: 'native message', createdAt: Date.now(), status: null,
    }) + '\n');
    // 2) the store side (as pullOnce's "store parity feed" ingestPayload would
    //    write) — SAME hash, same logical message.
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { s.appendMessage({ workspaceId: 'child-dedup', body: 'native message', hash: sharedHash }); }
    finally { s.close(); }

    const rCount = cli.run(['inbox', 'count', 'child-dedup'], ctx(home, { cwd: childWt }));
    assert.equal(rCount.result.ok, true);
    assert.equal(rCount.result.unread, 1, 'the same message in both channels must count ONCE, not twice');
    assert.equal(rCount.result.total, 1);

    const rRead = cli.run(['inbox', 'read', 'child-dedup'], ctx(home, { cwd: childWt }));
    assert.equal(rRead.result.count, 1);
    assert.deepEqual(rRead.result.lines, [JSON.stringify({ _h: sharedHash, fromBranch: null, message: 'native message', createdAt: rRead.result.lines[0] ? JSON.parse(rRead.result.lines[0]).createdAt : null, status: null })]);
    // the store-side twin must be excluded from meshMessages (already reflected
    // via `lines`) — the union deduped it, it is not double-reported.
    assert.equal(rRead.result.meshMessages.length, 0, 'the store-side duplicate must be deduped out of meshMessages');
  } finally {
    rm(home);
    if (childWt) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', childWt]);
    rm(mainRepo);
  }
});

test('P0 fix: the projection\'s unread count (deriveSummary) matches what `inbox count` actually reports, before and after ack', () => {
  const home = tmpHome();
  const mainRepo = makeGitRepo('p0proj');
  let childWt = null;
  try {
    childWt = addLinkedWorktree(mainRepo, 'p0proj');
    const repoKey = repokey.repoKeyForWorktree(childWt);
    registerChild(home, childWt, 'child-proj');

    const rSend = cli.run(
      ['send', '--to', 'child-proj', '--message', 'urgent: reply needed', '--urgency', 'urgent'],
      ctx(home, { cwd: mainRepo })
    );
    assert.equal(rSend.result.ok, true, JSON.stringify(rSend.result));

    const summaryBefore = storeLib.readSummaryForHash(home, repoKey);
    const projectedBefore = summaryBefore && summaryBefore.workspaces && summaryBefore.workspaces['child-proj'];
    assert.ok(projectedBefore, 'projection must have a row for child-proj');
    const rCount = cli.run(['inbox', 'count', 'child-proj'], ctx(home, { cwd: childWt }));
    assert.equal(rCount.result.unread, projectedBefore.directUnread,
      'inbox count unread must AGREE with the persisted projection\'s directUnread');
    assert.equal(rCount.result.unread, 1);
    assert.equal(projectedBefore.directUnread, 1);

    const rAck = cli.run(['inbox', 'ack', 'child-proj'], ctx(home, { cwd: childWt }));
    assert.equal(rAck.result.ok, true, JSON.stringify(rAck.result));

    const summaryAfter = storeLib.readSummaryForHash(home, repoKey);
    const projectedAfter = summaryAfter.workspaces['child-proj'];
    const rCountAfter = cli.run(['inbox', 'count', 'child-proj'], ctx(home, { cwd: childWt }));
    assert.equal(rCountAfter.result.unread, 0, 'inbox count must be 0 after ack');
    assert.equal(projectedAfter.directUnread, 0, 'the persisted projection must ALSO drop to 0 after ack (banner agreement)');
  } finally {
    rm(home);
    if (childWt) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', childWt]);
    rm(mainRepo);
  }
});

test('P0 fix: `inbox ack` on a store-mesh direct is ownership-gated (cross-workspace ack hazard) the same way `inbox messages --ack` already is', () => {
  const home = tmpHome();
  const mainRepo = makeGitRepo('p0ownership');
  let childWtA = null;
  let childWtB = null;
  try {
    childWtA = addLinkedWorktree(mainRepo, 'p0ownershipA');
    childWtB = addLinkedWorktree(mainRepo, 'p0ownershipB');
    const repoKey = repokey.repoKeyForWorktree(childWtA);
    registerChild(home, childWtA, 'child-a');
    registerChild(home, childWtB, 'child-b');

    const rSend = cli.run(
      ['send', '--to', 'child-b', '--message', 'for B only', '--urgency', 'normal'],
      ctx(home, { cwd: mainRepo })
    );
    assert.equal(rSend.result.ok, true, JSON.stringify(rSend.result));

    // A tries to ack B's descriptor-path inbox from A's own cwd/identity — the
    // NDJSON-side ack always succeeds (no cross-workspace hazard there, per the
    // existing 'ack' contract), but the NEW store-side ack must be REFUSED so A
    // cannot silently clear B's projected unread out from under it.
    cli.run(['inbox', 'ack', 'child-b'], ctx(home, { cwd: childWtA }));

    const summary = storeLib.readSummaryForHash(home, repoKey);
    assert.equal(summary.workspaces['child-b'].directUnread, 1,
      'a cross-workspace ack must NOT clear another workspace\'s projected unread');

    // B acking its OWN inbox (from B's own cwd) must succeed normally.
    const rAckB = cli.run(['inbox', 'ack', 'child-b'], ctx(home, { cwd: childWtB }));
    assert.equal(rAckB.result.ok, true);
    const summaryAfter = storeLib.readSummaryForHash(home, repoKey);
    assert.equal(summaryAfter.workspaces['child-b'].directUnread, 0);
  } finally {
    rm(home);
    if (childWtA) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', childWtA]);
    if (childWtB) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', childWtB]);
    rm(mainRepo);
  }
});
