'use strict';
// devswarm-parent-inbox.js — OWN-CHECKOUT ROW FOLD (P0 field bug, attempt #2).
//
// FIELD REPORT: the DevSwarm app self-registers its own "primary builder" row
// under an id OTHER than anti-hall's own primaryId (e.g. an app builder id
// like `76cf862f…`, label "SkyCrew", worktree === the Primary's own main
// checkout). Before this fix such a row fell through to the generic CHILD
// path, producing a false "SkyCrew (76cf862f) N unread" nag with wrong
// child-shaped wording ("messages YOU sent").
//
// ATTEMPT #1 (reverted): folding ANY row whose worktree matched the Primary's
// own checkout broke 59 existing tests, because this test SUITE's own
// fixtures widely reuse the test's own repo cwd as an ordinary CHILD's
// worktreePath for convenience. Worktree match alone is NOT sufficient.
//
// PROVEN SIGNAL (owner-verified on the live DevSwarm app DB): the `builders`
// table's `builderType` column is 'primary' for exactly the app's own row
// (5 primary vs 209 standard, live-verified) — companion/lib/devswarm-appdb.js
// is the injectable (dbPath-overridable), fail-open (-> null on ANY error)
// accessor for it. The fold requires BOTH conjuncts: worktree match AND
// builderTypeFor(id) === 'primary'. When the app DB is unavailable (the
// common case — no test in this suite ships one), builderTypeFor always
// returns null, so NOTHING folds and every pre-existing fixture is
// byte-identical to before this fix.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

const HOOK = 'devswarm-parent-inbox.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);

// Only meaningful where node:sqlite is actually available (CI matrix node 22/24) —
// same gate the rest of the codebase uses for its own sqlite-backed tests.
let HAS_SQLITE = true;
try { require('node:sqlite'); } catch (_) { HAS_SQLITE = false; }

function payload() { return { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: REPO_CWD }; }
function ctx(r) { return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || ''; }
function segment(c, banner) { return c.split('\n\n').find((s) => s.startsWith(banner)) || ''; }
function tableSeg(c) { return segment(c, 'DEVSWARM WORKSPACES'); }
function tableRow(c, id) { return tableSeg(c).split('\n').find((l) => l.startsWith('| ' + id + ' ')) || ''; }

function writeSharedSummary(home, workspaces) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  const full = {};
  for (const id of Object.keys(workspaces)) {
    full[id] = Object.assign({
      worktreePath: REPO_CWD, sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null,
      total: 0, cursor: 0, unread: 0, directUnread: 0, broadcastUnread: 0, urgencyMax: null,
      working_on: null, gates: {}, archive_ready: false,
    }, workspaces[id]);
  }
  fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), JSON.stringify({
    generatedAt: Date.now(), requiredGates: [], workspaces: full, recent: [],
  }));
}

// writeAppDb(home, rows) -> absolute path to a fixture DevSwarm app DB with a
// minimal `builders(id, builderType, worktreePath, label)` table — exactly
// the shape devswarm-appdb.js's builderTypeForId query reads.
function writeAppDb(home, rows) {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(home, 'fixture-devswarm-app.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE builders (id TEXT PRIMARY KEY, builderType TEXT, worktreePath TEXT, label TEXT)');
  const stmt = db.prepare('INSERT INTO builders (id, builderType, worktreePath, label) VALUES (?, ?, ?, ?)');
  for (const r of rows) stmt.run(r.id, r.builderType, r.worktreePath || null, r.label || null);
  db.close();
  return dbPath;
}

function runInbox(home, envOverride) {
  return testHook(HOOK, payload(), { home, env: Object.assign({}, PRIMARY_ENV, envOverride || {}), expectJson: true });
}

(HAS_SQLITE ? test : test.skip)(
  'a builderType:"primary" row on the Primary\'s own worktree is FOLDED into own-unread, never a fake child nag',
  () => {
    const h = makeHome();
    try {
      writeSharedSummary(h.home, {
        '76cf862f': { worktreePath: REPO_CWD, total: 2, cursor: 0, unread: 2, directUnread: 2, urgencyMax: 'normal' },
      });
      const dbPath = writeAppDb(h.home, [{ id: '76cf862f', builderType: 'primary', worktreePath: REPO_CWD, label: 'SkyCrew' }]);
      const r = runInbox(h.home, { ANTIHALL_APPDB_PATH: dbPath });
      const c = ctx(r);
      assert.strictEqual(tableRow(c, '76cf862f'), '', 'the app-primary row must NEVER appear as a standalone child table row');
      assert.ok(!/SkyCrew \(76cf862f\)/.test(c), 'must never render the false child-shaped nag: ' + c);
      assert.match(c, /DEVSWARM OWN INBOX/, 'its unread must instead surface via the own-unread path');
      assert.match(c, /2 unread/);
    } finally { h.cleanup(); }
  }
);

(HAS_SQLITE ? test : test.skip)(
  'a builderType:"standard" row on the SAME worktree is UNCHANGED — still a genuine child',
  () => {
    const h = makeHome();
    try {
      writeSharedSummary(h.home, {
        wsStd: { worktreePath: REPO_CWD, total: 2, cursor: 0, unread: 2, directUnread: 2, urgencyMax: 'normal' },
      });
      const dbPath = writeAppDb(h.home, [{ id: 'wsStd', builderType: 'standard', worktreePath: REPO_CWD, label: 'a-child' }]);
      const r = runInbox(h.home, { ANTIHALL_APPDB_PATH: dbPath });
      const c = ctx(r);
      assert.match(tableRow(c, 'wsStd'), /wsStd/, 'a standard-builderType row must still render as an ordinary child row');
    } finally { h.cleanup(); }
  }
);

test('no app DB available (the common/default case) — same-worktree row behaves exactly as before this fix', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      wsNoDb: { worktreePath: REPO_CWD, total: 2, cursor: 0, unread: 2, directUnread: 2, urgencyMax: 'normal' },
    });
    // No ANTIHALL_APPDB_PATH set, and no real app DB exists at the guessed
    // per-OS path inside this fake HOME -> builderTypeForId fails open to
    // null -> the fold never applies -> unchanged child-row behavior.
    const r = runInbox(h.home);
    const c = ctx(r);
    assert.match(tableRow(c, 'wsNoDb'), /wsNoDb/, 'with no app DB, a same-worktree row must remain an ordinary child (fail-open, unchanged)');
  } finally { h.cleanup(); }
});
