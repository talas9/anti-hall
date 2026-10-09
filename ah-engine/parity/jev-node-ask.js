#!/usr/bin/env node
// The Node side of the Jev parity harness (run-jev.js): reads requests as JSON, one per stdin line, runs each through the
// Node jev-assist.js ask() (the authority), and prints each decision as one JSON line in the field names `ah-engine jev ask`
// prints. Run with HOME set to a fixture home. Usage: node jev-node-ask.js <hooks-dir>
const path = require('path');
const hooks = path.resolve(process.argv[2]);
const assist = require(path.join(hooks, 'lib', 'jev-assist.js'));
const text = require('fs').readFileSync(0, 'utf8');
(async () => {
  for (const line of text.split('\n').filter((l) => l.trim())) {
    const r = JSON.parse(line);
    const trust = r.trust || 'add-block';
    const o = {
      id: r.id, question: r.question, state: r.state, trust, baseline: r.baseline === undefined ? null : r.baseline,
      home: process.env.HOME, project: r.project, sessionId: r.sessionId, turnRef: r.turnRef,
      budgetMs: r.budgetMs, cacheKey: r.cacheKey, compare: r.compare, recordDisagreement: r.recordDisagreement,
    };
    const d = await assist.ask(o);
    const out = {
      final: d.final === undefined ? null : d.final, jev: d.jev === undefined ? null : d.jev, baseline: d.baseline === undefined ? null : d.baseline,
      confidence: d.confidence === undefined ? null : d.confidence, confident: d.confident === undefined ? null : d.confident,
      ms: d.ms, backend: d.backend, reason: d.reason === undefined ? null : d.reason, h: d.h,
      costUsd: d.costUsd === undefined ? null : d.costUsd, costSource: d.costSource === undefined ? null : d.costSource,
    };
    process.stdout.write(JSON.stringify(out) + '\n');
  }
})();
