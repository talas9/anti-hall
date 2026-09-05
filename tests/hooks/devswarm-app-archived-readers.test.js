'use strict';
// APP-SIDE archive detection — the OTHER two readers (the parent Stop gate has
// its own file, tests/hooks/devswarm-parent-gate-app-archived.test.js):
//
//   * hooks/devswarm-parent-inbox.js — the per-turn DEVSWARM WORKSPACES table.
//   * scripts/devswarm.js cmdRoster  — the `archived` row hint.
//
// FIELD ROOT CAUSE: the owner archived children in the DevSwarm app, which
// never writes anti-hall's own archived/<id>.json — so both surfaces kept
// rendering those rows as escalated. Both now derive "archived" by ABSENCE from
// the supervisor-written ACTIVE-set cache: the app's `workspace list all`
// carries no archive field of any name (measured, hivecontrol 2.5.1), it simply
// stops listing an archived workspace.
//
// No hivecontrol process is ever spawned by these tests: the cache file is
// written directly, exactly as the supervisor writes it.
//
// MUTATION LIST (proven RED against this file):
//   M1: drop the appArchived consult in devswarm-parent-inbox.js -> kills the
//       'archived' label test.
//   M2: drop the `opts.repoKey` branch in rosterHints -> kills the roster hint test.
//   M3: drop the freshness bound -> kills both STALE tests.
//   M4: drop the repos-root conjunct -> kills the "a row outside the repos root"
//       test on BOTH surfaces.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const cacheLib = require('../../plugins/anti-hall/companion/lib/devswarm-archived-cache.js');

const HOOK = 'devswarm-parent-inbox.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);

