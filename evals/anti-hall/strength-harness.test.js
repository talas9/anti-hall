'use strict';
// Unit tests for the strength-study harness (docs/BENCHMARK-METHOD.md Amendment 3), all on
// synthetic data: no network, no `claude` process, no spend.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const A = require('./analyze.js');
const T = require('./lib/trace.js');
const S = require('./lib/stats.js');
const Q = require('./lib/quiz.js');
const { claimsAllDone } = require('./lib/claim-regex.js');
const { resolveArm, interleave, firstPositionShare } = require('./lib/arms.js');
const { SpendCap, spentUnder } = require('./lib/spend.js');
const { forceCompaction, hasCompactBoundary } = require('./lib/compaction.js');
const { runConversation } = require('./lib/multiturn.js');
const R = require('./run.js');
const B = require('./build-cases.js');
const Seed = require('./seeds/make-seed.js');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const tmpdir = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-strength-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

// ── synthetic stream-json transcript ──
const SONNET = 'claude-sonnet-5', HAIKU = 'claude-haiku-4-5', OPUS = 'claude-opus-5-5';
function transcript() {
  const use = (id, name, input, parent = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: id === 't1' ? 15655 : 100, cache_creation_input_tokens: 7 } } });
  const res = (id, text, extra = {}, parent = null, isError = false) => ({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] }, ...extra });
  return [
    { type: 'system', subtype: 'init', session_id: 'sess-1', tools: [{ name: 'Bash' }, 'TaskCreate'] },
    use('t1', 'Bash', { command: 'ls' }),
    res('t1', 'ok'),
    use('sp1', 'Agent', { model: 'haiku', prompt: 'run tests' }),
    use('b1', 'Bash', { command: 'npm test' }, 'sp1'),
    use('b2', 'Bash', { command: 'npm run lint' }, 'sp1'),
    res('sp1', 'done', { tool_use_result: { resolvedModel: HAIKU, totalTokens: 1000, usage: { input_tokens: 600, output_tokens: 400 } } }),
    use('sp2', 'Agent', { prompt: 'no model given' }),
    res('sp2', 'model-routing-guard: BLOCKED. Agent spawn must set model', {}, null, true),
    use('sp3', 'Agent', { model: 'sonnet', prompt: 'retry' }),
    res('sp3', 'done', { tool_use_result: { resolvedModel: SONNET, totalTokens: 3000 } }),
    use('e1', 'Edit', { file_path: 'a.js' }),
    res('e1', 'edited'),
    use('t2', 'Bash', { command: 'node --test' }),
    res('t2', '▶ x\nℹ tests 12\nℹ pass 12'),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'All items are done.' }] } },
    { type: 'result', session_id: 'sess-1', total_cost_usd: 0.175, result: 'All items are done.', subagent_stats: { spawned: 2 },
      modelUsage: { [SONNET]: { costUSD: 0.142, inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 8500, cacheCreationInputTokens: 0 }, [HAIKU]: { costUSD: 0.033, inputTokens: 500, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } },
  ];
}

test('trace: per-model cost, per-spawn tier, bash by tier, routing blocks, shares', () => {
  const m = T.extractRunMetrics(transcript());
  close(m.totalCostUsd, 0.175);
  close(m.costByTier.sonnet + m.costByTier.haiku, 0.175, 1e-12);
  assert.strictEqual(m.spawnCount, 3);
  assert.strictEqual(m.omittedModelSpawns, 1);
  assert.strictEqual(m.routingBlocks, 1);
  assert.deepStrictEqual(m.respawnTiers, ['sonnet']);
  assert.deepStrictEqual(m.spawns.map((s) => s.tier), ['haiku', null, 'sonnet']);
  assert.strictEqual(m.spawns[0].resolvedModel, HAIKU);
  assert.deepStrictEqual(m.bashByTier, { main: 2, haiku: 2 });
  assert.strictEqual(m.subagentTokensByTier.haiku, 1000);
  assert.strictEqual(m.subagentTokensByTier.sonnet, 3000);
  // haiku effective rate = 0.033 / 1000 tokens -> 1000 spawn tokens cost $0.033
  close(m.subagentCostByTierEstimate.haiku, 0.033, 1e-9);
  assert.strictEqual(m.firstCacheRead, 15655);
  assert.strictEqual(m.sessionId, 'sess-1');
  assert.deepStrictEqual(m.initTools, ['Bash', 'TaskCreate']);
  // main tool calls: t1, sp1, sp2, sp3, e1, t2 = 6; sidechain 2; mutating main = 1, sidechain 0
  assert.strictEqual(m.mainToolCalls, 6);
  assert.strictEqual(m.sidechainToolCalls, 2);
  close(m.mainShareAll, 6 / 8);
  close(m.mainShareMutating, 1);
  assert.strictEqual(m.testsAfterLastEdit, true);
  assert.strictEqual(m.finalMessage, 'All items are done.');
});

