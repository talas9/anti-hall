'use strict';
// devswarm-parent-inbox (UserPromptSubmit hook). Surfaces real unread/idle
// DevSwarm workspace state to the PRIMARY, and recommends archiving workspaces the
// store marked archive_ready — never auto-archiving. Non-DevSwarm / child sessions
// and malformed stdin are silent no-ops (fail-open, exit 0).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
const { hashFromWorkspaceId } = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

const HOOK = 'devswarm-parent-inbox.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' }; // active + no source-branch = Primary

function payload() {
  return { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi' };
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

// writeWorkspace(home, id, {inbox:[lines], cursor}) — a descriptor + its durable
// inbox/cursor files. Returns the descriptor object written.
function writeWorkspace(home, id, opts = {}) {
  const root = swarmDir(home);
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  const inboxPath = path.join(root, 'inbox', id + '.ndjson');
  const cursorPath = path.join(root, 'cursor', id + '.json');
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  const inbox = opts.inbox || [];
  fs.writeFileSync(inboxPath, inbox.length ? inbox.join('\n') + '\n' : '');
  fs.writeFileSync(cursorPath, String(opts.cursor || 0));
  const d = {
    id,
    worktreePath: path.join(root, 'wt', id),
    sessionId: 'sess-' + id,
    inboxPath,
    cursorPath,
  };
  fs.writeFileSync(path.join(root, 'workspaces', id + '.json'), JSON.stringify(d));
  return d;
}

// PER-DESCRIPTOR summary: the store keys summaries/<hash>.json by EACH
// descriptor's OWN id (hashFromWorkspaceId(id)) — NOT by the hook's cwd worktree
// hash. writeSummary takes a { workspaces: { id: entry, ... }, requiredGates,
// generatedAt } shape (the same shape deriveSummary produces) and splits it into
// one hash-keyed file per id, so each descriptor's data lands where the hook
// actually looks it up regardless of the test process's cwd.
function writeSummary(home, obj) {
  const dir = path.join(swarmDir(home), 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  const workspaces = (obj && obj.workspaces) || {};
  for (const id of Object.keys(workspaces)) {
    const hash = hashFromWorkspaceId(id);
    const perId = {
      generatedAt: obj.generatedAt,
      requiredGates: obj.requiredGates,
      workspaces: { [id]: workspaces[id] },
    };
    fs.writeFileSync(path.join(dir, hash + '.json'), JSON.stringify(perId));
  }
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
    writeWorkspace(h.home, 'wsA', { inbox: ['{"m":1}', '{"m":2}'], cursor: 0 });
    const r = testHook(HOOK, payload(), { home: h.home }); // no DEVSWARM env
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('NO-OP: child workspace (DEVSWARM_SOURCE_BRANCH set) -> no stdout', () => {
  const h = makeHome();
  try {
    writeWorkspace(h.home, 'wsA', { inbox: ['{"m":1}'], cursor: 0 });
    const r = testHook(HOOK, payload(), {
      home: h.home,
      env: { ...PRIMARY_ENV, DEVSWARM_SOURCE_BRANCH: 'feature-x' },
    });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('NO-OP: Primary DevSwarm but no descriptors -> no stdout (inert)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('TABLE: descriptor with fully-consumed inbox + no stuck verdict -> live table row only (no attention/archive banner)', () => {
  const h = makeHome();
  try {
    writeWorkspace(h.home, 'wsA', { inbox: ['{"m":1}', '{"m":2}'], cursor: 2 }); // cursor==total
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV, expectJson: true });
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
    writeWorkspace(h.home, 'wsA', { inbox: ['{"m":1}', '{"m":2}', '{"m":3}'], cursor: 0 });
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV, expectJson: true });
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
    writeWorkspace(h.home, 'wsA', { inbox: ['a', 'b'], cursor: 0 });
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV, expectJson: true });
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
    writeWorkspace(h.home, 'wsA', { inbox: ['x', 'y'], cursor: 2 }); // no unread
    writeVerdict(h.home, 'wsA', { status: 'escalated' });
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(c.includes('wsA'), `stuck workspace must be surfaced; ctx=${c}`);
    assert.ok(c.includes('escalated'), `status label must appear; ctx=${c}`);
    // No unread anywhere -> no telemetry line.
    const logPath = path.join(h.home, '.anti-hall', 'devswarm', 'parent-inbox.log');
    assert.strictEqual(fs.existsSync(logPath), false, 'no telemetry when nothing unread');
  } finally { h.cleanup(); }
});

// ---- archive-ready recommendation (P1-E) ----

