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

// --- Codex app-server-broker class: REPORT-ONLY, never killed ---
// app-server-broker.mjs (the openai-codex Claude Code plugin's scripts/app-server-broker.mjs)
// is NOT an MCP-protocol server — it is that plugin's own JSON-RPC broker in front of
// Codex's "app-server" backend, unix-socket based. It is deliberately excluded from
// matchesMcp() above, which is intentionally "generic, AGNOSTIC ... match the protocol,
// not any user's servers" (see file header).
//
// *** THIS CLASS IS DETECT-AND-REPORT ONLY. IT IS NEVER KILLED. *** A 2026-09-25 safety
// review found this class's detection could not be made safe enough to act on
// automatically:
//   P1: `--cwd` paths containing spaces were truncated at the first space by an earlier
//       \S+ parse, misreading an in-use broker's real cwd as gone.
//   P1: comparing the broker's raw `--cwd` argument against an owner process's cwd
//       without canonicalizing both sides misses e.g. `--cwd /tmp/proj` vs an owning
//       process's OS-reported (symlink-resolved) `/private/tmp/proj` — the same directory,
//       read as two different ones, so a live broker's owner would go undetected.
//   P2: the broker's own `codex app-server` CHILD process also matches the owner
//       signature and typically shares the broker's cwd, so "is there a live owner"
//       almost always says yes even for a genuinely abandoned broker — the class could
//       barely ever fire even when accurate, defeating its own purpose.
// The fixes below (segment-boundary path capture, realpath on both sides, excluding the
// broker's own descendants from the owner-candidate list) make DETECTION meaningfully more
// accurate, but per the review's decision this class stays detect-and-report-only for
// 0.109.0 regardless of confidence — see findAbandonedCodexBrokers's return shape below;
// main() never feeds its output into the SIGTERM/SIGKILL passes.
//
// *** PPID IS NOT EVIDENCE FOR THIS CLASS ***. Read from the plugin's own source
// (~/.claude/plugins/cache/openai-codex/codex/*/scripts/lib/broker-lifecycle.mjs:59-70):
// the broker is spawned with `detached: true` + `child.unref()` ON PURPOSE, precisely so
// it OUTLIVES the spawning tool call and is reused across a session (`ensureBrokerSession`
// re-adopts it via a broker.json state file + `waitForBrokerEndpoint`, only respawning if
// the socket is dead). That means PPID 1 is the NORMAL, EXPECTED state for a live, in-use
// broker — not proof of death. broker.json also carries no owning-session-id or owning-pid
// field to check for liveness — only the broker's OWN pid/endpoint/sessionDir — so "that
// session/pid is dead" cannot be proven from the state file, and detection instead relies
// on the two proofs below.
//
// A broker is REPORTED (never reaped) only if its script/path signature matches (below)
// AND it is OLD ENOUGH (guards.reaperCodexBrokerMinAgeS, default 1800s / 30min) AND AT
// LEAST ONE of these two INDEPENDENT proofs that its owner is gone holds:
//   (a) its --cwd directory no longer exists (the worktree was removed/archived); or
//   (b) no live `claude`/`codex` process (EXCLUDING the broker's own descendants — see P2
//       above) has a REALPATH'd cwd equal to, an ANCESTOR of, or a DESCENDANT of the
//       REALPATH'd --cwd (checked via /proc/<pid>/cwd on Linux, `lsof -a -d cwd -p <pid>
//       -Fn` on macOS/BSD — mirrors companion/lib/target-session.js's own
//       defaultRunners().cwdOf). The ancestor direction matters: a Claude session commonly
//       runs at a workspace ROOT while a broker it owns runs `--cwd` inside a git
//       submodule under that root (the real field case) — a descendant-only check would
//       have misread that live broker as abandoned. See hasLiveOwnerAtCwd for the
//       segment-boundary-safe comparison (`/a/bc` is never mistaken for a relative of
//       `/a/b`).
// Anything unresolvable (cwd can't be parsed from the cmdline, realpath fails on either
// side, the owner-process cwd lookup itself fails) -> SKIP, never reported as abandoned.
//
// Exact script-name match (not a substring anywhere in a log path/grep arg), AND the cmd
// must carry a literal `/codex/` path segment before it (the plugin's own install path,
// e.g. `.../cache/openai-codex/codex/1.0.6/scripts/app-server-broker.mjs`) — this rejects
// an unrelated project's own same-named script that happens to live outside a codex path.
const CODEX_BROKER_SCRIPT_RE = /(^|[\s/\\])app-server-broker\.mjs(\s|$)/i;
const CODEX_BROKER_PATH_RE = /[/\\]codex[/\\][^\s]*app-server-broker\.mjs(\s|$)/i;

