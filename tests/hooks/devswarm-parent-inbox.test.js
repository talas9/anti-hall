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

const HOOK = 'devswarm-parent-inbox.js';
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' }; // active + no source-branch = Primary

function payload() {
  return { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi' };
}
function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
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

function writeSummary(home, obj) {
  fs.writeFileSync(path.join(swarmDir(home), 'summary.json'), JSON.stringify(obj));
}
function writeVerdict(home, id, verdict) {
  const p = path.join(swarmDir(home), 'liveness', id + '.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(verdict));
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

test('NO-OP: descriptor with fully-consumed inbox + no stuck verdict -> no stdout', () => {
  const h = makeHome();
  try {
    writeWorkspace(h.home, 'wsA', { inbox: ['{"m":1}', '{"m":2}'], cursor: 2 }); // cursor==total
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
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
    assert.ok(c.includes('DEVSWARM ARCHIVE-READY'), `archive banner expected for wsB; ctx=${c}`);
    assert.ok(!c.includes('wsA'), `ignored workspace must not be surfaced; ctx=${c}`);
    assert.ok(c.includes('wsB'), 'non-ignored workspace must still be surfaced');
  } finally { h.cleanup(); }
});

test('ARCHIVE: recent nudge within cooldown -> not repeated', () => {
  const h = makeHome();
  try {
    writeWorkspace(h.home, 'wsA', { inbox: [], cursor: 0 });
    writeSummary(h.home, { workspaces: { wsA: { archive_ready: true } } });
    const nudgeDir = path.join(h.home, '.anti-hall', 'devswarm', 'archive-nudges');
    fs.mkdirSync(nudgeDir, { recursive: true });
    fs.writeFileSync(path.join(nudgeDir, 'wsA.json'), JSON.stringify({ lastNudgedAt: Date.now() }));
    const r = testHook(HOOK, payload(), { home: h.home, env: PRIMARY_ENV });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '', `cooldown should suppress; got: ${r.stdout}`);
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
