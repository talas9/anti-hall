'use strict';
// VERIFICATION for defect f061789267c1 / a77b85571dfa's REVISED mechanism.
//
// The team-lead's FIRST field-derived model ("summary.total tracks the
// live store while summary.cursor is frozen") and SECOND model ("summary.total
// IS the reader's own live instance cursor") were both field inferences from a
// single captured snapshot, not verified against source. This test drives the
// REAL production code path (cmdRegister -> cmdInboxMessages ack -> real
// per-instance commitInstanceAck -> real computeSummary) end to end and reads
// off both fields, proving what actually feeds them:
//
//   summary.workspaces[id].total  = store.messageCount(id)            <- devswarm-store.js:2030,797/1423
//                                    a REAL row count, backend-independent.
//   summary.workspaces[id].cursor = store.cursorValue(id)             <- devswarm-store.js:2031,894/1524
//                                    the STORE's own shared-pair cursor, kept
//                                    at the MIN across live #inst- files by
//                                    commitInstanceAck's `prospective`
//                                    computation (scripts/devswarm.js:1481-1500).
//
// The apparent "total == live reader's own cursor" in the field capture was
// COINCIDENTAL: that reader had drained every row that existed at capture
// time, so its own instance cursor equaled the current message count at that
// instant. total is NOT sourced from any cursor — it is an independent count
// that keeps growing regardless of which reader is asking.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = process.env.ANTIHALL_TEST_PLUGIN_ROOT
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const inboxCursor = require(path.join(ROOT, 'companion', 'lib', 'devswarm-inbox-cursor.js'));
const ownReader = require(path.join(ROOT, 'companion', 'lib', 'devswarm-own-reader.js'));

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-summary-deriv-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-summary-deriv-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'T']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
function backend() { return (storeLib.sqliteAvailable && storeLib.sqliteAvailable()) ? 'sqlite' : 'journal'; }
function repoKeyOf(repo) {
  const rk = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));
  return rk.repoKeyForWorktree(repo);
}
function seed(home, repo, id, n, tagBase, startTs) {
  const s = storeLib.openStore({ home, hash: repoKeyOf(repo), backend: backend() });
  try {
    for (let i = 0; i < n; i++) {
      const fields = {
        from: 'peer-sender', to: id, type: 'direct',
        message: (tagBase || 'msg') + '-' + i, timestamp: (startTs || 1700000000000) + i, urgency: 'normal',
      };
      const hash = storeLib.meshMessageHash(fields);
      storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash }));
    }
  } finally { s.close(); }
}
function register(home, repo, id, sessionId, nonce) {
  return cli.cmdRegister(id, {
    worktree: [repo], session: [sessionId || ('sess-' + id)],
  }, { home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: nonce });
}
function readAllAck(home, repo, id, nonce) {
  return cli.cmdInboxMessages(id, { unread: [true] }, {
    home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: nonce,
  }, { ack: true });
}

const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
test.before(() => {
  const iso = tmpHome();
  process.env.HOME = iso;
  process.env.USERPROFILE = iso;
});
test.after(() => {
  if (REAL_HOME !== undefined) process.env.HOME = REAL_HOME; else delete process.env.HOME;
  if (REAL_USERPROFILE !== undefined) process.env.USERPROFILE = REAL_USERPROFILE; else delete process.env.USERPROFILE;
});

