#!/usr/bin/env node
'use strict';
// anti-hall :: SessionEnd MCP orphan sweep (in-plugin, per-session)
//
// === MEASURED FACTS (2026-09-05, three rounds of live `claude -p` probing) ===
// Round 3 used a REAL stdio MCP server under `claude -p`, sampled every 500ms:
//   - Claude Code reaps its own MCP children BEFORE its SessionEnd hooks run
//     on a clean exit — the MCP child process was gone from `ps` in 3/3 runs
//     by the time SessionEnd fired. So a hook that only looks at "this
//     session's own still-running claude process's children" (an earlier
//     version of this file did exactly that, with a detached grace child
//     waiting for that claude pid to exit) can NEVER find anything to reap on
//     a clean exit — Claude Code already did that job itself.
//   - On a hard crash (`kill -9` the claude process), SessionEnd does NOT run
//     at all, so no hook of this shape fires DURING the crash either.
//   - The only place a real MCP leak is ever observable is at the START of
//     the NEXT session (or the SessionEnd of whatever session runs after the
//     crash): the crashed session's MCP children, having lost their parent
//     with no clean-shutdown code path to reap them, are reparented to PID 1
//     by the kernel and simply sit there — mcp-reaper.js's own README already
//     documents exactly this leak class for the machine-local LaunchAgent.
// Conclusion: THIS HOOK DOES NOT (and structurally cannot) clean up its OWN
// session's MCP children — Claude Code already does that on a clean exit, and
// nothing runs on a crash. What it CAN do, and does: on every clean exit, it
// sweeps PID-1-reparented MCP-signature orphans LEFT BEHIND BY A PREVIOUS
// crashed session — the same invariant companion/mcp-reaper.js's machine-local
// LaunchAgent already uses, reused verbatim, now running once per session
// instead of only on a machine that has that LaunchAgent installed.
//
// Earlier design history (superseded, kept only as a note so this isn't
// re-invented): an earlier version snapshotted this session's own live claude
// process's direct MCP children and deferred killing them to a detached
// "grace child" that waited for that specific claude pid to exit. Round 3
// proved that path is DEAD CODE by construction (see above) — it has been
// removed entirely, along with the grace-child file and its tests.
//
// SessionEnd hook contract (see docs/KB-claude-code-hooks.md, event 33 + §6,
// now updated with the same measured facts):
//   - Read-only event: no block, no context injection — stdout/exit code are
//     BOTH ignored by the harness. The only visible effects are the NDJSON
//     audit log and any SIGTERM/SIGKILL this hook sends.
//   - Payload field is `reason` (MEASURED 2026-09-05: session_id,
//     transcript_path, cwd, prompt_id, hook_event_name, reason — NOT
//     `end_reason`, which is what the official docs page states).
//     `end_reason` is accepted only as a defensive fallback alias.
//   - ALL SessionEnd hooks share a single 1.5s time budget by default, raised
//     up to 60s if a configured per-hook timeout exceeds 1.5s (KB §3/§6).
//     hooks.json registers this hook with timeout: 5 — actual work is one
//     bounded `ps` scan, up to two small age-lookup `ps` calls, and (only if
//     candidates exist) a TERM -> <=500ms grace -> re-verify -> KILL sequence.
//
// === SAFETY INVARIANT ===
// A process is reaped ONLY IF `reason` is `prompt_input_exit`/`other` (clear/
// resume/logout -> no-op, no `ps` work at all) AND ALL of:
//   (i)   it matches companion/mcp-reaper.js's OWN `matchesMcp` signature,
//         unmodified and reused, not duplicated (its own "mcp-reaper"
//         substring exclusion means this hook's own process line can never
//         select itself);
//   (ii)  its ppid === 1 (kernel-reparented — never a live-parented process,
//         which by construction is never this hook's concern: (i)+(ii)
//         together are exactly companion/mcp-reaper.js's own orphan
//         invariant);
//   (iii) it has been alive >= ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S (default
//         60s) — computed via `ps -o etimes=` where supported (Linux) or
//         `ps -o lstart=` date-diff fallback (macOS/BSD, which does not
//         support `etimes`); an unknown age (both probes fail) -> SKIP, never
//         reaped (fail-soft toward not killing);
//   (iv)  it passes ANTIHALL_REAPER_EXCLUDE / ANTIHALL_REAPER_MATCH, honored
//         exactly as companion/mcp-reaper.js's own main() does, and the
//         built-in test-runner/dev-server denylist (vitest, jest, playwright,
//         ts-node, tsx, `next dev`, webpack) for defense against a file
//         merely NAMED *mcp-server* being misread as a real MCP process.
// Capped at ANTI_HALL_SESSION_END_REAPER_MAX (default 16). Kill-switch:
// ANTI_HALL_SESSION_END_REAPER=0 -> no-op, exit 0 immediately.
//
// === TWO ADDITIVE NARROWINGS (2026-09-05, final review round) — false
// positives for OTHER users' machines, not this maintainer's ===
//   F2 (containers): "ppid===1 means orphan" assumes PID 1 is an init/reaper
//      process. In a container, PID 1 is whatever the container's ENTRYPOINT
//      is (e.g. a Python app) — every process ppid===1 there is simply a
//      normal child of that entrypoint, NEVER an orphan. This hook therefore
//      gates the ENTIRE sweep on PID 1's own argv0/basename actually being an
//      init/reaper (`launchd`/`systemd`/`init`, reusing the basename logic
//      companion/mcp-reaper.js's own `isReaperParent` already uses) BEFORE
//      looking at any other process. If PID 1 is anything else, the sweep
//      does nothing at all (logged once as `{event:'skip', reason:
//      'pid1-not-init'}`) rather than misreading the container's own child
//      processes as leaked orphans.
//   F1 (launchd/systemd-managed services): a real MCP server can legitimately
//      be run as a macOS LaunchAgent or a Linux `systemd --user` unit — such a
//      process has ppid===1 WHILE FULLY HEALTHY (its init system is its
//      permanent parent, not a sign anything leaked), which is indistinguishable
//      from a leaked orphan by ppid alone. On darwin, this hook runs
//      `launchctl list` ONCE per sweep and skips any surviving candidate whose
//      pid appears in that output (`reason:'launchd-managed'`); if `launchctl`
//      itself fails, EVERY candidate is treated as unverifiable and skipped
//      (fail-closed — a killer must never guess). On linux, a fail-SOFT check
//      reads `/proc/<pid>/cgroup` and skips a candidate if it's readable and
//      contains `.service` (`reason:'systemd-service'`); an unreadable cgroup
//      does NOT skip (labelled here as an UNTESTED INFERENCE — this plugin was
//      built and reviewed on macOS only; there is no Linux box to measure this
//      against, so it stays deliberately fail-soft rather than fail-closed).
// Both narrowings are ADDITIVE ONLY — they can only shrink the candidate set,
// never grow it. On a machine that ALSO already runs companion/mcp-reaper.js's
// machine-local LaunchAgent, this hook's sweep is REDUNDANT with that reaper
// (both apply the identical orphan invariant) and IDEMPOTENT (an orphan
// already reaped by the LaunchAgent simply won't be in the next `ps` snapshot
// this hook takes) — running both is safe, not doubly destructive.
//
// Fail-open throughout: any error at any stage -> return with no kill, no
// throw. require()-ing this module has ZERO side effects; all I/O happens
// only inside main(), and only when actually invoked.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MCP_REAPER_MOD = path.join(__dirname, '..', 'companion', 'mcp-reaper.js');

