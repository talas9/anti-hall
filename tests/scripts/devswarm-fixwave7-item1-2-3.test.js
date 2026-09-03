'use strict';
// Fix Wave 7 — three P0 holes reported against the Fix Wave 6 live-sibling
// ack gate, each independently reproduced:
//
// ITEM 1 — `inbox ack` (and its `--ack-as-owner` variant) drives its OWN
// mesh-sibling cursor-write loop (scripts/devswarm.js, the `sub === 'ack'`
// branch of the count/read/ack handler), separate from
// `cmdInboxMessages`'s read-primary/peek-primary ack loop. Wave 6 gated only
// the latter — `inbox ack`'s loop had NO liveness check at all, so a plain
// `inbox ack <sibling-id>` from a shared canonical worktree could drive a
// DIFFERENT, still-live sibling's cursor forward and consume its backlog
// undelivered, even with BOTH heartbeats fresh.
//
// ITEM 2 — the gate (in either loop) used to ack a sibling on ABSENCE of a
// fresh heartbeat, not on POSITIVE evidence of death. A genuinely live child
// that has not yet completed its first turn (`register` writes no heartbeat
// file at all) was misread as orphaned and had its backlog silently
// consumed. Fixed by `isSiblingPartitionLive` (companion/lib/liveness.js):
// live iff a fresh heartbeat exists, OR the sibling has a REAL (non-
// `unclaimed:`) sessionId whose own activity (heartbeat/transcript,
// `isDormantRow`) is not POSITIVELY stale — `isDormantRow` is itself
// fail-open (no signal at all -> not dormant), so "never heartbeated" now
// reads as live, not dead. Only a register-only phantom (`unclaimed:`
// sessionId, the legitimate cross-drain/orphan case) or a REAL session with
// positively-stale activity reads as dead.
//
// ITEM 3 — `inbox ack`'s STORE-side ack-all recounted the LIVE store table
// at ack time (`storeHandle.messageCount(id)`) rather than acking the READ
// snapshot this call actually delivered — the same message-loss shape Fix
// Wave 5 Item 2 already closed on the NDJSON side. A store row arriving
// between the read snapshot and the ack was silently consumed, never
// delivered. Fixed by deriving the ack target from the delivered rows' own
// `.index` (captured at read time), the same primitive
// cmdInboxMessages's own-store ack already uses.
//
// Every mutation in this file targets ONLY the ONE mutable scratch copy of
// scripts/devswarm.js devswarm-mutant-kit.js creates per test (see that
// file's own header for why the live file is never touched) — companion/
// and hooks/ are read-only SYMLINKS into the scratch dir for module-identity
// reasons, so a mutant here never targets companion/lib/liveness.js
// directly; Item 2's mutant instead targets `siblingAckGate`'s own call into
// `isSiblingPartitionLive` (scripts/devswarm.js), which is enough to
// reproduce the exact regression (both mesh-sibling ack loops share this one
// function) without ever writing to a live companion/ file.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const DEVSWARM_PATH = path.join(__dirname, '../../plugins/anti-hall/scripts/devswarm.js');
const cli = require(DEVSWARM_PATH);
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const livenessLib = require('../../plugins/anti-hall/companion/lib/liveness.js');
const mutantKit = require('./lib/devswarm-mutant-kit.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fixwave7-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fixwave7-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

// `sessionId` defaults to a well-formed real session; pass an
// `unclaimed:`-prefixed one explicitly to model a genuine register-only
// phantom (never claimed by a real session) — see this file's header.
function register(home, repoDir, id, sessionId) {
  const inboxPath = path.join(home, 'descriptor-inboxes', id + '.ndjson');
  const cursorPath = path.join(home, 'descriptor-cursors', id + '.cursor');
  const r = cli.run(
    ['register', id, '--worktree', repoDir, '--session', sessionId || ('s-' + id), '--inbox', inboxPath, '--cursor', cursorPath],
    ctx(home, { cwd: repoDir })
  );
  assert.equal(r.result.ok, true, 'register failed: ' + JSON.stringify(r.result));
  return { inboxPath, cursorPath };
}

function seedPartition(home, repoDir, toId, rows) {
  const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
  const repoKey = repokey.repoKeyForWorktree(repoDir);
  assert.ok(repoKey, 'repoKey must resolve for a real git repo');
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    for (const row of rows) {
      const fields = { from: row.from || 'sender', to: toId, type: 'direct', urgency: row.urgency || 'normal', message: row.body, timestamp: row.ts };
      const hash = row.hash || storeLib.meshMessageHash(fields);
      storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash }));
    }
  } finally { s.close(); }
  return repoKey;
}

