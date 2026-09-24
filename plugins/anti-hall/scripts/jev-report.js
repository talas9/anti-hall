#!/usr/bin/env node
'use strict';
// anti-hall :: jev report — read-only summary of ~/.anti-hall/logs/jev-assist.ndjson.
//
// USAGE
//   node plugins/anti-hall/scripts/jev-report.js [--days 7] [--json]
//
// For each integration id seen in the log, reports: calls, jev-answered %
// (backend 'jev' or 'cache' vs 'baseline-only'), cache hits, agreement %
// (Jev's answer vs the caller-supplied `compare` field -- an INDEPENDENT
// heuristic verdict, e.g. speculation-guard's regex check -- only counted
// where both exist; rows with no `compare` field are excluded from this
// metric and counted separately as `excludedNoCompare`, since `base` is
// trust-rule math, not a real verdict, for some callers (e.g.
// speculation-guard's baseline is a hardcoded `false`) and comparing jev
// against it would silently measure something else, e.g. "rate Jev said
// not-speculative"), decisions changed (split by direction:
// 'added'/'relaxed'/'changed'), outcome rates (from recordOutcome lines,
// joined back to a decision by hash — an outcome is counted as "good" unless
// its name matches BAD_OUTCOME_RE below), latency p50/p95, an ESTIMATED cost
// (calls * jev.json `costPerCall`, or "n/a" if unset — this is a rough
// estimate, not a bill), and a KEEP / REVIEW / REMOVE suggestion.
//
// THRESHOLDS (documented here, not buried in code — tune by editing these):
//   MIN_CALLS_FOR_VERDICT = 50   below this, always "REVIEW (not enough data)"
//   REMOVE if, over >= 200 calls:
//     - changed-decision rate < 1%  (Jev almost never moves the outcome), OR
//     - good-outcome rate < 60% among changed decisions with a known outcome, OR
//     - failure rate (backend baseline-only due to a real jevDecide error,
//       i.e. NOT counting 'disabled'/'off'/'not-applicable') > 20%
//   KEEP if changed-decision rate >= 5% AND good-outcome rate >= 80% AND at
//     least one outcome has actually been observed (a NULL good-outcome rate
//     — no outcome signal at all yet — can NEVER earn KEEP, regardless of
//     changed-decision rate; it earns REVIEW instead).
//   REVIEW otherwise (includes: p95 latency > the integration's own configured
//     budget, or anything not meeting KEEP/REMOVE above).
//
// DEDUPE BY DECISION (content hash `h`): a Stop-hook retry (or any caller
// re-asking the same content) produces MULTIPLE log rows sharing one hash --
// one fresh call, then N cache hits. `changed`/`changedUnique`/`changedRate`,
// the outcome join, and `costEstimate` all count/charge each UNIQUE hash
// ONCE, from its fresh row only -- a cache hit is never a new decision and
// never costs anything, so it is excluded from all three, not just
// de-duplicated. `calls` stays the raw row count (fresh+cached, shown as
// "calls (fresh/cached)"); `changedRate` and `costEstimate` are computed
// against `freshCalls` (`calls - cachedCalls`), never `calls`.
//
// LABEL-ONLY INTEGRATIONS (e.g. newRequest, a `choice` classifier with no
// boolean baseline to agree/disagree against): `agreementPct` is n/a (no
// baseline), so the table instead reports a `label%` column — the top Jev
// answer's share of calls — with the full distribution available via --json.
// These integrations report a suggestion of their own too, but per the KEEP
// rule above can never reach KEEP until a human-supplied outcome exists.
//
// TRIAGE ANSWER-TIME (hooks/lib/jev-triage.js recordAnswered): a SEPARATE
// section (not part of the per-integration table, since it's latency data
// keyed by urgency label, not a jev-assist.ndjson decision row) reads
// jev-triage.ndjson's {type:'answered', urgency, latencyMs} rows and reports
// p50/p95 time-to-answer for urgent vs non-urgent labeled messages.
//
// This script only READS the log; it never mutates jev.json or any state.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MIN_CALLS_FOR_VERDICT = 50;
const REMOVE_MIN_CALLS = 200;
const REMOVE_CHANGED_RATE = 0.01;
const REMOVE_GOOD_OUTCOME_RATE = 0.60;
const REMOVE_FAILURE_RATE = 0.20;
const KEEP_CHANGED_RATE = 0.05;
const KEEP_GOOD_OUTCOME_RATE = 0.80;

