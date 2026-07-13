'use strict';
// devswarm-parent-inbox (UserPromptSubmit hook). Surfaces real unread/idle
// DevSwarm workspace state to the PRIMARY, and for workspaces the store marked
// archive_ready, urges the Primary to verify merged/tested/deployed per its OWN
// repo policy (this hook never checks that) then run `devswarm.js archive-request
// <id>` to ask the child to archive — never auto-archiving or archiving mechanically.
// Non-DevSwarm / child sessions and malformed stdin are silent no-ops (fail-open,
// exit 0).
//
// v0.57 mesh (PLAN-v0.57-mesh.md Phase 8, D1/D24/D29): the hook now reads ONE
// SHARED per-project summary (summaries/<repoKey>.json, keyed by
// repoKeyForWorktree(cwd)) and iterates its `workspaces` map, instead of the
// pre-mesh per-descriptor readDescriptors(home) + hashFromWorkspaceId(d.id)
// read. This means a resolvable `cwd` (-> repoKey) is now REQUIRED for any
// child/own data to surface at all — every test below that seeds workspace
// data passes `cwd: REPO_CWD` (via withCwd) and writes to the ONE shared
// summary file at REPO_KEY.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

const HOOK = 'devswarm-parent-inbox.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' }; // active + no source-branch = Primary

// OVERRIDE_REASSERT — v0.58 "mesh-only messaging": the terse per-turn COMMS
// OVERRIDE re-assertion the hook now injects UNCONDITIONALLY for every active
// Primary DevSwarm turn (see the hook's own OVERRIDE_REASSERT constant). Kept
// literal (not a substring match) so a "QUIET" test can assert the segment is
// EXACTLY this and nothing else.
const OVERRIDE_REASSERT =
  'DEVSWARM COMMS OVERRIDE: mesh only — native hivecontrol messaging blocked. ' +
  'Check: `roster` / `mesh read`. Direct: `send --to <meshId>`.';

// REPO_CWD/REPO_HASH/REPO_KEY — this test process's own cwd (a real git
// checkout) lets the hook's worktree resolution land on these exact keys, so a
// summary written under REPO_KEY is found. REPO_HASH is kept for the legacy
// worktreeHash back-compat fallback test only (D25's pre-mesh path).
const REPO_CWD = process.cwd();
const REPO_HASH = installIngest.worktreeHash(REPO_CWD);
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);

function payload() {
  return { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi' };
}
// withCwd(payloadFn) -> payload object carrying this test process's own cwd, so
// the hook's worktree resolution lands on REPO_KEY (required for ANY child/own
// data to surface under the v0.57 mesh restructure).
function withCwd(payloadFn) {
  return { ...payloadFn(), cwd: REPO_CWD };
}
function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}
// segment(ctx, banner) -> the '\n\n'-separated additionalContext segment whose
// first line starts with `banner`, or '' if absent. Lets a test assert on the
// archive/inbox banner alone, independent of the always-on live table segment.
function segment(c, banner) {
  return c.split('\n\n').find((s) => s.startsWith(banner)) || '';
}
// tableSeg(ctx) -> the live-workspace-table segment (or '').
function tableSeg(c) {
  return segment(c, 'DEVSWARM WORKSPACES');
}
// tableRow(ctx, id) -> the table row line for workspace `id`, or ''.
function tableRow(c, id) {
  return tableSeg(c).split('\n').find((l) => l.startsWith('| ' + id + ' ')) || '';
}

// swarmDir(home) -> ~/.anti-hall/devswarm, created.
function swarmDir(home) {
  const d = path.join(home, '.anti-hall', 'devswarm');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// makeGitRepo() -> a real, minimal git repo dir (git-common-dir resolution
// needs a real .git; no commit needed for `rev-parse --git-common-dir`).
function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-inbox-36-repo-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  return dir;
}

// wsEntry(overrides) -> one shared-summary workspace entry with the SAME shape
// deriveSummary() produces (devswarm-store.js). `worktreePath` defaults to
// REPO_CWD (the SAME repo as the caller) so an entry passes the #36 structural
// filter by default; override it to test cross-repoKey exclusion / fail-open.
function wsEntry(overrides) {
  return Object.assign({
    worktreePath: REPO_CWD,
    sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null,
    total: 0, cursor: 0, unread: 0, directUnread: 0,
    broadcastUnread: 0, urgencyMax: null, working_on: null,
    gates: {}, archive_ready: false,
  }, overrides || {});
}

// writeSharedSummary(home, workspacesRaw, extra) — writes the ONE shared
// summaries/<REPO_KEY>.json this hook now reads (v0.57 mesh). `workspacesRaw`
// is { id: <partial entry> }; each value is filled out via wsEntry() defaults.
function writeSharedSummary(home, workspacesRaw, extra) {
  const dir = path.join(swarmDir(home), 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  const workspaces = {};
  for (const id of Object.keys(workspacesRaw || {})) {
    const raw = workspacesRaw[id];
    workspaces[id] = raw === undefined ? undefined : (raw && typeof raw === 'object' ? wsEntry(raw) : raw);
  }
  const obj = {
    generatedAt: (extra && extra.generatedAt) != null ? extra.generatedAt : Date.now(),
    requiredGates: (extra && extra.requiredGates) || [],
    workspaces,
    recent: (extra && extra.recent) || [],
  };
  fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), JSON.stringify(obj));
}
function writeVerdict(home, id, verdict) {
  const p = path.join(swarmDir(home), 'liveness', id + '.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(verdict));
}
function writeHeartbeat(home, id, beat) {
  const p = path.join(swarmDir(home), 'heartbeats', id + '.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(beat));
}

// ---- gating no-ops ----

test('NO-OP: not a DevSwarm session -> no stdout', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { total: 2, cursor: 0, unread: 2, directUnread: 2 } });
    const r = testHook(HOOK, withCwd(payload), { home: h.home }); // no DEVSWARM env
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('NO-OP: child workspace (DEVSWARM_SOURCE_BRANCH set) -> no stdout', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { total: 1, cursor: 0, unread: 1, directUnread: 1 } });
    const r = testHook(HOOK, withCwd(payload), {
      home: h.home,
      env: { ...PRIMARY_ENV, DEVSWARM_SOURCE_BRANCH: 'feature-x' },
    });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('QUIET: Primary DevSwarm but no summary file at all -> ONLY the terse override re-assertion (v0.58, no longer fully inert)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(ctx(r), OVERRIDE_REASSERT, `expected ONLY the override; got: ${ctx(r)}`);
  } finally { h.cleanup(); }
});

