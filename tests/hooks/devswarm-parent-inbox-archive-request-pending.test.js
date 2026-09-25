'use strict';
// devswarm-parent-inbox.js — ARCHIVE-REQUEST-PENDING suppression.
//
// FIELD REPORT (SkyCrew, 399105fe/e75cade3): once the Primary had already run
// `archive-request <id>` against a child, BOTH the "CHILD NOT DRAINING" per-
// turn nag AND the (separately cooldown'd) "DEVSWARM ARCHIVE-READY" reminder
// kept re-instructing it to poke/re-send the identical request — even hours
// later, even while the child's session was still nominally live — because
// neither one had any notion of "a request for this exact workspace is
// already outstanding". The child was not neglected; it was simply waiting
// on its own user to act on the request it had already received.
//
// FIX: computeSummary's `archive_request_only_unread` (companion/lib/
// devswarm-store.js — true when EVERY currently-unread row for a workspace is
// the Primary's own archive-request marker send) is the SAME detector the
// pre-existing ARCHIVE-READY-QUIET fix already uses for the dead-session
// shape (see devswarm-parent-inbox-archive-ready-quiet.test.js). This suite
// covers the NEW, broader `archiveRequestQuiet` derived from it:
//   - suppresses the CHILD NOT DRAINING / notDraining nag entirely (live or
//     dead session — the dead-session case was already covered separately)
//   - suppresses the ARCHIVE-READY re-nudge ONLY for a still-live session
//     (the dead-session case keeps nudging: cmdArchiveRequest auto-archives
//     a dead+archive-ready target the next time the Primary runs it)
//   - resumes the moment the request is answered/drained (unread -> 0) or
//     the child resumes other work (a non-archive-request row arrives)
//   - resumes unconditionally after `devswarm.archiveRequestRenagHours`
//     (default 24h) even while still nominally "pending", so a genuinely
//     abandoned request is not silenced forever

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const { sessionsDirFor } = require('../../plugins/anti-hall/companion/lib/liveness.js');

const HOOK = 'devswarm-parent-inbox.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };

const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);

function payload() { return { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi' }; }
function withCwd(payloadFn) { return { ...payloadFn(), cwd: REPO_CWD }; }
function ctx(r) { return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || ''; }
function segment(c, banner) { return c.split('\n\n').find((s) => s.startsWith(banner)) || ''; }

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
function writeSharedSummary(home, workspacesRaw, extra) {
  const dir = path.join(swarmDir(home), 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  const workspaces = {};
  for (const id of Object.keys(workspacesRaw || {})) {
    const raw = workspacesRaw[id];
    workspaces[id] = raw && typeof raw === 'object' ? wsEntry(raw) : raw;
  }
  const obj = {
    generatedAt: (extra && extra.generatedAt) != null ? extra.generatedAt : Date.now(),
    requiredGates: (extra && extra.requiredGates) || [],
    workspaces,
    recent: (extra && extra.recent) || [],
    archivedRegistryRows: (extra && extra.archivedRegistryRows) || [],
  };
  fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), JSON.stringify(obj));
}
function writeVerdict(home, id, verdict) {
  const p = path.join(swarmDir(home), 'liveness', id + '.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(verdict));
}
function writeLiveSession(home, sessionId) {
  const dir = sessionsDirFor(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ sessionId, pid: process.pid }));
}

