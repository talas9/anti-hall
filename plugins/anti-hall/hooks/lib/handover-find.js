// anti-hall :: handover-find — locate handover artifacts under
// <cwd>/.anti-hall/handovers/<date>/<session-id>/.
//
// Shared by hooks/handover-resume.js (SessionStart pointer injection),
// hooks/precompact-snapshot.js (PreCompact mechanical snapshot: names the
// newest HANDOVER*.md and writes PRECOMPACT-<n>.md beside it) and
// hooks/lib/auto-handover-text.js (the fire directive's predicted handover
// path). Those are hook SCRIPTS that run main() on load, so they can't
// require each other — this file is the one place the lookup lives.
//
// FAIL-OPEN: every function returns null / [] / a best-effort value on any
// fs error; nothing here throws. Pure Node built-ins only.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const UNKNOWN_SESSION = 'unknown-session';
const HANDOVER_FILE_RE = /^HANDOVER(?:-(\d+))?\.md$/;
const PRECOMPACT_FILE_RE = /^PRECOMPACT-(\d+)\.md$/;

// sanitizeSessionId -- reused EXACTLY from tasklist-guard.js so session-id
// comparisons line up with the directory names the handover skill (and
// tasklist-guard's own progress/history dirs) already produce.
function sanitizeSessionId(raw) {
  const safe = String(raw || '').replace(/[^A-Za-z0-9_-]/g, '');
  return safe || UNKNOWN_SESSION;
}

// localDate(d?) -> 'YYYY-MM-DD' in LOCAL time — the same "today" an agent
// gets from `date +%F` when it writes a handover by hand.
function localDate(d) {
  const t = d || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
}

// realHome() -> realpath'd os.homedir(), or the raw value when it can't be
// realpath'd (fail-open — the homedir guard below just never matches).
function realHome() {
  try { return fs.realpathSync(os.homedir()); } catch (_) { return os.homedir(); }
}

// repoRoot(cwd) -> the git toplevel of cwd via the ONE canonical resolver
// (companion/lib/identity.js's resolveContext), or cwd itself when cwd is
// missing/not-a-repo/homedir (fail-open, matches the pre-existing plain-cwd
// behavior). FIXES the PreCompact doubled-path bug: a session whose cwd was
// `<repo>/.anti-hall/handovers` used to get `<repo>/.anti-hall/handovers`
// joined onto AGAIN, writing snapshots under
// `<repo>/.anti-hall/handovers/.anti-hall/handovers/...` that
// hooks/handover-resume.js could never find (verified field bug, 2026-09-25).
// `toplevel` (not `worktreeRoot`) mirrors command-guard.js's
// hasProtectedStashesMarker: the repo actually checked out AT cwd (a
// submodule included) owns its own .anti-hall/ state, not an unrelated
// superproject's. A linked (e.g. DevSwarm child) worktree's own toplevel is
// identical to its worktreeRoot (resolveContext never climbs past a linked
// worktree that isn't itself a submodule), so this still resolves to the
// worktree's OWN root, never the main checkout's.
//
// Deliberately NO `missingPath: 'ancestor'` (coordinator safety-review P2,
// 2026-09-25): every caller of repoRoot() is a live hook whose cwd exists for
// the running session — 'ancestor' only matters once cwd itself has been
// deleted mid-session (e.g. a removed nested worktree), and for that case
// climbing to the nearest SURVIVING ancestor would resolve to an unrelated
// enclosing repo (the main checkout) and write/read this session's state
// there instead. Falling back to the raw (now-missing) cwd means the
// subsequent fs call (mkdir/read/write) simply fails and the caller's
// existing fail-open handling takes over — never a cross-repo write.
//
// Homedir guard (coordinator safety-review P2, 2026-09-25): a dotfiles repo
// checked out AT $HOME (`~/.git`) would otherwise resolve toplevel === HOME,
// sending every handover/progress/history write into
// ~/.anti-hall/{handovers,progress,history} — anti-hall's OWN global state
// directory (session state, skip.json, etc.), silently mixing per-project
// session bookkeeping into it. Falls back to the raw cwd instead, same as
// the non-git case.
function repoRoot(cwd) {
  if (typeof cwd !== 'string' || !cwd) return cwd;
  try {
    const identity = require('../../companion/lib/identity.js');
    const ctx = identity.resolveContext(cwd);
    if (ctx && ctx.toplevel && ctx.toplevel !== realHome()) return ctx.toplevel;
  } catch (_) { /* fall through to raw cwd */ }
  return cwd;
}

function handoversRoot(cwd) {
  return path.join(repoRoot(cwd), '.anti-hall', 'handovers');
}

