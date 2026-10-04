'use strict';
// Seeded resampling helpers for the strength studies (docs/BENCHMARK-METHOD.md
// Amendment 3). Pure Node. No dependency on analyze.js (which imports this).

// mulberry32: small deterministic PRNG, so a bootstrap CI is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted, p) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Ratio of sums: sum(num) / sum(den) over rows. null when the denominator is 0
// (for $ per completed task: an arm with 0 successes has no defined ratio).
function ratioOfSums(rows) {
  let n = 0, d = 0;
  for (const r of rows) { n += r.num; d += r.den; }
  return d > 0 ? n / d : null;
}

// Cluster bootstrap of the with/without ratio of ratios-of-sums.
// rows: [{ cluster, aNum, aDen, bNum, bDen }] (arm a = with, arm b = without),
// e.g. aNum = Σ cost, aDen = Σ successes for one case. Clusters (families) are
// resampled with replacement; the statistic is (Σ aNum/Σ aDen) / (Σ bNum/Σ bDen).
// Resamples whose ratio is undefined (a zero denominator) are counted, not
// dropped silently: `undefinedResamples`.
function clusterBootstrapRatio(rows, { resamples = 10000, seed = 20261004, level = 0.95 } = {}) {
  const byCluster = new Map();
  for (const r of rows) { if (!byCluster.has(r.cluster)) byCluster.set(r.cluster, []); byCluster.get(r.cluster).push(r); }
  const clusters = [...byCluster.values()];
  const C = clusters.length;
  const point = ratioOfRows(rows);
  if (C < 2) return { clusters: C, point, ci: null, resamples: 0, undefinedResamples: 0, seed };
  const next = rng(seed);
  const stats = [];
  let undef = 0;
  for (let i = 0; i < resamples; i++) {
    const pick = [];
    for (let j = 0; j < C; j++) pick.push(...clusters[Math.floor(next() * C)]);
    const s = ratioOfRows(pick);
    if (s == null) undef++; else stats.push(s);
  }
  stats.sort((x, y) => x - y);
  const a = (1 - level) / 2;
  return { clusters: C, point, ci: stats.length ? [quantile(stats, a), quantile(stats, 1 - a)] : null, resamples, undefinedResamples: undef, seed };
}

function ratioOfRows(rows) {
  const a = ratioOfSums(rows.map((r) => ({ num: r.aNum, den: r.aDen })));
  const b = ratioOfSums(rows.map((r) => ({ num: r.bNum, den: r.bDen })));
  return a == null || b == null || b === 0 ? null : a / b;
}

module.exports = { rng, quantile, ratioOfSums, clusterBootstrapRatio };