// matchesCodexBroker(cmd) -> bool. Excludes our own reaper tooling (belt-and-suspenders;
// mcp-reaper.js never carries "app-server-broker.mjs" in its own cmdline anyway).
function matchesCodexBroker(cmd) {
  if (!cmd) return false;
  if (/mcp-reaper/i.test(cmd)) return false;
  if (!CODEX_BROKER_SCRIPT_RE.test(cmd)) return false;
  return CODEX_BROKER_PATH_RE.test(cmd);
}

// extractBrokerCwd(cmd) -> the broker's own `--cwd <path>` argument, or null if it can't
// be parsed. spawnBrokerProcess in broker-lifecycle.mjs passes --cwd as a single argv
// token, never shell-quoted, so in `ps` output a path containing a literal space is
// indistinguishable from a flag boundary by a naive \S+ capture (P1 fix: that used to
// truncate `/Users/x/My Proj` to `/Users/x/My`, misreading a live broker's cwd as gone).
// Capture is NON-GREEDY up to the next ` --<flag>` token or end of string instead, so an
// embedded space is kept as part of the path. Residual ambiguity (a path that itself
// contains the literal substring ` --` followed by a letter) is a known, accepted
// limitation of unquoted argv parsing — such a capture would stop early, but no match at
// all (or an empty capture) is always treated as unresolvable and skipped.
const CODEX_BROKER_CWD_RE = /(?:^|\s)--cwd\s+(.+?)(?=\s--[a-zA-Z]|\s*$)/;
function extractBrokerCwd(cmd) {
  if (!cmd) return null;
  const m = String(cmd).match(CODEX_BROKER_CWD_RE);
  if (!m) return null;
  const cwd = m[1].trim();
  return cwd || null; // empty capture -> ambiguous, skip
}

// A live "owner" process: the `claude` or `codex` CLI itself, matched the same
// boundary-anchored way companion/lib/target-session.js's own CLAUDE_RE does (a real
// binary invocation, e.g. `/opt/homebrew/bin/claude ...` — NOT a path that merely
// contains "claude"/"codex" as a substring, e.g. `.../.claude/plugins/.../codex/1.0.6/...`
// does not match: the char immediately before "claude" there is `.`, and the char right
// after "codex" there is `/`, so neither boundary condition is satisfied).
const OWNER_PROC_RE = /(^|[\s/\\])(claude|codex)(\s|$)/i;

// Default 30 minutes — deliberately much more conservative than the generic MCP class'
// DEFAULT floor (0): PPID carries no signal for this class (see block comment above), so
// age is one of the few remaining safety margins against a false "no owner found" report.
const DEFAULT_CODEX_BROKER_MIN_AGE_S = 1800;

// isPathAncestorOrSame(ancestor, other) -> bool. Segment-boundary-safe: `/a/b` is an
// ancestor of `/a/b/c` (next char after the prefix is path.sep), but NOT of `/a/bc`
// (next char is `c`, not a boundary) — a naive `startsWith` would wrongly match that.
function isPathAncestorOrSame(ancestor, other) {
  if (ancestor === other) return true;
  return other.startsWith(ancestor.endsWith(path.sep) ? ancestor : ancestor + path.sep);
}

// descendantsOf(procs, rootPid) -> Set<pid> of every process transitively parented by
// rootPid (rootPid itself NOT included). Mirrors companion/lib/target-session.js's own
// descendantsOf — used to exclude the broker's OWN `codex app-server` child from its
// owner-candidate list (P2 fix): that child inherits the broker's cwd and matches
// OWNER_PROC_RE too, so without this exclusion a broker would always appear "owned" by
// its own child and this class could almost never report a genuinely abandoned broker.
function descendantsOf(procs, rootPid) {
  const childrenByPpid = new Map();
  for (const p of procs || []) {
    if (!childrenByPpid.has(p.ppid)) childrenByPpid.set(p.ppid, []);
    childrenByPpid.get(p.ppid).push(p.pid);
  }
  const out = new Set();
  const stack = (childrenByPpid.get(rootPid) || []).slice();
  while (stack.length) {
    const pid = stack.pop();
    if (out.has(pid)) continue;
    out.add(pid);
    for (const c of childrenByPpid.get(pid) || []) stack.push(c);
  }
  return out;
}

