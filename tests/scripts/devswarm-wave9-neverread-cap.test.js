'use strict';
// Wave 9 (c) — NEVER_READ_SIBLING_CAP × a partition the caller CANNOT ack (P1).
//
// ROOT CAUSE (traced, code-level): the cap was gated on `pCursor === 0` and
// always kept the OLDEST `NEVER_READ_SIBLING_CAP` rows (a structural PREFIX),
// on the invariant "the withheld tail stays reachable on the caller's NEXT
// call, because this call acks only what it delivered". That invariant holds
// only for a partition the caller actually ACKS. A LIVE foreign sibling is
// never acked at all (siblingAckGate, Fix Wave 6/7) — so its `pCursor` stays 0
// forever, the `pCursor === 0` gate re-fires on every call, and the caller is
// handed the SAME oldest 200 rows for the rest of time. Anything past row 200
// on such a partition is permanently invisible to `read-primary`, and no
// number of re-reads makes progress.
//
// Two further gaps in the same block:
//   - the `pCursor === 0` gate means call #2 on an ACKED partition is not
//     bounded at all (a partition read once, then left to accumulate 10k rows,
//     dumps all 10k) — the hazard is the BACKLOG SIZE, not the first read.
//   - the withheld rows were reported as a bare count with no way to reach
//     them, though `inbox messages <pid>` reads that partition directly.
//
// FIX: cap on backlog size (not first-read); for a partition this call cannot
// ack, keep the NEWEST rows (a tail) instead of a frozen prefix and hard-block
// any ack for it (a tail is safe there precisely BECAUSE no cursor moves);
// and emit `neverReadCapHint` naming the exact command that reads the rest.
// LOSS-FREE either way: a tail-capped partition's cursor is never advanced.

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wave9-cap-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wave9-cap-repo-' + tag + '-'));
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
function seedPartition(home, repoDir, toId, rows) {
  const repoKey = repokey.repoKeyForWorktree(repoDir);
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    for (const row of rows) {
      const fields = { from: 'sender', to: toId, type: 'direct', urgency: 'normal', message: row.body, timestamp: row.ts };
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
function rowsFor(n, from) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ body: 'row-' + ((from || 0) + i), ts: 1000 + (from || 0) + i });
  return out;
}
const bodies = (r) => r.result.messages.filter((m) => m.body && m.body.startsWith('row-')).map((m) => m.body);

