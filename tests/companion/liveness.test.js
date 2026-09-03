'use strict';
// liveness: outbound-staleness detector + verdict writer. Uses a real temp HOME
// with fake timestamps; git activity is injected so the test doesn't need a repo.
// STALE requires BOTH signals idle AND a pending unread backlog. Liveness is
// uuid-SCOPED (only the target's own <sessionId>.jsonl). Workaround for #39755.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js',
));

const IDLE = 15 * 60 * 1000;
const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-liveness-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}

// Seed a workspace: a session transcript (<sessionId>.jsonl) with a chosen mtime,
// an inbox, a cursor. Returns a full descriptor (incl. sessionId) + projectDir.
function seed(home, { id, transcriptAgeMs, inboxLines, cursor, sessionId = UUID }) {
  const worktreePath = path.join(home, 'wt', id);
  fs.mkdirSync(worktreePath, { recursive: true });
  const projectDir = M.projectDirFor(worktreePath, home);
  fs.mkdirSync(projectDir, { recursive: true });
  const tp = path.join(projectDir, sessionId + '.jsonl');
  fs.writeFileSync(tp, '{}\n');
  if (typeof transcriptAgeMs === 'number') {
    const t = (Date.now() - transcriptAgeMs) / 1000;
    fs.utimesSync(tp, t, t);
  }
  const inboxPath = path.join(worktreePath, 'inbox.ndjson');
  const cursorPath = path.join(worktreePath, 'cursor');
  if (inboxLines) fs.writeFileSync(inboxPath, inboxLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (typeof cursor === 'number') fs.writeFileSync(cursorPath, String(cursor));
  return { id, worktreePath, inboxPath, cursorPath, sessionId, projectDir };
}

test('isSafeId: rejects traversal / separators / control chars / empty', () => {
  assert.strictEqual(M.isSafeId('w1'), true);
  assert.strictEqual(M.isSafeId('work-space_2.a'), true);
  assert.strictEqual(M.isSafeId(''), false);
  assert.strictEqual(M.isSafeId('..'), false);
  assert.strictEqual(M.isSafeId('../../x'), false);
  assert.strictEqual(M.isSafeId('a/b'), false);
  assert.strictEqual(M.isSafeId('a\\b'), false);
  assert.strictEqual(M.isSafeId('a b'), false);
  assert.strictEqual(M.isSafeId('a\0b'), false); // control char (NUL)
});

test('livenessPathFor throws on an unsafe id (no path escape)', () => {
  assert.throws(() => M.livenessPathFor('../../etc/x', '/home/x'));
});

test('unreadBacklog: integer cursor -> lines after it', () => {
  const { home, cleanup } = makeHome();
  try {
    const inbox = path.join(home, 'i'); const cur = path.join(home, 'c');
    fs.writeFileSync(inbox, 'a\nb\nc\n'); fs.writeFileSync(cur, '1');
    const r = M.unreadBacklog(inbox, cur);
    assert.deepStrictEqual(r, { lines: ['b', 'c'], known: true });
  } finally { cleanup(); }
});

test('unreadBacklog: {"line":N} cursor form', () => {
  const { home, cleanup } = makeHome();
  try {
    const inbox = path.join(home, 'i'); const cur = path.join(home, 'c');
    fs.writeFileSync(inbox, 'a\nb\nc\n'); fs.writeFileSync(cur, JSON.stringify({ line: 2 }));
    assert.deepStrictEqual(M.unreadBacklog(inbox, cur).lines, ['c']);
  } finally { cleanup(); }
});

test('unreadBacklog: missing/unparseable cursor -> known:false (fail-safe), tagged cursor-missing', () => {
  const { home, cleanup } = makeHome();
  try {
    const inbox = path.join(home, 'i');
    const cursorPath = path.join(home, 'nope');
    fs.writeFileSync(inbox, 'a\nb\n');
    // Regression-fix (label-taxonomy port): the prior generic known:false is
    // now tagged with WHY — an absent cursor file reads ENOENT -> 'cursor-missing',
    // additively (existing `.lines`/`.known` readers are unaffected).
    assert.deepStrictEqual(M.unreadBacklog(inbox, cursorPath), { lines: [], known: false, reason: 'cursor-missing', path: cursorPath, errno: 'ENOENT' });
  } finally { cleanup(); }
});

// -----------------------------------------------------------------------
// unreadBacklog LABEL TAXONOMY (regression fix, d1c8625 identity-family
// collapse in devswarm-parent-gate.js) — distinct `reason`s for distinct
// causes, each with the failing path/errno where available, so a caller can
// build an actionable label instead of a single generic "unreadable".
// -----------------------------------------------------------------------

test('unreadBacklog: inboxPath is null -> reason no-inbox-path (malformed/phantom descriptor), never a TypeError', () => {
  const { home, cleanup } = makeHome();
  try {
    const r = M.unreadBacklog(null, path.join(home, 'c'));
    assert.deepStrictEqual(r, { lines: [], known: false, reason: 'no-inbox-path', path: null, errno: null });
  } finally { cleanup(); }
});

test('unreadBacklog: inbox file missing (ENOENT) vs present-but-unreadable -> distinct reasons', () => {
  const { home, cleanup } = makeHome();
  try {
    const missingInbox = path.join(home, 'missing-inbox');
    const cur = path.join(home, 'c'); fs.writeFileSync(cur, '0');
    const rMissing = M.unreadBacklog(missingInbox, cur);
    assert.strictEqual(rMissing.known, false);
    assert.strictEqual(rMissing.reason, 'inbox-missing');
    assert.strictEqual(rMissing.errno, 'ENOENT');

    // A directory at the inbox path exists but readFileSync fails with EISDIR
    // — present, but genuinely unreadable as a file. Distinct from ENOENT.
    const dirAsInbox = path.join(home, 'inbox-is-a-dir');
    fs.mkdirSync(dirAsInbox);
    const rUnreadable = M.unreadBacklog(dirAsInbox, cur);
    assert.strictEqual(rUnreadable.known, false);
    assert.strictEqual(rUnreadable.reason, 'inbox-unreadable');
    assert.notStrictEqual(rUnreadable.reason, rMissing.reason, 'missing vs unreadable must be distinguishable');
  } finally { cleanup(); }
});

test('unreadBacklog: cursor unreadable/corrupt (bad JSON) -> reason cursor-unreadable', () => {
  const { home, cleanup } = makeHome();
  try {
    const inbox = path.join(home, 'i'); fs.writeFileSync(inbox, 'a\nb\n');
    const cur = path.join(home, 'c'); fs.writeFileSync(cur, 'not-json-and-not-an-int{{{');
    const r = M.unreadBacklog(inbox, cur);
    assert.strictEqual(r.known, false);
    assert.strictEqual(r.reason, 'cursor-unreadable');
  } finally { cleanup(); }
});

test('unreadBacklog: cursor value invalid (negative) -> reason cursor-invalid', () => {
  const { home, cleanup } = makeHome();
  try {
    const inbox = path.join(home, 'i'); fs.writeFileSync(inbox, 'a\nb\n');
    const cur = path.join(home, 'c'); fs.writeFileSync(cur, JSON.stringify({ line: -5 }));
    const r = M.unreadBacklog(inbox, cur);
    assert.strictEqual(r.known, false);
    assert.strictEqual(r.reason, 'cursor-invalid');
  } finally { cleanup(); }
});

test('STALE: both signals idle AND pending backlog', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'w1', transcriptAgeMs: 30 * 60 * 1000, inboxLines: [{ m: 1 }], cursor: 0 });
    const v = M.computeLiveness({
      descriptor: d, home, idleThresholdMs: IDLE,
      runners: { gitCommitTs: () => Date.now() - 40 * 60 * 1000 }, // worktree also idle 40m
    });
    assert.strictEqual(v.status, 'stale');
    assert.strictEqual(v.pending, true);
    assert.ok(v.staleSince > 0);
  } finally { cleanup(); }
});

