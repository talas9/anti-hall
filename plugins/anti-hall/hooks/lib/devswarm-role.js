'use strict';
// anti-hall :: devswarm-role — DevSwarm TOPOLOGY gate (Primary vs child workspace).
//
// Distinct from hooks/lib/devswarm-detect.js (which answers "is the liveness
// supervisor in play here?"). This helper answers only "is THIS session a
// child workspace sub-orchestrator?" — per KB-devswarm-hivecontrol.md §"Env",
// DEVSWARM_SOURCE_BRANCH is the role signal: empty/unset = root/Primary,
// non-empty = a child workspace spawned via `hivecontrol workspace create`.
//
// Pure Node built-ins. Never throws to the caller (fail-open = false = Primary).

// isChildWorkspace(env) -> boolean. env defaults to process.env.
function isChildWorkspace(env) {
  try {
    const e = env || process.env;
    const v = e.DEVSWARM_SOURCE_BRANCH;
    return typeof v === 'string' && v.trim() !== '';
  } catch (_) {
    return false; // fail-open = Primary
  }
}

module.exports = { isChildWorkspace };
