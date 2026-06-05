#!/usr/bin/env node
'use strict';
// anti-hall :: mcp-reaper (OPT-IN background reaper — macOS + Linux)
//
// Kills ORPHANED MCP-server processes that leaked when their spawner (a Claude /
// codex / npm / node session) exited without cleaning them up. On macOS there is
// no PR_SET_PDEATHSIG, so abandoned MCP children reparent to a reaper/init process
// and run forever, accumulating over a workday.
//
// === SAFETY INVARIANT (the heart) ===
// A process is reaped ONLY IF: (a) its command matches a generic MCP signature,
// AND (b) its PARENT is a reaper/init process (launchd / systemd --user / Relay / pid 1).
// On Unix an exited parent's children are ALWAYS reparented to init, so a SESSION-LEAKED
// MCP — one whose ORDINARY spawner (a Claude/codex/npm/node process) has died — is
// reliably distinguished from one still owned by a live spawner: a live spawner is never
// init. For that target case (the one this tool exists for) a false-positive kill is
// prevented by construction. Being too NARROW (missing an orphan) is safe; being too
// BROAD (killing a live one) is the only danger.
//
// KNOWN LIMITATION (NOT "impossible by construction"): an MCP that is INTENTIONALLY
// service-managed — run as a macOS LaunchAgent, a `systemd --user` unit, or any other
// init/launchd-managed service — is parented to init/launchd/systemd-user WHILE ALIVE,
// which is INDISTINGUISHABLE from a dead orphan by parent alone. Such a process CAN be
// reaped. It is the user's responsibility to exclude it via ANTIHALL_REAPER_EXCLUDE
// (a regex of cmd substrings that are never reaped). See companion/README.md.
//
// Windows is a documented no-op: parent-death reparenting does not exist and PID
// recycling makes external orphan detection unsafe.
//
// Fail-safe: never throws out. require()-ing this module has ZERO side effects;
// process enumeration and killing happen only when run as `node mcp-reaper.js`.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// --- generic, AGNOSTIC MCP signature (match the protocol, not any user's servers) ---
// Tightened: only match REAL MCP command tokens, never substrings inside filenames,
// log paths, or grep/editor args that merely MENTION mcp. False negatives (a missed
// orphan) are safe; false positives (killing a live MCP) are the only danger.
//
// Known runtime executables that legitimately launch MCP servers (argv0 basename).
// (uv/uvx are the uv-based launchers for Python MCP servers, e.g. `uvx mcp-server-fetch`.)
const RUNTIME_RE = /^(node|nodejs|npx|npm|pnpm|yarn|deno|bun|python|python3|uvx|uv)$/;
// @modelcontextprotocol package scope is extremely specific → always a strong match.
const MODELCTX_RE = /@?modelcontextprotocol\b/i;
// A space- or path-bounded mcp[-_]server / server-sequential-thinking token. Anchored so
// `build-mcp-server` (no boundary before mcp) does NOT match. The `[-_]` form also
// matches the Python module spelling (`python -m mcp_server_time`, `mcp_server_fetch`).
const MCP_TOKEN_RE = /(^|[\s/])(mcp[-_]server|server-sequential-thinking)/i;
// `mcp start` as a discrete command token (boundary on both sides, not "start.md").
const MCP_START_RE = /(^|\s)mcp\s+start(\s|$)/i;

// Kept for backward-compat export; not used directly by matchesMcp anymore.
const MCP_RE = MODELCTX_RE;

// reaper/init parent: pid 1, OR a launchd/init (argv0 basename) / systemd --user / Relay.
// NOTE: matching is done in isReaperParent against the argv0 BASENAME, not a substring
// anywhere in the cmdline. This regex is retained only as an exported constant.
const REAPER_CMD_RE =
  /(^|\/)launchd\b|(^|\/)init\b|\bsystemd\s+--user\b|(^|\/)systemd\s.*--user|\bRelay\(/;

function buildExtraRe(extra) {
  if (!extra) return null;
  try {
    return new RegExp(extra, 'i');
  } catch (_e) {
    return null; // bad override → ignore (safe)
  }
}

// parsePs(stdout) -> [{pid, ppid, cmd}]  (from `ps -axo pid=,ppid=,command=`)
function parsePs(stdout) {
  const out = [];
  if (!stdout) return out;
  const lines = String(stdout).split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
  }
  return out;
}

