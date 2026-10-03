'use strict';
// Fix Wave 1 (Codex review of HEAD, findings P1-A / P1-B / P2-D). All three
// findings live in cmdInbox's count/read/ack mesh-partition-widening block
// (scripts/devswarm.js, ~4370-4560).
//
// P1-A — HEADLINE BLOCKER: the two P0 fixes this repo already shipped
// compose into a duplicate-delivery bug NEITHER has alone.
//   - foldOne (scripts/devswarm.js, ~1611-1646) stops a candidate's OWN
//     cursor at a non-forwardable GAP (advanceTo/sawGap) but keeps
//     FORWARDING every later forwardable row regardless — a real copy lands
//     in the survivor's own partition under a DIFFERENT hash (meshMessageHash
//     hashes the recipient too).
//   - cmdInbox's mesh-partition widening (defect 27cd80902435) reads a live
//     `left` candidate's own partition as a sibling source, using only its
//     OWN stuck cursor.
//   A `[forwardable, non-forwardable, forwardable]` sequence on a candidate
//   the fold leaves LIVE therefore has its THIRD row counted TWICE: once as
//   the forward-copy already sitting in the survivor's own partition, once
//   as the still-"unread" original sitting in the candidate's own partition
//   (the pre-existing hash-only dedup cannot see they are the same logical
//   message — see scripts/devswarm.js's own P1-A comment at the fix site).
//
// FIX CHOSEN: option (b) from the assignment, in a STRUCTURAL (not blanket)
// form — a sibling's already-fetched unread window is walked in its own
// natural order; a forwardable row AT OR AFTER the first non-forwardable row
// seen is withheld from this call (never delivered, never lost — no cursor
// is touched), reported via meshGapWithheld/meshGapWithheldCount. A
// non-forwardable row is NEVER withheld (foldOne never forwards one, so it
// can never have a duplicate anywhere).
//
// OPTION (a) WAS TRIED FIRST AND REJECTED — evidence, not just argument: the
// first implementation recomputed the hash a sibling row WOULD carry if
// forwarded into `id`'s own partition (foldOne's own envelope) and
// suppressed a match — i.e. dedup on a CONTENT-derived "original identity".
// That is unsound: it is content-addressed with no real provenance link, so
// it ALSO matches the exact P0 case this repo already ships and tests
// (devswarm-mesh-union-review-fixes.test.js) — two INDEPENDENT real sends to
// DIFFERENT recipients that happen to share sender+ts+body+urgency. Running
// it against "P1-A guard (P0 non-regression)" below collapsed 2 genuinely
// distinct delivered messages down to 1 — an actual message-loss regression,
// caught by re-running this repo's own existing P0 invariant, not merely
// reasoned about. A SOUND content-addressed identity would need real
// provenance (the archived-orphan forward path's body-prefix marker,
// forwardArchivedOrphanUnread/archivedForwardProvenancePrefix, is the one
// place in this codebase that already does this safely, precisely because
// its forwarded body IS prefixed and so never coincidentally collides with
// unrelated real content) — but foldOne's own forward is contractually
// BODY-VERBATIM (devswarm-fold-mesh.test.js asserts
// `forwarded.body === 'which approach?'`, an established, tested contract),
// so borrowing that pattern here was not available without breaking it, and
// a schema column to carry real provenance was judged out of proportion for
// this fix.
//
// WHY THE STRUCTURAL (b) IS SOUND: it never inspects content at all, so it
// cannot coincidentally match two unrelated messages — "P1-A guard (P0
// non-regression)" below re-asserts the exact P0 scenario passes (no gap in
// either partition's window -> nothing withheld -> both delivered). Its
// cost is real but bounded and honest: a forwardable row genuinely NEW
// (never yet forwarded by any fold) that happens to sit after an existing
// gap in the SAME partition is ALSO withheld from this widened view until
// the next fold or a direct read of that sibling id — never silently, and
// never via a wrongful cursor advance (see "never advance a cursor past a
// message that was neither delivered nor forwarded").
//
// P1-B — a sibling-partition READ failure (cursorValue/messageCount/
// listMessages throwing for ONE sibling) used to be silently caught with NO
// meshGroupUnresolved/totalsPartial flag, unlike the earlier RESOLUTION-step
// failure a few lines above it, which already surfaces those fields. FIX:
// surface it the SAME way (same field names) — fail-open stays (every OTHER
// readable source still delivers), but the result must say so.
//
// P2-D — cmdInboxMessages (read-primary/peek-primary/--ack) already caps at
// DEFAULT_INBOX_READ_LIMIT/--limit; `count`/`read`/`ack` never did, and the
// mesh-partition widening makes an unbounded sibling backlog newly reachable
// here. FIX: apply the SAME cap constant/override rule (not a second
// mechanism) — here the pre-cap array is a plain per-source concatenation
// (never ts-sort-merged), so a straight length slice is already a genuine
// per-source structural prefix.
//
// MUTATION CHECK (documented per anti-hall protocol; each applied to the fix
// and confirmed to flip a test in this file from pass to fail, then
// reverted, file diffed back to identical):
//   P1-A/M1: delete the `gapSeen`-suffix withholding entirely (revert to the
//       pre-fix hash-only dedup: `if (row && row.hash && seenHashes.has(...))
//       continue; deliveredRows.push(row);` with no gap tracking at all) ->
//       KILLED by "P1-A RED/GREEN" below (unreadTotal reverts to 4, and
//       gap-msg-3's body is counted twice).
//   P1-A/M2: track `gapSeen` but never actually skip the withheld row (drop
//       the `continue` in the `else if (gapSeen)` branch, still incrementing
//       meshGapWithheldCount) -> KILLED by the same test (the duplicate
//       reappears in `meshMessages` even though meshGapWithheldCount would
//       misleadingly claim something was withheld).
//   P1-A/M3: set `gapSeen = true` unconditionally for EVERY row, not only
//       non-forwardable ones (`gapSeen = true;` added as the loop's first
//       statement, before the isForwardable check) -> KILLED by "P1-A guard
//       (P0 non-regression)" below (both single-row, gap-free sibling sends
//       now get withheld as if behind a gap: unreadTotal drops from 2 to 1).
//       Cross-checked (not re-run inside this file, but actually executed
//       during Fix Wave 1's verification pass) against
//       devswarm-count-read-mesh-union.test.js: this same mutation also
//       flips 4 of its pre-existing tests red (`count`/`read` "sees a
//       sibling registry row's mail", the C1 wake pre-check, and the ack
//       test) — confirming it is not merely caught by a new assertion but
//       by this repo's own established regression suite too.
//   P1-B/M1: delete the `meshGroupUnresolved = true; meshGroupError = ...`
//       lines from the sibling-read catch block (revert to the pre-fix bare
//       `catch (_) {}`) -> KILLED by "P1-B RED/GREEN" below (meshGroupUnresolved
//       is undefined, totalsPartial is undefined, despite a real sibling read
//       failure).
//   P2-D/M1: neutralize the cap step's own trigger condition (the `if
//       (preCapTotal > inboxCapLimit)` guard never fires, so the truncation
//       branch is dead code) -> KILLED by "P2-D RED/GREEN" below (`truncated`
//       is undefined, `meshMessages.length` is 8, not 3 — the explicit
//       --limit passed is silently ignored) and by "P2-D: ack never advances
//       a sibling cursor past what this call actually capped to" (the
//       sibling cursor advances to 5, not 2).
//   P2-D/M2: stop overwriting `part.deliveredCount` with the POST-cap kept
//       length in the truncation branch (leave it at its PRE-cap value) ->
//       KILLED by "P2-D: ack never advances a sibling cursor past what this
//       call actually capped to" (the sibling cursor advances past the 3
//       withheld rows this call never actually delivered).

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

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fixwave1-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fixwave1-repo-' + tag + '-'));
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
      const fields = { from: row.from || 'sender', to: toId, type: 'direct', urgency: row.urgency || 'normal', message: row.body, timestamp: row.ts };
      const hash = storeLib.meshMessageHash(fields);
      storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash }));
    }
  } finally { s.close(); }
  return repoKey;
}

