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

// writeOwnSummary(home, unread, urgencyMax) — the Primary's OWN unread,
// written to the SAME per-project summary projection path the hook reads
// (v0.57 mesh: summaries/<REPO_KEY>.json -> workspaces[primary-<hash>].unread).
function writeOwnSummary(home, unread, urgencyMax) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  const entry = { unread };
  if (urgencyMax !== undefined) entry.urgencyMax = urgencyMax;
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
    assert.match(r.json.reason, /devswarm-inbox-cursor\.js/, 'must state the read/ack clear path');
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

test('LOOP-SAFE: same blocking SET is capped (goes quiet after CAP forced-acks)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 }); // 2 unread, unchanging
    const env = { ANTIHALL_DEVSWARM_PARENT_GATE_CAP: '2' };
    const p = stopPayload('loopsess');
    const r1 = run(h.home, p, env); assert.strictEqual(r1.json && r1.json.decision, 'block', 'block #1');
    const r2 = run(h.home, p, env); assert.strictEqual(r2.json && r2.json.decision, 'block', 'block #2');
    const r3 = run(h.home, p, env); // cap=2 reached
    assert.strictEqual(r3.status, 0);
    assert.strictEqual(r3.stdout, '', 'must go quiet once the same set hits the cap');
  } finally { h.cleanup(); }
});

test('CAP RESET: a CHANGED unread set re-opens the budget after being capped', () => {
  const h = makeHome();
  try {
    const seeded = seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 });
    const env = { ANTIHALL_DEVSWARM_PARENT_GATE_CAP: '2' };
    const p = stopPayload('resetsess');
    run(h.home, p, env); // block #1
    run(h.home, p, env); // block #2 -> capped
    const capped = run(h.home, p, env);
    assert.strictEqual(capped.stdout, '', 'capped before change');
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

test('FAIL-OPEN: malformed own summary.json -> treated as no own-unread; child-only unread still gates', () => {
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
    assert.ok(!/YOU \(the Primary\)/.test(r.json.reason), `malformed own summary must not gate on own-unread; reason=${r.json.reason}`);
  } finally { h.cleanup(); }
});

test('LOOP-SAFE: own-unread blocking set is capped too (cap machinery still terminates)', () => {
  const h = makeHome();
  try {
    writeOwnSummary(h.home, 2);
    const env = { ANTIHALL_DEVSWARM_PARENT_GATE_CAP: '2' };
    const p = stopPayload('loop-own', true);
    const r1 = run(h.home, p, env); assert.strictEqual(r1.json && r1.json.decision, 'block', 'block #1');
    const r2 = run(h.home, p, env); assert.strictEqual(r2.json && r2.json.decision, 'block', 'block #2');
    const r3 = run(h.home, p, env); // cap=2 reached
    assert.strictEqual(r3.status, 0);
    assert.strictEqual(r3.stdout, '', 'must go quiet once the same own-unread set hits the cap');
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
    // cap=2 reached -> the SAME cap that already governs the neglect gate silences
    // both concerns at once; no separate wake-only block exists.
    const r3 = run(h.home, p, env);
    assert.strictEqual(r3.status, 0);
    assert.strictEqual(r3.stdout, '', `must go quiet exactly like the pre-wake gate; got: ${r3.stdout}`);
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