test('uuid-SCOPED: a FRESH sibling jsonl in the same encoded dir does NOT hide staleness', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'w1s', transcriptAgeMs: 30 * 60 * 1000, inboxLines: [{ m: 1 }], cursor: 0 });
    // A busy colliding sibling session writes a fresh transcript in the SAME dir.
    const sibling = path.join(d.projectDir, 'ffffffff-1111-2222-3333-444444444444.jsonl');
    fs.writeFileSync(sibling, '{}\n'); // mtime = now
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => Date.now() - 40 * 60 * 1000 } });
    assert.strictEqual(v.status, 'stale'); // scoped to <sessionId>.jsonl, so still idle
  } finally { cleanup(); }
});

test('P1-15: no git commits yet + a fresh NESTED file edit -> NOT stale (no dir-mtime false-idle)', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'w10', transcriptAgeMs: 30 * 60 * 1000, inboxLines: [{ m: 1 }], cursor: 0 });

    // Baseline (backdated): the nested subdir already exists as part of the idle
    // worktree, and BOTH the subdir and worktreePath itself are backdated to look
    // 30m idle — matching a worktree that has been sitting untouched.
    const srcDir = path.join(d.worktreePath, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const oldT = (Date.now() - 30 * 60 * 1000) / 1000;
    fs.utimesSync(srcDir, oldT, oldT);
    fs.utimesSync(d.worktreePath, oldT, oldT);

    // "Activity": create a NEW file INSIDE the already-existing subdir. This bumps
    // src/'s OWN mtime but NOT worktreePath's — worktreePath's directory entries
    // did not change ('src' already existed) — so a reintroduced
    // `fs.stat(worktreePath).mtimeMs` fallback would STILL read this as idle. The
    // old (vacuous) fixture instead created 'src' itself as the "activity", which
    // bumps worktreePath's OWN mtime and would make even a buggy fallback read
    // fresh — masking the bug. This fixture discriminates.
    const nested = path.join(srcDir, 'a.txt');
    fs.writeFileSync(nested, 'edited just now');

    // Sanity/load-bearing precondition: worktreePath's OWN mtime is still the
    // backdated, idle one. If a dir-mtime fallback were reintroduced, it would
    // read IDLE here and — combined with the idle transcript + pending backlog —
    // WRONGLY flip the verdict below to 'stale'.
    assert.ok((Date.now() - fs.statSync(d.worktreePath).mtimeMs) > 25 * 60 * 1000, 'worktreePath itself must still read idle');

    // No commits yet -> gitCommitTs returns null (UNKNOWN activity signal).
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => null } });
    assert.strictEqual(v.status, 'alive'); // git signal UNKNOWN -> not conclusively stale (fail-safe)

    // Contrast (proves the not-stale above is due to the UNKNOWN git signal, not
    // some unrelated reason): WITH a real, idle git reading the SAME fixture IS stale.
    const v2 = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => Date.now() - 40 * 60 * 1000 } });
    assert.strictEqual(v2.status, 'stale');
  } finally { cleanup(); }
});

test('NOT stale: idle but no pending work (nothing to do)', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'w2', transcriptAgeMs: 30 * 60 * 1000, inboxLines: [{ m: 1 }], cursor: 1 }); // fully read
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => Date.now() - 40 * 60 * 1000 } });
    assert.strictEqual(v.status, 'alive');
  } finally { cleanup(); }
});

test('NOT stale: pending work but recently active (transcript fresh)', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'w3', transcriptAgeMs: 60 * 1000, inboxLines: [{ m: 1 }], cursor: 0 }); // 1m old
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => Date.now() - 40 * 60 * 1000 } });
    assert.strictEqual(v.status, 'alive');
  } finally { cleanup(); }
});

test('NOT stale: worktree signal fresh even though transcript is idle', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'w4', transcriptAgeMs: 30 * 60 * 1000, inboxLines: [{ m: 1 }], cursor: 0 });
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => Date.now() - 60 * 1000 } }); // worktree active 1m ago
    assert.strictEqual(v.status, 'alive');
  } finally { cleanup(); }
});