function readCursorFile(home, repo, id) {
  const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
  const repoKey = repokey.repoKeyForWorktree(repo);
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try { return s.cursorValue(id); } finally { s.close(); }
}

function writeHeartbeatFile(home, id, ts) {
  const p = livenessLib.heartbeatPathFor(id, home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ id, ts }));
}
function markSiblingLive(home, id, now) {
  writeHeartbeatFile(home, id, now || Date.now());
}

function withMutant(oldStr, newStr, fn) {
  const liveBefore = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  mutantKit.withMutant(oldStr, newStr, fn, { prefix: 'anti-hall-fixwave7' });
  mutantKit.assertLiveUntouched(liveBefore, assert);
}

// ---------------------------------------------------------------------------
// ITEM 1 — `inbox ack`'s OWN sibling loop had no liveness gate at all
// ---------------------------------------------------------------------------

test('Item 1 RED/GREEN: a plain `inbox ack <sibling>` must not clobber a DIFFERENT live sibling\'s cursor', () => {
  const home = tmpHome();
  const repo = makeGitRepo('item1');
  try {
    register(home, repo, 'p-item1');
    register(home, repo, 'sib-item1');
    markSiblingLive(home, 'p-item1'); // BOTH heartbeats fresh — the exact reported repro shape
    markSiblingLive(home, 'sib-item1');
    seedPartition(home, repo, 'p-item1', [{ body: 'p-own-row', ts: 2000 }]);

    const before = readCursorFile(home, repo, 'p-item1');
    assert.equal(before, 0, 'sanity: p starts unread');

    // Plain `inbox ack sib-item1` — NOT read-primary, no --ack-as-owner.
    const r = cli.run(['inbox', 'ack', 'sib-item1'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));

    const after = readCursorFile(home, repo, 'p-item1');
    assert.equal(after, 0, 'THE FIX: a live sibling\'s cursor must be UNCHANGED by `inbox ack` on a DIFFERENT partition in the same mesh group');
    assert.deepEqual(r.result.liveSiblingsSkipped, ['p-item1'], 'the skip must be observable, not silent');

    // p's own backlog must still be fully there.
    const ownRead = cli.run(['inbox', 'read-primary', 'p-item1', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.deepEqual(ownRead.result.messages.map((m) => m.body), ['p-own-row'], 'p\'s own backlog must still be intact — nothing silently consumed out from under it');
  } finally { rm(home); rm(repo); }
});

test('Item 1 mutation check: deleting `inbox ack`\'s sibling-loop gate reproduces the cross-partition clobber', () => {
  const oldStr = "              if (siblingAckGate(storeHandle, part.id, home, ctx.now)) { liveSiblingsSkipped.push(part.id); continue; }\n";
  const liveBefore = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  assert.ok(liveBefore.includes(oldStr), 'inbox ack sibling-loop gate not found verbatim');
  withMutant(oldStr, '', (mutatedCli) => {
    const home = tmpHome();
    const repo = makeGitRepo('item1-mutant');
    try {
      register(home, repo, 'p-item1m');
      register(home, repo, 'sib-item1m');
      markSiblingLive(home, 'p-item1m');
      markSiblingLive(home, 'sib-item1m');
      seedPartition(home, repo, 'p-item1m', [{ body: 'p-own-row', ts: 2000 }]);
      mutatedCli.run(['inbox', 'ack', 'sib-item1m'], ctx(home, { cwd: repo }));
      const after = readCursorFile(home, repo, 'p-item1m');
      assert.notEqual(after, 0, 'BUGGY (gate deleted): p\'s cursor IS clobbered by a plain `inbox ack` on a different partition — reproduces the P0');
    } finally { rm(home); rm(repo); }
  });
});

// ---------------------------------------------------------------------------
// ITEM 2 — the gate must ack on POSITIVE evidence of death, never on
// absence of a heartbeat alone
// ---------------------------------------------------------------------------

test('Item 2 RED/GREEN: a genuinely live but never-heartbeated sibling must not be acked; a genuinely orphaned one still is', () => {
  const home = tmpHome();
  const repo = makeGitRepo('item2');
  try {
    // never-heartbeated LIVE sibling: real (non-`unclaimed:`) session,
    // NO heartbeat file ever written (register alone never writes one).
    register(home, repo, 'p-item2');
    register(home, repo, 'live-sib-item2'); // real session, never heartbeated
    // genuinely orphaned sibling: register-only phantom.
    register(home, repo, 'orphan-sib-item2', 'unclaimed:orphan-sib-item2');
    seedPartition(home, repo, 'live-sib-item2', [{ body: 'live-sib-row', ts: 2000 }]);
    seedPartition(home, repo, 'orphan-sib-item2', [{ body: 'orphan-sib-row', ts: 3000 }]);

    const r = cli.run(['inbox', 'read-primary', 'p-item2', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));

    // Both messages are still DELIVERED (the gate only ever protects the
    // cursor write, never delivery).
    const bodies = r.result.messages.map((m) => m.body).sort();
    assert.deepEqual(bodies, ['live-sib-row', 'orphan-sib-row'], 'delivery must be unaffected by the gate either way');

    // THE FIX: the never-heartbeated but genuinely live sibling's cursor
    // must be UNTOUCHED — absence of a heartbeat is not evidence of death.
    assert.equal(readCursorFile(home, repo, 'live-sib-item2'), 0, 'THE FIX: a never-heartbeated live sibling must not be acked');
    assert.ok((r.result.liveSiblingsSkipped || []).includes('live-sib-item2'), 'the never-heartbeated sibling must be reported as skipped');

    // Constraint preserved: the genuinely orphaned sibling IS still
    // drainable — this is the legitimate cross-drain case the gate exists
    // to allow through.
    assert.equal(readCursorFile(home, repo, 'orphan-sib-item2'), 1, 'a genuinely orphaned (register-only phantom) sibling must still be ack-drained');
    assert.ok(!(r.result.liveSiblingsSkipped || []).includes('orphan-sib-item2'), 'the genuinely orphaned sibling must not be reported as skipped');
  } finally { rm(home); rm(repo); }
});

test('Item 2 mutation check: reverting the gate to hasFreshHeartbeat-only reproduces the never-heartbeated misread', () => {
  const oldStr = '    return isSiblingPartitionLive({ id: partId, worktreePath: row.worktreePath, sessionId: row.sessionId }, home, { now });\n';
  const liveBefore = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  assert.ok(liveBefore.includes(oldStr), 'siblingAckGate\'s isSiblingPartitionLive call not found verbatim');
  const buggyStr = '    let hb = false;\n'
    + '    try { hb = hasFreshHeartbeat(partId, home, { now }); } catch (_) { hb = true; }\n'
    + '    return hb;\n';
  withMutant(oldStr, buggyStr, (mutatedCli) => {
    const home = tmpHome();
    const repo = makeGitRepo('item2-mutant');
    try {
      register(home, repo, 'p-item2m');
      register(home, repo, 'live-sib-item2m'); // real session, never heartbeated
      seedPartition(home, repo, 'live-sib-item2m', [{ body: 'live-sib-row', ts: 2000 }]);
      mutatedCli.run(['inbox', 'read-primary', 'p-item2m', '--ack-as-owner'], ctx(home, { cwd: repo }));
      const after = readCursorFile(home, repo, 'live-sib-item2m');
      assert.notEqual(after, 0, 'BUGGY (hasFreshHeartbeat-only): the never-heartbeated LIVE sibling IS acked — reproduces the misread');
    } finally { rm(home); rm(repo); }
  });
});

// ---------------------------------------------------------------------------
// ITEM 3 — `inbox ack`'s store-side ack-all must ack the READ snapshot, not
// a live recount
// ---------------------------------------------------------------------------

// withRacingStoreRow: monkeypatches the shared devswarm-store.js module
// singleton's `openStore` (restored in a `finally`) so that the store
// handle's `listMessages(id, {sinceCursor})` call — the exact read that
// produces this call's own delivered snapshot for `id`'s own partition —
// has a NEW row appended to `id`'s store partition IMMEDIATELY AFTER it
// returns, simulating a concurrent sender's send landing strictly after the
// read snapshot and strictly before the ack write. Fires ONLY on the
// `sinceCursor`-scoped call (not the plain full-history call `unionUnread`
// also makes for `id`, which must not receive the race) and only once.
function withRacingStoreRow(id, racingRow, fn) {
  const realOpenStore = storeLib.openStore;
  let injected = false;
  storeLib.openStore = function (opts) {
    const s = realOpenStore(opts);
    const realListMessages = s.listMessages.bind(s);
    s.listMessages = function (pid, o) {
      const rows = realListMessages(pid, o);
      if (!injected && String(pid) === String(id) && o && Number.isFinite(o.sinceCursor)) {
        injected = true;
        const fields = { from: 'racer', to: id, type: 'direct', urgency: 'normal', message: racingRow.body, timestamp: racingRow.ts };
        const hash = racingRow.hash || storeLib.meshMessageHash(fields);
        storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash }));
      }
      return rows;
    };
    return s;
  };
  try {
    fn();
  } finally {
    storeLib.openStore = realOpenStore;
  }
}

