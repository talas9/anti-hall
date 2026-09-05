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
//   M1: delete the `if (appArchived) staleOrEscalated = false;` block
//       -> kills "a FRESH app-archived row no longer blocks".
//   M2: drop the freshness bound (devswarm-archived-cache.js `fresh = true`)
//       -> kills "a STALE cache changes NOTHING".
//   M3: let appArchived also zero realUnread
//       -> kills "app-archived + REAL unread STILL blocks".

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const cacheLib = require('../../plugins/anti-hall/companion/lib/devswarm-archived-cache.js');

const HOOK = 'devswarm-parent-gate.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);

function run(home, env) {
  return testHookRaw(HOOK, JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-1' }), {
    home, env: { ...PRIMARY_ENV, ...(env || {}) },
  });
}

// The descriptor's worktreePath must resolve to THIS repo's key, or the hook's
// structural cross-project filter drops the row before any of this runs.
function seedWorkspace(home, id, opts = {}) {
  const root = path.join(home, '.anti-hall', 'devswarm');
  const wsDir = path.join(root, 'workspaces');
  const inboxPath = path.join(root, 'inbox', id + '.ndjson');
  const cursorPath = path.join(root, 'cursor', id + '.json');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(path.join(wsDir, id + '.json'), JSON.stringify({
    id, worktreePath: REPO_CWD, sessionId: 'child-' + id, inboxPath, cursorPath,
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
}

function writeCache(home, ids, ageMs) {
  cacheLib.writeArchivedCache({ home, byRepoKey: { [REPO_KEY]: ids }, now: Date.now() - (ageMs || 0) });
}

test('NEGATIVE CONTROL: an escalated row with NO cache still blocks', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { verdict: { status: 'escalated', pending: true } });
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block', `stdout=${r.stdout}`);
    assert.match(r.json.reason, /escalated/);
  } finally { h.cleanup(); }
});

test('a FRESH app-archived row no longer blocks', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { verdict: { status: 'escalated', pending: true } });
    writeCache(h.home, ['ws1'], 60_000);
    const r = run(h.home);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json, null, `the app says this workspace is archived; stdout=${r.stdout}`);
  } finally { h.cleanup(); }
});

test('a STALE cache changes NOTHING (today\'s behavior is preserved)', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { verdict: { status: 'escalated', pending: true } });
    writeCache(h.home, ['ws1'], cacheLib.resolveArchivedCacheMaxAgeMs({}) + 60_000);
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block',
      `a stale snapshot must never suppress; stdout=${r.stdout}`);
  } finally { h.cleanup(); }
});

test('a fresh cache listing a DIFFERENT id does not suppress this one', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { verdict: { status: 'escalated', pending: true } });
    writeCache(h.home, ['someone-else'], 60_000);
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block');
  } finally { h.cleanup(); }
});

test('a fresh cache under ANOTHER project\'s repoKey does not suppress', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { verdict: { status: 'escalated', pending: true } });
    cacheLib.writeArchivedCache({ home: h.home, byRepoKey: { 'some-other-repo': ['ws1'] }, now: Date.now() });
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block');
  } finally { h.cleanup(); }
});

test('LIVENESS AXIS ONLY: app-archived + REAL unread STILL blocks', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', {
      verdict: { status: 'escalated', pending: true },
      messages: ['a real message from the child that still needs an answer'],
      cursor: 0,
    });
    writeCache(h.home, ['ws1'], 60_000);
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block',
      `unread is a DIFFERENT axis; archiving does not answer mail. stdout=${r.stdout}`);
  } finally { h.cleanup(); }
});

test('a MALFORMED cache is ignored, and the hook still runs', () => {
  const h = makeHome();
  try {
    seedWorkspace(h.home, 'ws1', { verdict: { status: 'escalated', pending: true } });
    const p = cacheLib.archivedCachePath(h.home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{ this is not json');
    const r = run(h.home);
    assert.strictEqual(r.json && r.json.decision, 'block');
  } finally { h.cleanup(); }
});