test('NUDGE: within window and no advance past nudgedAt -> holds `nudged`', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'n1', transcriptAgeMs: 30 * 60 * 1000, inboxLines: [{ m: 1 }], cursor: 0 });
    const now = Date.now();
    const nudgedAt = now - 60 * 1000; // nudged 1m ago
    M.writeVerdict('n1', { status: 'nudged', lastOutboundTs: nudgedAt - 1000, staleSince: 1, nudgeAttempts: 1, nudgedAt }, home);
    const v = M.computeLiveness({
      descriptor: d, home, now, idleThresholdMs: IDLE, nudgeWindowMs: 3 * 60 * 1000,
      runners: { gitCommitTs: () => now - 40 * 60 * 1000 }, // still idle, no advance
    });
    assert.strictEqual(v.status, 'nudged');
    assert.strictEqual(v.nudgeAttempts, 1);
  } finally { cleanup(); }
});

test('NUDGE: lastOutboundTs advances past nudgedAt -> clears to alive (the poke worked)', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'n2', transcriptAgeMs: 5 * 1000, inboxLines: [{ m: 1 }], cursor: 0 }); // fresh transcript
    const now = Date.now();
    const nudgedAt = now - 60 * 1000; // nudged 1m ago
    M.writeVerdict('n2', { status: 'nudged', lastOutboundTs: nudgedAt - 1000, staleSince: 1, nudgeAttempts: 1, nudgedAt }, home);
    const v = M.computeLiveness({
      descriptor: d, home, now, idleThresholdMs: IDLE, nudgeWindowMs: 3 * 60 * 1000,
      runners: { gitCommitTs: () => now - 40 * 60 * 1000 },
    });
    assert.strictEqual(v.status, 'alive');
    assert.ok(v.lastOutboundTs > nudgedAt);
  } finally { cleanup(); }
});

test('NUDGE: window elapsed with no advance -> falls through to a fresh recompute, carrying nudgeAttempts forward', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'n3', transcriptAgeMs: 30 * 60 * 1000, inboxLines: [{ m: 1 }], cursor: 0 });
    const now = Date.now();
    const nudgedAt = now - 10 * 60 * 1000; // nudged 10m ago -> the 3m window is long elapsed
    M.writeVerdict('n3', { status: 'nudged', lastOutboundTs: nudgedAt - 1000, staleSince: 1, nudgeAttempts: 1, nudgedAt }, home);
    const v = M.computeLiveness({
      descriptor: d, home, now, idleThresholdMs: IDLE, nudgeWindowMs: 3 * 60 * 1000,
      runners: { gitCommitTs: () => now - 40 * 60 * 1000 },
    });
    assert.strictEqual(v.status, 'stale'); // fell through: both signals still idle + pending
    assert.strictEqual(v.nudgeAttempts, 1); // carried forward so pokeOrEscalate can see the attempt count
  } finally { cleanup(); }
});

test('TERMINAL short-circuit: a persisted `escalated` verdict is returned unchanged, un-recomputed', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'w7', transcriptAgeMs: 30 * 60 * 1000, inboxLines: [{ m: 1 }], cursor: 0 });
    M.writeVerdict('w7', { status: 'escalated', lastOutboundTs: 5, staleSince: 5, recoveries: 3 }, home);
    let statted = false;
    const v = M.computeLiveness({
      descriptor: d, home, idleThresholdMs: IDLE,
      runners: { gitCommitTs: () => { statted = true; return Date.now() - 40 * 60 * 1000; } },
    });
    assert.strictEqual(v.status, 'escalated');   // sticky, not re-flapped to stale
    assert.strictEqual(statted, false);          // did NOT recompute liveness signals
  } finally { cleanup(); }
});

test('writeVerdict round-trips atomically and nudgeAttempts persists into computeLiveness', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'w6', transcriptAgeMs: 60 * 1000, inboxLines: [], cursor: 0 });
    M.writeVerdict('w6', { status: 'alive', lastOutboundTs: 1, staleSince: null, nudgeAttempts: 2 }, home);
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => Date.now() - 40 * 60 * 1000 } });
    assert.strictEqual(v.nudgeAttempts, 2); // carried forward from the persisted verdict
    const onDisk = JSON.parse(fs.readFileSync(M.livenessPathFor('w6', home), 'utf8'));
    assert.strictEqual(onDisk.nudgeAttempts, 2);
  } finally { cleanup(); }
});

// ============================================================================
// FIX 3 (Task 6): heartbeat = definitive proof-of-life. A FRESH heartbeat CLEARS
// the stale/escalated verdict for coordination + archive purposes (the two axes
// — "env alive" vs "agent progress" — are decoupled). See the liveness.js header.
// ============================================================================

// writeHeartbeat(home, id, ageMs) — mirror scripts/devswarm.js cmdHeartbeat's
// durable heartbeats/<id>.json write (ts = when the beat was emitted).
function writeHeartbeat(home, id, ageMs) {
  const p = M.heartbeatPathFor(id, home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const ts = Date.now() - (typeof ageMs === 'number' ? ageMs : 0);
  fs.writeFileSync(p, JSON.stringify({ id, ts, state_ts: ts, source: 'cli-heartbeat' }));
  return ts;
}

test('hasFreshHeartbeat: a recent beat is fresh, an old one and an absent one are not', () => {
  const { home, cleanup } = makeHome();
  try {
    writeHeartbeat(home, 'hb1', 60 * 1000); // 1m ago
    assert.strictEqual(M.hasFreshHeartbeat('hb1', home), true);
    writeHeartbeat(home, 'hb2', 60 * 60 * 1000); // 1h ago (past the 15m window)
    assert.strictEqual(M.hasFreshHeartbeat('hb2', home), false);
    assert.strictEqual(M.hasFreshHeartbeat('never', home), false);
  } finally { cleanup(); }
});

test('FIX 3: a FRESH heartbeat clears a persisted STALE verdict -> computeLiveness reads alive', () => {
  const { home, cleanup } = makeHome();
  try {
    // Descriptor that WOULD compute stale (both signals idle + pending backlog).
    const d = seed(home, { id: 'hbstale', transcriptAgeMs: 40 * 60 * 1000, inboxLines: [{ m: 'x' }], cursor: 0 });
    M.writeVerdict('hbstale', { status: 'stale', lastOutboundTs: 5, staleSince: 5 }, home);
    // Without a heartbeat: still stale.
    const before = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => Date.now() - 40 * 60 * 1000 } });
    assert.strictEqual(before.status, 'stale');
    // A fresh heartbeat is definitive proof of life -> clears to alive.
    writeHeartbeat(home, 'hbstale', 30 * 1000);
    const after = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => Date.now() - 40 * 60 * 1000 } });
    assert.strictEqual(after.status, 'alive');
    assert.strictEqual(after.staleSince, null);
    // pending is still surfaced (coordination axis) even though it's alive.
    assert.strictEqual(after.pending, true);
  } finally { cleanup(); }
});