// Outcome names treated as evidence Jev's changed decision was WRONG. Every
// other named outcome (e.g. 'evidence-added', 'answered') counts as "good".
const BAD_OUTCOME_RE = /^(user-override|false-positive|wrong|bad|reverted|repeat-speculation)/i;

// A jevDecide-level failure (real error), as opposed to the integration
// simply being off/shadow/not-applicable for this call.
const FAILURE_REASONS = new Set([
  'timeout', 'network-error', 'no-key', 'parse-error', 'bad-response', 'error',
]);
function isHttpFailure(reason) {
  return typeof reason === 'string' && (/^http-/.test(reason) || FAILURE_REASONS.has(reason));
}

function logPath(home) {
  return path.join((home || os.homedir()), '.anti-hall', 'logs', 'jev-assist.ndjson');
}

function triageLogPath(home) {
  return path.join((home || os.homedir()), '.anti-hall', 'logs', 'jev-triage.ndjson');
}

function jevConfigPath(home) {
  return path.join((home || os.homedir()), '.anti-hall', 'jev.json');
}

function readCostPerCall(home) {
  try {
    const raw = fs.readFileSync(jevConfigPath(home), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && Number.isFinite(parsed.costPerCall)) ? parsed.costPerCall : null;
  } catch (_) {
    return null;
  }
}

// readBudgetConfig(home) -> {mode, usdPerDay, usdPerWeek}. No
// hooks/lib/settings.js get('jev', ...) accessor exists in this codebase
// (checked) -- read directly from jev.json's `budget` key, mirroring
// hooks/lib/jev-assist.js's own readBudgetConfig. mode defaults
// "unlimited" (report shows no budget section at all).
function readBudgetConfig(home) {
  try {
    const raw = fs.readFileSync(jevConfigPath(home), 'utf8');
    const parsed = JSON.parse(raw);
    const b = (parsed && parsed.budget && typeof parsed.budget === 'object') ? parsed.budget : {};
    const mode = b.mode === 'watch' ? 'watch' : 'unlimited';
    const usdPerDay = (Number.isFinite(b.usdPerDay) && b.usdPerDay > 0) ? b.usdPerDay : null;
    const usdPerWeek = (Number.isFinite(b.usdPerWeek) && b.usdPerWeek > 0) ? b.usdPerWeek : null;
    return { mode, usdPerDay, usdPerWeek };
  } catch (_) {
    return { mode: 'unlimited', usdPerDay: null, usdPerWeek: null };
  }
}

// computeBudgetStatus(rows, budget) -> null (mode !== 'watch') or
// {'24h': {spentUsd, budgetUsd, exceeded}|null, '7d': {...}|null} — spend is
// summed across ALL integrations (budget is a single global daily/weekly
// cap, not per-integration), from the SAME real costUsd field jev-assist.js
// writes. A window with no configured budget for it (e.g. usdPerWeek unset)
// reports null for that window, not a fabricated 0/0.
function computeBudgetStatus(rows, budget) {
  if (!budget || budget.mode !== 'watch') return null;
  const sumWindow = (days) => {
    const cutoff = Date.now() - days * 86400000;
    let sum = 0;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || row.type === 'outcome') continue;
      const ts = row.ts ? Date.parse(row.ts) : NaN;
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      if (Number.isFinite(row.costUsd)) sum += row.costUsd;
    }
    return sum;
  };
  const status = {};
  if (Number.isFinite(budget.usdPerDay)) {
    const spentUsd = sumWindow(1);
    status['24h'] = { spentUsd, budgetUsd: budget.usdPerDay, exceeded: spentUsd > budget.usdPerDay };
  } else {
    status['24h'] = null;
  }
  if (Number.isFinite(budget.usdPerWeek)) {
    const spentUsd = sumWindow(7);
    status['7d'] = { spentUsd, budgetUsd: budget.usdPerWeek, exceeded: spentUsd > budget.usdPerWeek };
  } else {
    status['7d'] = null;
  }
  return status;
}