test('QUIET: Primary DevSwarm, summary exists but has ZERO workspaces -> ONLY the terse override re-assertion', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {});
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(ctx(r), OVERRIDE_REASSERT, `expected ONLY the override; got: ${ctx(r)}`);
  } finally { h.cleanup(); }
});

test('QUIET: cwd unresolvable (no cwd in payload) -> no summary read, but the override still fires unconditionally', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { total: 3, cursor: 0, unread: 3, directUnread: 3 } });
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV, expectJson: true }); // no cwd field
    assert.strictEqual(r.status, 0);
    assert.strictEqual(ctx(r), OVERRIDE_REASSERT, `unresolvable repoKey must still show the override only; got: ${ctx(r)}`);
  } finally { h.cleanup(); }
});

test('TABLE: workspace with fully-consumed unread + no stuck verdict -> live table row only (no attention/archive banner)', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { total: 2, cursor: 2, unread: 0, directUnread: 0 } }); // cursor==total
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    // An ACTIVE workspace always appears in the live table, even when quiet.
    assert.ok(tableSeg(c).includes('DEVSWARM WORKSPACES'), `live table expected; ctx=${c}`);
    const row = tableRow(c, 'wsA');
    assert.ok(row, `wsA must have a table row; ctx=${c}`);
    assert.ok(/\bactive\b/.test(row), `quiet workspace status must be active; row=${row}`);
    assert.ok(/\|\s*0\s*\|/.test(row), `unread column must be 0; row=${row}`);
    // But no attention/archive banners when nothing is unread/stuck/archive-ready.
    assert.ok(!c.includes('DEVSWARM PARENT INBOX'), `no inbox banner; ctx=${c}`);
    assert.ok(!c.includes('DEVSWARM ARCHIVE-READY'), `no archive banner; ctx=${c}`);
  } finally { h.cleanup(); }
});

// ---- unread / idle surfacing ----

test('INJECT: workspace with unread backlog -> PARENT INBOX context with count + id + unread', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { total: 3, cursor: 0, unread: 3, directUnread: 3 } });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(r.json, `stdout must be JSON; stdout=${r.stdout}`);
    const c = ctx(r);
    assert.ok(c.includes('DEVSWARM PARENT INBOX'), `expected inbox banner; ctx=${c}`);
    assert.ok(c.includes('wsA'), 'must name the workspace');
    assert.ok(c.includes('3 unread'), `must report the unread count; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('TELEMETRY: unread>0 writes a parent-inbox.log line with cursor/total', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { total: 2, cursor: 0, unread: 2, directUnread: 2 } });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const logPath = path.join(h.home, '.anti-hall', 'devswarm', 'parent-inbox.log');
    const log = fs.readFileSync(logPath, 'utf8').trim();
    assert.ok(log, 'telemetry log must be written');
    const entry = JSON.parse(log.split('\n')[0]);
    assert.strictEqual(entry.event, 'inject');
    assert.strictEqual(entry.workspaces[0].id, 'wsA');
    assert.strictEqual(entry.workspaces[0].unread, 2);
    assert.strictEqual(entry.workspaces[0].total, 2);
    assert.strictEqual(entry.workspaces[0].cursor, 0);
  } finally { h.cleanup(); }
});

test('INJECT: escalated verdict with empty inbox is still surfaced (stuck), no telemetry', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { total: 2, cursor: 2, unread: 0, directUnread: 0 } }); // no unread
    writeVerdict(h.home, 'wsA', { status: 'escalated' });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(c.includes('wsA'), `stuck workspace must be surfaced; ctx=${c}`);
    assert.ok(c.includes('escalated'), `status label must appear; ctx=${c}`);
    // No unread anywhere -> no telemetry line.
    const logPath = path.join(h.home, '.anti-hall', 'devswarm', 'parent-inbox.log');
    assert.strictEqual(fs.existsSync(logPath), false, 'no telemetry when nothing unread');
  } finally { h.cleanup(); }
});

// ---- archive-ready recommendation (P1-E) ----

test('ARCHIVE: archive_ready workspace -> urges verify-per-repo-policy + archive-request recommendation (never auto-archive)', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { archive_ready: true } });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(c.includes('DEVSWARM ARCHIVE-READY'), `expected archive banner; ctx=${c}`);
    assert.ok(c.includes('wsA'), 'must name the workspace');
    assert.ok(/MERGED \+ TESTED \+ DEPLOYED/.test(c), `must urge verify-per-repo-policy; ctx=${c}`);
    assert.ok(/per YOUR repo's policy/i.test(c), `must defer to the parent repo's own policy; ctx=${c}`);
    assert.ok(/archive-request <id>/.test(c), `must recommend the archive-request CLI command; ctx=${c}`);
    assert.ok(/NEVER archive mechanically/i.test(c), `must warn never to archive mechanically; ctx=${c}`);
    // cooldown state recorded so it does not repeat every turn
    const nudgePath = path.join(h.home, '.anti-hall', 'devswarm', 'archive-nudges', 'wsA.json');
    assert.ok(fs.existsSync(nudgePath), 'archive nudge cooldown must be recorded');
  } finally { h.cleanup(); }
});

