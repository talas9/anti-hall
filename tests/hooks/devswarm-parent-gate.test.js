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
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');

const HOOK = 'devswarm-parent-gate.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' }; // active + Primary (no SOURCE_BRANCH)

// REPO_CWD/REPO_HASH/OWN_ID — the SAME per-worktree Primary-id convention
// devswarm-parent-inbox.test.js's STALE section already uses: passing this test
// process's own cwd (a real git checkout) lets the hook's pure-fs worktree
// resolution land on this exact hash, so a summary written under it is found.
const REPO_CWD = process.cwd();
const REPO_HASH = installIngest.worktreeHash(REPO_CWD);
const OWN_ID = 'primary-' + REPO_HASH;

function stopPayload(sessionId, withCwd) {
  const p = { hook_event_name: 'Stop', session_id: sessionId || 'sess-1' };
  if (withCwd) p.cwd = REPO_CWD;
  return p;
}

// writeOwnSummary(home, unread) — the Primary's OWN unread, written to the SAME
// per-project summary projection path the hook reads (summaries/<hash>.json ->
// workspaces[primary-<hash>].unread).
function writeOwnSummary(home, unread) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, REPO_HASH + '.json'), JSON.stringify({ workspaces: { [OWN_ID]: { unread } } }));
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
    worktreePath: path.join(home, 'wt', id),
    sessionId: 'child-' + id,
    inboxPath,
    cursorPath,
  };
  if (opts.repoId !== undefined) descriptor.repoId = opts.repoId;
  fs.writeFileSync(path.join(wsDir, id + '.json'), JSON.stringify(descriptor));

  if (opts.messages != null) {
    fs.writeFileSync(inboxPath, opts.messages.map((m) => JSON.stringify({ m })).join('\n') + '\n');
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
    fs.writeFileSync(path.join(dir, REPO_HASH + '.json'), '{not json');
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

// ---- #36 cross-project-bleed fix: repoId-scoped descriptor enumeration ----
// PRIMARY_ENV carries DEVSWARM_REPO_ID: 'repo-1'. The predicate is exactly
// "exclude only when BOTH the session's and the descriptor's repoId are present
// and differ" — fail-open by construction.

test('#36 EXCLUDE: a descriptor with a DIFFERENT repoId than the session is not gated on', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'other-project', { messages: ['a', 'b'], cursor: 0, repoId: 'repo-2' });
    const r = run(h.home); // PRIMARY_ENV: repo-1
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', 'a foreign-project descriptor must never block this session');
  } finally { h.cleanup(); }
});

test('#36 INCLUDE (back-compat): a descriptor with NO repoId still gates', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'legacy-desc', { messages: ['a', 'b'], cursor: 0 }); // no repoId field at all
    const r = run(h.home); // PRIMARY_ENV: repo-1
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block', 'pre-#36 descriptors must not vanish from the gate');
    assert.match(r.json.reason, /legacy-desc/);
  } finally { h.cleanup(); }
});

test('#36 INCLUDE (fail-open): session has NO DEVSWARM_REPO_ID -> filter disabled, all descriptors gate', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'foreign', { messages: ['a', 'b'], cursor: 0, repoId: 'repo-2' });
    // Manual-supervisor-mode session: active via ANTIHALL_DEVSWARM_SUPERVISOR=on,
    // no DEVSWARM_REPO_ID at all (not even PRIMARY_ENV's) -> currentRepoId falsy.
    const r = testHookRaw(HOOK, JSON.stringify(stopPayload()), {
      home: h.home,
      env: { ANTIHALL_DEVSWARM_SUPERVISOR: 'on' },
    });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json && r.json.decision, 'block', 'no session repoId must show every descriptor (same as today)');
    assert.match(r.json.reason, /foreign/);
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
