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
const meshStore = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const gateStateLib = require('../../plugins/anti-hall/companion/lib/devswarm-gate-state.js');

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

// makeLinkedWorktree() -> a REAL `git worktree add` linked worktree of THIS
// repo: SAME git-common-dir (repoKey) as REPO_CWD, but a DISTINCT toplevel
// path (-> a DIFFERENT identity-family key / canonicalMeshId than REPO_CWD /
// OWN_ID). Mirrors this repo's own real DevSwarm topology — a genuine child
// runs from its OWN linked worktree (`.claude/worktrees/<id>`), never from
// the Primary's own cwd. Fixtures that need "a real different workspace,
// same repoKey" use this instead of `worktreePath: REPO_CWD` (that was an
// unrealistic same-worktree collision with the Primary's own identity — the
// identity-family collapse this file also tests below correctly folds a
// REPO_CWD-worktreePath descriptor into the Primary's own row, since by the
// codebase's own definition it then IS the same worktree/identity).
function makeLinkedWorktree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-gate-idfam-wt-'));
  fs.rmdirSync(dir); // `git worktree add` requires the target not already exist
  const branch = 'parent-gate-idfam-' + path.basename(dir);
  const r = cp.spawnSync('git', ['worktree', 'add', '-q', '-b', branch, dir, 'HEAD'], { cwd: REPO_CWD });
  if (r.status !== 0) throw new Error('git worktree add failed: ' + (r.stderr && r.stderr.toString()));
  return {
    dir,
    cleanup() {
      try { cp.spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: REPO_CWD }); } catch (_) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      try { cp.spawnSync('git', ['branch', '-D', branch], { cwd: REPO_CWD }); } catch (_) {}
    },
  };
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
  // repoKey — the PERSISTED, worktree-derived project key scripts/devswarm.js
  // stamps at register/heartbeat time (defect e586afdaa968).
  if (opts.repoKey !== undefined) descriptor.repoKey = opts.repoKey;
  // ownerKey — the ONLY project key `rehomeCore` persists (it writes ownerKey and
  // leaves repoKey unset). A descriptor of that shape must resolve to the same
  // project as a repoKey-carrying one everywhere the gate reads a project key.
  if (opts.ownerKey !== undefined) descriptor.ownerKey = opts.ownerKey;
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

// seedWorkspaceWithInboxPath(home, id, inboxPath, opts) — writes ONLY the
// descriptor file (no inbox/cursor content), with an EXPLICIT `inboxPath`
// (including `null`, reproducing a malformed/phantom descriptor field-for-
// field per the live incident: "descriptor for primary-bf04dd47 has no
// inboxPath"). seedWorkspace() above always computes a real inboxPath, so
// this is the only way to exercise the `no-inbox-path` taxonomy branch at
// the gate level.
function seedWorkspaceWithInboxPath(home, id, inboxPath, opts = {}) {
  const root = path.join(home, '.anti-hall', 'devswarm');
  const wsDir = path.join(root, 'workspaces');
  fs.mkdirSync(wsDir, { recursive: true });
  const descriptor = {
    id,
    worktreePath: opts.worktreePath !== undefined ? opts.worktreePath : path.join(home, 'wt', id),
    sessionId: 'child-' + id,
    inboxPath,
    cursorPath: opts.cursorPath !== undefined ? opts.cursorPath : path.join(root, 'cursor', id + '.json'),
  };
  fs.writeFileSync(path.join(wsDir, id + '.json'), JSON.stringify(descriptor));
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
    // Root cause b fix (live incident): a CHILD's mailbox is the CHILD's own —
    // this Primary is neither the owner (read-primary against a child id is
    // refused as ownership-mismatch) nor may it advance that cursor (it would
    // mark a message read the child has never seen). The prescribed path is now
    // the NON-MUTATING `inbox peek-primary <id>` (inspect only, no ack).
    assert.match(r.json.reason, /inbox peek-primary/, 'must state the non-destructive inspect path');
    assert.doesNotMatch(r.json.reason, /inbox read-primary <id>/, 'must never tell the Primary to advance a CHILD workspace\'s cursor');
    assert.match(r.json.reason, /devswarm-parent-gate/, 'must name the skip-guard escape');
  } finally { h.cleanup(); }
});

test('BLOCK: stale verdict with no unread -> blocks on the liveness axis', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a'], cursor: 1, verdict: { status: 'stale', pending: true } }); // A1: corroborated by the verdict's own `pending`
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /stale/);
  } finally { h.cleanup(); }
});

test('BLOCK: escalated verdict counts as blocking (P1-C: same severity as stale)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a'], cursor: 1, verdict: { status: 'escalated', pending: true } }); // A1: corroborated
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
  const wt = makeLinkedWorktree();
  try {
    seedWorkspace(h.home, 'same-project', { messages: ['a', 'b'], cursor: 0, worktreePath: wt.dir });
    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /same-project/);
  } finally { h.cleanup(); wt.cleanup(); }
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

// defect e586afdaa968 (P1). An intermediate revision of this fix EXCLUDED a
// descriptor whose persisted `repoKey` named another project. That hid real,
// drainable work and is the behavior these tests now forbid:
//   * `repoKey` is a store-PARTITION fact. `realUnread` is counted from the
//     descriptor's NDJSON inbox, which is id-derived and partition-INDEPENDENT
//     — `devswarm.js inbox read <id>` returns those exact lines from ANY cwd
//     (asserted live in tests/scripts/devswarm-cross-repo-partition.test.js).
//   * `repoKey` is only ever (re)written while the worktree still resolves, so
//     once it stops a stale key can never be refreshed and the row would vanish
//     from this gate permanently.
// The real defect being cured is narrower: the Primary was told to run
// `inbox peek-primary <id>`, which the CLI REFUSES outright for a foreign id.
// So the row is KEPT and DOWNGRADED — it still gates on the drainable NDJSON
// axis, the un-actionable axes (store partition, liveness verdict) are dropped,
// and the remediation names a command that actually works.
test('e586afdaa968 DOWNGRADE: an unresolvable-worktree descriptor whose PERSISTED repoKey is another project still gates, with a WORKING remediation', () => {
  const h = makeHome();
  const otherRepo = makeGitRepo();
  try {
    const otherKey = repokey.repoKeyForWorktree(otherRepo);
    assert.notEqual(otherKey, REPO_KEY, 'precondition: genuinely different repoKey');
    // worktreePath deliberately left at the default (non-existent, non-git) so
    // the FRESH key is unresolvable — only the persisted key remains.
    seedWorkspace(h.home, 'foreign-gone', { messages: ['a', 'b'], cursor: 0, repoKey: otherKey });
    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block', 'drainable mail must NEVER be hidden from the Primary');
    assert.match(r.json.reason, /foreign-gone \(2 unread\)/);
    assert.match(r.json.reason, /inbox read <id>/, 'must name the command that WORKS from here');
    // the NOTE paragraph names `peek-primary` only to say it will REFUSE; what
    // must be gone is the PRESCRIPTIVE "INSPECT ... via peek-primary" advice.
    assert.doesNotMatch(r.json.reason, /INSPECT the unread backlog via/,
      'must never prescribe a command the CLI refuses with project-context-mismatch');
  } finally { h.cleanup(); fs.rmSync(otherRepo, { recursive: true, force: true }); }
});

// Same downgrade, reached via the OTHER descriptor shape that carries a project
// key: `rehomeCore` writes `ownerKey=<repoKey>` and leaves `repoKey` unset. This
// file used to fall back to `repoKey` ONLY while scripts/devswarm.js fell back
// `repoKey` -> `ownerKey`, so this exact descriptor read as "names no project"
// here and as "names project X" there. Both now share
// devswarm-repokey.registeredRepoKey, so this row is classified identically.
test('e586afdaa968: an ownerKey-ONLY descriptor (rehomeCore shape) naming another project is downgraded, not hidden', () => {
  const h = makeHome();
  const otherRepo = makeGitRepo();
  try {
    const otherKey = repokey.repoKeyForWorktree(otherRepo);
    assert.notEqual(otherKey, REPO_KEY);
    const wsDir = path.join(h.home, '.anti-hall', 'devswarm', 'workspaces');
    seedWorkspace(h.home, 'ownerkey-only', { messages: ['a', 'b'], cursor: 0 });
    const dp = path.join(wsDir, 'ownerkey-only.json');
    const desc = JSON.parse(fs.readFileSync(dp, 'utf8'));
    delete desc.repoKey;
    desc.ownerKey = otherKey; // exactly what rehomeCore persists
    fs.writeFileSync(dp, JSON.stringify(desc));
    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block', 'ownerKey-only foreign mail must still be reported');
    assert.match(r.json.reason, /ownerkey-only \(2 unread\)/);
    assert.match(r.json.reason, /inbox read <id>/);
    assert.doesNotMatch(r.json.reason, /INSPECT the unread backlog via/);
  } finally { h.cleanup(); fs.rmSync(otherRepo, { recursive: true, force: true }); }
});

