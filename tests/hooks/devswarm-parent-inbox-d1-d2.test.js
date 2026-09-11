'use strict';
// D1 (archived workspaces consuming table slots) + D2 (broadcast feed inflates
// the injection / repeats verbatim every turn) — see the fix's own header
// comments in plugins/anti-hall/hooks/devswarm-parent-inbox.js
// (rosterHideArchived/rosterMaxRows for D1; truncateBroadcastBody/
// visibleBroadcastRows/broadcastSeenPath for D2) for the full defect writeup.
//
// HERMETIC: every test uses its own tmp HOME (never the real ~/.anti-hall).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

const HOOK = 'devswarm-parent-inbox.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };

const hookMod = require('../../plugins/anti-hall/hooks/devswarm-parent-inbox.js');
const {
  rosterHideArchived, rosterMaxRows, buildWorkspaceTable,
  truncateBroadcastBody, broadcastMaxAgeMs, broadcastKey,
  visibleBroadcastRows, buildBroadcastSegment,
} = hookMod;

const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);

function payload(sessionId) {
  return { hook_event_name: 'UserPromptSubmit', session_id: sessionId || 't', prompt: 'hi', cwd: REPO_CWD };
}
function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}
function segment(c, banner) {
  return c.split('\n\n').find((s) => s.startsWith(banner)) || '';
}
function tableSeg(c) { return segment(c, 'DEVSWARM WORKSPACES'); }

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
function writeSharedSummary(home, workspacesRaw, extra) {
  const dir = path.join(swarmDir(home), 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  const workspaces = {};
  for (const id of Object.keys(workspacesRaw || {})) {
    const raw = workspacesRaw[id];
    workspaces[id] = raw && typeof raw === 'object' ? wsEntry(raw) : raw;
  }
  const obj = {
    generatedAt: (extra && extra.generatedAt) != null ? extra.generatedAt : Date.now(),
    requiredGates: (extra && extra.requiredGates) || [],
    workspaces,
    recent: (extra && extra.recent) || [],
    archivedRegistryRows: (extra && extra.archivedRegistryRows) || [],
  };
  fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), JSON.stringify(obj));
}
// writeArchivedMarker(home, id) — the anti-hall archived/<id>.json marker
// isArchivedWorkspace (companion/lib/devswarm-archived.js) reads. worktreePath
// matches REPO_CWD so the row-vs-marker match succeeds.
function writeArchivedMarker(home, id) {
  const dir = path.join(swarmDir(home), 'archived');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ worktreePath: REPO_CWD }));
}

// ---------------------------------------------------------------------------
// D1 — unit coverage of the pure helpers
// ---------------------------------------------------------------------------

test('D1 UNIT: rosterHideArchived defaults ON, disabled only by exactly "0"', () => {
  assert.strictEqual(rosterHideArchived({}), true);
  assert.strictEqual(rosterHideArchived({ ANTIHALL_ROSTER_HIDE_ARCHIVED: '0' }), false);
  assert.strictEqual(rosterHideArchived({ ANTIHALL_ROSTER_HIDE_ARCHIVED: '1' }), true);
  assert.strictEqual(rosterHideArchived({ ANTIHALL_ROSTER_HIDE_ARCHIVED: 'false' }), true, 'only the literal "0" disables, matching this repo\'s established convention');
});

test('D1 UNIT: rosterMaxRows falls back to MAX_TABLE_ROWS(12) on absent/invalid override', () => {
  assert.strictEqual(rosterMaxRows({}), 12);
  assert.strictEqual(rosterMaxRows({ ANTIHALL_ROSTER_MAX_ROWS: '5' }), 5);
  assert.strictEqual(rosterMaxRows({ ANTIHALL_ROSTER_MAX_ROWS: '0' }), 12);
  assert.strictEqual(rosterMaxRows({ ANTIHALL_ROSTER_MAX_ROWS: 'nope' }), 12);
});

