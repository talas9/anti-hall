'use strict';
// Arm definitions and interleaved scheduling (docs/BENCHMARK-METHOD.md Amendment 3 §8).
const path = require('path');

const HERE = path.resolve(__dirname, '..');
const REPO = path.resolve(HERE, '..', '..');

// plugin: 'repo' = plugins/anti-hall (or --plugin <dir>), 'noop' = stub-noop (loads nothing),
//         'block-all' = degenerate guard stub, or a literal dir via --arm-plugin name=dir.
// files:  seed files (B3 handover + PRECOMPACT) are scaffolded into the workspace.
// settings: --settings JSON is copied into the plugin copy (B1 ablation arm, only after probe P9).
const ARM_DEFS = {
  // legacy pilot arms: one CLI call, harness-run paired baseline
  'anti-hall': { plugin: 'repo', ablation: 'with-without', files: false, legacy: true },
  'block-all': { plugin: 'block-all', ablation: 'none', files: false, legacy: true },
  // strength-study arms: one arm per CLI call (ablation none), so arms can be interleaved
  without: { plugin: 'noop', ablation: 'none', files: false },
  with: { plugin: 'repo', ablation: 'none', files: true },
  'files-present-no-plugin': { plugin: 'noop', ablation: 'none', files: true },
  'with-settings': { plugin: 'repo', ablation: 'none', files: true, settings: true },
};

const PLUGIN_DIRS = {
  repo: path.join(REPO, 'plugins', 'anti-hall'),
  noop: path.join(HERE, 'stub-noop'),
  'block-all': path.join(HERE, 'stub-block-all'),
};

// armPlugins: { 'with@pre': '/abs/archive', ... } from repeated --arm-plugin name=dir.
// `with@<tag>` (before/after builds) behaves as `with` but loads the given directory.
function resolveArm(name, { plugin, armPlugins = {} } = {}) {
  let def = ARM_DEFS[name];
  let dir;
  if (!def && /^with@[\w.-]+$/.test(name)) {
    if (!armPlugins[name]) throw new Error(`arm ${name} needs --arm-plugin ${name}=<dir>`);
    def = { ...ARM_DEFS.with }; dir = armPlugins[name];
  }
  if (!def) throw new Error(`unknown arm ${name}; known: ${Object.keys(ARM_DEFS).join(', ')}, with@<tag>`);
  if (!dir) dir = armPlugins[name] || (def.plugin === 'repo' && plugin ? plugin : PLUGIN_DIRS[def.plugin]);
  return { name, ...def, pluginDir: path.resolve(dir) };
}

// Interleaved schedule: for each case (in the given order), K reps, each rep runs every arm once;
// the arm order alternates per rep (ABAB..., then BABA for the next case parity), so no arm
// systematically warms the prompt cache for the other. Deterministic and pure.
function interleave(cases, arms, reps) {
  const jobs = [];
  cases.forEach((c, ci) => {
    for (let r = 0; r < reps; r++) {
      const flip = (r + ci) % 2 === 1;
      const order = flip ? [...arms].reverse() : arms;
      order.forEach((arm) => jobs.push({ case: c, arm, rep: r + 1, caseIndex: ci }));
    }
  });
  return jobs;
}

// First-position share per arm: fairness check reported in the dry-run plan and the tests.
function firstPositionShare(jobs, arms) {
  const firsts = {};
  for (let i = 0; i < jobs.length; i += arms.length) firsts[jobs[i].arm] = (firsts[jobs[i].arm] || 0) + 1;
  const total = Object.values(firsts).reduce((a, b) => a + b, 0);
  return Object.fromEntries(arms.map((a) => [a, total ? (firsts[a] || 0) / total : 0]));
}

module.exports = { ARM_DEFS, resolveArm, interleave, firstPositionShare, PLUGIN_DIRS };
