'use strict';
// Round 13 — P0 HOTFIX: recurring sibling re-delivery after a converged drain,
// plus the ownership gate on `unclaimed:` promotion.
//
// FIELD REPORT (root-caused with scratchpad/p0b/repro.js against v0.90.0): a
// Primary drained its mesh group to convergence, and every subsequent
// `inbox read-primary` re-delivered the SAME 200 sibling rows, forever, while
// `inbox count` reported 0 unread on the same store sequence. Four independent
// mechanisms, each covered below:
//
//   (7) NAMESPACE SPLIT — `read-primary` sized a sibling's window from
//       `cursors/<pid>.json`, `inbox count` from the store cursor. Whichever
//       one a writer had not touched read as 0.
//   (8) NO LOCKSTEP — foldOne and reap-orphans advanced ONLY the store cursor,
//       creating that split in the first place.
//   (9) REWIND — reconcileOrphanCursor took a MIN that included the descriptor's
//       NDJSON LINE cursor, a different sequence entirely; an untouched NDJSON
//       channel (cursor 0) dragged a converged 606/606 pair back to 0/0.
//  (10) NO WATERMARK — a LIVE sibling is (correctly) never acked, so with
//       nothing recorded anywhere its whole backlog was re-delivered every read.
//
//   (1) OWNERSHIP — `maybePromoteUnclaimed` was called on the id being READ with
//       the READER's session id, so a Primary reading its twin stamped its own
//       live session onto the twin, making the twin read as live and blocking
//       the ack gate permanently.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const PLUGIN = path.join(__dirname, '../../plugins/anti-hall');
const cli = require(path.join(PLUGIN, 'scripts/devswarm.js'));
const storeLib = require(path.join(PLUGIN, 'companion/lib/devswarm-store.js'));
const repokey = require(path.join(PLUGIN, 'companion/lib/devswarm-repokey.js'));
const inboxCursor = require(path.join(PLUGIN, 'companion/lib/devswarm-inbox-cursor.js'));

const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} };

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-home-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'T']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'i']);
  return dir;
}
// `run(argv, ctx)` has NO env home override — every ctx below carries an
// explicit scratch `home` so nothing ever touches the real ~/.anti-hall.
const mkCtx = (home, repo, over) => Object.assign({ home, backend: 'journal', env: {}, cwd: repo }, over || {});

function seed(home, repoKey, toId, n, prefix, startTs) {
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    for (let i = 0; i < n; i++) {
      const f = { from: 'archived-X', to: toId, type: 'direct', urgency: 'normal',
        message: prefix + i, timestamp: (startTs || 1000) + i };
      storeLib.appendMeshMessage(s, Object.assign({}, f, { hash: storeLib.meshMessageHash(f) }));
    }
  } finally { s.close(); }
}
function register(home, repo, id, sessionId) {
  const inboxPath = path.join(home, 'di', id + '.ndjson');
  const cursorPath = path.join(home, 'dc', id + '.cursor');
  const r = cli.run(['register', id, '--worktree', repo, '--session', sessionId,
    '--inbox', inboxPath, '--cursor', cursorPath], mkCtx(home, repo));
  assert.ok(r.result.ok, 'register ' + id + ': ' + JSON.stringify(r.result));
  return { inboxPath, cursorPath };
}
// The caller identity this cwd actually produces — the Primary's own row id.
function callerIdFor(home, repo) {
  return cli.run(['inbox', 'read-primary', 'probe-only'], mkCtx(home, repo)).result.callerIdentity;
}

// ---------------------------------------------------------------------------
// (7) BOTH SURFACES SIZE FROM MAX(json, store)
// ---------------------------------------------------------------------------

test('R13 item 7: store=N/json=0 -> count 0 AND read 0 (the store cursor is honoured by read-primary)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('max-a');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const P = callerIdFor(home, repo);
    const T = '11111111-2222-3333-4444-555555555555';
    register(home, repo, P, 'unclaimed:' + P);
    register(home, repo, T, T + '-session');
    seed(home, repoKey, T, 6, 'fwd-', 100000);

    // ONLY the store cursor is advanced — the json namespace stays at 0.
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { s.setCursor(T, 6); } finally { s.close(); }
    assert.equal(inboxCursor.readCursor(cli.primaryCursorPath(home, T)), 0, 'precondition: json namespace untouched');

    const c = cli.run(['inbox', 'count', P], mkCtx(home, repo)).result;
    assert.equal(c.unreadTotal, 0, 'count sees the store cursor');
    const r = cli.run(['inbox', 'read-primary', P], mkCtx(home, repo)).result;
    assert.equal((r.messages || []).length, 0,
      'THE FIX: read-primary sizes from MAX(json, store) too — pre-fix it re-delivered all 6 forever');
  } finally { rm(home); rm(repo); }
});