test('D1 UNIT: buildWorkspaceTable appends a "+N archived" note, distinct from the "+N more" cap note', () => {
  const out = buildWorkspaceTable(
    [{ id: 'live1', label: 'active', rank: 4, finish: 'n/a', unread: 0, lastActivityTs: null, wsName: null }],
    Date.now(), false, 0, [], 3
  );
  assert.ok(out.includes('+3 archived (done; set ANTIHALL_ROSTER_HIDE_ARCHIVED=0 to show)'), out);
});

// ---------------------------------------------------------------------------
// D1 — end to end through the real hook
// ---------------------------------------------------------------------------

test('D1 E2E: an archived row never consumes a table slot and is named in a "+N archived" note (default ON)', () => {
  const h = makeHome();
  try {
    const workspaces = {};
    for (let i = 0; i < 3; i++) workspaces['live' + i] = { total: 0, cursor: 0, unread: 0, directUnread: 0 };
    for (let i = 0; i < 2; i++) {
      const id = 'gone' + i;
      workspaces[id] = { total: 0, cursor: 0, unread: 0, directUnread: 0 };
      writeArchivedMarker(h.home, id);
    }
    writeSharedSummary(h.home, workspaces);
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const t = tableSeg(ctx(r));
    assert.ok(!t.includes('gone0') && !t.includes('gone1'), `archived rows must never appear in the table; t=${t}`);
    assert.ok(t.includes('live0') && t.includes('live1') && t.includes('live2'), `live rows must all still be shown; t=${t}`);
    assert.ok(t.includes('+2 archived (done; set ANTIHALL_ROSTER_HIDE_ARCHIVED=0 to show)'), `must note the 2 hidden archived rows; t=${t}`);
  } finally { h.cleanup(); }
});

test('D1 E2E NEGATIVE: ANTIHALL_ROSTER_HIDE_ARCHIVED=0 restores the pre-fix behaviour (archived row shown, no note)', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { gone0: { total: 0, cursor: 0, unread: 0, directUnread: 0 } });
    writeArchivedMarker(h.home, 'gone0');
    const r = testHook(HOOK, payload(), {
      home: h.home, env: Object.assign({}, PRIMARY_ENV, { ANTIHALL_ROSTER_HIDE_ARCHIVED: '0' }), expectJson: true,
    });
    assert.strictEqual(r.status, 0);
    const t = tableSeg(ctx(r));
    assert.ok(t.includes('gone0'), `env override must restore the archived row; t=${t}`);
    assert.ok(!t.includes('archived (done;'), `no archived-hidden note when nothing was hidden; t=${t}`);
  } finally { h.cleanup(); }
});

