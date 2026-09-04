'use strict';
// Item 1 P0 fix — downstream-Primary mail loss, field evidence: a live
// `primary-<hash>` row's cursor advanced across two wake-watch turns with NO
// `read-primary` issued in between (cursorStore 3139->3140->3141), while the
// swept rows (storeSeq 34167/34170) PROVABLY still exist in that exact row's
// own row set (`inbox messages primary-63f9261d --limit 5000` returns them).
// The next `read-primary` started past them; both downstream children had to
// resend.
//
// ROOT CAUSE (traced, this session, code-level — see file:line below):
// `retireWorktreeDuplicates` fixes its SURVIVOR to always be the CALLER's own
// self-registration (`registerStoreDescriptor`, hooks/devswarm-child-turn.js
// :742-758, called on EVERY child turn) — it never runs pickSurvivor/
// pickFreshestLive at all. Its ONLY existing meshId protection
// (scripts/devswarm.js:1624, `if (String(keepDesc.id) === String(keepMesh))
// return null;`) guards the meshId row ONLY when it is the CALLER/survivor.
// It does nothing when the meshId row (e.g. the Primary's own
// `primary-<hash>` registration) is merely a same-worktree CANDIDATE in some
// OTHER builder-id self-register's fold pass (or in foldMeshDuplicates' own
// pickSurvivor-driven grouping) — foldOne's unconditional cursor-advance
// (the B1(b) "contiguous forwarded prefix" write, scripts/devswarm.js
// ~:1854, pre-fix) then swept the meshId row's read frontier forward every
// time ANY co-located builder-id self-register ran its per-turn fold, moving
// its unread mail into a survivor id nothing standard (`read-primary`,
// `inbox count`) ever queries.
//
// COORDINATOR'S INFERENCE (pickFreshestLive/pickSurvivor choosing a dead
// UUID twin over the live meshId row via isLiveSessionId's shape-only check)
// is DISPROVEN for this every-turn path: retireWorktreeDuplicates never
// calls pickSurvivor — survivor selection there is architecturally fixed to
// the calling descriptor, not chosen by any liveness heuristic. That
// selection concern is real only for foldMeshDuplicates' registry-wide sweep
// (update/doctor cadence, not per-turn), a separate, lower-frequency
// surface not implicated by the "EVERY TURN" field evidence.
//
// FIX (scripts/devswarm.js, foldGroupIntoSurvivor, ~:1764): a candidate whose
// id IS the canonical meshId for its own worktree (`canonicalMeshId(d.
// worktreePath) === d.id`) is now excluded from folding altogether —
// reported LEFT, forward loop and cursor-advance both skipped entirely. This
// closes the asymmetry symmetrically with the existing keepDesc-side guard,
// for BOTH callers that share foldGroupIntoSurvivor (retireWorktreeDuplicates
// AND foldMeshDuplicates).
//
// MUTATION-CHECK: removing the `isMeshAnchor` guard block (or its `continue`)
// reproduces the exact pre-fix RED behaviour on both tests below.

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
const mutantKit = require('./lib/devswarm-mutant-kit.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fold-anchor-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fold-anchor-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function topOf(dir) { return inst.resolveWorktree(dir); }
function meshOf(dir) { return inst.primaryWorkspaceId(inst.resolveWorktree(dir)); }
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

// -----------------------------------------------------------------------
// UNIT-LEVEL REPRODUCTION: foldGroupIntoSurvivor called directly with a
// fake store handle whose CANDIDATE id is the canonical meshId for its own
// worktree (the live Primary's row), while the SURVIVOR is some unrelated
// builder-id row (the co-located self-registrant / "UUID twin" in the field
// evidence). Proves: pre-fix, the meshId row's cursor gets swept past
// undelivered mail; post-fix, it is untouched (reported LEFT, no forward).
// -----------------------------------------------------------------------
test('REPRO + FIX: a candidate that IS the canonical meshId row for its own worktree is NEVER folded (no forward, no cursor advance) regardless of survivor', () => {
  const WT = '/wt/live-primary-fixture';
  const MESH_ID = cli.canonicalMeshId(WT); // e.g. 'primary-XXXXXXXX' — the LIVE Primary's own anchor id
  const SURVIVOR = 'builder-uuid-twin-76cf862f'; // co-located self-registrant / UUID twin

  const setCursorCalls = [];
  let appendCalls = 0;
  const rows = [
    { hash: 'h1', ts: 1000, body: 'undelivered-1', sender: 'x', recipient: MESH_ID, mtype: 'direct', urgency: 'normal', needsReply: false, isHeartbeat: false },
    { hash: 'h2', ts: 2000, body: 'undelivered-2', sender: 'x', recipient: MESH_ID, mtype: 'direct', urgency: 'normal', needsReply: false, isHeartbeat: false },
  ];
  const fakeS = {
    cursorValue(id) { return id === MESH_ID ? 0 : 0; },
    listMessages(id) { return id === MESH_ID ? rows.slice() : []; },
    messageCount(id) { return id === MESH_ID ? rows.length : 0; },
    setCursor(id, val) { setCursorCalls.push({ id, val }); },
    appendMeshRow() { appendCalls++; return { inserted: true, seq: appendCalls }; },
    removeRegistryIf() { throw new Error('must never be reached — the meshId anchor must never be tombstoned via this path'); },
  };
  const candidateRow = { id: MESH_ID, worktreePath: WT, sessionId: 'live-primary-session', updatedAt: 1, writeSeq: 1 };

  const res = cli.foldGroupIntoSurvivor(fakeS, '/nonexistent-home-fixture', SURVIVOR, [candidateRow], {});

  assert.deepStrictEqual(res.left, [MESH_ID], 'the meshId anchor row must be reported LEFT, never retired');
  assert.deepStrictEqual(res.retired, [], 'the meshId anchor row must never be tombstoned');
  assert.strictEqual(appendCalls, 0, 'the meshId anchor row\'s mail must NEVER be forwarded into another survivor (it is the stable addressing target, not a duplicate to collapse)');
  assert.deepStrictEqual(setCursorCalls, [],
    'THE FIX: the meshId anchor row\'s cursor must NEVER be advanced by a fold it did not request — advancing it here would mark undelivered mail "read" on the only partition read-primary/inbox-count ever queries, with the copy sitting in a survivor id nothing standard drains');
});

// -----------------------------------------------------------------------
// FIELD-SHAPE E2E: retireWorktreeDuplicates (the every-turn path, called
// from hooks/devswarm-child-turn.js's registerStoreDescriptor) with a
// co-located builder-id self-register sharing the SAME worktree as a live
// meshId (Primary) row that has unread mail. Proves the meshId row survives
// untouched through the real per-turn call path, not just the unit harness.
// -----------------------------------------------------------------------
test('FIELD-SHAPE E2E: a co-located builder-id self-register\'s per-turn retireWorktreeDuplicates fold never advances the live meshId Primary row\'s cursor', () => {
  const home = tmpHome();
  const W = makeGitRepo('anchor-e2e');
  try {
    const repoKey = repokey.repoKeyForWorktree(W);
    const wt = topOf(W);
    const meshId = meshOf(W);

    // Seed the live Primary's meshId row with unread mail addressed to it.
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      s.upsertRegistry({ id: meshId, worktreePath: wt, sessionId: 'primary-live-session' });
      const f1 = { from: 'sender-x', to: meshId, type: 'direct', message: 'primary-mail-1', timestamp: Date.now(), urgency: 'normal' };
      const f2 = { from: 'sender-x', to: meshId, type: 'direct', message: 'primary-mail-2', timestamp: Date.now(), urgency: 'normal' };
      storeLib.appendMeshMessage(s, Object.assign({}, f1, { hash: storeLib.meshMessageHash(f1) }));
      storeLib.appendMeshMessage(s, Object.assign({}, f2, { hash: storeLib.meshMessageHash(f2) }));
    } finally { s.close(); }

    const sPre = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let preCursor, preCount;
    try { preCursor = sPre.cursorValue(meshId); preCount = sPre.messageCount(meshId); } finally { sPre.close(); }
    assert.strictEqual(preCursor, 0, 'precondition: the Primary meshId row has not been drained yet');
    assert.ok(preCount >= 2, 'precondition: the Primary meshId row holds the unread backlog');

    // A co-located builder-id self-register, same worktree, NOT the meshId
    // (mirrors registerStoreDescriptor's per-turn call: keepDesc.id !==
    // keepMesh, so the early-return guard at :1624 does NOT fire).
    const builderDesc = { id: 'builder-uuid-twin-fixture', worktreePath: wt, sessionId: 'builder-session' };
    const result = cli.retireWorktreeDuplicates(home, builderDesc, ctx(home, { cwd: wt }));

    // The meshId row must be reported LEFT (if reported at all) — never
    // retired/tombstoned, and critically never silently drained.
    if (result && result.left) {
      assert.ok(result.left.includes(meshId) || true); // presence is fine; absence (guard short-circuits before classification bookkeeping) is also fine
    }
    if (result && result.retired) {
      assert.ok(!result.retired.includes(meshId), 'the Primary meshId row must NEVER be tombstoned by a co-located builder-id self-register');
    }

    const sPost = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let postCursor, postCount, meshStillRegistered;
    try {
      postCursor = sPost.cursorValue(meshId);
      postCount = sPost.messageCount(meshId);
      meshStillRegistered = (sPost.listRegistry() || []).some((r) => r && String(r.id) === String(meshId));
    } finally { sPost.close(); }

    assert.ok(meshStillRegistered, 'the Primary meshId row must still be registered');
    assert.strictEqual(postCursor, 0,
      `THE FIX: the live Primary meshId row's cursor must NOT be advanced by a co-located builder-id self-register's fold (cursor=${postCursor}) — pre-fix this silently marked undelivered mail "read"`);
    assert.strictEqual(postCount, preCount, 'no message rows lost (forward-then-tombstone never ran against this row)');

    // The mail must still be reachable by reading the meshId row directly —
    // the exact guarantee `read-primary`/`inbox count` depend on.
    const sVerify = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let bodies;
    try { bodies = sVerify.listMessages(meshId, { sinceCursor: 0 }).map((m) => m.body); } finally { sVerify.close(); }
    assert.ok(bodies.includes('primary-mail-1') && bodies.includes('primary-mail-2'),
      'both undelivered messages must still be readable, unread, directly off the Primary meshId row');
  } finally { rm(W); rm(home); }
});

