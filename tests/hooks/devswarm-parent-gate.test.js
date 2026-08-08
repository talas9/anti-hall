'use strict';
// devswarm-parent-gate (Stop hook, Primary only). Forces a bounded acknowledgement
// when a DevSwarm child workspace still has unread inbox backlog past its cursor OR
// a stale/escalated supervisor verdict. Reads ONLY already-written files (inbox +
// cursor + per-workspace verdict) — never computeLiveness / git on the Stop path.
// Inert (no output, exit 0) for children, non-DevSwarm sessions, or when no
// descriptors/inbox exist. Loop-safe via a per-SET forced-ack cap. Fail-open.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const cp = require('node:child_process');
const os = require('node:os');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const replyStateLib = require('../../plugins/anti-hall/companion/lib/devswarm-reply-state.js');

const HOOK = 'devswarm-parent-gate.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' }; // active + Primary (no SOURCE_BRANCH)

// REPO_CWD/REPO_HASH/REPO_KEY/OWN_ID — the SAME per-worktree Primary-id
// convention devswarm-parent-inbox.test.js's STALE section already uses:
// passing this test process's own cwd (a real git checkout) lets the hook's
// pure-fs worktree resolution land on this exact hash, so a summary written
// under it is found. v0.57 mesh (D1/D24): the own-unread summary is now
// keyed by REPO_KEY (readOwnUnread prefers repoKey, falling back to the
// legacy REPO_HASH only when repoKey is unresolvable) — REPO_HASH is kept
// for OWN_ID (D19: the Primary's addressing/partition id is NOT re-keyed).
const REPO_CWD = process.cwd();
const REPO_HASH = installIngest.worktreeHash(REPO_CWD);
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);
const OWN_ID = 'primary-' + REPO_HASH;

// makeGitRepo() -> a real, minimal git repo dir (git-common-dir resolution
// needs a real .git; no commit needed for `rev-parse --git-common-dir`).
// Mirrors tests/companion/install-ingest-repokey.test.js's own helper.
function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-gate-36-repo-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  return dir;
}

function stopPayload(sessionId, withCwd, explicitCwd) {
  const p = { hook_event_name: 'Stop', session_id: sessionId || 'sess-1' };
  if (explicitCwd !== undefined) p.cwd = explicitCwd;
  else if (withCwd) p.cwd = REPO_CWD;
  return p;
}

// writeOwnSummary(home, unread, urgencyMax, pendingQuestions, pendingQuestionsTruncated)
// — the Primary's OWN unread, written to the SAME per-project summary
// projection path the hook reads (v0.57 mesh: summaries/<REPO_KEY>.json ->
// workspaces[primary-<hash>].unread). `pendingQuestions` (§4.4) is the
// per-workspace projected array of `{from, ts, seq}` structural questions —
// same shape computeSummary produces. `pendingQuestionsTruncated` (P2 fix)
// is the store's own `{cap, kept, dropped}` truncation-signal object —
// computeSummary stamps it on the workspace entry ONLY when its backstop cap
// actually bit; this param lets a test seed that exact shape directly rather
// than seeding 200+ senders through the real store.
function writeOwnSummary(home, unread, urgencyMax, pendingQuestions, pendingQuestionsTruncated) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  const entry = { unread };
  if (urgencyMax !== undefined) entry.urgencyMax = urgencyMax;
  if (pendingQuestions !== undefined) entry.pendingQuestions = pendingQuestions;
  if (pendingQuestionsTruncated !== undefined) entry.pendingQuestionsTruncated = pendingQuestionsTruncated;
  fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), JSON.stringify({ workspaces: { [OWN_ID]: entry } }));
}

// Seed a workspace: descriptor + optional inbox/cursor + optional verdict, all
// under the fixture HOME's ~/.anti-hall/devswarm tree.
function seedWorkspace(home, id, opts = {}) {
  const root = path.join(home, '.anti-hall', 'devswarm');
  const wsDir = path.join(root, 'workspaces');
  const inboxPath = path.join(root, 'inbox', id + '.ndjson');
  const cursorPath = path.join(root, 'cursor', id + '.json');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });

  const descriptor = {
    id,
    worktreePath: opts.worktreePath !== undefined ? opts.worktreePath : path.join(home, 'wt', id),
    sessionId: 'child-' + id,
    inboxPath,
    cursorPath,
  };
  if (opts.repoId !== undefined) descriptor.repoId = opts.repoId;
  fs.writeFileSync(path.join(wsDir, id + '.json'), JSON.stringify(descriptor));

  if (opts.messages != null) {
    fs.writeFileSync(inboxPath, opts.messages.map((m) => JSON.stringify({ m })).join('\n') + '\n');
  }
  // messageRows — full control over each inbox line's raw JSON (e.g. a
  // `createdAt` timestamp), used by the message-freshness (P0) tests below
  // instead of the bare `{m}` shape `opts.messages` writes.
  if (opts.messageRows != null) {
    fs.writeFileSync(inboxPath, opts.messageRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  // rawLines — literal (possibly non-JSON) line content, for malformed-inbox tests.
  if (opts.rawLines != null) {
    fs.writeFileSync(inboxPath, opts.rawLines.join('\n') + '\n');
  }
  if (opts.cursor != null) fs.writeFileSync(cursorPath, String(opts.cursor));
  if (opts.verdict != null) {
    const lp = path.join(root, 'liveness', id + '.json');
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    fs.writeFileSync(lp, JSON.stringify(opts.verdict));
  }
  return { inboxPath, cursorPath };
}

function run(home, payload, env) {
  return testHookRaw(HOOK, JSON.stringify(payload || stopPayload()), {
    home,
    env: { ...PRIMARY_ENV, ...(env || {}) },
  });
}

test('BLOCK: unread backlog past cursor -> decision:block naming the workspace + clear path', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b', 'c'], cursor: 1 }); // 2 unread
    const r = run(h.home);
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.ok(r.json, `stdout must be JSON; stdout=${r.stdout}`);
    assert.strictEqual(r.json.decision, 'block');
    assert.match(r.json.reason, /ws1/);
    assert.match(r.json.reason, /2 unread/);
    // C1 fix: the prescribed clear path is now the dual-backend CLI verb
    // (`inbox read-primary <id>`), NOT the NDJSON-only advanceCursor primitive
    // in devswarm-inbox-cursor.js (which never clears a store-backed row's
    // unread projection — the gate used to refire forever demanding it).
    assert.match(r.json.reason, /inbox read-primary/, 'must state the read/ack clear path');
    assert.match(r.json.reason, /devswarm-parent-gate/, 'must name the skip-guard escape');
  } finally { h.cleanup(); }
});

test('BLOCK: stale verdict with no unread -> blocks on the liveness axis', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a'], cursor: 1, verdict: { status: 'stale' } });
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /stale/);
  } finally { h.cleanup(); }
});

test('BLOCK: escalated verdict counts as blocking (P1-C: same severity as stale)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a'], cursor: 1, verdict: { status: 'escalated' } });
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /escalated/);
  } finally { h.cleanup(); }
});