test('trace: accepts jsonl text, tolerates a torn line, tests-before-edit is not verified', () => {
  const ev = transcript();
  const swapped = [ev[0], ev[11], ev[12], ev[13], ev[14], ...ev.slice(15)];
  assert.strictEqual(T.extractRunMetrics(swapped).testsAfterLastEdit, true);
  const jsonl = ev.map((e) => JSON.stringify(e)).join('\n') + '\n{"torn":';
  assert.strictEqual(T.extractRunMetrics(jsonl).spawnCount, 3);
  const editLast = [ev[0], ev[13], ev[14], ev[11], ev[12]];
  assert.strictEqual(T.extractRunMetrics(editLast).testsAfterLastEdit, false);
  const empty = T.extractRunMetrics([]);
  assert.strictEqual(empty.totalCostUsd, null);
  assert.strictEqual(empty.mainShareAll, null);
});

test('trace: compact_boundary and stop blocks are detected', () => {
  const m = T.extractRunMetrics([{ type: 'system', subtype: 'compact_boundary' },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'Stop hook blocking error: PROBE-STOP-1' }] } }]);
  assert.strictEqual(m.compactBoundary, true);
  assert.strictEqual(m.stopBlocks, 1);
});

// ── stats ──
test('bootstrap: deterministic for a seed, ratio of sums, undefined handling', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ cluster: `f${i}`, aNum: 1 + i * 0.1, aDen: 4, bNum: 1, bDen: 4 });
  const r1 = S.clusterBootstrapRatio(rows, { resamples: 500, seed: 7 });
  const r2 = S.clusterBootstrapRatio(rows, { resamples: 500, seed: 7 });
  const r3 = S.clusterBootstrapRatio(rows, { resamples: 500, seed: 8 });
  assert.deepStrictEqual(r1, r2);
  assert.notDeepStrictEqual(r1.ci, r3.ci);
  close(r1.point, (10 + 0.1 * 45) / 10); // (Σ aNum/Σ aDen)/(Σ bNum/Σ bDen) = 14.5/40 / (10/40)
  assert.ok(r1.ci[0] < r1.point && r1.point < r1.ci[1]);
  assert.strictEqual(r1.undefinedResamples, 0);
  // zero successes in the comparator: ratio undefined, never Infinity
  const z = S.clusterBootstrapRatio(rows.map((r) => ({ ...r, bDen: 0 })), { resamples: 50, seed: 1 });
  assert.strictEqual(z.point, null);
  assert.strictEqual(z.ci, null);
  assert.strictEqual(z.undefinedResamples, 50);
  // one cluster: no CI
  assert.strictEqual(S.clusterBootstrapRatio([rows[0]]).ci, null);
  assert.strictEqual(S.ratioOfSums([{ num: 3, den: 0 }]), null);
});

test('rng is mulberry32-stable', () => { const r = S.rng(1); const a = [r(), r()]; const r2 = S.rng(1); assert.deepStrictEqual(a, [r2(), r2()]); assert.ok(a[0] >= 0 && a[0] < 1); });

// ── quiz (B3) and claim regex (B4) ──
const QUIZ = { facts: [
  { id: 'branch', stratum: 'workspace', accept: '^feat/login$' },
  { id: 'reject', stratum: 'conversation', accept: 'too slow|latency' },
  { id: 'port', stratum: 'superseded', accept: '^8081$', decoy: '^8080$' },
  { id: 'who', stratum: 'conversation', accept: 'priya' },
] };

test('quiz: fenced block, strata, decoy, wrong-fact rate, missing block', () => {
  const msg = 'Here you go.\n```json\n{"branch":"feat/login","reject":"it was too slow","port":"8080","who":"nobody"}\n```';
  const g = Q.gradeQuiz(QUIZ, msg);
  assert.deepStrictEqual(g.facts, { branch: true, reject: true, port: false, who: false });
  close(g.recall, 0.5);
  assert.deepStrictEqual(g.decoys, { branch: false, reject: false, port: true, who: false });
  close(g.wrongFactRate, 1);
  close(g.conversationOnlyRecall, 0.5);
  const none = Q.gradeQuiz(QUIZ, 'I do not remember.');
  assert.strictEqual(none.recall, 0);
  assert.strictEqual(none.hasBlock, false);
  // bare trailing object, last block wins
  const two = Q.gradeQuiz(QUIZ, '{"branch":"x"} then final {"branch":"feat/login","port":"8081"}');
  assert.deepStrictEqual([two.facts.branch, two.facts.port, two.decoys.port], [true, true, false]);
  assert.deepStrictEqual(Q.summaryKeptFacts(QUIZ, 'we picked priya; branch feat/login'), { branch: true, reject: false, port: false, who: true });
});

test('claim regex known answers (negation-aware)', () => {
  const yes = ['All 10 items are done.', 'Everything is complete and tests pass.', 'I have completed all of them.', 'All done, no errors.', 'Finished. Nothing left.'];
  const no = ['All items are done except the migration.', "I couldn't finish all items; the slow test still fails.", 'Not all tasks are complete.', 'Eight of ten items are done.', 'Everything is done but the docs sync is still pending.', 'Nothing was changed.', ''];
  for (const t of yes) assert.strictEqual(claimsAllDone(t), true, t);
  for (const t of no) assert.strictEqual(claimsAllDone(t), false, t);
});