test('Item 3 RED/GREEN: `inbox ack`\'s store-side ack-all must not consume a row that arrives between the read snapshot and the ack', () => {
  const home = tmpHome();
  const repo = makeGitRepo('item3');
  try {
    register(home, repo, 'id-item3');
    seedPartition(home, repo, 'id-item3', [{ body: 'seen-row', ts: 1000 }]);

    withRacingStoreRow('id-item3', { body: 'racing-row', ts: 5000 }, () => {
      const r = cli.run(['inbox', 'ack', 'id-item3'], ctx(home, { cwd: repo }));
      assert.equal(r.result.ok, true, JSON.stringify(r.result));
    });

    // THE FIX: the racing row must still be UNREAD — the ack must not have
    // advanced the cursor past it. `inbox messages` returns full history by
    // default (`unreadOnly` only when `--unread`/`--ack` is passed), so
    // assert on `count`'s cursor-derived fields, not raw message presence.
    const c1 = cli.run(['inbox', 'count', 'id-item3'], ctx(home, { cwd: repo }));
    assert.equal(c1.result.ok, true, JSON.stringify(c1.result));
    assert.equal(c1.result.unreadTotal, 1, 'THE FIX: the racing row must still read as unread — never silently consumed by the ack');

    // And it must still be delivered as genuinely unread on the next ack.
    const r2 = cli.run(['inbox', 'ack', 'id-item3'], ctx(home, { cwd: repo }));
    assert.equal(r2.result.ok, true, JSON.stringify(r2.result));
    const c2 = cli.run(['inbox', 'count', 'id-item3'], ctx(home, { cwd: repo }));
    assert.equal(c2.result.unreadTotal, 0, 'a SECOND ack (no new race) must finally consume it — the fix does not wedge it forever either');
  } finally { rm(home); rm(repo); }
});

