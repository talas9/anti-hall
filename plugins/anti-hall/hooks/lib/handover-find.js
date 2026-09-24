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

function handoversRoot(cwd) {
  return path.join(cwd, '.anti-hall', 'handovers');
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
  handoversRoot,
  findNewestHandover,
  findNewestPrecompact,
  nextHandoverName,
};
