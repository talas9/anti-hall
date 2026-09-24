'use strict';
// v0.108.0 contract 5 — scripts/jev-report.js.
//
// BASE (already shipped, exercised for real below): reads
// ~/.anti-hall/logs/jev-assist.ndjson, groups rows by integration `id`,
// reports calls/jevAnsweredPct/cacheHits/changed/costEstimate, and honors
// jev.json's costPerCall for an estimated cost field (null when unset).
//
// v0.108.0 EXTENDS this contract with two pieces not yet in this working
// tree:
//   (a) CHANGED-DEDUPE: today, `buildReport` increments `changed.<direction>`
//       once per LOG ROW. A single logical decision that is looked up 1 time
//       fresh + 5 times from cache (same content hash `h`, same direction)
//       currently counts as 6 "changed" events — confirmed by reading
//       scripts/jev-report.js's per-row accumulation loop, which has no
//       hash-based dedup. The agreed v0.108.0 contract is that a fresh call
//       plus its cache hits for the SAME hash counts as exactly ONE changed
//       decision. GATED below.
//   (b) BUDGET MODE (unlimited vs watch): no `budget`/`unlimited`/`watch`
//       concept exists anywhere in jev-report.js or jev.json today (grepped,
//       zero hits). GATED below.
//
// GATE: unreleasedMentions() checks CHANGELOG.md's "## Unreleased" section,
// this repo's own convention for a landed-but-not-yet-versioned change, for
// the keyword naming each sub-feature. This is a concrete file-content
// check (never a behavioral pre-run) and flips on the moment the change is
// documented as landed, per this repo's own documented convention (see
// CHANGELOG.md's header: "Every behavioral change MUST bump plugin.json
// version" — paired with an Unreleased bullet first).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { makeHome, rm, antiHallDir, writeJson, runCliScript, unreleasedMentions } = require('./lib.js');

const HAS_CHANGED_DEDUPE = unreleasedMentions('changed-decision dedup') || unreleasedMentions('dedupe') && unreleasedMentions('jev report');
const HAS_BUDGET_MODE = unreleasedMentions('budget mode') || (unreleasedMentions('unlimited') && unreleasedMentions('watch'));

const DEDUPE_GATE = { skip: HAS_CHANGED_DEDUPE ? false : 'feature not in base: jev-report changed-decision hash-dedup (CHANGELOG "## Unreleased" has no matching entry)' };
const BUDGET_GATE = { skip: HAS_BUDGET_MODE ? false : 'feature not in base: jev-report budget mode (unlimited vs watch) (CHANGELOG "## Unreleased" has no matching entry)' };

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

test('BASE (documents the pre-v0.108.0 gap): 1 fresh + 5 cached rows of ONE hash currently count as 6 changed events, not 1', () => {
  // This test pins down TODAY's real (undesired) behavior so the gap is
  // visible and the DEDUPE_GATE test above it flips the moment the fix
  // lands — it is not the target contract itself.
  const home = makeHome();
  try {
    const rows = [decisionRow({ id: 'claimLedger', h: 'shared-hash', backend: 'jev', cached: false })];
    for (let i = 0; i < 5; i++) rows.push(decisionRow({ id: 'claimLedger', h: 'shared-hash', backend: 'cache', cached: true }));
    writeLog(home, rows);
    const r = runReport(home, ['--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    const claimLedger = r.json.integrations.find((i) => i.id === 'claimLedger');
    assert.strictEqual(claimLedger.changed.added, 6, 'pre-v0.108.0 behavior: no hash dedup, every row counts');
  } finally { rm(home); }
});

// ── v0.108.0: changed-decision hash-dedupe (gated) ────────────────────────
test(
  'v0.108.0: 1 fresh + 5 cached rows of ONE hash => changed counted ONCE',
  DEDUPE_GATE,
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
  DEDUPE_GATE,
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

// ── v0.108.0: budget mode unlimited vs watch (gated) ──────────────────────
test(
  'v0.108.0: budget mode "unlimited" => no budget warning regardless of cost/call volume',
  BUDGET_GATE,
  () => {
    const home = makeHome();
    try {
      writeJson(path.join(antiHallDir(home), 'jev.json'), { costPerCall: 1.0, budgetMode: 'unlimited', budgetMonthly: 1 });
      const rows = [];
      for (let i = 0; i < 500; i++) rows.push(decisionRow({ id: 'claimLedger', h: `h${i}` }));
      writeLog(home, rows);
      const r = runReport(home, ['--json']);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /budget exceeded|over budget/i);
    } finally { rm(home); }
    },
);

test(
  'v0.108.0: budget mode "watch" => flags when estimated cost exceeds the configured monthly budget',
  BUDGET_GATE,
  () => {
    const home = makeHome();
    try {
      writeJson(path.join(antiHallDir(home), 'jev.json'), { costPerCall: 1.0, budgetMode: 'watch', budgetMonthly: 1 });
      const rows = [];
      for (let i = 0; i < 500; i++) rows.push(decisionRow({ id: 'claimLedger', h: `h${i}` }));
      writeLog(home, rows);
      const r = runReport(home, ['--json']);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.match(r.stdout + JSON.stringify(r.json), /budget/i);
    } finally { rm(home); }
  },
);
