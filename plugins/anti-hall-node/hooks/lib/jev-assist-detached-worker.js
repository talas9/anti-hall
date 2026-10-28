#!/usr/bin/env node
'use strict';
// jev-assist-detached-worker.js — the fire-and-forget half of jev-assist.js's
// askDetached(). Never invoked directly; askDetached() spawns it DETACHED
// (own process group, stdio ignored, unref()'d) so the caller returns
// immediately without waiting on this process or its network call.
//
// Contract: reads {id, question, state, trust, baseline, cacheKey, budgetMs,
// home} JSON from stdin, runs the SAME ask() flow jev-assist.js's own ask()
// runs (mode gating, cache, trust math, one metrics line), then exits. Its
// result is discarded by design — nothing reads this process's stdout.
// Never throws past main(); any failure is swallowed since there is no
// caller left to report it to.

const fs = require('fs');

async function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    return;
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch (_) {
    return;
  }

  let ask;
  try {
    ({ ask } = require('./jev-assist.js'));
  } catch (_) {
    return;
  }

  try {
    await ask({
      id: input && input.id,
      question: input && input.question,
      state: input && input.state,
      trust: input && input.trust,
      baseline: input && input.baseline,
      cacheKey: input && input.cacheKey,
      budgetMs: input && input.budgetMs,
      home: input && input.home,
      compare: input && input.compare,
      project: input && input.project,
      sessionId: input && input.sessionId,
      turnRef: input && input.turnRef,
    });
  } catch (_) {
    // nothing left to report to — this process's result is never observed.
  }
}

main().catch(() => {}).finally(() => {
  try { process.exit(0); } catch (_) { /* nothing left to do */ }
});