// PRECEDENCE (vacuity fix): both prior e586afdaa968 gate cases had an
// UNRESOLVABLE worktree, so they were blind to fresh-vs-persisted ORDER —
// reversing it left them green. Here the worktree RESOLVES to another project
// while the persisted key claims THIS one. Fresh must win, so the row is
// DROPPED (the #36 structural exclusion). If persisted won, the row would be
// treated as local and would block.
test('e586afdaa968 PRECEDENCE: a RESOLVABLE worktree in another project beats a persisted repoKey claiming this one', () => {
  const h = makeHome();
  const otherRepo = makeGitRepo();
  try {
    const otherKey = repokey.repoKeyForWorktree(otherRepo);
    assert.notEqual(otherKey, REPO_KEY, 'precondition: genuinely different repoKey');
    seedWorkspace(h.home, 'fresh-wins', {
      messages: ['a', 'b'], cursor: 0,
      worktreePath: otherRepo, // FRESH key resolves -> otherKey
      repoKey: REPO_KEY,       // persisted key LIES that it is ours
    });
    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '',
      'the live worktree-derived key is ground truth — a persisted key must never override it');
  } finally { h.cleanup(); fs.rmSync(otherRepo, { recursive: true, force: true }); }
});

test('e586afdaa968 INCLUDE: an unresolvable-worktree descriptor whose PERSISTED repoKey is THIS project still gates (full remediation, not the downgrade)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'mine-gone', { messages: ['a', 'b'], cursor: 0, repoKey: REPO_KEY });
    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /mine-gone/);
    assert.match(r.json.reason, /INSPECT the unread backlog via/, 'a LOCAL row keeps the normal remediation');
    assert.doesNotMatch(r.json.reason, /DIFFERENT project/);
  } finally { h.cleanup(); }
});

// A foreign row's LIVENESS verdict is not this Primary's to act on (recovering
// another project's wedged child is that project's job), so the stale/escalated
// axis is suppressed for it — unlike the NDJSON unread axis, which IS drainable
// from here and therefore still gates.
test('e586afdaa968: a foreign-project row does NOT gate on the liveness (stale) axis alone', () => {
  const h = makeHome();
  const otherRepo = makeGitRepo();
  try {
    const otherKey = repokey.repoKeyForWorktree(otherRepo);
    seedWorkspace(h.home, 'foreign-stale', {
      messages: ['a'], cursor: 1, repoKey: otherKey, verdict: { status: 'stale' },
    });
    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', 'no drainable mail + a foreign liveness verdict -> nothing for this Primary to do');
  } finally { h.cleanup(); fs.rmSync(otherRepo, { recursive: true, force: true }); }
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
  const wt = makeLinkedWorktree();
  try {
    seedWorkspace(h.home, 'same-project', { messages: ['a', 'b'], cursor: 0, worktreePath: wt.dir, repoId: 'repo-999' });
    const r = run(h.home, stopPayload(), { DEVSWARM_REPO_ID: 'repo-1' }); // deliberately mismatching env
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block', 'the structural repoKey match must win over any env repoId mismatch');
    assert.match(r.json.reason, /same-project/);
  } finally { h.cleanup(); wt.cleanup(); }
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
      verdict: { status: 'stale', pending: true }, // A1: corroborated by the verdict's own `pending`
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
      verdict: { status: 'escalated', pending: true }, // A1: corroborated
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
test('FAIL-OPEN (P0-2): a LIVE descriptor whose inbox file is genuinely ABSENT (known:false) BLOCKS, not silently dropped', () => {
  const h = makeHome();
  try {
    // No messages/messageRows/rawLines opt -> seedWorkspace never creates the
    // inbox file, simulating a descriptor that was never register-precreated
    // (or whose precreate failed) and whose native backlog was never pulled.
    // The worktree dir IS created: this fixture is the GENUINE ANOMALY case (a
    // pre-fix legacy child / failed inbox write on a workspace that still
    // physically exists), which the un-clearable-axis rule deliberately leaves
    // blocking. Previously this fixture left worktreePath uncreated too, which
    // made it indistinguishable from a DEAD descriptor — see the UN-CLEARABLE
    // AXIS block at the end of this file for that separate case.
    const liveWt = path.join(h.home, 'live-wt-absent1');
    fs.mkdirSync(liveWt, { recursive: true });
    seedWorkspace(h.home, 'absent1', { worktreePath: liveWt, cursor: 0, verdict: { status: 'alive' } });
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
function registerRealChild(home, id, sessionId, cwd) {
  const r = testHook('devswarm-child-turn.js', {
    hook_event_name: 'UserPromptSubmit', session_id: sessionId || ('sess-' + id), prompt: 'go', cwd: cwd || REPO_CWD,
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
  const wt = makeLinkedWorktree();
  try {
    registerRealChild(h.home, 'removed-real1', undefined, wt.dir);
    const desc = realChildDescriptor(h.home, 'removed-real1');
    assert.ok(fs.existsSync(desc.inboxPath), 'precondition: the real registration path must have precreated the inbox');
    fs.unlinkSync(desc.inboxPath); // simulate a genuinely-absent inbox (removed / pre-fix legacy child)

    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', 'an inbox removed AFTER real registration must still block, not silently read as 0 unread');
    assert.match(r.json.reason, /removed-real1/);
  } finally { h.cleanup(); wt.cleanup(); }
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
    seedWorkspace(h.home, 'ws-hb', { messages: ['a'], cursor: 1, verdict: { status: 'stale', pending: true } }); // A1: corroborated
    // no heartbeat written
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /stale/);
  } finally { h.cleanup(); }
});

test('FIX 3: an OLD heartbeat does NOT suppress the stale nudge (no false proof-of-life)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws-hb', { messages: ['a'], cursor: 1, verdict: { status: 'stale', pending: true } }); // A1: corroborated
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

// ============================================================================
// ROOT CAUSE (a)+(b) FIX — live-session bug report (anti-hall 0.75.1): the
// store-side UNION check (companion/lib/devswarm-unread.js) reads a CHILD
// descriptor's mailbox partition (workspace_id === recipient === d.id, per
// devswarm-store.js appendMeshMessage's D3 wire-contract). A message THIS
// PRIMARY just sent to that child (`send --to <id>`) lands there with
// `sender === own.id` and is awaiting the CHILD's read — not this Primary's.
// (a) that row must not count toward the neglect count. (b) the remediation
// text the gate emits for a genuine child-unread block must never instruct a
// cursor advance on a workspace this Primary does not own (destructive by
// side effect, and structurally refused anyway).
// ============================================================================

// seedStoreOnlyRow(home, id, from, hash) — a REAL store-direct mesh row
// (appendMeshMessage, the same primitive `send --to` uses) addressed TO `id`,
// with `sender` set to `from`. Mirrors devswarm-child-gate.test.js's own
// seedOutboundReport helper (same store/openStore/appendMeshMessage pattern).
function seedStoreOnlyRow(home, id, from, hash) {
  const s = meshStore.openStore({ home, workspaceId: id, hash: REPO_KEY });
  try {
    meshStore.appendMeshMessage(s, {
      from, to: id, type: 'direct', message: 'store-direct row', timestamp: Date.now(), hash,
    });
  } finally { s.close(); }
}

test('FIX 3a: a store-only row whose sender IS this Primary (own outbound send) does NOT count as neglect', () => {
  const h = makeHome();
  const wt = makeLinkedWorktree();
  try {
    seedWorkspace(h.home, 'ws-out1', { worktreePath: wt.dir, messages: [], cursor: 0 });
    seedStoreOnlyRow(h.home, 'ws-out1', OWN_ID, 'test-out-1');
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.stdout, '', `this Primary's own outbound send must never self-flag as neglect; got: ${r.stdout}`);
  } finally { h.cleanup(); wt.cleanup(); }
});

test('FIX 3a control: a store-only row from a DIFFERENT sender still counts as real neglect', () => {
  const h = makeHome();
  const wt = makeLinkedWorktree();
  try {
    seedWorkspace(h.home, 'ws-out2', { worktreePath: wt.dir, messages: [], cursor: 0 });
    seedStoreOnlyRow(h.home, 'ws-out2', 'some-other-sender', 'test-out-2');
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.json && r.json.decision, 'block', 'a store-only row from a real different sender must still block');
    assert.match(r.json.reason, /ws-out2/);
    assert.match(r.json.reason, /1 unread/);
  } finally { h.cleanup(); wt.cleanup(); }
});

test('FIX 3a mixed: this Primary\'s own outbound row is excluded while a genuine different-sender row in the SAME workspace still counts', () => {
  const h = makeHome();
  const wt = makeLinkedWorktree();
  try {
    seedWorkspace(h.home, 'ws-out3', { worktreePath: wt.dir, messages: [], cursor: 0 });
    seedStoreOnlyRow(h.home, 'ws-out3', OWN_ID, 'test-out-3a');
    seedStoreOnlyRow(h.home, 'ws-out3', 'some-other-sender', 'test-out-3b');
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /1 unread/, 'the own-outbound row must be excluded from the displayed count, leaving only the real one');
  } finally { h.cleanup(); wt.cleanup(); }
});

test('FIX 3b: the remediation for a genuine child-unread block is NON-DESTRUCTIVE — no cursor-advancing/ack command against a workspace this Primary does not own', () => {
  const h = makeHome();
  const wt = makeLinkedWorktree();
  try {
    seedWorkspace(h.home, 'ws-out2', { worktreePath: wt.dir, messages: [], cursor: 0 });
    seedStoreOnlyRow(h.home, 'ws-out2', 'some-other-sender', 'test-out-4');
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.json && r.json.decision, 'block');
    const reason = r.json.reason;
    // The non-destructive, read-only inspect verb IS present...
    assert.match(reason, /inbox peek-primary <id>/, `must point at the non-mutating peek-primary verb; reason=${reason}`);
    // ...and no cursor-advancing/ack verb against the child id is present anywhere.
    assert.doesNotMatch(reason, /inbox read-primary <id>/, `must never tell the Primary to advance a child's cursor; reason=${reason}`);
    assert.doesNotMatch(reason, /ADVANCING its cursor/i, `must not instruct the Primary to advance a child's cursor; reason=${reason}`);
    assert.doesNotMatch(reason, /\bACK\w*\s+its cursor/i, `must not instruct acking a child's cursor; reason=${reason}`);
  } finally { h.cleanup(); wt.cleanup(); }
});