test('FIX 3: a FRESH heartbeat clears even a sticky ESCALATED verdict (heartbeat proves the env recovered)', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'hbesc', transcriptAgeMs: 40 * 60 * 1000, inboxLines: [], cursor: 0 });
    M.writeVerdict('hbesc', { status: 'escalated', lastOutboundTs: 5, staleSince: 5 }, home);
    writeHeartbeat(home, 'hbesc', 30 * 1000);
    let statted = false;
    const v = M.computeLiveness({
      descriptor: d, home, idleThresholdMs: IDLE,
      runners: { gitCommitTs: () => { statted = true; return Date.now() - 40 * 60 * 1000; } },
    });
    assert.strictEqual(v.status, 'alive', 'a fresh heartbeat must recover even an escalated verdict');
    assert.strictEqual(statted, false, 'the heartbeat short-circuit needs no git recompute');
  } finally { cleanup(); }
});

test('FIX 3: a STALE heartbeat does NOT clear a stale verdict (no false proof-of-life)', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'hbold', transcriptAgeMs: 40 * 60 * 1000, inboxLines: [{ m: 'x' }], cursor: 0 });
    M.writeVerdict('hbold', { status: 'stale', lastOutboundTs: 5, staleSince: 5 }, home);
    writeHeartbeat(home, 'hbold', 60 * 60 * 1000); // 1h ago -> not fresh
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => Date.now() - 40 * 60 * 1000 } });
    assert.strictEqual(v.status, 'stale', 'an OLD heartbeat is not proof of life and must not clear staleness');
  } finally { cleanup(); }
});

// P1-7: a FUTURE heartbeat ts must NOT count as fresh. A future ts makes
// (now - ts) negative, which trivially satisfied the old `<= freshMs` check and
// would mark the workspace "provably alive" until that future time — indefinitely
// suppressing the stale gate + reaper. Guarded by isFreshBeat's `0 < ts <= now`.
test('P1-7: a FUTURE heartbeat ts is NOT fresh (hasFreshHeartbeat)', () => {
  const { home, cleanup } = makeHome();
  try {
    writeHeartbeat(home, 'fut', -60 * 60 * 1000); // ts 1h in the FUTURE
    assert.strictEqual(M.hasFreshHeartbeat('fut', home), false, 'a future heartbeat must not be treated as fresh');
    // A far-future beat is likewise not fresh.
    writeHeartbeat(home, 'fut2', -365 * 24 * 60 * 60 * 1000);
    assert.strictEqual(M.hasFreshHeartbeat('fut2', home), false);
  } finally { cleanup(); }
});

test('P1-7: isFreshBeat rejects future / non-positive ts, accepts a recent past ts', () => {
  const now = 1_000_000_000;
  const freshMs = 15 * 60 * 1000;
  assert.strictEqual(M.isFreshBeat(now - 1000, now, freshMs), true, 'a recent past ts is fresh');
  assert.strictEqual(M.isFreshBeat(now + 1000, now, freshMs), false, 'a future ts is not fresh');
  assert.strictEqual(M.isFreshBeat(now, now, freshMs), true, 'ts === now is fresh (boundary)');
  assert.strictEqual(M.isFreshBeat(0, now, freshMs), false, 'a zero ts is not fresh');
  assert.strictEqual(M.isFreshBeat(-5, now, freshMs), false, 'a negative ts is not fresh');
  assert.strictEqual(M.isFreshBeat(null, now, freshMs), false, 'an absent ts is not fresh');
  assert.strictEqual(M.isFreshBeat(now - freshMs - 1, now, freshMs), false, 'a ts past the window is not fresh');
});

test('P1-7: a FUTURE heartbeat does NOT short-circuit computeLiveness to alive (stays stale)', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'futwedge', transcriptAgeMs: 40 * 60 * 1000, inboxLines: [{ m: 'x' }], cursor: 0 });
    M.writeVerdict('futwedge', { status: 'stale', lastOutboundTs: 5, staleSince: 5 }, home);
    writeHeartbeat(home, 'futwedge', -60 * 60 * 1000); // 1h in the FUTURE
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => Date.now() - 40 * 60 * 1000 } });
    assert.strictEqual(v.status, 'stale', 'a future heartbeat must not be accepted as proof-of-life');
  } finally { cleanup(); }
});

// ============================================================================
// Item 2/3 (SkyCrew fix-wave): union-unread (NDJSON ∪ store-only mesh-direct)
// drives `pending`, and a stale-but-nonzero backlog additionally flags
// `notDraining` — a distinct, REPORT/ESCALATE-ONLY signal (never gates a kill;
// see liveness.js header). A `send --to` direct is STORE-ONLY (see companion/
// lib/devswarm-unread.js's header) — the pre-fix unreadBacklog()/NDJSON-only
// read was BLIND to it.
// ============================================================================

const devswarmStoreForLiveness = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokeyForLiveness = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

const LIVENESS_REPO_CWD = process.cwd();
const LIVENESS_REPO_KEY = repokeyForLiveness.repoKeyForWorktree(LIVENESS_REPO_CWD);

function seedStoreOnlyBacklog(home, id, count, ageMs) {
  const s = devswarmStoreForLiveness.openStore({ home, workspaceId: id, hash: LIVENESS_REPO_KEY });
  try {
    const ts = Date.now() - (typeof ageMs === 'number' ? ageMs : 0);
    for (let i = 0; i < count; i++) {
      const fields = { from: 'primary-x', to: id, type: 'direct', message: 'row ' + i, timestamp: ts };
      devswarmStoreForLiveness.appendMeshMessage(s, Object.assign({}, fields, { hash: devswarmStoreForLiveness.meshMessageHash(fields) }));
    }
  } finally { s.close(); }
}

