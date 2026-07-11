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

const HOOK = 'devswarm-parent-gate.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' }; // active + Primary (no SOURCE_BRANCH)

function stopPayload(sessionId) {
  return { hook_event_name: 'Stop', session_id: sessionId || 'sess-1' };
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
