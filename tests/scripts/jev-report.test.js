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
  auditLogPath, readAuditSnippet, cmdPruneAudit,
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

test('buildReport: agreement% is computed from `compare`, never from `base` (base is trust-rule math, sometimes a hardcoded constant)', () => {
  const rows = [
    row({ id: 'x', jev: true, base: false, compare: true }),
    row({ id: 'x', jev: false, base: false, compare: true }),
    row({ id: 'x', jev: null, base: false, backend: 'baseline-only' }),
  ];
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'x');
  assert.ok(Math.abs(r.agreementPct - 0.5) < 1e-9);
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
    row({ id: 'mixed', jev: true, compare: true }),
    row({ id: 'mixed', jev: false, compare: true }), // disagreement
    row({ id: 'mixed', jev: true, base: false }), // no compare -> excluded
  ];
  const report = buildReport(rows, {});
  const r = report.integrations.find((x) => x.id === 'mixed');
  assert.ok(Math.abs(r.agreementPct - 0.5) < 1e-9);
  assert.strictEqual(r.excludedNoCompare, 1);
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