test('UNION: a store-only mesh-direct backlog (empty NDJSON) is picked up as pending — previously invisible', () => {
  const { home, cleanup } = makeHome();
  try {
    const worktreePath = LIVENESS_REPO_CWD;
    const d = { id: 'sw1', worktreePath, inboxPath: path.join(home, 'sw1.inbox.ndjson'), cursorPath: path.join(home, 'sw1.cursor'), sessionId: null };
    fs.writeFileSync(d.inboxPath, ''); // empty durable NDJSON — the pre-fix signal reads 0 unread
    fs.writeFileSync(d.cursorPath, '0');
    seedStoreOnlyBacklog(home, 'sw1', 14, 25 * 60 * 1000); // 14 store-only directs, 25 min old (field-evidence shape)
    writeHeartbeat(home, 'sw1', 0); // fresh heartbeat -> takes the heartbeat short-circuit branch
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE });
    assert.strictEqual(v.status, 'alive', 'a fresh heartbeat still proves the env alive');
    assert.strictEqual(v.pending, true, 'the store-only backlog must be visible as pending (union, not NDJSON-only)');
    assert.strictEqual(v.notDraining, true, 'a pending backlog older than NOT_DRAINING_AGE_MS must flag notDraining');
    assert.ok(v.oldestUnreadAgeMs >= 25 * 60 * 1000 - 5000, `oldestUnreadAgeMs must reflect the seeded age; got ${v.oldestUnreadAgeMs}`);
  } finally { cleanup(); }
});

test('UNION: a FRESH store-only backlog (under NOT_DRAINING_AGE_MS) is pending but NOT flagged notDraining', () => {
  const { home, cleanup } = makeHome();
  try {
    const worktreePath = LIVENESS_REPO_CWD;
    const d = { id: 'sw2', worktreePath, inboxPath: path.join(home, 'sw2.inbox.ndjson'), cursorPath: path.join(home, 'sw2.cursor'), sessionId: null };
    fs.writeFileSync(d.inboxPath, '');
    fs.writeFileSync(d.cursorPath, '0');
    seedStoreOnlyBacklog(home, 'sw2', 1, 60 * 1000); // 1 minute old — well under the 20-min threshold
    writeHeartbeat(home, 'sw2', 0);
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE });
    assert.strictEqual(v.pending, true, 'still pending');
    assert.strictEqual(v.notDraining, false, 'a fresh backlog must not be flagged notDraining yet');
  } finally { cleanup(); }
});

test('UNION FAIL-OPEN: an unresolvable worktree (non-git) degrades to the pre-fix NDJSON-only pending signal, never throws', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seed(home, { id: 'nongit1', transcriptAgeMs: 40 * 60 * 1000, inboxLines: [{ m: 1 }], cursor: 0 }); // seed's worktreePath is NOT a git repo
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => Date.now() - 40 * 60 * 1000 } });
    assert.strictEqual(v.pending, true, 'NDJSON-only fallback must still see its own durable unread line');
    assert.strictEqual(v.notDraining, false, 'no oldest-ts signal available on the NDJSON-only fallback path -> never fabricated as notDraining');
  } finally { cleanup(); }
});

// ============================================================================
// A3 (field defect, live-verified 2026-08-28): liveness.js's OWN copy of the
// union-unread computation counted EVERY undrained store row with no sender
// attribution, so the caller's (Primary's) own just-sent messages, sitting in
// an idle target's mailbox, read as that target neglecting inbound work and
// drove `stale`. hooks/devswarm-parent-gate.js:757 already skips
// `row.sender === own.id` in its OWN local union copy for exactly this reason
// — this closes the same hole in liveness.js's independent copy, which feeds
// the PERSISTED verdict (and therefore A1's `escalated` stickiness).
//
// Fix shape: unionPendingFor gained a `pendingInbound` axis (opts.selfId
// filters out STORE-ONLY rows whose `sender === selfId`; NDJSON rows always
// count — they carry no sender field at all, fail-open toward the alarm).
// computeLiveness resolves `selfId` from the descriptor's OWN worktreePath via
// the new `resolveSelfId` (mirrors recovery.js's notifyParentEscalation
// ADDRESSEE FIX: resolveMainWorktree() then primaryWorkspaceId(), NOT a naive
// hash of a linked worktree's own root) and gates `stale` on `pendingInbound`
// instead of the raw `pending` reporting value.
//
// MUTATION-CHECK (documented per anti-hall discipline — a mutation list that
// exists only in a transcript is not evidence; each entry below was ACTUALLY
// applied to liveness.js and the suite re-run to confirm the kill):
//   1. `selfId && row.sender != null && String(row.sender) === selfId` ->
//      `selfId && row.sender != null` (drop the equality, so ANY non-null
//      sender is skipped). KILLED by "A3 guard: ... DIFFERENT (non-self,
//      non-null) sender" (a solo non-self, non-null row must still be
//      'stale'; the mutant wrongly filters it too -> 'alive'). Verified:
//      applying this mutant flips that test from pass to fail.
//   2. Dropping `row.sender != null` (so a null-sender row is compared
//      `String(null) === selfId`, always false) is a NO-OP mutant — a
//      null-sender row was never equal to a real selfId string either way,
//      so no test distinguishes it; both "A3 fix" and both "A3 guard" tests
//      still pass. NOT independently killable (semantically equivalent to
//      the unmutated code on every reachable input) — documented rather than
//      silently omitted.
//   3. Flip `continue` to an unconditional skip regardless of selfId (drop
//      ALL store-only rows unconditionally). KILLED by EITHER "A3 guard"
//      test (both rely on a store-only row surviving to drive 'stale').
//   4. Using `pending` instead of `pendingInbound` at the `stale` computation
//      (reverting the actual A3 fix). KILLED by "A3 fix" (expects 'alive',
//      mutant yields 'stale') — this is also the literal RED case, verified
//      live against the pre-fix module (see the reproduction note below).
// ============================================================================

const installIngestForLiveness = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');

