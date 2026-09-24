'use strict';
// v0.108.0 contract 5 — scripts/jev-report.js.
//
// BASE (already shipped, exercised for real below): reads
// ~/.anti-hall/logs/jev-assist.ndjson, groups rows by integration `id`,
// reports calls/jevAnsweredPct/cacheHits/changed/costEstimate, and honors
// jev.json's costPerCall for an estimated cost field (null when unset).
//
// v0.108.0 adds (exercised live below):
//   (a) CHANGED-DEDUPE: a fresh call plus its cache hits for the SAME content
//       hash counts as exactly ONE changed decision (calls still count every
//       row).
//   (b) BUDGET WATCH: settings jev.budget.mode "watch" + usdPerDay/usdPerWeek
//       compare the real per-call `costUsd` logged by jev-assist against the
//       budget and report `budgetStatus` (observability only — Jev is never
//       disabled). "unlimited" (the default) reports no budget status.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { makeHome, rm, antiHallDir, writeJson, runCliScript } = require('./lib.js');

function logPath(home) { return path.join(antiHallDir(home), 'logs', 'jev-assist.ndjson'); }
function writeLog(home, rows) {
  const p = logPath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

// A real jev-assist.ndjson decision row, matching the exact shape
// hooks/lib/jev-assist.js's finalize() writes (ts, id, h, base, jev, conf,
// ms, backend, final, changed, cached, mode) — confirmed by reading that
// function directly, not guessed.
function decisionRow({ id, h, backend, changed, cached, ms }) {
  return {
    ts: new Date().toISOString(),
    id: id || 'claimLedger',
    h: h || 'hash-1',
    base: false,
    jev: true,
    conf: 0.9,
    ms: ms == null ? 120 : ms,
    backend: backend || 'jev',
    final: true,
    changed: changed === undefined ? 'added' : changed,
    cached: !!cached,
    mode: 'on',
  };
}

function runReport(home, args) {
  return runCliScript('jev-report.js', ['--home', home, ...(args || [])], home);
}

// ── BASE: real, exercised against the shipped script ─────────────────────
test('BASE: one integration id, multiple calls => calls/jevAnsweredPct/cacheHits reported correctly', () => {
  const home = makeHome();
  try {
    writeLog(home, [
      decisionRow({ id: 'claimLedger', h: 'h1', backend: 'jev', cached: false }),
      decisionRow({ id: 'claimLedger', h: 'h1', backend: 'cache', cached: true }),
      decisionRow({ id: 'claimLedger', h: 'h1', backend: 'cache', cached: true }),
    ]);
    const r = runReport(home, ['--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    const out = r.json;
    assert.ok(out, `expected JSON output; stdout: ${r.stdout}`);
    const claimLedger = out.integrations.find((i) => i.id === 'claimLedger');
    assert.strictEqual(claimLedger.calls, 3);
    assert.strictEqual(claimLedger.cacheHits, 2);
    assert.strictEqual(claimLedger.jevAnsweredPct, 1);
  } finally { rm(home); }
});

test('BASE: costEstimate is null when jev.json has no costPerCall set', () => {
  const home = makeHome();
  try {
    writeLog(home, [decisionRow({ id: 'claimLedger' })]);
    const r = runReport(home, ['--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.json.costPerCallKnown, false);
    const claimLedger = r.json.integrations.find((i) => i.id === 'claimLedger');
    assert.strictEqual(claimLedger.costEstimate, null);
  } finally { rm(home); }
});

test('BASE: costEstimate = calls * jev.json costPerCall when set', () => {
  const home = makeHome();
  try {
    writeJson(path.join(antiHallDir(home), 'jev.json'), { costPerCall: 0.002 });
    writeLog(home, [
      decisionRow({ id: 'claimLedger', h: 'h1' }),
      decisionRow({ id: 'claimLedger', h: 'h2' }),
    ]);
    const r = runReport(home, ['--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.json.costPerCallKnown, true);
    const claimLedger = r.json.integrations.find((i) => i.id === 'claimLedger');
    assert.ok(Math.abs(claimLedger.costEstimate - 0.004) < 1e-9, `expected ~0.004, got ${claimLedger.costEstimate}`);
  } finally { rm(home); }
});

// ── v0.108.0: changed-decision hash-dedupe ────────────────────────────────
test(
  'v0.108.0: 1 fresh + 5 cached rows of ONE hash => changed counted ONCE',
  () => {
    const home = makeHome();
    try {
      const rows = [decisionRow({ id: 'claimLedger', h: 'shared-hash', backend: 'jev', cached: false })];
      for (let i = 0; i < 5; i++) rows.push(decisionRow({ id: 'claimLedger', h: 'shared-hash', backend: 'cache', cached: true }));
      writeLog(home, rows);
      const r = runReport(home, ['--json']);
      assert.strictEqual(r.status, 0, r.stderr);
      const claimLedger = r.json.integrations.find((i) => i.id === 'claimLedger');
      assert.strictEqual(claimLedger.calls, 6, 'call count itself must still count every row');
      assert.strictEqual(claimLedger.changed.added, 1, 'changed-decision count must dedupe by hash to 1');
    } finally { rm(home); }
  },
);

test(
  'v0.108.0: two DIFFERENT hashes each changed => counted as 2, not collapsed together',
  () => {
    const home = makeHome();
    try {
      writeLog(home, [
        decisionRow({ id: 'claimLedger', h: 'hash-a', backend: 'jev', cached: false }),
        decisionRow({ id: 'claimLedger', h: 'hash-a', backend: 'cache', cached: true }),
        decisionRow({ id: 'claimLedger', h: 'hash-b', backend: 'jev', cached: false }),
      ]);
      const r = runReport(home, ['--json']);
      assert.strictEqual(r.status, 0, r.stderr);
      const claimLedger = r.json.integrations.find((i) => i.id === 'claimLedger');
      assert.strictEqual(claimLedger.changed.added, 2, 'distinct hashes must not be deduped against each other');
    } finally { rm(home); }
  },
);

// ── v0.108.0: budget watch (settings jev.budget.*) ───────────────────────
function costRows(n, costUsd) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(Object.assign(decisionRow({ id: 'claimLedger', h: `h${i}` }), { costUsd }));
  return rows;
}

test('v0.108.0: budget mode "unlimited" (default) => no budget status, whatever the spend', () => {
  const home = makeHome();
  try {
    writeJson(path.join(antiHallDir(home), 'settings.json'), { jev: { 'budget.usdPerDay': 0.01 } });
    writeLog(home, costRows(50, 0.5));
    const r = runReport(home, ['--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.json.budget.mode, 'unlimited');
    assert.strictEqual(r.json.budgetStatus, null);
    const human = runReport(home, []);
    assert.doesNotMatch(human.stdout, /OVER BUDGET|exceeded/i);
  } finally { rm(home); }
});

test('v0.108.0: budget mode "watch" => 24h spend over usdPerDay is flagged exceeded; under is not', () => {
  const home = makeHome();
  try {
    writeJson(path.join(antiHallDir(home), 'settings.json'), { jev: { 'budget.mode': 'watch', 'budget.usdPerDay': 1, 'budget.usdPerWeek': 100 } });
    writeLog(home, costRows(4, 0.5)); // $2.00 today
    const r = runReport(home, ['--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.json.budget.mode, 'watch');
    assert.strictEqual(r.json.budgetStatus['24h'].exceeded, true);
    assert.ok(Math.abs(r.json.budgetStatus['24h'].spentUsd - 2) < 1e-9);
    assert.strictEqual(r.json.budgetStatus['7d'].exceeded, false);
  } finally { rm(home); }
});

test('v0.108.0: legacy jev.json {"budget": {...}} still drives budget watch when settings.json has none', () => {
  const home = makeHome();
  try {
    writeJson(path.join(antiHallDir(home), 'jev.json'), { budget: { mode: 'watch', usdPerDay: 1 } });
    writeLog(home, costRows(3, 0.5));
    const r = runReport(home, ['--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.json.budgetStatus['24h'].exceeded, true);
  } finally { rm(home); }
});
