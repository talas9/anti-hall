#!/usr/bin/env node
'use strict';
// jev-assist-worker.js — the sync half of jev-assist.js's askSync(). Never
// invoked directly by a user; askSync() spawns it via execFileSync with its
// OWN hard `timeout`, mirroring hooks/lib/jev-triage-worker.js's pattern for
// the same reason: jevDecide() is fetch-based (async), but some callers
// (model-routing-guard's PreToolUse main()) are fully synchronous.
//
// Contract: reads {question, state, timeoutMs} JSON from stdin, calls
// jevDecide, writes the Result JSON to stdout. Never throws past main();
// any failure prints {ok:false, reason:...} so the parent always gets valid
// JSON to parse.

const fs = require('fs');

async function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'no-input' }));
    return;
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch (_) {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'bad-input' }));
    return;
  }

  let jevDecide;
  try {
    ({ jevDecide } = require('./jev-client.js'));
  } catch (_) {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'unavailable' }));
    return;
  }

  const r = await jevDecide({
    question: input && input.question,
    state: input && input.state,
    timeoutMs: input && input.timeoutMs,
  });
  process.stdout.write(JSON.stringify(r));
}

main().catch(() => {
  try { process.stdout.write(JSON.stringify({ ok: false, reason: 'error' })); } catch (_) { /* nothing left to do */ }
});
