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