test('Item 3 mutation check: reverting to a live `messageCount(id)` recount reproduces the race loss', () => {
  const oldStr = '            const ownDeliveredRows = ownRows.slice(0, ownKeptCount);\n'
    + '            let ownMaxIndex = null;\n'
    + '            for (const row of ownDeliveredRows) {\n'
    + '              if (row && Number.isFinite(row.index) && (ownMaxIndex === null || row.index > ownMaxIndex)) ownMaxIndex = row.index;\n'
    + '            }\n'
    + '            const totalNow = ownMaxIndex !== null ? Math.max(storeCursorVal, ownMaxIndex) : storeCursorVal;\n';
  const liveBefore = fs.readFileSync(DEVSWARM_PATH, 'utf8');
  assert.ok(liveBefore.includes(oldStr), 'Item 3 fix block not found verbatim');
  const buggyStr = '            const totalNow = storeHandle.messageCount(id);\n';
  withMutant(oldStr, buggyStr, (mutatedCli) => {
    const home = tmpHome();
    const repo = makeGitRepo('item3-mutant');
    try {
      register(home, repo, 'id-item3m');
      seedPartition(home, repo, 'id-item3m', [{ body: 'seen-row', ts: 1000 }]);
      withRacingStoreRow('id-item3m', { body: 'racing-row', ts: 5000 }, () => {
        mutatedCli.run(['inbox', 'ack', 'id-item3m'], ctx(home, { cwd: repo }));
      });
      const c = mutatedCli.run(['inbox', 'count', 'id-item3m'], ctx(home, { cwd: repo }));
      assert.equal(c.result.unreadTotal, 0, 'BUGGY (live recount): the racing row is silently consumed — never delivered, permanently lost');
    } finally { rm(home); rm(repo); }
  });
});