// listDirs(p) -> array of directory names directly under p, or [] on any error.
function listDirs(p) {
  let entries;
  try {
    entries = fs.readdirSync(p, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

// collect(root, re, onlySessionId) -> [{ filePath, mtimeMs, date, sessionId, seq }]
function collect(root, re, onlySessionId) {
  const out = [];
  for (const date of listDirs(root)) {
    const datePath = path.join(root, date);
    for (const sessionId of listDirs(datePath)) {
      if (onlySessionId && sessionId !== onlySessionId) continue;
      const sessionPath = path.join(datePath, sessionId);
      let files;
      try {
        files = fs.readdirSync(sessionPath);
      } catch (_) {
        continue;
      }
      for (const fname of files) {
        const m = re.exec(fname);
        if (!m) continue;
        const filePath = path.join(sessionPath, fname);
        let st;
        try {
          st = fs.statSync(filePath);
        } catch (_) {
          continue;
        }
        if (!st.isFile()) continue;
        out.push({ filePath, mtimeMs: st.mtimeMs, date, sessionId, seq: m[1] ? parseInt(m[1], 10) : 1 });
      }
    }
  }
  return out;
}

// findNewestHandover(root, wantSessionId) -> candidate or null. Highest mtime,
// but a SAME-session candidate (continuation after clear/compact) wins over a
// merely newer file from a different session.
function findNewestHandover(root, wantSessionId) {
  const candidates = collect(root, HANDOVER_FILE_RE, null);
  if (candidates.length === 0) return null;
  let pool = candidates;
  if (wantSessionId) {
    const same = candidates.filter((c) => c.sessionId === wantSessionId);
    if (same.length > 0) pool = same;
  }
  pool.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return pool[0];
}

// collectForSession(root, re, sessionId) -> [{filePath, mtimeMs, date,
// sessionId, seq}], same shape as collect() but bounded to ONLY this
// session's own directory under each date -- it never lists (or even stats)
// any OTHER session's directory. For each date dir it goes straight to
// <date>/<sessionId>/ instead of listDirs(datePath) + a per-entry filter, so
// the cost is O(#dates) readdir calls, not O(#dates * #sessions-per-date).
function collectForSession(root, re, sessionId) {
  const out = [];
  if (!sessionId) return out;
  for (const date of listDirs(root)) {
    const sessionPath = path.join(root, date, sessionId);
    let files;
    try {
      files = fs.readdirSync(sessionPath);
    } catch (_) {
      continue; // no handover dir for this session on this date -- fine
    }
    for (const fname of files) {
      const m = re.exec(fname);
      if (!m) continue;
      const filePath = path.join(sessionPath, fname);
      let st;
      try {
        st = fs.statSync(filePath);
      } catch (_) {
        continue;
      }
      if (!st.isFile()) continue;
      out.push({ filePath, mtimeMs: st.mtimeMs, date, sessionId, seq: m[1] ? parseInt(m[1], 10) : 1 });
    }
  }
  return out;
}

// findNewestHandoverForSession(root, sessionId) -> candidate or null. Bounded
// to THIS session's own handover files only -- no cross-session fallback
// (unlike findNewestHandover, whose fallback exists for handover-resume's
// "pick up wherever the newest handover is" use case). Used by
// hooks/lib/auto-handover-gate.js's noteHandover(), which runs on EVERY
// prompt once the gate's fire arm is set and must never arm from another
// session's handover anyway (see that file's own header comment) -- a full
// collect(root, re, null) walk (every date dir x every session dir x every
// file) on every prompt is wasted work once there are many sessions/dates.
function findNewestHandoverForSession(root, sessionId) {
  const candidates = collectForSession(root, HANDOVER_FILE_RE, sessionId);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0];
}

// findNewestPrecompact(root, sessionId) -> the newest PRECOMPACT-<n>.md for
// THIS session only (a snapshot from another session is not this session's
// continuation state), or null.
function findNewestPrecompact(root, sessionId) {
  if (!sessionId) return null;
  const c = collect(root, PRECOMPACT_FILE_RE, sessionId);
  if (c.length === 0) return null;
  c.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (b.seq - a.seq));
  return c[0];
}

// nextHandoverName(sessionDir) -> 'HANDOVER.md' | 'HANDOVER-<n>.md' — the
// skill's own sequencing rule (seq = existing HANDOVER*.md count + 1).
function nextHandoverName(sessionDir) {
  let count = 0;
  try {
    count = fs.readdirSync(sessionDir).filter((f) => HANDOVER_FILE_RE.test(f)).length;
  } catch (_) {
    count = 0;
  }
  const seq = count + 1;
  return seq > 1 ? 'HANDOVER-' + seq + '.md' : 'HANDOVER.md';
}

module.exports = {
  UNKNOWN_SESSION,
  HANDOVER_FILE_RE,
  PRECOMPACT_FILE_RE,
  sanitizeSessionId,
  localDate,
  repoRoot,
  handoversRoot,
  findNewestHandover,
  findNewestHandoverForSession,
  findNewestPrecompact,
  nextHandoverName,
};
