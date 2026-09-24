'use strict';
// devswarm-parent-gate cursor-namespace parity, take 2 — the v0.102.2 fix
// (CURSOR-NAMESPACE PARITY comment, devswarm-parent-gate.js's union-unread
// block) computed the per-instance nonce from `cwd: d.worktreePath` — the
// DESCRIPTOR's worktree — instead of the gate's OWN cwd. `deriveInstanceNonce`
// (scripts/devswarm.js) matches the CALLING PROCESS's own ancestry (a
// `<home>/.claude/sessions/<pid>.json` record) against the cwd it is handed —
// it is a PER-READER identity, never a per-partition one (every OTHER call
// site in scripts/devswarm.js — cmdInbox's read-primary/peek-primary, the
// registration path — passes `ctx.cwd` defaulting to `process.cwd()`, the
// CALLER's own cwd, never a target's). Passing the descriptor's worktree
// instead of the gate's own cwd makes the match fail for every descriptor that
// is not the gate's own row (a REAL different worktree matches no session
// record), which falls back to the UNDECLARED `self:<parentPid>:<startMs>`
// nonce — `siblingBaseCursor` then finds no declared instance file under that
// nonce and drops to the cross-instance MIN-floor cursor, exactly the
// phantom-unread source the v0.102.2 edit was meant to eliminate. Net: the fix
// worked only for the gate's SELF descriptor and was INERT for every CHILD
// descriptor, i.e. the common case.
//
// THIS FILE proves the FIX (cwd: cwd, the gate's own reading identity, not
// cwd: d.worktreePath) with a decisive, non-vacuous, behavioral test: a real
// child descriptor whose worktreePath is a DIFFERENT real directory than the
// gate's own cwd, a real declared per-instance cursor keyed to the nonce the
// GATE's own cwd resolves to, and store-only mesh rows that the declared
// cursor has partially consumed. Only the fixed code can find that declared
// cursor for the CHILD descriptor's union-unread computation; the unfixed
// code (keying off the child's worktree) cannot, and reports the inflated
// MIN-floor count instead.
//
// VACUITY: this test was run against the UNFIXED source (`cwd: d.worktreePath`
// restored) before the fix was reapplied — see the sibling note in the fix
// report for the captured RED failure. It is not re-derived here because
// re-injecting the bug at runtime (rather than reading a stale trace) is what
// proves the test is live, and that was done once, out-of-band, exactly as
// the task required.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const meshStore = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const inboxCursor = require('../../plugins/anti-hall/companion/lib/devswarm-inbox-cursor.js');
const devswarmCli = require('../../plugins/anti-hall/scripts/devswarm.js');

const HOOK = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'devswarm-parent-gate.js');
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };

const REPO_CWD = process.cwd();
const REPO_HASH = installIngest.worktreeHash(REPO_CWD);
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);
const OWN_ID = 'primary-' + REPO_HASH;

const GIT_AVAILABLE = (() => {
  try {
    const r = cp.spawnSync('git', ['--version']);
    return !r.error && r.status === 0;
  } catch (_) { return false; }
})();

// makeLinkedWorktree() — a REAL `git worktree add` linked worktree of THIS
// repo: SAME repoKey (git-common-dir) as REPO_CWD, but a DISTINCT toplevel
// path. Mirrors devswarm-parent-gate.test.js's own helper of the same name
// (not imported from there per scope: that file is owned by another agent
// right now) so a child descriptor here has a real, resolvable, but
// genuinely DIFFERENT worktree identity from the gate's own cwd.
function makeLinkedWorktree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-nonce-cwd-wt-'));
  fs.rmdirSync(dir); // `git worktree add` requires the target not already exist
  const branch = 'fix-nonce-cwd-' + path.basename(dir);
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

// seedChildWorkspace(home, id, worktreePath) — the minimal descriptor +
// empty-NDJSON-inbox fixture (mirrors devswarm-parent-gate.test.js's
// seedWorkspace, self-contained copy). Store-only rows carry the entire
// unread signal in this test, matching the union-unread FIX 3a pattern
// already proven in that file.
function seedChildWorkspace(home, id, worktreePath) {
  const root = path.join(home, '.anti-hall', 'devswarm');
  const wsDir = path.join(root, 'workspaces');
  const inboxPath = path.join(root, 'inbox', id + '.ndjson');
  const cursorPath = path.join(root, 'cursor', id + '.json');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  const descriptor = {
    id, worktreePath, sessionId: 'child-' + id, inboxPath, cursorPath,
  };
  fs.writeFileSync(path.join(wsDir, id + '.json'), JSON.stringify(descriptor));
  fs.writeFileSync(inboxPath, '');
  fs.writeFileSync(cursorPath, '0');
}