test('ARCHIVE: ignore mark silences the archive reminder for that workspace only', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { archive_ready: true }, wsB: { archive_ready: true } });
    const igDir = path.join(h.home, '.anti-hall', 'devswarm', 'archive-ignore');
    fs.mkdirSync(igDir, { recursive: true });
    fs.writeFileSync(path.join(igDir, 'wsA.json'), '{}');
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    // The ignore mark silences the archive NUDGE for wsA only (wsA still appears in
    // the factual live table — ignore governs the reminder, not the status table).
    const archive = segment(c, 'DEVSWARM ARCHIVE-READY');
    assert.ok(archive, `archive banner expected for wsB; ctx=${c}`);
    assert.ok(!archive.includes('wsA'), `ignored workspace must not be nudged; archive=${archive}`);
    assert.ok(archive.includes('wsB'), 'non-ignored workspace must still be nudged');
  } finally { h.cleanup(); }
});

test('ARCHIVE: recent nudge within cooldown -> archive banner suppressed (table still shows archive-ready status)', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { archive_ready: true } });
    const nudgeDir = path.join(h.home, '.anti-hall', 'devswarm', 'archive-nudges');
    fs.mkdirSync(nudgeDir, { recursive: true });
    fs.writeFileSync(path.join(nudgeDir, 'wsA.json'), JSON.stringify({ lastNudgedAt: Date.now() }));
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    // Cooldown suppresses the repeat NUDGE banner...
    assert.ok(!c.includes('DEVSWARM ARCHIVE-READY'), `cooldown should suppress the archive banner; ctx=${c}`);
    // ...but the live table still reports the factual archive-ready status.
    assert.ok(/archive-ready/.test(tableRow(c, 'wsA')), `table row must show archive-ready; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('MULTI-WORKSPACE: two workspaces in ONE shared summary each render independently (no field bleed between entries)', () => {
  const h = makeHome();
  try {
    // Regression for the Phase 8 restructure (Opus-auditor P1: iterate
    // summary.workspaces ONCE, do not double-read/mis-key per descriptor):
    // two DISTINCT entries in the SAME shared summary must not leak fields
    // onto each other.
    writeSharedSummary(h.home, {
      wsAlpha: { archive_ready: true, status: 'idle', gates: { done: true } },
      wsBeta: { archive_ready: false, status: 'escalated', gates: {} },
    }, { requiredGates: ['done'] });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    // wsAlpha: archive-ready + 1/1 gates, per ITS OWN entry.
    const archive = segment(c, 'DEVSWARM ARCHIVE-READY');
    assert.ok(archive.includes('wsAlpha'), `wsAlpha must be archive-ready; ctx=${c}`);
    assert.ok(!archive.includes('wsBeta'), `wsBeta must NOT be archive-ready; ctx=${c}`);
    assert.ok(/\|\s*wsAlpha\s*\|\s*archive-ready\s*\|\s*1\/1\s*\|/.test(tableRow(c, 'wsAlpha')), `wsAlpha row; row=${tableRow(c, 'wsAlpha')}`);
    // wsBeta: escalated + 0/1 gates, per ITS OWN entry — not wsAlpha's
    // archive-ready status leaking over, and not silently null (the bug).
    assert.ok(/\|\s*wsBeta\s*\|\s*escalated\s*\|\s*0\/1\s*\|/.test(tableRow(c, 'wsBeta')), `wsBeta row; row=${tableRow(c, 'wsBeta')}`);
  } finally { h.cleanup(); }
});

// ---- live workspace table (v0.54.1) ----

test('TABLE: renders correct rows/columns for varied status + gates + unread, sorted attention-first', () => {
  const h = makeHome();
  try {
    // wsQuiet: alive, no unread, gates 1/2 + heartbeat progress -> active
    writeHeartbeat(h.home, 'wsQuiet', { id: 'wsQuiet', ts: Date.now(), progress_pct: 40 });
    // wsStale: stale verdict + unread -> stale, attention-first
    writeVerdict(h.home, 'wsStale', { status: 'stale', lastOutboundTs: Date.now() - 20 * 60 * 1000 });
    writeSharedSummary(h.home, {
      wsQuiet: { total: 2, cursor: 2, unread: 0, directUnread: 0, gates: { tests: true, review: false }, archive_ready: false },
      wsStale: { total: 3, cursor: 0, unread: 3, directUnread: 3, gates: {}, archive_ready: false },
      wsDone: { total: 0, cursor: 0, unread: 0, directUnread: 0, gates: { tests: true, review: true }, archive_ready: true },
    }, { requiredGates: ['tests', 'review'] });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    const t = tableSeg(c);
    assert.ok(t.includes('| workspace | status | finish | unread | last |'), `header row expected; t=${t}`);
    // Column values
    // required gates declared but none met for wsStale -> 0/2 (not "—").
    assert.ok(/\|\s*wsStale\s*\|\s*stale\s*\|\s*0\/2\s*\|\s*3\s*\|/.test(tableRow(c, 'wsStale')), `wsStale row; row=${tableRow(c, 'wsStale')}`);
    assert.ok(/\|\s*wsDone\s*\|\s*archive-ready\s*\|\s*2\/2\s*\|\s*0\s*\|/.test(tableRow(c, 'wsDone')), `wsDone row; row=${tableRow(c, 'wsDone')}`);
    // gates 1/2 + progress 40% shown together
    assert.ok(/\|\s*wsQuiet\s*\|\s*active\s*\|\s*1\/2 \(40%\)\s*\|\s*0\s*\|/.test(tableRow(c, 'wsQuiet')), `wsQuiet row; row=${tableRow(c, 'wsQuiet')}`);
    // Sort: stale (attention) before archive-ready before active.
    const body = t.split('\n');
    const iStale = body.findIndex((l) => l.startsWith('| wsStale '));
    const iDone = body.findIndex((l) => l.startsWith('| wsDone '));
    const iQuiet = body.findIndex((l) => l.startsWith('| wsQuiet '));
    assert.ok(iStale < iDone && iDone < iQuiet, `attention-first sort; order stale<done<quiet; body=${JSON.stringify(body)}`);
  } finally { h.cleanup(); }
});

test('TABLE: no active workspaces -> no table, ONLY the terse override re-assertion', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {});
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(ctx(r), OVERRIDE_REASSERT, `expected ONLY the override; got: ${ctx(r)}`);
  } finally { h.cleanup(); }
});

test('TABLE: caps at 12 rows with a "+N more" note and a logged table-cap event', () => {
  const h = makeHome();
  try {
    const workspaces = {};
    for (let i = 0; i < 15; i++) {
      const id = 'ws' + String(i).padStart(2, '0');
      workspaces[id] = { total: 0, cursor: 0, unread: 0, directUnread: 0 };
    }
    writeSharedSummary(h.home, workspaces);
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const t = tableSeg(ctx(r));
    const dataRows = t.split('\n').filter((l) => /^\| ws\d\d /.test(l));
    assert.strictEqual(dataRows.length, 12, `must cap at 12 rows; got ${dataRows.length}`);
    assert.ok(t.includes('+3 more (capped at 12)'), `must note the +3 hidden; t=${t}`);
    // cap logged (no silent truncation)
    const logPath = path.join(h.home, '.anti-hall', 'devswarm', 'parent-inbox.log');
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const cap = lines.find((e) => e.event === 'table-cap');
    assert.ok(cap, 'a table-cap telemetry line must be written');
    assert.strictEqual(cap.total, 15);
    assert.strictEqual(cap.shown, 12);
    assert.strictEqual(cap.hidden, 3);
  } finally { h.cleanup(); }
});

test('TABLE: fail-open on a malformed entry (non-object value) -> good workspace still tabled, exit 0', () => {
  const h = makeHome();
  try {
    // A malformed entry alongside a good one — writeSharedSummary passes a raw
    // (non-object) value straight through instead of filling it via wsEntry().
    writeSharedSummary(h.home, {
      wsGood: { total: 1, cursor: 0, unread: 1, directUnread: 1 },
      wsBad: 'not-an-object',
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    assert.ok(tableRow(c, 'wsGood'), `good workspace must still be tabled; ctx=${c}`);
    assert.ok(!c.includes('wsBad'), 'malformed entry must be skipped');
  } finally { h.cleanup(); }
});

test('TABLE: coexists with the unread inbox + archive-ready + broadcast banners (append, no clobber)', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      wsUnread: { total: 2, cursor: 0, unread: 2, directUnread: 2 },
      wsDone: { archive_ready: true },
    }, {
      recent: [{ from: 'peer-1', summary: 'wrapping up phase 3', ts: Date.now(), urgency: 'normal' }],
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    // All four segments present.
    assert.ok(tableSeg(c).includes('DEVSWARM WORKSPACES'), `table segment present; ctx=${c}`);
    assert.ok(segment(c, 'DEVSWARM BROADCAST'), `broadcast segment present; ctx=${c}`);
    assert.ok(segment(c, 'DEVSWARM PARENT INBOX'), `unread inbox banner present; ctx=${c}`);
    assert.ok(segment(c, 'DEVSWARM ARCHIVE-READY'), `archive banner present; ctx=${c}`);
    // Table lists both workspaces.
    assert.ok(tableRow(c, 'wsUnread'), 'table row for unread workspace');
    assert.ok(tableRow(c, 'wsDone'), 'table row for archive-ready workspace');
    assert.ok(segment(c, 'DEVSWARM BROADCAST').includes('peer-1'), 'broadcast segment names the sender');
  } finally { h.cleanup(); }
});

// ---- v0.57 mesh: urgency tiering (D4, Phase 8 step 2) ----

test('URGENCY: an urgent direct renders the LOUD imperative segment, distinct from the standard one', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      wsUrgent: { total: 1, cursor: 0, unread: 1, directUnread: 1, urgencyMax: 'urgent' },
      wsNormal: { total: 1, cursor: 0, unread: 1, directUnread: 1, urgencyMax: 'normal' },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    const urgentSeg = segment(c, 'DEVSWARM URGENT INBOX');
    const normalSeg = segment(c, 'DEVSWARM PARENT INBOX');
    assert.ok(urgentSeg, `urgent segment expected; ctx=${c}`);
    assert.ok(urgentSeg.includes('wsUrgent'), `urgent segment names wsUrgent; seg=${urgentSeg}`);
    assert.ok(!urgentSeg.includes('wsNormal'), `urgent segment must not include the normal workspace; seg=${urgentSeg}`);
    assert.match(urgentSeg, /STOP and read/);
    assert.ok(normalSeg, `standard segment expected for the normal-urgency workspace; ctx=${c}`);
    assert.ok(normalSeg.includes('wsNormal'), `standard segment names wsNormal; seg=${normalSeg}`);
    assert.ok(!normalSeg.includes('wsUrgent'), `standard segment must not include the urgent workspace; seg=${normalSeg}`);
  } finally { h.cleanup(); }
});

test('URGENCY: unrecognized/null urgency falls back to the standard (normal) tier — back-compat default', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      wsLegacy: { total: 1, cursor: 0, unread: 1, directUnread: 1 }, // urgencyMax: null (native-drained)
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(segment(c, 'DEVSWARM PARENT INBOX').includes('wsLegacy'), `legacy/null urgency must render via the standard segment; ctx=${c}`);
    assert.strictEqual(segment(c, 'DEVSWARM URGENT INBOX'), '', `no urgent segment for a null-urgency unread; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('URGENCY: low-urgency unread is TABLE-ROW-ONLY — excluded from every textual segment', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      wsLow: { total: 1, cursor: 0, unread: 1, directUnread: 1, urgencyMax: 'low' },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(tableRow(c, 'wsLow'), `low-urgency workspace must still get a table row; ctx=${c}`);
    assert.strictEqual(segment(c, 'DEVSWARM PARENT INBOX'), '', `no standard segment for a low-urgency-only unread; ctx=${c}`);
    assert.strictEqual(segment(c, 'DEVSWARM URGENT INBOX'), '', `no urgent segment for a low-urgency unread; ctx=${c}`);
  } finally { h.cleanup(); }
});

