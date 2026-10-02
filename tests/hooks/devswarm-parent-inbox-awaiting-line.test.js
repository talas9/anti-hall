'use strict';
// devswarm-parent-inbox: the "QUESTIONS AWAITING YOUR REPLY" lead line of the
// Primary's OWN INBOX segment (count, age of the oldest unanswered question,
// workspace title, scrubbed 80-char preview). Built from the same unanswered
// data the segment already nags on; absent when nothing is unanswered.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const replyStateLib = require('../../plugins/anti-hall/companion/lib/devswarm-reply-state.js');
const names = require('../../plugins/anti-hall/companion/lib/devswarm-names.js');

const HOOK = 'devswarm-parent-inbox.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
const REPO_CWD = process.cwd();
const REPO_HASH = installIngest.worktreeHash(REPO_CWD);
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);
const OWN_ID = 'primary-' + REPO_HASH;
const LINE_RE = /^QUESTIONS AWAITING YOUR REPLY: .*$/m;

function swarmDir(home) {
  const d = path.join(home, '.anti-hall', 'devswarm');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function writeSummary(home, own, others) {
  const dir = path.join(swarmDir(home), 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  const base = {
    worktreePath: REPO_CWD, sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null,
    total: 0, cursor: 0, unread: 0, directUnread: 0, broadcastUnread: 0, urgencyMax: null,
    working_on: null, gates: {}, archive_ready: false,
  };
  const workspaces = { [OWN_ID]: Object.assign({}, base, own) };
  for (const id of others) workspaces[id] = Object.assign({}, base, { worktreePath: '/wt/' + id });
  fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), JSON.stringify({
    generatedAt: Date.now(), requiredGates: [], workspaces, recent: [], archivedRegistryRows: [],
  }));
}
function run(home) {
  const r = testHook(HOOK, { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: REPO_CWD },
    { home, env: PRIMARY_ENV, expectJson: true });
  assert.strictEqual(r.status, 0);
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}
const lineOf = (c) => { const m = LINE_RE.exec(c); return m ? m[0] : ''; };

test('one unanswered question: count 1, age, workspace title and preview', () => {
  const h = makeHome();
  try {
    names.writeName(h.home, 'child-a', 'Billing refactor');
    writeSummary(h.home, {
      total: 1, cursor: 0, unread: 1, directUnread: 1,
      pendingQuestions: [{ from: 'child-a', ts: Date.now() - 5 * 60000, seq: 1 }],
      pendingQuestionPreviews: { 1: 'Should the invoice table keep the legacy currency column?' },
    }, ['child-a']);
    const c = run(h.home);
    assert.match(lineOf(c), /^QUESTIONS AWAITING YOUR REPLY: 1 \(oldest 5m\) — Billing refactor: Should the invoice table keep the legacy currency column\?$/, c);
    assert.ok(c.indexOf('QUESTIONS AWAITING') < c.indexOf('DEVSWARM OWN INBOX'), 'the line leads the segment');
    assert.match(c, /DEVSWARM OWN INBOX — PRIORITY/, 'rest of the segment kept');
  } finally { h.cleanup(); }
});

test('several unanswered questions: count is right and the OLDEST is the one shown', () => {
  const h = makeHome();
  try {
    names.writeName(h.home, 'child-a', 'Newer ws');
    names.writeName(h.home, 'child-b', 'Older ws');
    writeSummary(h.home, {
      total: 2, cursor: 0, unread: 2, directUnread: 2,
      pendingQuestions: [
        { from: 'child-a', ts: Date.now() - 2 * 60000, seq: 1 },
        { from: 'child-b', ts: Date.now() - 90 * 60000, seq: 2 },
      ],
      pendingQuestionPreviews: { 1: 'newer question', 2: 'older question' },
    }, ['child-a', 'child-b']);
    const l = lineOf(run(h.home));
    assert.match(l, /: 2 \(oldest 90m\) — Older ws: older question$/, l);
  } finally { h.cleanup(); }
});

test('an answered question is excluded from the line', () => {
  const h = makeHome();
  try {
    names.writeName(h.home, 'child-a', 'Answered ws');
    names.writeName(h.home, 'child-b', 'Open ws');
    const now = Date.now();
    writeSummary(h.home, {
      total: 2, cursor: 0, unread: 2, directUnread: 2,
      pendingQuestions: [
        { from: 'child-a', ts: now - 60 * 60000, seq: 1 },
        { from: 'child-b', ts: now - 10 * 60000, seq: 2 },
      ],
      pendingQuestionPreviews: { 1: 'already answered', 2: 'still open' },
    }, ['child-a', 'child-b']);
    replyStateLib.recordReply(REPO_KEY, h.home, 'child-a', now - 30 * 60000);
    const l = lineOf(run(h.home));
    assert.match(l, /: 1 \(oldest 10m\) — Open ws: still open$/, l);
    assert.ok(!/already answered|Answered ws/.test(l), l);
  } finally { h.cleanup(); }
});

