'use strict';
// Mesh redesign Phase 3 — "a read error must return UNKNOWN, never 0, and gates
// treat unknown as block-with-reason" (Codex: the pre-existing error->0 path in
// devswarm-unread.js unionUnread's catch). End to end through the REAL parent
// Stop gate: a child partition whose read positions (reader_cursors) cannot be
// read must BLOCK with a reason naming the unknown state — before Phase 3 the
// store-side failure was swallowed and the row read as drained.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const meshStore = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

const HOOK = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'devswarm-parent-gate.js');
const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);
const ENV = { DEVSWARM_REPO_ID: 'repo-1', ANTIHALL_DEVSWARM_STORE_BACKEND: 'journal' };
const GIT_AVAILABLE = (() => { try { const r = cp.spawnSync('git', ['--version']); return !r.error && r.status === 0; } catch (_) { return false; } })();

function makeLinkedWorktree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-unknown-wt-'));
  fs.rmdirSync(dir);
  const branch = 'gates-unknown-' + path.basename(dir);
  const r = cp.spawnSync('git', ['worktree', 'add', '-q', '-b', branch, dir, 'HEAD'], { cwd: REPO_CWD });
  if (r.status !== 0) throw new Error('git worktree add failed: ' + (r.stderr && r.stderr.toString()));
  return {
    dir,
    cleanup() {
      try { cp.spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: REPO_CWD }); } catch (_) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      try { cp.spawnSync('git', ['worktree', 'prune'], { cwd: REPO_CWD }); } catch (_) {}
      try { cp.spawnSync('git', ['branch', '-D', branch], { cwd: REPO_CWD }); } catch (_) {}
    },
  };
}
function seedChild(home, id, worktreePath) {
  const root = path.join(home, '.anti-hall', 'devswarm');
  const inboxPath = path.join(root, 'inbox', id + '.ndjson');
  const cursorPath = path.join(root, 'cursor', id + '.json');
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspaces', id + '.json'), JSON.stringify({ id, worktreePath, sessionId: 'child-' + id, inboxPath, cursorPath }));
  fs.writeFileSync(inboxPath, '');
  fs.writeFileSync(cursorPath, '0');
  const s = meshStore.openStore({ home, workspaceId: id, hash: REPO_KEY, backend: 'journal' });
  try {
    meshStore.appendMeshMessage(s, { from: 'someone', to: id, type: 'direct', message: 'hello', timestamp: Date.now(), hash: 'gates-unknown-1' });
  } finally { s.close(); }
  return path.join(home, '.anti-hall', 'devswarm', 'store', REPO_KEY, 'journal', 'reader_cursors.ndjson');
}
const run = (home) => testHookRaw(HOOK, JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-gates-unknown' }), { home, env: ENV });

test('parent gate: an UNREADABLE reader_cursors table blocks with an UNKNOWN reason (never read as drained)', { skip: !GIT_AVAILABLE && 'git not available' }, () => {
  const h = makeHome();
  const wt = makeLinkedWorktree();
  try {
    const rcFile = seedChild(h.home, 'ws-unknown', wt.dir);
    fs.mkdirSync(rcFile, { recursive: true }); // EISDIR on every read of the table
    const r = run(h.home);
    assert.equal(r.status, 0, 'stderr=' + r.stderr);
    assert.ok(r.json, 'stdout=' + r.stdout);
    assert.equal(r.json.decision, 'block', 'an unknown unread count must block; reason=' + (r.json && r.json.reason));
    assert.match(r.json.reason, /ws-unknown/);
    assert.match(r.json.reason, /UNKNOWN/, 'the reason names the unknown state: ' + r.json.reason);
  } finally { try { wt.cleanup(); } catch (_) {} try { h.cleanup(); } catch (_) {} }
});

test('parent gate control: the SAME fixture with a healthy table counts the real unread (1)', { skip: !GIT_AVAILABLE && 'git not available' }, () => {
  const h = makeHome();
  const wt = makeLinkedWorktree();
  try {
    seedChild(h.home, 'ws-known', wt.dir);
    const r = run(h.home);
    assert.equal(r.status, 0, 'stderr=' + r.stderr);
    assert.equal(r.json && r.json.decision, 'block');
    assert.match(r.json.reason, /ws-known \(1 unread\)/, r.json.reason);
    assert.doesNotMatch(r.json.reason, /UNKNOWN/);
  } finally { try { wt.cleanup(); } catch (_) {} try { h.cleanup(); } catch (_) {} }
});

test('parent gate: an UNREADABLE message journal blocks with an UNKNOWN reason — the pre-Phase-3 error->0 path', { skip: !GIT_AVAILABLE && 'git not available' }, () => {
  const h = makeHome();
  const wt = makeLinkedWorktree();
  try {
    const rcFile = seedChild(h.home, 'ws-unread-err', wt.dir);
    const msgs = path.join(path.dirname(rcFile), 'messages.ndjson');
    fs.renameSync(msgs, msgs + '.moved');
    fs.mkdirSync(msgs); // EISDIR: the journal records the error and reads EMPTY (never throws)
    const r = run(h.home);
    assert.equal(r.status, 0, 'stderr=' + r.stderr);
    assert.equal(r.json && r.json.decision, 'block', 'a store read error must never read as "0 unread"; got ' + JSON.stringify(r.json));
    assert.match(r.json.reason, /ws-unread-err/);
    assert.match(r.json.reason, /UNKNOWN/, r.json.reason);
  } finally { try { wt.cleanup(); } catch (_) {} try { h.cleanup(); } catch (_) {} }
});