test('ARCHIVE: archive_ready workspace -> INFORM THE USER recommendation (never auto-archive)', () => {
  const h = makeHome();
  try {
    writeWorkspace(h.home, 'wsA', { inbox: [], cursor: 0 });
    writeSummary(h.home, { workspaces: { wsA: { archive_ready: true } } });
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    assert.ok(c.includes('DEVSWARM ARCHIVE-READY'), `expected archive banner; ctx=${c}`);
    assert.ok(c.includes('wsA'), 'must name the workspace');
    assert.ok(/INFORM THE USER/i.test(c), 'must tell the agent to inform the user');
    // cooldown state recorded so it does not repeat every turn
    const nudgePath = path.join(h.home, '.anti-hall', 'devswarm', 'archive-nudges', 'wsA.json');
    assert.ok(fs.existsSync(nudgePath), 'archive nudge cooldown must be recorded');
  } finally { h.cleanup(); }
});

test('ARCHIVE: ignore mark silences the archive reminder for that workspace only', () => {
  const h = makeHome();
  try {
    writeWorkspace(h.home, 'wsA', { inbox: [], cursor: 0 });
    writeWorkspace(h.home, 'wsB', { inbox: [], cursor: 0 });
    writeSummary(h.home, { workspaces: { wsA: { archive_ready: true }, wsB: { archive_ready: true } } });
    const igDir = path.join(h.home, '.anti-hall', 'devswarm', 'archive-ignore');
    fs.mkdirSync(igDir, { recursive: true });
    fs.writeFileSync(path.join(igDir, 'wsA.json'), '{}');
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV, expectJson: true });
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
    writeWorkspace(h.home, 'wsA', { inbox: [], cursor: 0 });
    writeSummary(h.home, { workspaces: { wsA: { archive_ready: true } } });
    const nudgeDir = path.join(h.home, '.anti-hall', 'devswarm', 'archive-nudges');
    fs.mkdirSync(nudgeDir, { recursive: true });
    fs.writeFileSync(path.join(nudgeDir, 'wsA.json'), JSON.stringify({ lastNudgedAt: Date.now() }));
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    // Cooldown suppresses the repeat NUDGE banner...
    assert.ok(!c.includes('DEVSWARM ARCHIVE-READY'), `cooldown should suppress the archive banner; ctx=${c}`);
    // ...but the live table still reports the factual archive-ready status.
    assert.ok(/archive-ready/.test(tableRow(c, 'wsA')), `table row must show archive-ready; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('PER-DESCRIPTOR SUMMARY: two workspaces with different id-hashes each resolve their OWN summary (regression for the per-project store migration bug — a single cwd-keyed summary must NOT leak across descriptors)', () => {
  const h = makeHome();
  try {
    writeWorkspace(h.home, 'wsAlpha', { inbox: [], cursor: 0 });
    writeWorkspace(h.home, 'wsBeta', { inbox: [], cursor: 0 });
    // Two DISTINCT per-descriptor summaries, each landing under its OWN
    // hashFromWorkspaceId(id) file (never a single shared summary). No cwd is
    // passed in the payload at all, so the pre-fix code — which resolved ONE
    // summary via the hook's cwd worktree hash — would have read null for BOTH
    // and shown neither as archive-ready/escalated.
    writeSummary(h.home, {
      requiredGates: ['done'],
      workspaces: {
        wsAlpha: { archive_ready: true, status: 'idle', gates: { done: true } },
        wsBeta: { archive_ready: false, status: 'escalated', gates: {} },
      },
    });
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    // wsAlpha: archive-ready + 1/1 gates, per ITS OWN summary entry.
    const archive = segment(c, 'DEVSWARM ARCHIVE-READY');
    assert.ok(archive.includes('wsAlpha'), `wsAlpha must be archive-ready from its own summary; ctx=${c}`);
    assert.ok(!archive.includes('wsBeta'), `wsBeta must NOT be archive-ready; ctx=${c}`);
    assert.ok(/\|\s*wsAlpha\s*\|\s*archive-ready\s*\|\s*1\/1\s*\|/.test(tableRow(c, 'wsAlpha')), `wsAlpha row; row=${tableRow(c, 'wsAlpha')}`);
    // wsBeta: escalated + 0/1 gates, per ITS OWN summary entry — not wsAlpha's
    // archive-ready status leaking over, and not silently null (the bug).
    assert.ok(/\|\s*wsBeta\s*\|\s*escalated\s*\|\s*0\/1\s*\|/.test(tableRow(c, 'wsBeta')), `wsBeta row; row=${tableRow(c, 'wsBeta')}`);
  } finally { h.cleanup(); }
});

// ---- live workspace table (v0.54.1) ----

test('TABLE: renders correct rows/columns for varied status + gates + unread, sorted attention-first', () => {
  const h = makeHome();
  try {
    // wsQuiet: alive, no unread, gates 1/2 + heartbeat progress -> active
    writeWorkspace(h.home, 'wsQuiet', { inbox: ['a', 'b'], cursor: 2 });
    writeHeartbeat(h.home, 'wsQuiet', { id: 'wsQuiet', ts: Date.now(), progress_pct: 40 });
    // wsStale: stale verdict + unread -> stale, attention-first
    writeWorkspace(h.home, 'wsStale', { inbox: ['x', 'y', 'z'], cursor: 0 });
    writeVerdict(h.home, 'wsStale', { status: 'stale', lastOutboundTs: Date.now() - 20 * 60 * 1000 });
    // wsDone: archive_ready, all required gates met -> archive-ready, 2/2
    writeWorkspace(h.home, 'wsDone', { inbox: [], cursor: 0 });
    writeSummary(h.home, {
      requiredGates: ['tests', 'review'],
      workspaces: {
        wsQuiet: { gates: { tests: true, review: false }, archive_ready: false },
        wsStale: { gates: {}, archive_ready: false },
        wsDone: { gates: { tests: true, review: true }, archive_ready: true },
      },
    });
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV, expectJson: true });
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

test('TABLE: no active workspaces -> no table, no stdout (inert)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
  } finally { h.cleanup(); }
});

test('TABLE: caps at 12 rows with a "+N more" note and a logged table-cap event', () => {
  const h = makeHome();
  try {
    for (let i = 0; i < 15; i++) {
      const id = 'ws' + String(i).padStart(2, '0');
      writeWorkspace(h.home, id, { inbox: [], cursor: 0 });
    }
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV, expectJson: true });
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

test('TABLE: fail-open on a malformed descriptor -> good workspace still tabled, exit 0', () => {
  const h = makeHome();
  try {
    writeWorkspace(h.home, 'wsGood', { inbox: ['a'], cursor: 0 });
    // A corrupt descriptor file alongside the good one.
    fs.writeFileSync(path.join(swarmDir(h.home), 'workspaces', 'wsBad.json'), '{not json');
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    assert.ok(tableRow(c, 'wsGood'), `good workspace must still be tabled; ctx=${c}`);
    assert.ok(!c.includes('wsBad'), 'malformed descriptor must be skipped');
  } finally { h.cleanup(); }
});

test('TABLE: coexists with the unread inbox + archive-ready banners (append, no clobber)', () => {
  const h = makeHome();
  try {
    writeWorkspace(h.home, 'wsUnread', { inbox: ['m1', 'm2'], cursor: 0 });
    writeWorkspace(h.home, 'wsDone', { inbox: [], cursor: 0 });
    writeSummary(h.home, { workspaces: { wsDone: { archive_ready: true } } });
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    const c = ctx(r);
    // All three segments present.
    assert.ok(tableSeg(c).includes('DEVSWARM WORKSPACES'), `table segment present; ctx=${c}`);
    assert.ok(segment(c, 'DEVSWARM PARENT INBOX'), `unread inbox banner present; ctx=${c}`);
    assert.ok(segment(c, 'DEVSWARM ARCHIVE-READY'), `archive banner present; ctx=${c}`);
    // Table lists both workspaces.
    assert.ok(tableRow(c, 'wsUnread'), 'table row for unread workspace');
    assert.ok(tableRow(c, 'wsDone'), 'table row for archive-ready workspace');
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

// ---- daemon-liveness staleness banner (rewired to the ingest daemon's own
// heartbeat, not summary.json's generatedAt — #21) ----
// heartbeats/ingest-<hash>.json is rewritten EVERY sweep cycle regardless of
// whether anything was inserted (writeIngestHeartbeat in devswarm-ingest.js), so a
// live-but-QUIET daemon (backlog present, no new messages) no longer false-reads
// as stale via a frozen generatedAt. `hash` = install-devswarm-ingest.js's own
// worktreeHash() of the git toplevel — the hook resolves it via a pure fs walk
// from payload.cwd (no git spawn), so passing THIS test process's own cwd (a real
// git checkout) lets both sides land on the identical hash.
const HEARTBEAT_STALE_MS = 3 * 60 * 1000; // must match HEARTBEAT_STALE_MS in the hook
const REPO_CWD = process.cwd();
const REPO_HASH = installIngest.worktreeHash(REPO_CWD);
// staleBanner(ctx) -> the '⚠ DEVSWARM STALE DATA' segment, or ''.
function staleBanner(c) {
  return c.split('\n\n').find((s) => s.includes('DEVSWARM STALE DATA')) || '';
}
// withCwd(payloadFn) -> payload object carrying this test process's own cwd, so
// the hook's fs-only worktree resolution lands on REPO_HASH.
function withCwd(payloadFn) {
  return { ...payloadFn(), cwd: REPO_CWD };
}
function writeDaemonHeartbeat(home, hash, ts) {
  const p = path.join(swarmDir(home), 'heartbeats', 'ingest-' + hash + '.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ts, workspaceId: 'primary-' + hash, workingDir: REPO_CWD, pid: 1 }));
}

test('STALE: fresh daemon heartbeat -> NO banner even with an ancient summary.generatedAt (proves the live-but-quiet fix)', () => {
  const h = makeHome();
  try {
    writeWorkspace(h.home, 'wsA', { inbox: ['a', 'b'], cursor: 0 });
    // generatedAt is WAY past the old threshold -- would have false-alarmed under
    // the pre-#21 mechanism. The heartbeat is fresh, so the rewired banner must not.
    writeSummary(h.home, { generatedAt: Date.now() - HEARTBEAT_STALE_MS * 10, workspaces: { wsA: { unread: 2 } } });
    writeDaemonHeartbeat(h.home, REPO_HASH, Date.now() - 10 * 1000);
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    assert.ok(tableSeg(c).includes('DEVSWARM WORKSPACES'), `table still present; ctx=${c}`);
    assert.strictEqual(staleBanner(c), '', `fresh heartbeat must not warn; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('STALE: heartbeat older than threshold + active descriptor -> banner ABOVE the table', () => {
  const h = makeHome();
  try {
    writeWorkspace(h.home, 'wsA', { inbox: ['a', 'b'], cursor: 0 });
    writeDaemonHeartbeat(h.home, REPO_HASH, Date.now() - (HEARTBEAT_STALE_MS + 60 * 1000));
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

test('STALE: missing heartbeat file (daemon never wrote one for this worktree) + active descriptor -> banner (additive, does not suppress the unread banner)', () => {
  const h = makeHome();
  try {
    writeWorkspace(h.home, 'wsA', { inbox: ['a', 'b', 'c'], cursor: 0 });
    // No heartbeat file written at all, and no summary.json either.
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    assert.ok(staleBanner(c), `missing heartbeat must warn; ctx=${c}`);
    assert.ok(c.includes('DEVSWARM PARENT INBOX'), `live unread still surfaced alongside; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('STALE: no active descriptor -> NO banner (nothing tabled, regardless of heartbeat state)', () => {
  const h = makeHome();
  try {
    // No descriptors at all; no heartbeat either.
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `no descriptors -> fully inert, no banner; stdout=${r.stdout}`);
  } finally { h.cleanup(); }
});

test('STALE: no cwd in payload (worktree unresolvable) -> NO banner, no throw (fail-open)', () => {
  const h = makeHome();
  try {
    writeWorkspace(h.home, 'wsA', { inbox: [], cursor: 0 });
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV, expectJson: true }); // no cwd field
    assert.strictEqual(r.status, 0);
    const c = ctx(r);
    assert.ok(tableSeg(c).includes('DEVSWARM WORKSPACES'), `table still renders; ctx=${c}`);
    assert.strictEqual(staleBanner(c), '', `unresolvable worktree -> no banner, no throw; ctx=${c}`);
  } finally { h.cleanup(); }
});

test('STALE: cwd with no enclosing git repo (bogus path) -> NO banner, no throw (fail-open)', () => {
  const h = makeHome();
  try {
    writeWorkspace(h.home, 'wsA', { inbox: [], cursor: 0 });
    const r = testHook(HOOK, { ...payload(), cwd: '/definitely-does-not-exist-anti-hall-test-root' },
      { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(staleBanner(ctx(r)), '', `no git toplevel found -> no banner; ctx=${ctx(r)}`);
  } finally { h.cleanup(); }
});

test('STALE: malformed heartbeat JSON -> treated as unknown/missing (still warns), no throw', () => {
  const h = makeHome();
  try {
    writeWorkspace(h.home, 'wsA', { inbox: [], cursor: 0 });
    const p = path.join(swarmDir(h.home), 'heartbeats', 'ingest-' + REPO_HASH + '.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not json');
    const r = testHook(HOOK, withCwd(payload), { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(staleBanner(ctx(r)), `malformed heartbeat treated as missing -> still warns; ctx=${ctx(r)}`);
  } finally { h.cleanup(); }
});
