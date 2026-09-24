'use strict';
// devswarm-parent-inbox.js — inbox grace window (SkyCrew report fix).
//
// FIELD REPORT: a direct send to a LIVE child lane was flagged "need
// attention" in the Primary's own per-turn additionalContext as little as 4s
// after sending — before the child's own Stop-hook loop could realistically
// have cycled once, let alone drained the message. Root cause: the
// attention-push gate (devswarm-parent-inbox.js, `unread > 0` in the
// per-workspace loop) fired the instant `unread` went positive, with no age
// check at all.
//
// FIX: `unreadIsGraced`/`resolveInboxGraceMs` — suppress the UNREAD-ONLY
// trigger (never `stuck`/`notDraining`, which are independent liveness
// signals) until EITHER the oldest still-unread message is older than the
// grace window (ANTIHALL_DEVSWARM_INBOX_GRACE_SEC, default 120s) OR the
// child has recorded a heartbeat AFTER the message was sent.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const M = require('../../plugins/anti-hall/hooks/devswarm-parent-inbox.js');
const { makeHome } = require('../helpers/fixtures.js');
const { heartbeatPathFor } = require('../../plugins/anti-hall/companion/lib/liveness.js');
const { testHook } = require('../helpers/spawn-hook.js');
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

test('unreadIsGraced: just sent (4s old, well inside default grace), no heartbeat since -> GRACED', () => {
  const now = 1_000_000_000;
  const sentTs = now - 4000;
  const out = M.unreadIsGraced({
    unread: 1, oldestUnreadTs: sentTs, now, id: 'child-1',
    heartbeatTsFn: () => null, // no heartbeat recorded at all
  });
  assert.strictEqual(out, true, 'THE FIX: a 4-second-old send must not flag immediately');
});

test('unreadIsGraced: past the grace window -> no longer graced, regardless of heartbeat', () => {
  const now = 1_000_000_000;
  const sentTs = now - (130 * 1000); // 130s > 120s default
  const out = M.unreadIsGraced({
    unread: 1, oldestUnreadTs: sentTs, now, id: 'child-1',
    heartbeatTsFn: () => null,
  });
  assert.strictEqual(out, false);
});

test('unreadIsGraced: within grace window BUT a heartbeat landed AFTER the send -> no longer graced', () => {
  const now = 1_000_000_000;
  const sentTs = now - 4000;
  const heartbeatAfterSend = sentTs + 1000; // heartbeat 1s after the send
  const out = M.unreadIsGraced({
    unread: 1, oldestUnreadTs: sentTs, now, id: 'child-1',
    heartbeatTsFn: () => heartbeatAfterSend,
  });
  assert.strictEqual(out, false, 'a heartbeat after the send proves the child\'s loop already had a chance to notice it');
});

test('unreadIsGraced: within grace window, heartbeat exists but is BEFORE the send -> still graced', () => {
  const now = 1_000_000_000;
  const sentTs = now - 4000;
  const heartbeatBeforeSend = sentTs - 60_000; // stale heartbeat, predates the send
  const out = M.unreadIsGraced({
    unread: 1, oldestUnreadTs: sentTs, now, id: 'child-1',
    heartbeatTsFn: () => heartbeatBeforeSend,
  });
  assert.strictEqual(out, true, 'a heartbeat that predates the send proves nothing about this message');
});

test('unreadIsGraced: ANTIHALL_DEVSWARM_INBOX_GRACE_SEC=0 (graceMs:0) -> never graced', () => {
  const now = 1_000_000_000;
  const out = M.unreadIsGraced({ unread: 1, oldestUnreadTs: now - 1, now, graceMs: 0, heartbeatTsFn: () => null });
  assert.strictEqual(out, false);
});

test('unreadIsGraced: a heartbeat lookup that throws fails open to NOT graced', () => {
  const now = 1_000_000_000;
  const out = M.unreadIsGraced({
    unread: 1, oldestUnreadTs: now - 4000, now,
    heartbeatTsFn: () => { throw new Error('boom'); },
  });
  assert.strictEqual(out, false, 'a heartbeat read failure must never hide a real neglect signal');
});

// --- integration: the full hook, through the real attention-push gate ------

const HOOK = 'devswarm-parent-inbox.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);

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

test('integration: a message sent 4s ago, but the child already heartbeat AFTER the send -> surfaces immediately (grace waived)', () => {
  const h = makeHome();
  try {
    const sentTs = Date.now() - 4000;
    writeSharedSummary(h.home, {
      wsHb: {
        total: 1, cursor: 0, unread: 1, directUnread: 1,
        oldestDirectUnreadTs: sentTs,
      },
    });
    const hbPath = heartbeatPathFor('wsHb', h.home);
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ ts: sentTs + 1000 }));

    const r = testHook(HOOK, payload(), { env: PRIMARY_ENV, home: h.home });
    assert.strictEqual(r.status, 0);
    assert.match(ctx(r), /need attention/,
      'a heartbeat after the send proves the child already had a chance to act — grace no longer applies:\n' + ctx(r));
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