// ============================================================================
// IDENTITY-FAMILY COLLAPSE — the parent-gate workspace-count divergence fix.
// readDescriptors(home) yields one row per descriptor FILE; two descriptor
// files sharing one worktreePath (a builder-id UUID row and a slug row for
// the SAME physical worktree — including the Primary's OWN row) must collapse
// to ONE reported entry (companion/lib/devswarm-identity-family.js), never
// two, while the underlying descriptor files themselves are never
// retired/deleted/tombstoned (unit-tested directly in
// tests/companion/devswarm-identity-family.test.js — these are the
// integration-level proofs through the real hook).
// ============================================================================

test('IDENTITY-FAMILY: two descriptors sharing one worktreePath collapse to ONE workspace, unread UNIONED', () => {
  const h = makeHome();
  const bogusCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-gate-idfam-nogit-'));
  try {
    // A fabricated, non-git, shared worktreePath: the #36 repoKey filter is
    // fail-open here (unresolvable on both sides), isolating this test to
    // ONLY the identity-family collapse. Two DIFFERENT descriptor ids at the
    // exact SAME worktreePath — the builder-id-UUID-vs-slug shape the defect
    // report names.
    const sharedWt = path.join(h.home, 'shared-wt');
    seedWorkspace(h.home, 'builder-uuid-1', { messages: ['a', 'b'], cursor: 0, worktreePath: sharedWt });
    seedWorkspace(h.home, 'slug-one', { messages: ['c', 'd', 'e'], cursor: 0, worktreePath: sharedWt });
    const r = run(h.home, stopPayload('sess-idfam1', false, bogusCwd));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /1 workspace\(s\)/, 'two descriptors at the SAME worktreePath must collapse to 1 workspace, not 2');
    assert.match(r.json.reason, /5 unread/, 'the UNION of unread across both members (2 + 3)');
  } finally { h.cleanup(); fs.rmSync(bogusCwd, { recursive: true, force: true }); }
});

test('IDENTITY-FAMILY: the SELF/Primary row duplicated (live evidence: the same id appears twice) collapses to one', () => {
  const h = makeHome();
  try {
    // own's synthetic self-row (via writeOwnSummary, id=OWN_ID) PLUS a REAL
    // descriptor registered under the Primary's OWN worktree/canonical id —
    // reproducing the literal live-evidence duplication where
    // "primary-63f9261d (you)" appeared twice in one blocking line.
    writeOwnSummary(h.home, 2);
    seedWorkspace(h.home, OWN_ID, { messages: ['x', 'y', 'z'], cursor: 0, worktreePath: REPO_CWD });
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /1 workspace\(s\)/, 'the self row duplicated across own + a same-worktree descriptor must collapse to 1, not 2');
    assert.match(r.json.reason, new RegExp(OWN_ID + ' \\(you\\)'), 'the survivor must still carry the (you) label');
    assert.match(r.json.reason, /5 unread/, 'own\'s 2 unread UNIONED with the descriptor\'s 3 real unread');
  } finally { h.cleanup(); }
});

test('IDENTITY-FAMILY: a descriptor whose worktree no longer exists still groups deterministically, never throws', () => {
  const h = makeHome();
  const bogusCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-gate-idfam-nogit-'));
  try {
    // A worktreePath that never existed on disk at all -> canonicalMeshId's
    // realpath resolution degrades to path.resolve (worktreeRealPath's own
    // documented "never throws" contract) rather than failing.
    const vanishedWt = path.join(os.tmpdir(), 'parent-gate-idfam-vanished-' + Date.now());
    seedWorkspace(h.home, 'ghost-uuid', { messages: ['a'], cursor: 0, worktreePath: vanishedWt });
    seedWorkspace(h.home, 'ghost-slug', { messages: ['b'], cursor: 0, worktreePath: vanishedWt });
    let r;
    assert.doesNotThrow(() => { r = run(h.home, stopPayload('sess-idfam2', false, bogusCwd)); });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /1 workspace\(s\)/, 'still groups deterministically even though the worktree never existed');
  } finally { h.cleanup(); fs.rmSync(bogusCwd, { recursive: true, force: true }); }
});

test('IDENTITY-FAMILY: two GENUINELY distinct workspaces (different worktreePath) are still counted separately (no over-collapse)', () => {
  const h = makeHome();
  const bogusCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-gate-idfam-nogit-'));
  try {
    seedWorkspace(h.home, 'distinct-a', { messages: ['a'], cursor: 0, worktreePath: path.join(h.home, 'wt-alpha') });
    seedWorkspace(h.home, 'distinct-b', { messages: ['b'], cursor: 0, worktreePath: path.join(h.home, 'wt-beta') });
    const r = run(h.home, stopPayload('sess-idfam3', false, bogusCwd));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /2 workspace\(s\)/, 'two genuinely distinct worktrees must never be merged');
    assert.match(r.json.reason, /distinct-a/);
    assert.match(r.json.reason, /distinct-b/);
  } finally { h.cleanup(); fs.rmSync(bogusCwd, { recursive: true, force: true }); }
});

test('IDENTITY-FAMILY: unreadUnknown on any family member propagates (blocks + a taxonomy\'d label, not "inbox unreadable")', () => {
  const h = makeHome();
  const bogusCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-gate-idfam-nogit-'));
  try {
    // The shared worktree is CREATED on disk: this test is about the family
    // aggregate of a LIVE workspace's unknown axis, not about a dead descriptor
    // (see the UN-CLEARABLE AXIS block at the end of this file).
    const sharedWt = path.join(h.home, 'shared-wt-unknown');
    fs.mkdirSync(sharedWt, { recursive: true });
    // 'known-quiet' has a confirmed-empty (0 unread) inbox; 'unknown-one' has
    // NO inbox file at all (known:false -> unreadUnknown), sharing the SAME
    // worktreePath -> one family whose aggregate must still surface unknown.
    seedWorkspace(h.home, 'known-quiet', { messages: [], cursor: 0, worktreePath: sharedWt });
    seedWorkspace(h.home, 'unknown-one', { worktreePath: sharedWt }); // no messages/cursor -> inbox absent -> known:false
    const r = run(h.home, stopPayload('sess-idfam4', false, bogusCwd));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /1 workspace\(s\)/);
    // Regression-fix taxonomy (see the dedicated LABEL TAXONOMY tests below):
    // a genuinely absent inbox file now reads "inbox file missing", NOT the
    // old generic "inbox unreadable" bucket that gave no actionable cause.
    assert.match(r.json.reason, /inbox file missing/, 'unreadUnknown from either member must propagate to the collapsed family, with the real cause named');
    assert.doesNotMatch(r.json.reason, /\binbox unreadable\b/, 'the old generic bucket label must not resurface once the real cause is known');
  } finally { h.cleanup(); fs.rmSync(bogusCwd, { recursive: true, force: true }); }
});

// -----------------------------------------------------------------------
// LABEL TAXONOMY + PER-MEMBER ATTRIBUTION (Fix 2 — regression from d1c8625's
// identity-family collapse). A live operator saw "primary-bf04dd47 (inbox
// unreadable)" for a descriptor whose `inboxPath` field was literally `null`
// — a wording that gave no way to act on it. These tests prove: (a) the
// label names the ACTUAL cause (missing field vs missing file vs unreadable
// file vs corrupt cursor), and (b) a sibling descriptor's failure is never
// misattributed to the Primary's own survivor id / own-summary paragraph.
// -----------------------------------------------------------------------

test('LABEL TAXONOMY: descriptor with inboxPath:null -> names the missing/malformed inboxPath field, not bare "inbox unreadable"', () => {
  const h = makeHome();
  const bogusCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-gate-idfam-nogit-'));
  try {
    seedWorkspaceWithInboxPath(h.home, 'phantom-null-inbox', null, { worktreePath: path.join(h.home, 'wt-phantom') });
    const r = run(h.home, stopPayload('sess-taxA', false, bogusCwd));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /phantom-null-inbox/);
    assert.match(r.json.reason, /descriptor has no inboxPath/i, 'must name the missing field, falsifiable from the descriptor itself');
    assert.doesNotMatch(r.json.reason, /\binbox unreadable\b/);
  } finally { h.cleanup(); fs.rmSync(bogusCwd, { recursive: true, force: true }); }
});