// seedStoreOnlyBacklogFrom(home, id, rows) — rows: [{ sender, message }]. Same
// store-only mesh-direct shape as seedStoreOnlyBacklog above, but with an
// explicit per-row `sender` (`from`) instead of the fixed 'primary-x'.
function seedStoreOnlyBacklogFrom(home, id, rows) {
  const s = devswarmStoreForLiveness.openStore({ home, workspaceId: id, hash: LIVENESS_REPO_KEY });
  try {
    const ts = Date.now();
    rows.forEach((r, i) => {
      const fields = { from: r.sender != null ? r.sender : null, to: id, type: 'direct', message: r.message || ('row ' + i), timestamp: ts };
      devswarmStoreForLiveness.appendMeshMessage(s, Object.assign({}, fields, { hash: devswarmStoreForLiveness.meshMessageHash(fields) }));
    });
  } finally { s.close(); }
}

// buildIdleDescriptor(home, id) -> { d, oldTs }. A descriptor whose transcript
// AND worktree-activity signals are both idle past IDLE, using the REAL repo
// cwd as worktreePath (so resolveSelfId can actually resolve a primary id —
// mirrors the existing UNION tests' LIVENESS_REPO_CWD usage above).
function buildIdleDescriptor(home, id) {
  const worktreePath = LIVENESS_REPO_CWD;
  const projectDir = M.projectDirFor(worktreePath, home);
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionId = UUID;
  const tp = path.join(projectDir, sessionId + '.jsonl');
  fs.writeFileSync(tp, '{}\n');
  const oldTs = Date.now() - 40 * 60 * 1000;
  fs.utimesSync(tp, oldTs / 1000, oldTs / 1000);
  const inboxPath = path.join(home, id + '.inbox.ndjson');
  const cursorPath = path.join(home, id + '.cursor');
  fs.writeFileSync(inboxPath, '');
  fs.writeFileSync(cursorPath, '0');
  return { d: { id, worktreePath, inboxPath, cursorPath, sessionId }, oldTs };
}

test('A3 fix: rows sent by the caller\'s own (primary) id do not count as inbound neglect -> alive, not stale', () => {
  const { home, cleanup } = makeHome();
  try {
    const id = 'a3wedge';
    const { d, oldTs } = buildIdleDescriptor(home, id);
    const selfId = installIngestForLiveness.primaryWorkspaceId(
      installIngestForLiveness.resolveMainWorktree(d.worktreePath) || d.worktreePath,
    );
    assert.ok(M.isSafeId(selfId), 'selfId must resolve for the real repo worktree fixture');
    assert.strictEqual(M.resolveSelfId(d.worktreePath), selfId, 'resolveSelfId must derive the SAME primary id computeLiveness will use internally');
    // 2 store-only rows, BOTH sender === the caller's own (primary) id — exactly
    // the field-evidence shape (the Primary's own just-sent messages).
    seedStoreOnlyBacklogFrom(home, id, [{ sender: selfId }, { sender: selfId }]);
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => oldTs } });
    assert.strictEqual(v.status, 'alive', 'the caller\'s own just-sent messages must never read as the target neglecting inbound work');
    assert.strictEqual(v.pending, true, 'reporting `pending` (mailbox depth) must stay UNCHANGED — still reflects the real backlog');
  } finally { cleanup(); }
});

test('A3 guard: a row from a DIFFERENT (non-self, non-null) sender still drives stale — the fix must not widen past selfId', () => {
  const { home, cleanup } = makeHome();
  try {
    const id = 'a3guard1';
    const { d, oldTs } = buildIdleDescriptor(home, id);
    // ONLY a row sender === some OTHER child id (never null, never selfId) —
    // isolates the equality check itself: a mutant that drops the `===selfId`
    // comparison (skipping on ANY non-null sender) would wrongly filter this
    // row out too and flip this test to 'alive'.
    seedStoreOnlyBacklogFrom(home, id, [{ sender: 'some-other-child-id' }]);
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => oldTs } });
    assert.strictEqual(v.status, 'stale', 'a genuinely wedged target with real inbound backlog from someone else must still be caught');
  } finally { cleanup(); }
});

test('A3 guard: a row with NO resolvable sender (null) still drives stale — fail-open, never silently dropped', () => {
  const { home, cleanup } = makeHome();
  try {
    const id = 'a3guard2';
    const { d, oldTs } = buildIdleDescriptor(home, id);
    // ONLY a null-sender row — isolates the `row.sender != null` guard: a
    // mutant that drops it (comparing String(null) === selfId, always false)
    // still counts this row as-is, so this test alone does not distinguish
    // that mutant, but it DOES prove the null-sender row is never silently
    // treated as "the caller's own" and dropped.
    seedStoreOnlyBacklogFrom(home, id, [{ sender: null }]);
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => oldTs } });
    assert.strictEqual(v.status, 'stale', 'an unattributable row must fail OPEN toward the alarm, never be silently excluded');
  } finally { cleanup(); }
});

// RED reproduction (documented, not re-run every suite pass — see the task's
// "RED->GREEN, both outputs shown" requirement). Verified live against the
// pre-fix module content (git HEAD before this fix) with the EXACT fixture the
// GREEN test above uses:
//   RED  (pre-fix): {"status":"stale", ..., "pending":true,"notDraining":false}
//   GREEN (post-fix): {"status":"alive", ..., "pending":true,"notDraining":false}
// i.e. the fix flips ONLY `status`; `pending` (reporting) is byte-identical
// before and after, confirming computeSummary's/`pending`'s reporting semantics
// were never touched — only the NEW `pendingInbound` axis feeds `stale`.