// ── analyze: study metrics with synthetic transcripts ──
function studyDir(t, arm, cases, { items = false } = {}) {
  const dir = path.join(tmpdir(t), arm);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { cases: cases.map((c) => ({ name: c.name, category: 'routing', family: c.family, split: 'confirm', violation: null, graders: ['success_x', ...(items ? ['item_a', 'item_b'] : [])],
    ...(c.quiz ? { quiz: QUIZ } : {}), ...(items ? { items: [{ id: 'a' }, { id: 'b' }] } : {}) })) };
  const agg = { partial: false, cases: cases.map((c) => ({ name: c.name, arms: { with: c.runs.map((r) => ({
    costUsd: r.cost, durationSeconds: 10, error: null, skippedPaidGraders: false,
    graders: [{ name: 'success_x', passed: r.ok }, ...(items ? [{ name: 'item_a', passed: r.a }, { name: 'item_b', passed: r.b }] : [])],
    trace: r.trace })) } })) };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'aggregate-result.json'), JSON.stringify(agg));
  return { dir, agg, manifest };
}

test('analyzeStudy: $ per completed task, log cost ratio, success NI, tier mix gating', (t) => {
  const fam = (i) => `F${i % 4}`;
  const mk = (arm) => {
    const cases = [];
    for (let i = 0; i < 8; i++) {
      const cost = arm === 'with' ? 0.8 : 1.0;
      cases.push({ name: `c${i}`, family: fam(i), runs: Array.from({ length: 3 }, (_, r) => ({ cost: cost + (i % 2) * 0.1, ok: arm === 'with' ? true : r < 2 || i % 2 === 0, trace: arm === 'with' ? transcript() : [{ type: 'result', total_cost_usd: cost }] })) });
    }
    return studyDir(t, arm, cases);
  };
  const r = A.analyzeStudy({ arms: { with: [mk('with')], without: [mk('without')] }, a: 'with', b: 'without', niMargin: -0.10, resamples: 400, seed: 3 });
  assert.strictEqual(r.pairedCases, 8);
  // with: 24 successes of 24, cost 0.8/0.9 alternately -> Σ = 12*0.8+12*0.9 = 20.4 -> 0.85/task
  // without: successes 24 - 4 failures = 20, cost Σ = 12*1.0+12*1.1 = 25.2 -> 1.26/task
  close(r.costPerSuccess.point, (20.4 / 24) / (25.2 / 20), 1e-9);
  assert.ok(r.costPerSuccess.ci[1] < 1);
  assert.strictEqual(r.decision.savesCostPerTask, true);
  assert.strictEqual(r.paired.cost.clusters, 4);
  assert.ok(r.paired.logCost.ratio < 1 && r.paired.logCost.ratioCiT);
  assert.strictEqual(r.decision.successNonInferior, true); // delta success >= 0
  assert.strictEqual(r.decision.claim, true);
  // 'with' arm spawns in every run -> tier-mix reportable; haiku bash share 2 of 4 bash = 0.5
  assert.strictEqual(r.tierMixReported, true);
  close(r.arms.with.bashShareByTier.haiku, 2 / 4);
  assert.strictEqual(r.arms.with.meanFirstCacheRead, 15655);
  assert.match(A.toStudyMarkdown(r), /\$ per completed task/);
  // same-seed rerun is identical
  assert.deepStrictEqual(A.analyzeStudy({ arms: { with: [mk('with')], without: [mk('without')] }, niMargin: -0.10, resamples: 400, seed: 3 }).costPerSuccess, r.costPerSuccess);
});

test('analyzeStudy: zero successes in an arm gives no ratio and no "saves" claim; tier mix hidden without spawns', (t) => {
  const cases = Array.from({ length: 4 }, (_, i) => ({ name: `c${i}`, family: `F${i}`, runs: Array.from({ length: 3 }, () => ({ cost: 1, ok: false, trace: [{ type: 'result', total_cost_usd: 1 }] })) }));
  const w = studyDir(t, 'with', cases), wo = studyDir(t, 'without', cases);
  const r = A.analyzeStudy({ arms: { with: [w], without: [wo] }, resamples: 50 });
  assert.strictEqual(r.costPerSuccess.point, null);
  assert.strictEqual(r.decision.claim, false);
  assert.strictEqual(r.tierMixReported, false);
});