test('LABEL TAXONOMY: inbox file missing (ENOENT) vs present-but-unreadable (EISDIR) -> distinct labels', () => {
  const h = makeHome();
  const bogusCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-gate-idfam-nogit-'));
  try {
    // 'missing-one': a real inboxPath that was simply never written (ENOENT).
    // Its worktree is CREATED: the "inbox file missing" LABEL is only reachable
    // on a workspace that still exists — an ENOENT inbox on a GONE worktree is a
    // dead descriptor and no longer raises the unknown axis at all (see the
    // UN-CLEARABLE AXIS block at the end of this file).
    const missingWt = path.join(h.home, 'wt-missing');
    fs.mkdirSync(missingWt, { recursive: true });
    seedWorkspace(h.home, 'missing-one', { worktreePath: missingWt, cursor: 0 });
    // 'unreadable-one': inboxPath points AT A DIRECTORY — present on disk,
    // genuinely not readable as a file (EISDIR), distinct cause from ENOENT.
    const dirInbox = path.join(h.home, 'wt-unreadable-inbox-dir');
    fs.mkdirSync(dirInbox, { recursive: true });
    seedWorkspaceWithInboxPath(h.home, 'unreadable-one', dirInbox, { worktreePath: path.join(h.home, 'wt-unreadable') });
    const r = run(h.home, stopPayload('sess-taxB', false, bogusCwd));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /missing-one \(inbox file missing/, 'ENOENT must read as "inbox file missing"');
    assert.match(r.json.reason, /unreadable-one \(inbox file unreadable/, 'EISDIR must read as "inbox file unreadable" — a DIFFERENT label from missing');
  } finally { h.cleanup(); fs.rmSync(bogusCwd, { recursive: true, force: true }); }
});

test('FAMILY ATTRIBUTION: a sibling descriptor (inboxPath:null) sharing the Primary\'s OWN worktree family -> names the sibling, own-summary paragraph does NOT fire for the survivor', () => {
  const h = makeHome();
  try {
    writeOwnSummary(h.home, 0); // the Primary's OWN summary reads fine: unread 0, unknown:false
    // 'primary-bf04dd47' shares the SAME worktreePath as the Primary's own
    // cwd (REPO_CWD) -> collapses into the SAME identity family as own's
    // synthetic self-row (canonicalMeshId(REPO_CWD) === own.id, so the
    // Primary's own row is ALWAYS the survivor for this family) — but its
    // OWN inboxPath is null, reproducing the live incident field-for-field.
    seedWorkspaceWithInboxPath(h.home, 'primary-bf04dd47', null, { worktreePath: REPO_CWD });
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, new RegExp(OWN_ID + ' \\(you\\)'), 'the survivor is still the Primary\'s own id');
    assert.match(r.json.reason, /primary-bf04dd47: descriptor has no inboxPath/, 'the sibling\'s failure is named explicitly, never blamed on the survivor');
    assert.doesNotMatch(r.json.reason, /YOUR OWN inbound status could not be confirmed/, 'own-summary genuinely read fine — this paragraph must NOT fire over a SIBLING\'s unrelated failure');
  } finally { h.cleanup(); }
});

test('SELF ROW: own-summary genuinely unreadable/corrupt -> the own-summary paragraph DOES fire (regression guard)', () => {
  const h = makeHome();
  try {
    const dir = path.join(h.home, '.anti-hall', 'devswarm', 'summaries');
    fs.mkdirSync(dir, { recursive: true });
    // A zero-byte summary file is the SAME torn-write window readOwnUnread
    // treats as genuinely unknown (own.unknown:true) — distinct from ENOENT
    // ("never derived yet" -> confirmed-empty, per readOwnUnread's own header).
    fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), '');
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /YOUR OWN inbound status could not be confirmed/, 'a genuine own-summary read failure must still surface this paragraph');
  } finally { h.cleanup(); }
});

test('IDENTITY-FAMILY: sig stability — the SAME collapsed state across repeated calls never phantom-churns (reaches escalation at the cap)', () => {
  const h = makeHome();
  const bogusCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-gate-idfam-nogit-'));
  try {
    // If the collapsed set's signature were unstable across identical repeat
    // calls (e.g. member/family ordering flipping run to run), the per-SET
    // cap would never accumulate and escalation would never fire — exactly
    // the same proof shape the existing LOOP-SAFE tests use for the
    // uncollapsed path.
    const sharedWt = path.join(h.home, 'shared-wt-sig');
    seedWorkspace(h.home, 'sig-uuid-1', { messages: ['a', 'b'], cursor: 0, worktreePath: sharedWt });
    seedWorkspace(h.home, 'sig-slug-1', { messages: ['c'], cursor: 0, worktreePath: sharedWt });
    const env = { ANTIHALL_DEVSWARM_PARENT_GATE_CAP: '2' };
    const p = stopPayload('sess-idfam-sig', false, bogusCwd);
    const r1 = run(h.home, p, env); assert.strictEqual(r1.json && r1.json.decision, 'block', 'block #1');
    const r2 = run(h.home, p, env); assert.strictEqual(r2.json && r2.json.decision, 'block', 'block #2');
    const r3 = run(h.home, p, env); // effectiveBlocks === cap (2) -> escalation, never reset by a phantom-churning sig
    assert.strictEqual(r3.json && r3.json.decision, 'block', 'escalation pass #3 must still block');
    assert.match(r3.json.reason, /DEVSWARM ESCALATION/, 'the collapsed set signature must be STABLE run-to-run to ever reach escalation');
  } finally { h.cleanup(); fs.rmSync(bogusCwd, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// STATED-INTENT — a Primary that explains itself (`devswarm.js gate-intent
// --reason "..."`) must be counted DIFFERENTLY from one silently ignoring the
// gate: the escalation branch defers to a larger absolute backstop, but the
// FIRST surfacing of a condition is never suppressed, and an intent never
// carries over once the blocking signature (sig) actually changes.
// ---------------------------------------------------------------------------

function readGateState(home, sessionId) {
  return JSON.parse(fs.readFileSync(gateStateLib.stateFileFor(sessionId, home), 'utf8'));
}

// writeIntent(home, sessionId, sig, reason) — simulates exactly what
// scripts/devswarm.js's `gate-intent` CLI verb persists: merges an
// `intents: { [sig]: { ts, reason } }` entry into the EXISTING state file,
// preserving every other field. Used here instead of shelling out to the CLI
// so these hook-level tests stay fast/in-process; the CLI verb itself is
// covered separately in tests/scripts/devswarm-cli.test.js.
function writeIntent(home, sessionId, sig, reason, base) {
  const stateFile = gateStateLib.stateFileFor(sessionId, home);
  const existing = base || {};
  const next = Object.assign({}, existing, { intents: { [sig]: { ts: Date.now(), reason } } });
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(next));
}

test('STATED-INTENT: the FIRST block still fires even when an intent is already recorded for the sig (never suppresses the initial surfacing)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 }); // stable 2-unread blocking set
    // Learn the real sig via a throwaway session, then discard its state.
    const learnP = stopPayload('learn-sig-sess');
    run(h.home, learnP);
    const sig = readGateState(h.home, 'learn-sig-sess').sig;
    assert.ok(sig, 'must have learned a real sig');

    // A FRESH session that has never blocked before, but whose state file was
    // pre-seeded with an intent for the exact sig it is about to compute.
    writeIntent(h.home, 'fresh-intent-sess', sig, 'already investigating, this is expected');
    const r = run(h.home, stopPayload('fresh-intent-sess'));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block', 'an intent must never suppress the first-ever block for a session');
    assert.doesNotMatch(r.json.reason, /DEVSWARM ESCALATION/, 'the first block is a normal nag, not an escalation');
  } finally { h.cleanup(); }
});

test('STATED-INTENT: intent recorded + sig unchanged -> repeated stops do NOT escalate, and intentAcks increments', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 }); // stable 2-unread blocking set
    const env = { ANTIHALL_DEVSWARM_PARENT_GATE_CAP: '2' }; // absoluteCap = 2*5 = 10
    const p = stopPayload('intent-sustain-sess');

    const r1 = run(h.home, p, env); // pass #1: no intent yet
    assert.strictEqual(r1.json && r1.json.decision, 'block');
    const state1 = readGateState(h.home, 'intent-sustain-sess');
    assert.strictEqual(state1.intentAcks, 0, 'no intent recorded yet -> intentAcks stays 0');

    // Primary "explains itself" — record the intent for the exact sig just persisted.
    writeIntent(h.home, 'intent-sustain-sess', state1.sig, 'known backlog, handling after this task', state1);

    let lastIntentAcks = 0;
    for (let i = 0; i < 6; i++) { // well under absoluteCap(10), well past the plain cap(2)
      const r = run(h.home, p, env);
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.json && r.json.decision, 'block', `pass ${i + 2} must still block`);
      assert.doesNotMatch(r.json.reason, /DEVSWARM ESCALATION/, `pass ${i + 2} must NOT escalate while an intent is on file`);
      const st = readGateState(h.home, 'intent-sustain-sess');
      assert.ok(st.intentAcks > lastIntentAcks, `intentAcks must increment (pass ${i + 2}): was ${lastIntentAcks}, now ${st.intentAcks}`);
      lastIntentAcks = st.intentAcks;
    }
  } finally { h.cleanup(); }
});

test('STATED-INTENT: sig CHANGES after an intent was recorded -> escalation behavior returns to normal (intent does not carry over)', () => {
  const h = makeHome();
  try {
    const seeded = seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 });
    const env = { ANTIHALL_DEVSWARM_PARENT_GATE_CAP: '2' };
    const p = stopPayload('intent-sig-change-sess');

    const r1 = run(h.home, p, env);
    const state1 = readGateState(h.home, 'intent-sig-change-sess');
    writeIntent(h.home, 'intent-sig-change-sess', state1.sig, 'on it', state1);
    const r2 = run(h.home, p, env); // still same sig -> covered by intent, no escalation
    assert.doesNotMatch(r2.json.reason, /DEVSWARM ESCALATION/, 'still covered by the intent before the sig changes');

    // Change the actual unread content -> a genuinely NEW blocking signature.
    fs.appendFileSync(seeded.inboxPath, JSON.stringify({ m: 'c' }) + '\n');

    // Drive the (now intent-free) new sig through the PLAIN cap (2) until it
    // escalates — proves the old intent does not silently carry over.
    let escalated = false;
    for (let i = 0; i < 6 && !escalated; i++) {
      const r = run(h.home, p, env);
      if (r.json && /DEVSWARM ESCALATION/.test(r.json.reason)) escalated = true;
    }
    assert.ok(escalated, 'the new sig must still escalate at the plain cap — the prior intent must not apply to it');
    const stFinal = readGateState(h.home, 'intent-sig-change-sess');
    assert.ok(!stFinal.intents || !stFinal.intents[state1.sig], 'the OLD sig\'s intent must be pruned once the sig has moved on');
  } finally { h.cleanup(); }
});