test('NO-OP: unread fully acked AND alive verdict -> no block', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 2, verdict: { status: 'alive' } });
    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `expected no output; got ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('INERT: no descriptors at all -> no block (P1-D)', () => {
  const h = makeHome();
  try {
    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  } finally { h.cleanup(); }
});

test('NO-OP: child workspace (DEVSWARM_SOURCE_BRANCH set) -> never gates', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 }); // unread present
    const r = run(h.home, stopPayload(), { DEVSWARM_SOURCE_BRANCH: 'feat/x' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', 'a child must never run the parent gate');
  } finally { h.cleanup(); }
});

test('NO-OP: DevSwarm inactive (no env) -> no block', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 });
    const r = testHookRaw(HOOK, JSON.stringify(stopPayload()), { home: h.home }); // no PRIMARY_ENV
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  } finally { h.cleanup(); }
});

test('SKIP: user-consented skip.json disables the gate', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 });
    h.writeSkip({ 'devswarm-parent-gate': Date.now() + 60000 });
    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  } finally { h.cleanup(); }
});

// §4.4 requirement D: cap-exhaustion is now an ESCALATION block (not a silent
// return) on the FIRST pass where effectiveBlocks === cap, and only goes
// quiet on the NEXT pass after that (effectiveBlocks > cap) — bounding total
// blocks-per-signature at cap+1, never a fully-silent give-up.
test('LOOP-SAFE: same blocking SET escalates at the cap, then goes quiet (bounded at cap+1 blocks)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 }); // 2 unread, unchanging
    const env = { ANTIHALL_DEVSWARM_PARENT_GATE_CAP: '2' };
    const p = stopPayload('loopsess');
    const r1 = run(h.home, p, env); assert.strictEqual(r1.json && r1.json.decision, 'block', 'block #1');
    const r2 = run(h.home, p, env); assert.strictEqual(r2.json && r2.json.decision, 'block', 'block #2');
    const r3 = run(h.home, p, env); // effectiveBlocks === cap (2) -> escalation, not silence
    assert.strictEqual(r3.json && r3.json.decision, 'block', 'escalation pass #3 must still block');
    assert.match(r3.json.reason, /DEVSWARM ESCALATION/, 'must use escalation wording, not the normal nag');
    const r4 = run(h.home, p, env); // effectiveBlocks > cap -> now goes quiet
    assert.strictEqual(r4.status, 0);
    assert.strictEqual(r4.stdout, '', 'must go quiet the pass AFTER the escalation');
  } finally { h.cleanup(); }
});

test('CAP RESET: a CHANGED unread set re-opens the budget after being capped', () => {
  const h = makeHome();
  try {
    const seeded = seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 });
    const env = { ANTIHALL_DEVSWARM_PARENT_GATE_CAP: '2' };
    const p = stopPayload('resetsess');
    run(h.home, p, env); // block #1
    run(h.home, p, env); // block #2
    const escalated = run(h.home, p, env); // block #3 -> escalation
    assert.match(escalated.json && escalated.json.reason, /DEVSWARM ESCALATION/, 'pass #3 escalates');
    const capped = run(h.home, p, env); // block #4 -> now quiet
    assert.strictEqual(capped.stdout, '', 'capped (quiet) before change');
    // A new message arrives -> unread count changes -> signature changes -> reset.
    fs.appendFileSync(seeded.inboxPath, JSON.stringify({ m: 'c' }) + '\n');
    const after = run(h.home, p, env);
    assert.strictEqual(after.json && after.json.decision, 'block', 'a changed set must re-block');
    assert.match(after.json.reason, /3 unread/);
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: empty stdin -> exit 0, no crash', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(r.status, 0);
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: malformed JSON stdin -> exit 0, no crash', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{bad', { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(r.status, 0);
  } finally { h.cleanup(); }
});

// ---- Primary's OWN inbound unread (#34) — the parent is gated on its OWN
// unread too, not just children's. Resolved from the same summary projection
// devswarm-parent-inbox.js reads (workspaces[primary-<hash>].unread); requires
// cwd in the payload to resolve the worktree hash (falls back to process.cwd()
// when absent, exercised by the last test below).

test('BLOCK: Primary\'s own summary-projected unread -> gated, blocking set includes it, imperative wording + read-primary clear path', () => {
  const h = makeHome();
  try {
    writeOwnSummary(h.home, 3);
    const r = run(h.home, stopPayload('ownsess', true));
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.ok(r.json, `stdout must be JSON; stdout=${r.stdout}`);
    assert.strictEqual(r.json.decision, 'block');
    assert.match(r.json.reason, /YOU \(the Primary\) have 3 unread parent\/peer message\(s\)/);
    assert.match(r.json.reason, /STOP and read them FIRST/);
    assert.ok(r.json.reason.includes('inbox read-primary ' + OWN_ID), `must state the read-primary clear path; reason=${r.json.reason}`);
    assert.match(r.json.reason, /devswarm-parent-gate/, 'must still name the skip-guard escape');
  } finally { h.cleanup(); }
});

test('BLOCK: own-unread present with ZERO child descriptors still gates (inertness override)', () => {
  const h = makeHome();
  try {
    writeOwnSummary(h.home, 1);
    const r = run(h.home, stopPayload('sess-zero-desc', true));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /1 unread parent\/peer message/);
  } finally { h.cleanup(); }
});

test('NO-OP: own-unread absent (no summary) AND no descriptors -> inert (P1-D preserved)', () => {
  const h = makeHome();
  try {
    const r = run(h.home, stopPayload('sess-inert', true));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  } finally { h.cleanup(); }
});

// C3 FIX: a malformed (corrupt-but-EXISTING) own summary used to be silently
// swallowed into "no own-unread" — the exact polarity bug fixed here. It must
// now surface as an explicit UNKNOWN own-status entry (never the old "YOU
// (the Primary) have N unread..." wording, which implies a KNOWN count), in
// addition to the child-only unread still gating as before.
test('C3 FIX: malformed own summary.json -> surfaces as an explicit UNKNOWN own-status (never silently "no own-unread"); child-only unread still gates', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 });
    const dir = path.join(h.home, '.anti-hall', 'devswarm', 'summaries');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), '{not json');
    const r = run(h.home, stopPayload('sess-badsum', true));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /ws1/);
    assert.ok(!/YOU \(the Primary\) have \d+ unread/.test(r.json.reason), `a corrupt summary must never be reported as a KNOWN unread count; reason=${r.json.reason}`);
    assert.match(r.json.reason, /YOUR OWN inbound status could not be confirmed/, `must surface the own-summary as UNKNOWN; reason=${r.json.reason}`);
    assert.match(r.json.reason, /UNKNOWN/, `must explicitly say UNKNOWN, not imply a known zero; reason=${r.json.reason}`);
    assert.ok(r.json.reason.includes('inbox read-primary ' + OWN_ID), `must still state the read-primary check path; reason=${r.json.reason}`);
  } finally { h.cleanup(); }
});

test('LOOP-SAFE: own-unread blocking set escalates at the cap, then goes quiet (cap machinery still terminates)', () => {
  const h = makeHome();
  try {
    writeOwnSummary(h.home, 2);
    const env = { ANTIHALL_DEVSWARM_PARENT_GATE_CAP: '2' };
    const p = stopPayload('loop-own', true);
    const r1 = run(h.home, p, env); assert.strictEqual(r1.json && r1.json.decision, 'block', 'block #1');
    const r2 = run(h.home, p, env); assert.strictEqual(r2.json && r2.json.decision, 'block', 'block #2');
    const r3 = run(h.home, p, env); // effectiveBlocks === cap (2) -> escalation, not silence
    assert.strictEqual(r3.json && r3.json.decision, 'block', 'escalation pass #3 must still block');
    assert.match(r3.json.reason, /DEVSWARM ESCALATION/, 'must use escalation wording');
    const r4 = run(h.home, p, env); // effectiveBlocks > cap -> now goes quiet
    assert.strictEqual(r4.status, 0);
    assert.strictEqual(r4.stdout, '', 'must go quiet the pass AFTER the escalation for own-unread too');
  } finally { h.cleanup(); }
});

test('CHILD-ONLY: no cwd in payload (own-unread unresolvable) -> child-only unread still gates exactly as before', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b', 'c'], cursor: 1 }); // 2 unread
    const r = run(h.home); // default stopPayload(): no cwd field at all
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /ws1/);
    assert.match(r.json.reason, /2 unread/);
    assert.ok(!/YOU \(the Primary\)/.test(r.json.reason), 'no own-unread segment when no summary exists for the resolved worktree');
  } finally { h.cleanup(); }
});

// ---- #36 cross-project-bleed fix: STRUCTURAL repoKey-scoped descriptor
// enumeration (D29 — REPLACES the spoofable v0.56 env filter). This loop
// builds its blocking SET from raw machine-global readDescriptors + readUnread
// (NOT the per-project summary), so it needs its OWN explicit
// repoKeyForWorktree(d.worktreePath) === repoKeyForWorktree(cwd) filter —
// env DEVSWARM_REPO_ID is spoofable and no longer consulted at all. Fail-open:
// a descriptor is excluded ONLY when BOTH sides resolve a repoKey AND they
// differ; a null/unresolvable repoKey on either side keeps the descriptor.

test('#36 EXCLUDE: a descriptor whose worktree resolves to a DIFFERENT repoKey is not gated on', () => {
  const h = makeHome();
  const otherRepo = makeGitRepo();
  try {
    assert.notEqual(repokey.repoKeyForWorktree(otherRepo), REPO_KEY, 'precondition: genuinely different repoKey');
    seedWorkspace(h.home, 'other-project', { messages: ['a', 'b'], cursor: 0, worktreePath: otherRepo });
    const r = run(h.home); // cwd falls back to process.cwd() = REPO_CWD -> selfKey = REPO_KEY
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', 'a foreign-project descriptor must never block this session');
  } finally { h.cleanup(); fs.rmSync(otherRepo, { recursive: true, force: true }); }
});

test('#36 INCLUDE (same repoKey): a descriptor whose worktree resolves to the SAME repoKey still gates', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'same-project', { messages: ['a', 'b'], cursor: 0, worktreePath: REPO_CWD });
    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /same-project/);
  } finally { h.cleanup(); }
});

test('#36 INCLUDE (fail-open): a descriptor whose worktreePath is unresolvable (non-git) still gates', () => {
  const h = makeHome();
  try {
    // The default seedWorkspace worktreePath (home/wt/<id>) does not exist and
    // is not a git repo -> repoKeyForWorktree resolves null -> filter disabled.
    seedWorkspace(h.home, 'legacy-desc', { messages: ['a', 'b'], cursor: 0 });
    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block', 'an unresolvable-worktree descriptor must not vanish from the gate');
    assert.match(r.json.reason, /legacy-desc/);
  } finally { h.cleanup(); }
});

test('#36 INCLUDE (fail-open): session cwd is unresolvable (non-git) -> filter disabled, descriptor still gates', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'child-x', { messages: ['a', 'b'], cursor: 0, worktreePath: REPO_CWD });
    const bogusCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-gate-36-nogit-'));
    try {
      assert.strictEqual(repokey.repoKeyForWorktree(bogusCwd), null, 'precondition: session cwd must be genuinely non-git');
      const r = run(h.home, stopPayload('sess-nogit', false, bogusCwd));
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.json && r.json.decision, 'block', 'an unresolvable session repoKey must not blind the gate to real descriptors');
      assert.match(r.json.reason, /child-x/);
    } finally { fs.rmSync(bogusCwd, { recursive: true, force: true }); }
  } finally { h.cleanup(); }
});

// env DEVSWARM_REPO_ID is no longer consulted for #36 at all — a mismatching
// env value must NOT exclude a same-repoKey descriptor (the derived key is
// ground truth; env was always spoofable, D29).
test('#36 env DEVSWARM_REPO_ID is IGNORED: a mismatching env repoId does not exclude a same-repoKey descriptor', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'same-project', { messages: ['a', 'b'], cursor: 0, worktreePath: REPO_CWD, repoId: 'repo-999' });
    const r = run(h.home, stopPayload(), { DEVSWARM_REPO_ID: 'repo-1' }); // deliberately mismatching env
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block', 'the structural repoKey match must win over any env repoId mismatch');
    assert.match(r.json.reason, /same-project/);
  } finally { h.cleanup(); }
});

test('#36 INCLUDE: a descriptor with a MATCHING repoId still gates', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'same-project', { messages: ['a', 'b'], cursor: 0, repoId: 'repo-1' });
    const r = run(h.home); // PRIMARY_ENV: repo-1
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /same-project/);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// v0.59 "self-wake" — TEXT-ONLY re-assertion, mirroring devswarm-child-gate.js's
// reuse pattern exactly: the MAILBOX WAKE line rides along on this SAME neglect-
// forced-ack, bounded by the SAME per-SET {sig, blocks} cap this file already
// has. No new state file, no new field. The Primary is the LONGEST-lived DevSwarm
// session (a child is spun for one matter and archived; the Primary plausibly
// outlives a cron job's 7-day auto-expiry), so it needs this renewal path most —
// but it only fires while the gate is ALREADY blocking for a real neglect reason;
// it is silent on the healthy/no-neglect path (that would need an independent,
// un-keyed counter — new schema, forbidden).
// ---------------------------------------------------------------------------

const CLAUDE_PRIMARY_ENV = { DEVSWARM_AI_AGENT: 'claude' };
const CODEX_PRIMARY_ENV = { DEVSWARM_AI_AGENT: 'codex' };

test('WAKE RE-ASSERT: Claude Primary -> the neglect block reason also carries the CronCreate wake directive (read-primary drain)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b', 'c'], cursor: 1 }); // 2 unread
    const r = run(h.home, stopPayload(), CLAUDE_PRIMARY_ENV);
    assert.strictEqual(r.json && r.json.decision, 'block');
    const reason = r.json.reason;
    assert.ok(/MAILBOX WAKE/.test(reason), `reason must re-assert the wake directive; reason=${reason}`);
    assert.ok(/`CronCreate`/.test(reason), `must name the CronCreate tool; reason=${reason}`);
    assert.ok(reason.includes('`*/5 * * * *`'), `must carry the default schedule; reason=${reason}`);
    assert.ok(/inbox read-primary <DEVSWARM_BUILDER_ID>/.test(reason), `Primary must drain with read-primary, not the child pull+read verbs; reason=${reason}`);
    for (const m of [...reason.matchAll(/`node ([^`]*?devswarm\.js)\b/g)]) {
      assert.ok(path.isAbsolute(m[1]), `emitted CLI path must be absolute: ${m[1]}`);
      assert.ok(fs.existsSync(m[1]), `emitted CLI path must exist: ${m[1]}`);
    }
  } finally { h.cleanup(); }
});

test('WAKE INTERVAL: ANTIHALL_DEVSWARM_WAKE_CRON is honored in the Primary re-assertion too', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 });
    const env = Object.assign({}, CLAUDE_PRIMARY_ENV, { ANTIHALL_DEVSWARM_WAKE_CRON: '*/1 * * * *' });
    const r = run(h.home, stopPayload(), env);
    assert.ok(r.json.reason.includes('`*/1 * * * *`'), `override must be honored; reason=${r.json.reason}`);
  } finally { h.cleanup(); }
});

// CONSUMER-LEVEL (Monitor low-latency wake): this hook computes its own absolute
// WATCHER path (companion/lib/devswarm-wake-watch.js, resolved from __dirname the
// same way CLI already is) and passes it to wakeReassert() — the Claude branch
// must then arm `Monitor` with that exact path, alongside the CronCreate text
// (never instead of it — cron is unconditional, see lib/devswarm-wake.js header).
test('MONITOR: Claude Primary neglect-block reason arms Monitor with an ABSOLUTE watcher path, ALONGSIDE the cron directive', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b', 'c'], cursor: 1 }); // 2 unread
    const r = run(h.home, stopPayload(), CLAUDE_PRIMARY_ENV);
    assert.strictEqual(r.json && r.json.decision, 'block');
    const reason = r.json.reason;
    assert.ok(/`Monitor`/.test(reason), `must arm Monitor; reason=${reason}`);
    assert.ok(/`CronCreate`/.test(reason), `cron must still be present alongside Monitor; reason=${reason}`);
    const m = reason.match(/node ([^`]*?devswarm-wake-watch\.js)/);
    assert.ok(m, `must emit the watcher script path; reason=${reason}`);
    assert.ok(path.isAbsolute(m[1]), `watcher path must be absolute: ${m[1]}`);
    assert.ok(m[1].endsWith(path.join('companion', 'lib', 'devswarm-wake-watch.js')), `must resolve to companion/lib/devswarm-wake-watch.js: ${m[1]}`);
  } finally { h.cleanup(); }
});

