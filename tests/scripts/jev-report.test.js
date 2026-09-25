'use strict';
// jev-report.js — pure-function aggregation tests against a fixture log
// (in-process, no fs/network — buildReport() takes rows directly).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeHome } = require('../helpers/fixtures.js');

const {
  buildReport, buildHeadline, labelsLogPath, readLabels, latestHumanLabelByHash, cmdLabel,
  auditLogPath, readAuditSnippet, cmdPruneAudit, describeWindow, printWindow, parseIsoMs,
} = require('../../plugins/anti-hall/scripts/jev-report.js');

// writeAuditRow(home, {ts, id, h, snippet}) — test helper, writes directly to
// jev-audit.ndjson the way hooks/lib/jev-assist.js's maybeWriteAuditSnippet
// would (jev-report.js never writes this file itself, only reads/prunes it).
function writeAuditRow(home, row) {
  const p = auditLogPath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(Object.assign({ ts: new Date().toISOString() }, row)) + '\n', 'utf8');
}

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

// FIX (v0.108.1, proven bug 2): REMOVE used to fire on changedRate<1% or a
// high failure rate ALONE, with zero labelled outcomes behind it (a real
// production case: 3 changed / 304 fresh hit REMOVE via changedRate alone).
// KEEP and REMOVE now BOTH require a labelled sample (tp+fp, human+auto) of
// at least MIN_LABELED_FOR_VERDICT (20) before either can fire; below that,
// the verdict is REVIEW (needs labels: n/20), no matter how the raw rates look.

test('buildReport: >=200 calls, changed<1%, no LABELLED outcomes -> REVIEW (needs labels), never REMOVE', () => {
  const rows = [];
  for (let i = 0; i < 200; i++) {
    rows.push(row({ id: 'noop-integration', h: 'h' + i, jev: false, base: false, changed: null }));
  }
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'noop-integration');
  assert.match(r.suggestion, /^REVIEW \(needs labels: 0\/20\)$/);
});

test('buildReport: changed<1% is a LOW YIELD note, never a REMOVE trigger by itself, once labelled', () => {
  const rows = [];
  // 20 changed decisions out of 2500 fresh calls = 0.8% changed rate, each
  // with a GOOD outcome (so goodOutcomeRate=100%, failureRate=0%) -- neither
  // REMOVE condition is met, and changedRate<1% must not remove on its own.
  for (let i = 0; i < 20; i++) {
    rows.push(row({ id: 'low-yield', h: 'h' + i, changed: 'added' }));
    rows.push({ ts: new Date().toISOString(), type: 'outcome', id: 'low-yield', h: 'h' + i, outcome: 'evidence-added' });
  }
  for (let i = 0; i < 2480; i++) {
    rows.push(row({ id: 'low-yield', h: 'u' + i, jev: false, base: false, changed: null }));
  }
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'low-yield');
  assert.ok(r.changedRate < 0.01, `expected <1% changed rate, got ${r.changedRate}`);
  assert.notStrictEqual(r.suggestion, 'REMOVE', 'low yield alone must never remove');
  assert.match(r.suggestion, /low yield: changed/);
});

test('buildReport: >=200 calls, high failure rate BUT below MIN_LABELED_FOR_VERDICT -> REVIEW (needs labels), never REMOVE', () => {
  const rows = [];
  for (let i = 0; i < 200; i++) {
    const failing = i < 50; // 25% failures
    rows.push(row({
      id: 'flaky-unlabeled', h: 'h' + i, jev: failing ? null : true, backend: failing ? 'baseline-only' : 'jev',
      reason: failing ? 'timeout' : undefined, changed: failing ? null : 'added',
    }));
  }
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'flaky-unlabeled');
  assert.match(r.suggestion, /^REVIEW \(needs labels: 0\/20\)$/);
});

test('buildReport: >=200 calls, high failure rate AND a labelled sample -> REMOVE', () => {
  const rows = [];
  for (let i = 0; i < 200; i++) {
    const failing = i < 50; // 25% failures
    rows.push(row({
      id: 'flaky', h: 'h' + i, jev: failing ? null : true, backend: failing ? 'baseline-only' : 'jev',
      reason: failing ? 'timeout' : undefined, changed: failing ? null : 'added',
    }));
  }
  // Reach MIN_LABELED_FOR_VERDICT (20) via good auto-TP outcomes on 20 of the
  // successful, changed decisions -- the failure rate alone still earns
  // REMOVE once a labelled sample exists, regardless of those 20 being good.
  for (let i = 50; i < 70; i++) {
    rows.push({ ts: new Date().toISOString(), type: 'outcome', id: 'flaky', h: 'h' + i, outcome: 'evidence-added' });
  }
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'flaky');
  assert.strictEqual(r.suggestion, 'REMOVE');
});

test('buildReport: changed>=5% and good-outcome>=80% with a labelled sample -> KEEP', () => {
  const rows = [];
  for (let i = 0; i < 100; i++) {
    const changed = i < 30; // 30% changed -- reaches the 20-label floor below
    rows.push(row({ id: 'speculation', h: 'h' + i, changed: changed ? 'added' : null }));
  }
  // 30 changed decisions, 27 good outcomes, 3 bad -- labelledSample=30 >= 20.
  for (let i = 0; i < 27; i++) rows.push({ ts: new Date().toISOString(), type: 'outcome', id: 'speculation', h: 'h' + i, outcome: 'evidence-added' });
  for (let i = 27; i < 30; i++) rows.push({ ts: new Date().toISOString(), type: 'outcome', id: 'speculation', h: 'h' + i, outcome: 'user-override' });
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'speculation');
  assert.strictEqual(r.suggestion, 'KEEP');
  assert.ok(Math.abs(r.goodOutcomeRate - 0.9) < 1e-9);
});

test('buildReport: changed>=5% and good-outcome>=80% but BELOW MIN_LABELED_FOR_VERDICT -> REVIEW (needs labels), never KEEP', () => {
  const rows = [];
  for (let i = 0; i < 100; i++) {
    const changed = i < 10; // 10% changed, but only 10 outcomes below (< 20 floor)
    rows.push(row({ id: 'thin-speculation', h: 'h' + i, changed: changed ? 'added' : null }));
  }
  for (let i = 0; i < 9; i++) rows.push({ ts: new Date().toISOString(), type: 'outcome', id: 'thin-speculation', h: 'h' + i, outcome: 'evidence-added' });
  rows.push({ ts: new Date().toISOString(), type: 'outcome', id: 'thin-speculation', h: 'h9', outcome: 'user-override' });
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'thin-speculation');
  assert.match(r.suggestion, /^REVIEW \(needs labels: 10\/20\)$/);
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

test('buildReport: agreement% is computed from `compare`, never from `base` (base is trust-rule math, sometimes a hardcoded constant)', () => {
  const rows = [
    row({ id: 'x', h: 'x1', jev: true, base: false, compare: true }),
    row({ id: 'x', h: 'x2', jev: false, base: false, compare: true }),
    row({ id: 'x', h: 'x3', jev: null, base: false, backend: 'baseline-only' }),
  ];
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'x');
  assert.ok(Math.abs(r.agreementPct - 0.5) < 1e-9);
  assert.strictEqual(r.agreeTotal, 2, 'denominator is the 2 distinct decisions with a compare signal');
});

test('buildReport: rows with a boolean jev answer but no `compare` field are excluded from agreement, not folded into it', () => {
  // Regression for the bug where jev-report computed agreement as
  // row.jev === row.base, and base was a hardcoded add-block baseline
  // (always false) -- silently reporting "rate Jev said not-speculative"
  // as if it were agreement with an independent heuristic.
  const rows = [
    row({ id: 'speculation', jev: true, base: false }),
    row({ id: 'speculation', jev: false, base: false }),
  ];
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'speculation');
  assert.strictEqual(r.agreementPct, null, 'no `compare` field anywhere -> agreementPct must be null, not derived from base');
  assert.strictEqual(r.excludedNoCompare, 2);
});

