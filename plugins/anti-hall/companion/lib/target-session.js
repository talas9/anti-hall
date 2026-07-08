'use strict';
// anti-hall :: target-session — map a DevSwarm worktree + its published sessionId
// to the ONE live HEADLESS `claude` pid, or ABSTAIN. Workaround for
// claude-code#39755.
//
// SAFETY: the confirm-gate is the single most important property here. A survivor
// must satisfy ALL of: (1) cwd == worktreePath, (2) argv uuid == descriptor
// sessionId (identity-binding), (3) argv is HEADLESS (-p/--print — orchestrated
// children are headless; a human takeover is interactive and must NOT be killed),
// (4) not the supervisor's own pid nor any descendant of it. THEN exactly one
// survivor must remain, else ABSTAIN. Live counter-examples that MUST abstain: a
// stale bootstrap wrapper `sh -c 'claude -p --resume <uuid>'` sharing cwd + uuid
// (>1 candidate), and a lone INTERACTIVE `claude --resume <uuid>` (a person
// rescuing the worktree). The candidate FILTER stays inclusive; correctness comes
// from the gate, not a clever filter.
//
// Pure Node built-ins. All process/fs access goes through INJECTABLE runners so
// unit tests never touch real processes. Never throws (any error -> abstain).

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

// Bounded timeout for every external probe (ps/lsof): a hung probe must never
// block the whole synchronous sweep. A timed-out probe yields NO data => abstain.
const PROBE_TIMEOUT_MS = 4000;

// UUID v4-ish (Claude session ids), case-insensitive.
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const SESSION_ARG_RE = new RegExp('(?:--session-id|--resume)\\s+(' + UUID + ')');
const CLAUDE_RE = /(^|[\s/])claude(\s|$)/i;
// Headless flag: `-p` or `--print` as a standalone token anywhere in the argv.
const HEADLESS_RE = /(^|\s)(-p|--print)(\s|=|$)/;

// encodeWorktreePath(p) -> Claude projects dir segment. LOSSY, FORWARD-ONLY:
// replace every '/' AND every '.' with '-'. Never decode back.
function encodeWorktreePath(worktreePath) {
  return String(worktreePath).replace(/[/.]/g, '-');
}

// projectDirFor(worktreePath, home) -> ~/.claude/projects/<encoded>.
function projectDirFor(worktreePath, home) {
  return path.join(home || os.homedir(), '.claude', 'projects', encodeWorktreePath(worktreePath));
}

// parseSessionArg(cmd) -> uuid | null (from --session-id/--resume <uuid> ONLY).
function parseSessionArg(cmd) {
  if (!cmd) return null;
  const m = String(cmd).match(SESSION_ARG_RE);
  return m ? m[1] : null;
}

// isHeadless(cmd) -> bool. True iff the argv carries -p/--print. An orchestrated
// child is headless; an interactive human takeover is NOT (and is never targeted).
function isHeadless(cmd) {
  return HEADLESS_RE.test(String(cmd || ''));
}

// parsePs(stdout) -> [{pid, ppid, cmd}] from `ps -axo pid=,ppid=,command=`.
function parsePs(stdout) {
  const out = [];
  if (!stdout) return out;
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
  }
  return out;
}

// candidatesFromPs(procs) -> [{pid, ppid, cmd, uuid, headless}] — a `claude`
// invocation carrying a --session-id/--resume <uuid>. INTENTIONALLY inclusive
// (matches shell wrappers too): correctness comes from the confirm-gate.
function candidatesFromPs(procs) {
  const out = [];
  for (const p of procs || []) {
    if (!CLAUDE_RE.test(p.cmd)) continue;
    const uuid = parseSessionArg(p.cmd);
    if (!uuid) continue;
    out.push({ pid: p.pid, ppid: p.ppid, cmd: p.cmd, uuid, headless: isHeadless(p.cmd) });
  }
  return out;
}

// descendantsOf(procs, rootPid) -> Set<pid> of every process transitively parented
// by rootPid (used for supervisor self-tree exclusion). rootPid itself is NOT
// included (the caller excludes it separately).
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