// reason values on which this hook is permitted to act at all (MEASURED wire
// field is `reason`; KB event 33 lists the value set as clear/resume/logout/
// prompt_input_exit/other). Only the two "real termination" reasons qualify.
const ACT_REASONS = new Set(['prompt_input_exit', 'other']);

const DEFAULT_MIN_AGE_S = 60;
const DEFAULT_MAX_CANDIDATES = 16;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// Built-in exclusion for JS/TS test runners and dev servers that can
// false-positive against mcp-reaper's matchesMcp when a file/arg merely
// CONTAINS an "mcp-server"-shaped substring (e.g. a stale, still-running
// `vitest --run tests/mcp-server.test.ts` from a crashed prior session).
const RUNNER_EXCLUDE_PATTERNS = [
  /(^|[\s/\\])vitest\b/i,
  /(^|[\s/\\])jest(-worker)?\b/i,
  /(^|[\s/\\])playwright\b/i,
  /(^|[\s/\\])ts-node\b/i,
  /(^|[\s/\\])tsx\b/i,
  /(^|[\s/\\])next(-server\b|\s+dev\b)/i,
  /(^|[\s/\\])webpack(-dev-server\b|\s+serve\b)/i,
];

function isExcludedRunner(cmd) {
  if (!cmd) return false;
  return RUNNER_EXCLUDE_PATTERNS.some((re) => re.test(cmd));
}

