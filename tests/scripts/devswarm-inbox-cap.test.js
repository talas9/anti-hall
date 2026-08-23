'use strict';
// defect 8d0a66cfc563: `inbox read-primary`/`peek-primary` merge EVERY mesh
// sibling partition plus the NDJSON descriptor channel with NO cap — a real
// field case returned 489 messages in a single read. This file exercises the
// fix added to cmdInboxMessages (scripts/devswarm.js): a default (and
// --limit-overridable) cap on the FINAL merged read, honest truncation
// reporting (never silent), and — the highest-risk part — that the ack
// cursor for EVERY source (own store partition, each mesh sibling partition,
// the NDJSON channel) can never advance past a message the cap withheld,
// even when withholding requires excluding a row a naive ts-sort slice would
// have kept (see test 4).

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-inbox-cap-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-inbox-cap-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function register(home, repoDir, id, over) {
  const inboxPath = path.join(home, 'descriptor-inboxes', id + '.ndjson');
  const cursorPath = path.join(home, 'descriptor-cursors', id + '.cursor');
  const r = cli.run(
    ['register', id, '--worktree', repoDir, '--session', 's-' + id, '--inbox', inboxPath, '--cursor', cursorPath],
    ctx(home, Object.assign({ cwd: repoDir }, over || {}))
  );
  assert.equal(r.result.ok, true, 'register failed: ' + JSON.stringify(r.result));
  return { inboxPath, cursorPath };
}

// seedPartition(home, repoDir, toId, rows) — rows inserted in ARRAY ORDER,
// which becomes physical insertion (id ASC / listMessages positional) order
// for that partition — independent of each row's own `ts`.
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

// ---- 3: cap returns exactly the limit and flags truncation ----------------

