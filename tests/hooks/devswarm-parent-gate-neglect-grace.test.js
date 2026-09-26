'use strict';
// devswarm-parent-gate.js — NEGLECT GRACE WINDOW (field report, OLD 0.109.1
// hooks): a Primary that sends a child a message and ends its turn SECONDS
// later got hard-blocked with "DEVSWARM NEGLECT" before the child had any
// chance to drain its inbox. The pre-existing BUSY downgrade
// (parentGateBusyFreshMin/parentGateBusyMaxAgeMin) does not cover this case
// — busy requires a FRESH REAL-WORK transcript from the child, and a child
// that just received mail has not necessarily produced one yet.
//
// Fix: a NEW, independent axis — parentGateNeglectGraceMin (default 5) — any
// plain unread backlog (no unreadUnknown, no corroborated staleOrEscalated,
// no familyWaitingOnUser) whose oldest unread is younger than this many
// minutes is downgraded to a stderr advisory, exactly like the busy
// downgrade, regardless of whether the child is independently busy. Must NOT
// suppress: an unanswered CHILD QUESTION (a wholly separate `unanswered`
// axis handled earlier in main()), a corroborated stale/escalated verdict,
// or unread mail older than the grace window.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

const HOOK = 'devswarm-parent-gate.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
const REPO_CWD = process.cwd();
const REPO_HASH = installIngest.worktreeHash(REPO_CWD);
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);
const OWN_ID = 'primary-' + REPO_HASH;

function run(home, payload, env) {
  return testHookRaw(HOOK, JSON.stringify(payload || { hook_event_name: 'Stop', session_id: 'sess-1' }), {
    home,
    env: { ...PRIMARY_ENV, ...(env || {}) },
  });
}

function stopPayload(sessionId) {
  return { hook_event_name: 'Stop', session_id: sessionId || 'sess-1', cwd: REPO_CWD };
}

// seedWorkspace: a child descriptor with an inbox of `n` unread rows, each
// timestamped `ageMin` minutes ago (createdAt), never yet read (cursor 0).
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
  fs.writeFileSync(path.join(wsDir, id + '.json'), JSON.stringify(descriptor));
  const ageMin = opts.ageMin == null ? 0.05 : opts.ageMin; // default: a few seconds old
  const n = opts.unread == null ? 1 : opts.unread;
  const rows = Array.from({ length: n }, (_, i) => ({
    m: '[Primary] fyi ' + i,
    createdAt: Date.now() - ageMin * 60000 + i,
  }));
  fs.writeFileSync(inboxPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(cursorPath, '0');
  return { inboxPath, cursorPath };
}

function writeOwnSummary(home, unread, pendingQuestions) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  const entry = { unread: unread || 0 };
  if (pendingQuestions !== undefined) entry.pendingQuestions = pendingQuestions;
  const workspaces = { [OWN_ID]: entry };
  if (Array.isArray(pendingQuestions)) {
    for (const q of pendingQuestions) {
      if (q && q.from != null && q.from !== OWN_ID) workspaces[String(q.from)] = {};
    }
  }
  fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), JSON.stringify({ workspaces, archivedRegistryRows: [] }));
}

test('GRACE: a message sent seconds ago (no busy evidence) -> advisory, not a block', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'child-fresh', { unread: 1, ageMin: 0.1 }); // ~6s old
    const r = run(h.home, stopPayload('grace-fresh'));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `fresh mail (no busy evidence) must not block; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /within the grace window, not yet neglect/, `stderr=${r.stderr}`);
  } finally { h.cleanup(); }
});

test('OLD MAIL: unread older than the grace window -> still BLOCKS', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'child-old', { unread: 1, ageMin: 30 }); // past default 5m grace
    const r = run(h.home, stopPayload('grace-old'));
    assert.strictEqual(r.json && r.json.decision, 'block', `old unread must still block; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.json.reason, /1 unread/);
  } finally { h.cleanup(); }
});

test('CONFIGURABLE: raising the grace window (env override) suppresses a block that would fire under the default', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'child-mid', { unread: 1, ageMin: 2 }); // past the default 1m grace -> blocks by default
    const baseline = run(h.home, stopPayload('grace-mid'));
    assert.strictEqual(baseline.json && baseline.json.decision, 'block', `precondition: 2m-old mail must block under the default 1m grace; stdout=${baseline.stdout} stderr=${baseline.stderr}`);
    const r = run(h.home, stopPayload('grace-mid-2'), { ANTIHALL_DEVSWARM_PARENT_GATE_NEGLECT_GRACE_MIN: '5' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `2m-old mail must NOT block once the grace window is raised to 5m; stdout=${r.stdout} stderr=${r.stderr}`);
  } finally { h.cleanup(); }
});

test('NOT SUPPRESSED: fresh unread PLUS an unanswered child question -> still BLOCKS on the question axis', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'child-ask', { unread: 1, ageMin: 0.1 }); // fresh, would otherwise get grace
    writeOwnSummary(h.home, 0, [{ from: 'child-ask', ts: Date.now() - 60000, seq: 1 }]);
    const r = run(h.home, stopPayload('grace-question'));
    assert.strictEqual(r.json && r.json.decision, 'block', `an unanswered child question must still block despite fresh mail elsewhere; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.json.reason, /UNANSWERED QUESTION/, `reason=${r.json && r.json.reason}`);
  } finally { h.cleanup(); }
});