test('a question that was read (unread 0) but is unanswered is still listed', () => {
  const h = makeHome();
  try {
    names.writeName(h.home, 'child-a', 'Read ws');
    writeSummary(h.home, {
      total: 1, cursor: 1, unread: 0, directUnread: 0,
      pendingQuestions: [{ from: 'child-a', ts: Date.now() - 7 * 60000, seq: 1 }],
      pendingQuestionPreviews: { 1: 'read but not replied' },
    }, ['child-a']);
    assert.match(lineOf(run(h.home)), /: 1 \(oldest 7m\) — Read ws: read but not replied$/);
  } finally { h.cleanup(); }
});

test('no questions: the line is absent', () => {
  const h = makeHome();
  try {
    writeSummary(h.home, { total: 1, cursor: 0, unread: 1, directUnread: 1, pendingQuestions: [] }, []);
    const c = run(h.home);
    assert.ok(!/QUESTIONS AWAITING/.test(c), c);
    assert.match(c, /DEVSWARM OWN INBOX/, 'plain unread segment still shows');
  } finally { h.cleanup(); }
});

test('preview: token-shaped text is redacted, newlines/control chars stripped, capped at 80 chars', () => {
  const h = makeHome();
  try {
    names.writeName(h.home, 'child-a', 'Secrets ws');
    const token = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0';
    writeSummary(h.home, {
      total: 1, cursor: 0, unread: 1, directUnread: 1,
      pendingQuestions: [{ from: 'child-a', ts: Date.now() - 60000, seq: 1 }],
      pendingQuestionPreviews: { 1: 'use key ' + token + '\nor\u0007 the other one?\r\n' + 'x'.repeat(200) },
    }, ['child-a']);
    const c = run(h.home);
    const l = lineOf(c);
    assert.ok(!c.includes(token), 'token must not reach the injection');
    assert.match(l, /\[REDACTED_KEY\]/, l);
    assert.ok(!/[\u0000-\u001f]/.test(l), 'single line, no control chars');
    const preview = l.split(': ').slice(2).join(': ');
    assert.ok(preview.length <= 80, 'preview capped at 80, got ' + preview.length);
  } finally { h.cleanup(); }
});

test('no cached title -> short id; no preview in the summary -> line without one', () => {
  const h = makeHome();
  try {
    writeSummary(h.home, {
      total: 1, cursor: 0, unread: 1, directUnread: 1,
      pendingQuestions: [{ from: 'child-a', ts: Date.now() - 3 * 60000, seq: 1 }],
    }, ['child-a']);
    const l = lineOf(run(h.home));
    assert.strictEqual(l, 'QUESTIONS AWAITING YOUR REPLY: 1 (oldest 3m) — ' + names.shortId('child-a'));
  } finally { h.cleanup(); }
});

test('store: pendingQuestionPreviews is a sibling projection and pendingQuestions keeps its shape (both backends)', () => {
  const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
  const inst = installIngest;
  const backends = ['journal'];
  if (store.sqliteAvailable()) backends.push('sqlite');
  for (const backend of backends) {
    const h = makeHome();
    try {
      const s = store.openStore({ home: h.home, backend });
      try {
        s.upsertRegistry({ id: 'w', worktreePath: '/wt/w', sessionId: null, inboxPath: '/i/w', cursorPath: '/c/w', nudgeCommand: null });
        const wt = '/wt/sender';
        s.upsertRegistry({ id: 'A', worktreePath: wt, sessionId: null, inboxPath: '/i/A', cursorPath: '/c/A', nudgeCommand: null });
        const f = { from: inst.primaryWorkspaceId(wt), to: 'w', type: 'direct', message: 'may I drop the column? ' + 'z'.repeat(300), timestamp: 100, urgency: 'normal', needsReply: true };
        store.appendMeshMessage(s, Object.assign({}, f, { hash: store.meshMessageHash(f) }));
        const e = store.computeSummary(s, { home: h.home }).workspaces.w;
        assert.strictEqual(e.pendingQuestions.length, 1, backend);
        assert.ok(!('preview' in e.pendingQuestions[0]), 'pendingQuestions entries carry no new field');
        const p = e.pendingQuestionPreviews[e.pendingQuestions[0].seq];
        assert.ok(typeof p === 'string' && p.startsWith('may I drop the column?') && p.length === 120, backend + ': ' + p);
      } finally { s.close(); }
    } finally { h.cleanup(); }
  }
});
