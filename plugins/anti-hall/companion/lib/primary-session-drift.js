'use strict';
// anti-hall :: primary-session-drift — detect a Primary anchor whose recorded
// session is not the newest Claude Code session on its worktree (v0.108.0).
//
// WHY: the Primary anchor (register-primary's `primary-<hash>` row) records a
// sessionId. After a /clear the live session changes (new transcript) but the
// anchor kept the old id, so a DevSwarm restart resumed the OLD session — the
// one that no longer owns the live lanes. The anchor is now refreshed on the
// running session's register/heartbeat; this module is the READ-ONLY detector
// for the residue: "a newer session exists on this worktree".
//
// Evidence: <home>/.claude/projects/<encoded worktree>/*.jsonl (top level only),
// each transcript's `cwd` must be the worktree (or below it) — the directory
// encoding is lossy, so the cwd check is what proves the transcript is ours.
// "Newer" = started later: the transcript's first `timestamp`, else its birth
// time. Never writes, never throws. Pure Node built-ins.

const fs = require('fs');
const path = require('path');

const HEAD_BYTES = 64 * 1024;
const MAX_SCAN = 25;
const SID_RE = /^[A-Za-z0-9._-]+$/;

function projectDirFor(worktree, home) {
  return path.join(String(home), '.claude', 'projects', String(worktree).replace(/[/\\:.]/g, '-'));
}

function readHead(file, F) {
  let fd = null;
  try {
    fd = F.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = F.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.slice(0, n).toString('utf8');
  } catch (_) { return ''; } finally { try { if (fd != null) F.closeSync(fd); } catch (_) {} }
}

// transcriptInfo(file) -> { cwd, startMs } from the transcript head.
function transcriptInfo(file, F) {
  const head = readHead(file, F);
  const cwdM = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
  const tsM = /"timestamp"\s*:\s*"([^"]+)"/.exec(head);
  let cwd = null;
  try { cwd = cwdM ? JSON.parse('"' + cwdM[1] + '"') : null; } catch (_) { cwd = null; }
  let startMs = tsM ? Date.parse(tsM[1]) : NaN;
  if (!Number.isFinite(startMs)) {
    try { const st = F.statSync(file); startMs = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs; } catch (_) { startMs = NaN; }
  }
  return { cwd, startMs: Number.isFinite(startMs) ? startMs : null };
}

// sessionsForWorktree(worktree, { home, fs }) ->
//   [{ sessionId, startMs, lastActivityMs }] ordered by LAST ACTIVITY, newest
//   first. P2 fix: "newest" used to mean "started first" (transcriptInfo's
//   `startMs`, the transcript's FIRST timestamp) — three sessions started
//   within 90s could then rank an abandoned one (no writes since) "newer"
//   than the one still live and being actively written to. `lastActivityMs`
//   is the transcript file's own mtime (already collected below, `m`, to
//   bound the MAX_SCAN window) — it advances on every turn appended to the
//   transcript, so it tracks real recency instead of session-start order.
function sessionsForWorktree(worktree, opts) {
  const o = opts || {};
  const F = o.fs || fs;
  if (!worktree || !o.home) return [];
  const dir = projectDirFor(worktree, o.home);
  let names = [];
  try { names = F.readdirSync(dir); } catch (_) { return []; }
  const wt = String(worktree);
  // Bounded: only the MAX_SCAN most recently written transcripts are opened.
  const files = [];
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const sessionId = n.slice(0, -'.jsonl'.length);
    if (!SID_RE.test(sessionId)) continue;
    let m = 0;
    try { m = F.statSync(path.join(dir, n)).mtimeMs; } catch (_) { continue; }
    files.push({ n, sessionId, m });
  }
  files.sort((a, b) => b.m - a.m);
  const out = [];
  for (const { n, sessionId, m } of files.slice(0, MAX_SCAN)) {
    const info = transcriptInfo(path.join(dir, n), F);
    if (!info.cwd || !(info.cwd === wt || info.cwd.startsWith(wt + path.sep))) continue;
    if (info.startMs == null) continue;
    out.push({ sessionId, startMs: info.startMs, lastActivityMs: m });
  }
  out.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return out;
}

// anchorSessionDrift({ anchorSessionId, worktree, home, fs }) ->
//   null | { anchorSessionId, newestSessionId, newestStartMs }.
// Drift = the newest session on the worktree is NOT the anchor's recorded one.
// No anchor session, no transcripts, or the anchor IS the newest -> null.
function anchorSessionDrift(opts) {
  const o = opts || {};
  try {
    const anchor = o.anchorSessionId != null ? String(o.anchorSessionId) : '';
    if (!anchor || anchor.startsWith('unclaimed:')) return null;
    const list = sessionsForWorktree(o.worktree, o);
    if (!list.length || list[0].sessionId === anchor) return null;
    // P2 fix: only surface "a newer session exists" when the most-recently-
    // ACTIVE session on this worktree (list[0], now ordered by lastActivityMs)
    // is actually more recently active than the CURRENT running session's own
    // last activity — a session that merely started earlier/later but has
    // since gone stale must not outrank the live one on id/anchor alone.
    // o.currentSessionId not found in `list` (its own transcript not yet
    // matched/written) -> fail open to the anchor-only drift below, same as
    // before this fix.
    const cur = o.currentSessionId != null ? String(o.currentSessionId) : '';
    const curEntry = cur ? list.find((s) => s.sessionId === cur) : null;
    if (curEntry && list[0].lastActivityMs <= curEntry.lastActivityMs) return null;
    return { anchorSessionId: anchor, newestSessionId: list[0].sessionId, newestStartMs: list[0].lastActivityMs };
  } catch (_) { return null; }
}

// driftNotice(drift, currentSessionId) -> the notice text, or '' (no drift).
function driftNotice(drift, currentSessionId) {
  if (!drift) return '';
  const cur = currentSessionId ? String(currentSessionId) : '';
  if (cur && cur === drift.newestSessionId) return ''; // this IS the newest session: the anchor refresh fixes it
  return 'DEVSWARM PRIMARY SESSION NOTICE: you are this project\'s only Primary; a newer session exists: '
    + drift.newestSessionId + ' — /resume it if it owns the live lanes. (The Primary anchor records session '
    + drift.anchorSessionId + '. A `primary-<hash>` sender label is a worktree id, NOT proof of another '
    + 'Primary — never stand down on a label alone; check `devswarm.js roster`.)';
}

module.exports = { projectDirFor, sessionsForWorktree, anchorSessionDrift, driftNotice };