// hasLiveOwnerAtCwd(brokerCwd, procs, cwdOfFn, opts?) -> bool. True if ANY live
// claude/codex process (other than one in opts.excludePids — see descendantsOf above)
// has a cwd that REALPATHs to something EQUAL TO, an ANCESTOR of, or a DESCENDANT of the
// broker's --cwd, realpath'd the same way (P1 fix: comparing raw strings misses e.g.
// `--cwd /tmp/proj` vs an owner's OS-reported `/private/tmp/proj`, the identical directory
// under two spellings). If the broker's OWN cwd can't be realpath'd (opts.realpathSync
// throws — should be rare since the caller only gets here after confirming the path
// exists) the whole check is unresolvable and this returns true (fail-soft: never treat an
// unresolvable broker as ownerless). A Claude session commonly runs at a workspace root
// while the broker it owns runs `--cwd` inside a git submodule several levels under that
// root (the real field case: broker `--cwd .../fix-roster-image-only-message/skyflutter`,
// owning session cwd `.../fix-roster-image-only-message`, an ANCESTOR, not the same dir or
// a descendant — a descendant-only check would misread that live broker as abandoned).
// Segment boundaries matter both directions: an owner at `/a/bc` never counts for a broker
// at `/a/b` (see isPathAncestorOrSame). An owner cwd of `/` or `$HOME` then blocks every
// report for every broker under it — accepted as the safe-side failure mode. Also true
// (fail-soft) if a candidate owner process exists but its cwd (or that cwd's realpath)
// could not be resolved — an unresolved candidate is treated as "might still own this
// broker", never as proof of absence.
function hasLiveOwnerAtCwd(brokerCwd, procs, cwdOfFn, opts) {
  const o = opts || {};
  const realpathSync = typeof o.realpathSync === 'function' ? o.realpathSync : fs.realpathSync;
  const excludePids = o.excludePids instanceof Set ? o.excludePids : new Set();

  let target;
  try {
    target = realpathSync(brokerCwd);
  } catch (_e) {
    return true; // can't canonicalize the broker's own cwd -> unresolvable, fail-soft
  }

  let unresolvedCandidate = false;
  for (const p of procs) {
    if (excludePids.has(p.pid)) continue; // the broker itself / its own descendants
    if (!OWNER_PROC_RE.test(p.cmd)) continue;
    let cwd;
    try {
      cwd = cwdOfFn(p.pid);
    } catch (_e) {
      cwd = null;
    }
    if (cwd == null) {
      unresolvedCandidate = true;
      continue;
    }
    let resolved;
    try {
      resolved = realpathSync(cwd);
    } catch (_e) {
      unresolvedCandidate = true; // can't canonicalize this candidate -> fail-soft
      continue;
    }
    if (isPathAncestorOrSame(resolved, target) || isPathAncestorOrSame(target, resolved)) return true;
  }
  return unresolvedCandidate; // can't rule ownership out -> fail-soft "has an owner"
}