// ============================================================================
// NEVER-LAUNCHED gap (Wave 8 Item 1): a registry row with a REAL sessionId
// that never once produced a transcript (tMtime permanently null — never
// launched at all, or died before its first turn) used to make `haveBoth`
// permanently false, so `bothIdle`/`stale` could never fire: the persisted
// verdict stayed 'alive' forever, cmdReapStale never listed it, and
// siblingAckGate (via isSiblingPartitionLive -> isDormantRow -> readActivityTs)
// never classified it dead either. The fix adds a FALLBACK, gated to fire
// ONLY when the transcript signal is entirely absent: the descriptor file's
// own mtime (workspaces/<id>.json — descriptorRegistrationTs, written once by
// the explicit `register` CREATE path and untouched again unless a live
// session's own `ensure` call rewrites it) stands in for "registration time".
// Past DEFAULT_NEVER_LAUNCHED_MS (6h — same wide-default philosophy as this
// file's own DEFAULT_ROSTER_IDLE_MS), the row is treated as dead.
//
// MUTATION LIST (documented here, applied against an ISOLATED SCRATCH COPY of
// companion/lib/liveness.js — never the live file, matching this repo's
// established mutation-test pattern in tests/scripts/lib/devswarm-mutant-kit.js):
//   M1 — computeLiveness / cmdReapStale's path: revert
//        `const stale = (bothIdle || neverLaunchedDead) && unionInfo.pendingInbound;`
//        back to the pre-fix `const stale = bothIdle && unionInfo.pendingInbound;`
//        (neverLaunchedDead computed but never consulted — the exact pre-fix gap).
//   M2 — readActivityTs / siblingAckGate's path: remove the `if (best === 0) { ... }`
//        descriptorRegistrationTs fallback block entirely, reverting to the
//        pre-fix `return { ts: best > 0 ? best : null, sawTranscript };` with no
//        registration-ts rescue.
// Each mutant is proven non-vacuous below: applied to a scratch copy, the
// SAME fixture that passes GREEN against the live (fixed) module goes RED
// against the mutant (reproducing the original defect), then the live module
// is proven byte-untouched.

const mutantKit = require(path.join(__dirname, '..', 'scripts', 'lib', 'devswarm-mutant-kit.js'));
const LIVE_LIVENESS_PATH = path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js',
);
const LIVE_TARGET_SESSION_PATH = path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'target-session.js',
);

// createLivenessCopy: an isolated scratch copy of JUST liveness.js + its one
// dependency (target-session.js, itself node-builtins-only — see its own
// header). Mirrors devswarm-mutant-kit.js's createCopy pattern (own tmp dir,
// mutate ONLY the copy, discard afterward) but scoped to this one module
// instead of the whole scripts/devswarm.js + companion/ + hooks/ tree, since
// computeLiveness/readActivityTs are exercised directly here, not via the CLI.
function createLivenessCopy(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), (prefix || 'anti-hall-liveness-mutant') + '-'));
  const libDir = path.join(dir, 'lib');
  fs.mkdirSync(libDir);
  const livenessPath = path.join(libDir, 'liveness.js');
  fs.copyFileSync(LIVE_LIVENESS_PATH, livenessPath);
  fs.copyFileSync(LIVE_TARGET_SESSION_PATH, path.join(libDir, 'target-session.js'));
  return { dir, livenessPath };
}

// seedNeverLaunched: a registry row with a REAL (non-empty, non-`unclaimed:`)
// sessionId whose worktree/inbox/cursor exist but whose projectDir/transcript
// NEVER gets created — the never-launched shape. The descriptor file
// (workspaces/<id>.json, what descriptorRegistrationTs stats) is written with
// its mtime backdated by `registrationAgeMs` when given, standing in for "this
// is how long ago `register` ran and nothing has touched the file since".
function seedNeverLaunched(home, { id, registrationAgeMs, inboxLines, cursor, sessionId }) {
  const worktreePath = path.join(home, 'wt', id);
  fs.mkdirSync(worktreePath, { recursive: true });
  const inboxPath = path.join(worktreePath, 'inbox.ndjson');
  const cursorPath = path.join(worktreePath, 'cursor');
  if (inboxLines) fs.writeFileSync(inboxPath, inboxLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (typeof cursor === 'number') fs.writeFileSync(cursorPath, String(cursor));
  const descPath = M.descriptorPathFor(id, home);
  fs.mkdirSync(path.dirname(descPath), { recursive: true });
  fs.writeFileSync(descPath, JSON.stringify({ id, worktreePath, sessionId: sessionId || ('real-sid-' + id) }));
  if (typeof registrationAgeMs === 'number') {
    const t = (Date.now() - registrationAgeMs) / 1000;
    fs.utimesSync(descPath, t, t);
  }
  return { id, worktreePath, inboxPath, cursorPath, sessionId: sessionId || ('real-sid-' + id) };
}

const SEVEN_HOURS = 7 * 60 * 60 * 1000; // > DEFAULT_NEVER_LAUNCHED_MS (6h)
const FIVE_MINUTES = 5 * 60 * 1000; // << DEFAULT_NEVER_LAUNCHED_MS

test('NEVER-LAUNCHED GREEN: a real-sessionId row with NO transcript, registered past the deadline, becomes stale (reapable/ack-eligible)', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seedNeverLaunched(home, {
      id: 'w-never-old', registrationAgeMs: SEVEN_HOURS, inboxLines: [{ m: 1 }], cursor: 0,
    });
    // Worst case: no git signal either (a brand-new worktree with no commits
    // yet) — proves the fallback fires even without wMtime's help.
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => null } });
    assert.strictEqual(v.status, 'stale', 'a row that never produced a transcript, registered 7h ago (> 6h deadline), must be classified dead');
    assert.ok(v.staleSince > 0);
  } finally { cleanup(); }
});

test('NEVER-LAUNCHED GUARD (GREEN): a real-sessionId row with NO transcript, registered RECENTLY, stays alive (protected)', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seedNeverLaunched(home, {
      id: 'w-never-recent', registrationAgeMs: FIVE_MINUTES, inboxLines: [{ m: 1 }], cursor: 0,
    });
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => null } });
    assert.strictEqual(v.status, 'alive', 'a row registered only 5 minutes ago must NOT be reaped — normal register-to-first-turn gap');
  } finally { cleanup(); }
});

test('NEVER-LAUNCHED GUARD (GREEN): a missing/unreadable registration timestamp fails safe to alive, never fabricated', () => {
  const { home, cleanup } = makeHome();
  try {
    // No descriptor file written at all (id never even ran through
    // seedNeverLaunched's descriptor write) — descriptorRegistrationTs must
    // return null, and computeLiveness must never treat that as "old enough".
    const worktreePath = path.join(home, 'wt', 'w-never-nodesc');
    fs.mkdirSync(worktreePath, { recursive: true });
    const inboxPath = path.join(worktreePath, 'inbox.ndjson');
    fs.writeFileSync(inboxPath, JSON.stringify({ m: 1 }) + '\n');
    const d = { id: 'w-never-nodesc', worktreePath, inboxPath, cursorPath: path.join(worktreePath, 'cursor'), sessionId: 'real-sid' };
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => null } });
    assert.strictEqual(v.status, 'alive', 'undetermined registration time must never mean "consume the mail"');
  } finally { cleanup(); }
});