test('WAKE BOUND: rides the SAME per-SET cap the neglect gate already has — no extra block, never wedged', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 }); // 2 unread, unchanging
    const env = Object.assign({}, CLAUDE_PRIMARY_ENV, { ANTIHALL_DEVSWARM_PARENT_GATE_CAP: '2' });
    const p = stopPayload('wake-cap-sess');
    const r1 = run(h.home, p, env);
    assert.strictEqual(r1.json && r1.json.decision, 'block', 'block #1');
    assert.ok(/MAILBOX WAKE/.test(r1.json.reason), 'block #1: wake line present');
    const r2 = run(h.home, p, env);
    assert.strictEqual(r2.json && r2.json.decision, 'block', 'block #2');
    assert.ok(/MAILBOX WAKE/.test(r2.json.reason), 'block #2: wake line present');
    // cap=2 reached -> the SAME cap that already governs the neglect gate now
    // escalates (requirement D) rather than going silent; the wake line still
    // rides along on this escalation block too.
    const r3 = run(h.home, p, env);
    assert.strictEqual(r3.json && r3.json.decision, 'block', 'escalation pass #3 must still block');
    assert.match(r3.json.reason, /DEVSWARM ESCALATION/, 'must escalate, not silently return');
    assert.ok(/MAILBOX WAKE/.test(r3.json.reason), 'escalation pass: wake line still present');
    // Only the NEXT pass (effectiveBlocks > cap) goes fully quiet.
    const r4 = run(h.home, p, env);
    assert.strictEqual(r4.status, 0);
    assert.strictEqual(r4.stdout, '', `must go quiet the pass AFTER the escalation; got: ${r4.stdout}`);
  } finally { h.cleanup(); }
});

