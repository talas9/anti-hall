'use strict';
// v0.108.0 — one read-only snapshot of the DevSwarm app DB.
//   (a) schema pin: a fixture with exactly the pinned columns reads `missing: []`
//   (b) joins: repo, PR (by pullRequestId), terminals, active-terminal sessionId,
//       scrollback stat, app version; brief text is never read (length only)
//   (c) fail-open: a dropped column/table degrades to null + `missing`; a
//       dropped core column (builders.isActive) -> null snapshot
//   (d) sessionOwner / sessionMap, briefDelivery, finishSignal, lastSelected
//   (e) messageTimestamps selects no bodies

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const appDb = require(path.join(ROOT, 'companion', 'lib', 'devswarm-app-db.js'));
const { buildAppDb, rmFixture, COLS } = require('../helpers/app-db-fixture.js');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite unavailable';

test('(a) schema pin: fixture columns == SCHEMA; full fixture reads missing: []', { skip }, () => {
  for (const [table, cols] of Object.entries(appDb.SCHEMA)) {
    const have = new Set(COLS[table].split(', ').map((c) => c.split(' ')[0]));
    for (const c of cols) assert.ok(have.has(c), 'fixture ' + table + ' carries pinned column ' + c);
  }
  const f = buildAppDb();
  try {
    appDb.resetCache();
    const s = appDb.snapshot({ home: f.home, env: f.env });
    assert.ok(s && s.ok);
    assert.deepStrictEqual(s.missing, []);
    assert.strictEqual(s.appVersion, 'DevSwarm@9.9.9');
  } finally { rmFixture(f); }
});

test('(b) joins per workspace; brief text never enters the snapshot', { skip }, () => {
  const f = buildAppDb();
  try {
    const s = appDb.readSnapshot(f.dbFile);
    const a = s.workspaces.find((w) => w.id === 'b-a');
    assert.strictEqual(a.repoPath, f.repoPath);
    assert.strictEqual(a.label.length > 60, true, 'full label kept');
    assert.strictEqual(a.pullRequest.number, 12);
    assert.strictEqual(a.pullRequest.state, 'merged');
    assert.strictEqual(a.sessionId, 'sess-a');
    assert.strictEqual(a.isPinned, true);
    assert.deepStrictEqual(a.scrollback && a.scrollback.size, 10);
    const arch = s.workspaces.find((w) => w.id === 'b-arch');
    assert.strictEqual(arch.archived, true);
    assert.strictEqual(arch.scrollback, null, 'no scrollback stat for an inactive builder');
    const b = s.workspaces.find((w) => w.id === 'b-b');
    assert.strictEqual(b.terminals[0].briefPending, true);
    assert.ok(b.terminals[0].briefLen > 0);
    assert.ok(!JSON.stringify(s).includes('SECRET-BRIEF-TEXT'), 'brief text is never selected');
    assert.ok(!JSON.stringify(s).includes('SECRET-BODY'), 'message bodies are never selected');
  } finally { rmFixture(f); }
});

test('(c) fail-open: dropped columns/tables degrade and are listed; core column -> null', { skip }, () => {
  const f = buildAppDb({ drop: ['builders.label', 'builder_terminals.ai_session_config', 'pull_requests (table)', 'workspace_messages.toBranch'] });
  try {
    const s = appDb.readSnapshot(f.dbFile);
    assert.ok(s && s.ok);
    for (const m of ['builders.label', 'builder_terminals.ai_session_config', 'pull_requests (table)', 'workspace_messages.toBranch']) {
      assert.ok(s.missing.includes(m), 'missing lists ' + m + ' (got ' + s.missing.join(',') + ')');
    }
    const a = s.workspaces.find((w) => w.id === 'b-a');
    assert.strictEqual(a.label, null);
    assert.strictEqual(a.sessionId, null);
    assert.strictEqual(a.pullRequest, null);
    assert.strictEqual(appDb.messageTimestamps({ home: f.home, env: f.env }), null, 'counts off when a pinned column is gone');
  } finally { rmFixture(f); }
  const g = buildAppDb({ drop: ['builders.isActive'] });
  try {
    assert.strictEqual(appDb.readSnapshot(g.dbFile), null);
  } finally { rmFixture(g); }
  assert.strictEqual(appDb.snapshot({ home: null, env: {} }), null, 'no home -> never the real home');
  assert.strictEqual(appDb.snapshot({ home: '/x', env: { ANTIHALL_DEVSWARM_APP_DB: 'off' } }), null);
  assert.strictEqual(appDb.readSnapshot('/definitely/not/here.db'), null);
});