test('PENDING: not-draining verdict + pending archive-request (live session) -> CHILD NOT DRAINING nag suppressed', () => {
  const h = makeHome();
  try {
    writeLiveSession(h.home, 'sess-pending');
    writeVerdict(h.home, 'wsPending', { notDraining: true });
    writeSharedSummary(h.home, {
      wsPending: {
        total: 1, cursor: 0, unread: 1, directUnread: 1, urgencyMax: 'high',
        archive_ready: true, archive_requested: true, archive_request_only_unread: true,
        oldestDirectUnreadTs: Date.now() - 60 * 60 * 1000, // 1h ago (< 24h default renag)
        sessionId: 'sess-pending',
      },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.strictEqual(segment(c, 'DEVSWARM URGENT INBOX'), '', `no urgent nag while pending; ctx=${c}`);
    assert.strictEqual(segment(c, 'DEVSWARM PARENT INBOX'), '', `no standard nag while pending; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('PENDING: ARCHIVE-READY re-nudge suppressed for a LIVE session with a pending archive-request', () => {
  const h = makeHome();
  try {
    writeLiveSession(h.home, 'sess-pending2');
    writeSharedSummary(h.home, {
      wsPending2: {
        total: 1, cursor: 0, unread: 1, directUnread: 1, urgencyMax: 'high',
        archive_ready: true, archive_requested: true, archive_request_only_unread: true,
        oldestDirectUnreadTs: Date.now() - 60 * 60 * 1000, // 1h ago
        sessionId: 'sess-pending2',
      },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.strictEqual(segment(c, 'DEVSWARM ARCHIVE-READY'), '',
      `the archive-ready nudge must not re-instruct sending an already-pending request; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('DEAD SESSION EXEMPT: ARCHIVE-READY re-nudge still fires when the session is dead (cmdArchiveRequest auto-archives it)', () => {
  const h = makeHome();
  try {
    // No live-session file written -> isSessionAliveRow reads false.
    writeSharedSummary(h.home, {
      wsDeadPending: {
        total: 1, cursor: 0, unread: 1, directUnread: 1, urgencyMax: 'high',
        archive_ready: true, archive_requested: true, archive_request_only_unread: true,
        oldestDirectUnreadTs: Date.now() - 60 * 60 * 1000,
        sessionId: 'long-gone-session',
      },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(segment(c, 'DEVSWARM ARCHIVE-READY').includes('wsDeadPending'),
      `a dead session's archive-ready nudge must keep firing (it directly archives next run); ctx=${c}`);
  } finally { h.cleanup(); }
});

test('RESUMED WORK: a real (non-archive-request) unread row alongside the pending request resumes the nag', () => {
  const h = makeHome();
  try {
    writeLiveSession(h.home, 'sess-resumed');
    writeSharedSummary(h.home, {
      wsResumed: {
        total: 2, cursor: 0, unread: 2, directUnread: 2, urgencyMax: 'high',
        archive_ready: true, archive_requested: true, archive_request_only_unread: false, // mixed
        oldestDirectUnreadTs: Date.now() - 60 * 60 * 1000,
        sessionId: 'sess-resumed',
      },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(segment(c, 'DEVSWARM URGENT INBOX').includes('wsResumed'),
      `a real unread row mixed in must resume the nag; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('RESOLVED: no unread at all (request drained) -> no nag, not archive_request_only_unread', () => {
  const h = makeHome();
  try {
    writeLiveSession(h.home, 'sess-drained');
    writeSharedSummary(h.home, {
      wsDrained: {
        total: 1, cursor: 1, unread: 0, directUnread: 0, urgencyMax: null,
        archive_ready: true, archive_requested: false, archive_request_only_unread: false,
        sessionId: 'sess-drained',
      },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.strictEqual(segment(c, 'DEVSWARM URGENT INBOX'), '', `nothing unread -> no nag; ctx=${c}`);
    assert.ok(segment(c, 'DEVSWARM ARCHIVE-READY').includes('wsDrained'),
      `once resolved, the archive-ready nudge resumes normally; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('STALE: a pending archive-request older than devswarm.archiveRequestRenagHours re-nags', () => {
  const h = makeHome();
  try {
    writeLiveSession(h.home, 'sess-stale');
    writeSharedSummary(h.home, {
      wsStalePending: {
        total: 1, cursor: 0, unread: 1, directUnread: 1, urgencyMax: 'high',
        archive_ready: true, archive_requested: true, archive_request_only_unread: true,
        oldestDirectUnreadTs: Date.now() - 25 * 60 * 60 * 1000, // 25h ago, > 24h default
        sessionId: 'sess-stale',
      },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(segment(c, 'DEVSWARM URGENT INBOX').includes('wsStalePending'),
      `a request pending for over the default 24h re-nag window must resume nagging; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('STALE: devswarm.archiveRequestRenagHours is configurable via ANTIHALL_DEVSWARM_ARCHIVE_REQUEST_RENAG_HOURS', () => {
  const h = makeHome();
  try {
    writeLiveSession(h.home, 'sess-cfg');
    writeSharedSummary(h.home, {
      wsCfgPending: {
        total: 1, cursor: 0, unread: 1, directUnread: 1, urgencyMax: 'high',
        archive_ready: true, archive_requested: true, archive_request_only_unread: true,
        oldestDirectUnreadTs: Date.now() - 2 * 60 * 60 * 1000, // 2h ago
        sessionId: 'sess-cfg',
      },
    });
    // With a 1h renag window, a 2h-old pending request is already stale.
    const r = testHook(HOOK, withCwd(payload), {
      home: h.home, env: Object.assign({}, PRIMARY_ENV, { ANTIHALL_DEVSWARM_ARCHIVE_REQUEST_RENAG_HOURS: '1' }),
      expectJson: true,
    });
    const c = ctx(r);
    assert.ok(segment(c, 'DEVSWARM URGENT INBOX').includes('wsCfgPending'),
      `a shortened renag window must resume nagging sooner; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('STUCK STATUS UNAFFECTED: a genuinely escalated child still nags even with a pending archive-request', () => {
  const h = makeHome();
  try {
    writeLiveSession(h.home, 'sess-stuck');
    writeSharedSummary(h.home, {
      wsStuck: {
        total: 1, cursor: 0, unread: 1, directUnread: 1, urgencyMax: 'high', status: 'escalated',
        archive_ready: true, archive_requested: true, archive_request_only_unread: true,
        oldestDirectUnreadTs: Date.now() - 60 * 60 * 1000,
        sessionId: 'sess-stuck',
      },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(segment(c, 'DEVSWARM PARENT INBOX').includes('wsStuck') || segment(c, 'DEVSWARM URGENT INBOX').includes('wsStuck'),
      `a genuinely escalated/stuck status is a different signal and must still nag; ctx=${c}`);
  } finally { h.cleanup(); }
});