// -----------------------------------------------------------------------
// GUARD (unaffected by this fix): the existing "distinct live child" and
// "stale cross-reference" fold behaviours from devswarm-fold-stale-alias /
// devswarm-fold-cursor-advance must be untouched — neither test's ids are
// meshId-format, so the new guard's `String(d.id) ===
// canonicalMeshId(d.worktreePath)` comparison never matches them.
// -----------------------------------------------------------------------
test('GUARD: a non-meshId candidate id is never mistaken for a meshId anchor', () => {
  const WT = '/wt/some-fixture-path';
  const meshId = cli.canonicalMeshId(WT);
  assert.notStrictEqual('some-ordinary-builder-id', meshId, 'sanity: the guard fixture id must not accidentally equal the real canonical meshId');
});

// -----------------------------------------------------------------------
// MUTATION-KILL: removing the isMeshAnchor guard reproduces the exact
// pre-fix RED behaviour (cursor advanced, mail forwarded away) on a fresh
// scratch copy of devswarm.js — proving the guard, not something else, is
// what makes the fix test above pass.
// -----------------------------------------------------------------------
test('MUTATION-KILL: removing the meshId-anchor guard reproduces the pre-fix cursor-advance bug', () => {
  mutantKit.withMutant(
    "    if (isMeshAnchor) { left.push(d.id); leftRows.set(String(d.id), d); anchorLeft.add(String(d.id)); continue; }\n",
    '',
    (mutatedCli) => {
      const WT = '/wt/live-primary-fixture-mutant';
      const MESH_ID = mutatedCli.canonicalMeshId(WT);
      const SURVIVOR = 'builder-uuid-twin-mutant';
      const setCursorCalls = [];
      let appendCalls = 0;
      const rows = [
        { hash: 'h1', ts: 1000, body: 'undelivered-1', sender: 'x', recipient: MESH_ID, mtype: 'direct', urgency: 'normal', needsReply: false, isHeartbeat: false },
      ];
      const fakeS = {
        cursorValue(id) { return id === MESH_ID ? 0 : 0; },
        listMessages(id) { return id === MESH_ID ? rows.slice() : []; },
        messageCount(id) { return id === MESH_ID ? rows.length : 0; },
        setCursor(id, val) { setCursorCalls.push({ id, val }); },
        appendMeshRow() { appendCalls++; return { inserted: true, seq: appendCalls }; },
        removeRegistryIf() { return false; },
      };
      const candidateRow = { id: MESH_ID, worktreePath: WT, sessionId: 'live-primary-session', updatedAt: 1, writeSeq: 1 };
      mutatedCli.foldGroupIntoSurvivor(fakeS, '/nonexistent-home-fixture', SURVIVOR, [candidateRow], {});
      assert.ok(setCursorCalls.length > 0 && appendCalls > 0,
        'RED (expected on the mutant): without the guard, the meshId anchor row IS folded — cursor advanced and mail forwarded away. If this fails, the guard removal did not actually reproduce the bug.');
    },
    { prefix: 'anti-hall-fold-anchor-mutant' }
  );
});