test('cap: a read with more messages than the cap returns exactly the cap, flags truncation, and states the withheld count', () => {
  const home = tmpHome();
  const repo = makeGitRepo('cap-basic');
  try {
    register(home, repo, 'primary-cap', undefined);
    const rows = [];
    for (let i = 0; i < 7; i++) rows.push({ body: 'm' + i, ts: 1000 + i * 10 });
    seedPartition(home, repo, 'primary-cap', rows);

    const r = cli.run(['inbox', 'read-primary', 'primary-cap', '--ack-as-owner', '--limit', '3'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.count, 3, 'exactly the cap must be returned');
    assert.equal(r.result.messages.length, 3);
    assert.equal(r.result.truncated, true, 'truncation must be flagged, never silent');
    assert.equal(r.result.truncatedCount, 4, '7 total - 3 delivered = 4 withheld');
    assert.equal(r.result.limit, 3);
    assert.ok(typeof r.result.truncatedHint === 'string' && r.result.truncatedHint.length > 0, 'a hint for retrieving the rest must be present');
    // total/unreadCount stay the REAL untruncated numbers — only `count`/
    // `messages` reflect what was actually delivered this call.
    assert.equal(r.result.total, 7);
  } finally { rm(home); rm(repo); }
});

// ---- 5: an under-cap read is completely unaffected (no regression) --------

test('cap: an under-cap read behaves exactly as before — no truncated field, everything delivered and acked', () => {
  const home = tmpHome();
  const repo = makeGitRepo('cap-under');
  try {
    register(home, repo, 'primary-under', undefined);
    seedPartition(home, repo, 'primary-under', [
      { body: 'a', ts: 1000 }, { body: 'b', ts: 2000 }, { body: 'c', ts: 3000 },
    ]);
    const r = cli.run(['inbox', 'read-primary', 'primary-under', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.count, 3);
    assert.equal(r.result.truncated, undefined, 'an under-cap read must not carry a truncated flag at all');
    assert.equal(r.result.truncatedCount, undefined);
    // Fully acked: a second read sees nothing left.
    const r2 = cli.run(['inbox', 'read-primary', 'primary-under', '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r2.result.count, 0, 'everything was delivered and acked on the first (uncapped) read');
  } finally { rm(home); rm(repo); }
});

// ---- 4: the cursor invariant under the cap (the highest-risk part) --------
//
// Own partition gets 3 messages with normal, monotonically increasing ts
// (1000/2000/3000). A SIBLING partition gets 2 messages inserted in an order
// where the FIRST-inserted (position 0, the one the sibling's cursor must
// clear first) carries a LATER ts (9000) than the SECOND-inserted (position
// 1, ts 500) — i.e. non-monotonic ts vs. insertion order, which is exactly
// the shape a naive "ts-sort the merged list, then slice the first N" cap
// would get wrong: sorted by ts, sibling's position-1 row (ts 500) sorts
// BEFORE sibling's position-0 row (ts 9000), so a naive top-4-of-5 slice
// would KEEP position 1 while WITHHOLDING position 0 — advancing that
// sibling's cursor past a message it never returned to the caller (the
// message-loss bug this test proves does NOT happen). The fix must instead
// withhold BOTH sibling rows this call (since position 0 is the first gap,
// and the cursor is a positional/consumed-count, not a ts-ordered one), and
// only own's 3 rows are delivered.
test('cursor invariant under the cap: withheld messages are NEVER marked read, even when a naive ts-sort slice would have kept a later message while dropping an earlier one', () => {
  const home = tmpHome();
  const repo = makeGitRepo('cap-invariant');
  try {
    register(home, repo, 'primary-inv', undefined);
    register(home, repo, 'sibling-inv', undefined);
    seedPartition(home, repo, 'primary-inv', [
      { body: 'own-0', ts: 1000 }, { body: 'own-1', ts: 2000 }, { body: 'own-2', ts: 3000 },
    ]);
    // Inserted in this literal order: position 0 = ts 9000 (LATER ts, but
    // EARLIER position/cursor-order), position 1 = ts 500 (EARLIER ts, later
    // position).
    seedPartition(home, repo, 'sibling-inv', [
      { body: 'sib-pos0-latets', ts: 9000 }, { body: 'sib-pos1-earlyts', ts: 500 },
    ]);

    const first = cli.run(['inbox', 'read-primary', 'primary-inv', '--ack-as-owner', '--limit', '4'], ctx(home, { cwd: repo }));
    assert.equal(first.result.ok, true, JSON.stringify(first.result));
    assert.equal(first.result.truncated, true, JSON.stringify(first.result));
    // The structural prefix guarantee forces BOTH sibling rows out this call
    // (position 0 is the first gap for that source) — only own's 3 rows land.
    assert.equal(first.result.count, 3, 'only own\'s 3 messages are deliverable as a clean prefix under this cap: ' + JSON.stringify(first.result.messages.map((m) => m.body)));
    assert.deepStrictEqual(
      first.result.messages.map((m) => m.body).sort(),
      ['own-0', 'own-1', 'own-2'],
      'sibling rows must NOT appear — delivering sib-pos1 without sib-pos0 would violate the positional prefix invariant'
    );
    assert.equal(first.result.truncatedCount, 2);

    // Cursor invariant: the sibling's cursor must be UNCHANGED (still 0) —
    // neither of its two messages was actually delivered this call.
    const sibCursorPath = cli.primaryCursorPath(home, 'sibling-inv');
    const sibCursorRaw = fs.existsSync(sibCursorPath) ? fs.readFileSync(sibCursorPath, 'utf8').trim() : '0';
    assert.equal(sibCursorRaw, '0', 'a withheld partition\'s cursor must not advance at all: ' + sibCursorRaw);

    // own's cursor DID fully advance (all 3 of its own messages were delivered).
    const ownCursorPath = cli.primaryCursorPath(home, 'primary-inv');
    assert.equal(fs.readFileSync(ownCursorPath, 'utf8').trim(), '3');

    // A second read must return BOTH sibling messages now (still unread) —
    // proving nothing was lost, and delivered in the correct positional
    // order (pos0 before pos1), not silently skipped.
    const second = cli.run(['inbox', 'read-primary', 'primary-inv', '--ack-as-owner', '--limit', '4'], ctx(home, { cwd: repo }));
    assert.equal(second.result.ok, true, JSON.stringify(second.result));
    assert.equal(second.result.truncated, undefined, 'well under the cap on the second read');
    assert.equal(second.result.count, 2, 'both previously-withheld sibling messages must resurface: ' + JSON.stringify(second.result.messages));
    assert.deepStrictEqual(
      second.result.messages.map((m) => m.body).sort(),
      ['sib-pos0-latets', 'sib-pos1-earlyts']
    );

    // Full round-trip accounting: 5 total messages sent, 5 total delivered
    // across the two reads, zero lost, zero duplicated.
    assert.equal(first.result.count + second.result.count, 5);
  } finally { rm(home); rm(repo); }
});

// ---- --limit override --------------------------------------------------

test('cap: --limit overrides the default and a non-positive/invalid --limit falls back to the default rather than disabling the cap', () => {
  const home = tmpHome();
  const repo = makeGitRepo('cap-override');
  try {
    register(home, repo, 'primary-ovr', undefined);
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push({ body: 'm' + i, ts: 1000 + i });
    seedPartition(home, repo, 'primary-ovr', rows);

    const r = cli.run(['inbox', 'peek-primary', 'primary-ovr', '--limit', '2'], ctx(home, { cwd: repo, env: { DEVSWARM_BUILDER_ID: 'primary-ovr' } }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.count, 2);
    assert.equal(r.result.truncated, true);
    assert.equal(r.result.limit, 2);

    // peek-primary never acks — nothing was consumed regardless of the cap.
    const cursorPath = cli.primaryCursorPath(home, 'primary-ovr');
    const cursorRaw = fs.existsSync(cursorPath) ? fs.readFileSync(cursorPath, 'utf8').trim() : '0';
    assert.equal(cursorRaw, '0', 'peek-primary must never advance the cursor, capped or not');

    const r2 = cli.run(['inbox', 'peek-primary', 'primary-ovr', '--limit', '0'], ctx(home, { cwd: repo, env: { DEVSWARM_BUILDER_ID: 'primary-ovr' } }));
    assert.equal(r2.result.ok, true, JSON.stringify(r2.result));
    assert.equal(r2.result.limit, undefined, 'a non-positive --limit is ignored, not surfaced as the active limit');
    assert.equal(r2.result.count, 5, 'falls back to the (much larger) default cap, so nothing is withheld here');
  } finally { rm(home); rm(repo); }
});
