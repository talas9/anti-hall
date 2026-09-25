'use strict';
// devswarm-parent-inbox.js — ARCHIVE-READY-QUIET + the ignore list.
//
// DEFECT (field report, v0.106.0): an archive-ready workspace from a PREVIOUS
// session, whose only unread is the Primary's own archive-request send (see
// companion/lib/devswarm-store.js computeSummary's archive_request_only_unread),
// nagged in the LOUD "DEVSWARM URGENT INBOX" segment every single turn even
// though the child it addresses can never read/drain it — nobody is left to.
//
// FIX (a): such a row is excluded from the urgent/attention nag entirely (it
// still gets the existing, cooldown'd DEVSWARM ARCHIVE-READY nudge, and still
// shows in the live table, just not as `not-draining`).
// FIX (b): a user-editable ~/.anti-hall/devswarm/ignore.json {"ids":[...]}
// list (companion/lib/devswarm-ignore.js) additionally suppresses the same
// nag for any explicitly-listed id, while keeping it in the roster table.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const { sessionsDirFor } = require('../../plugins/anti-hall/companion/lib/liveness.js');
const { ignoreFilePath } = require('../../plugins/anti-hall/companion/lib/devswarm-ignore.js');

const HOOK = 'devswarm-parent-inbox.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };

const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);

function payload() { return { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi' }; }
function withCwd(payloadFn) { return { ...payloadFn(), cwd: REPO_CWD }; }
function ctx(r) { return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || ''; }
function segment(c, banner) { return c.split('\n\n').find((s) => s.startsWith(banner)) || ''; }
function tableSeg(c) { return segment(c, 'DEVSWARM WORKSPACES'); }
function tableRow(c, id) { return tableSeg(c).split('\n').find((l) => l.startsWith('| ' + id + ' ')) || ''; }

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
    workspaces[id] = raw === undefined ? undefined : (raw && typeof raw === 'object' ? wsEntry(raw) : raw);
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
// writeLiveSession(home, sessionId) — a real .claude/sessions/<n>.json record
// pointing at THIS TEST PROCESS's own pid (definitely alive), so
// isSessionAliveRow proves the row's session is genuinely running.
function writeLiveSession(home, sessionId) {
  const dir = sessionsDirFor(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ sessionId, pid: process.pid }));
}

test('ARCHIVE-READY-QUIET: archive-ready + unread is ONLY the archive-request + no live session -> no urgent nag, table still shows archive-ready', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      wsDone: {
        total: 5, cursor: 4, unread: 1, directUnread: 1, urgencyMax: 'high',
        archive_ready: true, archive_requested: true, archive_request_only_unread: true,
        sessionId: 'long-gone-session',
      },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    assert.strictEqual(segment(c, 'DEVSWARM URGENT INBOX'), '', `no urgent nag expected; ctx=${c}`);
    assert.strictEqual(segment(c, 'DEVSWARM PARENT INBOX'), '', `no standard nag expected either; ctx=${c}`);
    const row = tableRow(c, 'wsDone');
    assert.ok(row, `wsDone must still have a table row; ctx=${c}`);
    assert.ok(/archive-ready/.test(row), `table row must show archive-ready, not not-draining; row=${row}`);
    assert.ok(!/not-draining/.test(row), `table row must NOT show not-draining; row=${row}`);
    assert.ok(segment(c, 'DEVSWARM ARCHIVE-READY').includes('wsDone'),
      `the existing cooldown'd archive-ready nudge must still fire; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('ARCHIVE-READY-QUIET REGRESSION GUARD: a REAL (non-self-sent) unread alongside archive_ready still nags urgently', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      wsReal: {
        total: 2, cursor: 0, unread: 2, directUnread: 2, urgencyMax: 'high',
        archive_ready: true, archive_requested: true, archive_request_only_unread: false, // a real row mixed in
        sessionId: 'long-gone-session',
      },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(segment(c, 'DEVSWARM URGENT INBOX').includes('wsReal'),
      `a genuinely mixed unread backlog must still nag urgently; ctx=${c}`);
  } finally { h.cleanup(); }
});

// SUPERSEDED by ARCHIVE-REQUEST-PENDING (SkyCrew field report 399105fe/
// e75cade3): a LIVE session whose ENTIRE unread backlog is the Primary's own
// pending archive-request is no longer treated as "someone may yet drain it"
// — the CHILD NOT DRAINING / URGENT INBOX nag was re-instructing the Primary
// to poke/re-send the SAME archive-request it had already sent, every turn,
// while the child was simply waiting on its own user to decide. See
// devswarm-parent-inbox-archive-request-pending.test.js for the full suite
// covering this suppression (pending/quiet, resumed-on-other-unread,
// resumed-on-drained, and the 24h archiveRequestRenagHours re-nag).
test('ARCHIVE-REQUEST-PENDING: a LIVE session whose only unread is a pending archive-request no longer nags urgently', () => {
  const h = makeHome();
  try {
    writeLiveSession(h.home, 'still-running-session');
    writeSharedSummary(h.home, {
      wsLive: {
        total: 1, cursor: 0, unread: 1, directUnread: 1, urgencyMax: 'high',
        archive_ready: true, archive_requested: true, archive_request_only_unread: true,
        sessionId: 'still-running-session',
      },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(!segment(c, 'DEVSWARM URGENT INBOX').includes('wsLive'),
      `a pending archive-request must suppress the re-instruct-to-poke nag even while the session is live; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('IGNORE LIST: a listed id never nags urgently, but stays visible in the roster table', () => {
  const h = makeHome();
  try {
    const p = ignoreFilePath(h.home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ids: ['wsIgnored'] }));
    writeSharedSummary(h.home, {
      wsIgnored: { total: 1, cursor: 0, unread: 1, directUnread: 1, urgencyMax: 'urgent' },
      wsOther: { total: 1, cursor: 0, unread: 1, directUnread: 1, urgencyMax: 'urgent' },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    const urgentSeg = segment(c, 'DEVSWARM URGENT INBOX');
    assert.ok(!urgentSeg.includes('wsIgnored'), `ignored id must never appear in the urgent segment; seg=${urgentSeg}`);
    assert.ok(urgentSeg.includes('wsOther'), `a non-ignored urgent workspace must still nag; seg=${urgentSeg}`);
    assert.ok(tableRow(c, 'wsIgnored'), `ignored id must STILL have a roster table row; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('IGNORE LIST: absent/empty ignore.json changes nothing (fail-open, back-compat)', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      wsA: { total: 1, cursor: 0, unread: 1, directUnread: 1, urgencyMax: 'urgent' },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(segment(c, 'DEVSWARM URGENT INBOX').includes('wsA'), `no ignore file -> normal urgent nag; ctx=${c}`);
  } finally { h.cleanup(); }
});