test('buildReport: a mix of compare-bearing and compare-less rows only counts the compare-bearing ones', () => {
  const rows = [
    row({ id: 'mixed', h: 'm1', jev: true, compare: true }),
    row({ id: 'mixed', h: 'm2', jev: false, compare: true }), // disagreement
    row({ id: 'mixed', h: 'm3', jev: true, base: false }), // no compare -> excluded
  ];
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'mixed');
  assert.ok(Math.abs(r.agreementPct - 0.5) < 1e-9);
  assert.strictEqual(r.agreeTotal, 2);
  assert.strictEqual(r.excludedNoCompare, 1);
});

test('buildReport: a cache-hit RETRY of the same decision (same hash) does not add its own extra vote to agreement -- root cause of the inconsistent agreement% across windows (99%/77.5%/37% on the real log)', () => {
  const rows = [
    // One real (fresh) decision that DISAGREES with compare.
    row({ id: 'spec2', h: 'popular', jev: true, compare: false, backend: 'jev' }),
    // The SAME decision re-asked as a cache hit 4 more times (a common
    // recurring input) -- must NOT be treated as 4 more independent
    // disagreements.
    row({ id: 'spec2', h: 'popular', jev: true, compare: false, backend: 'cache' }),
    row({ id: 'spec2', h: 'popular', jev: true, compare: false, backend: 'cache' }),
    row({ id: 'spec2', h: 'popular', jev: true, compare: false, backend: 'cache' }),
    row({ id: 'spec2', h: 'popular', jev: true, compare: false, backend: 'cache' }),
    // A genuinely different decision that AGREES with compare.
    row({ id: 'spec2', h: 'other', jev: true, compare: true, backend: 'jev' }),
  ];
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'spec2');
  assert.strictEqual(r.agreeTotal, 2, 'two DISTINCT decisions, not 6 raw rows');
  assert.ok(Math.abs(r.agreementPct - 0.5) < 1e-9, `50% (1 of 2 distinct decisions agrees), not skewed by the 5x cache-hit repeat; got ${r.agreementPct}`);
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

// ---------------------------------------------------------------------------
// Dedupe by content hash: a Stop-hook retry produces one fresh call + N cache
// hits sharing the same `h`. Real-log pattern that motivated this: 6
// changed:"added" rows all sharing hash 23bfcd484e8e71dc -- 1 live call + 5
// cached hits across 3 Stop-hook retry pairs.
// ---------------------------------------------------------------------------

test('buildReport: one fresh call + N cache hits sharing a hash count as ONE changed decision, excluded cost/outcome for cache rows', () => {
  const H = '23bfcd484e8e71dc';
  const rows = [
    row({ id: 'speculation', h: H, backend: 'jev', changed: 'added' }), // the 1 live call
    row({ id: 'speculation', h: H, backend: 'cache', changed: 'added' }),
    row({ id: 'speculation', h: H, backend: 'cache', changed: 'added' }),
    row({ id: 'speculation', h: H, backend: 'cache', changed: 'added' }),
    row({ id: 'speculation', h: H, backend: 'cache', changed: 'added' }),
    row({ id: 'speculation', h: H, backend: 'cache', changed: 'added' }),
    // one outcome row for the decision (joins by hash, not per raw row)
    { ts: new Date().toISOString(), type: 'outcome', id: 'speculation', h: H, outcome: 'evidence-added' },
  ];
  const report = buildReport(rows, { costPerCall: 0.01 });
  const r = report.integrations.find((x) => x.id === 'speculation');
  assert.strictEqual(r.calls, 6, 'raw row count unchanged');
  assert.strictEqual(r.freshCalls, 1);
  assert.strictEqual(r.cachedCalls, 5);
  assert.strictEqual(r.changedUnique, 1, 'one decision, not six');
  assert.strictEqual(r.changed.added, 1);
  assert.strictEqual(r.changedRate, 1, 'yield computed on fresh calls only: 1 unique changed / 1 fresh call');
  assert.strictEqual(r.knownOutcomes, 1, 'outcome counted once per decision, not once per cache-hit retry');
  assert.strictEqual(r.goodOutcomeRate, 1);
  assert.ok(Math.abs(r.costEstimate - 0.01) < 1e-9, 'cost charged for the 1 fresh call only, cache hits are $0');
});

// ---------------------------------------------------------------------------
// Real cost (gateway/price-table-reported costUsd on each row) — distinct
// from the manual costEstimate/costPerCall fallback.
// ---------------------------------------------------------------------------

test('buildReport: realCostTotal/PerCall/PerChangedDecision computed from row.costUsd, cache hits contribute $0', () => {
  const rows = [
    row({ id: 'speculation', h: 'h1', backend: 'jev', changed: 'added', costUsd: 0.002, costSource: 'gateway' }),
    row({ id: 'speculation', h: 'h1', backend: 'cache', changed: 'added', costUsd: 0, costSource: 'cache' }),
    row({ id: 'speculation', h: 'h2', backend: 'jev', changed: null, costUsd: 0.001, costSource: 'gateway' }),
  ];
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'speculation');
  assert.ok(Math.abs(r.realCostTotal - 0.003) < 1e-9, 'sums real cost across all rows, cache contributes $0');
  assert.strictEqual(r.freshCalls, 2);
  assert.ok(Math.abs(r.realCostPerCall - 0.0015) < 1e-9, '0.003 / 2 fresh calls');
  assert.ok(Math.abs(r.realCostPerChangedDecision - 0.003) < 1e-9, '0.003 / 1 unique changed decision (h1)');
});

test('buildReport: no row carries costUsd -> realCostTotal is null, not $0', () => {
  const rows = [row({ id: 'x' })];
  const report = buildReport(rows, {});
  const r = report.integrations.find((i) => i.id === 'x');
  assert.strictEqual(r.realCostTotal, null);
  assert.strictEqual(r.realCostPerCall, null);
  assert.strictEqual(r.realCostPerChangedDecision, null);
});

test('buildCostWindows: default windows are 24h and 7d, each re-running buildReport with its own cutoff', () => {
  const { buildCostWindows } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const old = new Date(Date.now() - 3 * 86400000).toISOString(); // 3 days ago: in 7d, not 24h
  const recent = new Date().toISOString();
  const rows = [
    row({ id: 'speculation', h: 'old', ts: old, backend: 'jev', changed: 'added', costUsd: 0.01 }),
    row({ id: 'speculation', h: 'new', ts: recent, backend: 'jev', changed: 'added', costUsd: 0.02 }),
  ];
  const windows = buildCostWindows(rows, {});
  assert.deepStrictEqual(Object.keys(windows).sort(), ['24h', '7d']);
  const r24 = windows['24h'].integrations.find((i) => i.id === 'speculation');
  const r7 = windows['7d'].integrations.find((i) => i.id === 'speculation');
  assert.ok(Math.abs(r24.realCostTotal - 0.02) < 1e-9, '24h window excludes the 3-day-old row');
  assert.ok(Math.abs(r7.realCostTotal - 0.03) < 1e-9, '7d window includes both rows');
});

// ---------------------------------------------------------------------------
// Precision labels (tp/fp), yield, cost efficiency, overhead, headline
// ---------------------------------------------------------------------------

