'use strict';
// Host-aware wording for guard block text. Claude strings stay in the guards
// byte-for-byte; a Codex session (isCodexPayload: turn_id+model, or the
// apply_patch tool) gets Codex vocabulary instead. Verified Codex facts only:
// the sub-agent tool is `spawn_agent` (codex-rs hook_runtime, see
// coordinator-detect.js) and the cheap tier is the fast-tier model (docs/KB-gpt-5.6.md).
// Codex has no per-session scratchpad dir and its Bash payload carries no
// run_in_background flag, so the scratchpad-script path is never offered there.
function isCodex(payload) {
  try { return require('../coordinator-detect.js').isCodexPayload(payload); } catch (_) { return false; }
}

const CODEX_SUBAGENT = 'a sub-agent (spawn_agent)';
const CODEX_CHEAP = 'a sub-agent (spawn_agent, fast-tier model)';

module.exports = { isCodex, CODEX_SUBAGENT, CODEX_CHEAP };