// survivorsFor(...) — the shared confirm-gate filter. Returns { survivors,
// interactiveMatched } where a survivor passed ALL four conditions and
// interactiveMatched flags an identity+cwd+transcript match that was rejected
// ONLY for being interactive (so findTarget can abstain with a precise reason).
function survivorsFor(procs, worktreePath, projectDir, sessionId, runners, selfPid) {
  const raw = candidatesFromPs(procs);
  const excluded = descendantsOf(procs, selfPid);
  excluded.add(selfPid);
  const survivors = [];
  let interactiveMatched = false;
  for (const c of raw) {
    if (excluded.has(c.pid)) continue;                                       // self / self-tree
    if (c.uuid !== sessionId) continue;                                      // identity-binding
    const cwd = runners.cwdOf(c.pid);
    if (!cwd || path.resolve(cwd) !== path.resolve(worktreePath)) continue;  // cwd confirm-gate
    if (!runners.transcriptExists(projectDir, c.uuid)) continue;             // transcript cross-check
    if (!c.headless) { interactiveMatched = true; continue; }                // human takeover -> never kill
    survivors.push(c);
  }
  return { survivors, interactiveMatched };
}

// findTarget({worktreePath, sessionId, home, runners, selfPid}) ->
//   { pid, uuid, worktreePath }             (exactly one confirmed)
//   { ambiguous: true, reason, candidates } (0 / >1 / interactive-only / no
//                                            sessionId -> ABSTAIN)
function findTarget(opts) {
  try {
    const worktreePath = opts && opts.worktreePath;
    const sessionId = opts && opts.sessionId;
    const home = (opts && opts.home) || os.homedir();
    const runners = (opts && opts.runners) || defaultRunners();
    const selfPid = (opts && Number.isFinite(opts.selfPid)) ? opts.selfPid : process.pid;
    if (!worktreePath) return { ambiguous: true, reason: 'no-worktree-path', candidates: [] };
    if (!sessionId) return { ambiguous: true, reason: 'no-session-id', candidates: [] };

    const projectDir = projectDirFor(worktreePath, home);
    const procs = parsePs(runners.ps());
    const { survivors, interactiveMatched } = survivorsFor(procs, worktreePath, projectDir, sessionId, runners, selfPid);

    if (survivors.length !== 1) {
      let reason;
      if (survivors.length > 1) reason = 'multiple-candidates';
      else if (interactiveMatched) reason = 'interactive-candidate';
      else reason = 'no-candidate';
      return { ambiguous: true, reason, candidates: survivors };
    }
    const s = survivors[0];
    return { pid: s.pid, uuid: s.uuid, worktreePath };
  } catch (_) {
    return { ambiguous: true, reason: 'error', candidates: [] };
  }
}

// verifyTarget({worktreePath, sessionId, home, runners, selfPid, pid, uuid}) ->
// bool. Re-derives on FRESH data and returns true iff findTarget still confirms
// the SAME pid + uuid. The recovery engine calls this immediately before EACH
// signal (SIGTERM, SIGKILL) so a pid recycled during the grace window is never
// killed (mirrors mcp-reaper's re-enumerate-before-SIGKILL invariant).
function verifyTarget(opts) {
  try {
    const r = findTarget(opts);
    return !r.ambiguous && r.pid === opts.pid && r.uuid === opts.uuid;
  } catch (_) {
    return false;
  }
}

// defaultRunners() — real ps / lsof //proc / fs, each behind PROBE_TIMEOUT_MS.
// macOS uses `lsof -Fn`, Linux reads /proc/<pid>/cwd. A failed OR timed-out
// enumeration returns '' / null (=> no candidates => abstain), never a partial or
// truncated list that could mislead the gate.
function defaultRunners() {
  return {
    ps() {
      const r = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: PROBE_TIMEOUT_MS });
      if (r.error || r.status !== 0 || r.signal) return ''; // r.signal set when killed on timeout
      return r.stdout || '';
    },
    cwdOf(pid) {
      if (process.platform === 'linux') {
        try { return fs.readlinkSync('/proc/' + pid + '/cwd'); } catch (_) { return null; }
      }
      const r = spawnSync('lsof', ['-p', String(pid), '-a', '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
      if (r.error || r.status !== 0 || r.signal) return null; // r.signal set when killed on timeout
      const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('n'));
      return line ? line.slice(1) : null;
    },
    transcriptExists(dir, uuid) {
      try { return fs.existsSync(path.join(dir, uuid + '.jsonl')); } catch (_) { return false; }
    },
  };
}

module.exports = {
  PROBE_TIMEOUT_MS,
  encodeWorktreePath, projectDirFor, parseSessionArg, isHeadless, parsePs,
  candidatesFromPs, descendantsOf, findTarget, verifyTarget, defaultRunners,
};