test('cmdLabel + readLabels + latestHumanLabelByHash: round-trip a human label', () => {
  const h = makeHome();
  try {
    cmdLabel('abc123', 'tp', h.home);
    const rows = readLabels(h.home);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].h, 'abc123');
    assert.strictEqual(rows[0].label, 'tp');
    assert.strictEqual(rows[0].source, 'human');
    const map = latestHumanLabelByHash(rows);
    assert.strictEqual(map.get('abc123'), 'tp');
  } finally { h.cleanup(); }
});

test('cmdLabel: rejects an invalid label value, writes nothing', () => {
  const h = makeHome();
  const savedExitCode = process.exitCode;
  try {
    cmdLabel('abc123', 'maybe', h.home);
    assert.ok(!fs.existsSync(labelsLogPath(h.home)));
  } finally {
    process.exitCode = savedExitCode; // cmdLabel sets exitCode 1 for CLI usage; don't leak it into the test run
    h.cleanup();
  }
});

test('latestHumanLabelByHash: a later label for the same hash overrides an earlier one (a correction)', () => {
  const rows = [
    { h: 'x', label: 'fp', source: 'human' },
    { h: 'x', label: 'tp', source: 'human' },
  ];
  const map = latestHumanLabelByHash(rows);
  assert.strictEqual(map.get('x'), 'tp');
});

test('buildReport: a human label wins over the auto-derived label for the same hash', () => {
  const rows = [
    row({ h: 'h1', changed: 'added' }),
    { ts: new Date().toISOString(), type: 'outcome', h: 'h1', id: 'speculation', outcome: 'repeat-speculation' }, // would auto-label fp
  ];
  const humanLabelByHash = new Map([['h1', 'tp']]);
  const report = buildReport(rows, { humanLabelByHash });
  const r = report.integrations.find((x) => x.id === 'speculation');
  assert.strictEqual(r.humanTP, 1);
  assert.strictEqual(r.humanFP, 0);
  assert.strictEqual(r.autoTP, 0);
  assert.strictEqual(r.autoFP, 0, 'the human label suppresses the auto derivation entirely for this hash');
});

test('buildReport: no human label -> auto tp/fp derived from the existing outcome/BAD_OUTCOME_RE signal', () => {
  const rows = [
    row({ h: 'good', changed: 'added' }),
    { ts: new Date().toISOString(), type: 'outcome', h: 'good', id: 'speculation', outcome: 'evidence-added' },
    row({ h: 'bad', changed: 'added' }),
    { ts: new Date().toISOString(), type: 'outcome', h: 'bad', id: 'speculation', outcome: 'repeat-speculation' },
    row({ h: 'unlabeled', changed: 'added' }), // no outcome row at all
  ];
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'speculation');
  assert.strictEqual(r.autoTP, 1);
  assert.strictEqual(r.autoFP, 1);
  assert.strictEqual(r.humanTP, 0);
  assert.strictEqual(r.humanFP, 0);
  assert.strictEqual(r.changedUnique, 3, 'the unlabeled hash still counts as a changed decision');
});

test('buildReport: yield (changedPer100/tpPer100) computed on fresh calls only', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(row({ h: 'h' + i, changed: i < 2 ? 'added' : null }));
  rows.push({ ts: new Date().toISOString(), type: 'outcome', h: 'h0', id: 'speculation', outcome: 'evidence-added' });
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'speculation');
  assert.ok(Math.abs(r.changedPer100 - 20) < 1e-9, '2 changed / 10 fresh calls * 100');
  assert.ok(Math.abs(r.tpPer100Auto - 10) < 1e-9, '1 auto TP / 10 fresh calls * 100');
  assert.strictEqual(r.tpPer100Human, 0);
});

test('buildReport: costPerTp is realCostTotal / (humanTP + autoTP), null when no TP', () => {
  const rows = [
    row({ h: 'h1', changed: 'added', costUsd: 0.01 }),
    { ts: new Date().toISOString(), type: 'outcome', h: 'h1', id: 'speculation', outcome: 'evidence-added' },
  ];
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'speculation');
  assert.ok(Math.abs(r.costPerTp - 0.01) < 1e-9);

  const rowsNoTp = [row({ h: 'h2', changed: 'added', costUsd: 0.01 })]; // no outcome -> unlabeled
  const r2 = buildReport(rowsNoTp, {}).integrations.find((x) => x.id === 'speculation');
  assert.strictEqual(r2.costPerTp, null);
});

test('buildReport: overhead fields (pctCallsOver1s, timeouts, fallbackCount)', () => {
  const rows = [
    row({ h: 'a', ms: 1500, changed: null }),
    row({ h: 'b', ms: 200, changed: null }),
    row({ h: 'c', backend: 'baseline-only', jev: null, reason: 'timeout', changed: null }),
    row({ h: 'd', backend: 'baseline-only', jev: null, mode: 'on', reason: 'http-500', changed: null }),
  ];
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'speculation');
  assert.ok(Math.abs(r.pctCallsOver1s - 0.25) < 1e-9, '1 of 4 fresh calls over 1000ms');
  assert.strictEqual(r.timeouts, 1);
  assert.strictEqual(r.fallbackCount, 2, 'both baseline-only rows fell back while mode was on');
});

test('buildHeadline: combines changed/TP/cost/latency/suggestion into one line', () => {
  const r = {
    id: 'speculation', changedUnique: 6, humanTP: 3, autoTP: 2, autoFP: 1,
    costPerTp: 0.05, p50: 600, suggestion: 'KEEP',
  };
  const line = buildHeadline(r, '24h');
  assert.strictEqual(line, 'speculation: 6 changed/24h · 5 TP (3 human, 2 auto) · $0.0500/TP · p50=600ms · KEEP');
});

test('buildHeadline: cost/latency unknown -> "n/a" placeholders, never fabricated', () => {
  const r = { id: 'x', changedUnique: 0, humanTP: 0, autoTP: 0, costPerTp: null, p50: null, suggestion: 'REVIEW' };
  const line = buildHeadline(r, '7d');
  assert.match(line, /cost n\/a/);
  assert.match(line, /p50 n\/a/);
});

// ---------------------------------------------------------------------------
// Audit snippets: read-only side (jev-report never WRITES jev-audit.ndjson,
// only reads it for `label` and prunes it via `prune-audit`).
// ---------------------------------------------------------------------------

function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = orig; }
  return lines;
}

test('readAuditSnippet: null when nothing was ever stored for that hash (the common, off-by-default case)', () => {
  const h = makeHome();
  try {
    assert.strictEqual(readAuditSnippet(h.home, 'nope'), null);
  } finally { h.cleanup(); }
});

test('readAuditSnippet: returns the latest snippet stored for the hash', () => {
  const h = makeHome();
  try {
    writeAuditRow(h.home, { id: 'speculation', h: 'abc', snippet: 'first' });
    writeAuditRow(h.home, { id: 'speculation', h: 'abc', snippet: 'second (a correction)' });
    writeAuditRow(h.home, { id: 'speculation', h: 'other', snippet: 'unrelated' });
    assert.strictEqual(readAuditSnippet(h.home, 'abc'), 'second (a correction)');
  } finally { h.cleanup(); }
});

test('readAuditSnippet: a shadow-marked (would-change) row is read the same as a real change -- not filtered out', () => {
  const h = makeHome();
  try {
    writeAuditRow(h.home, { id: 'newRequest', h: 'sh1', snippet: 'a new request, shadow mode', shadow: true });
    assert.strictEqual(readAuditSnippet(h.home, 'sh1'), 'a new request, shadow mode');
  } finally { h.cleanup(); }
});