test('NEVER-LAUNCHED GUARD (GREEN): a row WITH a transcript is unaffected by an old descriptor mtime (fallback only fires when the signal is entirely absent)', () => {
  const { home, cleanup } = makeHome();
  try {
    // Same 7h-old descriptor as the dead case above, but this row DID produce
    // a transcript (fresh) — must go through the EXISTING bothIdle path,
    // completely untouched by the never-launched fallback.
    const d = seed(home, { id: 'w-has-transcript', transcriptAgeMs: 60 * 1000, inboxLines: [{ m: 1 }], cursor: 0 });
    const descPath = M.descriptorPathFor(d.id, home);
    fs.mkdirSync(path.dirname(descPath), { recursive: true });
    fs.writeFileSync(descPath, JSON.stringify({ id: d.id, worktreePath: d.worktreePath, sessionId: d.sessionId }));
    const t = (Date.now() - SEVEN_HOURS) / 1000;
    fs.utimesSync(descPath, t, t);
    const v = M.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => Date.now() - 60 * 1000 } });
    assert.strictEqual(v.status, 'alive', 'a fresh transcript must win — the never-launched fallback must never override a row that ever ran');
  } finally { cleanup(); }
});

test('NEVER-LAUNCHED mutation check M1 (computeLiveness): reverting `stale` to ignore neverLaunchedDead reproduces the pre-fix cmdReapStale gap (RED), live source untouched (GREEN elsewhere)', () => {
  const liveBefore = fs.readFileSync(LIVE_LIVENESS_PATH, 'utf8');
  const copy = createLivenessCopy('anti-hall-liveness-m1');
  try {
    mutantKit.mutate(
      copy.livenessPath,
      'const stale = (bothIdle || neverLaunchedDead) && unionInfo.pendingInbound;',
      'const stale = bothIdle && unionInfo.pendingInbound;',
    );
    const mutated = mutantKit.requireFresh(copy.livenessPath);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-liveness-m1-'));
    try {
      const d = seedNeverLaunched(home, {
        id: 'w-m1', registrationAgeMs: SEVEN_HOURS, inboxLines: [{ m: 1 }], cursor: 0,
      });
      const v = mutated.computeLiveness({ descriptor: d, home, idleThresholdMs: IDLE, runners: { gitCommitTs: () => null } });
      // RED: the SAME fixture that is 'stale' against the live (fixed)
      // module (see the GREEN test above) stays 'alive' forever against the
      // mutant — the exact pre-fix defect (visible-but-never-consumable).
      assert.strictEqual(v.status, 'alive', 'RED: with the fix reverted, a 7h-old never-launched row is (wrongly) never classified dead');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  } finally {
    mutantKit.discardCopy(copy);
    assert.equal(fs.readFileSync(LIVE_LIVENESS_PATH, 'utf8'), liveBefore, 'live companion/lib/liveness.js must never be modified by a mutation test');
  }
});

test('NEVER-LAUNCHED mutation check M2 (readActivityTs): removing the descriptorRegistrationTs fallback reproduces the pre-fix siblingAckGate gap (RED), live source untouched (GREEN elsewhere)', () => {
  const liveBefore = fs.readFileSync(LIVE_LIVENESS_PATH, 'utf8');
  const copy = createLivenessCopy('anti-hall-liveness-m2');
  try {
    mutantKit.mutate(
      copy.livenessPath,
      "  if (best === 0) {\n    try {\n      const rt = descriptorRegistrationTs(id, home, F);\n      if (Number.isFinite(rt) && rt > 0) best = rt;\n    } catch (_) {}\n  }\n  return { ts: best > 0 ? best : null, sawTranscript };",
      '  return { ts: best > 0 ? best : null, sawTranscript };',
    );
    const mutated = mutantKit.requireFresh(copy.livenessPath);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-liveness-m2-'));
    try {
      const d = seedNeverLaunched(home, { id: 'w-m2', registrationAgeMs: SEVEN_HOURS });
      const r = mutated.readActivityTs({ id: d.id, worktreePath: d.worktreePath, sessionId: d.sessionId }, home, {});
      // RED: with the fallback removed, a never-launched row (no heartbeat,
      // no transcript, no verdict) reads back `ts: null` forever — the exact
      // pre-fix input that made isDormantRow (and therefore
      // isSiblingPartitionLive/siblingAckGate) fail open to "live" forever.
      assert.strictEqual(r.ts, null, 'RED: with the fallback removed, readActivityTs never resolves a ts for a never-launched row, no matter its age');
      assert.strictEqual(mutated.isDormantRow({ id: d.id, worktreePath: d.worktreePath, sessionId: d.sessionId }, home, {}), false,
        'RED: isDormantRow (siblingAckGate\'s underlying rule) still reads this 7h-old never-launched row as NOT dormant');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  } finally {
    mutantKit.discardCopy(copy);
    assert.equal(fs.readFileSync(LIVE_LIVENESS_PATH, 'utf8'), liveBefore, 'live companion/lib/liveness.js must never be modified by a mutation test');
  }
});

test('NEVER-LAUNCHED GREEN (readActivityTs/isDormantRow — siblingAckGate\'s path): a never-launched row past the deadline reads dormant on the LIVE (fixed) module', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = seedNeverLaunched(home, { id: 'w-live-m2', registrationAgeMs: SEVEN_HOURS });
    const r = M.readActivityTs({ id: d.id, worktreePath: d.worktreePath, sessionId: d.sessionId }, home, {});
    assert.ok(Number.isFinite(r.ts), 'GREEN: the live module resolves a ts from the descriptor registration fallback');
    assert.strictEqual(r.sawTranscript, false);
    assert.strictEqual(
      M.isDormantRow({ id: d.id, worktreePath: d.worktreePath, sessionId: d.sessionId }, home, {}),
      true,
      'GREEN: isDormantRow (siblingAckGate\'s underlying rule) now classifies this row dormant',
    );
  } finally { cleanup(); }
});