test('STATED-INTENT: no intent recorded -> existing escalate-at-cap behavior is UNCHANGED (regression guard)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 });
    const env = { ANTIHALL_DEVSWARM_PARENT_GATE_CAP: '2' };
    const p = stopPayload('no-intent-regression-sess');
    run(h.home, p, env); // block #1
    run(h.home, p, env); // block #2
    const r3 = run(h.home, p, env); // effectiveBlocks === cap(2) -> escalation
    assert.match(r3.json && r3.json.reason, /DEVSWARM ESCALATION/, 'no stated intent -> escalates exactly like before this feature');
    const r4 = run(h.home, p, env);
    assert.strictEqual(r4.stdout, '', 'then goes quiet, exactly as before');
  } finally { h.cleanup(); }
});

test('STATED-INTENT: the absolute cap still bounds the loop even with an intent present', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 });
    const env = { ANTIHALL_DEVSWARM_PARENT_GATE_CAP: '2' }; // absoluteCap = 10
    const p = stopPayload('intent-absolute-cap-sess');

    run(h.home, p, env); // pass #1, no intent yet
    const state1 = readGateState(h.home, 'intent-absolute-cap-sess');
    writeIntent(h.home, 'intent-absolute-cap-sess', state1.sig, 'deferring escalation deliberately', state1);

    let escalated = false;
    let sawSilenceAfter = false;
    for (let i = 0; i < 20 && !sawSilenceAfter; i++) {
      const r = run(h.home, p, env);
      if (!escalated) {
        if (r.json && /DEVSWARM ESCALATION/.test(r.json.reason)) escalated = true;
      } else {
        // The pass immediately after escalation must go silent, exactly like
        // the plain (no-intent) axis already does.
        assert.strictEqual(r.stdout, '', 'must go quiet the pass after the absolute-cap escalation');
        sawSilenceAfter = true;
      }
    }
    assert.ok(escalated, 'an intent must not make the gate loop forever — the absolute backstop must eventually escalate');
    assert.ok(sawSilenceAfter, 'and then go quiet, same as the plain axis');
  } finally { h.cleanup(); }
});

test('STATED-INTENT: a state file with NO intents key (prior shape) loads and behaves exactly as before', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 });
    const p = stopPayload('legacy-shape-sess');
    // Pre-seed a PRE-FEATURE-shaped state file: no `intents`/`intentAcks` keys
    // at all, exactly what every state file looked like before this change.
    const stateFile = gateStateLib.stateFileFor('legacy-shape-sess', h.home);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ sig: 'stale-sig-does-not-match', blocks: 1, escalated: false, qSig: '', qBlocks: 0, qEscalated: false }));
    const r = run(h.home, p);
    assert.strictEqual(r.status, 0, 'must not throw on a legacy-shaped state file');
    assert.strictEqual(r.json && r.json.decision, 'block', 'must behave exactly as before — a normal block');
    assert.doesNotMatch(r.json.reason, /DEVSWARM ESCALATION/, 'a fresh (mismatched) sig never escalates on its first real pass');
  } finally { h.cleanup(); }
});

test('STATED-INTENT: the injected block reason NEVER echoes the stored reason text (injection hygiene)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 });
    const p = stopPayload('no-echo-sess');
    run(h.home, p); // learn the sig
    const state1 = readGateState(h.home, 'no-echo-sess');
    const secretReason = 'TOTALLY-UNIQUE-REASON-TEXT-9f3a-should-never-be-echoed';
    writeIntent(h.home, 'no-echo-sess', state1.sig, secretReason, state1);
    const r = run(h.home, p);
    assert.strictEqual(r.status, 0);
    assert.ok(r.json && typeof r.json.reason === 'string', 'must still block with a reason');
    assert.doesNotMatch(r.json.reason, /TOTALLY-UNIQUE-REASON-TEXT-9f3a/, 'the stored reason text must never appear in the injected output');
    assert.doesNotMatch(r.json.reason, /should-never-be-echoed/, 'the stored reason text must never appear in the injected output');
  } finally { h.cleanup(); }
});

test('STATED-INTENT: FAIL-OPEN — a corrupt/unreadable gate-state file behaves exactly as today (no throw)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { messages: ['a', 'b'], cursor: 0 });
    const p = stopPayload('corrupt-state-sess');
    const stateFile = gateStateLib.stateFileFor('corrupt-state-sess', h.home);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, '{ this is not valid json,,, ]]]');
    const r = run(h.home, p);
    assert.strictEqual(r.status, 0, 'must exit 0, never throw on a corrupt state file');
    assert.strictEqual(r.json && r.json.decision, 'block', 'must fail open toward a normal first block, exactly as pre-intent behavior');
    assert.doesNotMatch(r.json.reason, /DEVSWARM ESCALATION/, 'a corrupt file must be treated as fresh state, not pre-exhausted');
  } finally { h.cleanup(); }
});

// =========================================================================
// UN-CLEARABLE AXIS (defect: a Primary blocked EVERY turn, permanently, over a
// workspace whose worktree no longer exists).
//
// Live evidence this reproduces: `~/.anti-hall/devswarm/workspaces/8f3d585d-…`
// stayed LIVE while its slug twin was archived, its worktree dir was EMPTY on
// disk, liveness.js mapped the ENOENT inbox to reason 'inbox-missing'/known:false,
// and `unreadUnknown` ALONE satisfied the block predicate. The Primary could not
// clear it by ANY action — there was no inbox to read and no child to poke.
//
// The refined rule: 'inbox-missing' (ENOENT) AND a gone worktreePath is a DEAD
// DESCRIPTOR, not neglect. Every other axis is deliberately left intact, and the
// tests below pin each one so the suppression can never widen into silence.
// =========================================================================

