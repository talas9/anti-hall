'use strict';
// anti-hall :: devswarm-primary-gate (role-aware) — cheap "this hook cannot act" pre-check for
// the large role-specific DevSwarm hooks (devswarm-parent-gate.js ~187 KB,
// devswarm-parent-inbox.js ~167 KB, devswarm-child-turn.js / -child-gate.js
// ~70 KB each). They start by loading a dozen companion
// libs at module scope, which costs ~19 ms CPU on every Stop / prompt even in a
// session that is not a DevSwarm Primary (the common case). main() already
// returns early for those sessions; this repeats the SAME payload-independent
// checks, in the SAME order, before the heavy requires run, so a non-Primary
// session pays only for this ~2 KB lib + settings.js. Decisions are unchanged:
// a session that passes here goes through the full hook exactly as before.
//
// Pure Node built-ins, never throws (fail-open = run the full hook).
const fs = require('fs');

// inert(opts) -> true when the hook would no-op for this process.
//   opts.setting : devswarm.<setting> on/off switch (off -> inert)
//   opts.guard   : optional skip-guard name (user-consented skip -> inert)
//   opts.role    : 'primary' (default: a child workspace is inert) or 'child'
//                  (a Primary / non-DevSwarm session is inert)
function inert(opts) {
  try {
    const o = opts || {};
    try { if (!require('./settings.js').enabled('devswarm', o.setting)) return true; } catch (_) { /* run */ }
    if (o.guard && require('../skip-guard.js').isSkipped(o.guard)) return true;
    if (!require('./devswarm-detect.js').isDevswarmActive(process.env)) return true;
    const child = require('./devswarm-role.js').isChildWorkspace(process.env);
    return o.role === 'child' ? !child : child;
  } catch (_) {
    return false;
  }
}

// exitIfInert(opts): call at the very top of a hook entry file, BEFORE its heavy
// requires. Only acts when the file is the process entry point (a test that
// require()s the hook for its helpers must not be exited). Drains stdin first
// so the harness never sees a broken pipe.
function exitIfInert(entryModule, opts) {
  if (require.main !== entryModule) return;
  if (!inert(opts)) return;
  try { fs.readFileSync(0); } catch (_) { /* nothing to drain */ }
  process.exit(0);
}

module.exports = { inert, exitIfInert };