test('CODEX PARITY: a Codex Primary is NEVER told to call CronCreate; the neglect cap is unaffected', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 });
    const r = run(h.home, stopPayload(), CODEX_PRIMARY_ENV);
    assert.strictEqual(r.json && r.json.decision, 'block', 'the neglect block itself is unaffected');
    assert.ok(!/CronCreate|MAILBOX WAKE/.test(r.json.reason), `Codex must get no wake nag; reason=${r.json.reason}`);
  } finally { h.cleanup(); }
});

test('HEALTHY PATH: no neglect -> no block at all, so the wake line does NOT fire either (by design — no independent counter exists to bound it)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 2, verdict: { status: 'alive' } }); // fully acked
    const r = run(h.home, stopPayload(), CLAUDE_PRIMARY_ENV);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `nothing neglected -> byte-identical no-op (no wake block); got: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('NON-DEVSWARM / KILL SWITCH: DISABLE_ANTIHALL_DEVSWARM=1 -> no block at all, even with unread + Claude agent', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 });
    const env = Object.assign({}, CLAUDE_PRIMARY_ENV, { DISABLE_ANTIHALL_DEVSWARM: '1' });
    const r = run(h.home, stopPayload(), env);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `kill switch must silence the hook entirely; got: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: cap state unwritable -> exit 0, never blocks (the wake line rides the SAME persist-or-fail-open path)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 });
    const p = stopPayload('unwritable-sess');
    // Park a DIRECTORY where the state JSON would go, so writeFileSync fails.
    const stateFilePath = path.join(h.home, '.anti-hall', 'devswarm', 'parent-gate', 'unwritable-sess.json');
    fs.mkdirSync(stateFilePath, { recursive: true });
    const r = run(h.home, p, CLAUDE_PRIMARY_ENV);
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.stdout, '', `unpersistable cap must fail OPEN (never block); got: ${r.stdout}`);
  } finally { h.cleanup(); }
});

// 7-DAY EXPIRY (scheduled-tasks contract) — same wording contract as the child gate.
test('WAKE RENEWAL: the Primary re-assertion instructs a CronList RE-VERIFY (re-create if expired), not merely a create', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 });
    const r = run(h.home, stopPayload(), CLAUDE_PRIMARY_ENV);
    const reason = r.json.reason;
    assert.ok(/`CronList`/.test(reason), `must instruct a CronList verify; reason=${reason}`);
    assert.ok(/VERIFY|verify/.test(reason), `must be worded as a verify; reason=${reason}`);
    assert.ok(/RE-CREATE|re-create/i.test(reason), `must instruct re-creation when gone; reason=${reason}`);
    assert.ok(/expire/i.test(reason) && /7 days/.test(reason), `must state the 7-day auto-expiry; reason=${reason}`);
    assert.ok(reason.indexOf('`CronList`') < reason.indexOf('`CronCreate`'), `CronList must come before CronCreate; reason=${reason}`);
  } finally { h.cleanup(); }
});

// FAIL-OPEN INVARIANT: lib/devswarm-wake.js is loaded LAZILY inside a try/catch. A
// TOP-LEVEL require would sit OUTSIDE main()'s try/catch, so a lib missing from a
// package (or throwing on load) would CRASH this Stop hook instead of degrading —
// verified: pre-fix it exited 1 with an uncaught throw, which on a Stop hook
// degrades or wedges the user's session. Preload fixture: helpers/break-devswarm-wake.js.
// Forward-slash the path: Node's NODE_OPTIONS parser eats backslashes (escape char), so
// a raw Windows path (D:\...\break-devswarm-wake.js) is mangled before --require resolves
// it -> MODULE_NOT_FOUND, child exits 1 before the hook body runs. Forward slashes are
// backslash-free and Node accepts them for require on Windows; on POSIX this is a no-op.
const BREAK_WAKE = path.join(__dirname, '..', 'helpers', 'break-devswarm-wake.js').replace(/\\/g, '/');

test('FAIL-OPEN: an UNLOADABLE devswarm-wake lib -> the gate still blocks with its PRE-WAKE reason, never crashes', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 });
    const env = Object.assign({}, CLAUDE_PRIMARY_ENV, { NODE_OPTIONS: `--require "${BREAK_WAKE}"` });
    const r = run(h.home, stopPayload(), env);
    assert.strictEqual(r.status, 0, `must fail OPEN, not crash; stderr=${r.stderr}`);
    assert.strictEqual(r.json && r.json.decision, 'block', 'the neglect forced-ack itself must survive');
    assert.ok(!/MAILBOX WAKE/.test(r.json.reason), `the wake line must be dropped, not half-emitted; reason=${r.json.reason}`);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// GHOST-WORKSPACE FIX (P0) — replaces the REJECTED message/child-freshness
// approach (failed review twice: freshness suppresses real neglect, AND the
// ghosts' unread is actually FRESH `[Primary poke]` traffic, so a freshness
// check never even fires on the real ghost case). The gate now counts only
// REAL unread — rows classified as system-generated poke/mirror NOISE
// (companion/lib/devswarm-noise.js isNoiseText) are excluded from realUnread.
// isNoiseText is a SEPARATE, text-based check from scripts/devswarm.js's #67
// isForwardable (a structural mtype/sender/recipient rule applied to STORE
// rows, which carry no text signal of their own) — the two are NOT the same
// classifier layered on different shapes, and after the P0-3 revert
// isForwardableRow is PURELY STRUCTURAL: it does not consume POKE_PREFIX at
// all — only isNoiseText does (see devswarm-noise.js's own header). The two
// checks merely live in the same module. A workspace whose unread
// is ALL noise -> realUnread 0 -> no longer nags. Message/child AGE plays NO
// part in this decision.
// ---------------------------------------------------------------------------