// buildExtraRe(pattern) -> RegExp | null. Same posture as mcp-reaper.js's own
// helper (not exported there, so mirrored here rather than reached into): a
// bad/empty pattern -> null (ignored, safe), never throws.
function buildExtraRe(pattern) {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch (_e) {
    return null;
  }
}

function parseEnvInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function readStdinRaw() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_e) {
    return '';
  }
}

// extractReason(payload) -> string | null. `reason` is the MEASURED wire
// field; `end_reason` is accepted only as a defensive fallback if `reason` is
// absent.
function extractReason(payload) {
  if (payload && typeof payload.reason === 'string') return payload.reason;
  if (payload && typeof payload.end_reason === 'string') return payload.end_reason;
  return null;
}

// --- age lookup: ps -o etimes= (Linux, raw seconds) with a ps -o lstart=
// (macOS/BSD date-diff) fallback for any pid etimes could not resolve. Both
// probes are bounded to the (already capped-by-signature) candidate pid list,
// so this is at most 2 extra `ps` calls total, never one per pid. -----------

function parseEtimesOutput(stdout) {
  const out = new Map();
  if (!stdout) return out;
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (!m) continue;
    out.set(Number(m[1]), Number(m[2]));
  }
  return out;
}

function parseLstartOutput(stdout, nowMs) {
  const out = new Map();
  if (!stdout) return out;
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const d = new Date(m[2]);
    if (isNaN(d.getTime())) continue;
    const ageS = Math.floor((now - d.getTime()) / 1000);
    if (ageS < 0) continue; // clock skew -> unknown, leave absent from the map
    out.set(pid, ageS);
  }
  return out;
}

// getAgesForPids(pids, opts) -> Map<pid, ageSeconds>. A pid absent from the
// returned map has an UNKNOWN age (both probes failed for it) — the caller
// must treat that as "skip", never as "old enough".
function getAgesForPids(pids, opts) {
  const o = opts || {};
  const result = new Map();
  const list = Array.isArray(pids) ? pids : [];
  if (!list.length) return result;
  const pidArg = list.join(',');

  const etimesExec =
    o.etimesExec || (() => spawnSync('ps', ['-o', 'pid=,etimes=', '-p', pidArg], { encoding: 'utf8' }));
  let etimesMap = new Map();
  try {
    const r = etimesExec();
    if (r && !r.error && r.status === 0 && !r.signal) etimesMap = parseEtimesOutput(r.stdout);
  } catch (_e) {
    /* fall through to lstart */
  }

  const missing = list.filter((pid) => !etimesMap.has(pid));
  let lstartMap = new Map();
  if (missing.length) {
    const lstartExec =
      o.lstartExec ||
      (() => spawnSync('ps', ['-o', 'pid=,lstart=', '-p', missing.join(',')], { encoding: 'utf8' }));
    try {
      const r2 = lstartExec();
      if (r2 && !r2.error && r2.status === 0 && !r2.signal) {
        lstartMap = parseLstartOutput(r2.stdout, o.nowFn ? o.nowFn() : Date.now());
      }
    } catch (_e) {
      /* unknown for `missing` pids */
    }
  }

  for (const pid of list) {
    if (etimesMap.has(pid)) result.set(pid, etimesMap.get(pid));
    else if (lstartMap.has(pid)) result.set(pid, lstartMap.get(pid));
    // else: left absent -> unknown age -> caller skips
  }
  return result;
}