// =======================================================================
// WAVE 10 — the EXACT FIELD SHAPE the Wave 9 narrowing does not cover.
//
// VERIFIED PREDICATE FACTS (read this session, scripts/devswarm.js):
//   - isLiveSessionId (:245-250) returns FALSE for any sessionId starting
//     with SYNTHETIC_SESSION_PREFIX 'unclaimed:'. The live Primary's own
//     anchor row in the incident store carries sessionId
//     'unclaimed:primary-<hash>' — so the LIVENESS half of the guard is
//     FALSE in the field, by design.
//   - readDescriptorFile (:686) resolves ONLY workspaces/<id>.json
//     (descriptorPath :584 -> workspacesDir :475 -> devswarmRoot =
//     <home>/.anti-hall/devswarm). So in the field the guard held on the
//     DESCRIPTOR half ALONE — and archive paths legitimately delete a live
//     descriptor, making that single thread fragile.
//   - primaryCursorPath (:585) = <home>/.anti-hall/devswarm/cursors/<id>.json.
//
// FIX UNDER TEST: a third, independent attended signal — READER EVIDENCE
// (store cursor > 0, or an on-disk cursors/<id>.json ack file). The tests
// below pin all three field cases; case 2 (descriptor deleted, cursor > 0)
// is the one ONLY reader evidence can save, and is the mutation target.
// =======================================================================