test('GHOST FIX: unread is entirely noise ([Primary poke] rows) -> realUnread 0 -> NOT in blocking set (no nag)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ghost1', {
      messageRows: [
        { _h: 'native:aaa', message: '[Primary poke] wake up', createdAt: new Date().toISOString() },
        { _h: 'native:bbb', message: '[Primary poke] wake up again', createdAt: new Date().toISOString() },
      ],
      cursor: 0,
      verdict: { status: 'alive' },
    });
    const r = run(h.home);
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.stdout, '', `an all-noise unread backlog must not nag; got: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('FAIL-FIRST PROOF: the ghost fixture actually has a nonzero RAW unread count (the bug this fix removes)', () => {
  const h = makeHome();
  try {
    const seeded = seedWorkspace(h.home, 'ghost1raw', {
      messageRows: [{ _h: 'native:aaa', message: '[Primary poke] wake up', createdAt: new Date().toISOString() }],
      cursor: 0,
      verdict: { status: 'alive' },
    });
    const inboxCursor = require('../../plugins/anti-hall/companion/lib/devswarm-inbox-cursor.js');
    const u = inboxCursor.readUnread(seeded.inboxPath, seeded.cursorPath);
    assert.strictEqual(u.known, true);
    assert.strictEqual(u.count, 1, 'the raw line-count classifier the OLD code used would have blocked on this');
  } finally { h.cleanup(); }
});

test('REAL: unread has a genuine inbound message -> BLOCKS', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'real1', {
      messageRows: [{ _h: 'native:ccc', message: 'status: finished the migration, needs review', createdAt: new Date().toISOString() }],
      cursor: 0,
      verdict: { status: 'alive' },
    });
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', 'a genuine inbound message must block');
    assert.match(r.json.reason, /real1/);
    assert.match(r.json.reason, /1 unread/);
  } finally { h.cleanup(); }
});

// P0-1 investigated: isNoiseText is a PREFIX check (trimStart+startsWith), not
// a substring/contains check. A genuine child message that merely mentions or
// quotes the poke phrase mid-body (not at the very start) must never be
// misclassified as noise and dropped from realUnread.
test('P0-1: a genuine message that MENTIONS the poke phrase mid-body (not at the start) is NOT treated as noise -> BLOCKS', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'echo1', {
      messageRows: [
        { _h: 'native:e1', message: 'FYI the previous note said "[Primary poke]" but this is a real status update' },
      ],
      cursor: 0,
      verdict: { status: 'alive' },
    });
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', 'a genuine message merely echoing the phrase mid-body must still block');
    assert.match(r.json.reason, /echo1/);
    assert.match(r.json.reason, /1 unread/, 'the mid-body echo must count as real, not be excluded as noise');
  } finally { h.cleanup(); }
});

test('MIXED: poke noise + one real direct -> BLOCKS (real present), and unread count excludes the noise', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'mixed1', {
      messageRows: [
        { _h: 'native:d1', message: '[Primary poke] wake up' },
        { _h: 'native:d2', message: 'status: blocked on review' },
        { _h: 'native:d3', message: '[Primary poke] wake up again' },
      ],
      cursor: 0,
      verdict: { status: 'alive' },
    });
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', 'a real message among noise must still block');
    assert.match(r.json.reason, /mixed1/);
    assert.match(r.json.reason, /1 unread/, 'the displayed count must exclude the 2 noise rows');
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: an unparseable/malformed unread row -> BLOCKS (never assumed noise)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'malformed1', {
      rawLines: ['not-json-at-all', 'also not json {{'],
      cursor: 0,
      verdict: { status: 'alive' },
    });
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', 'malformed unread rows must never be read as confirmed-noise');
    assert.match(r.json.reason, /malformed1/);
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: an unread row with no recognizable message text -> BLOCKS (ambiguous is real, not noise)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'notext1', {
      messageRows: [{ _h: 'native:e1', status: 'delivered' }], // no `message` field at all
      cursor: 0,
      verdict: { status: 'alive' },
    });
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', 'a row with no message text must count as real, not noise');
    assert.match(r.json.reason, /notext1/);
  } finally { h.cleanup(); }
});

test('stale/escalated with all-noise unread -> STILL BLOCKS (never "merely noisy")', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'wedged1', {
      messageRows: [{ _h: 'native:f1', message: '[Primary poke] wake up' }],
      cursor: 0,
      verdict: { status: 'stale' },
    });
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', 'a wedged (stale) child blocks regardless of unread content');
    assert.match(r.json.reason, /wedged1/);
    assert.match(r.json.reason, /stale/);
  } finally { h.cleanup(); }
});

test('escalated with all-noise unread -> STILL BLOCKS', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'esc1', {
      messageRows: [{ _h: 'native:g1', message: '[Primary poke] wake up' }],
      cursor: 0,
      verdict: { status: 'escalated' },
    });
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', 'an escalated child blocks regardless of unread content');
    assert.match(r.json.reason, /esc1/);
    assert.match(r.json.reason, /escalated/);
  } finally { h.cleanup(); }
});

// FAIL-OPEN = BLOCK on an UNREADABLE inbox (Codex P0 #2): a descriptor whose
// inbox FILE demonstrably EXISTS but cannot be conclusively read (here: its
// cursor is corrupt) must never silently read as "0 unread, no problem" — it
// blocks.
test('FAIL-OPEN: inbox file EXISTS but is unreadable (corrupt cursor) -> BLOCKS, not silently dropped', () => {
  const h = makeHome();
  try {
    const seeded = seedWorkspace(h.home, 'unreadable1', {
      messageRows: [{ _h: 'native:h1', message: 'status: real content sitting behind a corrupt cursor' }],
      verdict: { status: 'alive' },
      // deliberately no `cursor` opt — write a corrupt cursor file directly below.
    });
    fs.writeFileSync(seeded.cursorPath, 'not-a-number-and-not-json');
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', 'an unreadable inbox with real content behind it must never be silently dropped');
    assert.match(r.json.reason, /unreadable1/);
  } finally { h.cleanup(); }
});

// FAIL-OPEN = BLOCK on an ABSENT inbox, unconditionally (spec-literal
// known:false -> block; P0-2 fix). An absent inbox is now a genuine anomaly,
// NOT the routine signature of a fresh child — scripts/devswarm.js's register
// precreates an EMPTY inbox file (see the test directly below), so a
// descriptor that STILL has no inbox file can only mean: a pre-fix legacy
// child, a failed inbox write, or a native backlog that was never
// inbox-pulled. Any of those is exactly the kind of silent neglect this gate
// exists to catch — silently reading it as "0 unread" would defeat the gate.
test('FAIL-OPEN (P0-2): a descriptor whose inbox file is genuinely ABSENT (known:false) BLOCKS unconditionally, not silently dropped', () => {
  const h = makeHome();
  try {
    // No messages/messageRows/rawLines opt -> seedWorkspace never creates the
    // inbox file, simulating a descriptor that was never register-precreated
    // (or whose precreate failed) and whose native backlog was never pulled.
    seedWorkspace(h.home, 'absent1', { cursor: 0, verdict: { status: 'alive' } });
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', 'an absent inbox must never be silently read as 0 unread');
    assert.match(r.json.reason, /absent1/);
  } finally { h.cleanup(); }
});

// registerRealChild(home, id, sessionId) — drives the REAL production
// registration entry point: devswarm-child-turn.js's UserPromptSubmit hook
// (registerChildDescriptor), NOT a hand-seeded descriptor. This is the path a
// genuine DevSwarm child actually goes through on its very first turn, BEFORE
// it ever calls `devswarm.js inbox pull` (a separate, later, CLI-driven
// registration path with its own precreate — cmdRegister/cmdInboxPull in
// scripts/devswarm.js — that a prior fix round mistakenly treated as the ONLY
// production entry point; a test that only exercises cmdRegister therefore
// misses the real per-turn hook path entirely).
function registerRealChild(home, id, sessionId) {
  const r = testHook('devswarm-child-turn.js', {
    hook_event_name: 'UserPromptSubmit', session_id: sessionId || ('sess-' + id), prompt: 'go', cwd: REPO_CWD,
  }, {
    home,
    env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: id },
  });
  assert.strictEqual(r.status, 0, 'devswarm-child-turn hook must exit 0');
  return r;
}

function realChildDescriptor(home, id) {
  const p = path.join(home, '.anti-hall', 'devswarm', 'workspaces', id + '.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('NO-OP (regression guard, REAL registration path): a child registered via the actual devswarm-child-turn UserPromptSubmit hook does not nag', () => {
  const h = makeHome();
  try {
    registerRealChild(h.home, 'fresh-real1');
    const desc = realChildDescriptor(h.home, 'fresh-real1');
    assert.ok(desc.inboxPath, 'the real registration path must assign an inboxPath');
    assert.ok(fs.existsSync(desc.inboxPath), 'the real registration path must precreate the inbox file (not just the cursor)');
    assert.strictEqual(fs.readFileSync(desc.inboxPath, 'utf8'), '', 'a freshly-registered inbox must be precreated EMPTY, not written to');

    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `a freshly-registered (real-path) child must not block; got: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('FAIL-OPEN (P0-2, REAL registration path): a real child whose inbox file is later REMOVED still BLOCKS unconditionally', () => {
  const h = makeHome();
  try {
    registerRealChild(h.home, 'removed-real1');
    const desc = realChildDescriptor(h.home, 'removed-real1');
    assert.ok(fs.existsSync(desc.inboxPath), 'precondition: the real registration path must have precreated the inbox');
    fs.unlinkSync(desc.inboxPath); // simulate a genuinely-absent inbox (removed / pre-fix legacy child)

    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', 'an inbox removed AFTER real registration must still block, not silently read as 0 unread');
    assert.match(r.json.reason, /removed-real1/);
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: no verdict file at all for a descriptor with real unread -> STILL blocks (never silently suppressed)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'noverdict1', { messages: ['a', 'b', 'c'], cursor: 0 }); // no verdict seeded at all
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', 'a missing verdict must never suppress a real unread backlog');
    assert.match(r.json.reason, /noverdict1/);
  } finally { h.cleanup(); }
});

