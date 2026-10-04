'use strict';
// jev-triage-arrival.js — the ONE detached drain worker per HOME spawned by
// jev-triage.js enqueueArrival() (which already took the lock for it). Drains
// the arrival queue through the normal triage path, then releases the lock.
try {
  const home = process.env.ANTIHALL_TRIAGE_ARRIVAL_HOME;
  if (home) require('./jev-triage.js').runArrivalWorker(home, process.env.ANTIHALL_TRIAGE_ARRIVAL_TOKEN);
} catch (_) { /* advisory only */ }