// readLines(home) -> array of parsed rows (decision rows + outcome rows),
// reading BOTH the live file and its one rotated backup (.1) so a report run
// right after a rotation doesn't silently lose the older half.
function readLines(home) {
  const rows = [];
  for (const suffix of ['.1', '']) {
    try {
      const raw = fs.readFileSync(logPath(home) + suffix, 'utf8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { rows.push(JSON.parse(t)); } catch (_) { /* skip a corrupt line */ }
      }
    } catch (_) {
      // file doesn't exist — fine, nothing to add
    }
  }
  return rows;
}

// readTriageLines(home) -> array of parsed jev-triage.ndjson rows (both the
// per-message classification lines and the recordAnswered() 'answered'
// lines), same live+.1-backup read as readLines() above.
function readTriageLines(home) {
  const rows = [];
  for (const suffix of ['.1', '']) {
    try {
      const raw = fs.readFileSync(triageLogPath(home) + suffix, 'utf8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { rows.push(JSON.parse(t)); } catch (_) { /* skip a corrupt line */ }
      }
    } catch (_) {
      // file doesn't exist — fine, nothing to add
    }
  }
  return rows;
}

// buildTriageAnswerReport(triageRows) -> {urgent:{n,p50,p95}, normal:{n,p50,p95}}
// from {type:'answered', urgency, latencyMs} rows. `normal` buckets every
// non-'urgent' labeled answer (kind-only or urgency:'normal').
function buildTriageAnswerReport(triageRows) {
  const buckets = { urgent: [], normal: [] };
  for (const row of triageRows) {
    if (!row || row.type !== 'answered' || !Number.isFinite(row.latencyMs)) continue;
    const bucket = row.urgency === 'urgent' ? 'urgent' : 'normal';
    buckets[bucket].push(row.latencyMs);
  }
  const summarize = (arr) => {
    const sorted = arr.slice().sort((a, b) => a - b);
    return { n: sorted.length, p50: percentile(sorted, 0.50), p95: percentile(sorted, 0.95) };
  };
  return { urgent: summarize(buckets.urgent), normal: summarize(buckets.normal) };
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = Math.min(sortedArr.length - 1, Math.floor(p * sortedArr.length));
  return sortedArr[idx];
}

const COST_WINDOWS = { '24h': 1, '7d': 7 };

function parseArgs(argv) {
  const opts = { days: null, json: false, window: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') opts.days = Number(argv[++i]);
    else if (argv[i] === '--json') opts.json = true;
    else if (argv[i] === '--home') opts.home = argv[++i]; // test-only override
    else if (argv[i] === '--window') opts.window = argv[++i];
  }
  return opts;
}

// buildCostWindows(rows, { costPerCall, windows }) -> { '24h': {generatedAt,
// integrations}, '7d': {...} } -- reuses buildReport's own per-window cutoff
// (`days`) so real-cost figures come from the exact same aggregation as the
// main table, just re-run per window. `windows` defaults to both 24h and 7d;
// pass a single-key object (e.g. {'--window 24h'}) to report just one.
function buildCostWindows(rows, opts = {}) {
  const windows = opts.windows || COST_WINDOWS;
  const out = {};
  for (const label of Object.keys(windows)) {
    out[label] = buildReport(rows, { days: windows[label], costPerCall: opts.costPerCall });
  }
  return out;
}

