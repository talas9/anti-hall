'use strict';
// hooks/devswarm-parent-gate.js — APP-SIDE ARCHIVE DETECTION (field report).
//
// ROOT CAUSE: the owner archived children in the DevSwarm app. That flow never
// calls anti-hall's `archive` verb, so `archived/<id>.json` is never written,
// `isArchivedWorkspace` stays false forever, and the rows kept forcing
// "DEVSWARM NEGLECT" as escalated/stale on every Stop.
//
// FIX: the supervisor's reconcile sweep caches the app's OWN archived list
// (`hivecontrol workspace list all`) per repoKey; this hook reads that cache
// (never a spawn of its own) and suppresses ONLY the liveness axis, and ONLY
// while the cache is FRESH. A STALE cache is ignored entirely — it can never
// silently mute a live workspace.
//
// MUTATION LIST (proven RED against this file):
//   M1: drop the appArchived consult -> kills "a row ABSENT ... no longer blocks".
//   M2: drop the freshness bound -> kills "a STALE cache changes NOTHING".
//   M3: let appArchived also zero realUnread
//       -> kills "app-archived + REAL unread STILL blocks".
//   M4: drop the repos-root conjunct -> kills "a row outside `.devswarm/repos/`".
//   M5: drop the grace conjunct -> kills "a row registered AFTER the snapshot".

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const cacheLib = require('../../plugins/anti-hall/companion/lib/devswarm-archived-cache.js');

const HOOK = 'devswarm-parent-gate.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);

// The Primary runs FROM a DevSwarm-managed worktree here, not from the
// anti-hall checkout: the absence rule's repos-root conjunct only classifies
// rows under `.devswarm/repos/`, so a test row has to actually live there. The
// gate reads `payload.cwd`, so no helper change is needed.
function run(home, cwd, env) {
  return testHookRaw(HOOK, JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-1', cwd }), {
    home, env: { ...PRIMARY_ENV, ...(env || {}) },
  });
}

// A REAL, standalone git repo at a DevSwarm-shaped path. `git init` on a fresh
// temp dir — it never touches the anti-hall checkout's worktree list.
function makeAppWorktree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-app-arch-'));
  const wt = path.join(base, '.devswarm', 'repos', '1', 'aa', 'child');
  fs.mkdirSync(wt, { recursive: true });
  cp.spawnSync('git', ['init', '-q', wt]);
  return { wt, key: repokey.repoKeyForWorktree(wt),
    cleanup() { try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {} } };
}

// The descriptor's worktreePath must resolve to the SAME repo key the hook
// resolves from its cwd, or the structural cross-project filter drops the row
// before any of this runs. Its mtime is ALSO the row's age source for the
// absence rule's grace conjunct, so it is stamped OLD unless a test says
// otherwise.
function seedWorkspace(home, id, opts = {}) {
  const root = path.join(home, '.anti-hall', 'devswarm');
  const wsDir = path.join(root, 'workspaces');
  const inboxPath = path.join(root, 'inbox', id + '.ndjson');
  const cursorPath = path.join(root, 'cursor', id + '.json');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  const descPath = path.join(wsDir, id + '.json');
  fs.writeFileSync(descPath, JSON.stringify({
    id, worktreePath: opts.worktreePath || REPO_CWD, sessionId: 'child-' + id, inboxPath, cursorPath,
  }));
  fs.writeFileSync(inboxPath, opts.messages
    ? opts.messages.map((m) => JSON.stringify({ message: m })).join('\n') + '\n'
    : '');
  fs.writeFileSync(cursorPath, String(opts.cursor != null ? opts.cursor : 0));
  if (opts.verdict) {
    const lp = path.join(root, 'liveness', id + '.json');
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    fs.writeFileSync(lp, JSON.stringify(opts.verdict));
  }
  // Age the descriptor so the grace conjunct is satisfied. `descriptorAgeMs: 0`
  // keeps it brand-new, which is the "just spawned, not yet listed" case.
  const ageMs = opts.descriptorAgeMs != null ? opts.descriptorAgeMs : 3 * 60 * 60 * 1000;
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(descPath, t, t);
}

// Cache an ACTIVE set for `key` that does NOT contain the row under test — the
// app archived it. A snapshot must be non-empty to be usable at all, so an
// unrelated live workspace always stands in for "the app is still reporting".
function writeCache(home, key, ageMs) {
  cacheLib.writeActiveCache({
    home,
    byRepoKey: { [key]: [{ id: 'ws-still-live', worktreePath: '/somewhere/.devswarm/repos/1/zz/live' }] },
    now: Date.now() - (ageMs || 0),
  });
}

test('NEGATIVE CONTROL: an escalated row with NO cache still blocks', () => {
  const h = makeHome();
  const a = makeAppWorktree();
  try {
    seedWorkspace(h.home, 'ws1', { worktreePath: a.wt, verdict: { status: 'escalated', pending: true } });
    const r = run(h.home, a.wt);
    assert.strictEqual(r.json && r.json.decision, 'block', `stdout=${r.stdout}`);
    assert.match(r.json.reason, /escalated/);
  } finally { a.cleanup(); h.cleanup(); }
});