// ============================================================================
// FIX 3 (Task 6): a FRESH heartbeat is definitive proof-of-life, so the parent
// gate must NOT nudge such a workspace as gone/stale/escalated. Only the
// LIVENESS axis is suppressed — a heartbeating workspace with REAL unread still
// gates (a separate coordination concern).
// FIX 2c (Task 5): an ARCHIVED workspace (descriptor moved out of workspaces/)
// is excluded from the gate scan entirely.
// ============================================================================

function writeHeartbeat(home, id, ts) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'heartbeats');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, ts: (typeof ts === 'number' ? ts : Date.now()) }));
}
function archiveDescriptor(home, id) {
  const root = path.join(home, '.anti-hall', 'devswarm');
  const adir = path.join(root, 'archived');
  fs.mkdirSync(adir, { recursive: true });
  fs.renameSync(path.join(root, 'workspaces', id + '.json'), path.join(adir, id + '.json'));
}

test('FIX 3: a fresh-heartbeat workspace with a STALE verdict is NOT nudged (liveness axis suppressed)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws-hb', { messages: ['a'], cursor: 1, verdict: { status: 'stale' } }); // stale, no unread
    writeHeartbeat(h.home, 'ws-hb', Date.now()); // fresh proof-of-life
    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', 'a fresh-heartbeat workspace must not be nudged as gone/stale');
  } finally { h.cleanup(); }
});

test('FIX 3 control: the SAME stale workspace WITHOUT a fresh heartbeat DOES block', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws-hb', { messages: ['a'], cursor: 1, verdict: { status: 'stale' } });
    // no heartbeat written
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /stale/);
  } finally { h.cleanup(); }
});

test('FIX 3: an OLD heartbeat does NOT suppress the stale nudge (no false proof-of-life)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws-hb', { messages: ['a'], cursor: 1, verdict: { status: 'stale' } });
    writeHeartbeat(h.home, 'ws-hb', Date.now() - 60 * 60 * 1000); // 1h ago -> not fresh
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', 'a stale heartbeat is not proof of life');
    assert.match(r.json.reason, /stale/);
  } finally { h.cleanup(); }
});

test('FIX 3: a fresh heartbeat does NOT suppress a REAL unread backlog (only the liveness axis)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws-hb2', { messages: ['a', 'b'], cursor: 0, verdict: { status: 'stale' } }); // 2 unread + stale
    writeHeartbeat(h.home, 'ws-hb2', Date.now());
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', 'real unread on a live workspace still gates');
    assert.match(r.json.reason, /2 unread/);
    assert.doesNotMatch(r.json.reason, /stale/, 'the liveness axis is suppressed by the fresh heartbeat, but unread still blocks');
  } finally { h.cleanup(); }
});

test('FIX 2c: an ARCHIVED workspace is EXCLUDED from the parent-gate scan (never nudged)', () => {
  const h = makeHome();
  try {
    // ws-archived WOULD block (stale + unread) but is archived (descriptor moved
    // out of workspaces/ into archived/ — cmdArchive's real end-state).
    seedWorkspace(h.home, 'ws-archived', { messages: ['a', 'b'], cursor: 0, verdict: { status: 'stale' } });
    // ws-live genuinely blocks, so the gate is ACTIVE (not trivially inert).
    seedWorkspace(h.home, 'ws-live', { messages: ['x'], cursor: 0 }); // 1 unread
    archiveDescriptor(h.home, 'ws-archived');
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', 'the live workspace must still gate');
    assert.match(r.json.reason, /ws-live/);
    assert.doesNotMatch(r.json.reason, /ws-archived/, 'an archived workspace must never appear in the neglect set');
  } finally { h.cleanup(); }
});

// ============================================================================
// §4.4 — UNANSWERED QUESTIONS (requirement C: cap-bypass) + CAP-EXHAUSTION
// ESCALATION (requirement D). `pendingQuestions` is the summary projection's
// structural per-workspace field (companion/lib/devswarm-store.js
// computeSummary); `readReplyState`/`recordReply`/`unansweredQuestions` come
// from companion/lib/devswarm-reply-state.js. writeOwnSummary's 4th arg seeds
// `entry.pendingQuestions` directly — the same field readOwnUnread now reads.
// ============================================================================

test('UNANSWERED QUESTION: gate keeps forcing the reply up to the ceiling, then escalates once and goes quiet (spec item 5 / C2)', () => {
  const h = makeHome();
  try {
    const ts = Date.now() - 5 * 60000; // 5 minutes ago
    writeOwnSummary(h.home, 1, undefined, [{ from: 'child-1', ts, seq: 1 }]);
    const env = { ANTIHALL_DEVSWARM_PARENT_GATE_CAP: '2' }; // small cap, deliberately exhausted below
    const p = stopPayload('unanswered-sess', true);
    // Passes 1-2: normal, unconditional per-question block wording, no escalation yet.
    for (let i = 1; i <= 2; i++) {
      const r = run(h.home, p, env);
      assert.strictEqual(r.status, 0, `call #${i} must exit 0`);
      assert.strictEqual(r.json && r.json.decision, 'block', `call #${i} must still block (unanswered question)`);
      assert.match(r.json.reason, /UNANSWERED QUESTION/, `call #${i} must carry the unanswered-question wording`);
      assert.match(r.json.reason, /child-1/, `call #${i} must name the asker`);
      assert.ok(r.json.reason.includes('send --to'), `call #${i} must state the exact reply command`);
      // Small fix #2 (Round 2 review): the reply-target label is now `<id>`,
      // not `<meshId>` — the resolved value is a registry row id, not
      // necessarily the sender's raw meshId.
      assert.ok(r.json.reason.includes('<id>'), `call #${i} must label the reply target as <id>; reason=${r.json.reason}`);
      assert.ok(!r.json.reason.includes('<meshId>'), `call #${i} must NOT use the misleading <meshId> label; reason=${r.json.reason}`);
      assert.match(r.json.reason, /is NOT sufficient/i, `call #${i} must say reading alone is not sufficient`);
      assert.ok(!/DEVSWARM ESCALATION/.test(r.json.reason), `call #${i} must not yet escalate (pre-ceiling)`);
    }
    // Pass 3 (cap=2 exhausted): ONE loud escalation line, still blocks, question wording absent.
    const escalated = run(h.home, p, env);
    assert.strictEqual(escalated.json && escalated.json.decision, 'block', 'the ceiling-exhaustion pass must still block');
    assert.match(escalated.json.reason, /DEVSWARM ESCALATION/, 'the ceiling-exhaustion pass must carry escalation wording');
    assert.match(escalated.json.reason, /child-1/, 'the escalation must still name the asker');
    // Pass 4+: goes fully quiet on this Stop-block loop — the question itself
    // is never dropped (it is still unanswered in the store), only the
    // repeated forced-block stops.
    for (let i = 4; i <= 6; i++) {
      const r = run(h.home, p, env);
      assert.strictEqual(r.status, 0, `call #${i} must exit 0`);
      assert.strictEqual(r.stdout, '', `call #${i} must go quiet — the ceiling escalated exactly once already`);
    }
  } finally { h.cleanup(); }
});

test('UNANSWERED QUESTION CLEARED: once a reply is recorded for that asker, the same question no longer blocks (assuming no OTHER blocking reason)', () => {
  const h = makeHome();
  try {
    const ts = Date.now() - 5 * 60000;
    // unread:0 isolates this to ONLY the question axis (own.unread contributing
    // no separate blocking reason) so clearing the question alone goes quiet.
    writeOwnSummary(h.home, 0, undefined, [{ from: 'child-1', ts, seq: 1 }]);
    const p = stopPayload('reply-clears-sess', true);

    const before = run(h.home, p);
    assert.strictEqual(before.json && before.json.decision, 'block', 'must block while unanswered');
    assert.match(before.json.reason, /UNANSWERED QUESTION/);
    assert.match(before.json.reason, /child-1/);

    // Record an observed reply AFTER the question's ts (recordReply is the
    // primitive the PostToolUse reply-tracker hook, §4.3, would call). Keyed
    // by REPO_KEY (the durable per-project key), not the session_id — the
    // gate now reads reply-state via `selfKey`/REPO_KEY (see stopPayload's
    // `withCwd` -> REPO_CWD), independent of the Stop payload's session_id.
    replyStateLib.recordReply(REPO_KEY, h.home, 'child-1', ts + 60000);

    const after = run(h.home, p);
    assert.strictEqual(after.status, 0);
    assert.strictEqual(after.stdout, '', `question answered + no other blocking reason -> must go quiet; got: ${after.stdout}`);
  } finally { h.cleanup(); }
});