test('cmdLabel <hash> (no verdict): read-only, prints unlabeled + no snippet, writes nothing', () => {
  const h = makeHome();
  try {
    const lines = captureLogs(() => cmdLabel('abc', undefined, h.home));
    assert.ok(!fs.existsSync(labelsLogPath(h.home)), 'read-only inspect must never write a label');
    assert.ok(lines.some((l) => l.includes('unlabeled')));
    assert.ok(lines.some((l) => l.includes('snippet: none')));
  } finally { h.cleanup(); }
});

test('cmdLabel <hash> tp: writes the label AND prints the stored snippet as a courtesy', () => {
  const h = makeHome();
  try {
    writeAuditRow(h.home, { id: 'speculation', h: 'abc', snippet: 'the plan is probably done' });
    const lines = captureLogs(() => cmdLabel('abc', 'tp', h.home));
    assert.ok(lines.some((l) => l.includes('labeled abc as tp')));
    assert.ok(lines.some((l) => l.includes('the plan is probably done')));
    assert.strictEqual(latestHumanLabelByHash(readLabels(h.home)).get('abc'), 'tp');
  } finally { h.cleanup(); }
});

test('cmdPruneAudit: removes entries older than N days, keeps recent ones, never runs unless explicitly invoked', () => {
  const h = makeHome();
  const savedExitCode = process.exitCode;
  try {
    const old = new Date(Date.now() - 30 * 86400000).toISOString();
    const recent = new Date().toISOString();
    writeAuditRow(h.home, { ts: old, id: 'speculation', h: 'old1', snippet: 'stale' });
    writeAuditRow(h.home, { ts: recent, id: 'speculation', h: 'new1', snippet: 'fresh' });
    cmdPruneAudit(7, h.home);
    assert.strictEqual(readAuditSnippet(h.home, 'old1'), null, 'pruned');
    assert.strictEqual(readAuditSnippet(h.home, 'new1'), 'fresh', 'kept');
  } finally { process.exitCode = savedExitCode; h.cleanup(); }
});

