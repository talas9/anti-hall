'use strict';
// Regression tests for an adversarial review of the mesh/channel union read
// path added in cmdInboxMessages (scripts/devswarm.js, defect dca4d2e16926 +
// the ASYMMETRIC PARTITION RESOLUTION fix — see tests/scripts/
// devswarm-primary-mesh-union.test.js and devswarm-primary-union.test.js for
// the original fixes these harden).
//
// P0 (message loss): the sibling-partition fold used to dedup on a WEAK
// content key (sender, ts, body). Two GENUINELY DISTINCT messages — real,
// separate `send`s to two different sibling partitions — that merely happen
// to share sender+ts+body collapsed into one, and the ack loop then advanced
// BOTH partitions' cursors past the suppressed twin, losing it permanently.
// Investigated identity: `hash` (meshMessageHash) hashes `to` (the
// recipient/partition) too, and carries a store-WIDE UNIQUE(hash) constraint
// across every partition — so two rows in different partitions can NEVER
// share a hash, and no stronger cross-partition identity exists in the
// schema. Fix: stop suppressing cross-partition rows at all (deliver both);
// keep a defensive hash-based guard that cannot fire in practice, and derive
// each partition's cursor-ack target from what was ACTUALLY delivered
// (structural invariant), never from its raw total.
//
// P1a (cursor persistence swallowed): a sibling or NDJSON cursor write
// failure used to be silently caught and dropped — `ok:true` gave no signal
// that the ack didn't durably persist (messages then simply redeliver next
// read, which is the safe direction, but the caller had no way to know).
//
// P1b (registry enumeration failure narrows the group silently): the
// mesh-group resolution's catch-all used to fall back to `[id]` on ANY
// thrown error with no visible signal, indistinguishable from "this
// worktree genuinely has no sibling rows" — so a caller saw ok:true and a
// total that LOOKED complete while sibling mail was actually omitted.

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-mesh-review-fix-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-mesh-review-fix-repo-' + tag + '-'));
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

// ---- P0: two DISTINCT messages sharing (sender, ts, body) across siblings --