// argv0Basename(cmd) -> basename of the first whitespace-delimited token, or ''.
function argv0Basename(cmd) {
  if (!cmd) return '';
  const argv0 = String(cmd).trim().split(/\s+/)[0] || '';
  return argv0.replace(/^.*\//, '');
}

// matchesMcp(cmd, extraRe?) -> bool. Excludes our own reaper tooling.
// Only returns true for a REAL MCP command, never a mere mention of "mcp" inside a
// filename, log path, or an editor/grep argument.
function matchesMcp(cmd, extraRe) {
  if (!cmd) return false;
  if (/mcp-reaper/i.test(cmd)) return false; // never match ourselves / the matcher

  // 1) @modelcontextprotocol package scope — extremely specific, always a match.
  if (MODELCTX_RE.test(cmd)) return true;

  const base = argv0Basename(cmd);
  const runtimeArgv0 = RUNTIME_RE.test(base);

  // 2) mcp-server / server-sequential-thinking token, boundary-anchored.
  //    Accept only when argv0 is a known runtime (node mcp-server.js) OR the matched
  //    token itself is argv0 (e.g. `mcp-server-everything`). This rejects
  //    `vim mcp-server.js`, `tail -f mcp-server.log`, `grep mcp-server ...`, `less ...`.
  if (MCP_TOKEN_RE.test(cmd)) {
    const tokenIsArgv0 =
      /^(mcp[-_]server|server-sequential-thinking)/i.test(base);
    if (runtimeArgv0 || tokenIsArgv0) return true;
  }

  // 3) `mcp start` as a discrete command, only under a known runtime argv0 (or `mcp`
  //    itself as argv0). Rejects `less ~/notes/mcp start.md`.
  if (MCP_START_RE.test(cmd) && (runtimeArgv0 || base === 'mcp')) return true;

  // (Intentionally NO bare `mcp ... --stdio` rule — that matched `python train.py
  //  --mcp --stdio`. --stdio is only a signal alongside a real mcp package/server,
  //  which is already covered above.)

  if (extraRe && extraRe.test(cmd)) return true;
  return false;
}

// isReaperParent(parentPid, parentCmd) -> bool. Conservative: unsure → false (skip).
// CRITICAL: classification is anchored to the parent's EXECUTABLE BASENAME (argv0),
// not a substring match anywhere in the cmdline. Otherwise a LIVE spawner like
// `node /opt/app/scripts/init.js` would be misread as a reaper and its MCP child
// killed. pid 1 is always a reaper regardless of cmd.
function isReaperParent(parentPid, parentCmd) {
  if (Number(parentPid) === 1) return true;
  if (!parentCmd) return false;

  // WSL relay shows up as a display name like `Relay(123)` — not a basename; full-cmd test.
  if (/\bRelay\(/.test(parentCmd)) return true;

  const base = argv0Basename(parentCmd);
  if (base === 'launchd') return true;
  // NOTE: no `base === 'init'` branch. Real SysV init is ALWAYS pid 1 (handled by the
  // Number(parentPid) === 1 short-circuit above), so matching the basename `init`
  // would only ever flag a LIVE custom daemon argv0-named `init` (e.g. `/opt/init`)
  // as a reaper and wrongly kill its MCP child. Dropping it loses zero real orphans.
  // `systemd --user` is a Linux per-user subreaper (system-wide systemd is pid 1,
  // already covered above). Require the --user flag token.
  if (base === 'systemd' && /(^|\s)--user(\s|$)/.test(parentCmd)) return true;

  return false;
}

// findOrphans(procList, extraRe?, excludeRe?) -> orphans. Applies the invariant.
// excludeRe is an opt-out safety valve (ANTIHALL_REAPER_EXCLUDE): any process whose
// cmd matches it is SKIPPED (never an orphan) even if it otherwise qualifies — used to
// protect service-managed MCPs (LaunchAgent / `systemd --user` units) that share init
// as a parent and are otherwise indistinguishable from a leaked orphan.
function findOrphans(procList, extraRe, excludeRe) {
  const list = Array.isArray(procList) ? procList : [];
  const byPid = new Map();
  for (const p of list) byPid.set(p.pid, p);
  const orphans = [];
  for (const p of list) {
    if (!matchesMcp(p.cmd, extraRe)) continue;
    if (excludeRe && excludeRe.test(p.cmd)) continue; // user opt-out: never reap
    // ppid===1 is provably the kernel reaper-of-last-resort. It need not appear in the
    // snapshot to be trusted, and no LIVE spawner can have pid 1 — so this is always a
    // true orphan. Handle it before the missing-parent guard below.
    if (Number(p.ppid) === 1) {
      orphans.push(p);
      continue;
    }
    const parent = byPid.get(p.ppid);
    // If the (non-pid-1) parent is NOT in the list we are UNSURE — the ps snapshot is
    // non-atomic and can be truncated, so an absent parent line does NOT prove the
    // parent died. Unsure → skip (default FALSE). A genuinely reparented orphan has its
    // ppid rewritten to 1/reaper and is still caught (the pid-1 case above, or the
    // reaper-basename branch), so this loses no real orphans while preventing a
    // live-MCP kill on a snapshot race.
    if (!parent) continue;
    const parentIsReaper = isReaperParent(p.ppid, parent.cmd);
    if (parentIsReaper) orphans.push(p);
  }
  return orphans;
}

module.exports = { parsePs, isReaperParent, matchesMcp, findOrphans, argv0Basename, MCP_RE, REAPER_CMD_RE };

// ---------------------------------------------------------------------------
// Run section — only when executed directly. Wrapped fail-safe; never throws.
// ---------------------------------------------------------------------------
function enumerate() {
  const r = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return [];
  // Guard against a SILENTLY TRUNCATED scan. spawnSync sets r.signal (e.g. 'SIGTERM')
  // when output exceeded maxBuffer. A truncated proc list could be missing a live
  // parent line and cause a false-positive kill — so treat any such scan as unreliable
  // and return [] (no kills). Fail-open: skipping a scan never kills a live MCP.
  if (r.signal) return [];
  return parsePs(r.stdout);
}

function logLine(logFile, msg) {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
  } catch (_e) {
    /* fail-safe */
  }
}

function sleepSync(ms) {
  // Block WITHOUT spawning any child process — an anti-orphan tool must not itself
  // spawn node workers. Atomics.wait on a throwaway SharedArrayBuffer (Node >= 18).
  try {
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, Math.max(0, ms | 0));
  } catch (_e) {
    /* SharedArrayBuffer/Atomics unavailable → skip the wait (best-effort) */
  }
}

