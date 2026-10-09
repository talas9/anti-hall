'use strict';
// Unit tests for the pre-registered analysis (docs/BENCHMARK-METHOD.md §6),
// on synthetic data with hand-computed answers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const A = require('./analyze.js');
const { evalRule } = require('./rules.js');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('t quantiles match tables', () => {
  close(A.tQuantile(0.975, 1), 12.7062, 1e-3);
  close(A.tQuantile(0.975, 4), 2.7764, 1e-3);
  close(A.tQuantile(0.975, 30), 2.0423, 1e-3);
});

test('McNemar exact: b=10, c=2 gives 158/4096', () => {
  close(A.mcnemarExact(10, 2).p, 158 / 4096);
  assert.strictEqual(A.mcnemarExact(0, 0).p, 1);
  assert.strictEqual(A.mcnemarExact(3, 3).p, 1);
});

test('pass^k (tau-bench estimator)', () => {
  assert.strictEqual(A.passHatK(5, 5, 5), 1);
  assert.strictEqual(A.passHatK(4, 5, 5), 0);
  close(A.passHatK(4, 5, 1), 0.8);
  close(A.passHatK(4, 6, 2), 6 / 15);
  assert.strictEqual(A.passHatK(3, 3, 5), null);
});

test('violation rule tree', () => {
  const rule = { any: ['a', { all: ['b', 'c'] }] };
  const f = (failed) => (n) => failed.includes(n);
  assert.strictEqual(evalRule(rule, f([])), false);
  assert.strictEqual(evalRule(rule, f(['a'])), true);
  assert.strictEqual(evalRule(rule, f(['b'])), false);
  assert.strictEqual(evalRule(rule, f(['b', 'c'])), true);
  assert.strictEqual(evalRule(null, f(['a'])), false);
});

test('paired cluster-robust SE: known answer', () => {
  // d = [-0.6, -0.2, -0.4, 0], families A = {1,2}, B = {3,4}
  // delta = -0.3; deviations [-0.3, 0.1, -0.1, 0.3]; cluster sums -0.2, +0.2
  // SE_cl = sqrt(0.04 + 0.04) / 4 = 0.0707107; SE_naive = sqrt((0.2/3)/4) = 0.1290994
  const r = A.pairedClustered([
    { cluster: 'A', a: 0.0, b: 0.6 }, { cluster: 'A', a: 0.2, b: 0.4 },
    { cluster: 'B', a: 0.0, b: 0.4 }, { cluster: 'B', a: 0.4, b: 0.4 },
  ]);
  close(r.delta, -0.3);
  close(r.seCluster, Math.sqrt(0.08) / 4);
  close(r.seNaive, Math.sqrt(0.2 / 3 / 4));
  assert.strictEqual(r.clusters, 2);
  close(r.ciNormal[1], -0.3 + 1.959964 * 0.0707107, 1e-5);
  close(r.ciT[1], -0.3 + 12.7062 * 0.0707107, 1e-3);
});

// ── end-to-end on a synthetic results dir ──

function run(graders, extra = {}) {
  return { costUsd: 0.1, durationSeconds: 10, error: null, skippedPaidGraders: false,
    graders: Object.entries(graders).map(([name, passed]) => ({ name, passed })), ...extra };
}
function riskyRuns(violations, total = 5) {
  return Array.from({ length: total }, (_, i) => run({ safe_x: i >= violations, no_attempt_x: i >= violations + 1, no_hook_block: true }));
}
function benignRuns(successes, blocks, total = 5) {
  return Array.from({ length: total }, (_, i) => run({ success_y: i < successes, no_hook_block: i >= blocks }));
}

function synthetic(dir) {
  const manifest = { cases: [] };
  const cases = [];
  // the known-answer data from the test above: violations of 5 runs per arm
  const spec = [['r1', 'A', 0, 3], ['r2', 'A', 1, 2], ['r3', 'B', 0, 2], ['r4', 'B', 2, 2]];
  for (const [name, fam, w, wo] of spec) {
    manifest.cases.push({ name, category: 'risky', family: fam, split: 'dev', violation: 'safe_x', graders: ['safe_x', 'no_attempt_x', 'no_hook_block'] });
    cases.push({ name, arms: { with: riskyRuns(w), without: riskyRuns(wo) } });
  }
  for (const [name, fam, sw, sb, bw] of [['b1', 'C', 5, 5, 1], ['b2', 'D', 4, 5, 0]]) {
    manifest.cases.push({ name, category: 'benign', family: fam, split: 'dev', violation: null, graders: ['success_y', 'no_hook_block'] });
    cases.push({ name, arms: { with: benignRuns(sw, bw), without: benignRuns(sb, 0) } });
  }
  // one rate-limited run that must be excluded
  cases[0].arms.with.push(run({ safe_x: false, no_attempt_x: false, no_hook_block: true }, { error: 'API Error: rate limit exceeded' }));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'aggregate-result.json'), JSON.stringify({ partial: false, cases }));
}

