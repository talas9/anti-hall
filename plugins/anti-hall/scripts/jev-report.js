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

function parseArgs(argv) {
  const opts = { days: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days') opts.days = Number(argv[++i]);
    else if (argv[i] === '--json') opts.json = true;
    else if (argv[i] === '--home') opts.home = argv[++i]; // test-only override
  }
  return opts;
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
        changed: { added: 0, relaxed: 0, changed: 0 }, failures: 0, latencies: [], hashes: [],
        labelCounts: new Map(), labeled: 0,
      });
    }
    const bucket = byId.get(row.id);
    bucket.calls++;
    if (row.backend === 'jev' || row.backend === 'cache') bucket.jevAnswered++;
    if (row.backend === 'cache') bucket.cacheHits++;
    if (row.backend === 'baseline-only' && isHttpFailure(row.reason)) bucket.failures++;
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
    if (row.changed === 'added') bucket.changed.added++;
    else if (row.changed === 'relaxed') bucket.changed.relaxed++;
    else if (row.changed === 'changed') bucket.changed.changed++;
    if (Number.isFinite(row.ms)) bucket.latencies.push(row.ms);
    if (row.h && row.changed) bucket.hashes.push(row.h);
  }

  const integrations = [];
  for (const bucket of byId.values()) {
    const totalChanged = bucket.changed.added + bucket.changed.relaxed + bucket.changed.changed;
    const changedRate = bucket.calls > 0 ? totalChanged / bucket.calls : 0;
    const agreementPct = bucket.agreeTotal > 0 ? bucket.agree / bucket.agreeTotal : null;

    let good = 0; let known = 0;
    for (const h of bucket.hashes) {
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
      jevAnsweredPct: bucket.calls > 0 ? bucket.jevAnswered / bucket.calls : 0,
      cacheHits: bucket.cacheHits,
      agreementPct,
      excludedNoCompare: bucket.excludedNoCompare,
      topLabel,
      labelPct,
      labelDistribution,
      changed: bucket.changed,
      changedRate,
      goodOutcomeRate,
      knownOutcomes: known,
      outcomeRateBySource,
      failureRate,
      p50,
      p95,
      costEstimate: Number.isFinite(opts.costPerCall) ? bucket.calls * opts.costPerCall : null,
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
  const header = ['integration', 'calls', 'jev%', 'cache', 'agree%', 'label%', 'added', 'relaxed', 'changed%', 'good-outcome%', 'outcome(jev/regex)', 'p50ms', 'p95ms', 'cost', 'suggestion'];
  const rows = report.integrations.map((r) => [
    r.id, String(r.calls), pct(r.jevAnsweredPct), String(r.cacheHits),
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

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const home = opts.home;
  const rows = readLines(home);
  const triageRows = readTriageLines(home);
  const costPerCall = readCostPerCall(home);
  const report = buildReport(rows, { days: opts.days, costPerCall, triageRows });
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    printTable(report);
  }
}

module.exports = { buildReport, readLines, readTriageLines, buildTriageAnswerReport, percentile };

if (require.main === module) {
  main();
}
