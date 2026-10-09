'use strict';
// Global spend cap summed across runs (docs/BENCHMARK-METHOD.md Amendment 3 §0, §8).
// `--max-cost-usd` bounds ONE `claude plugin eval` invocation. Interleaved arms run as
// many invocations, so the cap must be a ledger over all of them: this module sums
// `costUsd` of every run in every results dir under a root, and a ledger of reserved
// budget for invocations in flight / already launched.
const fs = require('fs');
const path = require('path');

function sumAggregate(agg) {
  let total = 0;
  for (const c of (agg && agg.cases) || []) {
    for (const runs of Object.values(c.arms || {})) for (const r of runs || []) if (typeof r.costUsd === 'number') total += r.costUsd;
  }
  return total;
}

// Spend already recorded under resultsRoot (all <dir>/aggregate-result.json), optionally
// restricted to dirs whose name starts with `prefix` (one study = one prefix).
function spentUnder(resultsRoot, prefix = '') {
  let total = 0, dirs = 0;
  if (!fs.existsSync(resultsRoot)) return { total, dirs };
  // Recursive: an interleaved run nests one aggregate-result.json per (arm, case, rep) job dir.
  const walk = (d) => {
    const f = path.join(d, 'aggregate-result.json');
    if (fs.existsSync(f)) {
      try { total += sumAggregate(JSON.parse(fs.readFileSync(f, 'utf8'))); dirs++; } catch (_) { /* unreadable: counted as 0 */ }
      return;
    }
    for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) walk(path.join(d, e.name));
  };
  for (const e of fs.readdirSync(resultsRoot, { withFileTypes: true })) {
    if (e.isDirectory() && (!prefix || e.name.startsWith(prefix))) walk(path.join(resultsRoot, e.name));
  }
  return { total, dirs };
}

class SpendCap {
  constructor(maxTotalUsd, alreadySpent = 0) {
    if (!(maxTotalUsd > 0)) throw new Error('--max-total-usd must be > 0');
    this.max = maxTotalUsd;
    this.spent = alreadySpent;
  }
  remaining() { return Math.max(0, this.max - this.spent); }
  // Budget for the next invocation: min(per-batch ceiling, what is left). null = cap reached, do not launch.
  // reserve = expected cost of one run: also null when what is left cannot cover it (per-run pre-check).
  nextCeiling(perBatch, reserve = 0) {
    const left = this.remaining();
    if (left <= 0 || left <= reserve) return null;
    return perBatch > 0 ? Math.min(perBatch, left) : left;
  }
  record(costUsd) { this.spent += Number(costUsd) || 0; return this.spent; }
}

module.exports = { sumAggregate, spentUnder, SpendCap };