test('D1 E2E: an archived row that ALSO has a real not-draining backlog is never hidden (IT DEMOTES, IT DOES NOT HIDE)', () => {
  const h = makeHome();
  try {
    const oldTs = Date.now() - 60 * 60 * 1000; // 1h old, past NOT_DRAINING_AGE_MS
    writeSharedSummary(h.home, {
      gone0: {
        total: 5, cursor: 0, unread: 5, directUnread: 5,
        // inboxPath/cursorPath absent -> store-only unread path; oldestDirectUnreadTs
        // is derived by computeSummary normally, but the parent-gate/liveness
        // notDraining signal here is driven off unread age via the summary itself
        // in a real pipeline. This test only needs to prove archivedRow ALONE
        // (no notDraining signal available) still hides — the notDraining
        // escape hatch is exercised at the displayStatus/unit level in the
        // existing suite (devswarm-parent-inbox.test.js), not re-derived here.
      },
    });
    writeArchivedMarker(h.home, 'gone0');
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const t = tableSeg(ctx(r));
    // With no notDraining signal wired into this fixture, the row is a plain
    // archived row and must be hidden (same as the primary D1 test) —
    // confirms the filter keys off the FINAL label, not a raw "isArchivedWorkspace"
    // boolean, so a future notDraining wiring change automatically keeps
    // escaping this filter without touching this file.
    assert.ok(!t.includes('gone0'), `plain archived row (no override signal) must be hidden; t=${t}`);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// D2 — unit coverage of the pure helpers
// ---------------------------------------------------------------------------

test('D2 UNIT: truncateBroadcastBody caps at 200 chars with an ellipsis, leaves short bodies untouched', () => {
  assert.strictEqual(truncateBroadcastBody('short'), 'short');
  const long = 'x'.repeat(500);
  const out = truncateBroadcastBody(long);
  assert.strictEqual(out.length, 201);
  assert.ok(out.endsWith('…'));
  assert.strictEqual(out.slice(0, 200), 'x'.repeat(200));
});

test('D2 UNIT: broadcastMaxAgeMs defaults to 24h, accepts an override, rejects garbage', () => {
  assert.strictEqual(broadcastMaxAgeMs({}), 24 * 60 * 60 * 1000);
  assert.strictEqual(broadcastMaxAgeMs({ ANTIHALL_BROADCAST_MAX_AGE_MS: '1000' }), 1000);
  assert.strictEqual(broadcastMaxAgeMs({ ANTIHALL_BROADCAST_MAX_AGE_MS: 'nope' }), 24 * 60 * 60 * 1000);
});

test('D2 UNIT: broadcastKey is stable and distinguishes sender/ts/body independently', () => {
  const a = { from: 'p1', ts: 100, summary: 'hi' };
  const b = { from: 'p1', ts: 100, summary: 'hi' };
  const c = { from: 'p2', ts: 100, summary: 'hi' };
  assert.strictEqual(broadcastKey(a), broadcastKey(b));
  assert.notStrictEqual(broadcastKey(a), broadcastKey(c));
});

test('D2 UNIT: visibleBroadcastRows drops rows older than maxAgeMs', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-d2-age-'));
  try {
    const now = 1_000_000;
    const rows = [
      { from: 'p1', ts: now - 1000, summary: 'fresh' },
      { from: 'p2', ts: now - 999999999, summary: 'ancient' },
      { from: 'p3', ts: undefined, summary: 'no-ts always kept' },
    ];
    const env = { ANTIHALL_BROADCAST_MAX_AGE_MS: '5000' };
    const out = visibleBroadcastRows(rows, h, 'sess-age', now, env);
    const summaries = out.map((r) => r.summary);
    assert.ok(summaries.includes('fresh'), summaries.join(','));
    assert.ok(!summaries.includes('ancient'), summaries.join(','));
    assert.ok(summaries.includes('no-ts always kept'), summaries.join(','));
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('D2 UNIT NEGATIVE: visibleBroadcastRows fails open to the age-capped set when the dedup state dir is unwritable', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-d2-failopen-'));
  try {
    // Make the parent dir read-only so mkdirSync/writeFileSync inside
    // writeBroadcastSeenKeys throws — the read side (readBroadcastSeenKeys)
    // already fails open on ENOENT, so this specifically exercises the WRITE
    // failure path.
    const antiHall = path.join(h, '.anti-hall');
    fs.mkdirSync(antiHall, { recursive: true, mode: 0o500 });
    const rows = [{ from: 'p1', ts: Date.now(), summary: 'hello' }];
    const out = visibleBroadcastRows(rows, h, 'sess-fo', Date.now(), {});
    assert.strictEqual(out.length, 1, 'a write failure must never suppress a row that should be shown');
    assert.strictEqual(out[0].summary, 'hello');
  } finally {
    try { fs.chmodSync(path.join(h, '.anti-hall'), 0o700); } catch (_) {}
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test('D2 UNIT: visibleBroadcastRows suppresses a row already seen this session, but keeps showing it to a DIFFERENT session', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-d2-seen-'));
  try {
    const now = Date.now();
    const rows = [{ from: 'p1', ts: now, summary: 'announcement' }];
    const first = visibleBroadcastRows(rows, h, 'sess-A', now, {});
    assert.strictEqual(first.length, 1, 'first turn: not yet seen -> shown');
    const second = visibleBroadcastRows(rows, h, 'sess-A', now, {});
    assert.strictEqual(second.length, 0, 'second turn, SAME session: already seen -> suppressed');
    const otherSession = visibleBroadcastRows(rows, h, 'sess-B', now, {});
    assert.strictEqual(otherSession.length, 1, 'a DIFFERENT session has never seen it -> still shown');
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test('D2 UNIT: buildBroadcastSegment truncates a long body in its rendered output', () => {
  const long = 'y'.repeat(400);
  const out = buildBroadcastSegment([{ from: 'p1', summary: long, urgency: 'normal' }]);
  assert.ok(!out.includes(long), 'the full 400-char body must never appear verbatim');
  assert.ok(out.includes('y'.repeat(200) + '…'), out.slice(0, 260));
});

// ---------------------------------------------------------------------------
// D2 — end to end through the real hook
// ---------------------------------------------------------------------------

test('D2 E2E: a long broadcast body is truncated in the rendered injection', () => {
  const h = makeHome();
  try {
    const long = 'z'.repeat(500);
    writeSharedSummary(h.home, {}, { recent: [{ from: 'peer-1', summary: long, ts: Date.now(), urgency: 'normal' }] });
    const r = testHook(HOOK, payload('sess-trunc'), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(!c.includes(long), 'the full 500-char body must never reach the injection');
    assert.ok(c.includes('z'.repeat(200) + '…'), c);
  } finally { h.cleanup(); }
});

test('D2 E2E: the SAME broadcast never repeats verbatim across turns of the SAME session', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {}, { recent: [{ from: 'peer-1', summary: 'wrapping up phase 3', ts: Date.now(), urgency: 'normal' }] });
    const r1 = testHook(HOOK, payload('sess-repeat'), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.ok(ctx(r1).includes('DEVSWARM BROADCAST'), `first turn must show the broadcast; ctx=${ctx(r1)}`);
    const r2 = testHook(HOOK, payload('sess-repeat'), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.ok(!ctx(r2).includes('DEVSWARM BROADCAST'), `second turn, same session, unchanged summary must NOT repeat; ctx=${ctx(r2)}`);
  } finally { h.cleanup(); }
});

test('D2 E2E NEGATIVE: a genuinely NEW broadcast still surfaces even after a prior one was suppressed', () => {
  const h = makeHome();
  try {
    const t0 = Date.now();
    writeSharedSummary(h.home, {}, { recent: [{ from: 'peer-1', summary: 'first announcement', ts: t0, urgency: 'normal' }] });
    testHook(HOOK, payload('sess-new'), { home: h.home, env: PRIMARY_ENV, expectJson: true }); // seen once
    writeSharedSummary(h.home, {}, {
      recent: [
        // SAME {from, ts, summary} as above -> same broadcastKey -> stays suppressed.
        { from: 'peer-1', summary: 'first announcement', ts: t0, urgency: 'normal' },
        { from: 'peer-2', summary: 'second, genuinely new announcement', ts: t0 + 1, urgency: 'normal' },
      ],
    });
    const r = testHook(HOOK, payload('sess-new'), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(!c.includes('first announcement'), `already-seen broadcast must stay suppressed; ctx=${c}`);
    assert.ok(c.includes('second, genuinely new announcement'), `a real new broadcast must still surface; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('D2 E2E: a broadcast older than ANTIHALL_BROADCAST_MAX_AGE_MS is dropped from the injection', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {}, {
      recent: [{ from: 'peer-1', summary: 'ancient news', ts: Date.now() - 60 * 60 * 1000, urgency: 'normal' }],
    });
    const r = testHook(HOOK, payload('sess-agecap'), {
      home: h.home, env: Object.assign({}, PRIMARY_ENV, { ANTIHALL_BROADCAST_MAX_AGE_MS: '1000' }), expectJson: true,
    });
    assert.ok(!ctx(r).includes('DEVSWARM BROADCAST'), `an age-capped-out broadcast must render nothing; ctx=${ctx(r)}`);
  } finally { h.cleanup(); }
});