// matchesInvariant(p, mcpReaper, extraRe, excludeRe) -> bool. Steps (i),(ii),(iv)
// of the safety invariant (age is checked separately, once, up front — it only
// grows, so it is never re-checked on the post-TERM re-verify pass).
function matchesInvariant(p, mcpReaper, extraRe, excludeRe) {
  if (p.ppid !== 1) return false;
  let isMcp = false;
  try {
    isMcp = mcpReaper.matchesMcp(p.cmd, extraRe);
  } catch (_e) {
    isMcp = false;
  }
  if (!isMcp) return false;
  if (excludeRe && excludeRe.test(p.cmd)) return false;
  if (isExcludedRunner(p.cmd)) return false;
  return true;
}

// findPid1Cmd(procs) -> string | null. The cmd of the ps row with pid===1, or
// null if absent from the snapshot (should not normally happen; treated as
// "not verified as init" by the caller — fail toward doing nothing).
function findPid1Cmd(procs) {
  const p1 = (Array.isArray(procs) ? procs : []).find((p) => p.pid === 1);
  return p1 ? p1.cmd : null;
}

// isInitPid1(cmd, mcpReaper) -> bool. Reuses mcp-reaper.js's OWN argv0Basename
// (the same basename logic its isReaperParent already relies on) rather than
// duplicating basename-parsing. A container's PID 1 (its entrypoint, e.g.
// `python app.py`) fails this check; `launchd`/`systemd`/`init` pass.
function isInitPid1(cmd, mcpReaper) {
  if (!cmd) return false;
  let base = '';
  try {
    base = mcpReaper.argv0Basename(cmd);
  } catch (_e) {
    base = '';
  }
  return base === 'launchd' || base === 'systemd' || base === 'init';
}

// --- F1: launchd (darwin) / systemd-service (linux) managed-process skip ---

function parseLaunchctlListOutput(stdout) {
  const set = new Set();
  if (!stdout) return set;
  for (const line of String(stdout).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /^PID\s/i.test(trimmed)) continue; // header line
    const first = trimmed.split(/\s+/)[0];
    const pid = Number(first);
    if (Number.isFinite(pid) && pid > 0) set.add(pid);
  }
  return set;
}

// getLaunchdManagedPids(opts) -> Set<pid> | null. null means UNVERIFIABLE
// (launchctl itself failed/threw) — the caller must fail CLOSED (skip every
// candidate), since this only ever gates a KILL decision.
function getLaunchdManagedPids(opts) {
  const o = opts || {};
  const launchctlList = o.launchctlList || (() => spawnSync('launchctl', ['list'], { encoding: 'utf8' }));
  try {
    const r = launchctlList();
    if (!r || r.error || typeof r.status !== 'number' || r.status !== 0 || typeof r.stdout !== 'string') {
      return null;
    }
    return parseLaunchctlListOutput(r.stdout);
  } catch (_e) {
    return null;
  }
}

