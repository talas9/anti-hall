#!/usr/bin/env node
// anti-hall :: eval analyzer — merge result shards + proper statistics.
//
// Reads one or more results JSON files (each {summary?, records:[...]}), merges
// their records, and computes the protocol-vs-baseline comparison with a real
// significance test instead of an eyeballed delta:
//
//   - per-task fabrication rate per condition (averaged over repeats)
//   - aggregate fabrication rate + bootstrap 95% CI on the (baseline-protocol)
//     reduction in fabrication rate
//   - McNemar's exact test on the paired per-task outcomes (the correct test for
//     paired binary data): discordant pairs b (baseline fab, protocol clean) and
//     c (protocol fab, baseline clean); two-sided exact binomial p-value.
//   - tool-use rates per arm (did the model actually run a verification command?)
//
// USAGE
//   node eval/analyze.js eval/results-powered*.json
//   node eval/analyze.js eval/results-toolson.json
// (globs are shell-expanded; pass the files as args.)
//
// Honest by design: reports the real discordant-pair count and whether the
// result is significant. Zero npm deps.

'use strict';

const fs = require('fs');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node eval/analyze.js <results.json> [more.json ...]');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Load + merge records.
// ---------------------------------------------------------------------------
const records = [];
for (const f of files) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    console.error('skip (unreadable): ' + f + ' :: ' + (e && e.message));
    continue;
  }
  const recs = Array.isArray(data) ? data : (data.records || []);
  for (const r of recs) records.push(r);
}
if (!records.length) {
  console.error('no records found across ' + files.length + ' file(s)');
  process.exit(2);
}

const graded = records.filter((r) => typeof r.fabricated === 'boolean');
const errored = records.filter((r) => r.error);