function main() {
  try {
    const logDir = path.join(os.homedir(), '.anti-hall');
    const logFile = path.join(logDir, 'mcp-reaper.log');

    if (process.platform === 'win32') {
      process.stdout.write(
        'anti-hall mcp-reaper: Windows is unsupported (no parent-death reparenting ' +
          '+ PID recycling make external orphan detection unsafe). No-op. Exit 0.\n'
      );
      process.exit(0);
      return;
    }

    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch (_e) {
      /* fail-safe */
    }

    const dryRun = process.env.MCP_REAP_DRYRUN === '1';
    // Parse grace; honor an explicit 0 (don't let `|| 3` swallow it). Finite & >= 0 wins.
    const graceParsed = Number(process.env.MCP_REAP_GRACE);
    const grace = Number.isFinite(graceParsed) && graceParsed >= 0 ? graceParsed : 3;
    const extraRe = buildExtraRe(process.env.ANTIHALL_REAPER_MATCH);
    const excludeRe = buildExtraRe(process.env.ANTIHALL_REAPER_EXCLUDE);

    const procs = enumerate();
    const orphans = findOrphans(procs, extraRe, excludeRe);

    if (orphans.length === 0) {
      logLine(logFile, 'scan: no orphans');
      process.exit(0);
      return;
    }

    if (dryRun) {
      for (const o of orphans) {
        logLine(logFile, `DRYRUN would reap pid=${o.pid} ppid=${o.ppid} cmd=${o.cmd}`);
      }
      process.exit(0);
      return;
    }

    // SIGTERM pass
    for (const o of orphans) {
      try {
        process.kill(o.pid, 'SIGTERM');
        logLine(logFile, `SIGTERM pid=${o.pid} ppid=${o.ppid} cmd=${o.cmd}`);
      } catch (_e) {
        /* already gone */
      }
    }

    // grace
    sleepSync(grace * 1000);

    // SIGKILL survivors. Re-enumerate and RE-APPLY THE FULL INVARIANT on fresh data,
    // then kill only PIDs that are STILL orphans — defends against the (unlikely) case
    // of an orphan PID being recycled into a live process during the grace window.
    const stillOrphanPids = new Set(findOrphans(enumerate(), extraRe, excludeRe).map((p) => p.pid));
    for (const o of orphans) {
      if (!stillOrphanPids.has(o.pid)) continue;
      try {
        process.kill(o.pid, 'SIGKILL');
        logLine(logFile, `SIGKILL pid=${o.pid} cmd=${o.cmd}`);
      } catch (_e) {
        /* gone between passes */
      }
    }

    process.exit(0);
  } catch (_e) {
    // Absolute fail-safe: never throw out of the reaper.
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}
