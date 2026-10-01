'use strict';
// hooks/devswarm-parent-gate.js — unread BROADCAST rows to a DONE child
// (archive_ready, via the summary projection) are not parent neglect; DIRECT
// rows still count; a not-done child still counts broadcasts. Archived children
// never count at all (0.109.4, re-pinned here). The escalation text names
// `devswarm.js archive <id>` when every flagged child is done or idle.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

const HOOK = 'devswarm-parent-gate.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);

function run(home, env) {
  return testHookRaw(HOOK, JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-1' }), {
    home, env: { ...PRIMARY_ENV, ...(env || {}) },
  });
}

function makeLinkedWorktree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-done-bc-wt-'));
  fs.rmdirSync(dir);
  const branch = 'pg-done-bc-' + path.basename(dir);
  const r = cp.spawnSync('git', ['worktree', 'add', '-q', '-b', branch, dir, 'HEAD'], { cwd: REPO_CWD });
  if (r.status !== 0) throw new Error('git worktree add failed: ' + (r.stderr && r.stderr.toString()));
  return {
    dir,
    cleanup() {
      try { cp.spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: REPO_CWD }); } catch (_) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      try { cp.spawnSync('git', ['branch', '-D', branch], { cwd: REPO_CWD }); } catch (_) {}
    },
  };
}

// rows: array of objects written verbatim as NDJSON lines.
function seedWorkspace(home, id, worktreePath, rows) {
  const root = path.join(home, '.anti-hall', 'devswarm');
  const inboxPath = path.join(root, 'inbox', id + '.ndjson');
  const cursorPath = path.join(root, 'cursor', id + '.json');
  for (const d of [path.join(root, 'workspaces'), path.dirname(inboxPath), path.dirname(cursorPath)]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, 'workspaces', id + '.json'),
    JSON.stringify({ id, worktreePath, sessionId: 'child-' + id, inboxPath, cursorPath }));
  fs.writeFileSync(inboxPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(cursorPath, '0');
}
function writeSummary(home, workspaces) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), JSON.stringify({ workspaces }));
}

const BROADCAST = { m: 'fyi: main moved', type: 'broadcast' };
const DIRECT = { m: 'please rebase' };

test('done child with an unread BROADCAST -> not neglect (no block)', () => {
  const h = makeHome(); const wt = makeLinkedWorktree();
  try {
    seedWorkspace(h.home, 'ws1', wt.dir, [BROADCAST]);
    writeSummary(h.home, { ws1: { archive_ready: true } });
    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json, null, `stdout=${r.stdout}`);
  } finally { wt.cleanup(); h.cleanup(); }
});

test('done child with an unread DIRECT message -> still blocks', () => {
  const h = makeHome(); const wt = makeLinkedWorktree();
  try {
    seedWorkspace(h.home, 'ws1', wt.dir, [BROADCAST, DIRECT]);
    writeSummary(h.home, { ws1: { archive_ready: true } });
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', `stdout=${r.stdout}`);
    assert.match(r.json.reason, /ws1 \(1 unread/);
  } finally { wt.cleanup(); h.cleanup(); }
});

test('NOT-done child with an unread broadcast -> still blocks', () => {
  const h = makeHome(); const wt = makeLinkedWorktree();
  try {
    seedWorkspace(h.home, 'ws1', wt.dir, [BROADCAST]);
    writeSummary(h.home, { ws1: { archive_ready: false } });
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', `stdout=${r.stdout}`);
  } finally { wt.cleanup(); h.cleanup(); }
});

test('escalation names `devswarm.js archive <id>` when every flagged child is done; not when one is not', () => {
  for (const [allDone, expectHint] of [[true, true], [false, false]]) {
    const h = makeHome(); const wt = makeLinkedWorktree(); const wt2 = makeLinkedWorktree();
    try {
      seedWorkspace(h.home, 'ws1', wt.dir, [DIRECT]);
      seedWorkspace(h.home, 'ws2', wt2.dir, [DIRECT]);
      writeSummary(h.home, { ws1: { archive_ready: true }, ws2: { archive_ready: allDone } });
      const env = { ANTIHALL_DEVSWARM_PARENT_GATE_CAP: '1' };
      let esc = null;
      for (let i = 0; i < 4 && !esc; i++) {
        const r = run(h.home, env);
        if (r.json && /DEVSWARM ESCALATION/.test(r.json.reason)) esc = r.json.reason;
      }
      assert.ok(esc, 'escalation fires within the cap');
      if (expectHint) assert.match(esc, /devswarm\.js archive <id>/);
      else assert.doesNotMatch(esc, /devswarm\.js archive <id>/);
    } finally { wt2.cleanup(); wt.cleanup(); h.cleanup(); }
  }
});