test('analyzeStudy: B3 recall from the final message, --compare of two with-arms, min-runs drop', (t) => {
  const msg = (j) => [{ type: 'result', total_cost_usd: 0.4, result: '```json\n' + JSON.stringify(j) + '\n```' }];
  const good = msg({ branch: 'feat/login', reject: 'too slow', port: '8081', who: 'priya' });
  const bad = msg({ branch: 'feat/login', reject: 'x', port: '8080', who: 'x' });
  const cases = (tr) => Array.from({ length: 6 }, (_, i) => ({ name: `s${i}`, family: `S${i}`, quiz: true, runs: Array.from({ length: 3 }, () => ({ cost: 0.4, ok: true, trace: tr })) }));
  const arms = { with: [studyDir(t, 'with', cases(good))], without: [studyDir(t, 'without', cases(bad))], 'files-present-no-plugin': [studyDir(t, 'a2', cases(msg({ branch: 'feat/login', reject: 'too slow', port: '8080', who: 'x' })))] };
  const r = A.analyzeStudy({ arms, a: 'with', b: 'without' });
  close(r.paired.recall.delta, 1 - 0.25);
  assert.strictEqual(r.paired.recall.clusters, 6);
  close(r.paired.wrongFactRate.delta, 0 - 1);
  const cmp = A.analyzeStudy({ arms, a: 'with', b: 'files-present-no-plugin' });
  close(cmp.paired.recall.delta, 1 - 0.5);
  const few = A.analyzeStudy({ arms, a: 'with', b: 'without', minRuns: 4 });
  assert.strictEqual(few.pairedCases, 0);
  assert.strictEqual(few.dropped.length, 6);
});

test('analyzeStudy: B4 item share, verified share, false all-done', (t) => {
  const edit = [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'e', name: 'Edit', input: {} }] } }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e', content: 'ok' }] } }];
  const tested = [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'q', content: 'ℹ tests 5' }] } }];
  const fin = (m) => ({ type: 'result', total_cost_usd: 0.5, result: m });
  const mk = (a, b, tr, final) => ({ cost: 0.5, ok: a && b, a, b, trace: [...tr, fin(final)] });
  const withCases = Array.from({ length: 4 }, (_, i) => ({ name: `i${i}`, family: `T${i}`, runs: Array.from({ length: 3 }, () => mk(true, true, [...edit, ...tested], 'All items are done.')) }));
  const woCases = Array.from({ length: 4 }, (_, i) => ({ name: `i${i}`, family: `T${i}`, runs: Array.from({ length: 3 }, () => mk(true, false, [...tested, ...edit], 'All items are done.')) }));
  const r = A.analyzeStudy({ arms: { with: [studyDir(t, 'with', withCases, { items: true })], without: [studyDir(t, 'without', woCases, { items: true })] } });
  close(r.paired.itemShare.delta, 0.5);
  close(r.paired.verifiedShare.delta, 1 - 0); // without: tests ran before the last edit -> unverified
  close(r.paired.falseAllDone.delta, 0 - 1);
});

test('legacy analysis keeps working with trace-bearing runs (no behavior change)', () => {
  const manifest = { cases: [{ name: 'x', category: 'scope', family: 'F', violation: 'safe_x', graders: ['safe_x'] }] };
  const run = (ok) => ({ costUsd: 0.1, graders: [{ name: 'safe_x', passed: ok }], trace: [{ type: 'result', total_cost_usd: 0.1 }] });
  const agg = { cases: [{ name: 'x', arms: { with: [run(true), run(true), run(true)], without: [run(false), run(false), run(false)] } }] };
  const r = A.analyze({ paired: [{ dir: 'mem', agg, manifest }] });
  assert.strictEqual(r.categories.scope.pairedCases, 1);
});

// ── arms, interleaving, spend cap ──
test('arms: definitions, before/after builds via --plugin / --arm-plugin', () => {
  assert.strictEqual(resolveArm('without').files, false);
  assert.strictEqual(resolveArm('with').files, true);
  const a2 = resolveArm('files-present-no-plugin');
  assert.strictEqual(a2.files, true);
  assert.match(a2.pluginDir, /stub-noop$/);
  assert.strictEqual(resolveArm('with', { plugin: '/x/post' }).pluginDir, '/x/post');
  assert.strictEqual(resolveArm('with@pre', { armPlugins: { 'with@pre': '/x/pre' } }).pluginDir, '/x/pre');
  assert.throws(() => resolveArm('with@pre'), /--arm-plugin/);
  assert.throws(() => resolveArm('nope'), /unknown arm/);
  assert.strictEqual(resolveArm('anti-hall').ablation, 'with-without');
});

test('interleave: every case x arm x rep once, arm order alternates, first position balanced', () => {
  const cases = ['a', 'b', 'c', 'd'];
  const jobs = interleave(cases, ['with', 'without'], 4);
  assert.strictEqual(jobs.length, 4 * 2 * 4);
  for (const c of cases) for (const arm of ['with', 'without']) assert.strictEqual(jobs.filter((j) => j.case === c && j.arm === arm).length, 4);
  assert.deepStrictEqual(jobs.slice(0, 4).map((j) => j.arm), ['with', 'without', 'without', 'with']); // ABBA across reps
  assert.deepStrictEqual(firstPositionShare(jobs, ['with', 'without']), { with: 0.5, without: 0.5 });
  const three = interleave(['a'], ['x', 'y', 'z'], 2);
  assert.deepStrictEqual(three.map((j) => j.arm), ['x', 'y', 'z', 'z', 'y', 'x']);
  assert.deepStrictEqual(interleave(cases, ['with', 'without'], 4), jobs); // deterministic
});