// Opus-auditor P2 regression (Wave G fix-wave): tierOf() must not conflate a
// pending direct's low message-urgency with a liveness escalation — a stuck
// (stale/escalated) workspace's own wedge/escalation must still surface in the
// LOUD imperative segment, never demoted to table-row-only just because the
// unread message it is carrying happens to be low-urgency.
test('URGENCY: a STUCK (stale/escalated) workspace is never demoted to table-row-only by a low-urgency message', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      wsStuck: { total: 1, cursor: 0, unread: 1, directUnread: 1, urgencyMax: 'low', status: 'stale' },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(tableRow(c, 'wsStuck'), `stuck workspace must still get a table row; ctx=${c}`);
    const normalSeg = segment(c, 'DEVSWARM PARENT INBOX');
    assert.ok(normalSeg.includes('wsStuck'), `stuck workspace must appear in the standard imperative segment despite low message urgency; seg=${normalSeg}`);
    assert.ok(normalSeg.includes('stale'), `status must be visible in the segment; seg=${normalSeg}`);
    assert.strictEqual(segment(c, 'DEVSWARM URGENT INBOX'), '', `low urgency must not promote to the urgent segment; ctx=${c}`);
  } finally { h.cleanup(); }
});

// ---- v0.57 mesh: broadcast/roster feed — advisory only (D3/D4/D22/D23/D27) ----

