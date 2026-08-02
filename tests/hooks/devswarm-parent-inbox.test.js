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
const replyStateLib = require('../../plugins/anti-hall/companion/lib/devswarm-reply-state.js');

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
  // orphans/staleRegistryPartitions (Phase A computeSummary) are additive and
  // OMITTED when absent, so a caller that never sets them writes the exact
  // pre-Phase-A shape (needed for the byte-identical-when-clean assertion).
  if (extra && extra.orphans !== undefined) obj.orphans = extra.orphans;
  if (extra && extra.staleRegistryPartitions !== undefined) obj.staleRegistryPartitions = extra.staleRegistryPartitions;
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

// ---- idle demotion (registry-staleness fix) ----
//
// The default "active" label is otherwise permanent: the completion gates
// (done/merged/tests_passed) are only ever set by the manual `devswarm.js gate`
// verb, and a row is only ever removed by an explicit manual `archive` — so a
// long-verified-done-but-never-archived workspace rendered "active" forever.
// This VIEW-ONLY fix demotes a long-idle row (by the already-computed
// lastActivityTs) to "idle" in the live table. It must never delete/archive the
// row, never touch gates, and must never outrank escalated/stale/archive-ready.

test('IDLE: row whose lastActivityTs is older than the default cutoff -> labeled idle, not active', () => {
  const h = makeHome();
  try {
    writeVerdict(h.home, 'wsOld', { lastOutboundTs: Date.now() - 7 * 60 * 60 * 1000 }); // 7h ago, > 6h default
    writeSharedSummary(h.home, { wsOld: { total: 0, cursor: 0, unread: 0, directUnread: 0 } });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const row = tableRow(ctx(r), 'wsOld');
    assert.ok(/\|\s*wsOld\s*\|\s*idle\s*\|/.test(row), `stale-activity row must show idle; row=${row}`);
    assert.ok(!/\bactive\b/.test(row), `must NOT still say active; row=${row}`);
  } finally { h.cleanup(); }
});

test('IDLE: row with recent activity stays active (unchanged)', () => {
  const h = makeHome();
  try {
    writeVerdict(h.home, 'wsFresh', { lastOutboundTs: Date.now() - 5 * 60 * 1000 }); // 5m ago
    writeSharedSummary(h.home, { wsFresh: { total: 0, cursor: 0, unread: 0, directUnread: 0 } });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const row = tableRow(ctx(r), 'wsFresh');
    assert.ok(/\|\s*wsFresh\s*\|\s*active\s*\|/.test(row), `fresh-activity row must stay active; row=${row}`);
  } finally { h.cleanup(); }
});

test('IDLE: escalated row that is ALSO long-idle stays escalated (precedence preserved, not demoted)', () => {
  const h = makeHome();
  try {
    writeVerdict(h.home, 'wsEsc', { status: 'escalated', lastOutboundTs: Date.now() - 30 * 60 * 60 * 1000 }); // 30h ago
    writeSharedSummary(h.home, { wsEsc: { total: 1, cursor: 0, unread: 1, directUnread: 1 } });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const row = tableRow(ctx(r), 'wsEsc');
    assert.ok(/\|\s*wsEsc\s*\|\s*escalated\s*\|/.test(row), `escalated must NOT be demoted to idle; row=${row}`);
  } finally { h.cleanup(); }
});

test('IDLE: stale row that is ALSO long-idle stays stale (precedence preserved, not demoted)', () => {
  const h = makeHome();
  try {
    writeVerdict(h.home, 'wsStaleOld', { status: 'stale', lastOutboundTs: Date.now() - 30 * 60 * 60 * 1000 }); // 30h ago
    writeSharedSummary(h.home, { wsStaleOld: { total: 0, cursor: 0, unread: 0, directUnread: 0 } });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const row = tableRow(ctx(r), 'wsStaleOld');
    assert.ok(/\|\s*wsStaleOld\s*\|\s*stale\s*\|/.test(row), `stale must NOT be demoted to idle; row=${row}`);
  } finally { h.cleanup(); }
});

test('IDLE: archive-ready row that is ALSO long-idle stays archive-ready (precedence preserved, not demoted)', () => {
  const h = makeHome();
  try {
    writeVerdict(h.home, 'wsArchOld', { lastOutboundTs: Date.now() - 30 * 60 * 60 * 1000 }); // 30h ago
    writeSharedSummary(h.home, { wsArchOld: { archive_ready: true } });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const row = tableRow(ctx(r), 'wsArchOld');
    assert.ok(/\|\s*wsArchOld\s*\|\s*archive-ready\s*\|/.test(row), `archive-ready must NOT be demoted to idle; row=${row}`);
  } finally { h.cleanup(); }
});

