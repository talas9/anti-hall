'use strict';
// Wave 9 (b) — SELF-TWIN PERPETUAL RE-DELIVERY (P1).
//
// ROOT CAUSE (traced, code-level):
//   `siblingAckGate` (scripts/devswarm.js) short-circuits with `return true`
//   (== skip the cursor write) when `partId`'s row is a CROSS-LINKED IDENTITY
//   TWIN of the CALLER's own row, on the stated theory that "the caller's own
//   read/ack path (cursorPath / s.setCursor for callerId) already governs it".
//   That theory is FALSE. The own-store ack writes exactly TWO cursors, both
//   keyed on the caller's OWN id:
//       inboxCursor.ackTo(cursorPath, ownTarget)   // primaryCursorPath(home, id)
//       s.setCursor(id, acked)                     // store cursor for `id`
//   The twin partition has its own separate cursor pair
//   (`primaryCursorPath(home, twinId)` / `s.setCursor(twinId, …)`), which NO
//   code path on this read ever touches. Meanwhile the twin's unread rows ARE
//   folded into `messages` and delivered on every single call
//   (meshSiblingPartitions is built before the gate; the gate governs the
//   cursor WRITE only). Net effect: the same rows are re-delivered forever and
//   the twin's cursor stays pinned at its pre-read value.
//
// FIX: a SELF twin is not a foreign sibling to be protected — it is the
// caller's OWN other identity, so the caller ACKS it, using the SAME
// ack-target arithmetic every other sibling partition uses (part.cursor +
// physicalConsumed, derived from rows actually delivered). Loss-free by the
// same construction: the target is computed FROM what was delivered.
//
// This test is RED on the pre-fix source (row re-delivered on call #2, twin
// cursor still 0) and GREEN after.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const livenessLib = require('../../plugins/anti-hall/companion/lib/liveness.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wave9-selftwin-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wave9-selftwin-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function register(home, repoDir, id, sessionId) {
  const inboxPath = path.join(home, 'descriptor-inboxes', id + '.ndjson');
  const cursorPath = path.join(home, 'descriptor-cursors', id + '.cursor');
  const r = cli.run(
    ['register', id, '--worktree', repoDir, '--session', sessionId || ('s-' + id), '--inbox', inboxPath, '--cursor', cursorPath],
    ctx(home, { cwd: repoDir })
  );
  assert.equal(r.result.ok, true, 'register failed: ' + JSON.stringify(r.result));
}
// See devswarm-cursor-integrity-A-C.test.js's own registerDirect header: a
// plain `register` for BOTH rows would let cmdRegister's retireWorktreeDuplicates
// tombstone the twin (its sessionId is an isStaleCrossReference) before the ack
// gate is ever reached, so identity-family fixtures insert the twin directly.
function registerDirect(home, repoDir, id, sessionId) {
  const repoKey = repokey.repoKeyForWorktree(repoDir);
  const inboxPath = path.join(home, 'descriptor-inboxes', id + '.ndjson');
  const cursorPath = path.join(home, 'descriptor-cursors', id + '.cursor');
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    const ok = s.upsertRegistry({ id, worktreePath: repoDir, sessionId, inboxPath, cursorPath });
    assert.notEqual(ok, false, 'upsertRegistry refused for ' + id);
  } finally { s.close(); }
}
function seedPartition(home, repoDir, toId, rows) {
  const repoKey = repokey.repoKeyForWorktree(repoDir);
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    for (const row of rows) {
      const fields = { from: row.from || 'sender', to: toId, type: 'direct', urgency: 'normal', message: row.body, timestamp: row.ts };
      storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash: storeLib.meshMessageHash(fields) }));
    }
  } finally { s.close(); }
}
function cursorOf(home, repoDir, id) {
  const repoKey = repokey.repoKeyForWorktree(repoDir);
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try { return s.cursorValue(id); } finally { s.close(); }
}
function markLive(home, id) {
  const p = livenessLib.heartbeatPathFor(id, home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ id, ts: Date.now() }));
}

