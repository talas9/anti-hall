'use strict';
// devswarm-parent-inbox.js — inbox grace window (SkyCrew report fix, then
// peer-bug fix 2026-09-26).
//
// FIELD REPORT (SkyCrew): a direct send to a LIVE child lane was flagged
// "need attention" in the Primary's own per-turn additionalContext as little
// as 4s after sending — before the child's own Stop-hook loop could
// realistically have cycled once, let alone drained the message. Root cause:
// the attention-push gate (devswarm-parent-inbox.js, `unread > 0` in the
// per-workspace loop) fired the instant `unread` went positive, with no age
// check at all.
//
// ORIGINAL FIX: `unreadIsGraced`/`resolveInboxGraceMs` — suppress the
// UNREAD-ONLY trigger (never `stuck`/`notDraining`, which are independent
// liveness signals) until EITHER the oldest still-unread message is older
// than the grace window (ANTIHALL_DEVSWARM_INBOX_GRACE_SEC, default 120s) OR
// the child had recorded a heartbeat AFTER the message was sent.
//
// PEER-BUG FIX (2026-09-26): the heartbeat half of that fix was itself
// broken. A field report showed the EXACT scenario the grace window exists
// to fix still reproducing verbatim: "CHILD NOT DRAINING" fired on a 9-
// second-old own mesh-direct send to a child whose heartbeat was 1s old
// (fresh — the child was actively working). Root cause: a heartbeat file is
// rewritten on every `inbox tick`/turn cycle regardless of whether the
// SPECIFIC new message was ever read — it is not evidence of mailbox
// drainage. A busy, continuously heartbeating child (precisely who this
// window protects) almost always has a heartbeat newer than a message sent
// seconds ago, disqualifying grace within the very first tick. Heartbeat is
// now DROPPED entirely and replaced with the same sender-keyed predicate the
// Stop gate uses (devswarm-parent-gate.js's `hadStoreOnlyRealRows`): age
// still decides the window, and a message whose sender is POSITIVELY known
// to be someone other than this Primary still forces the nag inside it — an
// unresolvable/legacy sender keeps the original lenient (graced) behavior,
// since this is an advisory nag, not the Stop gate's hard block.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const M = require('../../plugins/anti-hall/hooks/devswarm-parent-inbox.js');
const { makeHome } = require('../helpers/fixtures.js');
const { testHook } = require('../helpers/spawn-hook.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

// --- pure unit tests: unreadIsGraced / resolveInboxGraceMs -----------------

test('resolveInboxGraceMs: default is 120s', () => {
  assert.strictEqual(M.resolveInboxGraceMs({}), 120 * 1000);
  assert.strictEqual(M.DEFAULT_INBOX_GRACE_MS, 120 * 1000);
});

test('resolveInboxGraceMs: ANTIHALL_DEVSWARM_INBOX_GRACE_SEC overrides, 0 disables grace', () => {
  assert.strictEqual(M.resolveInboxGraceMs({ ANTIHALL_DEVSWARM_INBOX_GRACE_SEC: '300' }), 300 * 1000);
  assert.strictEqual(M.resolveInboxGraceMs({ ANTIHALL_DEVSWARM_INBOX_GRACE_SEC: '0' }), 0);
});

test('unreadIsGraced: no unread -> never graced (nothing to grace)', () => {
  assert.strictEqual(M.unreadIsGraced({ unread: 0, oldestUnreadTs: Date.now(), now: Date.now() }), false);
});

test('unreadIsGraced: unread but no oldestUnreadTs known -> fail-open to NOT graced (flags immediately)', () => {
  assert.strictEqual(M.unreadIsGraced({ unread: 1, oldestUnreadTs: null, now: Date.now() }), false);
});

test('unreadIsGraced: just sent (4s old, well inside default grace), no sender known -> GRACED', () => {
  const now = 1_000_000_000;
  const sentTs = now - 4000;
  const out = M.unreadIsGraced({ unread: 1, oldestUnreadTs: sentTs, now });
  assert.strictEqual(out, true, 'THE FIX: a 4-second-old send must not flag immediately');
});

test('unreadIsGraced: past the grace window -> no longer graced, regardless of sender', () => {
  const now = 1_000_000_000;
  const sentTs = now - (130 * 1000); // 130s > 120s default
  const out = M.unreadIsGraced({ unread: 1, oldestUnreadTs: sentTs, now, sender: 'primary-abc', ownId: 'primary-abc' });
  assert.strictEqual(out, false);
});

test('unreadIsGraced: PEER-BUG REGRESSION — fresh (9s old) own send, child heartbeat 1s old -> STILL GRACED (heartbeat is no longer consulted at all)', () => {
  // This is the exact field shape: heartbeat freshness must never disqualify
  // grace — it was never proof the SPECIFIC message was drained.
  const now = 1_000_000_000;
  const sentTs = now - 9000;
  const out = M.unreadIsGraced({
    unread: 1, oldestUnreadTs: sentTs, now, sender: 'primary-abc', ownId: 'primary-abc',
  });
  assert.strictEqual(out, true, 'a fresh own send must be graced no matter how recently the child heartbeat');
});

test('unreadIsGraced: within grace window, sender is a KNOWN THIRD PARTY (not this Primary) -> NOT graced', () => {
  const now = 1_000_000_000;
  const sentTs = now - 4000;
  const out = M.unreadIsGraced({ unread: 1, oldestUnreadTs: sentTs, now, sender: 'some-other-child', ownId: 'primary-abc' });
  assert.strictEqual(out, false, 'a message positively NOT from this Primary must never be graced, however fresh');
});

test('unreadIsGraced: within grace window, sender UNKNOWN (legacy/pre-mesh row) -> still graced (fail-open toward the existing lenient posture)', () => {
  const now = 1_000_000_000;
  const sentTs = now - 4000;
  const out = M.unreadIsGraced({ unread: 1, oldestUnreadTs: sentTs, now, sender: null, ownId: 'primary-abc' });
  assert.strictEqual(out, true);
});

test('unreadIsGraced: within grace window, ownId UNKNOWN (cannot verify) -> still graced (fail-open toward the existing lenient posture)', () => {
  const now = 1_000_000_000;
  const sentTs = now - 4000;
  const out = M.unreadIsGraced({ unread: 1, oldestUnreadTs: sentTs, now, sender: 'some-other-child', ownId: null });
  assert.strictEqual(out, true);
});

test('unreadIsGraced: ANTIHALL_DEVSWARM_INBOX_GRACE_SEC=0 (graceMs:0) -> never graced', () => {
  const now = 1_000_000_000;
  const out = M.unreadIsGraced({ unread: 1, oldestUnreadTs: now - 1, now, graceMs: 0 });
  assert.strictEqual(out, false);
});

// --- integration: the full hook, through the real attention-push gate ------

const HOOK = 'devswarm-parent-inbox.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
const REPO_CWD = process.cwd();
const REPO_HASH = installIngest.worktreeHash(REPO_CWD);
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);
const OWN_ID = 'primary-' + REPO_HASH;