test('UN-CLEARABLE AXIS: inbox ENOENT + worktree GONE -> does NOT block (the permanent unclearable nag)', () => {
  const h = makeHome();
  try {
    // worktreePath defaults to <home>/wt/<id>, which is NEVER created -> gone.
    seedWorkspace(h.home, 'dead-ws', {}); // no messages/cursor -> inbox file absent (ENOENT)
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.stdout, '', `a physically-gone workspace is a dead descriptor, not neglect; got: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('MUST NOT BREAK: LIVE worktree + inbox ENOENT -> STILL blocks (the genuine anomaly fail-open survives)', () => {
  const h = makeHome();
  try {
    const liveWt = path.join(h.home, 'live-wt-enoent');
    fs.mkdirSync(liveWt, { recursive: true }); // the worktree EXISTS -> not a dead descriptor
    seedWorkspace(h.home, 'live-anomaly', { worktreePath: liveWt }); // inbox absent
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block',
      'a pre-fix legacy child / failed inbox write on a LIVE worktree must still be surfaced');
    assert.match(r.json.reason, /live-anomaly/);
    assert.match(r.json.reason, /inbox file missing/);
  } finally { h.cleanup(); }
});

test('MUST NOT BREAK: LIVE worktree + a real unread backlog -> STILL blocks on the realUnread axis', () => {
  const h = makeHome();
  try {
    const liveWt = path.join(h.home, 'live-wt-backlog');
    fs.mkdirSync(liveWt, { recursive: true });
    seedWorkspace(h.home, 'live-backlog', { worktreePath: liveWt, messages: ['a', 'b', 'c'], cursor: 0 });
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /live-backlog/);
    assert.match(r.json.reason, /3 unread/);
  } finally { h.cleanup(); }
});

test('MUST NOT BREAK: worktree GONE + STORE-side unread -> STILL blocks on the unionUnread axis (nothing is hidden)', () => {
  const h = makeHome();
  try {
    // Gone worktree (never created) BUT a persisted repoKey naming THIS project,
    // so the union falls back to the only key still knowable. Sender is NOT this
    // Primary, so the outbound-not-neglect exclusion does not apply.
    seedWorkspace(h.home, 'gone-with-store', { repoKey: REPO_KEY }); // inbox absent (ENOENT)
    seedStoreOnlyRow(h.home, 'gone-with-store', 'some-child', 'test-dead-union-1');
    const r = run(h.home, stopPayload()); // cwd = REPO_CWD -> selfKey resolves
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block',
      'a removed workspace with real store-side backlog must NOT go silent');
    assert.match(r.json.reason, /gone-with-store/);
    assert.match(r.json.reason, /1 unread/);
  } finally { h.cleanup(); }
});

test('MUST NOT BREAK: worktree GONE + a CORROBORATED stale verdict -> STILL blocks on the staleOrEscalated axis', () => {
  const h = makeHome();
  try {
    // A1 fix note: the un-clearable-axis rule (above) deliberately makes the
    // unread-unknown axis permanently un-clearable for a gone worktree with a
    // missing inbox — unionUnread stays 0 forever and unreadUnknown stays
    // false forever for this row. Without a corroborating `pending:true` on
    // the verdict itself (or an unanswered question), a bare stale/escalated
    // STATUS here would now be exactly the A1 defect shape: a block with
    // NO axis that could ever clear it. `pending:true` is what makes this a
    // legitimate, correctable block instead.
    seedWorkspace(h.home, 'gone-stale', { verdict: { status: 'stale', pending: true } }); // inbox absent, worktree gone
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /gone-stale/);
  } finally { h.cleanup(); }
});

test('A1 fix: worktree GONE + an UNCORROBORATED stale verdict -> does NOT block (would otherwise block forever)', () => {
  const h = makeHome();
  try {
    // Same fixture as the corroborated test above, MINUS `pending:true` — the
    // un-clearable-axis rule means unionUnread/unreadUnknown can NEVER
    // corroborate this row, so an uncorroborated status here would block
    // every single turn with no possible remediation. This is the exact
    // pathology A1 closes.
    seedWorkspace(h.home, 'gone-stale-uncorr', { verdict: { status: 'stale' } });
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.status, 0);
    assert.notStrictEqual(r.json && r.json.decision, 'block', 'an uncorroborated stale verdict on a permanently un-clearable row must never block forever');
  } finally { h.cleanup(); }
});

test('STRICTLY SCOPED: worktree GONE but inbox present-and-UNREADABLE (EISDIR, not ENOENT) -> STILL blocks', () => {
  const h = makeHome();
  try {
    // inboxPath points AT A DIRECTORY: the file IS there, it is genuinely not
    // readable. Only ENOENT means "there is nothing to read"; every other errno
    // is a real anomaly and must survive the suppression untouched.
    const dirInbox = path.join(h.home, 'gone-eisdir-inbox-dir');
    fs.mkdirSync(dirInbox, { recursive: true });
    seedWorkspaceWithInboxPath(h.home, 'gone-eisdir', dirInbox, { worktreePath: path.join(h.home, 'never-created-wt') });
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block',
      'EISDIR is not ENOENT — a gone worktree must not launder an unreadable inbox into silence');
    assert.match(r.json.reason, /gone-eisdir \(inbox file unreadable/);
  } finally { h.cleanup(); }
});

test('STRICTLY SCOPED: worktree GONE + descriptor with inboxPath:null (no-inbox-path) -> STILL blocks', () => {
  const h = makeHome();
  try {
    seedWorkspaceWithInboxPath(h.home, 'gone-nullinbox', null, { worktreePath: path.join(h.home, 'never-created-wt-2') });
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block',
      'a malformed descriptor is an anomaly regardless of its worktree');
    assert.match(r.json.reason, /descriptor has no inboxPath/i);
  } finally { h.cleanup(); }
});

test('FAIL-CLOSED TO BLOCK: worktreePath that EXISTS as a dangling symlink is NOT "gone" -> inbox ENOENT still blocks', () => {
  const h = makeHome();
  try {
    // lstat (not stat) is what worktreeIsGone uses: a dangling symlink is a real
    // entry on disk. "I could not prove it is gone" must never read as gone.
    const link = path.join(h.home, 'dangling-wt-link');
    fs.symlinkSync(path.join(h.home, 'no-such-target'), link);
    seedWorkspace(h.home, 'dangling-ws', { worktreePath: link });
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /dangling-ws/);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// WORKTREE-GONE AUTHORITY (adversarial-review round). `worktreeIsGone` is the
// ONLY signal that can SUPPRESS the missing-inbox block, so every answer it
// gives that is not a positively-proven ENOENT on an ABSOLUTE path is a live
// workspace silently going un-nagged. Mutation checks these kill:
//   M4 — `gone = !!e` (any lstat error read as gone): ENOTDIR case below.
//   M5 — lstat'ing a RELATIVE path against the READER's cwd: P1 case below.
// (See tests/scripts/devswarm-archive-identity-family.test.js for the full
// mutation list; these two live here because the gate owns the predicate.)
// ---------------------------------------------------------------------------

test('P1 FAIL-CLOSED: a RELATIVE worktreePath is NEVER "gone" -> a LIVE workspace with a missing inbox still blocks', () => {
  const h = makeHome();
  try {
    // The exact live shape: registration persisted a relative path that resolved
    // fine from the REGISTERING cwd. The Primary's Stop hook runs from a
    // DIFFERENT cwd, where lstat('live-wt') is ENOENT — and the pre-fix predicate
    // read that as "the workspace is gone", suppressing the block for a workspace
    // that is very much alive.
    const rel = 'live-wt-' + process.pid;
    assert.strictEqual(fs.existsSync(path.join(process.cwd(), rel)), false,
      'precondition: the relative path must NOT resolve from the hook process cwd');
    seedWorkspace(h.home, 'relative-live', { worktreePath: rel }); // inbox absent (ENOENT)
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block',
      'an unresolvable RELATIVE path is not proof of death — it must not silence the gate');
    assert.match(r.json.reason, /relative-live/);
  } finally { h.cleanup(); }
});

test('V4 FAIL-CLOSED (kills any-error-is-gone): worktreePath under a FILE (ENOTDIR, not ENOENT) is NOT "gone" -> still blocks', () => {
  const h = makeHome();
  try {
    // lstat here fails with ENOTDIR, not ENOENT. A predicate that treats every
    // lstat error as "gone" passes the dangling-symlink test above (that one
    // SUCCEEDS) while still laundering this real anomaly into silence.
    const file = path.join(h.home, 'a-regular-file');
    fs.writeFileSync(file, 'x');
    const under = path.join(file, 'sub-wt');
    let errno = null;
    try { fs.lstatSync(under); } catch (e) { errno = e && e.code; }
    assert.strictEqual(errno, 'ENOTDIR', 'precondition: lstat must fail with ENOTDIR, not ENOENT');
    seedWorkspace(h.home, 'enotdir-ws', { worktreePath: under }); // inbox absent
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block',
      'ENOTDIR is "I could not tell", never "it is gone"');
    assert.match(r.json.reason, /enotdir-ws/);
  } finally { h.cleanup(); }
});

test('V3 (kills the repoKey-only union fallback): worktree GONE + STORE-side unread on an ownerKey-ONLY descriptor STILL blocks', () => {
  const h = makeHome();
  try {
    // The rehomeCore shape: ownerKey set, repoKey ABSENT. The sibling test above
    // seeds `repoKey`, so an implementation that falls back to repoKey ONLY —
    // and reads this descriptor as "names no project" — survives it untouched
    // while hiding real store-side backlog for every re-homed workspace.
    seedWorkspace(h.home, 'gone-ownerkey-only', { ownerKey: REPO_KEY });
    const desc = JSON.parse(fs.readFileSync(
      path.join(h.home, '.anti-hall', 'devswarm', 'workspaces', 'gone-ownerkey-only.json'), 'utf8'));
    assert.strictEqual(desc.repoKey, undefined, 'precondition: repoKey must be ABSENT');
    assert.strictEqual(desc.ownerKey, REPO_KEY, 'precondition: ownerKey carries the project');
    seedStoreOnlyRow(h.home, 'gone-ownerkey-only', 'some-child', 'test-ownerkey-union-1');

    const r = run(h.home, stopPayload());
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block',
      'an ownerKey-only descriptor with real store-side backlog must NOT go silent');
    assert.match(r.json.reason, /gone-ownerkey-only/);
    assert.match(r.json.reason, /1 unread/);
  } finally { h.cleanup(); }
});

// ============================================================================
// A1 (field defect, live-verified 2026-08-28): a PERSISTED verdict of
// `{"status":"escalated","pending":false,"notDraining":false}` — the verdict
// ITSELF says nothing is outstanding — still force-blocked the Primary ~20
// consecutive turns, because `readVerdictStatus` (now `readVerdict`) discarded
// everything but `v.status`, and `escalated` is STICKY (liveness.js's TERMINAL
// short-circuit returns it unchanged forever, cleared only by a fresh
// heartbeat a finished session will never emit).
//
// Fix: `status === 'stale' | 'escalated'` alone can no longer drive a hard
// block. It must be corroborated by an OR of FOUR axes: (1) the verdict's own
// `pending`, (2) this family's union unread > 0, (3) unreadUnknown, (4) an
// unanswered question FROM one of this family's own member ids. Exact
// expression (family loop, devswarm-parent-gate.js):
//   const corroborated = verdictPending || unionUnread > 0 || unreadUnknown || familyHasUnansweredQuestion;
// Uncorroborated -> ONE-TIME stderr advisory, decision left non-blocking
// (never `decision:'block'`) — the alarm is not silenced project-wide, only
// this specific unsubstantiated block is downgraded.
//
// MUTATION-CHECK (documented per anti-hall discipline; each entry below was
// ACTUALLY applied to devswarm-parent-gate.js and the suite re-run to confirm
// the kill):
//   1. Drop `verdictPending ||` from the OR -> a verdict carrying
//      `pending:true` with NOTHING else corroborating would flip from
//      'block' to no-block. KILLED by "A1 GREEN companion" below (also
//      re-verifies "MUST NOT BREAK: worktree GONE + a CORROBORATED stale
//      verdict" above, which relies on `pending:true` ALONE).
//   2. Drop `unionUnread > 0 ||` from the OR -> a family with real unread
//      but a status-only verdict would flip. KILLED by the pre-existing
//      "REAL: unread has a genuine inbound message -> BLOCKS" test (unread
//      alone, no verdict at all, must still block) and by "MUST NOT BREAK:
//      worktree GONE + STORE-side unread -> STILL blocks on the unionUnread
//      axis" (both already in this file, both re-run green against the
//      unmutated fix).
//   3. Drop the WHOLE corroboration gate (i.e. revert to bare
//      `status==='stale'||status==='escalated'`) -> the A1 RED case below
//      would return to blocking. This IS the literal RED case, reproduced
//      live below.
//   4. Invert the gate (block ONLY when corroborated is FALSE) -> every
//      corroborated test in this file (e.g. "BLOCK: stale verdict with no
//      unread", now carrying `pending:true`) would flip to no-block.
//      KILLED by re-running this file's full corroborated-block suite.
// ============================================================================

test('A1 RED->GREEN: an escalated verdict with pending:false/notDraining:false, live worktree, readable+0-unread inbox, no pending question -> does NOT block (live-proof shape)', () => {
  const h = makeHome();
  try {
    // Matches the live incident's verdict file byte-for-byte:
    // {"status":"escalated","pending":false,"notDraining":false}
    seedWorkspace(h.home, 'a1-live', {
      messages: ['a'], cursor: 1, // 0 unread — fully acked
      verdict: { status: 'escalated', pending: false, notDraining: false },
    });
    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.notStrictEqual(r.json && r.json.decision, 'block',
      'an uncorroborated escalated verdict (no pending, no unread, no unanswered question) must not force-block forever');
  } finally { h.cleanup(); }
});

test('A1 GREEN companion: the SAME shape but pending:true STILL blocks — the fix must not be widened to ignore a genuinely corroborated verdict', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'a1-live-corr', {
      messages: ['a'], cursor: 1, // still 0 unread on the NDJSON/union axis
      verdict: { status: 'escalated', pending: true, notDraining: false },
    });
    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block',
      'the verdict\'s OWN pending:true must still corroborate and block — never narrow the axis set to unread alone');
    assert.match(r.json.reason, /escalated/);
  } finally { h.cleanup(); }
});

test('A1: an uncorroborated stale (not just escalated) verdict is likewise downgraded — same corroboration gate for both statuses', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'a1-stale-uncorr', {
      messages: ['a'], cursor: 1,
      verdict: { status: 'stale', pending: false, notDraining: false },
    });
    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.notStrictEqual(r.json && r.json.decision, 'block', 'stale is gated by the SAME corroboration rule as escalated');
  } finally { h.cleanup(); }
});

// =========================================================================
// A2 FIX — LIVE-TEARDOWN WINDOW (the OTHER half of the un-clearable-axis
// rule above). The v0.85.0 fix above (worktreeIsGone -> deadDescriptor) only
// covers a PHYSICALLY-GONE worktree. In the live incident this closes, the
// worktree still EXISTS on disk (`.devswarm-temp/` mid-teardown) while its
// native `inbox.ndjson` is absent (ENOENT) — worktreeIsGone(d.worktreePath)
// is FALSE, so the pre-fix code fell straight to `unreadUnknown = true` and
// NEVER attempted the store (the actual source of delivery truth, storeSeq)
// even though the Primary's messages had already been delivered there.
//
// The fix (hooks/devswarm-parent-gate.js ~687-744): on `reason ===
// 'inbox-missing'` (ENOENT ONLY) with a LIVE worktree and NOT a foreign
// project, try the store BEFORE giving up to the unknown axis. Only when the
// store is ALSO unreadable does `unreadUnknown` fire.
// =========================================================================

test('A2 FIX: LIVE worktree + inbox ENOENT + store partition present with REAL (drained) history -> does NOT block', () => {
  const h = makeHome();
  const wt = makeLinkedWorktree();
  try {
    // worktreePath is a REAL, git-resolvable linked worktree (same repoKey as
    // REPO_KEY) -> NOT a dead descriptor, NOT foreign. No `messages`/`cursor`
    // passed -> the native inbox is never written (ENOENT), reproducing the
    // mid-teardown window verbatim. Seed ONE real store-direct row addressed to
    // this workspace FROM this Primary itself (OWN_ID) -- the exact live
    // incident this fix closes: the Primary's OWN message had already been
    // delivered via the store (storeSeq), so messageCount>0 is REAL history
    // (not an empty, never-touched partition — see the REAL-HISTORY GUARD
    // comment in hooks/devswarm-parent-gate.js, which this fixture is
    // deliberately shaped to satisfy: allRows.length>0). It nets to 0 unread
    // via the pre-existing FIX-3a own-outbound-is-not-neglect exclusion in the
    // UNION block, not because the store was empty.
    seedWorkspace(h.home, 'a2-live-drained', { worktreePath: wt.dir });
    seedStoreOnlyRow(h.home, 'a2-live-drained', OWN_ID, 'test-a2-green-1');
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.stdout, '',
      `a live worktree whose inbox is ENOENT but whose store conclusively shows real, already-accounted-for history must NOT block; got: ${r.stdout}`);
  } finally { h.cleanup(); wt.cleanup(); }
});

test('A2 GUARD (a): same fixture but store shows unread>0 from a CHILD sender -> STILL blocks', () => {
  const h = makeHome();
  const wt = makeLinkedWorktree();
  try {
    seedWorkspace(h.home, 'a2-live-childunread', { worktreePath: wt.dir });
    seedStoreOnlyRow(h.home, 'a2-live-childunread', 'some-other-child', 'test-a2-guard-a-1');
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block',
      'a genuine store-side unread row from a child must still block even though the native inbox is ENOENT');
    assert.match(r.json.reason, /a2-live-childunread/);
    assert.match(r.json.reason, /1 unread/);
  } finally { h.cleanup(); wt.cleanup(); }
});

test('A2 GUARD (b): EACCES inbox (not ENOENT) -> STILL blocks regardless of the store', () => {
  const h = makeHome();
  const wt = makeLinkedWorktree();
  try {
    const { inboxPath } = seedWorkspace(h.home, 'a2-live-eacces', { worktreePath: wt.dir });
    fs.writeFileSync(inboxPath, 'x'); // a real file so a permission error, not ENOENT, is what fires
    fs.chmodSync(inboxPath, 0o000);
    // Store side is CONCLUSIVE (real, drained history — the SAME shape the A2
    // FIX test above uses to legitimately clear an ENOENT inbox) -- this is
    // deliberate: if the fix's errno check ever widened past the literal
    // 'inbox-missing' string (mutation i), THIS store would wrongly answer for
    // an EACCES row too and silently clear the block. An empty store would not
    // expose that mutation (both scoped and widened code paths fail closed on
    // an empty store), so this fixture must NOT be left empty.
    seedStoreOnlyRow(h.home, 'a2-live-eacces', OWN_ID, 'test-a2-guard-b-1');
    let precheckErrno = null;
    try { fs.readFileSync(inboxPath, 'utf8'); } catch (e) { precheckErrno = e && e.code; }
    try {
      assert.notStrictEqual(precheckErrno, 'ENOENT', 'precondition: must be a permission failure, not ENOENT');
      const r = run(h.home, stopPayload());
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.json && r.json.decision, 'block',
        'EACCES must never be laundered through the ENOENT-only store fallback');
      assert.match(r.json.reason, /a2-live-eacces/);
    } finally {
      fs.chmodSync(inboxPath, 0o644); // restore so h.cleanup() can remove the tree
    }
  } finally { h.cleanup(); wt.cleanup(); }
});