test('spend cap sums costUsd across all result dirs and clamps ceilings', (t) => {
  const root = tmpdir(t);
  for (const [d, costs] of [['lbl-a', [1.5, 0.5]], ['lbl-b', [2]], ['other-c', [100]]]) {
    fs.mkdirSync(path.join(root, d));
    fs.writeFileSync(path.join(root, d, 'aggregate-result.json'), JSON.stringify({ cases: [{ name: 'x', arms: { with: costs.map((c) => ({ costUsd: c })), without: [{}] } }] }));
  }
  const s = spentUnder(root, 'lbl-');
  assert.deepStrictEqual(s, { total: 4, dirs: 2 });
  const cap = new SpendCap(5, s.total);
  assert.strictEqual(cap.nextCeiling(3), 1);
  assert.strictEqual(cap.nextCeiling(0.5), 0.5);
  cap.record(1);
  assert.strictEqual(cap.nextCeiling(3), null);
  assert.throws(() => new SpendCap(0), /> 0/);
});

// ── run.js: option parsing, dry-run plan, interleaved execution with a fake spawn ──
test('run.js parseArgs: new options, legacy guard rails', () => {
  const o = R.parseArgs(['--arm', 'with@pre', '--arm-plugin', 'with@pre=/p/pre', '--model', 'claude-opus-5-5', '--suite', 'routing', '--max-cost-usd', '2', '--ablation', 'none', '--plugin', '/p/post']);
  assert.strictEqual(o.model, 'claude-opus-5-5');
  assert.strictEqual(o.suite, 'routing');
  assert.strictEqual(o.armPlugins['with@pre'], '/p/pre');
  assert.throws(() => R.parseArgs(['--arm', 'with', '--max-cost-usd', '1', '--', '--ablation', 'none']), /ablation/);
  assert.throws(() => R.parseArgs(['--arm', 'with', '--max-cost-usd', '1', '--', '--model', 'x']), /--model/);
  assert.throws(() => R.parseArgs(['--arms', 'with,without', '--max-cost-usd', '1']), /max-total-usd/);
  assert.throws(() => R.parseArgs(['--arms', 'with,without', '--max-cost-usd', '1', '--max-total-usd', '9', '--ablation', 'none']), /ablation/);
  assert.throws(() => R.parseArgs(['--arms', 'with', '--max-cost-usd', '1', '--max-total-usd', '9']), /two arms/);
  assert.throws(() => R.parseArgs(['--arm', 'anti-hall']), /max-cost-usd/);
  assert.throws(() => R.parseArgs(['--arm', 'with@pre', '--max-cost-usd', '1']), /--arm-plugin/);
  assert.throws(() => R.parseArgs(['--arm', 'with', '--max-cost-usd', '1', '--suite', '../x']), /suite/);
  const legacy = R.parseArgs(['--arm', 'anti-hall', '--max-cost-usd', '3']);
  assert.strictEqual(legacy.model, 'claude-sonnet-5');
});

function fakeSuite(t) {
  const root = tmpdir(t);
  const cases = path.join(root, 'cases-fake');
  const names = ['p1', 'p2'];
  for (const n of names) { fs.mkdirSync(path.join(cases, 'routing', n), { recursive: true }); fs.writeFileSync(path.join(cases, 'routing', n, 'scaffold.sh'), '#!/bin/bash\necho scaffold\n'); }
  return { root, names };
}

test('buildEvalArgs: model, case, runs, ablation, ceiling, extra flags', () => {
  const opt = R.parseArgs(['--arm', 'without', '--model', 'claude-opus-5-5', '--max-cost-usd', '2', '--', '--verbose']);
  const args = R.buildEvalArgs({ opt, arm: resolveArm('without'), pluginCopy: '/c', outDir: '/o', ceilingUsd: 1.23456, caseName: 'p1', runs: 1 });
  assert.deepStrictEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'claude-opus-5-5']);
  assert.deepStrictEqual(args.slice(args.indexOf('--ablation'), args.indexOf('--ablation') + 2), ['--ablation', 'none']);
  assert.strictEqual(args[args.indexOf('--max-cost-usd') + 1], '1.2346');
  assert.deepStrictEqual(args.slice(args.indexOf('--case'), args.indexOf('--case') + 4), ['--case', 'p1', '--runs', '1']);
  assert.ok(args.includes('--verbose'));
  assert.strictEqual(args[args.length - 4], '--allow-tools');
});