test('BROADCAST: a plain broadcast renders soft, advisory react-if-concerned wording', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {}, {
      recent: [{ from: 'peer-2', summary: 'refactoring the store layer', ts: Date.now(), urgency: 'normal' }],
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    const seg = segment(c, 'DEVSWARM BROADCAST');
    assert.ok(seg, `broadcast segment expected; ctx=${c}`);
    assert.match(seg, /advisory/i);
    assert.match(seg, /react ONLY if you judge it relevant/);
    assert.match(seg, /NEVER blocks/i);
    assert.ok(seg.includes('peer-2'), 'names the sender');
    assert.ok(!seg.includes('[URGENT]'), 'a normal-urgency broadcast is not tagged URGENT');
  } finally { h.cleanup(); }
});

test('BROADCAST: an urgent broadcast renders LOUD ([URGENT] tag) yet stays advisory-only wording', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {}, {
      recent: [{ from: 'peer-3', summary: 'main is broken, everyone stop', ts: Date.now(), urgency: 'urgent' }],
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    const seg = segment(c, 'DEVSWARM BROADCAST');
    assert.ok(seg, `broadcast segment expected; ctx=${c}`);
    assert.ok(seg.includes('[URGENT] peer-3'), `urgent broadcast must be tagged; seg=${seg}`);
    assert.match(seg, /react ONLY if you judge it relevant/, 'still advisory wording, even when loud');
    assert.match(seg, /NEVER blocks/i, 'urgent broadcast never claims to gate');
  } finally { h.cleanup(); }
});

test('BROADCAST: a heartbeat row (no isHeartbeat discriminator on the wire) renders identically to a plain broadcast — never a Stop-gate concern', () => {
  const h = makeHome();
  try {
    // recent[] rows carry no isHeartbeat flag on the wire (D22) — a heartbeat's
    // working_on summary renders through the SAME advisory path as any broadcast.
    writeSharedSummary(h.home, {}, {
      recent: [{ from: 'peer-4', summary: 'working on phase 2 tests', ts: Date.now(), urgency: null }],
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    const seg = segment(c, 'DEVSWARM BROADCAST');
    assert.ok(seg && seg.includes('peer-4'), `heartbeat-shaped row surfaces via the broadcast segment; ctx=${c}`);
    assert.match(seg, /NEVER blocks/i);
  } finally { h.cleanup(); }
});

test('BROADCAST: no recent[] entries -> no broadcast segment', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { total: 0, cursor: 0, unread: 0, directUnread: 0 } });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.strictEqual(segment(c, 'DEVSWARM BROADCAST'), '', `no recent[] -> no broadcast segment; ctx=${c}`);
  } finally { h.cleanup(); }
});

// ---- #36 cross-project-bleed fix: STRUCTURAL repoKey-scoped enumeration
// (D29 — replaces the spoofable v0.56 env filter). Step 1's restructure
// already scopes reads to THIS project's OWN summaries/<repoKey>.json, so
// these tests exercise the DEFENSE-IN-DEPTH per-entry filter directly by
// crafting an entry whose worktreePath belongs to a DIFFERENT repo (as if a
// migration artifact or future write-path drift landed it in the wrong file).