// Builds the field shape: CALLER's registry sessionId IS the twin's id
// (crossLinkedIdentity), the twin itself is a register-only phantom that never
// heartbeats under its own id, and the twin holds unread mail.
function selfTwinFixture(tag) {
  const home = tmpHome();
  const repo = makeGitRepo(tag);
  register(home, repo, 'caller-primary', 'twin-uuid');
  registerDirect(home, repo, 'twin-uuid', 'unclaimed:twin-uuid');
  markLive(home, 'caller-primary');
  seedPartition(home, repo, 'twin-uuid', [{ body: 'twin-row-1', ts: 2000 }, { body: 'twin-row-2', ts: 2001 }]);
  return { home, repo };
}

test('(b) SELF twin: the caller ACKS its own identity twin\'s partition — the same rows are not re-delivered forever', () => {
  const { home, repo } = selfTwinFixture('ack');
  try {
    assert.equal(cursorOf(home, repo, 'twin-uuid'), 0, 'precondition: the twin partition is unread');

    const r1 = cli.run(['inbox', 'read-primary', 'caller-primary', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r1.result.ok, true, JSON.stringify(r1.result));
    const got1 = r1.result.messages.filter((m) => m.body && m.body.startsWith('twin-row-')).map((m) => m.body);
    assert.deepEqual(got1, ['twin-row-1', 'twin-row-2'], 'call #1 delivers the twin\'s unread mail (delivery is unchanged by this fix)');

    // THE FIX: the twin partition's OWN cursor advanced to exactly what was
    // delivered — the caller is the twin, so the caller's read consumed it.
    assert.equal(cursorOf(home, repo, 'twin-uuid'), 2,
      'THE FIX: the SELF twin\'s cursor must advance to the delivered prefix; pre-fix it stayed 0 and the rows re-delivered forever');

    // RED marker: pre-fix, call #2 hands back the identical rows.
    const r2 = cli.run(['inbox', 'read-primary', 'caller-primary', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r2.result.ok, true, JSON.stringify(r2.result));
    const got2 = r2.result.messages.filter((m) => m.body && m.body.startsWith('twin-row-')).map((m) => m.body);
    assert.deepEqual(got2, [], 'call #2 must deliver NOTHING new — pre-fix it re-delivered twin-row-1/twin-row-2 on every call, forever');
  } finally { rm(home); rm(repo); }
});

test('(b) SELF twin ack is LOSS-FREE: mail that arrives after the ack is still delivered', () => {
  const { home, repo } = selfTwinFixture('lossfree');
  try {
    cli.run(['inbox', 'read-primary', 'caller-primary', '--ack-as-owner'], ctx(home, { cwd: repo }));
    seedPartition(home, repo, 'twin-uuid', [{ body: 'twin-row-3', ts: 3000 }]);
    const r = cli.run(['inbox', 'read-primary', 'caller-primary', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    const got = r.result.messages.filter((m) => m.body && m.body.startsWith('twin-row-')).map((m) => m.body);
    assert.deepEqual(got, ['twin-row-3'], 'a NEW row on the twin partition is still delivered after the ack — the ack advances, it never skips ahead');
    assert.equal(cursorOf(home, repo, 'twin-uuid'), 3, 'and the cursor tracks it exactly');
  } finally { rm(home); rm(repo); }
});

test('(b) a FOREIGN live sibling is still never ack-drained (the self-twin fix does not widen the gate)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('foreign');
  try {
    register(home, repo, 'caller-f');
    markLive(home, 'caller-f');
    // A different agent entirely — no cross-link with the caller — and LIVE.
    register(home, repo, 'foreign-f');
    markLive(home, 'foreign-f');
    seedPartition(home, repo, 'foreign-f', [{ body: 'foreign-row', ts: 2000 }]);

    const r = cli.run(['inbox', 'read-primary', 'caller-f', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(cursorOf(home, repo, 'foreign-f'), 0,
      'a LIVE foreign sibling\'s cursor is still never advanced by another caller\'s read');
    assert.ok((r.result.liveSiblingsSkipped || []).includes('foreign-f'), 'and the skip is still observable');
  } finally { rm(home); rm(repo); }
});

// -----------------------------------------------------------------------
// WAVE 10 — the SELF twin × NEVER_READ_SIBLING_CAP interaction.
//
// The two Wave 9 fixes meet here: a SELF twin is ACKABLE (fix (b) above),
// so the cap must hand it the structural PREFIX (fix (c)) and the ack must
// land on exactly that prefix — `part.cursor + physicalConsumed`, never the
// partition's raw total. Getting this wrong in either direction is silent
// mail loss: an ack at the raw total marks the 50 withheld rows read and
// they are never delivered; no ack at all re-delivers the same 200 forever
// (the exact (b) bug, just at cap scale).
// -----------------------------------------------------------------------
function rowsFor(n, from) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ body: 'twin-row-' + ((from || 0) + i), ts: 2000 + (from || 0) + i });
  return out;
}
const twinBodies = (r) => r.result.messages.filter((m) => m.body && m.body.startsWith('twin-row-')).map((m) => m.body);

test('(b+c) WAVE 10: a CAPPED self-twin backlog acks to exactly the delivered prefix (pCursor + CAP), not the raw total', () => {
  const home = tmpHome();
  const repo = makeGitRepo('capped-selftwin');
  try {
    register(home, repo, 'caller-primary', 'twin-uuid');
    registerDirect(home, repo, 'twin-uuid', 'unclaimed:twin-uuid');
    markLive(home, 'caller-primary');
    const CAP = 200; // NEVER_READ_SIBLING_CAP (scripts/devswarm.js)
    seedPartition(home, repo, 'twin-uuid', rowsFor(250));
    assert.equal(cursorOf(home, repo, 'twin-uuid'), 0, 'precondition: the twin partition is unread');

    const r1 = cli.run(['inbox', 'read-primary', 'caller-primary', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r1.result.ok, true, JSON.stringify(r1.result));
    const got1 = twinBodies(r1);
    assert.equal(got1.length, CAP, 'the self-twin backlog is capped like any other sibling partition');
    // An ACKABLE partition keeps the structural PREFIX — the ack arithmetic
    // depends on it (a tail would make part.cursor + n meaningless).
    assert.ok(got1.includes('twin-row-0') && got1.includes('twin-row-199'),
      'an ACKABLE self twin gets the PREFIX, so the withheld rows are the newest end');
    assert.ok(!got1.includes('twin-row-249'), 'and the newest rows are what was withheld this call');

    assert.equal(cursorOf(home, repo, 'twin-uuid'), 0 + CAP,
      'THE INVARIANT: the twin\'s cursor lands on pCursor + CAP — the DELIVERED prefix — never the raw total (250), which would mark the 50 withheld rows read and lose them');

    // And a second read makes real forward progress over the withheld slice.
    const r2 = cli.run(['inbox', 'read-primary', 'caller-primary', '--ack-as-owner'], ctx(home, { cwd: repo }));
    const got2 = twinBodies(r2);
    assert.equal(got2.length, 50, 'the next read delivers exactly the withheld remainder (250 - 200)');
    assert.ok(got2.includes('twin-row-200') && got2.includes('twin-row-249'),
      'and it is the slice that follows the acked prefix — nothing skipped, nothing repeated');
    assert.deepEqual(got2.filter((b) => got1.includes(b)), [], 'no row is delivered twice across the two calls');
    assert.equal(cursorOf(home, repo, 'twin-uuid'), 250, 'the whole backlog is drained after the second call');
  } finally { rm(home); rm(repo); }
});