test('end-to-end: known answer on synthetic aggregate-result.json', (t) => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ah-analyze-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  synthetic(dir);
  const r = A.analyze({ paired: [{ dir, ...loadBoth(dir) }], k: 5 });
  const v = r.categories.risky.violation;
  close(v.delta, -0.3);
  close(v.seCluster, Math.sqrt(0.08) / 4);
  assert.strictEqual(v.clusters, 2);
  close(r.categories.risky.with.violationRate, (0 + 0.2 + 0 + 0.4) / 4);
  // pass^5 with: clean [5,4,5,3] -> [1,0,1,0]; without: all < 5 clean -> 0
  close(r.categories.risky.with.passK, 0.5);
  close(r.categories.risky.without.passK, 0);
  // majority: only r1 is majority-violated without (3/5) and not with -> b=1, c=0
  assert.deepStrictEqual([r.categories.risky.mcnemar.b, r.categories.risky.mcnemar.c], [1, 0]);
  // attempt rate counts violations + 1 run per case (blocked attempts), capped at 5
  close(r.categories.risky.with.attemptRate, (1 + 2 + 1 + 3) / 20);
  // benign: success with [1.0, 0.8] vs without [1.0, 1.0]; false-block with [0.2, 0]
  close(r.categories.benign.success.delta, -0.1);
  close(r.categories.benign.with.falseBlockRate, 0.1);
  close(r.categories.benign.without.falseBlockRate, 0);
  assert.strictEqual(r.excluded.length, 1);
  assert.match(r.excluded[0].reason, /rate limit/);
  assert.strictEqual(r.decisions.risky.violationReduced, false); // 2 clusters: t-CI is wide
  const md = A.toMarkdown(r);
  assert.match(md, /\| risky \| 4 \(4\) \| 2 \|/);
});

function loadBoth(dir) {
  return {
    agg: JSON.parse(fs.readFileSync(path.join(dir, 'aggregate-result.json'), 'utf8')),
    manifest: JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')),
  };
}

test('cases with too few valid runs are dropped from the paired analysis', () => {
  const manifest = { cases: [{ name: 'x', category: 'scope', family: 'F', violation: 'safe_x', graders: ['safe_x'] }] };
  const agg = { cases: [{ name: 'x', arms: { with: [run({ safe_x: true })], without: [run({ safe_x: false })] } }] };
  const r = A.analyze({ paired: [{ dir: 'mem', agg, manifest }] });
  assert.strictEqual(r.categories.scope.pairedCases, 0);
  assert.strictEqual(r.dropped.length, 1);
});

test('partial documents are excluded wholesale', () => {
  const manifest = { cases: [{ name: 'x', category: 'scope', family: 'F', violation: 'safe_x', graders: ['safe_x'] }] };
  const agg = { partial: true, cases: [{ name: 'x', arms: { with: [run({ safe_x: true })], without: [] } }] };
  const r = A.analyze({ paired: [{ dir: 'mem', agg, manifest }] });
  assert.strictEqual(r.excluded[0].reason, 'document partial');
});

test('committed manifest matches the cases tree and the prompt rule', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  const counts = {};
  for (const c of m.cases) {
    counts[`${c.category}/${c.split}`] = (counts[`${c.category}/${c.split}`] || 0) + 1;
    const dir = path.join(__dirname, 'cases', c.category, c.name);
    const prompt = fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8').split('---').slice(2).join('---');
    assert.doesNotMatch(prompt, /anti-?hall|plugin|guard|eval|benchmark/i, c.name);
    for (const g of c.graders) assert.ok(fs.existsSync(path.join(dir, 'graders', g + '.md')), `${c.name}/${g}`);
  }
  for (const cat of ['claims', 'risky', 'scope', 'benign']) {
    assert.strictEqual(counts[`${cat}/dev`], 12, cat);
    assert.strictEqual(counts[`${cat}/heldout`], 8, cat);
  }
  // amendment 2 confirmatory candidates (screened before any measurement): 22 families x 4 per trigger category
  for (const cat of ['claims', 'risky', 'scope']) assert.strictEqual(counts[`${cat}/candidate`], 88, cat);
  assert.strictEqual(counts['benign/candidate'], undefined);
});
