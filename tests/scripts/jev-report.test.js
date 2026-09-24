'use strict';
// jev-report.js — pure-function aggregation tests against a fixture log
// (in-process, no fs/network — buildReport() takes rows directly).

const { test } = require('node:test');
const assert = require('node:assert');

const { buildReport } = require('../../plugins/anti-hall/scripts/jev-report.js');

function row(overrides) {
  return Object.assign({
    ts: new Date().toISOString(), id: 'speculation', h: 'h1', base: false, jev: true,
    conf: 0.9, ms: 100, backend: 'jev', final: false, changed: null, cached: false, mode: 'on',
  }, overrides);
}

test('buildReport: below MIN_CALLS_FOR_VERDICT -> REVIEW (not enough data)', () => {
  const rows = [row({ id: 'modelRouting', changed: null })];
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'modelRouting');
  assert.match(r.suggestion, /not enough data/);
});

test('buildReport: >=200 calls, changed<1%, no bad outcomes -> REMOVE', () => {
  const rows = [];
  for (let i = 0; i < 200; i++) {
    rows.push(row({ id: 'noop-integration', h: 'h' + i, jev: false, base: false, changed: null }));
  }
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'noop-integration');
  assert.strictEqual(r.suggestion, 'REMOVE');
});

test('buildReport: >=200 calls, high failure rate -> REMOVE', () => {
  const rows = [];
  for (let i = 0; i < 200; i++) {
    const failing = i < 50; // 25% failures
    rows.push(row({
      id: 'flaky', h: 'h' + i, jev: failing ? null : true, backend: failing ? 'baseline-only' : 'jev',
      reason: failing ? 'timeout' : undefined, changed: failing ? null : 'added',
    }));
  }
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'flaky');
  assert.strictEqual(r.suggestion, 'REMOVE');
});

test('buildReport: changed>=5% and good-outcome>=80% -> KEEP', () => {
  const rows = [];
  for (let i = 0; i < 100; i++) {
    const changed = i < 10; // 10% changed
    rows.push(row({ id: 'speculation', h: 'h' + i, changed: changed ? 'added' : null }));
  }
  // 10 changed decisions, 9 good outcomes, 1 bad
  for (let i = 0; i < 9; i++) rows.push({ ts: new Date().toISOString(), type: 'outcome', id: 'speculation', h: 'h' + i, outcome: 'evidence-added' });
  rows.push({ ts: new Date().toISOString(), type: 'outcome', id: 'speculation', h: 'h9', outcome: 'user-override' });
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'speculation');
  assert.strictEqual(r.suggestion, 'KEEP');
  assert.ok(Math.abs(r.goodOutcomeRate - 0.9) < 1e-9);
});

test('buildReport: outcome join by hash', () => {
  const rows = [
    row({ id: 'speculation', h: 'abc', changed: 'added' }),
    { ts: new Date().toISOString(), type: 'outcome', id: 'speculation', h: 'abc', outcome: 'evidence-added' },
  ];
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'speculation');
  assert.strictEqual(r.knownOutcomes, 1);
  assert.strictEqual(r.goodOutcomeRate, 1);
});

test('buildReport: agreement% only counted where both jev and base exist', () => {
  const rows = [
    row({ id: 'x', jev: true, base: true }),
    row({ id: 'x', jev: false, base: true }),
    row({ id: 'x', jev: null, base: false, backend: 'baseline-only' }),
  ];
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'x');
  assert.ok(Math.abs(r.agreementPct - 0.5) < 1e-9);
});

test('buildReport: --days window excludes rows older than the cutoff', () => {
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  const recent = new Date().toISOString();
  const rows = [row({ id: 'y', ts: old }), row({ id: 'y', ts: recent })];
  const report = buildReport(rows, { days: 7 });
  const r = report.integrations.find((x) => x.id === 'y');
  assert.strictEqual(r.calls, 1);
});

test('buildReport: cost is calls * costPerCall when configured, else null', () => {
  const rows = [row({ id: 'z' })];
  const withCost = buildReport(rows, { costPerCall: 0.001 });
  assert.ok(Math.abs(withCost.integrations[0].costEstimate - 0.001) < 1e-9);
  const withoutCost = buildReport(rows, {});
  assert.strictEqual(withoutCost.integrations[0].costEstimate, null);
  assert.strictEqual(withoutCost.costPerCallKnown, false);
});