test('cmdPruneAudit: invalid --days -> error, exit code 1, file untouched', () => {
  const h = makeHome();
  const savedExitCode = process.exitCode;
  try {
    writeAuditRow(h.home, { id: 'speculation', h: 'x', snippet: 'keepme' });
    cmdPruneAudit(NaN, h.home);
    assert.strictEqual(process.exitCode, 1);
    assert.strictEqual(readAuditSnippet(h.home, 'x'), 'keepme', 'a rejected call must never touch the file');
  } finally { process.exitCode = savedExitCode; h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Budget watch status (jev-report side: display only, never mutates state)
// ---------------------------------------------------------------------------

test('computeBudgetStatus: mode "unlimited" (default) -> null, nothing to show', () => {
  const { computeBudgetStatus } = require('../../plugins/anti-hall/scripts/jev-report.js');
  assert.strictEqual(computeBudgetStatus([row({ costUsd: 100 })], { mode: 'unlimited', usdPerDay: null, usdPerWeek: null }), null);
});

test('computeBudgetStatus: watch mode, usdPerDay only -> 24h computed, 7d null (not configured)', () => {
  const { computeBudgetStatus } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const rows = [row({ id: 'speculation', costUsd: 3 }), row({ id: 'modelRouting', costUsd: 4 })];
  const status = computeBudgetStatus(rows, { mode: 'watch', usdPerDay: 5, usdPerWeek: null });
  assert.strictEqual(status['24h'].spentUsd, 7, 'spend sums across ALL integrations');
  assert.strictEqual(status['24h'].exceeded, true);
  assert.strictEqual(status['7d'], null, 'usdPerWeek not configured -> null, not a fabricated 0');
});

test('computeBudgetStatus: under budget -> exceeded false', () => {
  const { computeBudgetStatus } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const status = computeBudgetStatus([row({ costUsd: 1 })], { mode: 'watch', usdPerDay: 5, usdPerWeek: null });
  assert.strictEqual(status['24h'].exceeded, false);
});

// ---------------------------------------------------------------------------
// Low-credit warning (opt-in: budget.mode "watch" + minCreditUsd)
// ---------------------------------------------------------------------------

test('maybeWarnLowCredit: not applicable when mode is not "watch"', () => {
  const { maybeWarnLowCredit } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const r = maybeWarnLowCredit({
    home: '/nonexistent', budget: { mode: 'unlimited', minCreditUsd: 10 },
    creditResult: { ok: true, balanceUsd: 1 },
  });
  assert.strictEqual(r, null);
});

test('maybeWarnLowCredit: not applicable when minCreditUsd is unset', () => {
  const { maybeWarnLowCredit } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const r = maybeWarnLowCredit({
    home: '/nonexistent', budget: { mode: 'watch', minCreditUsd: null },
    creditResult: { ok: true, balanceUsd: 1 },
  });
  assert.strictEqual(r, null);
});

test('maybeWarnLowCredit: not applicable when the balance is unknown (credit check failed)', () => {
  const { maybeWarnLowCredit } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const r = maybeWarnLowCredit({
    home: '/nonexistent', budget: { mode: 'watch', minCreditUsd: 10 },
    creditResult: { ok: false, reason: 'unsupported-transport' },
  });
  assert.strictEqual(r, null);
});

test('maybeWarnLowCredit: above threshold -> belowThreshold false, no state write', () => {
  const h = makeHome();
  try {
    const { maybeWarnLowCredit, budgetStatePath } = require('../../plugins/anti-hall/scripts/jev-report.js');
    const r = maybeWarnLowCredit({
      home: h.home, budget: { mode: 'watch', minCreditUsd: 10 },
      creditResult: { ok: true, balanceUsd: 50 },
    });
    assert.strictEqual(r.belowThreshold, false);
    assert.ok(!fs.existsSync(budgetStatePath(h.home)));
  } finally { h.cleanup(); }
});

test('maybeWarnLowCredit: below threshold -> warns once per day, then belowThreshold:true/warnedNow:false on repeat', () => {
  const h = makeHome();
  try {
    const { maybeWarnLowCredit } = require('../../plugins/anti-hall/scripts/jev-report.js');
    const budget = { mode: 'watch', minCreditUsd: 10 };
    const creditResult = { ok: true, balanceUsd: 2 };
    const r1 = maybeWarnLowCredit({ home: h.home, budget, creditResult });
    assert.strictEqual(r1.belowThreshold, true);
    assert.strictEqual(r1.warnedNow, true);
    const r2 = maybeWarnLowCredit({ home: h.home, budget, creditResult });
    assert.strictEqual(r2.belowThreshold, true);
    assert.strictEqual(r2.warnedNow, false, 'already warned today -- must not re-fire');
  } finally { h.cleanup(); }
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

// ---------------------------------------------------------------------------
// No mixing between "Jev classifier latency" (jev-assist.ndjson decision
// rows' `ms` field, backend:'jev'/'cache') and "reply turnaround" (jev-
// triage.ndjson's separate recordAnswered `{type:'answered', latencyMs}`
// rows -- agent reply time, NOT a Jev call at all). Verified against a real
// log: classifier calls were 352-1313ms across 122 rows while the triage
// answer-time p95 was ~960s (16 min) -- two very different quantities that
// must never be reported under one ambiguous "latency" figure.
// ---------------------------------------------------------------------------

test('buildTriageAnswerReport: a REAL classification row (no `type` field at all -- jev-triage.js\'s actual appendTriageLog shape) is excluded, not just a fake "type:classification" row', () => {
  const { buildTriageAnswerReport } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const triageRows = [
    // Exactly what hooks/lib/jev-triage.js's appendTriageLog writes: NO
    // `type` field at all (only recordAnswered rows carry type:'answered').
    { ts: '2026-01-01T00:00:00.000Z', hash: 'h1', urgency: 'urgent', kind: 'blocker', backend: 'jev', ms: 352 },
    { ts: '2026-01-01T00:00:01.000Z', hash: 'h2', urgency: 'normal', kind: 'fyi', backend: 'jev', ms: 1313 },
    { type: 'answered', urgency: 'urgent', latencyMs: 960000 },
  ];
  const r = buildTriageAnswerReport(triageRows);
  assert.strictEqual(r.urgent.n, 1, 'only the true answered row counts, not the classification rows');
  assert.strictEqual(r.urgent.p50, 960000);
});

test('buildReport: per-integration p50/p95 (classifier `ms`) is computed ONLY from jev-assist.ndjson decision rows, even if triage answer-time rows are (incorrectly) mixed into the same array', () => {
  const { buildReport } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const rows = [
    { ts: '2026-01-01T00:00:00.000Z', id: 'speculation', h: 'a', base: false, jev: true, conf: 0.9, ms: 352, backend: 'jev', final: false, changed: null, cached: false, mode: 'shadow' },
    { ts: '2026-01-01T00:00:01.000Z', id: 'speculation', h: 'b', base: false, jev: true, conf: 0.9, ms: 1313, backend: 'jev', final: false, changed: null, cached: false, mode: 'shadow' },
    // A triage answered-latency row mistakenly handed to buildReport (real
    // callers never do this -- triageRows is a SEPARATE opts field -- but
    // this proves buildReport's OWN p50/p95 math has no path that could pick
    // up a `latencyMs` field even if one leaked in).
    { type: 'answered', urgency: 'urgent', latencyMs: 960000 },
  ];
  const report = buildReport(rows, {});
  const spec = report.integrations.find((r) => r.id === 'speculation');
  assert.ok(spec);
  assert.ok([352, 1313].includes(spec.p50), `p50 must be a real classifier latency (352/1313), never the reply-turnaround figure; got ${spec.p50}`);
  assert.ok([352, 1313].includes(spec.p95), `p95 must be a real classifier latency (352/1313), never the reply-turnaround figure; got ${spec.p95}`);
});

test('buildReport: triage appears as its own integration (calls/backend/ms) sourced from opts.triageRows, since its real classification calls never land in jev-assist.ndjson (a separate file/schema, see hooks/lib/jev-triage.js) -- ROOT CAUSE of "triage backend undefined": it was invisible in this table entirely, not present with a bad value', () => {
  const rows = [
    row({ id: 'speculation', h: 'sp1' }),
  ];
  const triageRows = [
    // Real appendTriageLog shape: no `type`, has `hash`+`backend`+`ms`.
    { ts: '2026-01-01T00:00:00.000Z', hash: 'th1', urgency: null, kind: 'blocker', backend: 'jev', ms: 500 },
    { ts: '2026-01-01T00:00:01.000Z', hash: 'th2', urgency: 'normal', kind: 'fyi', backend: 'jev', ms: 700 },
    // A malformed/legacy entry with no backend at all must default to
    // 'baseline-only', never surface as undefined.
    { ts: '2026-01-01T00:00:02.000Z', hash: 'th3', urgency: null, kind: 'status-report', ms: 300 },
    // recordAnswered's reply-turnaround row (no `hash`) must NOT be counted
    // as a triage decision/call.
    { ts: '2026-01-01T00:00:03.000Z', type: 'answered', urgency: 'urgent', latencyMs: 960000 },
  ];

  const withoutTriage = buildReport(rows, {});
  assert.strictEqual(withoutTriage.integrations.find((r) => r.id === 'triage'), undefined,
    'sanity: with no triageRows opt, triage is absent (pre-fix behavior)');

  const report = buildReport(rows, { triageRows });
  const triage = report.integrations.find((r) => r.id === 'triage');
  assert.ok(triage, 'triage must appear as its own integration once real classification rows are supplied');
  assert.strictEqual(triage.calls, 3, 'only the 3 real classification rows count, not the answered/reply-turnaround row');
  assert.ok([500, 700, 300].includes(triage.p50));
  // th1+th2 report backend:'jev' -> 2/3 calls answered by Jev; th3 has no
  // backend field in the raw fixture at all, and must default to
  // 'baseline-only' (never left undefined) rather than being silently
  // dropped from the jevAnswered count.
  assert.strictEqual(Math.round(triage.jevAnsweredPct * triage.calls), 2);
});

// ---------------------------------------------------------------------------
// --by project|session and --project <name>: log rows carry a `project` key
// (repoKey/cwd basename, agnostic -- see hooks/lib/jev-assist.js's
// defaultProject()) and an optional `sessionId`. Rows missing either group
// under 'unknown', including genuinely old pre-feature rows.
// ---------------------------------------------------------------------------

test('parseArgs: --by and --project are parsed', () => {
  const { parseArgs } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const opts = parseArgs(['--by', 'session', '--project', 'anti-hall']);
  assert.strictEqual(opts.by, 'session');
  assert.strictEqual(opts.project, 'anti-hall');
});

test('groupKeyOf: falls back to "unknown" for a row missing the field (including a genuinely old pre-feature row)', () => {
  const { groupKeyOf } = require('../../plugins/anti-hall/scripts/jev-report.js');
  assert.strictEqual(groupKeyOf({ project: 'anti-hall' }, 'project'), 'anti-hall');
  assert.strictEqual(groupKeyOf({}, 'project'), 'unknown');
  assert.strictEqual(groupKeyOf({ id: 'speculation', base: false }, 'project'), 'unknown', 'an old row with no project field at all groups as unknown');
  assert.strictEqual(groupKeyOf({ sessionId: 's1' }, 'session'), 's1');
  assert.strictEqual(groupKeyOf({}, 'session'), 'unknown');
});

test('groupRowsBy: partitions rows into one bucket per distinct project/session value', () => {
  const { groupRowsBy } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const rows = [
    { id: 'speculation', project: 'anti-hall', sessionId: 's1' },
    { id: 'speculation', project: 'anti-hall', sessionId: 's2' },
    { id: 'speculation', project: 'other-repo', sessionId: 's3' },
    { id: 'speculation' }, // no project/session at all
  ];
  const byProject = groupRowsBy(rows, 'project');
  assert.deepStrictEqual(Array.from(byProject.keys()).sort(), ['anti-hall', 'other-repo', 'unknown']);
  assert.strictEqual(byProject.get('anti-hall').length, 2);
  assert.strictEqual(byProject.get('unknown').length, 1);

  const bySession = groupRowsBy(rows, 'session');
  assert.deepStrictEqual(Array.from(bySession.keys()).sort(), ['s1', 's2', 's3', 'unknown']);
});

test('jev-assist.js finalize(): auto-populates `project` from cwd basename when the caller supplies none, and logs `sessionId` only when provided', () => {
  const jevAssist = require('../../plugins/anti-hall/hooks/lib/jev-assist.js');
  const h = require('../helpers/fixtures.js').makeHome();
  try {
    jevAssist.ask({ id: 'speculation', question: null, state: 'x', trust: 'add-block', baseline: false, home: h.home });
  } finally {
    // ask() is async but its `off`-mode fast path (no jev.json here) resolves
    // synchronously before any await point, so the log line is already on
    // disk by the time this sync test reads it back -- same assumption
    // tests/hooks/jev-assist.test.js's own off-mode tests already make.
    const fs = require('node:fs');
    const path = require('node:path');
    const log = fs.readFileSync(path.join(h.home, '.anti-hall', 'logs', 'jev-assist.ndjson'), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.strictEqual(log.length, 1);
    assert.strictEqual(log[0].project, path.basename(process.cwd()));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(log[0], 'sessionId'), false, 'no sessionId passed -> field omitted, not null');
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Real cost SUMMED PER PROJECT: groupRowsBy('project') + buildReport per
// group already gives each group its own realCostTotal (buildReport is
// project-agnostic — it only ever sees the rows it's handed); this proves
// the composition actually sums correctly per project, and that
// printRealCostSummary renders it.
// ---------------------------------------------------------------------------

test('sum cost per project: groupRowsBy + buildReport gives each project its own independent realCostTotal', () => {
  const { groupRowsBy, buildReport } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const rows = [
    row({ id: 'speculation', h: 'p1a', project: 'proj-a', backend: 'jev', costUsd: 0.001, costSource: 'default-price' }),
    row({ id: 'speculation', h: 'p1b', project: 'proj-a', backend: 'jev', costUsd: 0.002, costSource: 'default-price' }),
    row({ id: 'speculation', h: 'p2a', project: 'proj-b', backend: 'jev', costUsd: 0.05, costSource: 'gateway' }),
    row({ id: 'modelRouting', h: 'p2b', project: 'proj-b', backend: 'jev', costUsd: 0.01, costSource: 'default-price' }),
  ];
  const groups = groupRowsBy(rows, 'project');
  const projA = buildReport(groups.get('proj-a'), {});
  const projB = buildReport(groups.get('proj-b'), {});
  const specA = projA.integrations.find((r) => r.id === 'speculation');
  assert.ok(Math.abs(specA.realCostTotal - 0.003) < 1e-9, 'proj-a speculation cost is scoped to proj-a rows only: ' + specA.realCostTotal);
  const specB = projB.integrations.find((r) => r.id === 'speculation');
  assert.ok(Math.abs(specB.realCostTotal - 0.05) < 1e-9, 'proj-b speculation must not include proj-a\'s cost: ' + specB.realCostTotal);
  const mrB = projB.integrations.find((r) => r.id === 'modelRouting');
  assert.ok(Math.abs(mrB.realCostTotal - 0.01) < 1e-9);
});

test('printRealCostSummary: renders total + per-integration real cost for a single group report', () => {
  const { buildReport, printRealCostSummary } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const rows = [
    row({ id: 'speculation', h: 'x1', backend: 'jev', costUsd: 0.002, costSource: 'default-price' }),
    row({ id: 'modelRouting', h: 'x2', backend: 'jev', costUsd: 0.001, costSource: 'gateway' }),
  ];
  const report = buildReport(rows, {});
  const lines = [];
  const origLog = console.log;
  console.log = (s) => lines.push(s);
  try { printRealCostSummary(report); } finally { console.log = origLog; }
  const out = lines.join('\n');
  assert.match(out, /real cost: \$0\.0030 total/);
  assert.match(out, /speculation: calls=1 \$0\.0020/);
  assert.match(out, /modelRouting: calls=1 \$0\.0010/);
});

test('printRealCostSummary: silent no-op when nothing in the group carries a real cost', () => {
  const { buildReport, printRealCostSummary } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const rows = [row({ id: 'speculation', h: 'x1' })];
  const report = buildReport(rows, {});
  const lines = [];
  const origLog = console.log;
  console.log = (s) => lines.push(s);
  try { printRealCostSummary(report); } finally { console.log = origLog; }
  assert.deepStrictEqual(lines, []);
});

// ---------------------------------------------------------------------------
// --weekly: a compact, always-7-day per-integration summary (verdict + reason)
// for the weekly scorecard SessionStart notice (hooks/jev-weekly-scorecard.js).
// ---------------------------------------------------------------------------

function makeRows(id, n, { changed = false } = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      ts: new Date().toISOString(), id, h: 'h' + i, base: false, jev: changed,
      conf: 0.95, ms: 100, backend: 'jev', final: changed, changed: changed ? 'added' : null,
      cached: false, mode: 'on',
    });
  }
  return rows;
}

test('buildWeeklyScorecard: KEEP candidate gets a reason citing changed/good-outcome rates', () => {
  const { buildWeeklyScorecard } = require('../../plugins/anti-hall/scripts/jev-report.js');
  // 60 calls, all changed (100% >> 5%), each with a good outcome -> KEEP.
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push({
      ts: new Date().toISOString(), id: 'speculation', h: 'h' + i, base: false, jev: true,
      conf: 0.95, ms: 100, backend: 'jev', final: true, changed: 'added', cached: false, mode: 'on',
    });
    rows.push({ type: 'outcome', id: 'speculation', h: 'h' + i, outcome: 'evidence-added' });
  }
  const scorecard = buildWeeklyScorecard(rows, { jevCfg: { enabled: true } });
  const spec = scorecard.integrations.find((r) => r.id === 'speculation');
  assert.strictEqual(spec.suggestion, 'KEEP');
  assert.match(spec.reason, /changed 100\.0%/);
  assert.match(spec.reason, /good-outcome 100\.0%/);
  assert.strictEqual(spec.mode, 'on', 'mode is read live from the passed jevCfg via getMode');
});

test('buildWeeklyScorecard: REVIEW (not enough data) reason is extracted verbatim from the suggestion', () => {
  const { buildWeeklyScorecard } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const scorecard = buildWeeklyScorecard(makeRows('modelRouting', 3), { jevCfg: {} });
  const r = scorecard.integrations.find((x) => x.id === 'modelRouting');
  assert.match(r.suggestion, /^REVIEW/);
  assert.match(r.reason, /not enough data: 3 < 50 calls/);
});

test('buildWeeklyScorecard: mode defaults per getMode when jevCfg has no integrations map', () => {
  const { buildWeeklyScorecard } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const scorecard = buildWeeklyScorecard(makeRows('speculation', 3), { jevCfg: { enabled: true } });
  const r = scorecard.integrations.find((x) => x.id === 'speculation');
  assert.strictEqual(r.mode, 'on', 'speculation is a LEGACY_ON_DEFAULT integration');
});

// ---------------------------------------------------------------------------
// FIX (v0.108.1, proven bug 1): a shadow-mode integration's `changed` field
// is always null by construction (jev-assist.js's finalize() only applies a
// change when mode==='on'), so reading `row.changed` for a shadow row always
// saw changedRate=0 and could hit REMOVE regardless of how good Jev's shadow
// answers actually were. jev-report.js now reads `row.wouldChange` for shadow
// rows instead (the same trust-rule outcome, computed without the mode gate).
// ---------------------------------------------------------------------------

function shadowRow(overrides) {
  return Object.assign({
    ts: new Date().toISOString(), id: 'shadowed', h: 'h1', base: true, jev: false,
    conf: 0.95, ms: 100, backend: 'jev', final: true, changed: null, cached: false, mode: 'shadow',
  }, overrides);
}

test('buildReport: shadow-mode rows use wouldChange for yield, not changed (which is always null in shadow)', () => {
  const rows = [];
  for (let i = 0; i < 60; i++) {
    // 60 shadow rows (>= MIN_CALLS_FOR_VERDICT), all "would have relaxed" --
    // changed is null (shadow never applies it) but wouldChange carries the
    // real trust-rule outcome.
    rows.push(shadowRow({ h: 'h' + i, wouldChange: 'relaxed' }));
    rows.push({ ts: new Date().toISOString(), type: 'outcome', id: 'shadowed', h: 'h' + i, outcome: 'evidence-added' });
  }
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'shadowed');
  assert.strictEqual(r.changed.relaxed, 60, 'wouldChange direction is counted the same way changed would be for an \'on\' row');
  assert.strictEqual(r.changedUnique, 60);
  assert.strictEqual(r.changedRate, 1);
  assert.strictEqual(r.suggestion, 'KEEP', 'a shadow integration with a real, good wouldChange signal can now earn KEEP/REMOVE like an \'on\' one');
});

test('buildReport: shadow-mode rows with changed:null and no wouldChange (pre-fix log shape) still yield changedRate 0, not a crash', () => {
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push(shadowRow({ h: 'h' + i })); // no wouldChange field at all
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'shadowed');
  assert.strictEqual(r.changedUnique, 0);
  assert.strictEqual(r.changedRate, 0);
});

test('buildReport: label-only rows (string jev answer) are excluded from changedRate even if `changed`/`wouldChange` is set', () => {
  const rows = [];
  for (let i = 0; i < 60; i++) {
    // A malformed/defensive row where a label-only answer somehow carries a
    // changed/wouldChange direction -- must still be excluded, since a
    // string `jev` answer has no boolean baseline to have "changed" at all.
    rows.push(shadowRow({ id: 'newRequest', h: 'h' + i, jev: 'new-request', base: null, wouldChange: 'changed' }));
  }
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'newRequest');
  assert.strictEqual(r.changedUnique, 0, 'label-only rows never contribute to changedRate');
  assert.match(r.suggestion, /label-only/);
});

// FIX (v0.108.3): a label-only integration's changed% used to render as a
// bare "0" / "0 changed" -- indistinguishable from "Jev never changed
// anything here" -- even though there is no boolean outcome to diff at all.
// The report must instead surface the real distinct-decision count (unique
// content hashes) split fresh vs cache, both in the table's status note and
// in buildHeadline()'s one-line summary.
test('buildReport: label-only integration reports distinct-decision count (fresh vs cache), not a bare 0', () => {
  const rows = [];
  // 25 distinct decisions, each first seen fresh, then re-answered from
  // cache 3x (a real retry pattern) -- the fresh/cache split must count
  // each decision ONCE regardless of how many cache hits share its hash.
  for (let i = 0; i < 25; i++) {
    rows.push(shadowRow({ id: 'supervisorBlockerLabel', h: 'h' + i, jev: 'wedged', base: null, backend: 'jev' }));
    for (let c = 0; c < 3; c++) {
      rows.push(shadowRow({ id: 'supervisorBlockerLabel', h: 'h' + i, jev: 'wedged', base: null, backend: 'cache', cached: true }));
    }
  }
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'supervisorBlockerLabel');
  assert.strictEqual(r.isLabelOnly, true);
  assert.strictEqual(r.changedUnique, 0, 'still no boolean changed count');
  assert.strictEqual(r.labelDistinctDecisions, 25, 'all rows (fresh+cache) collapse to 25 distinct hashes');
  assert.strictEqual(r.labelDistinctFresh, 25, 'exactly the fresh occurrence of each hash counts');
  assert.strictEqual(
    r.labelOnlyNote,
    'label-only: no boolean outcome to compare; 25 distinct decisions (25 fresh)',
  );
  const headline = buildHeadline(r, '24h');
  assert.match(headline, /25 distinct decisions\/24h \(label-only\)/);
  assert.doesNotMatch(headline, /^supervisorBlockerLabel: 0 changed/);
});