function payload() { return { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: REPO_CWD }; }
function ctx(r) { return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || ''; }

function swarmDir(home) {
  const d = path.join(home, '.anti-hall', 'devswarm');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function wsEntry(overrides) {
  return Object.assign({
    worktreePath: REPO_CWD,
    sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null,
    total: 0, cursor: 0, unread: 0, directUnread: 0,
    broadcastUnread: 0, urgencyMax: null, working_on: null,
    gates: {}, archive_ready: false,
  }, overrides || {});
}
function writeSharedSummary(home, workspacesRaw) {
  const dir = path.join(swarmDir(home), 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  const workspaces = {};
  for (const id of Object.keys(workspacesRaw || {})) {
    workspaces[id] = wsEntry(workspacesRaw[id]);
  }
  const obj = { generatedAt: Date.now(), requiredGates: [], workspaces, recent: [], archivedRegistryRows: [] };
  fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), JSON.stringify(obj));
}

test('integration: a message sent 4s ago to a live child -> NO "need attention" banner (graced)', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      wsFresh: {
        total: 1, cursor: 0, unread: 1, directUnread: 1,
        oldestDirectUnreadTs: Date.now() - 4000, // just sent
      },
    });
    const r = testHook(HOOK, payload(), { env: PRIMARY_ENV, home: h.home });
    assert.strictEqual(r.status, 0);
    assert.doesNotMatch(ctx(r), /need attention/,
      'THE FIX: a 4-second-old unread must not surface as a neglect nag this turn:\n' + ctx(r));
  } finally { h.cleanup(); }
});