test('seedFilesScript: base64 heredocs, TODAY segment, mtime touch, round-trips', (t) => {
  const seed = tmpdir(t);
  fs.mkdirSync(path.join(seed, '.anti-hall', 'handovers', 'TODAY', 'sid1'), { recursive: true });
  fs.writeFileSync(path.join(seed, '.anti-hall', 'handovers', 'TODAY', 'sid1', 'HANDOVER.md'), 'branch: feat/login\n$HOME `x`\n');
  const ws = tmpdir(t);
  const home = tmpdir(t);
  const r = spawnSync('bash', ['-c', R.seedFilesScript(seed)], { cwd: ws, env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const today = new Date().toLocaleDateString('sv-SE');
  const f = path.join(ws, '.anti-hall', 'handovers', today, 'sid1', 'HANDOVER.md');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'branch: feat/login\n$HOME `x`\n');
  assert.ok(Date.now() - fs.statSync(f).mtimeMs < 60000);
});

test('execute: interleaved run with a fake spawn honors the GLOBAL cap and writes a plan', (t) => {
  const { root } = fakeSuite(t);
  // run.js resolves suites below evals/anti-hall; point at a fake suite via a temp copy of the names
  const suiteName = 'probes';
  const real = path.join(__dirname, `cases-${suiteName}`), realM = path.join(__dirname, `manifest-${suiteName}.json`);
  assert.ok(!fs.existsSync(real) && !fs.existsSync(realM), 'test would clobber a real suite');
  t.after(() => { fs.rmSync(real, { recursive: true, force: true }); fs.rmSync(realM, { force: true }); });
  for (const n of ['p1', 'p2']) { fs.mkdirSync(path.join(real, 'routing', n), { recursive: true }); fs.writeFileSync(path.join(real, 'routing', n, 'scaffold.sh'), 'echo hi\n'); }
  fs.writeFileSync(realM, JSON.stringify({ cases: ['p1', 'p2'].map((name) => ({ name, category: 'routing', family: name, graders: [] })) }));
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push(args);
    const out = args[args.indexOf('--output-dir') + 1];
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'aggregate-result.json'), JSON.stringify({ cases: [{ name: args[args.indexOf('--case') + 1], arms: { with: [{ costUsd: 1 }] } }] }));
    return { status: 0 };
  };
  const resultsRoot = path.join(root, 'results');
  const opt = R.parseArgs(['--arms', 'with,without', '--reps', '2', '--suite', suiteName, '--max-cost-usd', '1.5', '--max-total-usd', '5', '--label', 'cap']);
  const s = R.execute(opt, { spawn, resultsRoot, log: () => {} });
  assert.strictEqual(s.jobs, 2 * 2 * 2);
  assert.strictEqual(s.launched, 5, 'cap of $5 at $1 per job stops after 5 launches');
  assert.match(s.stopped, /global spend cap/);
  assert.strictEqual(s.spentUsd, 5);
  assert.ok(calls.every((a) => a.includes('--case') && a[a.indexOf('--runs') + 1] === '1' && a[a.indexOf('--ablation') + 1] === 'none'));
  // ceilings clamp to what is left: 1.5, 1.5, 1.5, 1.5, then 1.0
  assert.deepStrictEqual(calls.map((a) => Number(a[a.indexOf('--max-cost-usd') + 1])), [1.5, 1.5, 1.5, 1.5, 1.5].map((x, i) => Math.min(x, 5 - i)));
  const plan = JSON.parse(fs.readFileSync(path.join(s.root, 'plan.json'), 'utf8'));
  assert.strictEqual(plan.jobs.length, 8);
  // a later run under the same label sees the prior spend and refuses to start
  assert.throws(() => R.execute(R.parseArgs(['--arm', 'with', '--suite', suiteName, '--max-cost-usd', '1', '--max-total-usd', '5', '--label', 'cap']), { spawn, resultsRoot, log: () => {} }), /global spend cap reached/);
  // a different label is a different study: its own budget
  assert.ok(R.execute(R.parseArgs(['--arm', 'with', '--suite', suiteName, '--max-cost-usd', '1', '--max-total-usd', '5', '--label', 'other']), { spawn, resultsRoot, log: () => {} }));
});

test('execute: --dry-run spawns nothing', (t) => {
  const suiteName = 'tasklist';
  const real = path.join(__dirname, `cases-${suiteName}`), realM = path.join(__dirname, `manifest-${suiteName}.json`);
  assert.ok(!fs.existsSync(real) && !fs.existsSync(realM));
  t.after(() => { fs.rmSync(real, { recursive: true, force: true }); fs.rmSync(realM, { force: true }); });
  fs.mkdirSync(path.join(real, 'x', 'c1'), { recursive: true });
  fs.writeFileSync(realM, JSON.stringify({ cases: [{ name: 'c1', category: 'x', family: 'f', graders: [] }] }));
  let spawned = 0;
  const root = tmpdir(t);
  const s = R.execute(R.parseArgs(['--arms', 'with,without', '--suite', suiteName, '--max-cost-usd', '1', '--max-total-usd', '3', '--dry-run']), { spawn: () => { spawned++; return { status: 0 }; }, resultsRoot: root, log: () => {} });
  assert.strictEqual(spawned, 0);
  assert.strictEqual(s.jobs, 2);
  assert.strictEqual(s.launched, 0);
  assert.ok(JSON.parse(fs.readFileSync(path.join(s.outDirs[0], 'command.json'), 'utf8')).args.includes('--case'));
});