test('IDLE: ANTIHALL_DEVSWARM_IDLE_MS override honored (shorter cutoff demotes sooner)', () => {
  const h = makeHome();
  try {
    writeVerdict(h.home, 'wsShortCutoff', { lastOutboundTs: Date.now() - 2 * 60 * 1000 }); // 2m ago
    writeSharedSummary(h.home, { wsShortCutoff: { total: 0, cursor: 0, unread: 0, directUnread: 0 } });
    const r = testHook(HOOK, withCwd(payload), {
      home: h.home, env: { ...PRIMARY_ENV, ANTIHALL_DEVSWARM_IDLE_MS: '60000' }, expectJson: true, // 1m cutoff
    });
    assert.strictEqual(r.status, 0);
    const row = tableRow(ctx(r), 'wsShortCutoff');
    assert.ok(/\|\s*wsShortCutoff\s*\|\s*idle\s*\|/.test(row), `2m-idle must demote under a 1m override; row=${row}`);
  } finally { h.cleanup(); }
});

test('IDLE: garbage ANTIHALL_DEVSWARM_IDLE_MS -> falls back to default (6h), no crash', () => {
  const h = makeHome();
  try {
    // 2h idle: would stay active under the 6h default, would demote under any
    // small cutoff. Asserting "still active" proves the garbage value was
    // rejected in favor of the (much larger) default, not silently coerced to 0.
    writeVerdict(h.home, 'wsGarbageEnv', { lastOutboundTs: Date.now() - 2 * 60 * 60 * 1000 });
    writeSharedSummary(h.home, { wsGarbageEnv: { total: 0, cursor: 0, unread: 0, directUnread: 0 } });
    const r = testHook(HOOK, withCwd(payload), {
      home: h.home, env: { ...PRIMARY_ENV, ANTIHALL_DEVSWARM_IDLE_MS: 'not-a-number' }, expectJson: true,
    });
    assert.strictEqual(r.status, 0);
    const row = tableRow(ctx(r), 'wsGarbageEnv');
    assert.ok(/\|\s*wsGarbageEnv\s*\|\s*active\s*\|/.test(row), `garbage env must fall back to default cutoff; row=${row}`);
  } finally { h.cleanup(); }
});

test('IDLE: no activity signal at all -> stays active (unchanged fail-open default, byte-identical to pre-fix)', () => {
  const h = makeHome();
  try {
    // No writeVerdict/writeHeartbeat at all -> lastActivityTs is null.
    writeSharedSummary(h.home, { wsNoSignal: { total: 2, cursor: 2, unread: 0, directUnread: 0 } });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const row = tableRow(ctx(r), 'wsNoSignal');
    assert.ok(/\|\s*wsNoSignal\s*\|\s*active\s*\|/.test(row), `no-signal row must stay active; row=${row}`);
  } finally { h.cleanup(); }
});