// findAbandonedCodexBrokers(procList, opts) -> [{pid, ppid, cmd, cwd, age, reason}], a
// REPORT-ONLY list — main() never feeds this into the SIGTERM/SIGKILL passes. opts:
// { enabled, excludeRe, minAgeS, getAgesForPids(pids) -> Map<pid, ageSeconds>,
//   cwdOf(pid) -> string|null, existsSync(path) -> bool, realpathSync(path) -> string }.
// A candidate is listed only if its age is known and >= minAgeS, AND EITHER its --cwd is
// gone (reason: 'cwd-gone') OR no live claude/codex process (excluding its own
// descendants) owns that cwd (reason: 'no-live-owner'). Any unresolvable step -> skip.
function findAbandonedCodexBrokers(procList, opts) {
  const o = opts || {};
  if (!o.enabled) return [];
  const list = Array.isArray(procList) ? procList : [];
  const existsSync = typeof o.existsSync === 'function' ? o.existsSync : fs.existsSync;

  const candidates = [];
  for (const p of list) {
    if (!matchesCodexBroker(p.cmd)) continue;
    if (o.excludeRe && o.excludeRe.test(p.cmd)) continue; // user opt-out
    const brokerCwd = extractBrokerCwd(p.cmd);
    if (!brokerCwd) continue; // can't parse --cwd -> unresolvable, skip
    candidates.push({ p, brokerCwd });
  }
  if (!candidates.length) return [];

  // Age lookup, best-effort (also used in the report line, not only for gating).
  let ages = new Map();
  if (typeof o.getAgesForPids === 'function') {
    try {
      ages = o.getAgesForPids(candidates.map((c) => c.p.pid)) || new Map();
    } catch (_e) {
      ages = new Map();
    }
  }
  const minAgeS = Number.isFinite(o.minAgeS) ? o.minAgeS : DEFAULT_CODEX_BROKER_MIN_AGE_S;
  const oldEnough =
    minAgeS > 0
      ? candidates.filter((c) => {
          const age = ages.get(c.p.pid);
          return typeof age === 'number' && age >= minAgeS;
        })
      : candidates;
  if (!oldEnough.length) return [];

  const abandoned = [];
  for (const c of oldEnough) {
    const age = ages.get(c.p.pid);
    let cwdGone = false;
    try {
      cwdGone = !existsSync(c.brokerCwd);
    } catch (_e) {
      cwdGone = false; // fail-soft: an existsSync error never proves the cwd is gone
    }
    if (cwdGone) {
      abandoned.push({ pid: c.p.pid, ppid: c.p.ppid, cmd: c.p.cmd, cwd: c.brokerCwd, age, reason: 'cwd-gone' });
      continue;
    }

    if (typeof o.cwdOf !== 'function') continue; // can't check owner presence -> skip
    const excludePids = new Set([c.p.pid, ...descendantsOf(list, c.p.pid)]);
    let hasOwner;
    try {
      hasOwner = hasLiveOwnerAtCwd(c.brokerCwd, list, o.cwdOf, {
        realpathSync: o.realpathSync,
        excludePids,
      });
    } catch (_e) {
      hasOwner = true; // fail-soft: assume an owner is present -> skip
    }
    if (!hasOwner) {
      abandoned.push({ pid: c.p.pid, ppid: c.p.ppid, cmd: c.p.cmd, cwd: c.brokerCwd, age, reason: 'no-live-owner' });
    }
  }
  return abandoned;
}

