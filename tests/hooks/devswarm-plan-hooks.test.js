'use strict';
// Meeseeks supervision P1 — the hook surfaces of plan tracking:
//   - devswarm-parent-inbox: a row whose workspace has a plan shows
//     "step N/M · … · progress … ago" in the finish column; its neighbours
//     without a plan keep "working"/"working (N%)".
//   - devswarm-child-turn: a child with a plan is told its current step and
//     the `heartbeat --step` command; a child without one gets no plan text
//     unless devswarm.planRequired is on.
// Isolated HOME per test.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const planLib = require('../../plugins/anti-hall/companion/lib/devswarm-plan.js');

const REPO_CWD = process.cwd();
const REPO_KEY = repokey.repoKeyForWorktree(REPO_CWD);
const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
const CHILD_ENV = { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main', DEVSWARM_BUILDER_ID: 'child-p' };

function ctxOf(r) { return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || ''; }
function tableRow(c, id) {
  const seg = c.split('\n\n').find((s) => s.replace(/^\S+ anti-hall \u00B7 /, '').startsWith('devswarm-workspaces')) || '';
  return seg.split('\n').find((l) => l.startsWith('| ' + id + ' ')) || '';
}
function writeSummary(home, workspaces) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'summaries');
  fs.mkdirSync(dir, { recursive: true });
  const ws = {};
  for (const [id, e] of Object.entries(workspaces)) {
    ws[id] = Object.assign({ worktreePath: REPO_CWD, sessionId: null, total: 0, cursor: 0, unread: 0, directUnread: 0,
      broadcastUnread: 0, urgencyMax: null, working_on: null, gates: {}, archive_ready: false }, e);
  }
  fs.writeFileSync(path.join(dir, REPO_KEY + '.json'), JSON.stringify({ generatedAt: Date.now(), requiredGates: [], workspaces: ws, recent: [], archivedRegistryRows: [] }));
}
function writeHeartbeat(home, id, beat) {
  const p = path.join(home, '.anti-hall', 'devswarm', 'heartbeats', id + '.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(beat));
}
function seedPlan(home, key, steps, mutate) {
  const now = Date.now();
  const plan = planLib.newPlan({ key, id: key, steps, now: now - 50 * 60000 });
  if (mutate) mutate(plan, now);
  planLib.savePlan(home, key, plan);
  return plan;
}

test('parent-inbox: a plan row shows its step label; rows without a plan are unchanged', () => {
  const h = makeHome();
  try {
    writeHeartbeat(h.home, 'wsPlan', { id: 'wsPlan', ts: Date.now(), progress_pct: 10 });
    writeHeartbeat(h.home, 'wsPct', { id: 'wsPct', ts: Date.now(), progress_pct: 40 });
    writeSummary(h.home, { wsPlan: {}, wsPct: {}, wsBare: {} });
    seedPlan(h.home, 'wsPlan', ['read', 'fix', 'test'], (p, now) => {
      planLib.applyStep(p, 1, 'done', now - 30 * 60000);
      planLib.applyStep(p, 2, 'doing', now - 20 * 60000);
    });
    const r = testHook('devswarm-parent-inbox.js', { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: REPO_CWD },
      { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctxOf(r);
    assert.ok(/\|\s*1\/3 done · doing #2 · 20m · progress 20m ago\s*\|/.test(tableRow(c, 'wsPlan')), 'plan row: ' + tableRow(c, 'wsPlan'));
    assert.ok(/\|\s*working \(40%\)\s*\|/.test(tableRow(c, 'wsPct')), 'no-plan row keeps its old cell: ' + tableRow(c, 'wsPct'));
    assert.ok(/\|\s*working\s*\|/.test(tableRow(c, 'wsBare')), 'no-plan row keeps its old cell: ' + tableRow(c, 'wsBare'));

    // planTracking off -> the plan row falls back to its old cell too.
    const off = testHook('devswarm-parent-inbox.js', { hook_event_name: 'UserPromptSubmit', session_id: 't2', prompt: 'hi', cwd: REPO_CWD },
      { home: h.home, env: Object.assign({ ANTIHALL_DEVSWARM_PLAN_TRACKING: '0' }, PRIMARY_ENV), expectJson: true });
    assert.ok(/\|\s*working \(10%\)\s*\|/.test(tableRow(ctxOf(off), 'wsPlan')), 'off: ' + tableRow(ctxOf(off), 'wsPlan'));
  } finally { h.cleanup(); }
});

test('child-turn: plan segment names the current step and the heartbeat --step command; none without a plan', () => {
  const h = makeHome();
  try {
    const payload = { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'go', cwd: '/tmp' };
    const bare = testHook('devswarm-child-turn.js', payload, { home: h.home, env: CHILD_ENV, expectJson: true });
    assert.ok(!ctxOf(bare).includes('devswarm-plan'), 'no plan -> no plan text (byte-identical to before)');

    const req = testHook('devswarm-child-turn.js', Object.assign({}, payload, { session_id: 's2' }),
      { home: h.home, env: Object.assign({ ANTIHALL_DEVSWARM_PLAN_REQUIRED: '1' }, CHILD_ENV), expectJson: true });
    assert.ok(ctxOf(req).includes('💡 anti-hall · devswarm-plan: you have no step plan yet'), ctxOf(req));
    assert.ok(ctxOf(req).includes('plan set child-p'));

    seedPlan(h.home, 'child-p', ['read', 'fix'], (p, now) => planLib.applyStep(p, 1, 'doing', now));
    const withPlan = testHook('devswarm-child-turn.js', Object.assign({}, payload, { session_id: 's3' }), { home: h.home, env: CHILD_ENV, expectJson: true });
    const c = ctxOf(withPlan);
    assert.ok(c.includes('💡 anti-hall · devswarm-plan: 0/2 steps done; latest touched step 1 — "read".'), c);
    assert.ok(c.includes('heartbeat child-p --step N --status doing|done|blocked'), c);
  } finally { h.cleanup(); }
});

test('parent-inbox: successive roster renders of an out-of-order parallel wave never show a falling done count or a "step i/N" index', () => {
  const h = makeHome();
  try {
    writeHeartbeat(h.home, 'wsWave', { id: 'wsWave', ts: Date.now(), progress_pct: 10 });
    writeSummary(h.home, { wsWave: {} });
    const steps = Array.from({ length: 12 }, (_, i) => 'item ' + (i + 1));
    const touches = [[1, 'doing'], [3, 'doing'], [7, 'doing'], [6, 'doing'], [1, 'done'], [9, 'done'], [2, 'doing'], [4, 'done'], [2, 'done'], [12, 'done']];
    const plan = planLib.newPlan({ key: 'wsWave', id: 'wsWave', steps, now: Date.now() - 60 * 60000 });
    const rows = [];
    touches.forEach(([n, st], i) => {
      planLib.applyStep(plan, n, st, Date.now() - (30 - i) * 60000);
      planLib.savePlan(h.home, 'wsWave', plan);
      const r = testHook('devswarm-parent-inbox.js', { hook_event_name: 'UserPromptSubmit', session_id: 'wave' + i, prompt: 'hi', cwd: REPO_CWD },
        { home: h.home, env: PRIMARY_ENV, expectJson: true });
      rows.push(tableRow(ctxOf(r), 'wsWave'));
    });
    const done = rows.map((row) => { const m = /\|\s*(\d+)\/12 done/.exec(row); assert.ok(m, 'row has an N/12 done headline: ' + row); return Number(m[1]); });
    assert.deepStrictEqual(done, [0, 0, 0, 0, 1, 2, 2, 3, 4, 5]);
    for (const row of rows) assert.doesNotMatch(row, /\|\s*step \d+\//, row);
    assert.match(rows[3], /0\/12 done · 4 doing/);
  } finally { h.cleanup(); }
});