test('IDLE: demoted row is never removed from the registry/summary — no archive/delete side effect', () => {
  const h = makeHome();
  try {
    writeVerdict(h.home, 'wsIdleKept', { lastOutboundTs: Date.now() - 10 * 60 * 60 * 1000 }); // 10h ago
    writeSharedSummary(h.home, { wsIdleKept: { total: 0, cursor: 0, unread: 0, directUnread: 0 } });
    const summaryFile = path.join(swarmDir(h.home), 'summaries', REPO_KEY + '.json');
    const before = fs.readFileSync(summaryFile, 'utf8');
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    // Row still present (demoted, not disappeared) in this turn's table.
    const row = tableRow(ctx(r), 'wsIdleKept');
    assert.ok(row, `idle row must remain visible in the table, not vanish; ctx=${ctx(r)}`);
    assert.ok(/\bidle\b/.test(row), `row; row=${row}`);
    // The hook is read-only w.r.t. the registry: the summary file this hook
    // reads from is byte-identical after the run (no archive/delete side effect
    // was written back through it).
    const after = fs.readFileSync(summaryFile, 'utf8');
    assert.strictEqual(after, before, 'summary/registry file must be unchanged by a read-only view hook');
    // No archive-ignore or archive-nudge state was written for this workspace
    // either — nothing in this hook's idle path calls the archive machinery.
    assert.strictEqual(fs.existsSync(path.join(swarmDir(h.home), 'archive-ignore', 'wsIdleKept.json')), false);
    assert.strictEqual(fs.existsSync(path.join(swarmDir(h.home), 'archive-nudges', 'wsIdleKept.json')), false);
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
function writeDaemonHeartbeat(home, hash, ts, pid) {
  const p = path.join(swarmDir(home), 'heartbeats', 'ingest-' + hash + '.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // pid defaults to 1 (an implausible/unrelated daemon pid) so callers that
  // don't care about the SAME-INCARNATION guard (ingest-health.js daemonHealth)
  // keep their existing behavior; a caller asserting the daemon reads
  // 'healthy' must pass the SAME pid it wrote into the lock (writeDaemonLock)
  // — real production writers (devswarm-ingest.js) always stamp both records
  // with their own process.pid, so a genuinely healthy daemon's heartbeat and
  // lock pids always already match.
  fs.writeFileSync(p, JSON.stringify({ ts, workspaceId: 'primary-' + hash, workingDir: REPO_CWD, pid: pid === undefined ? 1 : pid }));
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
    writeDaemonHeartbeat(h.home, REPO_KEY, Date.now() - 10 * 1000, process.pid); // SAME pid as the lock below — one incarnation
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

// ----- v0.66 monitor-outcome FAULT banner (daemonHealth() status:'failed' —
// alive but `hivecontrol workspace monitor` is failing, ingesting NOTHING).
// Strictly MORE severe than 'stale': the SAME wiring slot renders
// buildMonitorFaultBanner() instead of buildStaleBanner() when status is
// 'failed'. daemonHealth's status is a single mutually-exclusive string (see
// its own doc comment / companion/lib/ingest-health.js), so 'failed' and
// 'stale' can never both be true for one call — these tests lock in that only
// the monitor-fault wording renders for 'failed', never the stale wording,
// and vice versa. -----
function writeDaemonHeartbeatFull(home, hash, fields) {
  const p = path.join(swarmDir(home), 'heartbeats', 'ingest-' + hash + '.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(fields));
}
function monitorFaultBanner(c) {
  return c.split('\n\n').find((s) => s.includes('DEVSWARM INGEST FAILING')) || '';
}

test('MONITOR-FAULT: alive (fresh heartbeat + live lock) but monitor failing past threshold -> monitor-fault banner, NOT the stale banner', { skip: process.platform === 'win32' }, () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { total: 2, cursor: 0, unread: 2, directUnread: 2 } });
    writeDaemonHeartbeatFull(h.home, REPO_KEY, {
      ts: Date.now() - 5000, pid: process.pid,
      consecutiveMonitorFailures: 5, // >= MONITOR_FAILURE_FAIL_THRESHOLD (3)
      lastMonitorOkMs: null,
      lastMonitorErrorCode: 'ENOENT',
    });
    writeDaemonLock(h.home, REPO_KEY, process.pid); // SAME pid -> same incarnation, baseHealthy
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    const banner = monitorFaultBanner(c);
    assert.ok(banner, `monitor-failing daemon must render the monitor-fault banner; ctx=${c}`);
    assert.ok(/hivecontrol workspace monitor/.test(banner), banner);
    assert.ok(/5x/.test(banner), banner);
    assert.ok(/anti-hall:doctor/.test(banner), banner);
    assert.strictEqual(staleBanner(c), '', `must NOT also render the stale banner; ctx=${c}`);
    // Banner must sit ABOVE the live workspace table, same slot as the stale banner.
    const iBanner = c.indexOf('DEVSWARM INGEST FAILING');
    const iTable = c.indexOf('DEVSWARM WORKSPACES');
    assert.ok(iBanner >= 0 && iTable >= 0 && iBanner < iTable, `banner above table; ctx=${c}`);
    // exactly ONE banner segment, never two.
    const bannerSegs = c.split('\n\n').filter((s) => s.includes('DEVSWARM STALE DATA') || s.includes('DEVSWARM INGEST FAILING'));
    assert.strictEqual(bannerSegs.length, 1, `exactly one banner must render; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('MONITOR-FAULT: healthy monitor (consecutiveMonitorFailures:0) -> neither banner renders', { skip: process.platform === 'win32' }, () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { total: 2, cursor: 0, unread: 2, directUnread: 2 } });
    writeDaemonHeartbeatFull(h.home, REPO_KEY, {
      ts: Date.now() - 5000, pid: process.pid,
      consecutiveMonitorFailures: 0,
      lastMonitorOkMs: Date.now(),
    });
    writeDaemonLock(h.home, REPO_KEY, process.pid);
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    assert.strictEqual(staleBanner(c), '', `healthy daemon must not warn stale; ctx=${c}`);
    assert.strictEqual(monitorFaultBanner(c), '', `healthy daemon must not warn monitor-fault either; ctx=${c}`);
  } finally { h.cleanup(); }
});

// ---- H4 fallback (daemon-down parent-inbox freeze) interaction with the NEW
// 'failed' status: a monitor-failing daemon PREVIOUSLY read as 'healthy'
// (heartbeat+lock both fine) so it never tripped the `status !== 'healthy'`
// self-heal fallback above; it NOW reads 'failed', so it newly triggers that
// fallback too. This is DESIRABLE — a daemon ingesting nothing means its own
// periodic deriveSummary calls (devswarm-ingest.js's runIngestLoop, gated on
// `ing.inserted > 0`) have also stopped, so the materialized projection would
// otherwise freeze exactly like the pre-existing 'stale' case; the Primary
// refreshing its own projection from the store's rows is correct. These two
// tests lock in that: (1) with rows present, the fallback actually refreshes
// the projection from the store; (2) with an EMPTY store, the non-destructive
// has-rows guard still prevents a blind overwrite of a richer cache. ----
const h4Store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
function seedRegistryRow(home, id, worktreePath) {
  const s = h4Store.openStore({ home, workspaceId: id, hash: REPO_KEY });
  try {
    s.upsertRegistry({ id, worktreePath: worktreePath || REPO_CWD, sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null });
  } finally { s.close(); }
}
function readRawSummary(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(swarmDir(home), 'summaries', REPO_KEY + '.json'), 'utf8'));
  } catch (_) { return null; }
}

test('H4 x failed: status:"failed" + store WITH rows -> deriveSummary refreshes the projection from the store', { skip: process.platform === 'win32' }, () => {
  const h = makeHome();
  try {
    // Stale on-disk projection that does NOT reflect the store's real rows.
    writeSharedSummary(h.home, {});
    seedRegistryRow(h.home, 'wsFromStore', REPO_CWD); // store has a real row this projection doesn't know about yet
    writeDaemonHeartbeatFull(h.home, REPO_KEY, {
      ts: Date.now() - 5000, pid: process.pid,
      consecutiveMonitorFailures: 5,
      lastMonitorOkMs: null,
      lastMonitorErrorCode: 'ENOENT',
    });
    writeDaemonLock(h.home, REPO_KEY, process.pid);
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const raw = readRawSummary(h.home);
    assert.ok(raw && raw.workspaces && Object.prototype.hasOwnProperty.call(raw.workspaces, 'wsFromStore'),
      `'failed' status must trigger the H4 fallback and refresh the projection from the store; raw=${JSON.stringify(raw)}`);
  } finally { h.cleanup(); }
});

test('H4 x failed: status:"failed" + EMPTY store -> non-destructive guard prevents blanking a richer existing cache', { skip: process.platform === 'win32' }, () => {
  const h = makeHome();
  try {
    // Richer existing projection, but the store backing THIS repoKey is empty
    // (e.g. store file never created / reset) — an out-of-band writer left it.
    writeSharedSummary(h.home, { wsRicher: { total: 3, cursor: 0, unread: 3, directUnread: 3 } });
    writeDaemonHeartbeatFull(h.home, REPO_KEY, {
      ts: Date.now() - 5000, pid: process.pid,
      consecutiveMonitorFailures: 5,
      lastMonitorOkMs: null,
      lastMonitorErrorCode: 'ENOENT',
    });
    writeDaemonLock(h.home, REPO_KEY, process.pid);
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const raw = readRawSummary(h.home);
    assert.ok(raw && raw.workspaces && Object.prototype.hasOwnProperty.call(raw.workspaces, 'wsRicher'),
      `an empty store must NOT blank/overwrite the existing richer cache; raw=${JSON.stringify(raw)}`);
  } finally { h.cleanup(); }
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

// ---- §4.5 decide+reply gate: the Primary's own unread pendingQuestions ----
// buildOwnUnreadSegment previously only ever said "STOP and read ... FIRST".
// This is the CORE fix for claim 1: this hook fires on EVERY UserPromptSubmit
// turn (unlike the SessionStart-only devswarm-child-role.js injection), so
// once the decide+reply wording is wired here it survives context compaction
// — a Primary mid-session, post-compaction, still sees "DECIDE and REPLY" (not
// just "read") on its very next turn if a question remains unanswered. These
// tests invoke the hook FRESH (no prior SessionStart context in scope at all,
// simulating post-compaction) and assert purely on THIS hook's own output.

test('OWN UNREAD DECIDE+REPLY (§4.5): unanswered pendingQuestion on own entry -> per-turn injection carries decide+reply wording (simulated post-compaction, no prior reply-state)', () => {
  const h = makeHome();
  try {
    const askTs = Date.now() - 60000;
    writeSharedSummary(h.home, {
      [OWN_ID]: {
        total: 1, cursor: 0, unread: 1, directUnread: 1,
        pendingQuestions: [{ from: 'child-a', ts: askTs, seq: 1 }],
      },
    });
    // No reply-state file at all — nothing has ever been recorded for this
    // session, the same shape post-compaction leaves behind (this hook's own
    // output is asserted independent of any other hook/session state).
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const own = ownSegment(ctx(r));
    assert.ok(own, `own segment expected; ctx=${ctx(r)}`);
    assert.match(own, /DECIDE/, `must instruct DECIDE; own=${own}`);
    assert.match(own, /send --to/, `must name the send --to reply command; own=${own}`);
    assert.ok(own.includes('child-a'), `must name the asker's id; own=${own}`);
    assert.match(own, /NOT SUFFICIENT/i, `must state that reading alone is not sufficient; own=${own}`);
    // Small fix #2 (Round 2 review): the reply-target label is now `<id>`,
    // not `<meshId>` — the resolved value is a registry row id, not
    // necessarily the sender's raw meshId.
    assert.ok(own.includes('<id>'), `must label the reply target as <id>; own=${own}`);
    assert.ok(!own.includes('<meshId>'), `must NOT use the misleading <meshId> label; own=${own}`);
  } finally { h.cleanup(); }
});

test('OWN UNREAD DECIDE+REPLY: a recorded reply for the asker clears the decide+reply wording, falls back to plain read wording', () => {
  const h = makeHome();
  try {
    const askTs = Date.now() - 60000;
    writeSharedSummary(h.home, {
      [OWN_ID]: {
        total: 1, cursor: 0, unread: 1, directUnread: 1,
        pendingQuestions: [{ from: 'child-a', ts: askTs, seq: 1 }],
      },
    });
    // Reply recorded under REPO_KEY (the durable per-project key the hook now
    // reads via — see the PER-PROJECT SCOPING fix), AFTER the question's ts,
    // for the exact asker — genuinely answered. No longer keyed by
    // session_id ('t').
    replyStateLib.recordReply(REPO_KEY, h.home, 'child-a', askTs + 1000);
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const own = ownSegment(ctx(r));
    // ownUnread (1) is independent of pendingQuestions/reply-state (this hook
    // has no store access to decrement it on its own), so the own segment
    // still surfaces — but with the PLAIN read wording, no longer nagging
    // DECIDE/REPLY once genuinely answered.
    assert.ok(own, `own segment still present (unread still > 0); ctx=${ctx(r)}`);
    assert.ok(!/DECIDE/.test(own), `must not nag DECIDE once genuinely answered; own=${own}`);
    assert.ok(!/NOT SUFFICIENT/i.test(own), `must not claim reading is insufficient once answered; own=${own}`);
    assert.match(own, /STOP and read your unread parent\/peer message\(s\) FIRST/, `falls back to plain read wording; own=${own}`);
  } finally { h.cleanup(); }
});

// BUG 1a FIX: reply-state is now keyed by the durable per-project REPO_KEY
// (resolved from `cwd`), not the short-lived Claude `session_id` — a reply
// recorded while one session was active must still clear the decide+reply
// nag when a COMPLETELY DIFFERENT session_id (same project/cwd) checks next.
test('BUG 1a FIX: a reply recorded under one session_id clears the decide+reply nag for a COMPLETELY DIFFERENT session_id, same project', () => {
  const h = makeHome();
  try {
    const askTs = Date.now() - 60000;
    writeSharedSummary(h.home, {
      [OWN_ID]: {
        total: 1, cursor: 0, unread: 1, directUnread: 1,
        pendingQuestions: [{ from: 'child-a', ts: askTs, seq: 1 }],
      },
    });
    const payloadSessionA = { hook_event_name: 'UserPromptSubmit', session_id: 'session-A-original', prompt: 'hi', cwd: REPO_CWD };
    const payloadSessionB = { hook_event_name: 'UserPromptSubmit', session_id: 'session-B-totally-unrelated', prompt: 'hi', cwd: REPO_CWD };

    const before = testHook(HOOK, payloadSessionA, { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.match(ownSegment(ctx(before)), /DECIDE/, 'must nag DECIDE under session A before any reply is recorded');

    // The reply-tracker hook (§4.3) would record this — keyed by repoKey, not
    // by whichever session_id happened to be active when the reply was sent.
    replyStateLib.recordReply(REPO_KEY, h.home, 'child-a', askTs + 1000);

    // A BRAND NEW Claude session (session-B, same project) must see the reply
    // — not start over with an empty, session-scoped reply-state file and
    // resurrect the question as unanswered.
    const after = testHook(HOOK, payloadSessionB, { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const ownAfter = ownSegment(ctx(after));
    assert.ok(!/DECIDE/.test(ownAfter), `a fresh session_id for the SAME project must see the question as already answered; own=${ownAfter}`);
  } finally { h.cleanup(); }
});

test('OWN UNREAD DECIDE+REPLY REGRESSION GUARD: read-and-acked (unread=0) but a pendingQuestion is still unanswered -> decide+reply segment STILL surfaces', () => {
  const h = makeHome();
  try {
    const askTs = Date.now() - 60000;
    // unread: 0 (fully drained/acked, cursor caught up to total) — but the
    // pendingQuestions entry has NO matching reply-state entry, so it is still
    // genuinely unanswered under the mesh semantics (pendingQuestions no
    // longer clears on read; only a recorded reply clears it). This is the
    // exact regression class: a Primary that reads/acks a question but never
    // replies must still see the decide+reply nag on the next turn.
    writeSharedSummary(h.home, {
      [OWN_ID]: {
        total: 1, cursor: 1, unread: 0, directUnread: 0,
        pendingQuestions: [{ from: 'child-a', ts: askTs, seq: 1 }],
      },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const own = ownSegment(ctx(r));
    assert.ok(own, `own segment must still surface when unread=0 but a question remains unanswered; ctx=${ctx(r)}`);
    assert.match(own, /DECIDE/, `must instruct DECIDE even with unread=0; own=${own}`);
    assert.match(own, /send --to/, `must name the send --to reply command; own=${own}`);
    assert.ok(own.includes('child-a'), `must name the asker's meshId; own=${own}`);
    assert.match(own, /NOT SUFFICIENT/i, `must state that reading alone is not sufficient; own=${own}`);
  } finally { h.cleanup(); }
});

test('OWN UNREAD DECIDE+REPLY REGRESSION: plain unread with no pendingQuestions is byte-identical to the pre-§4.5 wording', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { [OWN_ID]: { total: 4, cursor: 0, unread: 4, directUnread: 4 } });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const own = ownSegment(ctx(r));
    const cliPath = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'devswarm.js');
    const expected =
      'DEVSWARM OWN INBOX — PRIORITY: you have 4 unread parent/peer '
      + 'message(s) addressed to YOU (the Primary). STOP and read your unread '
      + 'parent/peer message(s) FIRST before continuing. Read them the SAFE, '
      + 'NON-DRAINING way — `node ' + cliPath + ' inbox read-primary ' + OWN_ID + '` (anti-hall '
      + 'devswarm CLI). Do NOT run `hivecontrol workspace read-messages` or '
      + '`monitor` — those DESTRUCTIVELY drain the native queue.';
    assert.strictEqual(own, expected, `no-pendingQuestions wording must be unchanged; own=${own}`);
  } finally { h.cleanup(); }
});

test('OWN UNREAD DECIDE+REPLY: multiple unanswered askers are all named, capped at MAX_LISTED like every other list in this file', () => {
  const h = makeHome();
  try {
    const askTs = Date.now() - 60000;
    const pendingQuestions = [];
    for (let i = 0; i < 8; i++) pendingQuestions.push({ from: 'child-' + i, ts: askTs, seq: i });
    writeSharedSummary(h.home, {
      [OWN_ID]: { total: 8, cursor: 0, unread: 8, directUnread: 8, pendingQuestions },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const own = ownSegment(ctx(r));
    assert.match(own, /DECIDE/, `own=${own}`);
    for (let i = 0; i < 6; i++) assert.ok(own.includes('child-' + i), `must name child-${i}; own=${own}`);
    assert.ok(own.includes('+2 more'), `must cap at 6 with a "+N more" suffix; own=${own}`);
  } finally { h.cleanup(); }
});

test('OWN UNREAD DECIDE+REPLY FAIL-OPEN: a corrupt reply-state file does not throw and does not suppress the decide/reply wording', () => {
  const h = makeHome();
  try {
    const askTs = Date.now() - 60000;
    writeSharedSummary(h.home, {
      [OWN_ID]: {
        total: 1, cursor: 0, unread: 1, directUnread: 1,
        pendingQuestions: [{ from: 'child-a', ts: askTs, seq: 1 }],
      },
    });
    // Malformed reply-state file for THIS project's repoKey — must fail open
    // toward "unanswered" (the lib's own contract), never crash the hook,
    // never be silently read as "already answered".
    const p = replyStateLib.replyStatePathFor(REPO_KEY, h.home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{ not valid json ][');
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0, 'hook must never throw / exit non-zero on a corrupt reply-state file');
    const own = ownSegment(ctx(r));
    assert.match(own, /DECIDE/, `corrupt reply-state must fail OPEN toward still showing decide/reply; own=${own}`);
    assert.match(own, /send --to/, `own=${own}`);
  } finally { h.cleanup(); }
});

test('OWN UNREAD DECIDE+REPLY FAIL-OPEN: malformed pendingQuestions entries (missing/garbage shape) still surface as unanswered, never throw', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      [OWN_ID]: {
        total: 1, cursor: 0, unread: 1, directUnread: 1,
        // Deliberately malformed entries: a bare string and an object missing
        // both `from`/`ts` — the shared lib's own contract keeps any entry
        // that isn't a well-formed {from, ts} object as unanswered.
        pendingQuestions: ['garbage', { bogus: true }],
      },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0, 'hook must never throw on a malformed pendingQuestions shape');
    const own = ownSegment(ctx(r));
    assert.match(own, /DECIDE/, `malformed pendingQuestions entries must still fail open toward decide/reply; own=${own}`);
  } finally { h.cleanup(); }
});

test('OWN UNREAD DECIDE+REPLY FAIL-OPEN: pendingQuestions not an array at all (top-level malformed) -> defaults to [], no throw, no decide/reply nag', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {
      [OWN_ID]: { total: 2, cursor: 0, unread: 2, directUnread: 2, pendingQuestions: 'not-an-array' },
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0, 'hook must never throw on a non-array pendingQuestions field');
    const own = ownSegment(ctx(r));
    assert.ok(own, `own segment still present (plain unread); ctx=${ctx(r)}`);
    assert.ok(!/DECIDE/.test(own), `no structured question data -> no decide/reply nag; own=${own}`);
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

// ---------------------------------------------------------------------------
// P1 fix: the Primary's cwd is its own PROJECT WORKTREE, not the plugin root,
// so a bare/relative `devswarm.js` reference in emitted text (this hook never
// even said `node scripts/devswarm.js` — every mention was a bare `devswarm.js`
// with no interpreter or path at all) is unrunnable there. Every emitted
// instruction must now carry an ABSOLUTE, existing `node <cli>` invocation.

function assertAbsoluteExistingCliPaths(c, { min } = {}) {
  const matches = [...c.matchAll(/`node ([^`]*?devswarm\.js)\b/g)];
  assert.ok(matches.length >= (min || 1), `expected node devswarm.js instruction(s); ctx=${c}`);
  for (const m of matches) {
    const cliPath = m[1];
    assert.ok(path.isAbsolute(cliPath), `emitted CLI path must be absolute, not relative: ${cliPath}`);
    assert.ok(fs.existsSync(cliPath), `emitted CLI path must exist on disk: ${cliPath}`);
    assert.ok(cliPath.endsWith(path.join('scripts', 'devswarm.js')), `must resolve to scripts/devswarm.js: ${cliPath}`);
  }
}

test('P1 FIX: standard unread (PARENT INBOX) segment carries an ABSOLUTE, existing devswarm.js path', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { total: 3, cursor: 0, unread: 3, directUnread: 3 } });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assertAbsoluteExistingCliPaths(segment(ctx(r), 'DEVSWARM PARENT INBOX'));
  } finally { h.cleanup(); }
});