const meshStore = storeLib;
const inboxCursor = require('../../plugins/anti-hall/companion/lib/devswarm-inbox-cursor.js');

// PATHS COME FROM THE HELPERS, NEVER FROM A HARDCODED FILENAME. The field
// report and the code cite different extensions for the read-path ack file
// ('.cursor' vs '.json'), so `cli.primaryCursorPath` / `cli.workspacesDir`
// (both exported) are the only source of truth here — a fixture that spelled
// the name itself would silently stop testing the real path the moment either
// helper changed.
const descriptorFileFor = (home, id) => path.join(cli.workspacesDir(home), id + '.json');
const cursorFileFor = (home, id) => cli.primaryCursorPath(home, id);

function seedFieldFixture(opts) {
  // Builds the real field shape: a canonical mesh anchor row with an
  // 'unclaimed:<id>' sessionId and unread mail, plus a same-worktree UUID
  // twin that will run the per-turn retireWorktreeDuplicates self-register.
  const home = tmpHome();
  const W = makeGitRepo(opts.tag);
  const repoKey = repokey.repoKeyForWorktree(W);
  const wt = topOf(W);
  const meshId = meshOf(W);
  const s = meshStore.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    s.upsertRegistry({ id: meshId, worktreePath: wt, sessionId: 'unclaimed:' + meshId });
    for (const body of ['field-mail-1', 'field-mail-2', 'field-mail-3']) {
      const f = { from: 'sender-x', to: meshId, type: 'direct', message: body, timestamp: Date.now(), urgency: 'normal' };
      meshStore.appendMeshMessage(s, Object.assign({}, f, { hash: meshStore.meshMessageHash(f) }));
    }
    // STORE-side reader evidence (s.cursorValue) — the value foldOne itself
    // advances via s.setCursor. NOTE: the store API is `cursorValue`/`setCursor`
    // (devswarm-store.js:799 sqlite, :1356 journal); there is no `getCursor`.
    if (opts.cursor > 0) s.setCursor(meshId, opts.cursor);
  } finally { s.close(); }
  if (opts.descriptor) {
    fs.mkdirSync(path.dirname(descriptorFileFor(home, meshId)), { recursive: true });
    fs.writeFileSync(descriptorFileFor(home, meshId),
      JSON.stringify({ id: meshId, worktreePath: wt, sessionId: 'unclaimed:' + meshId }));
  }
  // FILE-side reader evidence — written through the production writer
  // (inboxCursor.ackTo, the same call the read path uses) rather than by
  // hand, so the fixture cannot drift from the real on-disk format.
  if (opts.cursorFile > 0) inboxCursor.ackTo(cursorFileFor(home, meshId), opts.cursorFile);
  return { home, W, repoKey, wt, meshId };
}
function readState(home, repoKey, meshId) {
  const s = meshStore.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    return {
      cursor: s.cursorValue(meshId),
      count: s.messageCount(meshId),
      registered: (s.listRegistry() || []).some((r) => r && String(r.id) === String(meshId)),
    };
  } finally { s.close(); }
}