// buildReport(rows, { days, costPerCall, budgetMsById }) -> { generatedAt, integrations: [...] }
function buildReport(rows, opts = {}) {
  const now = Date.now();
  const cutoff = Number.isFinite(opts.days) ? now - opts.days * 86400000 : null;

  const byId = new Map();
  const outcomesByHash = new Map(); // hash -> [outcome, ...]
  const outcomesBySource = new Map(); // id -> { <source>: {good, known} }

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const ts = row.ts ? Date.parse(row.ts) : NaN;
    if (cutoff !== null && Number.isFinite(ts) && ts < cutoff) continue;

    if (row.type === 'outcome') {
      if (!row.h) continue;
      const arr = outcomesByHash.get(row.h) || [];
      arr.push(row.outcome);
      outcomesByHash.set(row.h, arr);
      // Per-decision-source breakdown (independent of hash-joining a decision
      // row — a pure regex/lexical block never logs one): lets `jev report`
      // compare Jev-added vs regex-only outcome rates directly.
      if (row.id && row.source) {
        if (!outcomesBySource.has(row.id)) outcomesBySource.set(row.id, {});
        const bySource = outcomesBySource.get(row.id);
        if (!bySource[row.source]) bySource[row.source] = { good: 0, known: 0 };
        bySource[row.source].known++;
        if (!BAD_OUTCOME_RE.test(String(row.outcome))) bySource[row.source].good++;
      }
      continue;
    }

    if (!row.id) continue;
    if (!byId.has(row.id)) {
      byId.set(row.id, {
        id: row.id, calls: 0, jevAnswered: 0, cacheHits: 0, agree: 0, agreeTotal: 0,
        excludedNoCompare: 0,
        // changedHashByFresh: hash -> direction, populated ONLY from
        // non-cached rows. A decision (content hash) is counted ONCE
        // regardless of how many cache-hit retries share that hash, and a
        // pure cache hit never enters this map at all (cost $0, and it
        // isn't a NEW decision) -- see the dedupe fix comment above.
        changedHashByFresh: new Map(),
        failures: 0, latencies: [],
        labelCounts: new Map(), labeled: 0,
        realCostSum: 0, realCostKnown: false,
      });
    }
    const bucket = byId.get(row.id);
    bucket.calls++;
    if (row.backend === 'jev' || row.backend === 'cache') bucket.jevAnswered++;
    if (row.backend === 'cache') bucket.cacheHits++;
    if (row.backend === 'baseline-only' && isHttpFailure(row.reason)) bucket.failures++;
    // Real (gateway/price-table-reported) cost, summed across every FRESH
    // call in the window (never deduped -- two independent fresh calls for
    // the same content each cost real money). A cache hit's costUsd is
    // always 0 (see jev-assist.js's computeCostUsd), so including it is
    // harmless.
    if (Number.isFinite(row.costUsd)) {
      bucket.realCostSum += row.costUsd;
      bucket.realCostKnown = true;
    }
    // Agreement is computed ONLY from the caller-supplied `compare` field
    // (an independent heuristic verdict), never from `base` (trust-rule
    // math, sometimes a hardcoded constant -- see the module comment above).
    // A boolean `jev` answer with no `compare` field is excluded from the
    // metric, not silently folded into it.
    if (typeof row.jev === 'boolean' && typeof row.compare === 'boolean') {
      bucket.agreeTotal++;
      if (row.jev === row.compare) bucket.agree++;
    } else if (typeof row.jev === 'boolean' && (row.backend === 'jev' || row.backend === 'cache')) {
      bucket.excludedNoCompare++;
    }
    // LABEL DISTRIBUTION: a non-boolean `jev` answer (a `choice` question,
    // e.g. newRequest's new-request/follow-up/correction/question) has no
    // boolean baseline to agree/disagree against, so it is tallied here
    // instead — the top label's share becomes the table's `label%` column;
    // the full distribution is available via --json.
    if (typeof row.jev === 'string') {
      bucket.labeled++;
      bucket.labelCounts.set(row.jev, (bucket.labelCounts.get(row.jev) || 0) + 1);
    }
    // Dedupe changed decisions by content hash, and EXCLUDE cache hits
    // entirely: a cache hit is a retry of an already-counted decision, not a
    // new one, and it costs $0 -- counting it would inflate both the
    // changed-decision rate and any cost-per-decision metric. Same hash from
    // multiple fresh calls (e.g. a cache eviction re-triggers the same
    // content) still collapses to one entry via the Map key.
    if (row.h && row.changed && row.backend !== 'cache') {
      bucket.changedHashByFresh.set(row.h, row.changed);
    }
    if (Number.isFinite(row.ms)) bucket.latencies.push(row.ms);
  }

  const integrations = [];
  for (const bucket of byId.values()) {
    const changed = { added: 0, relaxed: 0, changed: 0 };
    for (const direction of bucket.changedHashByFresh.values()) {
      if (direction === 'added') changed.added++;
      else if (direction === 'relaxed') changed.relaxed++;
      else if (direction === 'changed') changed.changed++;
    }
    const totalChangedUnique = bucket.changedHashByFresh.size;
    const freshCalls = bucket.calls - bucket.cacheHits;
    // Yield is computed on FRESH calls only -- a cache hit never represents
    // a new Jev decision, so it must not dilute the rate.
    const changedRate = freshCalls > 0 ? totalChangedUnique / freshCalls : 0;
    const agreementPct = bucket.agreeTotal > 0 ? bucket.agree / bucket.agreeTotal : null;

    // Outcome join is by the SAME deduped unique-hash set (fresh, changed
    // decisions only) -- iterating raw per-row hashes would count a cache
    // hit's outcome once per retry instead of once per decision.
    let good = 0; let known = 0;
    for (const h of bucket.changedHashByFresh.keys()) {
      const outcomes = outcomesByHash.get(h);
      if (!outcomes || outcomes.length === 0) continue;
      for (const o of outcomes) {
        known++;
        if (!BAD_OUTCOME_RE.test(String(o))) good++;
      }
    }
    const goodOutcomeRate = known > 0 ? good / known : null;

    const bySource = outcomesBySource.get(bucket.id) || {};
    const outcomeRateBySource = {};
    for (const src of Object.keys(bySource)) {
      const s = bySource[src];
      outcomeRateBySource[src] = s.known > 0 ? s.good / s.known : null;
    }

    const sorted = bucket.latencies.slice().sort((a, b) => a - b);
    const p50 = percentile(sorted, 0.50);
    const p95 = percentile(sorted, 0.95);
    const failureRate = bucket.calls > 0 ? bucket.failures / bucket.calls : 0;
    const budgetMs = opts.budgetMsById && opts.budgetMsById[bucket.id];

    let suggestion;
    if (bucket.calls < MIN_CALLS_FOR_VERDICT) {
      suggestion = `REVIEW (not enough data: ${bucket.calls} < ${MIN_CALLS_FOR_VERDICT} calls)`;
    } else if (
      bucket.calls >= REMOVE_MIN_CALLS &&
      (changedRate < REMOVE_CHANGED_RATE ||
        (goodOutcomeRate !== null && goodOutcomeRate < REMOVE_GOOD_OUTCOME_RATE) ||
        failureRate > REMOVE_FAILURE_RATE)
    ) {
      suggestion = 'REMOVE';
    } else if (
      changedRate >= KEEP_CHANGED_RATE &&
      goodOutcomeRate !== null && goodOutcomeRate >= KEEP_GOOD_OUTCOME_RATE
    ) {
      // KEEP requires an ACTUAL outcome signal (goodOutcomeRate !== null) —
      // a high changed-decision rate alone (Jev moving lots of decisions)
      // proves nothing about whether those moves were good ones.
      suggestion = 'KEEP';
    } else if (bucket.labeled > 0 && known === 0) {
      // Label-only integration (a `choice` classifier, no boolean baseline)
      // with zero human-supplied outcomes yet: never KEEP, always REVIEW.
      suggestion = 'REVIEW (label-only, no outcome signal yet)';
    } else if (Number.isFinite(budgetMs) && Number.isFinite(p95) && p95 > budgetMs) {
      suggestion = 'REVIEW (p95 latency exceeds budget)';
    } else {
      suggestion = 'REVIEW';
    }

    let topLabel = null; let labelPct = null;
    const labelDistribution = {};
    if (bucket.labeled > 0) {
      for (const [label, n] of bucket.labelCounts) {
        labelDistribution[label] = n / bucket.labeled;
        if (topLabel === null || n > bucket.labelCounts.get(topLabel)) topLabel = label;
      }
      labelPct = bucket.labelCounts.get(topLabel) / bucket.labeled;
    }

    integrations.push({
      id: bucket.id,
      calls: bucket.calls,
      freshCalls,
      cachedCalls: bucket.cacheHits,
      jevAnsweredPct: bucket.calls > 0 ? bucket.jevAnswered / bucket.calls : 0,
      cacheHits: bucket.cacheHits,
      agreementPct,
      excludedNoCompare: bucket.excludedNoCompare,
      topLabel,
      labelPct,
      labelDistribution,
      changed,
      changedUnique: totalChangedUnique,
      changedRate,
      goodOutcomeRate,
      knownOutcomes: known,
      outcomeRateBySource,
      failureRate,
      p50,
      p95,
      // Cache hits cost $0 -- estimate from FRESH calls only.
      costEstimate: Number.isFinite(opts.costPerCall) ? freshCalls * opts.costPerCall : null,
      // REAL cost (gateway-reported or price-table-computed, never a manual
      // guess) -- null when no row in the window carried a costUsd at all.
      realCostTotal: bucket.realCostKnown ? bucket.realCostSum : null,
      realCostPerCall: (bucket.realCostKnown && freshCalls > 0) ? bucket.realCostSum / freshCalls : null,
      realCostPerChangedDecision: (bucket.realCostKnown && totalChangedUnique > 0)
        ? bucket.realCostSum / totalChangedUnique : null,
      suggestion,
    });
  }

  integrations.sort((a, b) => b.calls - a.calls);
  const triageAnswers = buildTriageAnswerReport(opts.triageRows || []);
  return {
    generatedAt: new Date(now).toISOString(),
    costPerCallKnown: Number.isFinite(opts.costPerCall),
    integrations,
    triageAnswers,
  };
}