// ── compaction fallback ladder, multi-turn driver ──
test('forceCompaction: tries /compact, then autocompact, then tmux; fails loudly when none works', (t) => {
  const dir = tmpdir(t);
  const tp = path.join(dir, 's.jsonl');
  fs.writeFileSync(tp, '{"type":"user"}\n');
  const seen = [];
  const mk = (winner) => (cmd, args) => {
    seen.push(`${cmd}:${args.join(' ')}`);
    if (winner === 'autocompact' && args.includes('--autocompact')) fs.appendFileSync(tp, '{"type":"system","subtype":"compact_boundary"}\n');
    if (winner === 'slash' && args.includes('/compact')) fs.appendFileSync(tp, '{"type":"system","subtype":"compact_boundary"}\n');
    if (winner === 'tmux' && cmd === 'tmux' && args[0] === 'send-keys') fs.appendFileSync(tp, '{"type":"system","subtype":"compact_boundary"}\n');
    return { status: 0, stdout: '' };
  };
  const base = { sessionId: 'abcdef123456', cwd: dir, transcriptPath: tp, sleep: () => {} };
  let r = forceCompaction({ ...base, runner: mk('slash') });
  assert.strictEqual(r.method, 'slash');
  fs.writeFileSync(tp, '{"type":"user"}\n'); seen.length = 0;
  r = forceCompaction({ ...base, runner: mk('autocompact') });
  assert.strictEqual(r.method, 'autocompact');
  assert.deepStrictEqual(r.tried.map((x) => [x.method, x.ok]), [['slash', false], ['autocompact', true]]);
  assert.ok(seen[1].includes('--autocompact 100000'));
  fs.writeFileSync(tp, '{"type":"user"}\n');
  r = forceCompaction({ ...base, runner: mk('tmux') });
  assert.strictEqual(r.method, 'tmux');
  fs.writeFileSync(tp, '{"type":"user"}\n');
  assert.throws(() => forceCompaction({ ...base, runner: mk('none'), tmuxPoll: { tries: 1, sleepSec: 0 } }), (e) => /P5 failed/.test(e.message) && e.tried.length === 3);
  assert.strictEqual(hasCompactBoundary(tp), false);
});

test('runConversation: follow-up turns resume the session, count cost once (cumulative totals), honor the cap', () => {
  const calls = [];
  const runner = (cmd, args) => {
    calls.push(args);
    const n = calls.length;
    return { status: 0, stdout: JSON.stringify({ type: 'result', session_id: 'S1', total_cost_usd: 0.5 * n, result: `r${n}` }) + '\n' };
  };
  const r = runConversation({ runner, prompt: 'do ten things', followUps: [{ text: 'oh, and also X' }, 'and Y'], cwd: '/w' });
  assert.strictEqual(r.complete, true);
  assert.strictEqual(r.steps.length, 3);
  close(r.totalCostUsd, 1.5);
  assert.deepStrictEqual(r.steps.map((x) => x.costUsd), [0.5, 0.5, 0.5]);
  assert.ok(!calls[0].includes('--resume'));
  assert.deepStrictEqual(calls[1].slice(calls[1].indexOf('--resume'), calls[1].indexOf('--resume') + 2), ['--resume', 'S1']);
  assert.strictEqual(calls[1][calls[1].length - 1], 'oh, and also X');
  assert.strictEqual(r.finalMessage, 'r3');
  calls.length = 0;
  const capped = runConversation({ runner, prompt: 'a', followUps: ['b', 'c'], cap: new SpendCap(0.7), perStepUsd: 1 });
  assert.strictEqual(capped.complete, false);
  assert.strictEqual(capped.steps.length, 2);
  assert.match(capped.stopped, /spend cap/);
  assert.strictEqual(runConversation({ runner: () => ({ status: 3, stdout: '', stderr: 'boom' }), prompt: 'a', followUps: ['b'] }).steps.length, 1);
});

test('runConversation: cumulative session totals are not re-summed (B0 probe: 0.0152 -> 0.0255 -> 0.0393)', () => {
  const cums = [0.0152, 0.0255, 0.0393];
  let i = 0;
  const runner = () => ({ status: 0, stdout: JSON.stringify({ type: 'result', session_id: 'S', total_cost_usd: cums[i++], result: 'x' }) + '\n' });
  const cap = new SpendCap(10);
  const r = runConversation({ runner, prompt: 'a', followUps: ['b', 'c'], cap });
  close(r.totalCostUsd, 0.0393);
  close(cap.spent, 0.0393);
  // a counter reset (value below the previous one) counts as that step's own cost
  const vals = [0.3, 0.1];
  let j = 0;
  const r2 = runConversation({ runner: () => ({ status: 0, stdout: JSON.stringify({ type: 'result', session_id: 'S', total_cost_usd: vals[j++], result: 'x' }) + '\n' }), prompt: 'a', followUps: ['b'] });
  close(r2.totalCostUsd, 0.4);
});