test('(d) session owner, brief delivery, finish signal, last selected', { skip }, () => {
  const f = buildAppDb();
  try {
    const s = appDb.readSnapshot(f.dbFile);
    const own = appDb.sessionOwner(s, 'sess-primary-old');
    assert.strictEqual(own.builderId, 'b-primary', 'an older terminal session still maps to its worktree');
    assert.strictEqual(own.terminalActive, false);
    assert.strictEqual(appDb.sessionOwner(s, 'nope'), null);
    const map = appDb.sessionMap(s);
    assert.strictEqual(map['sess-b'].builderId, 'b-b');
    const ws = (id) => s.workspaces.find((w) => w.id === id);
    assert.strictEqual(appDb.briefDelivery(s, ws('b-a'), f.now), null, 'delivered');
    assert.deepStrictEqual(appDb.briefDelivery(s, ws('b-b'), f.now).status, 'not-delivered');
    assert.deepStrictEqual(appDb.briefDelivery(s, ws('b-b'), f.now - 540e3).status, 'pending', 'inside the grace window');
    assert.strictEqual(appDb.briefDelivery(s, ws('b-arch'), f.now), null, 'archived never judged');
    assert.strictEqual(appDb.finishSignal(ws('b-a')), 'PR #12 merged, checks failed');
    assert.strictEqual(appDb.finishSignal(ws('b-b')), null);
    assert.strictEqual(appDb.lastSelected(s, 'repo-1').id, 'b-primary');
    assert.strictEqual(appDb.workspaceFor(s, { worktreePath: f.wt.a }).id, 'b-a');
    assert.strictEqual(appDb.workspaceFor(s, { worktreePath: f.wt.arch }), null, 'never an archived builder by worktree');
    assert.strictEqual(appDb.repositoryForWorktree(s, f.wt.b).id, 'repo-1');
  } finally { rmFixture(f); }
});

test('(d2) brief delivery: rows older than the first recorded delivery are never judged', { skip }, () => {
  const f = buildAppDb();
  try {
    const s = appDb.readSnapshot(f.dbFile);
    const b = s.workspaces.find((w) => w.id === 'b-b');
    const s2 = Object.assign({}, s, { deliveryTrackedSince: b.terminals[0].createdAt + 1 });
    assert.strictEqual(appDb.briefDelivery(s2, b, f.now), null);
  } finally { rmFixture(f); }
});

test('(e) messageTimestamps: window-bounded, no bodies', { skip }, () => {
  const f = buildAppDb();
  try {
    const m = appDb.messageTimestamps({ home: f.home, env: f.env, sinceMs: f.now - 86400e3, untilMs: f.now - 120e3 });
    const rows = m.get('repo-1');
    assert.strictEqual(rows.length, 3, 'the in-flight row is outside the window');
    assert.ok(rows.every((r) => Object.keys(r).sort().join(',') === 'createdAtMs,toBranch'));
    assert.ok(!JSON.stringify(rows).includes('SECRET-BODY'));
  } finally { rmFixture(f); }
});

test('(f) capability gate: a gated column/table sleeps (null + listed), a gated core column -> null', { skip }, () => {
  const f = buildAppDb();
  try {
    const env = Object.assign({}, f.env, { ANTIHALL_DEVSWARM_CAPS_OFF: 'appdb.pull_requests,appdb.builder_terminals.ai_session_config' });
    const s = appDb.readSnapshot(f.dbFile, { env });
    assert.ok(s && s.ok);
    assert.deepStrictEqual(s.gated.sort(), ['appdb.builder_terminals.ai_session_config', 'appdb.pull_requests']);
    assert.strictEqual(s.workspaces.find((w) => w.id === 'b-a').pullRequest, null);
    assert.strictEqual(appDb.sessionOwner(s, 'sess-a'), null);
    assert.strictEqual(appDb.readSnapshot(f.dbFile, { env: Object.assign({}, f.env, { ANTIHALL_DEVSWARM_CAPS_OFF: 'appdb.builders.isActive' }) }), null);
    assert.strictEqual(appDb.readSnapshot(f.dbFile, { env: Object.assign({}, f.env, { ANTIHALL_DEVSWARM_CAPS_OFF: 'appdb' }) }), null);
    assert.strictEqual(appDb.messageTimestamps({ home: f.home, env: Object.assign({}, f.env, { ANTIHALL_DEVSWARM_CAPS_OFF: 'appdb.workspace_messages' }) }), null);
  } finally { rmFixture(f); }
});
