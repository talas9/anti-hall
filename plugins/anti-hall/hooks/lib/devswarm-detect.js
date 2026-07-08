'use strict';
// anti-hall :: devswarm-detect — DevSwarm liveness-supervisor feature gate.
//
// Workaround for claude-code#39755 (a `claude` session silently wedges — alive
// process, dead listener; no upstream headless recovery). Remove when upstream
// ships a real fix.
//
// Mirrors hooks/omc-detect.js: a pure, fail-open, dependency-free helper telling
// session-side consumers (doctor.js, any future hook) whether the DevSwarm
// liveness supervisor should be considered ACTIVE for THIS session/environment.
// Dormant unless DEVSWARM_REPO_ID is set (auto mode) — zero effect otherwise,
// byte-for-byte identical to today, exactly like omc-detect for a non-OMC session.
//
// Distinct from hooks/lib/devswarm-role.js (topology: primary vs child). This
// helper answers only "is the liveness supervisor in play here?".
//
// Gates:
//   1. Hard kill-switch: DISABLE_ANTIHALL_DEVSWARM === '1' -> false.
//   2. Mode ANTIHALL_DEVSWARM_SUPERVISOR: off -> false; on -> true; auto/unset ->
//      follow feature-detect (DEVSWARM_REPO_ID present & non-empty).
//
// Pure Node built-ins. Never throws to the caller (fail-open = false = dormant).

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// isDevswarmActive(env) -> boolean. env defaults to process.env.
function isDevswarmActive(env) {
  try {
    const e = env || process.env;
    if (e.DISABLE_ANTIHALL_DEVSWARM === '1') return false;
    const mode = String(e.ANTIHALL_DEVSWARM_SUPERVISOR || 'auto').trim().toLowerCase();
    if (mode === 'off') return false;
    if (mode === 'on') return true;
    return nonEmpty(e.DEVSWARM_REPO_ID); // auto: follow feature-detect
  } catch (_) {
    return false; // fail-open = dormant
  }
}

function detect(env) {
  const e = env || process.env;
  let repoId = null;
  try { repoId = nonEmpty(e.DEVSWARM_REPO_ID) ? e.DEVSWARM_REPO_ID : null; } catch (_) {}
  return { active: isDevswarmActive(e), repoId };
}

module.exports = { detect, isDevswarmActive };
