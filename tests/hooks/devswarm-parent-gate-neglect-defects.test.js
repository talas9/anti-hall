'use strict';
// devswarm-parent-gate.js — DEFECT 0ace80dff415 (P1): an ESCALATED child that
// is merged, done-reported and archive-approved by the Primary (all required
// gates done/merged/tests_passed set -> the store already derives
// archive_ready:true into the per-project summary projection) still forced
// "DEVSWARM NEGLECT" on every Stop, because the liveness verdict file is
// sticky and there was no verb for the Primary to clear it. Fix:
// hooks/devswarm-parent-gate.js's isArchiveReadyFor() projects the SAME
// archive_ready fact the store already derives and suppresses ONLY the
// stale/escalated axis (mirrors the existing hasFreshHeartbeat suppression
// right above it). Reads only an already-written file
// (summaries/<repoKey>.json) — no git spawn, no computeLiveness, no store DB
// open — matching this hook's existing cheap-Stop-hook-read discipline.
//
// DEFECT 45cf1659f54f (P2, gone-worktree unread pressure) is NOT fixed in
// this file — see the task's final report. A first attempt (diverting any
// confirmed-gone-worktree row's FULL contribution — real unread, unknown, AND
// stale/escalated — away from `blocking`) was REVERTED after it broke ~60
// pre-existing tests in devswarm-parent-gate.test.js, several of them
// EXPLICIT "MUST NOT BREAK" regression guards proving the current behavior —
// continuing to count a gone-worktree row's real/store-side unread and its
// stale/escalated verdict — is a DELIBERATE, already-hardened design decision
// (`inbox read <id>` and the store-union widening are both cwd-independent
// and genuinely still drain a gone-worktree row's mailbox; see e.g. "MUST NOT
// BREAK: worktree GONE + STORE-side unread -> STILL blocks on the unionUnread
// axis" and "...+ a CORROBORATED stale verdict -> STILL blocks on the
// staleOrEscalated axis" in devswarm-parent-gate.test.js). The genuinely
// still-unclearable sub-case the field report may be describing (if any)
// needs to be identified WITHOUT contradicting that existing, tested
// invariant — out of scope for a same-turn retry.
//
// MUTATION LIST (proven RED against this test, GREEN against the real fix —
// see the pasted transcript in this task's final report):
//   M1: delete the `if (staleOrEscalated) { try { if
//       (isArchiveReadyFor(...)) staleOrEscalated = false; } catch (_) {} }`
//       block -> kills "ARCHIVE-READY escalated child no longer blocks".
//   M2: make isArchiveReadyFor return `true` unconditionally (ignore the
//       summary read) -> kills "NEGATIVE CONTROL: escalated WITHOUT
//       archive_ready still blocks".

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

const HOOK = 'devswarm-parent-gate.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);

function run(home, payload, env) {
  return testHookRaw(HOOK, JSON.stringify(payload || { hook_event_name: 'Stop', session_id: 'sess-1' }), {
    home,
    env: { ...PRIMARY_ENV, ...(env || {}) },
  });
}

// makeLinkedWorktree() -> a REAL `git worktree add` linked worktree of THIS
// repo (same repoKey/REPO_KEY as REPO_CWD, distinct toplevel path) — mirrors
// devswarm-parent-gate.test.js's own helper of the same name, needed here
// because isArchiveReadyFor/repoKeyOfWorktree resolve a REAL git repoKey, not
// an injected one (this hook is exercised as a real subprocess, no DI).
function makeLinkedWorktree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-gate-defect-wt-'));
  fs.rmdirSync(dir);
  const branch = 'parent-gate-defect-' + path.basename(dir);
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
  if (opts.messages != null) {
    fs.writeFileSync(inboxPath, opts.messages.map((m) => JSON.stringify({ m })).join('\n') + '\n');
  } else {
    fs.writeFileSync(inboxPath, ''); // confirmed-empty, known:true/0-unread
  }
  fs.writeFileSync(cursorPath, String(opts.cursor != null ? opts.cursor : 0));
  if (opts.verdict != null) {
    const lp = path.join(root, 'liveness', id + '.json');
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    fs.writeFileSync(lp, JSON.stringify(opts.verdict));
  }
  return { inboxPath, cursorPath };
}

function writeSummary(home, repoKey, workspaces) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, repoKey + '.json'), JSON.stringify({ workspaces }));
}

// ---------------------------------------------------------------------------
// DEFECT 0ace80dff415 (P1)
// ---------------------------------------------------------------------------

test('DEFECT A: ARCHIVE-READY escalated child no longer blocks Stop', () => {
  const h = makeHome();
  const wt = makeLinkedWorktree();
  try {
    // Corroborated (verdict.pending:true) so the A1 corroboration gate alone
    // does not already suppress this — proves the NEW archive_ready check is
    // what clears it, not a pre-existing axis.
    seedWorkspace(h.home, 'ws1', { worktreePath: wt.dir, verdict: { status: 'escalated', pending: true } });
    writeSummary(h.home, REPO_KEY, { ws1: { archive_ready: true } });
    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json, null, `must be a silent no-op once archive_ready suppresses the only axis; stdout=${r.stdout}`);
  } finally { wt.cleanup(); h.cleanup(); }
});

test('DEFECT A NEGATIVE CONTROL: escalated WITHOUT archive_ready still blocks', () => {
  const h = makeHome();
  const wt = makeLinkedWorktree();
  try {
    seedWorkspace(h.home, 'ws1', { worktreePath: wt.dir, verdict: { status: 'escalated', pending: true } });
    // No summary at all -> isArchiveReadyFor fails closed to false.
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', `a genuinely-escalated, non-done child must still block; stdout=${r.stdout}`);
    assert.match(r.json.reason, /escalated/);
  } finally { wt.cleanup(); h.cleanup(); }
});

test('DEFECT A NEGATIVE CONTROL: archive_ready:false explicitly still blocks', () => {
  const h = makeHome();
  const wt = makeLinkedWorktree();
  try {
    seedWorkspace(h.home, 'ws1', { worktreePath: wt.dir, verdict: { status: 'escalated', pending: true } });
    writeSummary(h.home, REPO_KEY, { ws1: { archive_ready: false } });
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block');
  } finally { wt.cleanup(); h.cleanup(); }
});