// defaultCwdOf(pid) -> the live cwd of a pid, or null if it can't be determined. Mirrors
// companion/lib/target-session.js's own defaultRunners().cwdOf (Linux /proc, macOS lsof).
function defaultCwdOf(pid) {
  if (process.platform === 'linux') {
    try {
      return fs.readlinkSync('/proc/' + pid + '/cwd');
    } catch (_e) {
      return null;
    }
  }
  const r = spawnSync('lsof', ['-p', String(pid), '-a', '-d', 'cwd', '-Fn'], {
    encoding: 'utf8',
    timeout: 4000,
  });
  if (r.error || r.status !== 0 || r.signal) return null;
  const line = String(r.stdout || '')
    .split('\n')
    .find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

// formatAbandonedBrokerLogLine(b) -> the exact REPORT-ONLY log line main() writes for one
// findAbandonedCodexBrokers() candidate. Pure and exported so the report's exact format is
// unit-testable without spawning the real `node mcp-reaper.js` process.
function formatAbandonedBrokerLogLine(b) {
  const ageStr = typeof b.age === 'number' ? `${b.age}s` : 'unknown';
  return `abandoned codex broker (report-only): pid=${b.pid} age=${ageStr} cwd=${b.cwd} reason=${b.reason}`;
}

// parseGrace(envVal) -> the SIGTERM->SIGKILL grace period in seconds, from the raw
// MCP_REAP_GRACE env string. Pure and exported so the "explicit 0 must be honored, not
// swallowed by `|| 3`" contract is unit-testable with exact equality — no subprocess, no
// wall-clock measurement. (A `0 || 3` gotcha would silently triple every reap's latency.)
function parseGrace(envVal) {
  const n = Number(envVal);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

module.exports = {
  parsePs,
  isReaperParent,
  matchesMcp,
  findOrphans,
  argv0Basename,
  MCP_RE,
  REAPER_CMD_RE,
  matchesCodexBroker,
  extractBrokerCwd,
  isPathAncestorOrSame,
  descendantsOf,
  hasLiveOwnerAtCwd,
  findAbandonedCodexBrokers,
  formatAbandonedBrokerLogLine,
  defaultCwdOf,
  DEFAULT_CODEX_BROKER_MIN_AGE_S,
  parseGrace,
};

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
    // Parse grace via the exported pure parseGrace() — honors an explicit 0 (see its
    // doc comment) and is unit-tested there with exact equality, independent of this
    // subprocess's real wall-clock behavior.
    const grace = parseGrace(process.env.MCP_REAP_GRACE);
    let reaperMatch, reaperExclude, reaperCodexBroker, reaperCodexBrokerMinAgeS;
    try {
      const settingsLib = require('../hooks/lib/settings.js');
      reaperMatch = settingsLib.get('guards', 'reaperMatch');
      reaperExclude = settingsLib.get('guards', 'reaperExclude');
      reaperCodexBroker = settingsLib.get('guards', 'reaperCodexBroker');
      reaperCodexBrokerMinAgeS = settingsLib.get('guards', 'reaperCodexBrokerMinAgeS');
    } catch (_) {
      reaperMatch = process.env.ANTIHALL_REAPER_MATCH;
      reaperExclude = process.env.ANTIHALL_REAPER_EXCLUDE;
      // No settings.js -> fall back to the env knob, defaulting ON (same "opted in by
      // virtue of this script running at all" reasoning as the schema default).
      reaperCodexBroker = process.env.ANTIHALL_REAPER_CODEX_BROKER !== '0';
      const envMinAge = Number(process.env.ANTIHALL_REAPER_CODEX_BROKER_MIN_AGE_S);
      reaperCodexBrokerMinAgeS = Number.isFinite(envMinAge) ? envMinAge : DEFAULT_CODEX_BROKER_MIN_AGE_S;
    }
    const extraRe = buildExtraRe(reaperMatch);
    const excludeRe = buildExtraRe(reaperExclude);

    // Age lookup reused from hooks/session-end-mcp-reaper.js (require()-ing it has zero
    // side effects — it only runs main() under its own require.main === module guard).
    let getAgesForPids = null;
    try {
      getAgesForPids = require('../hooks/session-end-mcp-reaper.js').getAgesForPids;
    } catch (_e) {
      getAgesForPids = null; // unavailable -> codex-broker class fails-soft to "skip all"
    }

    // scanKillableOrphans() -> the generic MCP class ONLY. This is the ONLY list that
    // ever feeds the SIGTERM/SIGKILL passes below.
    function scanKillableOrphans() {
      return findOrphans(enumerate(), extraRe, excludeRe);
    }

    // scanAbandonedCodexBrokers(procs) -> the codex-broker class, REPORT-ONLY (see the
    // big comment above findAbandonedCodexBrokers). Its output is logged but is NEVER
    // passed to process.kill anywhere in this file.
    function scanAbandonedCodexBrokers(procs) {
      return findAbandonedCodexBrokers(procs, {
        enabled: !!reaperCodexBroker,
        excludeRe,
        minAgeS: reaperCodexBrokerMinAgeS,
        getAgesForPids,
        cwdOf: defaultCwdOf,
      });
    }

    const firstScanProcs = enumerate();
    const orphans = findOrphans(firstScanProcs, extraRe, excludeRe);
    const abandonedBrokers = scanAbandonedCodexBrokers(firstScanProcs);

    // Report-only output happens on EVERY run (dry-run or real, whether or not there are
    // any killable orphans) — this class is detected-and-listed, never killed.
    for (const b of abandonedBrokers) {
      logLine(logFile, formatAbandonedBrokerLogLine(b));
    }

    if (orphans.length === 0) {
      if (abandonedBrokers.length === 0) logLine(logFile, 'scan: no orphans');
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

    // SIGTERM pass — killable (generic MCP) orphans ONLY.
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
    // Codex brokers are never part of this set (report-only, see above).
    const stillOrphanPids = new Set(scanKillableOrphans().map((p) => p.pid));
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