// ---------------------------------------------------------------------------
// Per-task, per-condition fabrication (averaged over repeats).
// ---------------------------------------------------------------------------
const byTask = {};
for (const r of graded) {
  const t = (byTask[r.task_id] = byTask[r.task_id] || { protocol: [], baseline: [] });
  if (r.condition === 'protocol' || r.condition === 'baseline') {
    t[r.condition].push(r.fabricated ? 1 : 0);
  }
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// Paired per-task outcomes: a task counts as "fabricated" for a condition if it
// fabricated on a MAJORITY of its repeats (ties -> fabricated, conservative).
function majFab(arr) {
  if (!arr.length) return null;
  const f = arr.reduce((x, y) => x + y, 0);
  return f * 2 >= arr.length ? 1 : 0;
}

const pairs = []; // {task_id, p, b} for tasks present in BOTH conditions
for (const id of Object.keys(byTask)) {
  const p = majFab(byTask[id].protocol);
  const b = majFab(byTask[id].baseline);
  if (p === null || b === null) continue;
  pairs.push({ task_id: id, p, b, pRate: mean(byTask[id].protocol), bRate: mean(byTask[id].baseline) });
}

// McNemar discordant pairs:
//   b_count = baseline fabricated & protocol clean  (protocol WIN)
//   c_count = protocol fabricated & baseline clean  (protocol LOSS)
let bWin = 0, cLoss = 0, bothFab = 0, bothClean = 0;
for (const pr of pairs) {
  if (pr.b === 1 && pr.p === 0) bWin++;
  else if (pr.p === 1 && pr.b === 0) cLoss++;
  else if (pr.p === 1 && pr.b === 1) bothFab++;
  else bothClean++;
}

// Exact two-sided McNemar: under H0 each discordant pair is 50/50.
// p = 2 * sum_{k=0..min(b,c)} C(n,k) 0.5^n , capped at 1.
function logFactorial(n) { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; }
function logChoose(n, k) { return logFactorial(n) - logFactorial(k) - logFactorial(n - k); }
function mcnemarExactP(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const lo = Math.min(b, c);
  let cum = 0;
  for (let k = 0; k <= lo; k++) cum += Math.exp(logChoose(n, k) + n * Math.log(0.5));
  return Math.min(1, 2 * cum);
}
const pValue = mcnemarExactP(bWin, cLoss);

// ---------------------------------------------------------------------------
// Aggregate rates + bootstrap 95% CI on (baseline - protocol) fabrication rate.
// Deterministic bootstrap (seeded LCG) so results are reproducible.
// ---------------------------------------------------------------------------
function rate(cond) {
  const rows = graded.filter((r) => r.condition === cond);
  const fab = rows.filter((r) => r.fabricated).length;
  return { n: rows.length, fab, rate: rows.length ? fab / rows.length : null };
}
const proto = rate('protocol');
const base = rate('baseline');
const pointDelta = (base.rate != null && proto.rate != null) ? base.rate - proto.rate : null;

// paired bootstrap over tasks, using per-task mean rates
function bootstrapCI(pairsArr, iters) {
  if (!pairsArr.length) return null;
  let seed = 1234567;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const deltas = [];
  for (let it = 0; it < iters; it++) {
    let sb = 0, sp = 0;
    for (let i = 0; i < pairsArr.length; i++) {
      const pick = pairsArr[(rand() * pairsArr.length) | 0];
      sb += pick.bRate; sp += pick.pRate;
    }
    deltas.push((sb - sp) / pairsArr.length);
  }
  deltas.sort((a, b) => a - b);
  const q = (f) => deltas[Math.min(deltas.length - 1, Math.max(0, Math.floor(f * deltas.length)))];
  return { lo: q(0.025), hi: q(0.975) };
}
const ci = bootstrapCI(pairs, 5000);

// ---------------------------------------------------------------------------
// Tool-use rate per arm (did the model actually run a verification command?).
// ---------------------------------------------------------------------------
const ranRe = /hasattr|python3 -c|node -e|git \w+ (--help|-h)\b|\bI ran\b|output was|let me (run|check)|\$\(/i;
function toolUse(cond) {
  const rows = records.filter((r) => r.condition === cond && r.response);
  const ran = rows.filter((r) => ranRe.test(r.response)).length;
  return { n: rows.length, ran };
}
const tuP = toolUse('protocol');
const tuB = toolUse('baseline');

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
const pct = (x) => (x == null ? 'n/a' : (100 * x).toFixed(1) + '%');
const sig = pValue < 0.05;

console.log('================ POWERED ANALYSIS ================');
console.log('files merged       : ' + files.length);
console.log('records (graded)   : ' + graded.length + (errored.length ? ('  (+' + errored.length + ' errored)') : ''));
console.log('paired tasks       : ' + pairs.length);
console.log('');
console.log('PROTOCOL fabrication: ' + proto.fab + '/' + proto.n + '  (' + pct(proto.rate) + ')');
console.log('BASELINE fabrication: ' + base.fab + '/' + base.n + '  (' + pct(base.rate) + ')');
console.log('point reduction     : ' + (pointDelta == null ? 'n/a' : (100 * pointDelta).toFixed(1) + ' pts (baseline - protocol)'));
if (ci) console.log('bootstrap 95% CI    : [' + (100 * ci.lo).toFixed(1) + ', ' + (100 * ci.hi).toFixed(1) + '] pts');
console.log('');
console.log("McNemar's exact test (paired per-task):");
console.log('  protocol WINS  (baseline fab, protocol clean) b = ' + bWin);
console.log('  protocol LOSES (protocol fab, baseline clean) c = ' + cLoss);
console.log('  both fabricated                                = ' + bothFab);
console.log('  both clean                                     = ' + bothClean);
console.log('  discordant pairs (b+c)                         = ' + (bWin + cLoss));
console.log('  two-sided p-value                              = ' + pValue.toFixed(4));
console.log('  verdict        : ' + (sig
  ? (bWin > cLoss ? 'SIGNIFICANT — protocol reduces fabrication (p<0.05)' : 'SIGNIFICANT — protocol INCREASES fabrication (p<0.05)')
  : 'NOT significant (p>=0.05) — cannot distinguish from noise'));
console.log('  power note     : ' + (bWin + cLoss < 10
  ? 'UNDERPOWERED — only ' + (bWin + cLoss) + ' discordant pairs (need ~10+).'
  : (bWin + cLoss) + ' discordant pairs (adequate for a moderate effect).'));
console.log('');
console.log('tool-use (ran a verification command):');
console.log('  protocol : ' + tuP.ran + '/' + tuP.n + '  (' + pct(tuP.n ? tuP.ran / tuP.n : null) + ')');
console.log('  baseline : ' + tuB.ran + '/' + tuB.n + '  (' + pct(tuB.n ? tuB.ran / tuB.n : null) + ')');
console.log('==================================================');
