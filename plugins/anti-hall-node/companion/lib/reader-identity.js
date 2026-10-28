'use strict';
// anti-hall :: reader-identity — WHICH harness process is reading (mesh redesign
// Phase 2, B0). NOT wired to any caller yet (adoption is B5, co-released with
// Phase 3). Kept apart from identity.js so key-only hooks never load process-tree
// code.
//
// Decided nonce rule: the reader is the NEAREST harness ancestor, taken
// UNCONDITIONALLY — a harness is never skipped because its session cwd differs
// from the caller's (that skip is the legacy nonce-collision mechanism; the cwd
// question is identity.sessionWorktreeCoherent's separate verdict). No harness
// within MAX_PPID_HOPS -> null (headless: no per-instance reader). Codex writes no
// per-pid session record and is therefore headless (decision 3).
//
// A Claude harness hop = `<home>/.claude/sessions/<pid>.json` whose own `pid`
// equals the hop pid and which is not a stale record for a reused pid.
//
// Pure Node built-ins. Never throws.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_PPID_HOPS = 6;

// defaultPpidTable() -> Map<pid, ppid> from ONE `ps -A -o pid=,ppid=` snapshot, or null.
function defaultPpidTable() {
  try {
    const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 });
    if (!r || r.error || r.status !== 0) return null;
    const m = new Map();
    for (const line of String(r.stdout || '').split('\n')) {
      const p = line.trim().split(/\s+/);
      if (p.length === 2 && /^\d+$/.test(p[0]) && /^\d+$/.test(p[1])) m.set(Number(p[0]), Number(p[1]));
    }
    return m;
  } catch (_) { return null; }
}

// harnessAncestor({ home, pid, ppidOf, fs, kill }) -> { pid, startMs, harness, sessionId, cwd } | null
function harnessAncestor(opts) {
  const o = opts || {};
  const F = o.fs || fs;
  if (!o.home) return null;
  const sessDir = path.join(String(o.home), '.claude', 'sessions');
  let ppidOf = typeof o.ppidOf === 'function' ? o.ppidOf : null;
  if (!ppidOf) {
    let table;
    ppidOf = (pid) => {
      if (table === undefined) table = defaultPpidTable();
      return table ? table.get(pid) : null;
    };
  }
  let pidIsAlive = null;
  try { pidIsAlive = require('./liveness.js').pidIsAlive; } catch (_) { pidIsAlive = null; }
  let pid = Number.isInteger(o.pid) && o.pid > 0 ? o.pid : process.pid;
  const seen = new Set();
  try {
    for (let hop = 0; hop <= MAX_PPID_HOPS; hop++) {
      if (!Number.isInteger(pid) || pid <= 1 || seen.has(pid)) return null;
      seen.add(pid);
      const file = path.join(sessDir, String(pid) + '.json');
      let rec = null;
      try { rec = JSON.parse(F.readFileSync(file, 'utf8')); } catch (_) { rec = null; }
      if (rec && typeof rec === 'object' && rec.pid === pid) {
        let sinceMs = null;
        try { const st = F.statSync(file); sinceMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : null; } catch (_) { sinceMs = null; }
        const alive = pidIsAlive ? pidIsAlive(pid, o.kill, Number.isFinite(sinceMs) ? { sinceMs, ps: o.ps } : undefined) : null;
        if (alive !== false) {
          // startedAt (epoch ms) is written by the harness; procStart is a display string.
          const startMs = Number.isFinite(rec.startedAt) ? rec.startedAt : (Number.isFinite(sinceMs) ? sinceMs : 0);
          return {
            pid, startMs, harness: 'claude',
            sessionId: rec.sessionId != null ? String(rec.sessionId) : null,
            cwd: rec.cwd != null ? String(rec.cwd) : null,
          };
        }
        // stale record for a reused pid: not a harness, keep climbing.
      }
      let next = null;
      try { next = ppidOf(pid); } catch (_) { next = null; }
      pid = next;
    }
  } catch (_) { return null; }
  return null;
}

// deriveReaderNonce(opts) -> 'h:<pid>:<startMs>' for the nearest harness ancestor, or null (headless).
function deriveReaderNonce(opts) {
  const h = harnessAncestor(opts);
  return h ? `h:${h.pid}:${h.startMs}` : null;
}

module.exports = { harnessAncestor, deriveReaderNonce, MAX_PPID_HOPS };
