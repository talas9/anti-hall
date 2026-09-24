'use strict';
// devswarm-parent-inbox.js — item 4b (P0, field-proven): a child session
// auto-resumed BEFORE the harness re-registered a newer anti-hall build keeps
// running the OLD build (0.105.3 is NDJSON-only and cannot see store-side
// mesh mail), so the Primary saw it as "not-draining" when the real cause is
// a stale build with a totally different remedy (restart, not poke/escalate).
//
// The roster table and the parent-inbox nag now show "stale anti-hall <v>:
// restart this session (or drain with `<newest CLI path>`)" INSTEAD OF
// "not-draining" for a workspace whose heartbeat-recorded anti-hall version
// (item 4a) is older than the newest one registered/cached on this machine.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const { heartbeatPathFor } = require('../../plugins/anti-hall/companion/lib/liveness.js');

const HOOK = 'devswarm-parent-inbox.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);

function payload() { return { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: REPO_CWD }; }
function ctx(r) { return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || ''; }
function segment(c, banner) { return c.split('\n\n').find((s) => s.startsWith(banner)) || ''; }
function tableSeg(c) { return segment(c, 'DEVSWARM WORKSPACES'); }
function tableRow(c, id) { return tableSeg(c).split('\n').find((l) => l.startsWith('| ' + id + ' ')) || ''; }

function swarmDir(home) {
  const d = path.join(home, '.anti-hall', 'devswarm');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function wsEntry(overrides) {
  return Object.assign({
    worktreePath: REPO_CWD,
    sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null,
    total: 0, cursor: 0, unread: 0, directUnread: 0,
    broadcastUnread: 0, urgencyMax: null, working_on: null,
    gates: {}, archive_ready: false,
  }, overrides || {});
}
function writeSharedSummary(home, workspacesRaw) {
  const dir = path.join(swarmDir(home), 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  const workspaces = {};
  for (const id of Object.keys(workspacesRaw || {})) workspaces[id] = wsEntry(workspacesRaw[id]);
  const obj = { generatedAt: Date.now(), requiredGates: [], workspaces, recent: [], archivedRegistryRows: [] };
  fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), JSON.stringify(obj));
}
function writeVerdict(home, id, verdict) {
  const p = path.join(swarmDir(home), 'liveness', id + '.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(verdict));
}
function writeHeartbeatVersion(home, id, version) {
  const p = heartbeatPathFor(id, home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ id, ts: Date.now(), state_ts: Date.now(), version }));
}
// Lays out ~/.claude/plugins/{installed_plugins.json, cache/anti-hall/anti-hall/<v>/}
// under this fixture's isolated HOME so versionCheck.newestKnownAntiHallVersion
// resolves deterministically instead of reading the real machine's registry.
function layoutNewestVersion(home, version) {
  const pluginsRoot = path.join(home, '.claude', 'plugins');
  fs.mkdirSync(path.join(pluginsRoot, 'marketplaces', 'anti-hall'), { recursive: true });
  fs.mkdirSync(path.join(pluginsRoot, 'cache', 'anti-hall', 'anti-hall', version), { recursive: true });
  fs.writeFileSync(path.join(pluginsRoot, 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'anti-hall@anti-hall': [{ scope: 'user', version }] } }), 'utf8');
}

test('roster + nag: a notDraining workspace on a STALE anti-hall build shows "stale anti-hall <v>" instead of not-draining', () => {
  const h = makeHome();
  try {
    layoutNewestVersion(h.home, '0.107.1');
    writeSharedSummary(h.home, { wsStale: { total: 1, cursor: 0, unread: 1, directUnread: 1 } });
    writeVerdict(h.home, 'wsStale', { notDraining: true });
    writeHeartbeatVersion(h.home, 'wsStale', '0.105.3');

    const r = testHook(HOOK, payload(), { env: PRIMARY_ENV, home: h.home });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    assert.doesNotMatch(tableRow(c, 'wsStale'), /not-draining/,
      'the roster row must NOT show not-draining once a stale build is detected:\n' + c);
    assert.match(tableRow(c, 'wsStale'), /stale anti-hall 0\.105\.3/, 'the roster row must name the stale version:\n' + c);
    assert.match(c, /stale anti-hall 0\.105\.3: restart this session \(or drain with `node .*devswarm\.js`\)/,
      'the nag segment must carry the full restart/drain guidance:\n' + c);
    assert.doesNotMatch(c, /NOT DRAINING >20m/, 'must not ALSO show the generic not-draining tag:\n' + c);
  } finally { h.cleanup(); }
});