test('#36 EXCLUDE: an entry whose worktree resolves to a DIFFERENT repoKey never enters the table or attention list', () => {
  const h = makeHome();
  const otherRepo = makeGitRepo();
  try {
    assert.notEqual(repokey.repoKeyForWorktree(otherRepo), REPO_KEY, 'precondition: genuinely different repoKey');
    writeSharedSummary(h.home, {
      foreign: { total: 2, cursor: 0, unread: 2, directUnread: 2, worktreePath: otherRepo },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(ctx(r), OVERRIDE_REASSERT, 'a foreign-repoKey entry must produce ONLY the override, no leaked data');
  } finally { h.cleanup(); fs.rmSync(otherRepo, { recursive: true, force: true }); }
});

test('#36 INCLUDE (same repoKey): an entry whose worktree resolves to the SAME repoKey is surfaced', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      'same-project': { total: 2, cursor: 0, unread: 2, directUnread: 2, worktreePath: REPO_CWD },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(c.includes('same-project'), `matching repoKey must surface; ctx=${c}`);
    assert.ok(tableRow(c, 'same-project'), `must get a table row; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('#36 INCLUDE (fail-open): an entry with a null/unresolvable worktreePath is KEPT, not vanished', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      'legacy-desc': { total: 2, cursor: 0, unread: 2, directUnread: 2, worktreePath: null },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(c.includes('legacy-desc'), `a null-worktreePath entry must not vanish (fail-open); ctx=${c}`);
    assert.ok(tableRow(c, 'legacy-desc'), `must still get a table row; ctx=${c}`);
  } finally { h.cleanup(); }
});

// ---- fail-open ----

test('FAIL-OPEN: empty stdin -> exit 0, no crash', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(r.status, 0);
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: malformed JSON stdin -> exit 0, no crash', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{bad', { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(r.status, 0);
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: corrupt summary.json -> treated as no data, exit 0, no crash', () => {
  const h = makeHome();
  try {
    const dir = path.join(swarmDir(h.home), 'summaries');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), '{not json');
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(ctx(r), OVERRIDE_REASSERT, `corrupt summary must fail open to no data (override only); got: ${ctx(r)}`);
  } finally { h.cleanup(); }
});

// ---- daemon-liveness staleness banner (rewired to the ingest daemon's own
// heartbeat, not summary.json's generatedAt — #21; RE-KEYED to repoKey —
// release-gate #23, PLAN-v0.57-mesh.md D25) ----
// heartbeats/ingest-<repoKey>.json is rewritten EVERY sweep cycle regardless of
// whether anything was inserted (writeIngestHeartbeat in devswarm-ingest.js), so
// a live-but-QUIET daemon (backlog present, no new messages) no longer
// false-reads as stale via a frozen generatedAt.
const HEARTBEAT_STALE_MS = 3 * 60 * 1000; // must match HEARTBEAT_STALE_MS in the hook
// staleBanner(ctx) -> the '⚠ DEVSWARM STALE DATA' segment, or ''.
function staleBanner(c) {
  return c.split('\n\n').find((s) => s.includes('DEVSWARM STALE DATA')) || '';
}
function writeDaemonHeartbeat(home, hash, ts) {
  const p = path.join(swarmDir(home), 'heartbeats', 'ingest-' + hash + '.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ts, workspaceId: 'primary-' + hash, workingDir: REPO_CWD, pid: 1 }));
}
// writeDaemonLock(home, repoKey, pid) — the per-project O_EXCL ingest lock
// (D25's second health signal, devswarm-ingest.js's ingestLockPath project
// shape). daemonHealth's liveLock check reads only `pid`.
function writeDaemonLock(home, repoKey, pid) {
  const p = path.join(swarmDir(home), 'locks', 'ingest-project-' + repoKey + '.lock');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ pid, ts: Date.now(), token: 'test' }));
}

test('STALE: fresh heartbeat + live lock (repoKey-keyed) -> healthy -> NO banner even with an ancient summary.generatedAt (proves the live-but-quiet fix)', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { total: 2, cursor: 0, unread: 2, directUnread: 2 } }, {
      generatedAt: Date.now() - HEARTBEAT_STALE_MS * 10,
    });
    writeDaemonHeartbeat(h.home, REPO_KEY, Date.now() - 10 * 1000);
    writeDaemonLock(h.home, REPO_KEY, process.pid); // this test process itself — genuinely alive
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    assert.ok(tableSeg(c).includes('DEVSWARM WORKSPACES'), `table still present; ctx=${c}`);
    assert.strictEqual(staleBanner(c), '', `healthy daemon must not warn; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('STALE: heartbeat older than threshold (repoKey-keyed) -> banner ABOVE the table', { skip: process.platform === 'win32' }, () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { total: 2, cursor: 0, unread: 2, directUnread: 2 } });
    writeDaemonHeartbeat(h.home, REPO_KEY, Date.now() - (HEARTBEAT_STALE_MS + 60 * 1000));
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    const banner = staleBanner(c);
    assert.ok(banner, `stale heartbeat must warn; ctx=${c}`);
    assert.ok(/ingest daemon last alive/.test(banner), `banner text; banner=${banner}`);
    assert.ok(/doctor/.test(banner), `banner must point to a remedy; banner=${banner}`);
    // Banner must sit ABOVE the live workspace table.
    const iBanner = c.indexOf('DEVSWARM STALE DATA');
    const iTable = c.indexOf('DEVSWARM WORKSPACES');
    assert.ok(iBanner >= 0 && iTable >= 0 && iBanner < iTable, `banner above table; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('STALE: missing heartbeat file (daemon never wrote one for this project) + active workspace -> banner (additive, does not suppress the unread banner)', { skip: process.platform === 'win32' }, () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { total: 3, cursor: 0, unread: 3, directUnread: 3 } });
    // No heartbeat file written at all.
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    assert.ok(staleBanner(c), `missing heartbeat must warn; ctx=${c}`);
    assert.ok(c.includes('DEVSWARM PARENT INBOX'), `live unread still surfaced alongside; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('STALE: no active workspace -> NO banner (nothing tabled, regardless of heartbeat state); ONLY the override', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {}); // repoKey resolves, but zero workspaces
    // No heartbeat either.
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(ctx(r), OVERRIDE_REASSERT, `no active workspaces -> no banner, override only; ctx=${ctx(r)}`);
  } finally { h.cleanup(); }
});

test('STALE: no cwd in payload (worktree unresolvable) -> NO banner, no throw (fail-open); ONLY the override', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { total: 0, cursor: 0, unread: 0, directUnread: 0 } });
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV, expectJson: true }); // no cwd field -> nothing resolves at all
    assert.strictEqual(r.status, 0);
    assert.strictEqual(ctx(r), OVERRIDE_REASSERT, `unresolvable cwd -> no banner, override only; ctx=${ctx(r)}`);
  } finally { h.cleanup(); }
});

test('STALE: cwd with no enclosing git repo (bogus path) -> NO banner, no throw (fail-open)', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { total: 0, cursor: 0, unread: 0, directUnread: 0 } });
    const r = testHook(HOOK, { ...payload(), cwd: '/definitely-does-not-exist-anti-hall-test-root' },
      { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(staleBanner(ctx(r)), '', `no git toplevel found -> no banner; ctx=${ctx(r)}`);
  } finally { h.cleanup(); }
});