// seedStoreOnlyRow(home, id, from, hash) — a real store-direct mesh row
// (appendMeshMessage), mirrors devswarm-parent-gate.test.js's own helper.
function seedStoreOnlyRow(home, id, from, hash) {
  const s = meshStore.openStore({ home, workspaceId: id, hash: REPO_KEY });
  try {
    meshStore.appendMeshMessage(s, {
      from, to: id, type: 'direct', message: 'store-direct row ' + hash, timestamp: Date.now(), hash,
    });
  } finally { s.close(); }
}

// writeGateSession(home, cwd, startedAt) — registers a REAL harness session
// record for THIS TEST PROCESS's own pid, at the given cwd. The spawned gate
// hook is a direct child of this test process (no shell wrapper, see
// tests/helpers/spawn-hook.js), so `deriveInstanceNonce`'s ancestor walk
// fails to match the hook's OWN pid (hop 0, no file), then hops to its
// PARENT — this test process's pid (hop 1) — and finds this record. The
// match requires the record's cwd to canonicalize to the SAME real path as
// the value `deriveInstanceNonce` is called with.
function writeGateSession(home, cwd, startedAt) {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const rec = { pid: process.pid, cwd, startedAt, sessionId: 'fix-nonce-cwd-test' };
  fs.writeFileSync(path.join(dir, String(process.pid) + '.json'), JSON.stringify(rec));
}

function stopPayload() {
  return { hook_event_name: 'Stop', session_id: 'sess-fix-nonce-cwd' };
}

function run(home) {
  return testHookRaw(HOOK, JSON.stringify(stopPayload()), { home, env: PRIMARY_ENV });
}

// PHASE 3 (mesh redesign, reader_cursors) SUPERSEDES the v0.102.2 approach this
// file originally pinned: the parent gate looking at a CHILD's partition is a
// MONITORING view ("does the child have backlog"), so it counts from the
// partition's stored FLOOR (reader null) — never from the gate process's own
// reader row, whatever cwd that identity resolves from. A per-reader base there
// could only ever HIDE a slower reader's backlog.
function seedReaderRows(home, id, rows) {
  const s = meshStore.openStore({ home, workspaceId: id, hash: REPO_KEY });
  try { s.readerCursorTxn((tx) => { for (const r of rows) tx.put(Object.assign({ partition: id, updatedAt: 1 }, r)); }); }
  finally { s.close(); }
}

test('PHASE 3: the parent gate counts a CHILD partition from its stored FLOOR — the gate\'s own reader row never shrinks it', { skip: !GIT_AVAILABLE && 'git not available on PATH' }, () => {
  const h = makeHome();
  const wt = makeLinkedWorktree();
  try {
    const CHILD_ID = 'ws-nonce-cwd-fix';
    const STARTED_AT = 1700000000000;
    writeGateSession(h.home, REPO_CWD, STARTED_AT);
    seedChildWorkspace(h.home, CHILD_ID, wt.dir);
    seedStoreOnlyRow(h.home, CHILD_ID, 'some-other-sender', 'fix-nonce-cwd-1');
    seedStoreOnlyRow(h.home, CHILD_ID, 'some-other-sender', 'fix-nonce-cwd-2');
    seedStoreOnlyRow(h.home, CHILD_ID, 'some-other-sender', 'fix-nonce-cwd-3');
    // Floor at 2 (every live declared reader has consumed 2); the GATE's own
    // harness identity (this test process, the hook's parent) holds a row at 3
    // and a lagging sibling reader sits at 2.
    const gateReader = 'h:' + process.pid + ':' + STARTED_AT;
    seedReaderRows(h.home, CHILD_ID, [
      { ns: 'store', reader: '#floor', value: 2 }, { ns: 'nd', reader: '#floor', value: 0 },
      { ns: 'store', reader: gateReader, value: 3 }, { ns: 'store', reader: 'h:1:1', value: 2 },
    ]);
    const r = run(h.home);
    assert.strictEqual(r.status, 0, `gate must exit 0; stderr=${r.stderr}`);
    assert.ok(r.json, `stdout must be JSON; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.strictEqual(r.json.decision, 'block', `must block on the child's floor-view unread; reason=${r.json && r.json.reason}`);
    assert.match(r.json.reason, /\b1 unread\b/, `floor 2 of 3 -> 1 unread; got ${r.json.reason}`);
    assert.doesNotMatch(r.json.reason, /\b0 unread\b|\b3 unread\b/, `must use the floor, neither the gate's own row (0) nor 0 (3); reason=${r.json.reason}`);
  } finally {
    try { wt.cleanup(); } catch (_) {}
    try { h.cleanup(); } catch (_) {}
  }
});