test('REPRODUCTION: the exact field-captured shape (fresh caught-up reader, stale sibling 71 behind) via REAL commitInstanceAck + REAL computeSummary', () => {
  const home = tmpHome(); const repo = makeGitRepo('deriv1');
  try {
    const id = 'uuid-like-id';
    const FRESH_NONCE = 'anc:9001:1';
    const STALE_NONCE = 'anc:9002:2';

    // Both instances declare themselves (register) BEFORE any mail exists,
    // mirroring "present before the backlog arrived" — matches the real
    // fleet's topology (both a live and a since-idled reader had already run).
    register(home, repo, id, 'sess-fresh', FRESH_NONCE);
    register(home, repo, id, 'sess-stale', STALE_NONCE);

    // First batch: 859 messages. STALE reads+acks all of them (then goes
    // idle — models the 3-day-old sibling file). FRESH does NOT read yet.
    seed(home, repo, id, 859, 'batch1');
    const staleRead = readAllAck(home, repo, id, STALE_NONCE);
    assert.strictEqual(staleRead.ok, true, JSON.stringify(staleRead.error || staleRead.reason || ''));
    assert.strictEqual(staleRead.messages.length, 859);

    // Second batch: 71 more messages arrive (total now 930). FRESH reads+acks
    // ALL currently-unread mail (both batches) — the "caught up right now"
    // reader from the field capture.
    seed(home, repo, id, 71, 'batch2');
    const freshRead = readAllAck(home, repo, id, FRESH_NONCE);
    assert.strictEqual(freshRead.ok, true, JSON.stringify(freshRead.error || freshRead.reason || ''));
    assert.strictEqual(freshRead.messages.length, 930, 'FRESH had never read before, so it receives the full backlog');

    // Now read the REAL computeSummary projection.
    const s = storeLib.openStore({ home, hash: repoKeyOf(repo), backend: backend() });
    let entry;
    try {
      s.upsertRegistry({ id, worktreePath: repo, sessionId: 'sess-fresh' });
      const summary = storeLib.computeSummary(s, { home, now: Date.now() });
      entry = summary.workspaces[id];
    } finally { s.close(); }

    assert.ok(entry, 'the row must be projected');
    assert.strictEqual(entry.total, 930, 'total = store.messageCount(id), a REAL row count — devswarm-store.js:2030');
    assert.strictEqual(entry.cursor, 859, 'cursor = store.cursorValue(id) = the MIN across #inst- files (STALE\'s position) — devswarm-store.js:2031, commitInstanceAck prospective at scripts/devswarm.js:1481-1500');
    assert.strictEqual(entry.unread, 71, 'the EXACT phantom number from the field capture, reproduced from real code, not fabricated');

    // Prove total is NOT sourced from FRESH's cursor: advance FRESH further
    // by seeding one more unread message it has NOT yet read, and confirm
    // total does NOT move until a NEW message actually lands (independent of
    // any reader's position) — while FRESH's own instance cursor stays put
    // at 930 regardless of new mail arriving.
    seed(home, repo, id, 1, 'batch3');
    const s2 = storeLib.openStore({ home, hash: repoKeyOf(repo), backend: backend() });
    let entry2;
    try {
      const summary2 = storeLib.computeSummary(s2, { home, now: Date.now() });
      entry2 = summary2.workspaces[id];
    } finally { s2.close(); }
    assert.strictEqual(entry2.total, 931, 'total tracks the store\'s real row count, independent of any reader\'s cursor — it grew because a NEW message arrived, not because a cursor moved');
    assert.strictEqual(entry2.cursor, 859, 'cursor is unchanged: no ack happened between the two computeSummary calls');

    // Apply the FIX (own-reader helper) as the gate would, pinning
    // deriveInstanceNonce to FRESH's identity, against the FIRST snapshot
    // (`entry`, total:930). FRESH's live instance cursor is ALSO 930 — equal
    // to that snapshot's own total. P1 STALE-CACHE GUARD (Critic NO-GO,
    // 2026-09-11 round 1): the CACHE alone cannot distinguish "reader has
    // drained everything" from "mail landed after the snapshot" here. P1
    // GO-with-fix (Critic, round 2): rather than leave that AMBIGUOUS and
    // return UNKNOWN forever, this branch now pays for ONE live store read
    // to settle it for real — and by the time this assertion runs, the live
    // store genuinely DOES have one more row than `entry`'s snapshot knew
    // about (seeded above, before `entry2` was captured), so the live read
    // correctly resolves to 1, not 0 and not UNKNOWN. This is the exact
    // "genuinely-new-mail" resolution case; see
    // tests/companion/devswarm-summary-cursor-derivation.test.js's dedicated
    // AMBIGUOUS-BRANCH LIVE RESOLUTION tests below for the "genuinely
    // drained -> 0" and "live read unavailable -> null" companions.
    const origDerive = cli.deriveInstanceNonce;
    cli.deriveInstanceNonce = () => FRESH_NONCE;
    let fixedUnread;
    try {
      fixedUnread = ownReader.ownReaderUnread(home, repo, id, entry, entry.unread);
    } finally { cli.deriveInstanceNonce = origDerive; }
    assert.strictEqual(fixedUnread, 1, 'own cursor equal to the FIRST snapshot\'s own total is cache-ambiguous, but the live read settles it: exactly 1 new row genuinely exists');

    // Against the SECOND snapshot (`entry2`, total:931 — the cache has now
    // observed the row that pushed FRESH's own cursor's equal-total case
    // into "genuinely behind by one"), FRESH's cursor (930) is strictly
    // BELOW the cache's total -> cache-consistent -> the COMMON (non-live)
    // path computes the same real, trustworthy number: exactly 1.
    cli.deriveInstanceNonce = () => FRESH_NONCE;
    let fixedUnread2;
    try {
      fixedUnread2 = ownReader.ownReaderUnread(home, repo, id, entry2, entry2.unread);
    } finally { cli.deriveInstanceNonce = origDerive; }
    assert.strictEqual(fixedUnread2, 1, 'once the cache catches up past this reader\'s own position, the common (non-live) path independently confirms the same number');
  } finally { rm(home); rm(repo); }
});

