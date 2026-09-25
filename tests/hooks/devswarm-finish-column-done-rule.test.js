'use strict';
// Task #36(b): the roster's "finish" column used to show a raw gate ratio
// (e.g. "1/3"), which is misleading under the current done rule: a child's
// structured done-report (`devswarm.js done`) sets ONLY the `done` gate —
// auto-archive proves the merge itself (companion/lib/devswarm-lifecycle.js
// doneFact/mergedFact), so a workspace that is genuinely done-and-merged
// could still show "1/3" or "—", looking barely started.
//
// doneStateLabel now reflects the actual done-rule state in plain words:
//   'done ✓ merged'    — a done report AND a proven merge (entry.mergedVerified)
//   'done, not merged' — a done report, merge not (yet) proven
//   'working' [+ pct]  — no done report yet

const { test } = require('node:test');
const assert = require('node:assert');

const inbox = require('../../plugins/anti-hall/hooks/devswarm-parent-inbox.js');

function summaryWith(entry) {
  return { requiredGates: ['done', 'merged', 'tests_passed'], workspaces: { w1: entry } };
}

test('done-rule state: done report + proven merge -> "done ✓ merged"', () => {
  const summary = summaryWith({ gates: { done: true }, mergedVerified: true });
  assert.strictEqual(inbox.doneStateLabel(summary, 'w1', null), 'done ✓ merged');
});

test('done-rule state: done report via archive_ready, merge proven -> "done ✓ merged"', () => {
  const summary = summaryWith({ gates: { done: true, merged: true, tests_passed: true }, archive_ready: true, mergedVerified: true });
  assert.strictEqual(inbox.doneStateLabel(summary, 'w1', null), 'done ✓ merged');
});

test('done-rule state: done report, merge NOT proven -> "done, not merged" (never fabricates a merge claim)', () => {
  const summary = summaryWith({ gates: { done: true } }); // no merged/tests_passed gates, no mergedVerified at all
  assert.strictEqual(inbox.doneStateLabel(summary, 'w1', null), 'done, not merged');
});

test('done-rule state: done report, merge gate set but never verified (mergedVerified explicitly false) -> "done, not merged"', () => {
  const summary = summaryWith({ gates: { done: true, merged: true }, mergedVerified: false });
  assert.strictEqual(inbox.doneStateLabel(summary, 'w1', null), 'done, not merged');
});

test('done-rule state: no done report at all -> "working"', () => {
  const summary = summaryWith({ gates: {} });
  assert.strictEqual(inbox.doneStateLabel(summary, 'w1', null), 'working');
});

test('done-rule state: no done report, heartbeat progress_pct present -> "working (N%)"', () => {
  const summary = summaryWith({ gates: {} });
  assert.strictEqual(inbox.doneStateLabel(summary, 'w1', { progress_pct: 40 }), 'working (40%)');
});

test('done-rule state: no summary entry at all -> "working" (never a bare "—" any more)', () => {
  const summary = { requiredGates: ['done', 'merged', 'tests_passed'], workspaces: {} };
  assert.strictEqual(inbox.doneStateLabel(summary, 'ghost', null), 'working');
});

test('buildWorkspaceTable renders the done-state finish cell verbatim in the table', () => {
  const out = inbox.buildWorkspaceTable(
    [{ id: 'w1', label: 'active', rank: 4, finish: 'done ✓ merged', unread: 0, lastActivityTs: null, wsName: null }],
    Date.now(), false, 0, []
  );
  assert.ok(out.includes('done ✓ merged'), out);
});