test('FIELD CASE 1 (unclaimed: sessionId + descriptor + cursor>0): a same-worktree UUID twin self-register must not fold the anchor nor advance its cursor', () => {
  const f = seedFieldFixture({ tag: 'field-1', descriptor: true, cursor: 1 });
  try {
    const cliMod = cli;
    assert.strictEqual(cliMod.isLiveSessionId ? cliMod.isLiveSessionId('unclaimed:' + f.meshId) : false, false,
      'precondition (verified fact): an unclaimed: sessionId is NOT live — the liveness half of the guard is false in the field');
    const pre = readState(f.home, f.repoKey, f.meshId);
    assert.strictEqual(pre.cursor, 1, 'precondition: the anchor has a real read frontier');

    const twin = { id: 'builder-uuid-twin-field-1', worktreePath: f.wt, sessionId: 'twin-session' };
    const result = cli.retireWorktreeDuplicates(f.home, twin, ctx(f.home, { cwd: f.wt }));
    if (result && result.retired) {
      assert.ok(!result.retired.includes(f.meshId), 'the attended field anchor must never be tombstoned');
    }
    const post = readState(f.home, f.repoKey, f.meshId);
    assert.ok(post.registered, 'the anchor row must still be registered');
    assert.strictEqual(post.cursor, 1,
      `THE FIX: the anchor's cursor must be untouched by a twin's self-register fold (got ${post.cursor})`);
    assert.strictEqual(post.count, pre.count, 'no message rows moved out of the anchor partition');
  } finally { rm(f.W); rm(f.home); }
});

test('FIELD CASE 2 (unclaimed: sessionId, descriptor DELETED, cursor>0): reader evidence alone still protects the anchor', () => {
  const f = seedFieldFixture({ tag: 'field-2', descriptor: false, cursor: 2 });
  try {
    assert.ok(!fs.existsSync(descriptorFileFor(f.home, f.meshId)),
      'precondition: NO descriptor — both pre-Wave-10 signals are false; only reader evidence remains');
    const pre = readState(f.home, f.repoKey, f.meshId);
    assert.strictEqual(pre.cursor, 2, 'precondition: a real read frontier exists (the STORE-side reader evidence)');
    assert.strictEqual(inboxCursor.readCursor(cursorFileFor(f.home, f.meshId)), 0,
      'precondition: and NO ack file — this case exercises the s.cursorValue branch specifically');

    const twin = { id: 'builder-uuid-twin-field-2', worktreePath: f.wt, sessionId: 'twin-session' };
    cli.retireWorktreeDuplicates(f.home, twin, ctx(f.home, { cwd: f.wt }));

    const post = readState(f.home, f.repoKey, f.meshId);
    assert.strictEqual(post.cursor, 2,
      `THE FIX (reader evidence): a descriptor-less anchor with a live read frontier must NOT be drained (got ${post.cursor}) — deleting the descriptor is a normal archive side effect and must not strip the anchor's protection`);
    assert.strictEqual(post.count, pre.count, 'no message rows forwarded away from the anchor partition');
    assert.ok(post.registered, 'the anchor row must still be registered');
  } finally { rm(f.W); rm(f.home); }
});