test('P1 FIX: urgent unread (URGENT INBOX) segment carries an ABSOLUTE, existing devswarm.js path', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsUrgent: { total: 1, cursor: 0, unread: 1, directUnread: 1, urgencyMax: 'urgent' } });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assertAbsoluteExistingCliPaths(segment(ctx(r), 'DEVSWARM URGENT INBOX'));
  } finally { h.cleanup(); }
});

test('P1 FIX: own-unread (OWN INBOX) segment carries an ABSOLUTE, existing devswarm.js path', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { [OWN_ID]: { total: 4, cursor: 0, unread: 4, directUnread: 4 } });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assertAbsoluteExistingCliPaths(ownSegment(ctx(r)));
  } finally { h.cleanup(); }
});

test('P1 FIX: archive-ready segment carries an ABSOLUTE, existing devswarm.js path', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, { wsA: { archive_ready: true } });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assertAbsoluteExistingCliPaths(segment(ctx(r), 'DEVSWARM ARCHIVE-READY'));
  } finally { h.cleanup(); }
});

// ---- stuck-mesh surfacing (orphans[] / staleRegistryPartitions[], Phase A) ----
// LEAN render-only additions: computeSummary's A2 (orphaned partitions with real
// unread but no live registry row) and A3 (registry rows whose worktreePath no
// longer exists) are additive summary fields. This hook only RENDERS them —
// no writes, no auto-forward/delete, no persisted cooldown state; the
// MAX_MESH_ISSUES cap is the only anti-spam.