test('(c) a LIVE (non-ackable) sibling is capped to its NEWEST rows, not frozen on the oldest 200 forever', () => {
  const home = tmpHome();
  const repo = makeGitRepo('nonackable');
  try {
    register(home, repo, 'caller-x');
    markLive(home, 'caller-x');
    register(home, repo, 'live-sib');
    markLive(home, 'live-sib'); // LIVE -> siblingAckGate always skips its ack
    seedPartition(home, repo, 'live-sib', rowsFor(250));

    const r1 = cli.run(['inbox', 'read-primary', 'caller-x', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r1.result.ok, true, JSON.stringify(r1.result));
    const got1 = bodies(r1);
    assert.equal(got1.length, 200, 'still bounded to NEVER_READ_SIBLING_CAP');
    assert.equal(cursorOf(home, repo, 'live-sib'), 0, 'LOSS-FREE: a live sibling\'s cursor is never advanced by this caller');

    // THE FIX: the newest rows are the ones delivered — the oldest 50 are the
    // withheld end. Pre-fix this delivered row-0..row-199 and, because the
    // cursor can never advance, row-200..row-249 were unreachable FOREVER.
    assert.ok(got1.includes('row-249'), 'THE FIX: the NEWEST row on a non-ackable partition must be delivered; pre-fix it was permanently invisible to read-primary');
    assert.ok(!got1.includes('row-0'), 'and the oldest rows are the withheld end on a partition whose cursor can never advance');

    assert.equal(r1.result.meshNeverReadCapped, true, 'the cap is reported');
    assert.equal(r1.result.meshNeverReadWithheldCount, 50, '250 - 200 = 50 withheld');
    assert.ok(typeof r1.result.neverReadCapHint === 'string' && r1.result.neverReadCapHint.includes('inbox messages live-sib'),
      'THE FIX: the hint must name the exact command that reads the withheld rows: ' + JSON.stringify(r1.result.neverReadCapHint));
  } finally { rm(home); rm(repo); }
});

test('(c) NOTHING IS LOST: every withheld row on a non-ackable partition is still readable directly', () => {
  const home = tmpHome();
  const repo = makeGitRepo('lossfree');
  try {
    register(home, repo, 'caller-y');
    markLive(home, 'caller-y');
    register(home, repo, 'live-sib-y');
    markLive(home, 'live-sib-y');
    seedPartition(home, repo, 'live-sib-y', rowsFor(250));

    cli.run(['inbox', 'read-primary', 'caller-y', '--ack-as-owner'], ctx(home, { cwd: repo }));
    const direct = cli.run(['inbox', 'messages', 'live-sib-y', '--limit', '5000'], ctx(home, { cwd: repo }));
    assert.equal(direct.result.ok, true, JSON.stringify(direct.result));
    const seen = new Set(bodies(direct));
    for (let i = 0; i < 250; i++) assert.ok(seen.has('row-' + i), 'row-' + i + ' must still be readable directly (the hint\'s command)');
  } finally { rm(home); rm(repo); }
});

test('(c) the cap is gated on BACKLOG SIZE, not first-read: call #2 on an already-acked partition is bounded too', () => {
  const home = tmpHome();
  const repo = makeGitRepo('backlog');
  try {
    register(home, repo, 'caller-z');
    markLive(home, 'caller-z');
    // An ORPHANED sibling (`unclaimed:` sessionId, no heartbeat) — the one
    // shape a foreign caller IS allowed to ack-drain, so its cursor advances.
    register(home, repo, 'orphan-sib', 'unclaimed:orphan-sib');
    seedPartition(home, repo, 'orphan-sib', rowsFor(250));

    const r1 = cli.run(['inbox', 'read-primary', 'caller-z', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(bodies(r1).length, 200, 'call #1 capped');
    assert.equal(cursorOf(home, repo, 'orphan-sib'), 200, 'an ackable partition IS drained to exactly the delivered prefix');

    // Now pile on a fresh backlog well past the cap. pCursor is no longer 0,
    // so the OLD `pCursor === 0` gate did not fire at all and dumped all 300.
    seedPartition(home, repo, 'orphan-sib', rowsFor(300, 1000));
    const r2 = cli.run(['inbox', 'read-primary', 'caller-z', '--ack-as-owner'], ctx(home, { cwd: repo }));
    const got2 = bodies(r2);
    assert.equal(got2.length, 200, 'THE FIX: call #2 is bounded by the same cap — the hazard is backlog size, not whether this is the first read');
    assert.equal(r2.result.meshNeverReadCapped, true, 'and the cap is reported on call #2 as well');

    // LOSS-FREE on the ackable path: the cursor advanced by exactly what was
    // delivered, so the withheld remainder is delivered next call.
    assert.equal(cursorOf(home, repo, 'orphan-sib'), 400, 'cursor advanced to exactly the delivered prefix (200 + 200), never past the withheld rows');
    const r3 = cli.run(['inbox', 'read-primary', 'caller-z', '--ack-as-owner'], ctx(home, { cwd: repo }));
    const got3 = bodies(r3);
    assert.ok(got3.length > 0, 'the withheld remainder makes forward progress on the next call');
    assert.ok(got3.includes('row-1299'), 'and the whole backlog is eventually drained, nothing dropped');
  } finally { rm(home); rm(repo); }
});

test('(c) an ackable partition still gets a PREFIX (the ack arithmetic depends on it) and a below-cap backlog is untouched', () => {
  const home = tmpHome();
  const repo = makeGitRepo('prefix');
  try {
    register(home, repo, 'caller-p');
    markLive(home, 'caller-p');
    register(home, repo, 'orphan-p', 'unclaimed:orphan-p');
    seedPartition(home, repo, 'orphan-p', rowsFor(250));

    const r = cli.run(['inbox', 'read-primary', 'caller-p', '--ack-as-owner'], ctx(home, { cwd: repo }));
    const got = bodies(r);
    assert.ok(got.includes('row-0') && got.includes('row-199'), 'an ACKABLE partition keeps the structural PREFIX — its cursor advances, so the tail must stay the withheld end');
    assert.ok(!got.includes('row-249'), 'and the newest rows are the withheld end there');

    // A sibling whose backlog is under the cap is untouched by any of this.
    const home2 = tmpHome();
    const repo2 = makeGitRepo('small');
    try {
      register(home2, repo2, 'caller-s');
      markLive(home2, 'caller-s');
      register(home2, repo2, 'live-s');
      markLive(home2, 'live-s');
      seedPartition(home2, repo2, 'live-s', rowsFor(5));
      const rs = cli.run(['inbox', 'read-primary', 'caller-s', '--ack-as-owner'], ctx(home2, { cwd: repo2 }));
      assert.equal(bodies(rs).length, 5, 'a small backlog is delivered whole');
      assert.equal(rs.result.meshNeverReadCapped, undefined, 'and nothing is reported as capped');
      assert.equal(rs.result.neverReadCapHint, undefined, 'no hint when nothing was withheld');
    } finally { rm(home2); rm(repo2); }
  } finally { rm(home); rm(repo); }
});

// =======================================================================
// WAVE 10 — the tail-cap HARD REFUSE is not vacuous.
//
// GAP FOUND: in every fixture above, `pTailCapped` can only become true
// when `pAckable` is false, and `pAckable = doAck && !siblingAckGate(...)`
// — the SAME predicate the ack loop re-evaluates a few hundred lines later
// with the SAME arguments (s, id, pid, home, ctx.now). So the ack loop's
// `if (part.tailCapped) continue;` (scripts/devswarm.js, the TAIL-CAP HARD
// REFUSAL) is never the deciding line: deleting it leaves all four tests
// above GREEN, because `siblingAckGate` refuses the same partition on the
// very next line. The comment calls it belt-and-braces "if liveness flipped
// in between" — a state change no fixture can produce, since both calls
// share one frozen `ctx.now`.
//
// So the only honest way to exercise the line is to make the two predicates
// DISAGREE on purpose: force `pAckable` false at cap time (partition is
// tail-capped) while leaving the ack-time gate ACKABLE (an orphan sibling
// with an `unclaimed:` sessionId and no heartbeat — the shape test (c)
// above proves a foreign caller IS allowed to drain). That is exactly the
// liveness-flip the comment describes, and in that state the hard refuse is
// the ONLY thing standing between a tail-capped (non-prefix) delivery and a
// cursor write that would mark undelivered rows read.
//
// Both tests run against an isolated scratch copy; the live file is never
// touched (devswarm-mutant-kit).
// =======================================================================

const mutantKit = require('./lib/devswarm-mutant-kit.js');

const FORCE_TAIL_CAP_OLD = '        const pAckable = doAck && !siblingAckGate(s, id, pid, home, ctx.now);\n';
const FORCE_TAIL_CAP_NEW = '        const pAckable = false; // WAVE 10 TEST SEAM: force the tail-cap branch while the ack-time gate still says ACKABLE\n';
const HARD_REFUSE_LINE = '        if (part.tailCapped) { liveSiblingsSkipped.push(part.id); continue; }\n';

function runDisagreementFixture(mutatedCli, tag) {
  const home = tmpHome();
  const repo = makeGitRepo(tag);
  try {
    register(home, repo, 'caller-d');
    markLive(home, 'caller-d');
    // ORPHAN sibling: `unclaimed:` sessionId, no heartbeat -> siblingAckGate
    // returns FALSE (ackable) at ack time. With the seam above, the cap path
    // nonetheless marks it tailCapped, so the two DISAGREE.
    register(home, repo, 'orphan-d', 'unclaimed:orphan-d');
    seedPartition(home, repo, 'orphan-d', rowsFor(250));

    const r = mutatedCli.run(['inbox', 'read-primary', 'caller-d', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    const got = r.result.messages.filter((m) => m.body && m.body.startsWith('row-')).map((m) => m.body);
    assert.equal(got.length, 200, 'precondition: the partition was capped');
    assert.ok(got.includes('row-249') && !got.includes('row-0'),
      'precondition: the seam put this partition on the TAIL branch — the delivered window is NOT a structural prefix, so any cursor arithmetic over it is wrong by construction');
    const repoKey = repokey.repoKeyForWorktree(repo);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let cursor;
    try { cursor = s.cursorValue('orphan-d'); } finally { s.close(); }
    return cursor;
  } finally { rm(home); rm(repo); }
}

test('(c) WAVE 10: when the tail-cap flag and the ack gate DISAGREE, the hard refuse still blocks every cursor write', () => {
  mutantKit.withMutant(
    FORCE_TAIL_CAP_OLD, FORCE_TAIL_CAP_NEW,
    (mutatedCli) => {
      const cursor = runDisagreementFixture(mutatedCli, 'disagree-guarded');
      assert.strictEqual(cursor, 0,
        `THE GUARD: a tail-capped partition must never have its cursor written, even when the ack-time liveness gate would happily ack it (got ${cursor}) — the delivered window is the NEWEST rows, so an ack would mark the un-delivered oldest rows read and lose them`);
    },
    { prefix: 'anti-hall-wave10-tailcap-disagree' }
  );
});

test('(c) WAVE 10 MUTATION-KILL: deleting the tail-cap hard refuse loses mail once the two predicates disagree', () => {
  mutantKit.withMutantTransform(
    (src) => {
      if (!src.includes(FORCE_TAIL_CAP_OLD)) throw new Error('seam target not found verbatim');
      if (!src.includes(HARD_REFUSE_LINE)) throw new Error('hard-refuse target not found verbatim');
      return src.replace(FORCE_TAIL_CAP_OLD, FORCE_TAIL_CAP_NEW).replace(HARD_REFUSE_LINE, '');
    },
    (mutatedCli) => {
      const cursor = runDisagreementFixture(mutatedCli, 'disagree-mutant');
      assert.ok(cursor > 0,
        'RED (expected on the mutant): without the hard refuse, the ack loop reaches a tail-capped partition and writes a cursor over rows it never delivered. If this fails, the hard refuse is not what protects the tail-cap case and the test above is vacuous.');
    },
    { prefix: 'anti-hall-wave10-tailcap-mutant' }
  );
});
