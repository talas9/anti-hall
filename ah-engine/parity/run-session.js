#!/usr/bin/env node
// Parity of the six built-in session-maintenance checks against the real Node SessionStart hooks (see session-harness.js
// for what a scenario is and what is compared).
//   node run-session.js --engine ../target/release/ah-engine --repo <checkout> [--hook <name>|all] [--conc 6] [--show 25] [--keep]
const path = require('path');
const { runParity, HOOKS } = require('./session-harness.js');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const engine = arg('--engine', path.join(__dirname, '..', 'target', 'release', 'ah-engine'));
const repo = path.resolve(arg('--repo', path.join(__dirname, '..', '..')));
const want = arg('--hook', 'all');
const corpus = require('./session-corpus.js');
(async () => {
  let bad = 0;
  for (const hook of Object.keys(HOOKS)) {
    if (want !== 'all' && want !== hook) continue;
    let scenarios = corpus.build(hook, { repo });
    if (!scenarios) continue;
    if (arg('--only', '')) scenarios = scenarios.filter(s => s.id.includes(arg('--only', '')));
    await runParity({ name: hook, engine, repo, scenarios, conc: +arg('--conc', 6), show: +arg('--show', 25), keep: process.argv.includes('--keep'), verbose: process.argv.includes('--verbose'), tmpdir: arg('--tmp', undefined) });
    if (process.exitCode) bad = 1;
  }
  process.exitCode = bad;
})();