test('CAP-EXHAUSTION (plain, non-question backlog): the (cap+1)th call escalates, the (cap+2)th goes quiet', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 }); // 2 unread, unchanging, NO pendingQuestions
    const p = stopPayload('cap-exhaustion-sess');
    const cap = 3; // DEFAULT_CAP — no env override, exercised at its real default
    const results = [];
    for (let i = 1; i <= cap + 2; i++) results.push(run(h.home, p));

    for (let i = 0; i < cap; i++) {
      assert.strictEqual(results[i].json && results[i].json.decision, 'block', `call #${i + 1} (normal, pre-cap) must block`);
      assert.ok(!/DEVSWARM ESCALATION/.test(results[i].json.reason), `call #${i + 1} must not yet escalate`);
    }
    const escalationCall = results[cap]; // the (cap+1)th call
    assert.strictEqual(escalationCall.status, 0, '(cap+1)th call must exit 0');
    assert.strictEqual(escalationCall.json && escalationCall.json.decision, 'block', '(cap+1)th call must still block, not silently give up');
    assert.notStrictEqual(escalationCall.stdout, '', '(cap+1)th call must not be a silent give-up (the old behavior this fix removes)');
    assert.match(escalationCall.json.reason, /DEVSWARM ESCALATION/, '(cap+1)th call must carry escalation wording');

    const quietCall = results[cap + 1]; // the (cap+2)th call
    assert.strictEqual(quietCall.status, 0);
    assert.strictEqual(quietCall.stdout, '', '(cap+2)th call must go fully quiet, bounding total blocks at cap+1');
  } finally { h.cleanup(); }
});

// P0-C FIX: escalation-fired-once must be tracked EXPLICITLY (a persisted
// `escalated` boolean), never re-derived from `effectiveBlocks === cap`. The
// old arithmetic check broke exactly here: while a question is unanswered,
// the cap-bypass branch (unanswered.length > 0) NEVER escalates and NEVER
// returns — so `blocks` keeps climbing every Stop, sailing straight past the
// one instant `effectiveBlocks === cap` would ever have been true. Once the
// question is answered and the SAME plain, non-question backlog remains
// under the SAME signature, effectiveBlocks is already > cap — the old code
// would skip straight to the silent `effectiveBlocks > cap -> return`
// branch, and the one-time escalation message would never fire at all.
test('P0-C FIX: an unanswered-question bypass phase that overshoots the cap still escalates exactly once after the reply (never skips straight to silence)', () => {
  const h = makeHome();
  try {
    const ts = Date.now() - 5 * 60000;
    // A plain, non-question backlog (ws1) that persists under an UNCHANGED
    // signature across the whole test — the same axis the 'CAP-EXHAUSTION
    // (plain, non-question backlog)' test above exercises alone. own.unread:0
    // isolates `unanswered` to ONLY the pendingQuestions axis — own
    // contributes nothing to the `blocking` array/signature itself, so
    // answering the question can never itself change the signature.
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 }); // 2 unread, unchanging
    writeOwnSummary(h.home, 0, undefined, [{ from: 'child-1', ts, seq: 1 }]);
    const env = { ANTIHALL_DEVSWARM_PARENT_GATE_CAP: '2' };
    const p = stopPayload('p0c-bypass-sess', true);

    // 4 Stops while the question stays unanswered: the cap-bypass branch
    // fires every time (unanswered.length > 0), pushing the per-signature
    // `blocks` counter to 4 — well past cap=2 — regardless of what the
    // QUESTION-set ceiling (spec item 5 / C2) itself does. Passes 1-2 carry
    // the normal per-question wording; pass 3 exhausts the question ceiling
    // (its OWN escalation, independent of the plain-backlog axis this test
    // is really probing) and pass 4 goes quiet on the question axis — but
    // `blocks` (the plain-backlog counter) keeps incrementing underneath on
    // every pass regardless, which is the overshoot this test exists to
    // prove doesn't get silently skipped once the question clears.
    for (let i = 1; i <= 2; i++) {
      const r = run(h.home, p, env);
      assert.strictEqual(r.json && r.json.decision, 'block', `unanswered pass #${i} must block`);
      assert.match(r.json.reason, /UNANSWERED QUESTION/, `unanswered pass #${i} must carry the question wording`);
      assert.ok(!/DEVSWARM ESCALATION/.test(r.json.reason), `unanswered pass #${i} must not yet hit the question ceiling`);
    }
    const qEscalated = run(h.home, p, env);
    assert.strictEqual(qEscalated.json && qEscalated.json.decision, 'block', 'the question-ceiling exhaustion pass must still block');
    assert.match(qEscalated.json.reason, /DEVSWARM ESCALATION/, 'the question-ceiling exhaustion pass must carry escalation wording');
    const qQuiet = run(h.home, p, env);
    assert.strictEqual(qQuiet.stdout, '', 'the pass after question-ceiling escalation must go quiet (question axis only — ws1 plain backlog is untouched, still tracked underneath)');

    // Reply recorded -> the question clears. The plain ws1 backlog (SAME
    // signature) persists untouched. Keyed by REPO_KEY, not session_id.
    replyStateLib.recordReply(REPO_KEY, h.home, 'child-1', ts + 60000);

    // The VERY NEXT Stop must emit the escalation-worded block (never
    // silence), even though effectiveBlocks (4) is already well past cap (2)
    // — escalation is now tracked by the explicit `escalated` flag (still
    // false at this point for this signature), not by effectiveBlocks ===
    // cap, so an overshoot from the bypass phase must still trigger exactly
    // one escalation here rather than being skipped over.
    const escalated = run(h.home, p, env);
    assert.strictEqual(escalated.json && escalated.json.decision, 'block', 'first post-reply pass must still block');
    assert.match(escalated.json.reason, /DEVSWARM ESCALATION/, 'first post-reply pass must escalate, not silently skip to quiet');
    assert.ok(!/UNANSWERED QUESTION/.test(escalated.json.reason), 'the question is answered — must not re-appear in the reason');

    // Only the pass AFTER THAT goes quiet.
    const quiet = run(h.home, p, env);
    assert.strictEqual(quiet.status, 0);
    assert.strictEqual(quiet.stdout, '', 'must go quiet exactly one pass after the escalation, not before');
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: corrupt reply-state file -> exit 0, never throws, question still treated as UNANSWERED (still blocks)', () => {
  const h = makeHome();
  try {
    const ts = Date.now() - 60000;
    writeOwnSummary(h.home, 1, undefined, [{ from: 'child-1', ts, seq: 1 }]);
    const p = stopPayload('corrupt-reply-sess', true);
    const replyPath = replyStateLib.replyStatePathFor(REPO_KEY, h.home);
    fs.mkdirSync(path.dirname(replyPath), { recursive: true });
    fs.writeFileSync(replyPath, '{not valid json');
    const r = run(h.home, p);
    assert.strictEqual(r.status, 0, 'must exit 0, never throw on a corrupt reply-state file');
    assert.strictEqual(r.json && r.json.decision, 'block', 'a corrupt reply-state file must fail open toward BLOCKING, never silently clear the question');
    assert.match(r.json.reason, /UNANSWERED QUESTION/);
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: malformed pendingQuestions entries on the summary -> exit 0, never throws, treated as UNANSWERED (still blocks)', () => {
  const h = makeHome();
  try {
    writeOwnSummary(h.home, 1, undefined, [
      { from: 'child-1', ts: 'not-a-number' }, // malformed ts -> unansweredQuestions treats as always-newer
      null, // malformed entry entirely -> lib fail-opens to "keep" (unanswered)
      42, // malformed entry (not even an object)
    ]);
    const p = stopPayload('malformed-pq-sess', true);
    const r = run(h.home, p);
    assert.strictEqual(r.status, 0, 'must exit 0, never throw on malformed pendingQuestions entries');
    assert.strictEqual(r.json && r.json.decision, 'block', 'malformed pendingQuestions entries must fail open toward BLOCKING, never silently clear the question');
    assert.match(r.json.reason, /UNANSWERED QUESTION/);
  } finally { h.cleanup(); }
});