// seedNativeRow: a non-forwardable native-shaped row (mtype/sender/recipient
// all NULL — mirrors devswarm-ingest.js's bare appendMessage path exactly,
// the same shape devswarm-fold-cursor-advance.test.js's own "RED" test uses).
function seedNativeRow(home, repoDir, toId, row) {
  const repoKey = repokey.repoKeyForWorktree(repoDir);
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    s.appendMeshRow({
      workspaceId: toId, ts: row.ts, hash: 'native:' + row.ts, body: row.body,
      sender: null, recipient: null, mtype: null, urgency: null, isHeartbeat: false, needsReply: false,
    });
  } finally { s.close(); }
}

// buildGapScenario: registers a candidate A with [forwardable, non-
// forwardable, forwardable] in its own partition, then registers a second
// row B sharing the SAME worktree, which triggers retireWorktreeDuplicates
// -> foldGroupIntoSurvivor. A is a genuinely distinct live child (own
// descriptor) so the fold LEFTs it (forwards + never tombstones — the same
// P1 precedent devswarm-fold-cursor-advance.test.js's own SUCCESS CONDITION
// test relies on). Returns { home, main, child, A, B } — caller owns cleanup.
function buildGapScenario(tag) {
  const home = tmpHome();
  const main = makeGitRepo('gap-' + tag);
  const child = addLinkedWorktree(main, 'gap-' + tag + '-c');
  const childTop = topOf(child);
  const A = 'candidate-gap-' + tag;
  const B = 'survivor-gap-' + tag;

  const rA = cli.run(['register', A, '--worktree', childTop, '--session', 'sess-a-' + tag], ctx(home, { cwd: child }));
  assert.equal(rA.result.ok, true, JSON.stringify(rA.result));

  // Row 1 (forwardable), row 2 (native, non-forwardable — the GAP), row 3
  // (forwardable). urgency:null on the direct rows so the recomputed
  // as-if-forwarded hash's `|| 'normal'` fallback is actually exercised
  // (matches foldOne's own m.urgency||'normal' default) — this is what lets
  // P1-A/M2 (dropping that fallback) get caught.
  seedPartition(home, child, A, [{ body: 'gap-msg-1', ts: 1000, urgency: null }]);
  seedNativeRow(home, child, A, { body: 'gap-native-mail', ts: 2000 });
  seedPartition(home, child, A, [{ body: 'gap-msg-3', ts: 3000, urgency: null }]);

  const bInboxPath = path.join(home, 'descriptor-inboxes', B + '.ndjson');
  const bCursorPath = path.join(home, 'descriptor-cursors', B + '.cursor');
  const rB = cli.run(
    ['register', B, '--worktree', childTop, '--session', 'sess-b-' + tag, '--inbox', bInboxPath, '--cursor', bCursorPath],
    ctx(home, { cwd: child })
  );
  assert.equal(rB.result.ok, true, JSON.stringify(rB.result));
  assert.ok(!(rB.result.retiredDuplicates || []).includes(A), 'precondition: A must NOT be tombstoned (it is a genuinely distinct live child)');
  assert.ok((rB.result.leftDuplicates || []).includes(A), 'precondition: A must be reported LEFT (the fold-composition bug only exists for a LEFT candidate)');

  return { home, main, child, A, B };
}
function cleanupGapScenario(sc) {
  cp.spawnSync('git', ['-C', sc.main, 'worktree', 'remove', '--force', sc.child]);
  rm(sc.main); rm(sc.child); rm(sc.home);
}