test('A2 GUARD (c): store ALSO unreadable (unresolvable repoKey) -> STILL blocks via the unknown axis', () => {
  const h = makeHome();
  try {
    // A worktreePath that EXISTS on disk (worktreeIsGone -> false) but is NOT a
    // git worktree at all -> repoKeyForWorktree cannot resolve a repoKey, so
    // openStoreForUnread structurally cannot open a store. The store is
    // "reachable enough to attempt" in intent but never actually answerable —
    // the fallback must fail closed to unknown, exactly like the pre-fix path.
    const plainDir = path.join(h.home, 'a2-live-nostorekey-wt');
    fs.mkdirSync(plainDir, { recursive: true });
    seedWorkspace(h.home, 'a2-live-nostorekey', { worktreePath: plainDir }); // inbox absent (ENOENT)
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block',
      'when BOTH the inbox and the store are unreadable, the unknown axis must still fire');
    assert.match(r.json.reason, /a2-live-nostorekey/);
    assert.match(r.json.reason, /inbox file missing/);
  } finally { h.cleanup(); }
});

test('A2 GUARD (d): foreignProject + inbox ENOENT + REAL drained history in the OTHER project store -> STILL blocks (no cross-project read)', () => {
  const h = makeHome();
  try {
    // worktreePath EXISTS on disk (worktreeIsGone -> false) but is NOT a git
    // worktree (freshKey unresolvable, same shape as GUARD (c)) -- the ONLY
    // way `foreignProject` can ever be true for this branch (its own
    // definition requires `!freshKey`, see devswarm-parent-gate.js's
    // `foreignProject` derivation). Persisted `repoKey` names a DIFFERENT
    // project than REPO_KEY -> foreignProject === true. The OTHER project's
    // store partition (keyed by the registered/foreign key) is seeded with
    // REAL, drained history (own-sender row) — the exact positive signal
    // that clears the block in the A2 FIX test above — so if the
    // foreignProject guard were ever dropped AND rewired to open that
    // partition (e.g. via `registeredKey`, mirroring the deadDescriptor
    // union widening), this fixture would catch it going silent.
    const foreignKey = 'other-project-fakekey';
    const plainDir = path.join(h.home, 'a2-live-foreign-wt');
    fs.mkdirSync(plainDir, { recursive: true });
    seedWorkspace(h.home, 'a2-live-foreign', { worktreePath: plainDir, repoKey: foreignKey });
    const s = meshStore.openStore({ home: h.home, workspaceId: 'a2-live-foreign', hash: foreignKey });
    try {
      meshStore.appendMeshMessage(s, { from: OWN_ID, to: 'a2-live-foreign', type: 'direct', message: 'foreign store row', timestamp: Date.now(), hash: 'test-a2-guard-d-1' });
    } finally { s.close(); }
    const r = run(h.home, stopPayload());
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block',
      'a foreign-project descriptor must never be cleared by that OTHER project\'s store, no matter how "conclusive" it looks');
    assert.match(r.json.reason, /a2-live-foreign/);
  } finally { h.cleanup(); }
});