test('buildReport: outcome rate split by decision source (jev vs regex)', () => {
  const rows = [
    row({ id: 'speculation', h: 'j1', changed: 'added' }),
    row({ id: 'speculation', h: 'r1', backend: 'baseline-only', jev: null, changed: null }),
    { ts: new Date().toISOString(), type: 'outcome', id: 'speculation', h: 'j1', outcome: 'evidence-added', source: 'jev' },
    { ts: new Date().toISOString(), type: 'outcome', id: 'speculation', h: 'r1', outcome: 'repeat-speculation', source: 'regex' },
  ];
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'speculation');
  assert.strictEqual(r.outcomeRateBySource.jev, 1);
  assert.strictEqual(r.outcomeRateBySource.regex, 0);
});

test('buildReport: p50/p95 computed from latencies', () => {
  const rows = [10, 20, 30, 40, 50].map((ms) => row({ id: 'lat', ms, h: 'h' + ms }));
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'lat');
  assert.strictEqual(r.p50, 30);
  assert.strictEqual(r.p95, 50);
});

// ---------------------------------------------------------------------------
// New integrations: label distribution, no-KEEP-without-outcome, triage
// answer-time (item 3 of the follow-up).
// ---------------------------------------------------------------------------

test('buildReport: label-only integration (choice answer, null baseline) reports label distribution, never agree%', () => {
  const rows = [];
  const labels = ['new-request', 'new-request', 'new-request', 'follow-up'];
  for (let i = 0; i < 60; i++) {
    rows.push(row({
      id: 'newRequest', h: 'h' + i, base: null, jev: labels[i % 4], backend: 'jev', changed: null, mode: 'shadow',
    }));
  }
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'newRequest');
  assert.strictEqual(r.agreementPct, null, 'no boolean baseline -> agreementPct must stay null');
  assert.strictEqual(r.topLabel, 'new-request');
  assert.ok(r.labelPct > 0.7 && r.labelPct < 0.8, `expected ~75% top label share, got ${r.labelPct}`);
  assert.ok(r.labelDistribution['new-request'] > 0 && r.labelDistribution['follow-up'] > 0);
});

test('buildReport: high changed-decision rate but NO outcome signal -> never KEEP', () => {
  const rows = [];
  for (let i = 0; i < 200; i++) {
    // every call relaxes a block (changedRate 100%) but NO outcome row exists
    // anywhere in the log for any of these hashes.
    rows.push(row({ id: 'mergeGateHedge', h: 'h' + i, base: true, jev: false, changed: 'relaxed', mode: 'on' }));
  }
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'mergeGateHedge');
  assert.strictEqual(r.goodOutcomeRate, null, 'no outcome rows -> goodOutcomeRate must be null');
  assert.notStrictEqual(r.suggestion, 'KEEP', 'a null outcome signal must never earn KEEP, regardless of changed rate');
});

test('buildReport: changed-decision rate high AND a real outcome signal -> KEEP still reachable', () => {
  const rows = [];
  for (let i = 0; i < 200; i++) {
    rows.push(row({ id: 'claimLedger', h: 'h' + i, base: true, jev: false, changed: 'relaxed', mode: 'on' }));
    rows.push({ ts: new Date().toISOString(), type: 'outcome', id: 'claimLedger', h: 'h' + i, outcome: 'evidence-added' });
  }
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'claimLedger');
  assert.strictEqual(r.goodOutcomeRate, 1);
  assert.strictEqual(r.suggestion, 'KEEP');
});

test('buildTriageAnswerReport: separates urgent vs non-urgent time-to-answer', () => {
  const { buildTriageAnswerReport } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const triageRows = [
    { type: 'answered', urgency: 'urgent', latencyMs: 1000 },
    { type: 'answered', urgency: 'urgent', latencyMs: 2000 },
    { type: 'answered', urgency: 'normal', latencyMs: 50000 },
    { type: 'classification', urgency: 'urgent', kind: 'blocker' }, // not an 'answered' row -> ignored
  ];
  const r = buildTriageAnswerReport(triageRows);
  assert.strictEqual(r.urgent.n, 2);
  assert.strictEqual(r.normal.n, 1);
  assert.ok(r.urgent.p50 <= r.normal.p50, 'urgent answers should be faster than non-urgent in this fixture');
});