// ---------------------------------------------------------------------------
// P1-A
// ---------------------------------------------------------------------------

test('P1-A RED/GREEN: [forwardable, non-forwardable, forwardable] on a LEFT candidate — the survivor\'s union delivers each logical message exactly once, never a duplicate', () => {
  const sc = buildGapScenario('count-read');
  try {
    const count = cli.run(['inbox', 'count', sc.B], ctx(sc.home, { cwd: sc.child }));
    assert.equal(count.result.ok, true, JSON.stringify(count.result));
    // 3 logical messages exist: gap-msg-1, gap-native-mail, gap-msg-3. Never 4
    // (the pre-fix duplicate-counted total).
    assert.equal(count.result.unreadTotal, 3,
      `unreadTotal must be 3 (one per logical message), not 4 (gap-msg-3 double-counted) — got ${count.result.unreadTotal}`);

    const read = cli.run(['inbox', 'read', sc.B], ctx(sc.home, { cwd: sc.child }));
    assert.equal(read.result.ok, true, JSON.stringify(read.result));
    const bodies = read.result.meshMessages.map((m) => m.body).sort();
    assert.deepEqual(bodies, ['gap-msg-1', 'gap-msg-3', 'gap-native-mail'],
      `each logical message must appear exactly once — got ${JSON.stringify(bodies)}`);
    const dupCount = read.result.meshMessages.filter((m) => m.body === 'gap-msg-3').length;
    assert.equal(dupCount, 1, 'gap-msg-3 (the forwardable row AFTER the gap) must never be delivered twice');
  } finally { cleanupGapScenario(sc); }
});