// ---------------------------------------------------------------------------
// FIX (v0.108.1, proven bug 3): --since/--until/--exclude-window let a report
// exclude a known-accidental run (e.g. the 2026-09-24T19:56Z..22:23Z
// supervisorBlockerLabel rows) without touching jev-assist.ndjson itself.
// ---------------------------------------------------------------------------

test('parseArgs: --since/--until/--exclude-window are parsed', () => {
  const { parseArgs, parseIsoMs } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const opts = parseArgs(['--since', '2026-09-01T00:00:00Z', '--until', '2026-09-30T00:00:00Z',
    '--exclude-window', '2026-09-24T19:56:00Z..2026-09-24T22:23:00Z']);
  assert.strictEqual(opts.since, parseIsoMs('2026-09-01T00:00:00Z'));
  assert.strictEqual(opts.until, parseIsoMs('2026-09-30T00:00:00Z'));
  assert.deepStrictEqual(opts.excludeWindows, [[parseIsoMs('2026-09-24T19:56:00Z'), parseIsoMs('2026-09-24T22:23:00Z')]]);
});

test('parseArgs: an unparseable --exclude-window value is dropped, not thrown', () => {
  const { parseArgs } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const opts = parseArgs(['--exclude-window', 'not-a-window']);
  assert.strictEqual(opts.excludeWindows, undefined);
});

