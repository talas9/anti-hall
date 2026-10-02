'use strict';
// anti-hall :: primary-tier — the ONE gate for every injection of the DevSwarm
// PRIMARY dispatch-tier text ("the workspace is your top fan-out tier ...").
// Used by task-tracker.js (DEVSWARM_PRIMARY), verify-first.js
// (DEVSWARM_PRIMARY_NUDGE) and verify-first-orch.js (rule W).
//
// primaryTierTextOn(env, cwd) -> true only when ALL of:
//   - DevSwarm is active and this session is the root/Primary (not a child);
//   - devswarm.dispatchTierText is not off;
//   - the repo does NOT forbid workspaces for real work (dispatch-tier.js
//     noWorkspaceRepo: CLAUDE.md/AGENTS.md doctrine, or the configured repo list).
// Fail-open to FALSE on any error: the baseline text, never the tier text.
// Pure Node built-ins.

function primaryTierTextOn(env, cwd) {
  try {
    const e = env || process.env;
    const { isDevswarmActive } = require('./devswarm-detect.js');
    const { isChildWorkspace } = require('./devswarm-role.js');
    if (!isDevswarmActive(e) || isChildWorkspace(e)) return false;
    try { if (!require('./settings.js').enabled('devswarm', 'dispatchTierText')) return false; } catch (_) { /* default on */ }
    if (require('./dispatch-tier.js').noWorkspaceRepo(cwd || process.cwd())) return false;
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { primaryTierTextOn };