test('P1-A guard: a NON-forwardable row is never suppressed by the identity check (it has no forward copy anywhere, by construction)', () => {
  const sc = buildGapScenario('native-guard');
  try {
    const read = cli.run(['inbox', 'read', sc.B], ctx(sc.home, { cwd: sc.child }));
    assert.equal(read.result.ok, true, JSON.stringify(read.result));
    const native = read.result.meshMessages.filter((m) => m.body === 'gap-native-mail');
    assert.equal(native.length, 1, 'the genuinely un-forwardable gap row must still surface exactly once — this fix must never suppress real, never-forwarded mail');
  } finally { cleanupGapScenario(sc); }
});

test('P1-A guard (P0 non-regression): two independent real sends to DIFFERENT recipients sharing sender+ts+body are still BOTH delivered', () => {
  // Re-asserts the exact P0 invariant devswarm-mesh-union-review-fixes.test.js
  // already covers, run again here as a guard that the P1-A identity check
  // does not accidentally widen into that case: no fold/gap is involved at
  // all here, so the wouldBeForwardHash check for either row (both
  // forwardable) is computed against `id`'s own partition — since NEITHER
  // row was ever forwarded, neither computed hash can match anything, and
  // both must be delivered.
  const home = tmpHome();
  const repo = makeGitRepo('p1a-p0-control');
  try {
    register(home, repo, 'primary-p1a-p0', undefined);
    register(home, repo, 'sibling-p1a-p0', undefined);
    seedPartition(home, repo, 'primary-p1a-p0', [{ body: 'collision content', ts: 5000, from: 'agentA' }]);
    seedPartition(home, repo, 'sibling-p1a-p0', [{ body: 'collision content', ts: 5000, from: 'agentA' }]);

    const r = cli.run(['inbox', 'count', 'primary-p1a-p0'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.unreadTotal, 2, 'two genuinely distinct real sends must both be delivered, never collapsed by the P1-A identity check');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// P1-B
// ---------------------------------------------------------------------------

test('P1-B RED/GREEN: a sibling-partition READ failure (not a resolution failure) is surfaced as meshGroupUnresolved/totalsPartial, not silently swallowed', () => {
  const home = tmpHome();
  const repo = makeGitRepo('p1b-cmdinbox');
  try {
    register(home, repo, 'primary-p1b-ci', undefined);
    register(home, repo, 'sibling-p1b-ci', undefined);
    seedPartition(home, repo, 'primary-p1b-ci', [{ body: 'own partition mail', ts: 1000 }]);
    seedPartition(home, repo, 'sibling-p1b-ci', [{ body: 'unreadable sibling mail', ts: 2000 }]);

    // Force ONLY the sibling's listMessages call to throw — resolution
    // itself (listRegistry/canonicalMeshId) succeeds fine, so meshUnionActive
    // is true and the sibling IS in meshPartitionIds; the failure is
    // specifically the per-sibling READ this fix targets.
    const realOpenStore = storeLib.openStore;
    storeLib.openStore = function (opts) {
      const s = realOpenStore(opts);
      const realListMessages = s.listMessages;
      s.listMessages = function (pid) {
        if (String(pid) === 'sibling-p1b-ci') throw new Error('simulated sibling partition read failure');
        return realListMessages.apply(s, arguments);
      };
      return s;
    };
    let r;
    try {
      r = cli.run(['inbox', 'count', 'primary-p1b-ci'], ctx(home, { cwd: repo }));
    } finally {
      storeLib.openStore = realOpenStore;
    }

    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    // Fail-open: id's own mail still delivered.
    assert.equal(r.result.unreadTotal, 1, 'id\'s own partition mail still delivers despite the sibling failure (fail-open)');
    // THE FIX: the failure must not be indistinguishable from "no unread mail".
    assert.equal(r.result.meshGroupUnresolved, true, 'a sibling read failure must surface meshGroupUnresolved — an unreadable sibling is NOT the same fact as "no unread mail"');
    assert.ok(typeof r.result.meshGroupError === 'string' && r.result.meshGroupError.includes('sibling-p1b-ci'),
      'the error must name the specific unreadable partition: ' + JSON.stringify(r.result.meshGroupError));
    assert.equal(r.result.totalsPartial, true, 'total/unreadTotal must not be presented as a complete read when a sibling could not be read');
  } finally { rm(home); rm(repo); }
});

test('P1-B negative control: a genuinely single-partition workspace never sets meshGroupUnresolved/totalsPartial (still true after the fix)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('p1b-solo-ci');
  try {
    register(home, repo, 'solo-p1b-ci', undefined);
    seedPartition(home, repo, 'solo-p1b-ci', [{ body: 'solo mail', ts: 1000 }]);
    const r = cli.run(['inbox', 'count', 'solo-p1b-ci'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.unreadTotal, 1);
    assert.equal(r.result.meshGroupUnresolved, false);
    assert.equal(r.result.totalsPartial, false);
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// P2-D
// ---------------------------------------------------------------------------

test('P2-D RED/GREEN: `inbox read` with a sibling backlog larger than --limit is capped, flags truncation, and never advances a cursor past a withheld row', () => {
  const home = tmpHome();
  const repo = makeGitRepo('p2d-cap');
  try {
    register(home, repo, 'primary-p2d', undefined);
    register(home, repo, 'sibling-p2d', undefined);
    const rows = [];
    for (let i = 0; i < 8; i++) rows.push({ body: 'sib-msg-' + i, ts: 1000 + i, from: 'childZ' });
    seedPartition(home, repo, 'sibling-p2d', rows);

    const r = cli.run(['inbox', 'read', 'primary-p2d', '--limit', '3'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.meshMessages.length, 3, 'the cap must actually bound what is returned');
    assert.equal(r.result.unreadStore, 3, 'unreadStore reflects only what THIS call returned');
    assert.equal(r.result.total, 8, 'total/unreadTotal still report the REAL, untruncated total (never silently hidden)');
    assert.equal(r.result.truncated, true, 'truncation must be flagged explicitly');
    assert.equal(r.result.truncatedCount, 5);
    assert.equal(r.result.limit, 3);

    // A structural prefix: the FIRST 3 sibling rows by natural order, not an
    // arbitrary/ts-shuffled subset — proves "never withhold row N-1 while
    // keeping row N of the same source".
    const bodies = r.result.meshMessages.map((m) => m.body);
    assert.deepEqual(bodies, ['sib-msg-0', 'sib-msg-1', 'sib-msg-2']);
  } finally { rm(home); rm(repo); }
});

test('P2-D guard: an under-cap read is completely unaffected (no truncated field, everything delivered)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('p2d-undercap');
  try {
    register(home, repo, 'primary-p2d-u', undefined);
    register(home, repo, 'sibling-p2d-u', undefined);
    seedPartition(home, repo, 'sibling-p2d-u', [{ body: 'sib-1', ts: 1000 }, { body: 'sib-2', ts: 1100 }]);
    const r = cli.run(['inbox', 'read', 'primary-p2d-u'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.meshMessages.length, 2);
    assert.equal(r.result.truncated, undefined, 'no truncation field when nothing was withheld');
  } finally { rm(home); rm(repo); }
});

test('P2-D: ack never advances a sibling cursor past what this call actually capped to', () => {
  const home = tmpHome();
  const repo = makeGitRepo('p2d-ack-cap');
  try {
    register(home, repo, 'primary-p2d-ack', undefined);
    register(home, repo, 'sibling-p2d-ack', undefined, 'unclaimed:sibling-p2d-ack');
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push({ body: 'ack-sib-' + i, ts: 1000 + i, from: 'childY' });
    seedPartition(home, repo, 'sibling-p2d-ack', rows);

    const acked = cli.run(['inbox', 'ack', 'primary-p2d-ack', '--ack-as-owner', '--limit', '2'], ctx(home, { cwd: repo }));
    assert.equal(acked.result.ok, true, JSON.stringify(acked.result));
    assert.equal(acked.result.truncated, true, 'ack must report the same truncation signal as count/read');
    assert.equal(acked.result.truncatedCount, 3);

    const repoKey = repokey.repoKeyForWorktree(repo);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let sibCursor;
    try { sibCursor = s.cursorValue('sibling-p2d-ack'); } finally { s.close(); }
    assert.equal(sibCursor, 2, 'the sibling cursor must advance ONLY through the 2 rows this call actually capped to and delivered, never past the 3 withheld rows');

    // The withheld rows must still be readable on a follow-up call (never lost).
    const after = cli.run(['inbox', 'count', 'primary-p2d-ack'], ctx(home, { cwd: repo }));
    assert.equal(after.result.ok, true, JSON.stringify(after.result));
    assert.equal(after.result.unreadTotal, 3, 'the 3 withheld rows must still be reported unread — a cap must never lose mail');
  } finally { rm(home); rm(repo); }
});