function pct(n) {
  return n === null || n === undefined ? 'n/a' : `${(n * 100).toFixed(1)}%`;
}

function printTable(report) {
  console.log(`jev report — generated ${report.generatedAt}`);
  if (report.integrations.length === 0) {
    console.log('No jev-assist.ndjson activity found for this window.');
    return;
  }
  const header = ['integration', 'calls (fresh/cached)', 'jev%', 'agree%', 'label%', 'added', 'relaxed', 'changed%', 'good-outcome%', 'outcome(jev/regex)', 'p50ms', 'p95ms', 'cost', 'suggestion'];
  const rows = report.integrations.map((r) => [
    r.id, `${r.calls} (${r.freshCalls}/${r.cachedCalls})`, pct(r.jevAnsweredPct),
    r.agreementPct == null
      ? (r.excludedNoCompare > 0 ? 'n/a (no comparison signal)' : 'n/a')
      : pct(r.agreementPct),
    r.topLabel != null ? `${pct(r.labelPct)} (${r.topLabel})` : 'n/a',
    String(r.changed.added), String(r.changed.relaxed), pct(r.changedRate), pct(r.goodOutcomeRate),
    `${pct(r.outcomeRateBySource.jev)}/${pct(r.outcomeRateBySource.regex)}`,
    r.p50 == null ? 'n/a' : String(r.p50), r.p95 == null ? 'n/a' : String(r.p95),
    r.costEstimate == null ? 'n/a' : `$${r.costEstimate.toFixed(4)}`, r.suggestion,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
  if (!report.costPerCallKnown) {
    console.log('\ncost: n/a — set jev.json "costPerCall" (owner-supplied $/call estimate) to enable.');
  }

  const ta = report.triageAnswers;
  if (ta && (ta.urgent.n > 0 || ta.normal.n > 0)) {
    console.log('\ntriage answer-time (ms, time from a labeled inbound to the next outbound reply):');
    console.log(`  urgent:     n=${ta.urgent.n}  p50=${ta.urgent.p50 == null ? 'n/a' : ta.urgent.p50}  p95=${ta.urgent.p95 == null ? 'n/a' : ta.urgent.p95}`);
    console.log(`  non-urgent: n=${ta.normal.n}  p50=${ta.normal.p50 == null ? 'n/a' : ta.normal.p50}  p95=${ta.normal.p95 == null ? 'n/a' : ta.normal.p95}`);
  }
}

// printCostWindows(costWindows) — real (gateway/price-table) cost per
// integration for each window in `costWindows` ({'24h': report, '7d':
// report, ...}). Separate from the main table's manual `costPerCall`
// estimate: this is only ever populated from a real costUsd (see
// hooks/lib/jev-assist.js's computeCostUsd), never fabricated.
function printCostWindows(costWindows) {
  const labels = Object.keys(costWindows);
  if (labels.length === 0) return;
  console.log('\nreal cost (gateway/price-table-reported, not the manual costPerCall estimate):');
  for (const label of labels) {
    const report = costWindows[label];
    const known = report.integrations.filter((r) => r.realCostTotal !== null);
    if (known.length === 0) {
      console.log(`  ${label}: n/a — no row in this window carried a real cost (see jev-client.js's extractCostAndUsage, or set jev.json "prices").`);
      continue;
    }
    console.log(`  ${label}:`);
    for (const r of known) {
      const perCall = r.realCostPerCall == null ? 'n/a' : `$${r.realCostPerCall.toFixed(4)}/call`;
      const perChanged = r.realCostPerChangedDecision == null ? 'n/a' : `$${r.realCostPerChangedDecision.toFixed(4)}/changed`;
      console.log(`    ${r.id}: calls=${r.freshCalls} $total=${r.realCostTotal.toFixed(4)} ${perCall} ${perChanged}`);
    }
  }
}

// printBudgetStatus(status) — status is null when budget.mode !== 'watch'
// (nothing printed: unlimited is the silent default). Never suggests
// disabling Jev; a budget in "watch" mode is observability only.
function printBudgetStatus(status) {
  if (!status) return;
  const lines = [];
  for (const label of ['24h', '7d']) {
    const s = status[label];
    if (!s) continue;
    const flag = s.exceeded ? 'EXCEEDED' : 'ok';
    lines.push(`  ${label}: $${s.spentUsd.toFixed(4)} / $${s.budgetUsd.toFixed(2)} budget (${flag})`);
  }
  if (lines.length === 0) return;
  console.log('\nbudget (watch mode -- observability only, Jev is never auto-disabled):');
  for (const line of lines) console.log(line);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const home = opts.home;
  const rows = readLines(home);
  const triageRows = readTriageLines(home);
  const costPerCall = readCostPerCall(home);
  const report = buildReport(rows, { days: opts.days, costPerCall, triageRows });

  const windows = opts.window
    ? { [opts.window]: COST_WINDOWS[opts.window] != null ? COST_WINDOWS[opts.window] : Number(opts.window) }
    : COST_WINDOWS;
  const costWindows = buildCostWindows(rows, { costPerCall, windows });
  const budget = readBudgetConfig(home);
  const budgetStatus = computeBudgetStatus(rows, budget);

  if (opts.json) {
    process.stdout.write(JSON.stringify(Object.assign({}, report, { costWindows, budget, budgetStatus }), null, 2) + '\n');
  } else {
    printTable(report);
    printCostWindows(costWindows);
    printBudgetStatus(budgetStatus);
  }
}

module.exports = {
  buildReport, readLines, readTriageLines, buildTriageAnswerReport, percentile,
  buildCostWindows, COST_WINDOWS, readBudgetConfig, computeBudgetStatus,
};

if (require.main === module) {
  main();
}
