'use strict';
// Test support: Node's own `reconcile` (cmdReconcile) for one project, the ground truth the engine's port is compared with.
// usage: node reconcile.js <plugin-root> <home> <cwd> [budgetMs stepMs]
// With a budget the clock steps `stepMs` per reading (the budget is then exact by construction); the printed result masks nothing.
const path = require('path');
const [root, home, cwd, budget, step] = process.argv.slice(2);
process.env.HOME = home;
const D = require(path.join(root, 'scripts', 'devswarm.js'));
const ctx = { home, env: process.env, cwd };
if (budget !== undefined) {
  let t = 0;
  const s = Number(step || 1000);
  ctx.reconcileBudgetMs = Number(budget);
  ctx.reconcileNow = () => { const v = t; t += s; return v; };
  ctx.nativeTimeoutRetryBackoffMs = 0;
}
const r = D.run(['reconcile'], ctx);
process.stdout.write(JSON.stringify(r.result) + '\n');
