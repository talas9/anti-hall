'use strict';
// devswarm-parent-inbox.js — a FOLDED ghost row's unread directs count toward
// the canonical row's nag (0.108.4). A child's `primary-<hash>` label whose
// canonical row is in the same summary is shown once, under the canonical row;
// before this fix the fold `continue`d past the ghost and its unread vanished.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const aliasLib = require('../../plugins/anti-hall/companion/lib/devswarm-sender-alias.js');

const HOOK = 'devswarm-parent-inbox.js';
const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);
const CHILD = 'wsCanon';
const GHOST = 'primary-deadbeef';

function payload() { return { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: REPO_CWD }; }
function ctx(r) { return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || ''; }
function tableRow(c, id) {
  const seg = c.split('\n\n').find((s) => s.startsWith('DEVSWARM WORKSPACES')) || '';
  return seg.split('\n').find((l) => l.startsWith('| ' + id + ' ') || l.includes('(' + id + ') |')) || '';
}
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
function run(home) {
  return testHook(HOOK, payload(), { home, env: { DEVSWARM_REPO_ID: 'repo-1' }, expectJson: true });
}

test('a folded ghost row\'s unread directs are added to its canonical row (never vanish), and the ghost row is not shown', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      [CHILD]: { total: 1, cursor: 0, unread: 1, directUnread: 1, urgencyMax: 'normal' },
      [GHOST]: { total: 3, cursor: 0, unread: 3, directUnread: 3, urgencyMax: 'normal' },
    });
    const unfolded = ctx(run(h.home));
    assert.match(tableRow(unfolded, GHOST), /\| 3 \|/, 'precondition: unaliased ghost shown with its own unread: ' + unfolded);

    aliasLib.writeAlias(h.home, GHOST, CHILD, REPO_CWD);
    const c = ctx(run(h.home));
    assert.strictEqual(tableRow(c, GHOST), '', 'ghost row folded away: ' + c);
    const row = tableRow(c, CHILD);
    assert.ok(row, 'canonical row shown: ' + c);
    assert.match(row, /\| 4 \|/, 'canonical row carries 1 + 3 = 4 unread: ' + row);
  } finally { h.cleanup(); }
});

test('the ghost\'s unread alone makes a zero-unread canonical row nag', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      [GHOST]: { total: 2, cursor: 0, unread: 2, directUnread: 2, urgencyMax: 'normal' },
      [CHILD]: { total: 0, cursor: 0, unread: 0, directUnread: 0 },
    });
    aliasLib.writeAlias(h.home, GHOST, CHILD, REPO_CWD);
    const c = ctx(run(h.home));
    assert.strictEqual(tableRow(c, GHOST), '');
    assert.match(tableRow(c, CHILD), /\| 2 \|/, 'the ghost unread (2) is on the canonical row: ' + c);
  } finally { h.cleanup(); }
});
