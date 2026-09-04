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

// hasOnDiskDevswarmState(home, repoKey, io) -> boolean. On-disk-evidence
// FALLBACK for isDevswarmActive's env-based fast path (defect 088494cc3d3b):
// nothing in this plugin sets DEVSWARM_REPO_ID for a Primary's own process —
// it is a per-SESSION var set externally by the DevSwarm spawn path
// (companion/devswarm-supervisor.js) — so a Primary launched any other way
// never gets it and isDevswarmActive(env) alone stays false forever for that
// session, even though it is a genuine DevSwarm parent.
//
// Mirrors companion/lib/devswarm-wake-watch.js's isDevswarmActiveGate tier
// (d) byte-for-byte in spirit: a summaries/<repoKey>.json file exists ONLY
// when a real deriveSummary call (cmdSend / the ingest daemon; see
// companion/lib/devswarm-store.js's summaryPathForHash, the SAME file
// devswarm-wake-watch.js's readPrimarySnapshot reads) has already written
// state for this exact repo. Its presence is positive, non-spoofable
// evidence — a plain git repo with no DevSwarm activity at all never has this
// file, so this deliberately does NOT arm on a bare git repo with zero
// DevSwarm history (only a stat that resolves is treated as evidence, an
// absent/unreadable file is not, and any exception fails to false —
// "no evidence" — never true).
//
// Cheap by construction: ONE fs.existsSync (a stat), never a directory walk
// or a process spawn. Callers are expected to have ALREADY resolved repoKey
// (which itself spawns git via gitCommonDir) for their own purposes — this
// function performs no repo-key resolution itself, so it adds exactly one
// stat to whatever the caller was already going to do.
function hasOnDiskDevswarmState(home, repoKey, io) {
  try {
    if (typeof repoKey !== 'string' || !repoKey) return false;
    if (typeof home !== 'string' || !home) return false;
    const ioo = io || {};
    const F = ioo.fs || require('fs');
    const store = ioo.store || require('../../companion/lib/devswarm-store.js');
    return !!F.existsSync(store.summaryPathForHash(home, repoKey));
  } catch (_) {
    return false; // fail toward "no evidence" — never falsely arm on an error
  }
}

module.exports = { detect, isDevswarmActive, hasOnDiskDevswarmState };