test('P0: two genuinely distinct messages sharing sender+ts+body across sibling partitions are BOTH delivered (never lost)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('p0-distinct');
  try {
    register(home, repo, 'primary-p0', undefined);
    register(home, repo, 'sibling-p0', undefined, 'unclaimed:sibling-p0');

    // Two REAL, SEPARATE sends — different `to`, hence different `hash` —
    // that happen to carry identical sender/ts/body. Pre-fix, the weak
    // (sender, ts, body) content-key collapsed these into one and silently
    // discarded the second.
    seedPartition(home, repo, 'primary-p0', [{ body: 'collision content', ts: 5000, from: 'agentA' }]);
    seedPartition(home, repo, 'sibling-p0', [{ body: 'collision content', ts: 5000, from: 'agentA' }]);

    const rp = cli.run(['inbox', 'read-primary', 'primary-p0', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(rp.result.ok, true, JSON.stringify(rp.result));
    assert.equal(rp.result.count, 2, 'BOTH distinct messages must be delivered — neither is provably a duplicate of the other');
    assert.equal(rp.result.messages.filter((m) => m.body === 'collision content').length, 2,
      'both copies present, not collapsed to one');

    // Both partitions' cursors fully advanced (both were actually delivered).
    const rp2 = cli.run(['inbox', 'read-primary', 'primary-p0', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(rp2.result.count, 0, 'nothing left unread — both messages were genuinely delivered and acked, not silently dropped');
  } finally { rm(home); rm(repo); }
});

// ---- P0 invariant: a partition's cursor never advances past what was NOT
// actually returned to the caller. Exercised via the structural derivation
// (ack target = part.cursor + deliveredCount, not part.total) using a
// sibling that already has SOME prior unread history acked before this call
// — proving the ack target tracks exactly what THIS call delivered, not a
// blind "whatever the partition's raw total happens to be".

test('P0 invariant: sibling cursor advances by exactly what THIS call delivered, never blindly to the partition raw total', () => {
  const home = tmpHome();
  const repo = makeGitRepo('p0-invariant');
  try {
    register(home, repo, 'primary-inv', undefined);
    register(home, repo, 'sibling-inv', undefined, 'unclaimed:sibling-inv');

    seedPartition(home, repo, 'sibling-inv', [{ body: 'sib-1', ts: 1000 }]);
    // First ack: consumes sibling-inv's one existing message.
    const first = cli.run(['inbox', 'read-primary', 'primary-inv', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(first.result.ok, true, JSON.stringify(first.result));
    const sibCursorPath = cli.primaryCursorPath(home, 'sibling-inv');
    assert.equal(fs.readFileSync(sibCursorPath, 'utf8').trim(), '1');

    // More mail lands on the sibling AFTER that ack.
    seedPartition(home, repo, 'sibling-inv', [{ body: 'sib-2', ts: 2000 }, { body: 'sib-3', ts: 3000 }]);

    const second = cli.run(['inbox', 'read-primary', 'primary-inv', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(second.result.ok, true, JSON.stringify(second.result));
    assert.equal(second.result.count, 2, 'only the NEW sibling mail is delivered this call');
    // Cursor invariant: cursor lands at exactly cursor(1) + delivered(2) = 3
    // — the same value as the sibling's raw total here, but DERIVED from
    // what this call actually returned, not read blindly off messageCount.
    assert.equal(fs.readFileSync(sibCursorPath, 'utf8').trim(), '3');
  } finally { rm(home); rm(repo); }
});

// ---- P1a: a sibling cursor-write failure is reported, not swallowed -------

test('P1a: a sibling cursor-write failure still delivers the message AND names the failed partition/channel in the result', () => {
  const home = tmpHome();
  const repo = makeGitRepo('p1a');
  try {
    register(home, repo, 'primary-p1a', undefined);
    register(home, repo, 'sibling-p1a', undefined, 'unclaimed:sibling-p1a');
    seedPartition(home, repo, 'sibling-p1a', [{ body: 'undeliverable-cursor mail', ts: 1000 }]);

    // Force the sibling's cursor WRITE to fail: pre-create its cursor path
    // as a DIRECTORY so writeCursorAtomic's rename(tmp, cursorPath) throws
    // (EISDIR/ENOTDIR) — an unwritable-path failure, without touching the
    // shared `cursors/` directory (which would also break `id`'s own ack).
    const sibCursorPath = cli.primaryCursorPath(home, 'sibling-p1a');
    fs.mkdirSync(sibCursorPath, { recursive: true });

    const rp = cli.run(['inbox', 'read-primary', 'primary-p1a', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(rp.result.ok, true, JSON.stringify(rp.result));
    assert.equal(rp.result.count, 1, 'delivery still succeeds (fail-open on delivery — the safe direction)');
    assert.equal(rp.result.cursorPersisted, false, 'the result must honestly report that a cursor did not persist');
    assert.ok(Array.isArray(rp.result.cursorWriteFailures) && rp.result.cursorWriteFailures.length >= 1,
      'cursorWriteFailures must be present');
    const failure = rp.result.cursorWriteFailures.find((f) => f.partitionId === 'sibling-p1a');
    assert.ok(failure, 'the failure must name the exact partition that failed to persist: ' + JSON.stringify(rp.result.cursorWriteFailures));
    assert.equal(failure.channel, 'sibling-store-cursor');
    assert.ok(failure.error && typeof failure.error === 'string' && failure.error.length > 0, 'a reason must be attached');

    // Redelivery proof: since the cursor never persisted, the same message
    // resurfaces on the next read — the safe (at-least-once) direction.
    const rp2 = cli.run(['inbox', 'read-primary', 'primary-p1a', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(rp2.result.ok, true, JSON.stringify(rp2.result));
    assert.equal(rp2.result.count, 1, 'the message the failed cursor never marked read must redeliver, never vanish');
  } finally { rm(home); rm(repo); }
});

// ---- P1b: registry/group enumeration failure is surfaced, not silent -----

test('P1b: a thrown registry-enumeration error surfaces as an unresolved/partial group, not a silently-narrowed complete-looking read', () => {
  const home = tmpHome();
  const repo = makeGitRepo('p1b');
  try {
    register(home, repo, 'primary-p1b', undefined);
    register(home, repo, 'sibling-p1b', undefined);
    seedPartition(home, repo, 'primary-p1b', [{ body: 'own-partition mail', ts: 1000 }]);
    seedPartition(home, repo, 'sibling-p1b', [{ body: 'sibling mail that cannot be enumerated this call', ts: 2000 }]);

    // meshCandidateRows(storeHandle, meshId) calls storeHandle.listRegistry()
    // directly and unguarded (only each ROW's own canonicalMeshId resolution
    // is individually try/caught inside it) — simulate a genuine
    // enumeration failure (e.g. a corrupt/unreadable registry read) by
    // making listRegistry() throw on its SECOND call within this read (the
    // first call is cmdInboxMessages' own selfRow lookup, which must
    // succeed for the read to even get this far; the second is the one
    // meshCandidateRows makes to build the sibling group).
    const realOpenStore = storeLib.openStore;
    storeLib.openStore = function (opts) {
      const s = realOpenStore(opts);
      const realListRegistry = s.listRegistry;
      let calls = 0;
      s.listRegistry = function () {
        calls += 1;
        if (calls === 2) throw new Error('simulated registry enumeration failure');
        return realListRegistry.apply(s, arguments);
      };
      return s;
    };
    let rp;
    try {
      rp = cli.run(['inbox', 'read-primary', 'primary-p1b', '--ack-as-owner'], ctx(home, { cwd: repo }));
    } finally {
      storeLib.openStore = realOpenStore;
    }

    assert.equal(rp.result.ok, true, JSON.stringify(rp.result));
    assert.equal(rp.result.count, 1, 'delivery falls back to the single-partition read (fail-open FALLBACK, still correct as a fallback)');
    assert.equal(rp.result.messages[0].body, 'own-partition mail');
    // The surfacing this fix adds:
    assert.equal(rp.result.meshGroupUnresolved, true, 'the result must say the group could not be fully resolved');
    assert.ok(typeof rp.result.meshGroupError === 'string' && rp.result.meshGroupError.length > 0, 'a reason must be attached');
    assert.equal(rp.result.totalsPartial, true, 'total/unreadCount must not be presented as a complete read when enumeration failed');
  } finally { rm(home); rm(repo); }
});

// ---- P1b (negative control): no siblings exist is fine, silent -----------

test('P1b (negative control): a genuinely single-row Primary (no siblings, no error) never sets meshGroupUnresolved/totalsPartial', () => {
  const home = tmpHome();
  const repo = makeGitRepo('p1b-solo');
  try {
    register(home, repo, 'solo-p1b', undefined);
    seedPartition(home, repo, 'solo-p1b', [{ body: 'solo mail', ts: 1000 }]);

    const rp = cli.run(['inbox', 'read-primary', 'solo-p1b', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(rp.result.ok, true, JSON.stringify(rp.result));
    assert.equal(rp.result.count, 1);
    assert.equal(rp.result.meshGroupUnresolved, false, '"no siblings exist" must stay a silent, non-error fallback');
    assert.equal(rp.result.totalsPartial, false);
  } finally { rm(home); rm(repo); }
});