function orphanSeg(c) {
  return segment(c, '⚠ DEVSWARM ORPHANED MESH');
}
function staleRegistrySeg(c) {
  return segment(c, '⚠ DEVSWARM STALE WORKSPACE(S)');
}

test('ORPHANS: summary.orphans -> renders orphan line with ids + unread counts', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {}, {
      orphans: [
        { id: 'orphan-a', messageCount: 5, unread: 5 },
        { id: 'orphan-b', messageCount: 2, unread: 2 },
      ],
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    const seg = orphanSeg(c);
    assert.ok(seg, `expected orphan segment; ctx=${c}`);
    assert.ok(seg.includes('orphan-a (5 unread)'), `must name orphan-a with its unread; seg=${seg}`);
    assert.ok(seg.includes('orphan-b (2 unread)'), `must name orphan-b with its unread; seg=${seg}`);
    assert.ok(/no live workspace/.test(seg), `must explain no live reader; seg=${seg}`);
  } finally { h.cleanup(); }
});

test('STALE-REGISTRY: summary.staleRegistryPartitions -> renders stale-workspace line with ids + unread counts', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {}, {
      staleRegistryPartitions: [
        { id: 'gone-ws', worktreePath: '/no/such/path', unread: 3 },
      ],
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    const seg = staleRegistrySeg(c);
    assert.ok(seg, `expected stale-registry segment; ctx=${c}`);
    assert.ok(seg.includes('gone-ws (3 unread)'), `must name gone-ws with its unread; seg=${seg}`);
    assert.ok(/worktree is gone/.test(seg), `must explain the worktree is gone; seg=${seg}`);
  } finally { h.cleanup(); }
});