test('STALE: malformed heartbeat JSON (repoKey-keyed) -> treated as unknown/missing (still warns), no throw', { skip: process.platform === 'win32' }, () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { total: 0, cursor: 0, unread: 0, directUnread: 0 } });
    const p = path.join(swarmDir(h.home), 'heartbeats', 'ingest-' + REPO_KEY + '.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not json');
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(staleBanner(ctx(r)), `malformed heartbeat treated as missing -> still warns; ctx=${ctx(r)}`);
  } finally { h.cleanup(); }
});

// ---- D25: daemon health = RUNNING + HEALTHY, not freshness-only ----

test('D25: DEAD process with a still-fresh heartbeat file -> reported NOT-healthy -> banner shown', { skip: process.platform === 'win32' }, () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { total: 0, cursor: 0, unread: 0, directUnread: 0 } });
    writeDaemonHeartbeat(h.home, REPO_KEY, Date.now() - 5000); // fresh
    writeDaemonLock(h.home, REPO_KEY, 999999); // implausible/dead pid
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(staleBanner(ctx(r)), `a dead-process lock must still warn despite a fresh heartbeat; ctx=${ctx(r)}`);
  } finally { h.cleanup(); }
});

test('D25: LIVE process holding the lock but a MISSING heartbeat -> reported NOT-fresh -> banner shown', { skip: process.platform === 'win32' }, () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { total: 0, cursor: 0, unread: 0, directUnread: 0 } });
    // No heartbeat file written; the lock alone is live.
    writeDaemonLock(h.home, REPO_KEY, process.pid);
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(staleBanner(ctx(r)), `a live lock alone (no heartbeat) must still warn; ctx=${ctx(r)}`);
  } finally { h.cleanup(); }
});

// ---- back-compat: repoKey unresolvable -> legacy worktreeHash fallback ----

test('STALE back-compat: repoKey unresolvable (git spawn fails on a bogus .git) -> falls back to the LEGACY worktreeHash-keyed heartbeat (freshness-only)', () => {
  const h = makeHome();
  const bogusRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-bogus-git-'));
  try {
    // A `.git` ENTRY exists (pure-fs findGitToplevel resolves it), but it is not
    // a real git repository -> `git rev-parse --git-common-dir` fails -> repoKey
    // resolves to null -> the reader falls back to the legacy worktreeHash key.
    // No shared summary can be written for an unresolvable repoKey, so there is
    // no active-workspace precondition here (the banner gate's `gitTop &&
    // !repoKey` OR-branch fires independent of any workspace/row).
    fs.writeFileSync(path.join(bogusRepo, '.git'), 'not a real gitfile');
    assert.strictEqual(repokey.repoKeyForWorktree(bogusRepo), null, 'precondition: repoKey must be unresolvable for this bogus repo');

    const bogusHash = installIngest.worktreeHash(bogusRepo);
    writeDaemonHeartbeat(h.home, bogusHash, Date.now() - 10 * 1000); // fresh, legacy-keyed

    const r = testHook(HOOK, { ...payload(), cwd: bogusRepo }, { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(staleBanner(ctx(r)), '', `fresh legacy-keyed heartbeat must still suppress the banner (back-compat); ctx=${ctx(r)}`);
  } finally { h.cleanup(); try { fs.rmSync(bogusRepo, { recursive: true, force: true }); } catch (_) {} }
});

// D27 (missing/corrupt helper module fails the block open, never the hook) is
// NOT exercised here by mutating the real, shared companion/lib/ingest-health.js
// on disk: `node --test` parallelizes across test FILES (worker threads), and
// this repo-tree file is required by OTHER test files (tests/companion/
// ingest-health.test.js, tests/hooks/devswarm-child-turn.test.js) that may be
// running concurrently — corrupting it here would be flaky-by-construction for
// the whole suite, not just this file. The lazy `require(...)` IS wrapped in a
// try/catch in the hook source (see devswarm-parent-inbox.js's staleness
// block above) — the SAME pattern devswarm-child-turn.js uses, and the SAME
// require-fails-safely contract asserted directly (no shared-file mutation) in
// tests/companion/ingest-health.test.js's own "D27 contract" test.

// ---- Primary's OWN inbound unread (#34) — parity: the Primary previously had no
// visibility into its OWN unread parent/peer backlog (only children's). v0.57
// mesh: it is exposed via the SAME shared summaries/<REPO_KEY>.json ->
// workspaces[primary-<hash>].unread this hook already reads for children.
const OWN_ID = 'primary-' + REPO_HASH;
function ownSegment(c) {
  return segment(c, 'DEVSWARM OWN INBOX');
}

test('OWN UNREAD: Primary\'s own summary-projected unread -> imperative PRIORITY segment (parity with child wording)', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { [OWN_ID]: { total: 4, cursor: 0, unread: 4, directUnread: 4 } });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    const own = ownSegment(c);
    assert.ok(own, `own-unread PRIORITY segment expected; ctx=${c}`);
    assert.ok(own.includes('4 unread') || own.includes('4 '), `must report own unread count; own=${own}`);
    assert.ok(/STOP and read your unread parent\/peer message\(s\) FIRST/.test(own), `must use imperative parity wording; own=${own}`);
    assert.ok(own.includes(OWN_ID), 'must name the own workspace id for the read-primary CLI command');
    assert.ok(own.includes('inbox read-primary'), `must state the read-primary clear path; own=${own}`);
  } finally { h.cleanup(); }
});

test('OWN UNREAD: urgent own-unread gets the URGENT PRIORITY prefix (D4 honoring, Phase 8 step 4)', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { [OWN_ID]: { total: 1, cursor: 0, unread: 1, directUnread: 1, urgencyMax: 'urgent' } });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const own = ownSegment(ctx(r));
    assert.match(own, /DEVSWARM OWN INBOX — URGENT PRIORITY/, `own=${own}`);
  } finally { h.cleanup(); }
});

