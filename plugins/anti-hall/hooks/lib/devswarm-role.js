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

const fs = require('fs');
const path = require('path');
const os = require('os');

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

// isChildWorkspaceCorroborated(env, home, cwd) -> boolean.
//
// defect a55d6b71a76f fix (root cause C): isChildWorkspace() trusts
// DEVSWARM_SOURCE_BRANCH alone. That env var can LEAK into a Primary's shell
// (inherited from a parent process, a stale exported var, a misconfigured
// launcher) with no corroborating on-disk evidence — a Primary then gets
// gated as a child by every hook that calls isChildWorkspace() directly
// (devswarm-child-gate.js's Stop-block being the user-visible symptom).
//
// This helper requires ON-DISK evidence IN ADDITION to the env var before a
// caller treats the session as a child:
//   - a registered descriptor: devswarmRoot(home)/workspaces/<id>.json exists
//     for DEVSWARM_BUILDER_ID (anti-hall's own registry — written by
//     cmdRegister/cmdHeartbeat's auto-ensure), OR
//   - cwd sits under the REAL DevSwarm worktree layout,
//     `~/.devswarm/repos/<seq>/<hex8>/<branch>` (KB-devswarm-hivecontrol.md
//     §4 "Worktree layout" — `hivecontrol workspace create`'s own tree,
//     independent of anti-hall's registry).
// Neither on-disk signal present -> NOT corroborated (fail-open toward
// Primary, matching isChildWorkspace's own fail-open contract), even though
// the env var says child.
//
// P1 fix (gate-fix Wave 2 round-1 review): log an EACCES-on-descriptor
// warning at most ONCE per process instead of on every call.
let _loggedDescriptorEacces = false;

// Only meaningful when isChildWorkspace(env) is already true — callers should
// gate on `isChildWorkspace(env) && isChildWorkspaceCorroborated(env, home, cwd)`
// (or just call this one function, which checks the env var itself first).
// Pure fs reads; never throws; never writes.
function isChildWorkspaceCorroborated(env, home, cwd) {
  try {
    if (!isChildWorkspace(env)) return false;
    const e = env || process.env;
    const h = home || os.homedir();

    // Signal 1: a registered descriptor for this builder id.
    const id = e.DEVSWARM_BUILDER_ID;
    if (typeof id === 'string' && id.trim() !== '' && !id.includes('..') && /^[A-Za-z0-9._-]+$/.test(id)) {
      try {
        const descPath = path.join(h, '.anti-hall', 'devswarm', 'workspaces', id + '.json');
        if (fs.statSync(descPath).isFile()) return true;
      } catch (err) {
        // P1 fix: EACCES is NOT "no descriptor" (ENOENT) — a descriptor MAY
        // exist but this process cannot see it, so falling through to
        // signal 2 (and possibly returning false = "treat as Primary") would
        // fail-open on a permissions quirk, the WRONG direction for a
        // security-relevant corroboration gate. Treat EACCES as corroborated
        // (fail TOWARD gating, the safer direction here) and log once so a
        // real permissions problem is visible instead of silently degrading
        // every call for the rest of the process.
        if (err && err.code === 'EACCES') {
          if (!_loggedDescriptorEacces) {
            _loggedDescriptorEacces = true;
            try {
              process.stderr.write('[devswarm-role] EACCES reading workspace descriptor under '
                + path.join(h, '.anti-hall', 'devswarm', 'workspaces')
                + ' — treating as corroborated (fail toward gating)\n');
            } catch (_) { /* stderr unavailable — non-fatal */ }
          }
          return true;
        }
        /* ENOENT or other -> fall through to signal 2 */
      }
    }

    // Signal 2: cwd is under the real DevSwarm worktree layout.
    //
    // P1 fix: this previously read `os.homedir()` directly instead of the
    // INJECTED `h` (same `home` param signal 1 already honors) — a test or a
    // caller with a non-default HOME (or an injected `home` arg) got a
    // signal-1/signal-2 mismatch, since the two signals silently disagreed
    // about which home directory they were even checking. Also require cwd
    // to actually EXIST as a directory (a nonexistent/garbage cwd should
    // never corroborate anything), and compare REALPATHs on both sides (not
    // just path.resolve) so a symlinked home or worktree path (common on
    // macOS, e.g. /tmp -> /private/tmp) does not spuriously fail the
    // prefix check in either direction.
    const c = (typeof cwd === 'string' && cwd) ? cwd : process.cwd();
    let cwdIsDir = false;
    try { cwdIsDir = fs.statSync(c).isDirectory(); } catch (_) { cwdIsDir = false; }
    if (!cwdIsDir) return false;

    const reposRootRaw = path.join(h, '.devswarm', 'repos');
    let reposRootReal;
    try { reposRootReal = fs.realpathSync(reposRootRaw); } catch (_) { reposRootReal = path.resolve(reposRootRaw); }
    let cwdReal;
    try { cwdReal = fs.realpathSync(c); } catch (_) { cwdReal = path.resolve(c); }

    const reposRoot = reposRootReal + path.sep;
    const resolved = cwdReal + path.sep;
    if (resolved.startsWith(reposRoot)) return true;

    return false;
  } catch (_) {
    return false; // fail-open = not corroborated = treated as Primary by gates
  }
}

module.exports = { isChildWorkspace, isChildWorkspaceCorroborated };
