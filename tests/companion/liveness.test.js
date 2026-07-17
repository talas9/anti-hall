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

test('unreadBacklog: missing/unparseable cursor -> known:false (fail-safe)', () => {
  const { home, cleanup } = makeHome();
  try {
    const inbox = path.join(home, 'i');
    fs.writeFileSync(inbox, 'a\nb\n');
    assert.deepStrictEqual(M.unreadBacklog(inbox, path.join(home, 'nope')), { lines: [], known: false });
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
