'use strict';
// jev-triage-arrival.js — detached child of jev-triage.js enqueueArrival().
// Reads one message body from stdin and labels it through the normal
// triageMessagesSync path (same worker, budget, claims, cache, log). Fail-open.
try {
  const home = process.env.ANTIHALL_TRIAGE_ARRIVAL_HOME;
  const text = require('fs').readFileSync(0, 'utf8');
  if (home && text.trim()) require('./jev-triage.js').triageMessagesSync([{ key: 0, text }], { home });
} catch (_) { /* advisory only */ }