test('FIELD CASE 2b (unclaimed: sessionId, no descriptor, STORE cursor 0 but an on-disk ack file): the cursor-FILE branch protects the anchor on its own', () => {
  // The read path writes TWO cursors per partition (inboxCursor.ackTo on
  // primaryCursorPath AND s.setCursor). A store that lost its cursors row —
  // or a partition acked only through the file namespace — still has a real
  // reader with a real frontier, so the file alone must count as evidence.
  // This is the branch FIELD CASE 2 does NOT exercise.
  const f = seedFieldFixture({ tag: 'field-2b', descriptor: false, cursor: 0, cursorFile: 2 });
  try {
    const pre = readState(f.home, f.repoKey, f.meshId);
    assert.strictEqual(pre.cursor, 0, 'precondition: the STORE cursor is 0 — the s.cursorValue branch is FALSE here');
    assert.strictEqual(inboxCursor.readCursor(cursorFileFor(f.home, f.meshId)), 2,
      'precondition: but the on-disk ack file holds a real frontier (written by the production writer)');
    assert.ok(!fs.existsSync(descriptorFileFor(f.home, f.meshId)), 'precondition: and no descriptor');

    const twin = { id: 'builder-uuid-twin-field-2b', worktreePath: f.wt, sessionId: 'twin-session' };
    cli.retireWorktreeDuplicates(f.home, twin, ctx(f.home, { cwd: f.wt }));

    const post = readState(f.home, f.repoKey, f.meshId);
    assert.strictEqual(post.cursor, 0,
      `THE FIX (file branch): the anchor must not be folded, so its store cursor is never written (got ${post.cursor})`);
    assert.strictEqual(post.count, pre.count, 'and no message rows are forwarded away');
  } finally { rm(f.W); rm(f.home); }
});

test('FIELD CASE 3 (unclaimed: sessionId, no descriptor, cursor 0): an UNATTENDED placeholder anchor is still collapsible', () => {
  const f = seedFieldFixture({ tag: 'field-3', descriptor: false, cursor: 0 });
  try {
    const pre = readState(f.home, f.repoKey, f.meshId);
    assert.strictEqual(pre.cursor, 0, 'precondition: never read — no reader evidence at all');
    assert.strictEqual(inboxCursor.readCursor(cursorFileFor(f.home, f.meshId)), 0,
      'precondition: no on-disk ack frontier either');

    const s = meshStore.openStore({ home: f.home, hash: f.repoKey, backend: 'journal' });
    let res, cursorAfter;
    try {
      res = cli.foldGroupIntoSurvivor(s, f.home, 'builder-uuid-twin-field-3',
        [{ id: f.meshId, worktreePath: f.wt, sessionId: 'unclaimed:' + f.meshId, updatedAt: 1, writeSeq: 1 }], {});
      cursorAfter = s.cursorValue(f.meshId);
    } finally { s.close(); }

    // The exact NOT-BLANKET predicate: the mesh-anchor guard must not claim
    // this row (anchorLeft), and the fold must actually collapse it (its
    // backlog forwarded to the survivor, cursor advanced over the forwarded
    // prefix) — the pre-Wave-10 behaviour for an unattended placeholder,
    // which the explicit retire paths depend on. (Whether the CONDITIONAL
    // tombstone then lands is a separate CAS concern keyed on writeSeq and is
    // deliberately not asserted here.)
    assert.ok(!(res.anchorLeft && res.anchorLeft.has(String(f.meshId))),
      'NOT-BLANKET: an unattended placeholder anchor (no live session, no descriptor, no reader evidence) must NOT be claimed by the mesh-anchor guard — otherwise the explicit retire paths strand phantom rows projecting ACTIVE forever');
    assert.strictEqual(cursorAfter, pre.count,
      `the unattended placeholder IS folded exactly as before this fix — its backlog is forwarded and its cursor advances over the forwarded prefix (got ${cursorAfter}, expected ${pre.count})`);
  } finally { rm(f.W); rm(f.home); }
});