// isSystemdServicePid(pid, opts) -> bool. UNTESTED INFERENCE (no Linux box
// available to measure against — see file header): fail-SOFT, not
// fail-closed — an unreadable /proc/<pid>/cgroup must NEVER cause a skip, only
// a positive `.service` match does.
function isSystemdServicePid(pid, opts) {
  const o = opts || {};
  const readCgroup = o.readCgroup || ((p) => fs.readFileSync(`/proc/${p}/cgroup`, 'utf8'));
  try {
    const content = readCgroup(pid);
    return typeof content === 'string' && content.includes('.service');
  } catch (_e) {
    return false; // unreadable -> fail-soft, do NOT skip
  }
}

// filterManagedServices(candidates, opts) -> {kept, skipped}. `skipped`
// entries carry a `reason` for logging (`launchd-managed` / `systemd-service`
// / `launchd-unverifiable`). Platform-gated: darwin runs launchctl ONCE for
// the whole candidate list (never per-pid); linux checks each candidate's own
// cgroup file; any other platform is a no-op pass-through.
function filterManagedServices(candidates, opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return { kept: [], skipped: [] };

  if (platform === 'darwin') {
    const managed = getLaunchdManagedPids(o);
    if (managed === null) {
      return {
        kept: [],
        skipped: list.map((c) => ({ pid: c.pid, ppid: c.ppid, cmd: c.cmd, reason: 'launchd-unverifiable' })),
      };
    }
    const kept = [];
    const skipped = [];
    for (const c of list) {
      if (managed.has(c.pid)) skipped.push({ pid: c.pid, ppid: c.ppid, cmd: c.cmd, reason: 'launchd-managed' });
      else kept.push(c);
    }
    return { kept, skipped };
  }

  if (platform === 'linux') {
    const kept = [];
    const skipped = [];
    for (const c of list) {
      if (isSystemdServicePid(c.pid, o)) skipped.push({ pid: c.pid, ppid: c.ppid, cmd: c.cmd, reason: 'systemd-service' });
      else kept.push(c);
    }
    return { kept, skipped };
  }

  return { kept: list, skipped: [] };
}

// sweepOrphans(procs, mcpReaper, opts) -> [{pid, ppid, cmd}]
// The full candidate-selection pipeline: PID-1-is-init gate (F2), THEN
// signature + ppid==1 + exclude/match + runner denylist, THEN the age floor,
// THEN the launchd/systemd-managed skip (F1), THEN the cap. This is the ONE
// function every safety check in this file lives in. `opts.onManagedSkip`,
// if given, is called once per candidate removed by the F1 managed-service
// filter (used by main() to log each skip with its reason).
function sweepOrphans(procs, mcpReaper, opts) {
  const o = opts || {};
  const list = Array.isArray(procs) ? procs : [];

  // F2: never treat ppid===1 as "orphan" unless PID 1 is actually an
  // init/reaper process — in a container PID 1 is the entrypoint and every
  // one of its children is normal, not leaked.
  if (!isInitPid1(findPid1Cmd(list), mcpReaper)) return [];

  const extraRe = o.extraRe || null;
  const excludeRe = o.excludeRe || null;
  const minAgeS = typeof o.minAgeS === 'number' ? o.minAgeS : DEFAULT_MIN_AGE_S;
  const maxCandidates = typeof o.maxCandidates === 'number' ? o.maxCandidates : DEFAULT_MAX_CANDIDATES;

  const raw = list.filter((p) => matchesInvariant(p, mcpReaper, extraRe, excludeRe));
  if (!raw.length) return [];

  const ages = o.getAges ? o.getAges(raw.map((p) => p.pid)) : getAgesForPids(raw.map((p) => p.pid), o);

  const aged = raw.filter((p) => {
    const age = ages.get(p.pid);
    return typeof age === 'number' && age >= minAgeS;
  });
  if (!aged.length) return [];

  const { kept, skipped } = filterManagedServices(aged, o);
  if (typeof o.onManagedSkip === 'function') {
    for (const s of skipped) {
      try {
        o.onManagedSkip(s);
      } catch (_e) {
        /* logging must never break the sweep */
      }
    }
  }

  return kept.slice(0, maxCandidates);
}