// BUG 1a FIX: reply-state is now keyed by the durable per-project REPO_KEY
// (resolved from `cwd` — same as `selfKey` in the hook), not the short-lived
// Claude Stop payload `session_id`. A reply observed while one Claude session
// was active must still be seen as clearing the question when a COMPLETELY
// DIFFERENT session (same project) later checks — proving a fresh session no
// longer resurrects every historically-answered question (the exact
// resurrection bug this fix closes).
test('BUG 1a FIX: a reply recorded (repoKey-keyed) clears an unanswered question for a COMPLETELY DIFFERENT Claude session_id, same project', () => {
  const h = makeHome();
  try {
    const ts = Date.now() - 5 * 60000;
    // unread:0 isolates this to ONLY the question axis, same isolation
    // pattern as the 'UNANSWERED QUESTION CLEARED' test above.
    writeOwnSummary(h.home, 0, undefined, [{ from: 'child-1', ts, seq: 1 }]);
    const pSessionA = stopPayload('session-A-original', true);
    const pSessionB = stopPayload('session-B-totally-unrelated', true); // same REPO_CWD -> same repoKey

    const beforeA = run(h.home, pSessionA);
    assert.strictEqual(beforeA.json && beforeA.json.decision, 'block', 'must block under session A while unanswered');
    assert.match(beforeA.json.reason, /UNANSWERED QUESTION/);

    // The reply-tracker hook (§4.3) would record this — keyed by repoKey, not
    // by whichever session_id happened to be active when the reply was sent.
    replyStateLib.recordReply(REPO_KEY, h.home, 'child-1', ts + 60000);

    // A BRAND NEW Claude session (session-B, same project) must see the SAME
    // project's already-recorded reply — not start over with an empty,
    // session-scoped reply-state file and resurrect the question.
    const afterB = run(h.home, pSessionB);
    assert.strictEqual(afterB.status, 0);
    assert.strictEqual(afterB.stdout, '',
      `a fresh session_id for the SAME project must see the question as already answered; got: ${afterB.stdout}`);
  } finally { h.cleanup(); }
});

// Small fix #1 (Round 2 review): buildReason's "DEVSWARM NEGLECT: N
// workspace(s)..." paragraph must be entirely ABSENT (not "0 workspace(s)...
// : .") when the unanswered question is the ONLY reason this pass is
// blocking (blocking.length === 0).
test('SMALL FIX: the "DEVSWARM NEGLECT" paragraph is entirely absent (not a self-contradicting "0 workspace(s)") when an unanswered question is the ONLY blocking reason', () => {
  const h = makeHome();
  try {
    const ts = Date.now() - 60000;
    writeOwnSummary(h.home, 0, undefined, [{ from: 'child-1', ts, seq: 1 }]); // unread:0 -> blocking.length===0
    const p = stopPayload('neglect-wording-sess', true);
    const r = run(h.home, p);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.doesNotMatch(r.json.reason, /DEVSWARM NEGLECT/,
      `the NEGLECT paragraph must not appear at all when there is no neglected workspace to name; reason=${r.json.reason}`);
    assert.doesNotMatch(r.json.reason, /0 workspace\(s\)/,
      `must never emit the self-contradicting "0 workspace(s) ... : ." sentence; reason=${r.json.reason}`);
  } finally { h.cleanup(); }
});

// ============================================================================
// P2 FIX — pendingQuestionsTruncated: devswarm-store.js's computeSummary
// stamps a workspace entry with `pendingQuestionsTruncated: {cap, kept,
// dropped}` when its per-workspace backstop cap actually bit (more distinct
// resolved senders holding an unanswered question than the cap), but nothing
// downstream consumed that signal before this fix. Consequence: the senders
// past the cap are simply absent from `pendingQuestions`, so
// unansweredQuestions() below never sees them and the gate silently stopped
// blocking for exactly those askers, with no observed reply. The fix: treat
// the PRESENCE of the truncation signal as itself blocking, unconditionally
// (never governed by the forced-ack cap, same as an unanswered question), and
// name it explicitly in the reason so the operator knows the list shown is
// known-incomplete. Seeded directly via writeOwnSummary's 5th arg (the exact
// shape computeSummary stamps) rather than 200+ real senders, per the task's
// own "keep it fast" instruction.
// ============================================================================

test('TRUNCATED: presence of pendingQuestionsTruncated BLOCKS unconditionally, and the message says the list was truncated', () => {
  const h = makeHome();
  try {
    // unread:0, no pendingQuestions entries at all -> isolates this to ONLY
    // the truncation axis; without the fix this pass would go fully quiet.
    writeOwnSummary(h.home, 0, undefined, undefined, { cap: 200, kept: 200, dropped: 7 });
    const p = stopPayload('truncated-sess', true);
    const r = run(h.home, p);
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.json && r.json.decision, 'block', 'a truncated pendingQuestions projection must block, even with own.unread:0 and no unanswered entries visible');
    assert.match(r.json.reason, /TRUNCATED/i, 'reason must name the truncation explicitly');
    assert.match(r.json.reason, /200/, 'reason must surface the kept/cap count');
    assert.match(r.json.reason, /7/, 'reason must surface the dropped-sender count');
    assert.match(r.json.reason, /higher/i, 'reason must say the true unanswered count is higher than what is shown');

    // Never governed by the forced-ack cap: run well past DEFAULT_CAP with a
    // small explicit cap and confirm it NEVER escalates or goes quiet — same
    // bypass guarantee an unanswered question already has.
    const env = { ANTIHALL_DEVSWARM_PARENT_GATE_CAP: '2' };
    for (let i = 1; i <= 5; i++) {
      const rr = run(h.home, p, env);
      assert.strictEqual(rr.json && rr.json.decision, 'block', `truncated pass #${i} must still block`);
      assert.match(rr.json.reason, /TRUNCATED/i, `truncated pass #${i} must still name the truncation`);
      assert.ok(!/DEVSWARM ESCALATION/.test(rr.json.reason), `truncated pass #${i} must never escalate — the truncation axis bypasses the cap entirely`);
    }
  } finally { h.cleanup(); }
});

test('UNTRUNCATED: an ordinary (non-truncated) projection behaves exactly as today — no truncation wording, cap/escalation unaffected', () => {
  const h = makeHome();
  try {
    const ts = Date.now() - 5 * 60000;
    // A normal unanswered-question projection with NO pendingQuestionsTruncated
    // field at all (the common, untruncated case) — must be byte-identical in
    // behavior to the pre-fix gate: it blocks on the unanswered question, but
    // carries no truncation wording whatsoever.
    writeOwnSummary(h.home, 1, undefined, [{ from: 'child-1', ts, seq: 1 }]);
    const p = stopPayload('untruncated-sess', true);
    const r = run(h.home, p);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /UNANSWERED QUESTION/);
    assert.doesNotMatch(r.json.reason, /TRUNCATED/i, 'an untruncated projection must never carry truncation wording');

    // And the ordinary CAP-EXHAUSTION escalate-then-quiet machinery (plain,
    // non-question backlog, no truncation at all) is completely unaffected.
    const h2 = makeHome();
    try {
      seedWorkspace(h2.home, 'ws1', { messages: ['a', 'b'], cursor: 0 });
      const p2 = stopPayload('untruncated-cap-sess');
      const cap = 3;
      const results = [];
      for (let i = 1; i <= cap + 2; i++) results.push(run(h2.home, p2));
      for (let i = 0; i < cap; i++) {
        assert.strictEqual(results[i].json && results[i].json.decision, 'block', `call #${i + 1} must block`);
        assert.ok(!/DEVSWARM ESCALATION/.test(results[i].json.reason));
        assert.doesNotMatch(results[i].json.reason, /TRUNCATED/i);
      }
      assert.match(results[cap].json.reason, /DEVSWARM ESCALATION/, '(cap+1)th call must still escalate as before');
      assert.strictEqual(results[cap + 1].stdout, '', '(cap+2)th call must still go quiet as before');
    } finally { h2.cleanup(); }
  } finally { h.cleanup(); }
});