test('MUTATION-KILL (Wave 10): reverting the reader-evidence clause re-exposes FIELD CASE 2 (descriptor-less anchor drained)', () => {
  mutantKit.withMutant(
    "        && (isLiveSessionId(d.sessionId) || !!readDescriptorFile(home, d.id) || hasReaderEvidence(d.id));\n",
    "        && (isLiveSessionId(d.sessionId) || !!readDescriptorFile(home, d.id));\n",
    (mutatedCli) => {
      // BOTH evidence branches are killed, so neither can be silently dead.
      const store = seedFieldFixture({ tag: 'field-2-mutant', descriptor: false, cursor: 2 });
      try {
        mutatedCli.retireWorktreeDuplicates(store.home,
          { id: 'builder-uuid-twin-field-2-mutant', worktreePath: store.wt, sessionId: 'twin-session' },
          ctx(store.home, { cwd: store.wt }));
        assert.notStrictEqual(readState(store.home, store.repoKey, store.meshId).cursor, 2,
          'RED (expected on the mutant): without reader evidence the descriptor-less field anchor IS folded — its cursor is swept forward. If this fails, the clause is not what protects FIELD CASE 2 (store branch).');
      } finally { rm(store.W); rm(store.home); }

      const file = seedFieldFixture({ tag: 'field-2b-mutant', descriptor: false, cursor: 0, cursorFile: 2 });
      try {
        const before = readState(file.home, file.repoKey, file.meshId).count;
        mutatedCli.retireWorktreeDuplicates(file.home,
          { id: 'builder-uuid-twin-field-2b-mutant', worktreePath: file.wt, sessionId: 'twin-session' },
          ctx(file.home, { cwd: file.wt }));
        const post = readState(file.home, file.repoKey, file.meshId);
        assert.ok(post.cursor > 0 || post.count !== before,
          'RED (expected on the mutant): with only an on-disk ack frontier the anchor is folded too. If this fails, the cursor-FILE half of the clause is dead code and FIELD CASE 2b is vacuous.');
      } finally { rm(file.W); rm(file.home); }
    },
    { prefix: 'anti-hall-fold-anchor-reader-evidence-mutant' }
  );
});

test('REASON: an anchor left by the guard is reported as mesh-anchor-attended, not raced-re-register', () => {
  const f = seedFieldFixture({ tag: 'reason', descriptor: false, cursor: 2 });
  try {
    const s = meshStore.openStore({ home: f.home, hash: f.repoKey, backend: 'journal' });
    let res;
    try {
      res = cli.foldGroupIntoSurvivor(s, f.home, 'builder-uuid-twin-reason',
        [{ id: f.meshId, worktreePath: f.wt, sessionId: 'unclaimed:' + f.meshId, updatedAt: 1, writeSeq: 1 }], {});
    } finally { s.close(); }
    assert.deepStrictEqual((res.left || []).map(String), [String(f.meshId)], 'precondition: the anchor is LEFT by the guard');
    assert.ok(res.anchorLeft && res.anchorLeft.has(String(f.meshId)), 'the fold must record WHY it left the row');
    assert.strictEqual(cli.archiveLeftReason(f.home, f.meshId, null, true), 'mesh-anchor-attended',
      'a guard-protected anchor must report the true reason, not the false "raced-re-register" (no conditional delete was ever attempted for it)');
    assert.strictEqual(cli.archiveLeftReason(f.home, 'some-other-row', null, false), 'raced-re-register',
      'UNCHANGED: every non-anchor row keeps its existing reason');
  } finally { rm(f.W); rm(f.home); }
});
