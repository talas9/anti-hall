'use strict';
// anti-hall :: sqlite-quiet — the ONE place that loads `node:sqlite`.
//
// On Node 22.5+ the first require('node:sqlite') in a process emits
//   (node:PID) ExperimentalWarning: SQLite is an experimental feature ...
//   (Use `node --trace-warnings ...` to show where the warning was created)
// on stderr. A long-lived companion run under the harness Monitor (the
// wake-watch) has every stderr line delivered as a wake event — each one costs
// the model a turn for pure noise. The warning is swallowed ONLY for that one
// load: process.emitWarning is wrapped for the duration of the synchronous
// require and always restored; every other warning passes through untouched.
// Same throw contract as require: a missing node:sqlite still throws.

const SQLITE_WARNING_RE = /SQLite is an experimental feature/i;

function requireSqlite() {
  const orig = process.emitWarning;
  process.emitWarning = function (warning) {
    const msg = typeof warning === 'string' ? warning : (warning && warning.message) || '';
    if (SQLITE_WARNING_RE.test(msg)) return undefined;
    return orig.apply(this, arguments);
  };
  try {
    return require('node:sqlite');
  } finally {
    process.emitWarning = orig;
  }
}

module.exports = { requireSqlite };