test('a row ABSENT from a FRESH active set no longer blocks', () => {
  const h = makeHome();
  const a = makeAppWorktree();
  try {
    seedWorkspace(h.home, 'ws1', { worktreePath: a.wt, verdict: { status: 'escalated', pending: true } });
    writeCache(h.home, a.key, 60_000);
    const r = run(h.home, a.wt);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json, null, `the app no longer lists this workspace; stdout=${r.stdout}`);
  } finally { a.cleanup(); h.cleanup(); }
});

test('a row PRESENT in the active set still blocks', () => {
  const h = makeHome();
  const a = makeAppWorktree();
  try {
    seedWorkspace(h.home, 'ws1', { worktreePath: a.wt, verdict: { status: 'escalated', pending: true } });
    cacheLib.writeActiveCache({ home: h.home, byRepoKey: { [a.key]: [{ id: 'ws1', worktreePath: a.wt }] }, now: Date.now() });
    const r = run(h.home, a.wt);
    assert.strictEqual(r.json && r.json.decision, 'block', `stdout=${r.stdout}`);
  } finally { a.cleanup(); h.cleanup(); }
});

test('GRACE: a row registered AFTER the snapshot still blocks', () => {
  const h = makeHome();
  const a = makeAppWorktree();
  try {
    // Brand-new descriptor: absent from the snapshot because it did not exist
    // when the snapshot was taken, not because anyone archived it.
    seedWorkspace(h.home, 'ws1', {
      worktreePath: a.wt, verdict: { status: 'escalated', pending: true }, descriptorAgeMs: 0,
    });
    writeCache(h.home, a.key, 60_000);
    const r = run(h.home, a.wt);
    assert.strictEqual(r.json && r.json.decision, 'block',
      `a just-registered row must never be read as archived; stdout=${r.stdout}`);
  } finally { a.cleanup(); h.cleanup(); }
});

test('REPOS ROOT: a row outside `.devswarm/repos/` is never app-archived', () => {
  const h = makeHome();
  try {
    // The anti-hall checkout itself — the Primary's own row. It was never a
    // DevSwarm workspace, so its absence from the app's list means nothing.
    seedWorkspace(h.home, 'ws1', { worktreePath: REPO_CWD, verdict: { status: 'escalated', pending: true } });
    writeCache(h.home, REPO_KEY, 60_000);
    const r = run(h.home, REPO_CWD);
    assert.strictEqual(r.json && r.json.decision, 'block', `stdout=${r.stdout}`);
  } finally { h.cleanup(); }
});

test('a STALE cache changes NOTHING (today\'s behavior is preserved)', () => {
  const h = makeHome();
  const a = makeAppWorktree();
  try {
    seedWorkspace(h.home, 'ws1', { worktreePath: a.wt, verdict: { status: 'escalated', pending: true } });
    writeCache(h.home, a.key, cacheLib.resolveArchivedCacheMaxAgeMs({}) + 60_000);
    const r = run(h.home, a.wt);
    assert.strictEqual(r.json && r.json.decision, 'block',
      `a stale snapshot must never suppress; stdout=${r.stdout}`);
  } finally { a.cleanup(); h.cleanup(); }
});

test('a fresh cache under ANOTHER project\'s repoKey does not suppress', () => {
  const h = makeHome();
  const a = makeAppWorktree();
  try {
    seedWorkspace(h.home, 'ws1', { worktreePath: a.wt, verdict: { status: 'escalated', pending: true } });
    writeCache(h.home, 'some-other-repo', 60_000);
    const r = run(h.home, a.wt);
    assert.strictEqual(r.json && r.json.decision, 'block');
  } finally { a.cleanup(); h.cleanup(); }
});

test('LIVENESS AXIS ONLY: app-archived + REAL unread STILL blocks', () => {
  const h = makeHome();
  const a = makeAppWorktree();
  try {
    seedWorkspace(h.home, 'ws1', {
      worktreePath: a.wt,
      verdict: { status: 'escalated', pending: true },
      messages: ['a real message from the child that still needs an answer'],
      cursor: 0,
    });
    writeCache(h.home, a.key, 60_000);
    const r = run(h.home, a.wt);
    assert.strictEqual(r.json && r.json.decision, 'block',
      `unread is a DIFFERENT axis; archiving does not answer mail. stdout=${r.stdout}`);
  } finally { a.cleanup(); h.cleanup(); }
});

test('a MALFORMED cache is ignored, and the hook still runs', () => {
  const h = makeHome();
  const a = makeAppWorktree();
  try {
    seedWorkspace(h.home, 'ws1', { worktreePath: a.wt, verdict: { status: 'escalated', pending: true } });
    const p = cacheLib.cachePath(h.home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{ this is not json');
    const r = run(h.home, a.wt);
    assert.strictEqual(r.json && r.json.decision, 'block');
  } finally { a.cleanup(); h.cleanup(); }
});