// -----------------------------------------------------------------------
// MUTATION CHECKS (documented per the assignment's requirement). Each test
// below deliberately re-introduces one of the three named regressions the
// governing constraint calls out, and asserts the mutated behavior IS what a
// SPY on the real primitives would produce if the guard above did not exist
// — i.e. these pin the INVARIANT a mutant would break, so a mutation that
// removes the corresponding guard in the source causes the sibling GUARD
// test above (not these) to fail. Verified LIVE against the fixed source (not
// just reasoned about) by temporarily re-applying each mutation and
// confirming the named test below flips red, then reverting:
//   (i)   widen errno scope beyond the literal 'inbox-missing' string ->
//         KILLED by GUARD (b) (verified: with the scope widened, GUARD (b)
//         goes from ✔ to ✖ — an EACCES row with real drained store history
//         wrongly clears).
//   (ii)  drop the real-history requirement (`storeConclusive = true`
//         unconditionally whenever a store handle opens) -> KILLED by the
//         pre-existing "FAIL-OPEN (P0-2, REAL registration path)" test
//         (verified: with the requirement dropped, that test goes from ✔ to
//         ✖ — a freshly-registered real child whose store was only ever
//         opened for registry bookkeeping, never a message, wrongly clears).
//         GUARD (c) does NOT catch this specific mutation (its fixture never
//         reaches an open store handle at all), so the existing regression
//         test is the one pinning it — noted here rather than duplicating a
//         redundant fixture.
//   (iii) drop the `!foreignProject` guard on the store open -> VERIFIED
//         UNREACHABLE by construction, not merely "covered by another
//         suite": `foreignProject` is defined as
//         `!!(selfKey && !freshKey && registeredKey && registeredKey !==
//         selfKey)` (devswarm-parent-gate.js), which REQUIRES `freshKey` to
//         be falsy. This branch's store open always passes
//         `repoKey: freshKey` verbatim (never re-resolves, never falls back
//         to `registeredKey`) — so whenever `foreignProject` is true,
//         `freshKey` is null, `openStoreForUnread` returns null on that
//         `repoKey` alone, and `storeConclusive` stays false regardless of
//         the `!foreignProject` check's presence. Confirmed live: dropping
//         the check left ALL 105 tests in this file green, including GUARD
//         (d) above (a store CAN exist and be conclusive for the foreign
//         key — GUARD (d) proves the code never reaches for it). The
//         `!foreignProject` check is kept as defense-in-depth documentation
//         matching the assignment's explicit instruction, and GUARD (d)
//         pins the actual externally-observable contract (a foreign
//         project's store is never consulted) so a FUTURE change that wires
//         `registeredKey` into this specific probe (making the guard live)
//         would be caught immediately.
// -----------------------------------------------------------------------

// ============================================================================
// DEFECT 427dbff95f28 (P1, field report): the Primary replies to a child's
// needsReply question via a plain `send --to <uuid-row>`, but the Stop-gate
// still reports UNANSWERED forever. Root cause: a pendingQuestion's `from` is
// the sender's REGISTRY-ROW id as resolveSenderRegistryId (devswarm-store.js)
// resolves it — whichever row is "freshest LIVE" among every row sharing the
// sender's worktree-derived meshId — but a reply's recorded key
// (devswarm-parent-reply-tracker.js's recordReply(repoKey, home, resp.toId,
// ts)) is whichever row scripts/devswarm.js's resolveSendTarget ACTUALLY
// resolved `--to` to: an EXACT registry-id match (e.g. addressing the child's
// UUID row directly) wins there independent of liveness. A child can be known
// by a UUID row, a slug row, AND a primary-<8hex> builder id — different rows,
// same logical agent (devswarm-identity-family.js's own header) — so these two
// independently-computed identities can diverge for the SAME agent, and
// unansweredQuestions()'s raw string compare (`state[q.from]`) never sees a
// reply that landed on a sibling row.
//
// The fix (devswarm-parent-gate.js, in the `unanswered` block right after
// `unansweredQuestions()` runs): cross-check every remaining "unanswered"
// entry against every OTHER member of its identity family (grouped by
// resolved worktree, via devswarm-identity-family.js's collapseFamilies — the
// SAME grouping this file already uses for the blocking-family reduction) for
// a reply recorded at-or-after the question's effective ts.
// ============================================================================

test('DEFECT 427dbff95f28 FIX: a reply to a DIFFERENT registry row of the SAME identity family (UUID row vs builder-id row, same worktree) clears the question', () => {
  const h = makeHome();
  const wt = makeLinkedWorktree();
  try {
    const childUuidRow = 'a1b2c3d4-1111-2222-3333-444455556666';
    const childBuilderRow = 'primary-63f9261d';
    // Both rows registered against the SAME child worktree — the UUID-row /
    // builder-id-row shape this defect's report names explicitly.
    seedWorkspace(h.home, childUuidRow, { messages: [], cursor: 0, worktreePath: wt.dir });
    seedWorkspace(h.home, childBuilderRow, { messages: [], cursor: 0, worktreePath: wt.dir });

    const ts = Date.now() - 5 * 60000;
    // The question's `from` is the builder-id row — what
    // resolveSenderRegistryId's "freshest LIVE" pick would resolve to.
    writeOwnSummary(h.home, 0, undefined, [{ from: childBuilderRow, ts, seq: 1 }]);
    const p = stopPayload('idfam-427-sess', true); // withCwd -> REPO_CWD -> resolvable REPO_KEY

    const before = run(h.home, p);
    assert.strictEqual(before.json && before.json.decision, 'block', 'must block while genuinely unanswered');
    assert.match(before.json.reason, /UNANSWERED QUESTION/);

    // The Primary replies by a PLAIN send addressed to the child's UUID row
    // instead — recordReply is keyed under the UUID row's id (resp.toId), a
    // DIFFERENT string than the question's `from`, reproducing the exact field
    // defect (repro verified directly against devswarm-store.js +
    // devswarm-reply-state.js before this fix was written).
    replyStateLib.recordReply(REPO_KEY, h.home, childUuidRow, ts + 60000);

    const after = run(h.home, p);
    assert.strictEqual(after.status, 0);
    assert.strictEqual(after.stdout, '',
      `a reply landing on ANY member of the SAME identity family must clear the question; got: ${after.stdout}`);
  } finally { h.cleanup(); wt.cleanup(); }
});

test('DEFECT 427dbff95f28 NEGATIVE CONTROL: a reply recorded under an UNRELATED workspace (different worktree/family) must NOT clear the question (no false negative)', () => {
  const h = makeHome();
  const wtA = makeLinkedWorktree();
  const wtB = makeLinkedWorktree();
  try {
    const askerRow = 'primary-aaaaaaaa';
    const unrelatedRow = 'primary-bbbbbbbb';
    seedWorkspace(h.home, askerRow, { messages: [], cursor: 0, worktreePath: wtA.dir });
    seedWorkspace(h.home, unrelatedRow, { messages: [], cursor: 0, worktreePath: wtB.dir });

    const ts = Date.now() - 5 * 60000;
    writeOwnSummary(h.home, 0, undefined, [{ from: askerRow, ts, seq: 1 }]);
    const p = stopPayload('idfam-427-negctrl-sess', true);

    // Reply recorded for a GENUINELY different worktree/identity family.
    replyStateLib.recordReply(REPO_KEY, h.home, unrelatedRow, ts + 60000);

    const r = run(h.home, p);
    assert.strictEqual(r.json && r.json.decision, 'block',
      'a reply to an UNRELATED workspace (different family) must never clear a DIFFERENT family\'s unanswered question');
    assert.match(r.json.reason, /UNANSWERED QUESTION/);
  } finally { h.cleanup(); wtA.cleanup(); wtB.cleanup(); }
});

// MUTATION-TESTED (non-vacuousness proof for the two tests above). Both
// mutations were applied live to devswarm-parent-gate.js's unanswered-block
// identity-family cross-check, confirmed RED, then reverted and confirmed
// GREEN again (see the task's returned evidence for the actual command
// output — recorded here so a future reader can reproduce the same proof):
//   (i)  Delete the entire identity-family cross-check block (restore
//        `unanswered = rawUnanswered;` unconditionally, i.e. revert to the
//        PRE-FIX behavior) -> KILLS the FIX test above (goes from ✔ to ✖: the
//        question never clears, `after.stdout` carries the block instead of
//        '').
//   (ii) Widen the family match into a no-op that treats EVERY sender as
//        "in the same family as everything" (e.g. hard-code `if (!fam)
//        return true;` branch to always fall through and short-circuit
//        the whole filter to `() => false`, i.e. everything is
//        unconditionally "answered") -> KILLS the NEGATIVE CONTROL test
//        above (goes from ✔ to ✖: an unrelated reply wrongly clears a
//        DIFFERENT family's question) — proving the fix is neither a no-op
//        nor an over-broad "always clear" shortcut.