test('R13 item 7: store=0/json=N -> count 0 AND read 0 (symmetric — count honours the json cursor)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('max-b');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const P = callerIdFor(home, repo);
    const T = '11111111-2222-3333-4444-555555555555';
    register(home, repo, P, 'unclaimed:' + P);
    register(home, repo, T, T + '-session');
    seed(home, repoKey, T, 6, 'fwd-', 100000);

    inboxCursor.ackTo(cli.primaryCursorPath(home, T), 6);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try { assert.equal(s.cursorValue(T), 0, 'precondition: store namespace untouched'); } finally { s.close(); }

    const c = cli.run(['inbox', 'count', P], mkCtx(home, repo)).result;
    assert.equal(c.unreadTotal, 0, 'THE FIX: count sizes from MAX too — pre-fix it reported 6');
    const r = cli.run(['inbox', 'read-primary', P], mkCtx(home, repo)).result;
    assert.equal((r.messages || []).length, 0);
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// (8) LOCKSTEP
// ---------------------------------------------------------------------------

test('R13 item 8: after a fold, BOTH cursor namespaces hold the same value', () => {
  const home = tmpHome();
  const repo = makeGitRepo('lockstep');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const survivor = callerIdFor(home, repo);
    const dupe = 'dupe-row-aaaa';
    register(home, repo, survivor, 'sess-survivor');
    register(home, repo, dupe, 'unclaimed:' + dupe);
    seed(home, repoKey, dupe, 4, 'to-fold-', 200000);
    // Remove the duplicate's descriptor so foldOne treats it as foldable, not `left`.
    rm(path.join(home, '.anti-hall', 'devswarm', 'workspaces', dupe + '.json'));

    cli.foldMeshDuplicates(home, { repoKey, backend: 'journal', env: {}, cwd: repo });

    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let storeC;
    try { storeC = s.cursorValue(dupe); } finally { s.close(); }
    const jsonC = inboxCursor.readCursor(cli.primaryCursorPath(home, dupe));
    assert.ok(storeC > 0, 'precondition: the fold forwarded and advanced the store cursor (got ' + storeC + ')');
    assert.equal(jsonC, storeC,
      'THE FIX: the read-path ack file is advanced in lockstep — pre-fix it stayed 0 and read-primary re-delivered the folded rows');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// (9) reconcileOrphanCursor must not rewind on an untouched NDJSON channel
// ---------------------------------------------------------------------------

test('R13 item 9: a converged store-side pair survives reconciliation with an untouched NDJSON cursor', () => {
  const home = tmpHome();
  const repo = makeGitRepo('reconcile');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const T = '11111111-2222-3333-4444-555555555555';
    const d = register(home, repo, T, T + '-session');
    seed(home, repoKey, T, 606, 'fwd-', 100000);

    // Converged store-side: both namespaces at 606. The descriptor's NDJSON
    // channel has never had a line, so its cursor is 0 — a DIFFERENT sequence.
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      s.setCursor(T, 606);
      inboxCursor.ackTo(cli.primaryCursorPath(home, T), 606);
      assert.equal(inboxCursor.readCursor(d.cursorPath), 0, 'precondition: NDJSON line cursor is 0');

      const desc = { id: T, cursorPath: d.cursorPath, inboxPath: d.inboxPath };
      cli.reconcileOrphanCursor(home, s, T, desc, false);

      assert.equal(s.cursorValue(T), 606,
        'THE FIX: the NDJSON LINE cursor is not a store cursor — pre-fix MIN(606,0,606) rewound this to 0');
      assert.equal(inboxCursor.readCursor(cli.primaryCursorPath(home, T)), 606);
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('R13 item 9: a GENUINE store-side disagreement at a non-zero min is still reconciled', () => {
  const home = tmpHome();
  const repo = makeGitRepo('reconcile-real');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const T = '22222222-3333-4444-5555-666666666666';
    const d = register(home, repo, T, T + '-session');
    seed(home, repoKey, T, 20, 'fwd-', 100000);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      s.setCursor(T, 20);
      inboxCursor.ackTo(cli.primaryCursorPath(home, T), 10);
      const r = cli.reconcileOrphanCursor(home, s, T, { id: T, cursorPath: d.cursorPath }, false);
      assert.equal(r.min, 10, 'MIN over the two STORE-SIDE namespaces only');
      assert.equal(s.cursorValue(T), 10, 'the store cursor is lowered to the agreed min — still a real reconcile');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// (10) LIVE-SIBLING WATERMARK — the end-to-end field repro
// ---------------------------------------------------------------------------

test('R13 item 10: a LIVE twin\'s backlog converges instead of re-delivering forever, and the twin keeps its own cursors', () => {
  const home = tmpHome();
  const repo = makeGitRepo('watermark');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const P = callerIdFor(home, repo);
    const T = '11111111-2222-3333-4444-555555555555';
    register(home, repo, P, 'unclaimed:' + P);
    register(home, repo, T, T + '-session'); // a REAL session -> live -> not ackable
    seed(home, repoKey, T, 606, 'fwd-', 100000);

    const batches = [];
    for (let i = 0; i < 8; i++) {
      const r = cli.run(['inbox', 'read-primary', P], mkCtx(home, repo)).result;
      const n = (r.messages || []).length;
      batches.push(n);
      assert.ok((r.liveSiblingsSkipped || []).includes(T),
        'the twin is (correctly) never acked — its own cursor is off limits');
      if (!n) break;
    }
    assert.ok(batches[0] > 0 && batches[batches.length - 1] === 0,
      'THE FIX: the drain CONVERGES. Pre-fix every batch returned 200 forever. Got: ' + JSON.stringify(batches));
    assert.equal(batches.reduce((a, b) => a + b, 0), 606,
      'and it delivers each row exactly once across the batches, never the same head row again');

    // The twin's OWN namespaces are untouched: its own reader still sees 100%.
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      assert.equal(s.cursorValue(T), 0, 'the twin\'s store cursor is NEVER advanced by the Primary');
    } finally { s.close(); }
    assert.equal(inboxCursor.readCursor(cli.primaryCursorPath(home, T)), 0,
      'nor its read-path ack file');
    const own = cli.run(['inbox', 'count', T], mkCtx(home, repo)).result;
    assert.equal(own.unreadTotal, 606, 'the twin\'s OWN reader still sees every one of its 606 rows');

    // The watermark is caller-scoped and lives beside the cursors it never touches.
    const wm = cli.siblingSeenCursorPath(home, P, T);
    assert.ok(fs.existsSync(wm), 'the caller-scoped watermark file exists: ' + wm);
    assert.equal(inboxCursor.readCursor(wm), 606, 'and records exactly how far THIS caller has been shown');

    // count agrees with read: nothing outstanding for the Primary.
    const c = cli.run(['inbox', 'count', P], mkCtx(home, repo)).result;
    assert.equal(c.unreadTotal, 0, 'count and read-primary agree once converged');
  } finally { rm(home); rm(repo); }
});

test('R13 item 10: peek-primary writes NO watermark (it must stay non-mutating)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('peek');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const P = callerIdFor(home, repo);
    const T = '11111111-2222-3333-4444-555555555555';
    register(home, repo, P, 'unclaimed:' + P);
    register(home, repo, T, T + '-session');
    seed(home, repoKey, T, 10, 'fwd-', 100000);

    cli.run(['inbox', 'peek-primary', P], mkCtx(home, repo));
    assert.ok(!fs.existsSync(cli.siblingSeenCursorPath(home, P, T)),
      'a peek advances nothing at all, watermark included');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// (1) OWNERSHIP GATE ON `unclaimed:` PROMOTION
// ---------------------------------------------------------------------------

test('R13 item 1: a Primary reading its TWIN does not stamp its own session onto the twin', () => {
  const home = tmpHome();
  const repo = makeGitRepo('promote-twin');
  try {
    const P = callerIdFor(home, repo);
    const T = '11111111-2222-3333-4444-555555555555';
    register(home, repo, P, 'unclaimed:' + P);
    register(home, repo, T, 'unclaimed:' + T);

    const readerSession = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // `inbox messages`/`read-primary`/`pull` are the verbs that reach
    // maybePromoteUnclaimed — this is the exact field vector.
    cli.run(['inbox', 'messages', T], mkCtx(home, repo, { env: { CLAUDE_CODE_SESSION_ID: readerSession } }));

    const desc = JSON.parse(fs.readFileSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces', T + '.json'), 'utf8'));
    assert.equal(desc.sessionId, 'unclaimed:' + T,
      'THE FIX: the twin is untouched. Pre-fix it was stamped with the READER\'s session id (' + readerSession + '), '
      + 'which made it read as LIVE and blocked the sibling ack gate forever');
    assert.ok(String(desc.sessionId).startsWith('unclaimed:'),
      'and it therefore still reads as NOT live (isLiveSid rejects this prefix), exactly as before the read');
  } finally { rm(home); rm(repo); }
});

test('R13 item 1: a Primary reading its OWN unclaimed row IS promoted', () => {
  const home = tmpHome();
  const repo = makeGitRepo('promote-own');
  try {
    const P = callerIdFor(home, repo);
    register(home, repo, P, 'unclaimed:' + P);
    const ownSession = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    cli.run(['inbox', 'messages', P], mkCtx(home, repo, { env: { CLAUDE_CODE_SESSION_ID: ownSession } }));
    const desc = JSON.parse(fs.readFileSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces', P + '.json'), 'utf8'));
    assert.equal(desc.sessionId, ownSession, 'carry-out (e) still works for the caller\'s OWN row');
  } finally { rm(home); rm(repo); }
});

test('R13 item 1: `inbox pull` on the caller\'s own sole-worktree row still promotes', () => {
  const home = tmpHome();
  const repo = makeGitRepo('promote-pull');
  try {
    const id = 'builder-id-abcdef01';
    register(home, repo, id, 'unclaimed:' + id); // the ONLY row for this worktree
    const ownSession = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    cli.run(['inbox', 'pull', id], mkCtx(home, repo, { env: { CLAUDE_CODE_SESSION_ID: ownSession } }));
    const desc = JSON.parse(fs.readFileSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces', id + '.json'), 'utf8'));
    assert.equal(desc.sessionId, ownSession,
      'a child pulling its own builder-id row from its own worktree is provably its owner (sole row for that worktree)');
  } finally { rm(home); rm(repo); }
});

test('R13 item 1: callerOwnsRow is the single derivation, and it refuses a foreign read target', () => {
  const home = tmpHome();
  const repo = makeGitRepo('owns');
  try {
    const P = callerIdFor(home, repo);
    const T = '11111111-2222-3333-4444-555555555555';
    register(home, repo, P, 'unclaimed:' + P);
    register(home, repo, T, 'unclaimed:' + T);
    const ctx = mkCtx(home, repo);
    assert.equal(cli.callerOwnsRow(home, P, ctx), true, 'own canonical id');
    assert.equal(cli.callerOwnsRow(home, T, ctx), false, 'a same-worktree twin is NOT the caller\'s row');
    assert.equal(cli.callerOwnsRow(home, 'never-registered', ctx), false, 'an unknown id is never owned');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// (4) THE WRITER HALF OF SEND-RECEIPT PROJECT SCOPING
// (the reader half lives in tests/hooks/devswarm-parent-reply-tracker-receipts.test.js)
// ---------------------------------------------------------------------------

test('R13 item 4: cmdSend stamps repoKey (and cwd) onto every send receipt', () => {
  const home = tmpHome();
  const repo = makeGitRepo('receipt');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const P = callerIdFor(home, repo);
    const child = 'child-row-aaaa';
    register(home, repo, P, 'sess-primary');
    register(home, repo, child, 'sess-child');

    const r = cli.run(['send', '--to', child, '--message', 'here is your answer'], mkCtx(home, repo)).result;
    assert.ok(r.ok, 'send must succeed: ' + JSON.stringify(r));

    const dir = path.join(home, '.anti-hall', 'devswarm', 'send-receipts');
    const days = fs.readdirSync(dir);
    assert.equal(days.length, 1, 'exactly one day directory');
    const names = fs.readdirSync(path.join(dir, days[0])).filter((n) => n.endsWith('.json'));
    assert.equal(names.length, 1, 'exactly one receipt');
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, days[0], names[0]), 'utf8'));

    assert.equal(receipt.repoKey, repoKey,
      'THE FIX: receipts are home-scoped but reply-state is per-project — without repoKey a send in project A '
      + 'credited (and cleared) a pending question in project B');
    assert.equal(receipt.cwd, repo, 'and the cwd is recorded as human-readable provenance');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// (11) FOLD-FORWARD MUST NOT DUPLICATE WHAT THE SURVIVOR'S READER ALREADY HAS
//
// ROOT CAUSE: foldOne's forward window starts at `s.cursorValue(row.id)` — the
// CANDIDATE's own store cursor. A live twin's ack gate is closed by design, so
// `read-primary` delivers its rows to the survivor's reader while deliberately
// leaving the twin's own cursors at 0; progress lives ONLY in the caller-scoped
// watermark (item 10). The fold cannot see that, restarts at 0, and re-forwards
// the whole consumed backlog into the survivor as fresh copies.
//
// This runs UNATTENDED: the supervisor's periodic sweep
// (companion/devswarm-supervisor.js:656-659 `runFold`) and
// `/anti-hall:update` (skills/update/scripts/update.js:1026) both call the SAME
// exported `foldMeshDuplicates` — asserted below, so neither can drift into its
// own copy of this logic.
// ---------------------------------------------------------------------------

const liveness = require(path.join(PLUGIN, 'companion/lib/liveness.js'));
function beat(home, id) {
  const p = liveness.heartbeatPathFor(id, home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ id, ts: Date.now(), sessionId: 'sess-' + id }));
}
// The reproduced field shape: BOTH rows live, the survivor anchor-shaped (so it
// wins survivor selection) and the candidate a live uuid twin (so its ack gate
// is closed and only the watermark records the survivor's progress).
function twinFixture(home, repo, repoKey, n) {
  const P = callerIdFor(home, repo);
  const T = '11111111-2222-3333-4444-555555555555';
  register(home, repo, P, 'sess-real-P'); beat(home, P);
  register(home, repo, T, 'sess-real-T'); beat(home, T);
  seed(home, repoKey, T, n, 'old-', 100000);
  seed(home, repoKey, P, 1, 'own-', 900000);
  return { P, T };
}
function drain(home, repo, P) {
  for (let i = 0; i < 10; i++) {
    const r = cli.run(['inbox', 'read-primary', P, '--ack-as-owner'], mkCtx(home, repo)).result;
    if (!(r.messages || []).length) return;
  }
  throw new Error('drain did not converge');
}

test('R13 item 11: after a converged union drain, the fold forwards ZERO and the next read returns ZERO', () => {
  const home = tmpHome();
  const repo = makeGitRepo('fold-dup');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const { P, T } = twinFixture(home, repo, repoKey, 20);
    drain(home, repo, P);

    assert.equal(inboxCursor.readCursor(cli.siblingSeenCursorPath(home, P, T)), 20,
      'precondition: the survivor consumed all 20 of the twin\'s rows through the sibling union');
    const s0 = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let pTotalBefore;
    try {
      assert.equal(s0.cursorValue(T), 0, 'precondition: the live twin\'s own cursor is (correctly) still 0');
      pTotalBefore = s0.messageCount(P);
    } finally { s0.close(); }

    const f = cli.foldMeshDuplicates(home, { repoKey, backend: 'journal', env: {}, cwd: repo });
    assert.equal(f.forwarded, 0,
      'THE FIX: nothing is forwarded — every one of those rows is already in the survivor\'s reader\'s hands. '
      + 'Pre-fix this forwarded all 20 as fresh copies');

    const s1 = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      assert.equal(s1.messageCount(P), pTotalBefore, 'the survivor\'s partition did not grow');
    } finally { s1.close(); }

    const r = cli.run(['inbox', 'read-primary', P, '--ack-as-owner'], mkCtx(home, repo)).result;
    assert.equal((r.messages || []).length, 0,
      'and the survivor\'s next read returns nothing — pre-fix it re-delivered all 20');
  } finally { rm(home); rm(repo); }
});

test('R13 item 11: rows the survivor has NOT seen still forward, stamped with origHash', () => {
  const home = tmpHome();
  const repo = makeGitRepo('fold-new');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const { P, T } = twinFixture(home, repo, repoKey, 20);
    drain(home, repo, P);
    seed(home, repoKey, T, 5, 'new-', 500000); // arrives AFTER the drain

    const f = cli.foldMeshDuplicates(home, { repoKey, backend: 'journal', env: {}, cwd: repo });
    assert.equal(f.forwarded, 5, 'the skip is scoped to already-consumed rows — genuinely new mail still forwards');

    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const copies = s.listMessages(P).filter((r) => /^(old-|new-)/.test(String(r.body || '')));
      assert.equal(copies.length, 5, 'only the 5 unseen rows were copied: ' + JSON.stringify(copies.map((c) => c.body)));
      assert.equal(copies.filter((c) => c.origHash).length, 5,
        'THE FIX (second half): every fold copy carries the ORIGINAL\'s hash, so C2\'s cross-partition dedup can recognise it. '
        + 'Pre-fix fold forwards carried origHash on 0 of them');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('R13 item 11: the candidate\'s OWN cursor never advances past a row the fold skipped', () => {
  const home = tmpHome();
  const repo = makeGitRepo('fold-lossfree');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const { P, T } = twinFixture(home, repo, repoKey, 20);
    drain(home, repo, P);
    seed(home, repoKey, T, 5, 'new-', 500000);
    cli.foldMeshDuplicates(home, { repoKey, backend: 'journal', env: {}, cwd: repo });

    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      assert.equal(s.cursorValue(T), 0,
        'LOSS-FREE: the B1(b) cursor advance is only sound for rows that now exist in the survivor. A SKIPPED row does '
        + 'not, so advancing past it would hide real mail from the twin\'s OWN reader');
      assert.equal(s.messageCount(T), 25);
    } finally { s.close(); }
    assert.equal(cli.run(['inbox', 'count', T], mkCtx(home, repo)).result.unreadTotal, 25,
      'the twin\'s own reader still sees every one of its 25 rows');
  } finally { rm(home); rm(repo); }
});

test('R13 item 11: a fold copy and its sibling original are delivered ONCE, not twice, in the same read', () => {
  const home = tmpHome();
  const repo = makeGitRepo('fold-samecall');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const { P, T } = twinFixture(home, repo, repoKey, 20);
    drain(home, repo, P);
    seed(home, repoKey, T, 5, 'new-', 500000);
    cli.foldMeshDuplicates(home, { repoKey, backend: 'journal', env: {}, cwd: repo });

    // Now the SAME logical message exists twice: as a fold copy in P's own
    // partition and as the original still in T's partition, which P also reads
    // through the sibling union. The copy was RE-ADDRESSED, so its own hash
    // cannot match the original's — only the origHash stamp can.
    const r = cli.run(['inbox', 'read-primary', P, '--ack-as-owner'], mkCtx(home, repo)).result;
    const bodies = (r.messages || []).map((m) => String(m.body));
    assert.deepEqual(bodies.slice().sort(), ['new-0', 'new-1', 'new-2', 'new-3', 'new-4'],
      'THE FIX: each message once. Pre-fix this returned all five TWICE (own copy + sibling original) because the '
      + 'dedup seed added only the copy\'s own re-addressed hash, never the original\'s: ' + JSON.stringify(bodies));
  } finally { rm(home); rm(repo); }
});

test('R13 item 11: the supervisor sweep and update.js both call the SAME exported fold (no separate code path)', () => {
  // The two UNATTENDED entry points. Asserted against the source so neither can
  // quietly grow its own copy of foldOne's forward window.
  const sup = fs.readFileSync(path.join(PLUGIN, 'companion/devswarm-supervisor.js'), 'utf8');
  const upd = fs.readFileSync(path.join(PLUGIN, 'skills/update/scripts/update.js'), 'utf8');
  assert.ok(sup.includes('devswarmCli.foldMeshDuplicates(home, { repoKey, env })'),
    'the supervisor\'s periodic runFold must delegate to devswarm.js\'s foldMeshDuplicates');
  assert.ok(upd.includes('devswarm.foldMeshDuplicates(home, { cwd, env })'),
    'update.js\'s in-process fold must delegate to the same export');
  // And there is exactly ONE implementation to inherit from.
  const src = fs.readFileSync(path.join(PLUGIN, 'scripts/devswarm.js'), 'utf8');
  assert.equal((src.match(/^function foldMeshDuplicates\(/gm) || []).length, 1,
    'exactly one foldMeshDuplicates implementation exists');
});