test('filterByTimeWindow: --since/--until bound the row set; a row with no ts passes through', () => {
  const { filterByTimeWindow } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const rows = [
    { ts: '2026-09-01T00:00:00Z', id: 'a' },
    { ts: '2026-09-15T00:00:00Z', id: 'b' },
    { ts: '2026-09-30T00:00:00Z', id: 'c' },
    { id: 'd' }, // no ts at all
  ];
  const out = filterByTimeWindow(rows, { since: Date.parse('2026-09-10T00:00:00Z'), until: Date.parse('2026-09-20T00:00:00Z') });
  assert.deepStrictEqual(out.map((r) => r.id), ['b', 'd']);
});

test('filterByTimeWindow: --exclude-window drops rows inside the interval, keeps rows outside it', () => {
  const { filterByTimeWindow } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const rows = [
    { ts: '2026-09-24T19:00:00Z', id: 'before' },
    { ts: '2026-09-24T20:30:00Z', id: 'inside' },
    { ts: '2026-09-24T23:00:00Z', id: 'after' },
  ];
  const out = filterByTimeWindow(rows, {
    since: null, until: null,
    excludeWindows: [[Date.parse('2026-09-24T19:56:00Z'), Date.parse('2026-09-24T22:23:00Z')]],
  });
  assert.deepStrictEqual(out.map((r) => r.id), ['before', 'after']);
});

test('buildReport via filterByTimeWindow: excluding the accidental run window removes those rows from the aggregate', () => {
  const { filterByTimeWindow } = require('../../plugins/anti-hall/scripts/jev-report.js');
  const accidentalRows = [];
  for (let i = 0; i < 50; i++) {
    accidentalRows.push(row({ id: 'supervisorBlockerLabel', h: 'acc' + i, ts: '2026-09-24T20:30:00.000Z' }));
  }
  const realRows = [];
  for (let i = 0; i < 10; i++) {
    realRows.push(row({ id: 'supervisorBlockerLabel', h: 'real' + i, ts: '2026-09-25T10:00:00.000Z' }));
  }
  const filtered = filterByTimeWindow(accidentalRows.concat(realRows), {
    since: null, until: null,
    excludeWindows: [[Date.parse('2026-09-24T19:56:00Z'), Date.parse('2026-09-24T22:23:00Z')]],
  });
  assert.strictEqual(filtered.length, 10, 'only the real rows survive the exclusion window');
  const report = buildReport(filtered, {});
  const r = report.integrations.find((x) => x.id === 'supervisorBlockerLabel');
  assert.strictEqual(r.calls, 10);
});

// ---------------------------------------------------------------------------
// item 3 (reproducibility): describeWindow()/printWindow() surface the
// EFFECTIVE --since/--until/--exclude-window and the rows counted/excluded,
// so two analyses run against the same window can actually be compared.
// ---------------------------------------------------------------------------

test('describeWindow: since/until given -> ISO strings + row counts/excluded reported', () => {
  const opts = { since: parseIsoMs('2026-09-01T00:00:00Z'), until: parseIsoMs('2026-09-30T00:00:00Z'), excludeWindows: [] };
  const w = describeWindow(opts, 100, 42);
  assert.strictEqual(w.since, '2026-09-01T00:00:00.000Z');
  assert.strictEqual(w.until, '2026-09-30T00:00:00.000Z');
  assert.deepStrictEqual(w.excludeWindows, []);
  assert.strictEqual(w.rowsTotal, 100);
  assert.strictEqual(w.rowsInWindow, 42);
  assert.strictEqual(w.rowsExcluded, 58);
});