test('ORPHANS+STALE: clean summary (neither field present) -> BYTE-IDENTICAL to the pre-Phase-A output (no new segments)', () => {
  const h = makeHome();
  try {
    // Fresh heartbeat + live lock (this test process's own pid) deterministically
    // suppresses the daemon staleness banner (same technique as the STALE suite
    // above), so the only variable segment is the CLI's own absolute path.
    writeSharedSummary(h.home, { wsA: { total: 2, cursor: 0, unread: 2, directUnread: 2 } });
    writeDaemonHeartbeat(h.home, REPO_KEY, Date.now() - 10 * 1000, process.pid); // SAME pid as the lock below — one incarnation
    writeDaemonLock(h.home, REPO_KEY, process.pid);
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    const cliPath = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'devswarm.js');
    const expected = [
      OVERRIDE_REASSERT,
      'DEVSWARM WORKSPACES (live — refreshed every turn):\n'
        + '| workspace | status | finish | unread | last |\n'
        + '|---|---|---|---|---|\n'
        + '| wsA | active | — | 2 | — |',
      'DEVSWARM PARENT INBOX: 1 active workspace(s) need attention — wsA (2 unread). '
        + 'STOP and read each unread workspace\'s inbox message(s) FIRST via `node '
        + cliPath + ' inbox read <id>` before continuing (or reassign/archive it). '
        + 'A workspace flagged stale/escalated has a wedged child — check on it.',
    ].join('\n\n');
    assert.strictEqual(c, expected, `clean summary must be byte-identical to pre-Phase-A output; ctx=${c}`);
    assert.ok(!c.includes('ORPHANED MESH'), 'no orphan segment expected');
    assert.ok(!c.includes('STALE WORKSPACE(S)'), 'no stale-registry segment expected');
  } finally { h.cleanup(); }
});