test('OWN UNREAD: coexists with a child unread banner without prefix collision, child wording upgraded to imperative too', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      wsA: { total: 2, cursor: 0, unread: 2, directUnread: 2 },
      [OWN_ID]: { total: 1, cursor: 0, unread: 1, directUnread: 1 },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    const own = ownSegment(c);
    const child = segment(c, 'DEVSWARM PARENT INBOX:');
    assert.ok(own, `own segment present; ctx=${c}`);
    assert.ok(child, `child segment present; ctx=${c}`);
    assert.ok(own.includes('1'), `own unread count; own=${own}`);
    assert.ok(child.includes('wsA'), `child segment names wsA; child=${child}`);
    assert.ok(child.includes('2 unread'), `child unread count; child=${child}`);
    assert.ok(/STOP and read each unread workspace/.test(child), `child unread wording upgraded to imperative; child=${child}`);
  } finally { h.cleanup(); }
});

test('OWN UNREAD: no own-primary entry in summary -> no own segment (fail-open), child-only unread still works', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { total: 1, cursor: 0, unread: 1, directUnread: 1 } });
    // No own-primary entry in the summary at all.
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.strictEqual(ownSegment(c), '', `no own segment when summary has no own entry; ctx=${c}`);
    assert.ok(c.includes('DEVSWARM PARENT INBOX'), `child unread still surfaced; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('OWN UNREAD: unresolvable cwd (no git toplevel) -> no own segment, no throw (fail-open)', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { [OWN_ID]: { total: 3, cursor: 0, unread: 3, directUnread: 3 } });
    const r = testHook(HOOK, { ...payload(), cwd: '/definitely-does-not-exist-anti-hall-test-root' },
      { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(ownSegment(ctx(r)), '', `no cwd resolution -> no own segment; ctx=${ctx(r)}`);
  } finally { h.cleanup(); }
});

// Reviewer P1 regression (Wave G fix-wave): Phase 8's step-1 restructure iterates
// the shared summary's OWN entries too, since the Primary's self-registered id
// (OWN_ID) lives in the SAME summaries/<REPO_KEY>.json as real children. Without
// an explicit exclusion, OWN_ID double-surfaces as a fake "child" — once via the
// dedicated OWN INBOX segment (correct), and again via the live table / PARENT
// INBOX / URGENT INBOX / ARCHIVE-READY segments, all of which suggest a CLI
// command (`inbox read <id>`, `archive-request <id>`) that is provably broken
// for a primary id (readDescriptorFile has no descriptor for it).
// ---------------------------------------------------------------------------
// v0.58 "mesh-only messaging": terse per-turn OVERRIDE_REASSERT ordering +
// hook-text sweep (no emitted text ever names the blocked native verbs).

test('OVERRIDE: is the FIRST segment, ahead of the live table / unread / archive banners', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      wsUnread: { total: 2, cursor: 0, unread: 2, directUnread: 2 },
      wsDone: { archive_ready: true },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(c.startsWith(OVERRIDE_REASSERT), `override must lead every other segment; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('HOOK-TEXT SWEEP: emitted parent-inbox text never contains the blocked native verbs, even with every segment active', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      wsUnread: { total: 2, cursor: 0, unread: 2, directUnread: 2, urgencyMax: 'urgent' },
      wsDone: { archive_ready: true },
      [OWN_ID]: { total: 1, cursor: 0, unread: 1, directUnread: 1 },
    }, {
      recent: [{ from: 'peer-1', summary: 'status update', ts: Date.now(), urgency: 'normal' }],
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(!/message-parent/.test(c), `must never emit message-parent; ctx=${c}`);
    assert.ok(!/message-child/.test(c), `must never emit message-child; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('OWN UNREAD/#34: the Primary\'s own summary entry never double-surfaces as a fake child — table/attention/archive all exclude it, only the dedicated OWN INBOX segment names it', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      wsA: { total: 2, cursor: 0, unread: 2, directUnread: 2 },
      [OWN_ID]: {
        total: 5, cursor: 0, unread: 5, directUnread: 5, urgencyMax: 'urgent',
        archive_ready: true,
      },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    // OWN_ID surfaces via the dedicated OWN INBOX segment, and ONLY there.
    const own = ownSegment(c);
    assert.ok(own.includes(OWN_ID), `own segment must name OWN_ID; own=${own}`);
    // Never as a live-table row (a row for OWN_ID would carry `inbox read <id>`
    // in spirit even though the table itself has no CLI hint, but it also has no
    // reason to exist — the row-per-workspace contract is for real children).
    assert.strictEqual(tableRow(c, OWN_ID), '', `OWN_ID must never appear as a table row; ctx=${c}`);
    // Never in the child unread/urgent-unread attention segments (which suggest
    // `devswarm.js inbox read <id>` — broken for a primary id).
    const urgentChild = segment(c, 'DEVSWARM URGENT INBOX');
    const normalChild = segment(c, 'DEVSWARM PARENT INBOX:');
    assert.ok(!urgentChild.includes(OWN_ID), `OWN_ID must not appear in URGENT INBOX; seg=${urgentChild}`);
    assert.ok(!normalChild.includes(OWN_ID), `OWN_ID must not appear in PARENT INBOX; seg=${normalChild}`);
    // Never in the archive-ready recommendation (which suggests
    // `devswarm.js archive-request <id>` — also broken for a primary id).
    const archive = segment(c, 'DEVSWARM ARCHIVE-READY');
    assert.ok(!archive.includes(OWN_ID), `OWN_ID must not appear in the archive banner; seg=${archive}`);
    // The real child wsA is unaffected by the exclusion.
    assert.ok(tableRow(c, 'wsA'), `wsA must still have a table row; ctx=${c}`);
    assert.ok(normalChild.includes('wsA'), `wsA must still be named in the child unread segment; seg=${normalChild}`);
  } finally { h.cleanup(); }
});