test('integration: the SAME message, once past the grace window, DOES surface', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      wsOld: {
        total: 1, cursor: 0, unread: 1, directUnread: 1,
        oldestDirectUnreadTs: Date.now() - (150 * 1000), // 150s > 120s default
      },
    });
    const r = testHook(HOOK, payload(), { env: PRIMARY_ENV, home: h.home });
    assert.strictEqual(r.status, 0);
    assert.match(ctx(r), /need attention/, 'a genuinely-aged unread must still surface:\n' + ctx(r));
  } finally { h.cleanup(); }
});

test('integration: PEER-BUG REGRESSION — a fresh (9s) own mesh-direct send, child heartbeat 1s old -> STILL GRACED, no "need attention" banner', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      wsHb: {
        total: 1, cursor: 0, unread: 1, directUnread: 1,
        oldestDirectUnreadTs: Date.now() - 9000,
        oldestDirectUnreadSender: OWN_ID,
      },
    });
    // A fresh heartbeat (1s old) for the busy child — must have NO bearing on
    // grace any more; the old (buggy) code disqualified grace on this alone.
    const hbDir = path.join(swarmDir(h.home), 'heartbeats');
    fs.mkdirSync(hbDir, { recursive: true });
    fs.writeFileSync(path.join(hbDir, 'wsHb.json'), JSON.stringify({ ts: Date.now() - 1000 }));

    const r = testHook(HOOK, payload(), { env: PRIMARY_ENV, home: h.home });
    assert.strictEqual(r.status, 0);
    assert.doesNotMatch(ctx(r), /need attention/,
      'THE PEER-BUG FIX: a fresh own send must stay graced regardless of how fresh the child heartbeat is:\n' + ctx(r));
  } finally { h.cleanup(); }
});

test('integration: a fresh message from a KNOWN THIRD-PARTY sender (not this Primary) -> surfaces immediately, grace does not apply', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      wsThirdParty: {
        total: 1, cursor: 0, unread: 1, directUnread: 1,
        oldestDirectUnreadTs: Date.now() - 4000,
        oldestDirectUnreadSender: 'some-other-child',
      },
    });
    const r = testHook(HOOK, payload(), { env: PRIMARY_ENV, home: h.home });
    assert.strictEqual(r.status, 0);
    assert.match(ctx(r), /need attention/,
      'a message positively NOT from this Primary must not be graced just because it is fresh:\n' + ctx(r));
  } finally { h.cleanup(); }
});

test('integration: ANTIHALL_DEVSWARM_INBOX_GRACE_SEC=0 -> flags immediately, no grace at all', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      wsNoGrace: {
        total: 1, cursor: 0, unread: 1, directUnread: 1,
        oldestDirectUnreadTs: Date.now() - 1000,
      },
    });
    const r = testHook(HOOK, payload(), { env: Object.assign({}, PRIMARY_ENV, { ANTIHALL_DEVSWARM_INBOX_GRACE_SEC: '0' }), home: h.home });
    assert.strictEqual(r.status, 0);
    assert.match(ctx(r), /need attention/, ctx(r));
  } finally { h.cleanup(); }
});