test('roster + nag: a notDraining workspace with NO recorded version (legacy heartbeat) still shows plain not-draining', () => {
  const h = makeHome();
  try {
    layoutNewestVersion(h.home, '0.107.1');
    writeSharedSummary(h.home, { wsLegacy: { total: 1, cursor: 0, unread: 1, directUnread: 1 } });
    writeVerdict(h.home, 'wsLegacy', { notDraining: true });
    // No heartbeat file at all -> heartbeatVersion() returns null -> never stale.

    const r = testHook(HOOK, payload(), { env: PRIMARY_ENV, home: h.home });
    const c = ctx(r);
    assert.match(tableRow(c, 'wsLegacy'), /not-draining/, 'a legacy/unknown-version row keeps the plain label:\n' + c);
    assert.doesNotMatch(c, /stale anti-hall/, c);
  } finally { h.cleanup(); }
});

test('roster + nag: a notDraining workspace already CURRENT (same version as newest) stays plain not-draining', () => {
  const h = makeHome();
  try {
    layoutNewestVersion(h.home, '0.107.1');
    writeSharedSummary(h.home, { wsCurrent: { total: 1, cursor: 0, unread: 1, directUnread: 1 } });
    writeVerdict(h.home, 'wsCurrent', { notDraining: true });
    writeHeartbeatVersion(h.home, 'wsCurrent', '0.107.1');

    const r = testHook(HOOK, payload(), { env: PRIMARY_ENV, home: h.home });
    const c = ctx(r);
    assert.match(tableRow(c, 'wsCurrent'), /not-draining/, c);
    assert.doesNotMatch(c, /stale anti-hall/, c);
  } finally { h.cleanup(); }
});

test('roster + nag: a notDraining workspace AHEAD of everything known never flags stale (never regress)', () => {
  const h = makeHome();
  try {
    layoutNewestVersion(h.home, '0.107.1');
    writeSharedSummary(h.home, { wsAhead: { total: 1, cursor: 0, unread: 1, directUnread: 1 } });
    writeVerdict(h.home, 'wsAhead', { notDraining: true });
    writeHeartbeatVersion(h.home, 'wsAhead', '9.9.9');

    const r = testHook(HOOK, payload(), { env: PRIMARY_ENV, home: h.home });
    const c = ctx(r);
    assert.match(tableRow(c, 'wsAhead'), /not-draining/, c);
    assert.doesNotMatch(c, /stale anti-hall/, c);
  } finally { h.cleanup(); }
});

test('roster: a workspace NOT notDraining never shows a stale-build label even on an old build (only overrides not-draining)', () => {
  const h = makeHome();
  try {
    layoutNewestVersion(h.home, '0.107.1');
    // No verdict at all -> notDraining stays false; the row is healthy/quiet.
    writeSharedSummary(h.home, { wsQuiet: { total: 0, cursor: 0, unread: 0, directUnread: 0 } });
    writeHeartbeatVersion(h.home, 'wsQuiet', '0.105.3');

    const r = testHook(HOOK, payload(), { env: PRIMARY_ENV, home: h.home });
    const c = ctx(r);
    assert.doesNotMatch(c, /stale anti-hall/, 'a healthy/quiet row must not be flagged just for running an old build:\n' + c);
  } finally { h.cleanup(); }
});