function writeSummary(home, workspaces) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), JSON.stringify({
    generatedAt: Date.now(), requiredGates: [], workspaces, recent: [],
  }));
}
function writeVerdict(home, id, verdict) {
  const p = path.join(home, '.anti-hall', 'devswarm', 'liveness', id + '.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(verdict));
}
function wsEntry(overrides) {
  return Object.assign({
    worktreePath: REPO_CWD, sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null,
    total: 0, cursor: 0, unread: 0, directUnread: 0, broadcastUnread: 0, urgencyMax: null,
    working_on: null, gates: {}, archive_ready: false,
  }, overrides || {});
}
// APP_WT — a REAL directory under a DevSwarm-shaped repos root, created inside
// the test home. The repos-root conjunct is a genuine part of the rule, so a row
// under the Primary's own checkout (REPO_CWD) can no longer stand in for a
// managed workspace; these tests use both, deliberately.
function appWorktree(home, slug) {
  const p = path.join(home, '.devswarm', 'repos', '1', 'aa', slug || 'child');
  fs.mkdirSync(p, { recursive: true });
  return p;
}
// The row's age source: its registry descriptor's mtime. Stamped OLD so the
// grace conjunct is satisfied (a just-registered row is deliberately immune).
function seedDescriptorAge(home, id, worktreePath, ageMs) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, id + '.json');
  fs.writeFileSync(p, JSON.stringify({ id, worktreePath, sessionId: 's1' }));
  const t = new Date(Date.now() - (ageMs == null ? 3 * 60 * 60 * 1000 : ageMs));
  fs.utimesSync(p, t, t);
}
// Cache an ACTIVE set that does NOT contain `id` — i.e. the app archived it.
// A non-empty snapshot is required (an empty one is refused by the writer), so
// an unrelated live workspace always stands in for "the app is still reporting".
function writeCache(home, absentIds, ageMs) {
  cacheLib.writeActiveCache({
    home,
    byRepoKey: { [REPO_KEY]: [{ id: 'ws-still-live', worktreePath: path.join(home, '.devswarm', 'repos', '1', 'zz', 'live') }] },
    now: Date.now() - (ageMs || 0),
  });
  return absentIds;
}
function tableRow(r, id) {
  const c = (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
  const seg = c.split('\n\n').find((s) => s.startsWith('DEVSWARM WORKSPACES')) || '';
  return seg.split('\n').find((l) => l.startsWith('| ' + id + ' ')) || '';
}
function runInbox(home) {
  return testHook(HOOK, { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: REPO_CWD },
    { home, env: PRIMARY_ENV, expectJson: true });
}

// --- per-turn workspace table ---------------------------------------------

test('TABLE: an escalated row with NO cache still renders escalated (negative control)', () => {
  const h = makeHome();
  try {
    const wt = appWorktree(h.home);
    writeSummary(h.home, { wsA: wsEntry({ worktreePath: wt }) });
    seedDescriptorAge(h.home, 'wsA', wt);
    writeVerdict(h.home, 'wsA', { status: 'escalated' });
    assert.match(tableRow(runInbox(h.home), 'wsA'), /escalated/);
  } finally { h.cleanup(); }
});

test('TABLE: a row ABSENT from a FRESH active set renders `archived`, not escalated', () => {
  const h = makeHome();
  try {
    const wt = appWorktree(h.home);
    writeSummary(h.home, { wsA: wsEntry({ worktreePath: wt }) });
    seedDescriptorAge(h.home, 'wsA', wt);
    writeVerdict(h.home, 'wsA', { status: 'escalated' });
    writeCache(h.home, ['wsA'], 60_000);
    const row = tableRow(runInbox(h.home), 'wsA');
    assert.match(row, /archived/);
    assert.doesNotMatch(row, /escalated/);
  } finally { h.cleanup(); }
});

test('TABLE: a row PRESENT in the active set stays escalated', () => {
  const h = makeHome();
  try {
    const wt = appWorktree(h.home);
    writeSummary(h.home, { wsA: wsEntry({ worktreePath: wt }) });
    seedDescriptorAge(h.home, 'wsA', wt);
    writeVerdict(h.home, 'wsA', { status: 'escalated' });
    cacheLib.writeActiveCache({ home: h.home, byRepoKey: { [REPO_KEY]: [{ id: 'wsA', worktreePath: wt }] }, now: Date.now() });
    assert.match(tableRow(runInbox(h.home), 'wsA'), /escalated/);
  } finally { h.cleanup(); }
});

test('TABLE M4: a row OUTSIDE the DevSwarm repos root is never app-archived', () => {
  const h = makeHome();
  try {
    // REPO_CWD is the Primary's own checkout — the app never managed it, so its
    // absence from `workspace list all` carries no archive meaning.
    writeSummary(h.home, { wsA: wsEntry({ worktreePath: REPO_CWD }) });
    seedDescriptorAge(h.home, 'wsA', REPO_CWD);
    writeVerdict(h.home, 'wsA', { status: 'escalated' });
    writeCache(h.home, ['wsA'], 60_000);
    assert.match(tableRow(runInbox(h.home), 'wsA'), /escalated/);
  } finally { h.cleanup(); }
});

test('TABLE: a STALE cache changes nothing', () => {
  const h = makeHome();
  try {
    const wt = appWorktree(h.home);
    writeSummary(h.home, { wsA: wsEntry({ worktreePath: wt }) });
    seedDescriptorAge(h.home, 'wsA', wt);
    writeVerdict(h.home, 'wsA', { status: 'escalated' });
    writeCache(h.home, ['wsA'], cacheLib.resolveArchivedCacheMaxAgeMs({}) + 60_000);
    assert.match(tableRow(runInbox(h.home), 'wsA'), /escalated/);
  } finally { h.cleanup(); }
});

test('TABLE: LIVENESS AXIS ONLY — not-draining still outranks an app-archived row', () => {
  const h = makeHome();
  try {
    const wt = appWorktree(h.home);
    writeSummary(h.home, { wsA: wsEntry({ worktreePath: wt, total: 3, cursor: 0, unread: 3, directUnread: 3 }) });
    seedDescriptorAge(h.home, 'wsA', wt);
    writeVerdict(h.home, 'wsA', { status: 'escalated', notDraining: true });
    writeCache(h.home, ['wsA'], 60_000);
    const row = tableRow(runInbox(h.home), 'wsA');
    assert.match(row, /not-draining/,
      'archiving answers the liveness axis, never a real aging backlog');
  } finally { h.cleanup(); }
});

// --- roster ---------------------------------------------------------------

function rosterHome(worktreePath) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-app-archived-'));
  const wt = worktreePath || appWorktree(home);
  const s = store.openStore({ home, workspaceId: 'ws1', hash: REPO_KEY });
  try { s.upsertRegistry({ id: 'ws1', worktreePath: wt, sessionId: 's1' }); } finally { s.close(); }
  seedDescriptorAge(home, 'ws1', wt);
  return { home, wt, cleanup() { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}
function rosterHints(home, id) {
  const { result } = cli.run(['roster'], { home, env: {}, cwd: REPO_CWD });
  const w = (result.workspaces || []).find((x) => x.id === id);
  return (w && w.hints) || null;
}

test('ROSTER: a workspace ABSENT from a FRESH active set is hinted `archived`', () => {
  const h = rosterHome();
  try {
    assert.deepStrictEqual(rosterHints(h.home, 'ws1'), [], 'no cache -> no archived hint (control)');
    writeCache(h.home, ['ws1'], 60_000);
    assert.deepStrictEqual(rosterHints(h.home, 'ws1'), ['archived']);
  } finally { h.cleanup(); }
});

test('ROSTER: a workspace PRESENT in the active set gets no archived hint', () => {
  const h = rosterHome();
  try {
    cacheLib.writeActiveCache({ home: h.home, byRepoKey: { [REPO_KEY]: [{ id: 'ws1', worktreePath: h.wt }] }, now: Date.now() });
    assert.deepStrictEqual(rosterHints(h.home, 'ws1'), []);
  } finally { h.cleanup(); }
});

test('ROSTER M4: a workspace OUTSIDE the DevSwarm repos root is never app-archived', () => {
  const h = rosterHome(REPO_CWD);
  try {
    writeCache(h.home, ['ws1'], 60_000);
    assert.deepStrictEqual(rosterHints(h.home, 'ws1'), []);
  } finally { h.cleanup(); }
});

test('ROSTER: a STALE cache adds no hint', () => {
  const h = rosterHome();
  try {
    writeCache(h.home, ['ws1'], cacheLib.resolveArchivedCacheMaxAgeMs({}) + 60_000);
    assert.deepStrictEqual(rosterHints(h.home, 'ws1'), []);
  } finally { h.cleanup(); }
});

test('ROSTER: another project\'s entry never leaks in', () => {
  const h = rosterHome();
  try {
    cacheLib.writeActiveCache({ home: h.home, byRepoKey: { 'some-other-repo': [{ id: 'other', worktreePath: '/w/other' }] }, now: Date.now() });
    assert.deepStrictEqual(rosterHints(h.home, 'ws1'), []);
  } finally { h.cleanup(); }
});
