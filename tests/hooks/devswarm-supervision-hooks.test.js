'use strict';
// Meeseeks supervision P2 — the hook surfaces of straying supervision:
//   - devswarm-parent-inbox: a plan row with self-tagged extras / an active
//     straying warning gains "· +N extra(s)" / "· STRAYING: <signals>"; a plan
//     row with neither renders exactly the P1 label, and rows without a plan
//     keep their old cell;
//   - devswarm-parent-gate: one advisory devswarm-straying line per warning
//     per Primary session (never a block); no stray state -> no line;
//   - devswarm-child-turn: a child with a plan is told to `scope add` extra
//     work a user asks for.
// Isolated HOME per test.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
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
function seedStray(home, key, active) {
  planLib.saveStray(home, key, { v: 1, key, id: key, worktreePath: path.join(home, 'wt', key), warned: {}, perStep: {}, active, updated_at: Date.now() });
}
const stallEntry = { key: 'stall:2:1', signal: 'stall', step: 2, reason: 'no step progress 40m', at: Date.now(), n: 1 };

test('parent-inbox: extras and straying ride on the plan cell; a plain plan row is unchanged', () => {
  const h = makeHome();
  try {
    const mut = (p, now) => { planLib.applyStep(p, 1, 'done', now - 30 * 60000); planLib.applyStep(p, 2, 'doing', now - 20 * 60000); };
    for (const id of ['wsPlain', 'wsExtra', 'wsStray']) {
      writeHeartbeat(h.home, id, { id, ts: Date.now(), progress_pct: 10 });
      seedPlan(h.home, id, ['read', 'fix', 'test'], mut);
    }
    writeHeartbeat(h.home, 'wsBare', { id: 'wsBare', ts: Date.now(), progress_pct: 40 });
    const extra = planLib.findPlan(h.home, { id: 'wsExtra' });
    planLib.addExtra(extra.plan, 'docs/**', 'user asked for docs', Date.now());
    planLib.savePlan(h.home, extra.key, extra.plan);
    seedStray(h.home, 'wsStray', [stallEntry]);
    seedStray(h.home, 'wsPlain', []);
    const tokDir = path.join(h.home, '.anti-hall', 'devswarm', 'token-usage');
    fs.mkdirSync(tokDir, { recursive: true });
    fs.writeFileSync(path.join(tokDir, 'wsStray.json'), JSON.stringify({ v: 1, total: 1800000, sinceStep: 90000 }));
    fs.writeFileSync(path.join(tokDir, 'wsPlain.json'), JSON.stringify({ v: 1, total: 0, sinceStep: 0 }));
    writeSummary(h.home, { wsPlain: {}, wsExtra: {}, wsStray: {}, wsBare: {} });
    const r = testHook('devswarm-parent-inbox.js', { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: REPO_CWD },
      { home: h.home, env: PRIMARY_ENV, expectJson: true });
    assert.strictEqual(r.status, 0);
    const c = ctxOf(r);
    assert.ok(/\|\s*1\/3 done · doing #2 · 20m · progress 20m ago\s*\|/.test(tableRow(c, 'wsPlain')), 'plain plan row = plan label: ' + tableRow(c, 'wsPlain'));
    assert.ok(/\|\s*1\/3 done · doing #2 · 20m · progress 20m ago · \+1 extra\s*\|/.test(tableRow(c, 'wsExtra')), tableRow(c, 'wsExtra'));
    assert.ok(/\|\s*1\/3 done · doing #2 · 20m · progress 20m ago · 1.8M tok · STRAYING: stall\s*\|/.test(tableRow(c, 'wsStray')), tableRow(c, 'wsStray'));
    assert.ok(/\|\s*working \(40%\)\s*\|/.test(tableRow(c, 'wsBare')), 'no-plan row keeps its old cell: ' + tableRow(c, 'wsBare'));
  } finally { h.cleanup(); }
});

test('parent-inbox: a dormant workspace never shows STRAYING; two renders of the same state agree', () => {
  const h = makeHome();
  try {
    const mut = (p, now) => { planLib.applyStep(p, 1, 'done', now - 30 * 60000); planLib.applyStep(p, 2, 'doing', now - 20 * 60000); };
    const old = Date.now() - 8 * 3600000; // 8h silent, past the 6h idle window
    writeHeartbeat(h.home, 'wsDormant', { id: 'wsDormant', ts: old, progress_pct: 10 });
    writeHeartbeat(h.home, 'wsLive', { id: 'wsLive', ts: Date.now(), progress_pct: 10 });
    for (const id of ['wsDormant', 'wsLive']) { seedPlan(h.home, id, ['read', 'fix', 'test'], mut); seedStray(h.home, id, [stallEntry]); }
    writeSummary(h.home, { wsDormant: {}, wsLive: {} });
    const render = (sid) => ctxOf(testHook('devswarm-parent-inbox.js', { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'hi', cwd: REPO_CWD },
      { home: h.home, env: PRIMARY_ENV, expectJson: true }));
    const a = render('d1');
    const b = render('d2');
    const stable = (c, id) => tableRow(c, id).replace(/\|[^|]*\|\s*$/, '|'); // drop the relative "last" cell
    assert.match(tableRow(a, 'wsDormant'), /\|\s*dormant\s*\|/, tableRow(a, 'wsDormant'));
    assert.ok(!/STRAYING/.test(tableRow(a, 'wsDormant')), 'dormant row must not show STRAYING: ' + tableRow(a, 'wsDormant'));
    assert.strictEqual(stable(a, 'wsDormant'), stable(b, 'wsDormant'), 'same state -> same row across renders');
    assert.ok(/STRAYING: stall/.test(tableRow(a, 'wsLive')), 'a live row keeps its STRAYING hint: ' + tableRow(a, 'wsLive'));
  } finally { h.cleanup(); }
});

function seedIdleWorkspace(home, id) {
  const root = path.join(home, '.anti-hall', 'devswarm');
  const inboxPath = path.join(root, 'inbox', id + '.ndjson');
  const cursorPath = path.join(root, 'cursor', id + '.json');
  for (const d of [path.join(root, 'workspaces'), path.dirname(inboxPath), path.dirname(cursorPath)]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, 'workspaces', id + '.json'), JSON.stringify({ id, worktreePath: path.join(home, 'wt', id), sessionId: 'child-' + id, inboxPath, cursorPath }));
  fs.writeFileSync(inboxPath, '');
  fs.writeFileSync(cursorPath, '0');
}
const gate = (home, sid) => testHookRaw('devswarm-parent-gate.js', JSON.stringify({ hook_event_name: 'Stop', session_id: sid, cwd: REPO_CWD }), { home, env: PRIMARY_ENV });

test('parent-gate: one advisory devswarm-straying line per warning per session; never a block', () => {
  const h = makeHome();
  try {
    seedIdleWorkspace(h.home, 'child-s');
    const none = gate(h.home, 'g0');
    assert.ok(!/devswarm-straying/.test(none.stderr), 'no stray state -> no line: ' + none.stderr);

    seedStray(h.home, 'child-s', [stallEntry]);
    const a = gate(h.home, 'g1');
    assert.strictEqual(a.status, 0);
    assert.ok(!(a.json && a.json.decision === 'block'), 'advisory only: ' + a.stdout);
    assert.match(a.stderr, /devswarm-straying: child-s: step 2 no step progress 40m/);
    const b = gate(h.home, 'g1');
    assert.ok(!/devswarm-straying/.test(b.stderr), 'shown once per session: ' + b.stderr);
    const other = gate(h.home, 'g2');
    assert.match(other.stderr, /devswarm-straying/, 'a new Primary session sees it once');
    // Jev's recommendation arriving later re-shows the warning once, with the note.
    seedStray(h.home, 'child-s', [Object.assign({}, stallEntry, { jev: [{ integration: 'devswarmWaitKind', verdict: 'waiting on CI/owner/peer, not stuck', confidence: 0.92, supports: false }] })]);
    const withJev = gate(h.home, 'g1');
    assert.match(withJev.stderr, /no step progress 40m \(Jev: waiting on CI\/owner\/peer, not stuck 0\.92\)/, withJev.stderr);
    assert.ok(!/devswarm-straying/.test(gate(h.home, 'g1').stderr), 'and only once');
    // planTracking off -> nothing.
    const off = testHookRaw('devswarm-parent-gate.js', JSON.stringify({ hook_event_name: 'Stop', session_id: 'g3', cwd: REPO_CWD }),
      { home: h.home, env: Object.assign({ ANTIHALL_DEVSWARM_PLAN_TRACKING: '0' }, PRIMARY_ENV) });
    assert.ok(!/devswarm-straying/.test(off.stderr));
  } finally { h.cleanup(); }
});

test('child-turn: a child with a plan is told to `scope add` extra work a user asks for', () => {
  const h = makeHome();
  try {
    seedPlan(h.home, 'child-p', ['read', 'fix'], (p, now) => planLib.applyStep(p, 1, 'doing', now));
    const r = testHook('devswarm-child-turn.js', { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'go', cwd: '/tmp' },
      { home: h.home, env: CHILD_ENV, expectJson: true });
    const c = ctxOf(r);
    assert.ok(c.includes("scope add child-p --glob '<paths>' --note '<what the user asked>'"), c);
  } finally { h.cleanup(); }
});