test('ORPHANS+STALE: non-DevSwarm session with both fields populated -> unchanged no-op, no throw', () => {
  const h = makeHome();
  try {
    writeSharedSummary(h.home, {}, {
      orphans: [{ id: 'orphan-a', messageCount: 1, unread: 1 }],
      staleRegistryPartitions: [{ id: 'gone-ws', worktreePath: '/no/such/path', unread: 1 }],
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home }); // no DEVSWARM env
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('ORPHANS: cap at MAX_MESH_ISSUES(5) -> shows 5, sorted by unread desc, "+K more" for the rest', () => {
  const h = makeHome();
  try {
    const orphans = [];
    for (let i = 0; i < 8; i++) orphans.push({ id: 'orphan-' + i, messageCount: i + 1, unread: i + 1 });
    writeSharedSummary(h.home, {}, { orphans });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    const seg = orphanSeg(c);
    assert.ok(seg, `expected orphan segment; ctx=${c}`);
    // Highest-unread 5 (orphan-7..orphan-3) shown; the rest folded into "+3 more".
    for (const id of ['orphan-7', 'orphan-6', 'orphan-5', 'orphan-4', 'orphan-3']) {
      assert.ok(seg.includes(id), `${id} must be shown (top-5 by unread); seg=${seg}`);
    }
    for (const id of ['orphan-2', 'orphan-1', 'orphan-0']) {
      assert.ok(!seg.includes(id), `${id} must be folded into "+more"; seg=${seg}`);
    }
    assert.ok(/\+3 more/.test(seg), `expected "+3 more" suffix; seg=${seg}`);
  } finally { h.cleanup(); }
});

test('STALE-REGISTRY: cap at MAX_MESH_ISSUES(5) -> shows 5 + "+K more"', () => {
  const h = makeHome();
  try {
    const staleRegistryPartitions = [];
    for (let i = 0; i < 7; i++) {
      staleRegistryPartitions.push({ id: 'gone-' + i, worktreePath: '/no/such/' + i, unread: i + 1 });
    }
    writeSharedSummary(h.home, {}, { staleRegistryPartitions });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    const seg = staleRegistrySeg(c);
    assert.ok(seg, `expected stale-registry segment; ctx=${c}`);
    assert.ok(/\+2 more/.test(seg), `expected "+2 more" suffix; seg=${seg}`);
  } finally { h.cleanup(); }
});

test('ORPHANS+STALE: malformed/absent fields -> no throw, nothing extra rendered', () => {
  const h = makeHome();
  try {
    // orphans is not an array at all (malformed shape); staleRegistryPartitions
    // is an array of garbage entries (missing/unsafe id) — both must be silently
    // dropped, never thrown.
    writeSharedSummary(h.home, { wsA: { total: 1, cursor: 0, unread: 1, directUnread: 1 } }, {
      orphans: 'not-an-array',
      staleRegistryPartitions: [{ unread: 5 }, { id: '../../etc/passwd', unread: 5 }, null],
    });
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    assert.ok(!c.includes('ORPHANED MESH'), `malformed orphans must render nothing; ctx=${c}`);
    assert.ok(!c.includes('STALE WORKSPACE(S)'), `all-unsafe stale entries must render nothing; ctx=${c}`);
    // The rest of the hook still functions normally (unaffected by the malformed fields).
    assert.ok(c.includes('DEVSWARM PARENT INBOX'), `unrelated segments must still render; ctx=${c}`);
  } finally { h.cleanup(); }
});