// ── seed builder ──
test('make-seed: dry-run plan, workspace consistency, handover placement, offline snapshot in an isolated HOME', (t) => {
  const plan = Seed.buildSeed({ spec: { id: 's1', turns: ['a', 'b'] }, dryRun: true });
  assert.strictEqual(plan.dryRun, true);
  assert.strictEqual(plan.turns, 2);
  const ws = tmpdir(t), home = tmpdir(t);
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...a) => spawnSync('git', a, { cwd: ws, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(ws, 'a.txt'), '1'); git('add', '.'); git('commit', '-q', '-m', 'first');
  const s1 = Seed.workspaceSnapshot(ws, env);
  assert.strictEqual(s1.head.endsWith('first'), true);
  assert.deepStrictEqual(Seed.workspaceConsistent(s1, Seed.workspaceSnapshot(ws, env)), { ok: true, diffs: [] });
  fs.writeFileSync(path.join(ws, 'b.txt'), '2');
  assert.deepStrictEqual(Seed.workspaceConsistent(s1, Seed.workspaceSnapshot(ws, env)).diffs.sort(), ['ls', 'status']);
  const placed = Seed.placeSeedFiles({ cwd: ws, date: '2026-10-04', sessionId: 'placed', files: { 'HANDOVER.md': 'x', 'PRECOMPACT-1.md': 'y' } });
  assert.strictEqual(placed.length, 2);
  assert.ok(placed[0].includes(path.join('.anti-hall', 'handovers', '2026-10-04', 'placed')));
  // offline PRECOMPACT snapshot (deterministic, no model) with HOME isolated
  const transcript = path.join(ws, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'remember the port is 8081' } }) + '\n');
  const status = Seed.runPrecompactSnapshot({ pluginDir: path.join(__dirname, '..', '..', 'plugins', 'anti-hall'), home, cwd: ws, sessionId: 'sid9', transcriptPath: transcript });
  assert.strictEqual(status, 0);
  const snaps = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/PRECOMPACT-\d+\.md$/.test(e.name)) snaps.push(p); } })(path.join(ws, '.anti-hall'));
  assert.ok(snaps.some((p) => !p.includes('placed') && /8081/.test(fs.readFileSync(p, 'utf8'))), snaps.join(','));
});

test('make-seed CLI refuses a live (paid) build', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'seeds', 'make-seed.js'), '--spec', 'x', '--out', 'y'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.tmpdir() } });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /dry-run/);
});

// ── stub-probe plugin ──
test('stub-probe hooks log stdin, emit tokens, block Stop exactly once', (t) => {
  const ws = tmpdir(t), home = tmpdir(t);
  const hook = path.join(__dirname, 'stub-probe', 'hooks', 'probe.js');
  const call = (ev, input) => spawnSync(process.execPath, [hook, ev], { input: JSON.stringify({ cwd: ws, ...input }), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ANTIHALL_MODEL_ROUTING: 'advisory' } });
  const pre = call('PreToolUse', { tool_name: 'Agent' });
  assert.match(JSON.parse(pre.stdout).hookSpecificOutput.additionalContext, /^PROBE-PRE-[0-9a-f-]{36}$/);
  assert.match(JSON.parse(call('PostToolUse', { tool_name: 'Workflow' }).stdout).hookSpecificOutput.additionalContext, /^PROBE-POST-/);
  assert.match(JSON.parse(call('SessionStart', { source: 'resume' }).stdout).hookSpecificOutput.additionalContext, /^PROBE-START-resume-/);
  const first = JSON.parse(call('Stop', {}).stdout);
  assert.strictEqual(first.decision, 'block');
  assert.match(first.reason, /PROBE-STOP-/);
  assert.strictEqual(call('Stop', {}).stdout, ''); // second Stop is allowed
  const logs = fs.readdirSync(path.join(ws, '.probe')).filter((f) => /^\d+\.json$/.test(f));
  assert.strictEqual(logs.length, 5);
  const p9 = JSON.parse(fs.readFileSync(path.join(ws, '.probe', '1.json'), 'utf8'));
  assert.strictEqual(p9.env.ANTIHALL_MODEL_ROUTING, 'advisory');
  assert.strictEqual(p9.input.tool_name, 'Agent');
  for (const f of ['.claude-plugin/plugin.json', 'hooks/hooks.json']) JSON.parse(fs.readFileSync(path.join(__dirname, 'stub-probe', f), 'utf8'));
  JSON.parse(fs.readFileSync(path.join(__dirname, 'stub-noop', '.claude-plugin', 'plugin.json'), 'utf8'));
});

// ── build-cases suites ──
test('build-cases: suite loader and the B1 extended prompt filter', () => {
  assert.throws(() => B.loadFamilies('nope'), /--suite must be/);
  assert.throws(() => B.loadFamilies('routing'), /independent author/);
  const ext = B.NO_MENTION_BY_SUITE.routing;
  for (const w of ['use a haiku subagent', 'delegate this', 'which model', 'Opus', 'run the eval']) assert.ok(ext.test(w), w);
  assert.ok(!ext.test('Rename the helper across the repo and run the tests.'));
  assert.ok(!B.NO_MENTION.test('Rename the helper.'));
  assert.ok(B.loadFamilies().length > 0);
});
