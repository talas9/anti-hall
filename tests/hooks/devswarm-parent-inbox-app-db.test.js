'use strict';
// v0.108.0 — parent-inbox reads the DevSwarm app DB snapshot (fixture, tmpdir):
//   (1) title = the app's full label (not the stale names cache)
//   (2) finish column gains the app's PR record ("PR #12 merged, checks failed")
//   (3) pinned / on-screen / "brief not delivered" markers on the title cell
//   (4) the workspace the owner has ON SCREEN (lastSelectedAt < 2 min) is not
//       nagged; another workspace with the same backlog still is
//   (5) sidebar rank breaks ties
//   (6) no app DB -> none of the above (byte-identical fallback)

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const repokey = require(path.join(ROOT, 'companion', 'lib', 'devswarm-repokey.js'));
const names = require(path.join(ROOT, 'companion', 'lib', 'devswarm-names.js'));
const { testHook } = require('../helpers/spawn-hook.js');
const { buildAppDb, rmFixture } = require('../helpers/app-db-fixture.js');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite unavailable';

function run(f, env) {
  const REPO_CWD = process.cwd();
  const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);
  const dir = path.join(f.home, '.anti-hall', 'devswarm', 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  const plainA = path.join(f.base, 'plain-a');
  fs.mkdirSync(plainA, { recursive: true });
  const ws = (wt) => ({ worktreePath: wt, sessionId: null, total: 3, cursor: 0, unread: 3, directUnread: 3, urgencyMax: 'normal', gates: {}, archive_ready: false });
  fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), JSON.stringify({
    generatedAt: Date.now(), requiredGates: ['done'], recent: [], archivedRegistryRows: [],
    // The summary's row for b-a sits on a plain dir (the fixture's wt-a carries a
    // fake .git for the PR-freshness check, which would read as a foreign
    // project here); the app row is matched by id.
    workspaces: { 'b-a': ws(plainA), 'b-b': ws(f.wt.b) },
  }));
  names.writeName(f.home, 'b-a', 'Alpha task with a long full…', Date.now()); // stale truncated cache
  const r = testHook('devswarm-parent-inbox.js',
    { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: REPO_CWD },
    { home: f.home, env: Object.assign({ DEVSWARM_REPO_ID: 'repo-1' }, env), expectJson: true });
  assert.strictEqual(r.status, 0);
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

test('(1)-(5) app DB title, PR finish signal, markers, focus suppression, rank tiebreak', { skip }, () => {
  const f = buildAppDb();
  try {
    const db = new sqlite.DatabaseSync(f.dbFile);
    db.prepare('UPDATE builders SET lastSelectedAt = ? WHERE id = ?').run(new Date(Date.now() - 10e3).toISOString(), 'b-b');
    db.close();
    const c = run(f, Object.assign({}, f.env));
    const table = c.split('\n\n').find((s) => s.startsWith('DEVSWARM WORKSPACES')) || '';
    const rowA = table.split('\n').find((l) => l.includes('(b-a)')) || '';
    const rowB = table.split('\n').find((l) => l.includes('(b-b)')) || '';
    assert.ok(rowA.includes('Alpha task with a long full title that is well past sixty characters in length'), 'full app label wins over the stale cache: ' + rowA);
    assert.ok(rowA.includes('PR #12 merged, checks failed'), 'finish carries the PR signal: ' + rowA);
    assert.ok(rowA.includes('[pinned]'), rowA);
    assert.ok(rowB.includes('on screen') && rowB.includes('⚠ brief not delivered'), rowB);
    assert.ok(table.indexOf('(b-b)') < table.indexOf('(b-a)'), 'sidebar rank 1 before rank 2 on a tie');
    const nag = c.split('\n\n').filter((s) => /^DEVSWARM (URGENT|PARENT) INBOX/.test(s)).join('\n');
    assert.ok(nag.includes('b-a') || nag.includes('Alpha'), 'the off-screen workspace still nags: ' + nag);
    assert.ok(!nag.includes('Bravo') && !nag.includes('b-b'), 'the on-screen workspace is not nagged: ' + nag);
  } finally { rmFixture(f); }
});

test('(4b) focus suppression off (ANTIHALL_DEVSWARM_FOCUS_MS=0) -> the on-screen workspace nags again', { skip }, () => {
  const f = buildAppDb();
  try {
    const db = new sqlite.DatabaseSync(f.dbFile);
    db.prepare('UPDATE builders SET lastSelectedAt = ? WHERE id = ?').run(new Date(Date.now() - 10e3).toISOString(), 'b-b');
    db.close();
    const c = run(f, Object.assign({ ANTIHALL_DEVSWARM_FOCUS_MS: '0' }, f.env));
    const nag = c.split('\n\n').filter((s) => /^DEVSWARM (URGENT|PARENT) INBOX/.test(s)).join('\n');
    assert.ok(nag.includes('Bravo') || nag.includes('b-b'), nag);
  } finally { rmFixture(f); }
});

test('(6) no app DB -> cached name, no PR signal, no markers', { skip }, () => {
  const f = buildAppDb();
  try {
    const c = run(f, { ANTIHALL_DEVSWARM_APP_DB: 'off' });
    const table = c.split('\n\n').find((s) => s.startsWith('DEVSWARM WORKSPACES')) || '';
    assert.ok(table.includes('Alpha task with a long full… (b-a)'), table);
    assert.ok(!table.includes('PR #12') && !table.includes('[pinned') && !table.includes('brief'), table);
  } finally { rmFixture(f); }
});