test('genuinely-unread case through the SAME real pipeline: FRESH reader stops short, must see its true remaining count, never 0', () => {
  const home = tmpHome(); const repo = makeGitRepo('deriv2');
  try {
    const id = 'uuid-like-id-2';
    const READER_NONCE = 'anc:9101:1';
    const SIBLING_NONCE = 'anc:9102:2';
    register(home, repo, id, 'sess-r', READER_NONCE);
    register(home, repo, id, 'sess-sib', SIBLING_NONCE);
    seed(home, repo, id, 250, 'batch');
    // Both instances read+ack down to the SAME position (100 of 250),
    // leaving 150 genuinely unread for BOTH — via cmdInboxMessages' own
    // --limit flag (a real, capped ack, not a fabricated cursor value).
    const r1 = cli.cmdInboxMessages(id, { unread: [true], limit: ['100'] }, {
      home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: READER_NONCE,
    }, { ack: true });
    assert.strictEqual(r1.ok, true, JSON.stringify(r1.error || r1.reason || ''));
    assert.strictEqual(r1.messages.length, 100);
    const r2 = cli.cmdInboxMessages(id, { unread: [true], limit: ['100'] }, {
      home, cwd: repo, env: {}, backend: backend(), now: Date.now(), instanceNonce: SIBLING_NONCE,
    }, { ack: true });
    assert.strictEqual(r2.messages.length, 100);

    const s = storeLib.openStore({ home, hash: repoKeyOf(repo), backend: backend() });
    let entry;
    try {
      s.upsertRegistry({ id, worktreePath: repo, sessionId: 'sess-r' });
      const summary = storeLib.computeSummary(s, { home, now: Date.now() });
      entry = summary.workspaces[id];
    } finally { s.close(); }
    assert.strictEqual(entry.total, 250);
    assert.strictEqual(entry.cursor, 100, 'both instances at the same position -> shared floor also 100');
    assert.strictEqual(entry.unread, 150);

    const origDerive = cli.deriveInstanceNonce;
    cli.deriveInstanceNonce = () => READER_NONCE;
    let fixedUnread;
    try {
      fixedUnread = ownReader.ownReaderUnread(home, repo, id, entry, entry.unread);
    } finally { cli.deriveInstanceNonce = origDerive; }
    assert.strictEqual(fixedUnread, 150, 'the reader is genuinely 150 behind -> must see the true count, nothing hidden');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// AMBIGUOUS-BRANCH LIVE RESOLUTION (Critic GO-with-fix, 2026-09-11). A bare
// UNKNOWN for own==cached-total left the reporter's EXACT shape blocked
// forever on a healthy summary — not finished. These three tests drive the
// SAME real pipeline as the REPRODUCTION test above, through the genuine
// reporter shape (own 930, cached total 930, stale sibling 859), and prove
// the live resolution this branch now performs actually settles it: 0 when
// truly drained (gate opens), the real count when new mail landed since the
// snapshot (gate blocks), and UNKNOWN when the live read itself cannot run.
// ---------------------------------------------------------------------------

// buildReporterShape(tag) -> { home, repo, id, entry } — registers FRESH +
// STALE instances, seeds 859+71=930 messages, has STALE read+ack the first
// 859 then go idle, and FRESH read+ack all 930 (own cursor lands at 930,
// exactly equal to the snapshot's own total) — the reporter's EXACT live
// shape (own 930, cached total 930, cached cursor 859 = the stale sibling's
// position), captured via a REAL computeSummary call.
function buildReporterShape(tag) {
  const home = tmpHome(); const repo = makeGitRepo(tag);
  const id = 'reporter-shape-id';
  const FRESH_NONCE = 'anc:9201:1';
  const STALE_NONCE = 'anc:9202:2';
  register(home, repo, id, 'sess-fresh', FRESH_NONCE);
  register(home, repo, id, 'sess-stale', STALE_NONCE);
  seed(home, repo, id, 859, 'batch1');
  const staleRead = readAllAck(home, repo, id, STALE_NONCE);
  assert.strictEqual(staleRead.messages.length, 859);
  seed(home, repo, id, 71, 'batch2');
  const freshRead = readAllAck(home, repo, id, FRESH_NONCE);
  assert.strictEqual(freshRead.messages.length, 930);

  const s = storeLib.openStore({ home, hash: repoKeyOf(repo), backend: backend() });
  let entry;
  try {
    s.upsertRegistry({ id, worktreePath: repo, sessionId: 'sess-fresh' });
    const summary = storeLib.computeSummary(s, { home, now: Date.now() });
    entry = summary.workspaces[id];
  } finally { s.close(); }
  assert.strictEqual(entry.total, 930);
  assert.strictEqual(entry.cursor, 859);
  assert.strictEqual(entry.unread, 71);
  return { home, repo, id, entry, FRESH_NONCE };
}

test('AMBIGUOUS-BRANCH LIVE RESOLUTION: reporter\'s exact shape, NO new mail since the snapshot -> live resolves to 0, the gate would open', () => {
  const { home, repo, id, entry, FRESH_NONCE } = buildReporterShape('ambig1');
  try {
    const origDerive = cli.deriveInstanceNonce;
    cli.deriveInstanceNonce = () => FRESH_NONCE;
    let result;
    try {
      result = ownReader.ownReaderUnread(home, repo, id, entry, entry.unread);
    } finally { cli.deriveInstanceNonce = origDerive; }
    assert.strictEqual(result, 0, 'the live store genuinely has nothing beyond FRESH\'s own position -> the ambiguity resolves to a real 0, not UNKNOWN — the reporter\'s gate must open');
  } finally { rm(home); rm(repo); }
});

test('AMBIGUOUS-BRANCH LIVE RESOLUTION: reporter\'s exact shape PLUS 5 new messages arrived after the snapshot -> live resolves to 5, the gate would still block', () => {
  const { home, repo, id, entry, FRESH_NONCE } = buildReporterShape('ambig2');
  try {
    // 5 more messages land AFTER the snapshot (`entry` is already captured;
    // this seeds directly into the live store, never touching the cache).
    seed(home, repo, id, 5, 'batch3');
    const origDerive = cli.deriveInstanceNonce;
    cli.deriveInstanceNonce = () => FRESH_NONCE;
    let result;
    try {
      result = ownReader.ownReaderUnread(home, repo, id, entry, entry.unread);
    } finally { cli.deriveInstanceNonce = origDerive; }
    assert.strictEqual(result, 5, 'the live store now has 5 rows FRESH has not read -> the ambiguity resolves to the REAL count, never hidden as 0');
  } finally { rm(home); rm(repo); }
});

test('AMBIGUOUS-BRANCH LIVE RESOLUTION: live read cannot run (repo/store gone) -> UNKNOWN (null), never a guessed 0', () => {
  const { home, repo, id, entry, FRESH_NONCE } = buildReporterShape('ambig3');
  try {
    // Remove the repo (and therefore the store's resolvable repoKey) AFTER
    // capturing `entry` — models "the live read itself cannot succeed",
    // distinct from "the live read succeeded and found 0/N".
    rm(repo);
    const origDerive = cli.deriveInstanceNonce;
    cli.deriveInstanceNonce = () => FRESH_NONCE;
    let result;
    try {
      result = ownReader.ownReaderUnread(home, repo, id, entry, entry.unread);
    } finally { cli.deriveInstanceNonce = origDerive; }
    assert.strictEqual(result, null, 'a live read that cannot run must fail to UNKNOWN, never guess a number in either direction');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// INBOX-PATH FOLD-IN COVERAGE (Critic P2, 2026-09-11 round 3). The ambiguous
// branch's `entry.inboxPath`-present fold-in (devswarm-own-reader.js's
// `unionUnread` call) had ZERO test coverage before this round. `unionUnread`
// is fail-open: if `listMessages` throws inside it, it silently degrades to
// NDJSON-only reporting, which can be LOWER than the store number this
// module already proved live — adopting it unconditionally would hide mail.
// The fix takes `Math.max(liveUnread, union.unread)`; these three tests
// cover: (1) they genuinely agree, (2) a degraded/lower union must NOT win,
// (3) a legitimately higher union DOES win.
// ---------------------------------------------------------------------------

const unreadLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-unread.js'));

function withNdjsonInbox(home, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ndjson-' + tag + '-'));
  const inboxPath = path.join(dir, 'inbox.ndjson');
  const cursorPath = path.join(dir, 'cursor.json');
  fs.writeFileSync(inboxPath, ''); // empty durable inbox: 0 NDJSON lines, nothing to contribute
  fs.writeFileSync(cursorPath, '0');
  return { inboxPath, cursorPath, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} } };
}

test('INBOX-PATH FOLD-IN 1/3: durable inbox present, store and union genuinely AGREE -> no double-count', () => {
  const { home, repo, id, entry, FRESH_NONCE } = buildReporterShape('foldin1');
  const inbox = withNdjsonInbox(home, 'foldin1');
  try {
    seed(home, repo, id, 5, 'batch3'); // 5 genuinely new store-side rows, empty NDJSON side
    const entryWithInbox = Object.assign({}, entry, { inboxPath: inbox.inboxPath, cursorPath: inbox.cursorPath });
    const origDerive = cli.deriveInstanceNonce;
    cli.deriveInstanceNonce = () => FRESH_NONCE;
    let result;
    try {
      result = ownReader.ownReaderUnread(home, repo, id, entryWithInbox, entryWithInbox.unread);
    } finally { cli.deriveInstanceNonce = origDerive; }
    assert.strictEqual(result, 5, 'an empty NDJSON side contributes nothing -> the union agrees exactly with the store-only count, no double-count');
  } finally { inbox.cleanup(); rm(home); rm(repo); }
});

test('INBOX-PATH FOLD-IN 2/3: union DEGRADES below the proven store truth (listMessages throws inside unionUnread) -> the store number wins, never the lower union', () => {
  const { home, repo, id, entry, FRESH_NONCE } = buildReporterShape('foldin2');
  const inbox = withNdjsonInbox(home, 'foldin2');
  const origUnion = unreadLib.unionUnread;
  try {
    seed(home, repo, id, 5, 'batch3'); // proven store truth: 5 unread
    // Simulate unionUnread's own fail-open degrade path (its internal catch
    // around a listMessages throw, devswarm-unread.js ~:288): a real throw
    // there returns NDJSON-only reporting, `unread` LOWER than the store
    // truth. Monkeypatching the cached export reproduces that exact RETURN
    // SHAPE deterministically, without depending on forcing a genuine
    // internal exception.
    unreadLib.unionUnread = () => ({ unread: 1, total: 1, cursor: 0, storeCursor: 0, known: true, ndjsonUnreadLines: [], storeOnlyUnreadRows: [], oldestUnreadAgeMs: null });
    const entryWithInbox = Object.assign({}, entry, { inboxPath: inbox.inboxPath, cursorPath: inbox.cursorPath });
    const origDerive = cli.deriveInstanceNonce;
    cli.deriveInstanceNonce = () => FRESH_NONCE;
    let result;
    try {
      result = ownReader.ownReaderUnread(home, repo, id, entryWithInbox, entryWithInbox.unread);
    } finally { cli.deriveInstanceNonce = origDerive; }
    assert.strictEqual(result, 5, 'a degraded union (1) must NOT override the proven live store count (5) — Math.max protects against hiding real mail');
  } finally { unreadLib.unionUnread = origUnion; inbox.cleanup(); rm(home); rm(repo); }
});

test('INBOX-PATH FOLD-IN 3/3: union is LEGITIMATELY higher (real NDJSON-only mail the store side never saw) -> the union wins', () => {
  const { home, repo, id, entry, FRESH_NONCE } = buildReporterShape('foldin3');
  const inbox = withNdjsonInbox(home, 'foldin3');
  const origUnion = unreadLib.unionUnread;
  try {
    seed(home, repo, id, 5, 'batch3'); // proven store truth: 5 unread
    // A genuinely higher union (e.g. real NDJSON-only rows the store side
    // structurally cannot see) must be trusted, not clamped to the store's
    // own (lower) number.
    unreadLib.unionUnread = () => ({ unread: 12, total: 17, cursor: 0, storeCursor: 0, known: true, ndjsonUnreadLines: [], storeOnlyUnreadRows: [], oldestUnreadAgeMs: null });
    const entryWithInbox = Object.assign({}, entry, { inboxPath: inbox.inboxPath, cursorPath: inbox.cursorPath });
    const origDerive = cli.deriveInstanceNonce;
    cli.deriveInstanceNonce = () => FRESH_NONCE;
    let result;
    try {
      result = ownReader.ownReaderUnread(home, repo, id, entryWithInbox, entryWithInbox.unread);
    } finally { cli.deriveInstanceNonce = origDerive; }
    assert.strictEqual(result, 12, 'a legitimately higher union count must win — real NDJSON-only mail must never be clamped down to the store-only number');
  } finally { unreadLib.unionUnread = origUnion; inbox.cleanup(); rm(home); rm(repo); }
});