test('describeWindow: nothing given -> since/until null (the full log), zero excluded', () => {
  const opts = { since: null, until: null, excludeWindows: [] };
  const w = describeWindow(opts, 30, 30);
  assert.strictEqual(w.since, null);
  assert.strictEqual(w.until, null);
  assert.strictEqual(w.rowsExcluded, 0);
});

test('describeWindow: --exclude-window intervals are reported as ISO pairs', () => {
  const opts = {
    since: null, until: null,
    excludeWindows: [[Date.parse('2026-09-24T19:56:00Z'), Date.parse('2026-09-24T22:23:00Z')]],
  };
  const w = describeWindow(opts, 60, 10);
  assert.deepStrictEqual(w.excludeWindows, [['2026-09-24T19:56:00.000Z', '2026-09-24T22:23:00.000Z']]);
  assert.strictEqual(w.rowsExcluded, 50);
});

test('printWindow: prints the window bounds and the counted/excluded rows on one line', () => {
  const w = describeWindow(
    { since: parseIsoMs('2026-09-01T00:00:00Z'), until: parseIsoMs('2026-09-30T00:00:00Z'), excludeWindows: [] },
    100, 42
  );
  const lines = captureLogs(() => printWindow(w));
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /^window:/);
  assert.match(lines[0], /2026-09-01T00:00:00\.000Z/);
  assert.match(lines[0], /2026-09-30T00:00:00\.000Z/);
  assert.match(lines[0], /42 in window \/ 100 total/);
  assert.match(lines[0], /58 excluded/);
});

test('printWindow: no --since/--until -> reports "(log start)"/"(log end)", not a null/undefined string', () => {
  const w = describeWindow({ since: null, until: null, excludeWindows: [] }, 5, 5);
  const lines = captureLogs(() => printWindow(w));
  assert.match(lines[0], /\(log start\) \.\. \(log end\)/);
  assert.doesNotMatch(lines[0], /null|undefined/);
});

// ---------------------------------------------------------------------------
// FIX (v0.108.3): a choice/label integration (typeof row.jev === 'string',
// e.g. newRequest) forced effectiveDirection to null for EVERY row, so its
// would-change decisions never entered changedHashByFresh. tp/fp accounting
// (humanLabelByHash / autoTP / autoFP) iterated only changedHashByFresh, and
// the `bucket.labeled > 0 && known === 0` short-circuit always won first --
// so owner-delegated tp/fp labels on would-change choice decisions were read
// but never counted, and a choice integration could NEVER reach KEEP/REMOVE.
// Fix: a would-change (wouldChange/changed truthy), fresh, hashed choice row
// joins a label-candidate set (labelWouldChangeHashesFresh) that feeds the
// SAME precision/labelled-sample pipeline as changedHashByFresh, while
// changedRate/changedUnique stay untouched (0) since added/relaxed/changed
// semantics don't apply to a choice answer.
// ---------------------------------------------------------------------------

function choiceRow(overrides) {
  return Object.assign({
    ts: new Date().toISOString(), id: 'newRequest', h: 'h1', base: null, jev: 'new-request',
    conf: 0.9, ms: 100, backend: 'jev', final: true, changed: 'changed', cached: false, mode: 'on',
  }, overrides);
}

test('buildReport: choice integration, would-change rows + 20 labels, mostly TP -> KEEP-eligible', () => {
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push(choiceRow({ h: 'h' + i }));
  }
  // 25 labelled outcomes (>= MIN_LABELED_FOR_VERDICT): 22 good, 3 bad ->
  // goodOutcomeRate 0.88 >= KEEP_GOOD_OUTCOME_RATE (0.80).
  for (let i = 0; i < 22; i++) rows.push({ ts: new Date().toISOString(), type: 'outcome', id: 'newRequest', h: 'h' + i, outcome: 'evidence-added' });
  for (let i = 22; i < 25; i++) rows.push({ ts: new Date().toISOString(), type: 'outcome', id: 'newRequest', h: 'h' + i, outcome: 'user-override' });
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'newRequest');
  assert.strictEqual(r.changedUnique, 0, 'choice rows never enter changedHashByFresh/changedRate');
  assert.strictEqual(r.changedRate, 0);
  assert.strictEqual(r.labelWouldChangeUnique, 60, 'all 60 would-change choice decisions joined the label-candidate set');
  assert.strictEqual(r.autoTP, 22);
  assert.strictEqual(r.autoFP, 3);
  assert.ok(Math.abs(r.goodOutcomeRate - 22 / 25) < 1e-9);
  assert.strictEqual(r.suggestion, 'KEEP', 'labelled would-change choice decisions must be able to reach KEEP');
});

test('buildReport: choice integration, would-change rows + labelled sample, mostly FP -> REMOVE', () => {
  const rows = [];
  for (let i = 0; i < 200; i++) {
    rows.push(choiceRow({ h: 'h' + i }));
  }
  // 25 labelled outcomes: 5 good, 20 bad -> goodOutcomeRate 0.20 < 0.60.
  for (let i = 0; i < 5; i++) rows.push({ ts: new Date().toISOString(), type: 'outcome', id: 'newRequest', h: 'h' + i, outcome: 'evidence-added' });
  for (let i = 5; i < 25; i++) rows.push({ ts: new Date().toISOString(), type: 'outcome', id: 'newRequest', h: 'h' + i, outcome: 'user-override' });
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'newRequest');
  assert.strictEqual(r.autoTP, 5);
  assert.strictEqual(r.autoFP, 20);
  assert.strictEqual(r.suggestion, 'REMOVE', 'a proven bad-outcome rate on labelled would-change choice decisions must earn REMOVE');
});

test('buildReport: choice integration, tp/fp labels on NON-would-change rows are ignored (never counted)', () => {
  const rows = [];
  for (let i = 0; i < 60; i++) {
    // changed: null -> not a would-change row -- must not join the
    // label-candidate set even though it carries an `h`.
    rows.push(choiceRow({ h: 'h' + i, changed: null }));
  }
  const humanLabelByHash = new Map();
  for (let i = 0; i < 25; i++) humanLabelByHash.set('h' + i, 'tp');
  const report = buildReport(rows, { humanLabelByHash });
  const r = report.integrations.find((x) => x.id === 'newRequest');
  assert.strictEqual(r.labelWouldChangeUnique, 0, 'no row was would-change, so no hash joins the candidate set');
  assert.strictEqual(r.humanTP, 0, 'labels on non-would-change hashes are never counted');
  assert.strictEqual(r.humanFP, 0);
  assert.match(r.suggestion, /label-only, no outcome signal yet/, 'stays label-only since labeledSample is still 0');
});

test('buildReport: boolean integration is unaffected by the choice-label fix (labelWouldChangeUnique stays 0)', () => {
  const rows = [];
  for (let i = 0; i < 100; i++) {
    const changed = i < 30;
    rows.push(row({ id: 'speculation', h: 'h' + i, changed: changed ? 'added' : null }));
  }
  for (let i = 0; i < 27; i++) rows.push({ ts: new Date().toISOString(), type: 'outcome', id: 'speculation', h: 'h' + i, outcome: 'evidence-added' });
  for (let i = 27; i < 30; i++) rows.push({ ts: new Date().toISOString(), type: 'outcome', id: 'speculation', h: 'h' + i, outcome: 'user-override' });
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'speculation');
  assert.strictEqual(r.labelWouldChangeUnique, 0, 'a boolean integration never populates labelWouldChangeHashesFresh');
  assert.strictEqual(r.suggestion, 'KEEP');
  assert.ok(Math.abs(r.goodOutcomeRate - 0.9) < 1e-9);
});