function logLine(logFile, obj) {
  try {
    let size = 0;
    try {
      size = fs.statSync(logFile).size;
    } catch (_e) {
      size = 0; // file doesn't exist yet -> fine, write it
    }
    if (size > MAX_LOG_BYTES) return; // bounded: stop growing past 5MB, silently
    fs.appendFileSync(logFile, JSON.stringify(obj) + '\n');
  } catch (_e) {
    /* fail-soft */
  }
}

function sleepSync(ms) {
  // Block WITHOUT spawning a child process (mirrors mcp-reaper.js's sleepSync).
  try {
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, Math.max(0, ms | 0));
  } catch (_e) {
    /* SharedArrayBuffer/Atomics unavailable -> skip wait, best-effort */
  }
}

// main(opts) — opts is test-injectable: psExec, mcpReaperModPath, logDir,
// logFile, killFn, graceMs, skipSleep, stdinRaw, extraRe, excludeRe, minAgeS,
// maxCandidates, getAges/etimesExec/lstartExec/nowFn (age lookup). All
// optional; production run (require.main === module) uses zero opts and real
// ps/kill/sleep/stdin.
function main(opts) {
  const o = opts || {};
  const logDir = o.logDir || path.join(os.homedir(), '.anti-hall', 'logs');
  const logFile = o.logFile || path.join(logDir, 'session-end-reaper.log');

  try {
    if (String(process.env.ANTI_HALL_SESSION_END_REAPER) === '0') return;

    // Read + parse the SessionEnd payload the same bounded, fail-soft way
    // other hooks do: a single fs.readFileSync(0, 'utf8') wrapped in
    // try/catch. In production the harness always writes the JSON payload and
    // closes stdin before invoking the hook; a test harness must inject
    // `stdinRaw` instead of exercising the real fd 0 read.
    const raw = typeof o.stdinRaw === 'string' ? o.stdinRaw : readStdinRaw();
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch (_e) {
      return; // unreadable/missing payload -> fail-closed, no action
    }
    const reason = extractReason(payload);
    if (!reason || !ACT_REASONS.has(reason)) return; // clear/resume/logout -> no-op, no ps work

    let mcpReaper;
    try {
      mcpReaper = require(o.mcpReaperModPath || MCP_REAPER_MOD);
    } catch (_e) {
      return;
    }
    if (typeof mcpReaper.parsePs !== 'function' || typeof mcpReaper.matchesMcp !== 'function') return;

    const psExec =
      o.psExec ||
      (() =>
        spawnSync('ps', ['-axo', 'pid=,ppid=,command='], {
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        }));

    let r;
    try {
      r = psExec();
    } catch (_e) {
      return;
    }
    if (!r || r.error || r.status !== 0 || r.signal) return; // unreliable/truncated -> no-op

    let procs;
    try {
      procs = mcpReaper.parsePs(r.stdout);
    } catch (_e) {
      return;
    }
    if (!Array.isArray(procs) || !procs.length) return;

    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch (_e) {
      /* fail-soft */
    }

    // F2: gate the ENTIRE sweep on PID 1 actually being an init/reaper
    // process. In a container PID 1 is the entrypoint, not init — do NOTHING
    // (not even the age/exclude computation below) if it isn't recognized.
    const pid1Cmd = findPid1Cmd(procs);
    if (!isInitPid1(pid1Cmd, mcpReaper)) {
      logLine(logFile, { ts: new Date().toISOString(), event: 'skip', reason: 'pid1-not-init', pid1Cmd: pid1Cmd || null });
      return;
    }

    const extraRe = 'extraRe' in o ? o.extraRe : buildExtraRe(process.env.ANTIHALL_REAPER_MATCH);
    const excludeRe = 'excludeRe' in o ? o.excludeRe : buildExtraRe(process.env.ANTIHALL_REAPER_EXCLUDE);
    const minAgeS =
      typeof o.minAgeS === 'number'
        ? o.minAgeS
        : parseEnvInt(process.env.ANTI_HALL_SESSION_END_REAPER_MIN_AGE_S, DEFAULT_MIN_AGE_S);
    const maxCandidates =
      typeof o.maxCandidates === 'number'
        ? o.maxCandidates
        : parseEnvInt(process.env.ANTI_HALL_SESSION_END_REAPER_MAX, DEFAULT_MAX_CANDIDATES);

    const managedSkips = [];
    const candidates = sweepOrphans(procs, mcpReaper, {
      extraRe,
      excludeRe,
      minAgeS,
      maxCandidates,
      getAges: o.getAges,
      etimesExec: o.etimesExec,
      lstartExec: o.lstartExec,
      nowFn: o.nowFn,
      platform: o.platform,
      launchctlList: o.launchctlList,
      readCgroup: o.readCgroup,
      onManagedSkip: (s) => managedSkips.push(s),
    });

    for (const s of managedSkips) {
      logLine(logFile, { ts: new Date().toISOString(), pid: s.pid, ppid: s.ppid, cmd: s.cmd, action: 'skip', reason: s.reason });
    }

    logLine(logFile, { ts: new Date().toISOString(), event: 'scan', reason, candidates: candidates.length });

    if (!candidates.length) return;

    const killFn = o.killFn || ((pid, sig) => process.kill(pid, sig));

    for (const c of candidates) {
      logLine(logFile, { ts: new Date().toISOString(), pid: c.pid, ppid: c.ppid, cmd: c.cmd, action: 'term' });
    }
    for (const c of candidates) {
      try {
        killFn(c.pid, 'SIGTERM');
      } catch (_e) {
        /* already gone */
      }
    }

    const graceMs = typeof o.graceMs === 'number' ? o.graceMs : 500;
    if (!o.skipSleep) sleepSync(graceMs);

    // Re-verify against a FRESH scan before KILL — defends against a PID
    // being recycled into an unrelated live process during the grace window.
    // Age is NOT re-checked here (it only grows); signature/ppid==1/exclude
    // ARE re-checked so a recycled pid must independently still qualify.
    let stillPids = new Set();
    try {
      const r2 = psExec();
      if (r2 && !r2.error && r2.status === 0 && !r2.signal) {
        const procs2 = mcpReaper.parsePs(r2.stdout);
        for (const p2 of procs2) {
          if (matchesInvariant(p2, mcpReaper, extraRe, excludeRe)) stillPids.add(p2.pid);
        }
      }
    } catch (_e) {
      stillPids = new Set();
    }

    for (const c of candidates) {
      if (!stillPids.has(c.pid)) continue;
      logLine(logFile, { ts: new Date().toISOString(), pid: c.pid, ppid: c.ppid, cmd: c.cmd, action: 'kill' });
      try {
        killFn(c.pid, 'SIGKILL');
      } catch (_e) {
        /* already gone between passes */
      }
    }
  } catch (_e) {
    /* absolute fail-safe: never throw out of a SessionEnd hook */
  }
}

module.exports = {
  isExcludedRunner,
  buildExtraRe,
  extractReason,
  parseEtimesOutput,
  parseLstartOutput,
  getAgesForPids,
  matchesInvariant,
  findPid1Cmd,
  isInitPid1,
  parseLaunchctlListOutput,
  getLaunchdManagedPids,
  isSystemdServicePid,
  filterManagedServices,
  sweepOrphans,
  main,
  ACT_REASONS,
  DEFAULT_MIN_AGE_S,
  DEFAULT_MAX_CANDIDATES,
  MAX_LOG_BYTES,
};

if (require.main === module) {
  main();
  process.exit(0);
}
