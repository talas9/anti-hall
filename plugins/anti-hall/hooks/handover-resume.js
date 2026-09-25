#!/usr/bin/env node
// anti-hall :: handover-resume (SessionStart, all sources)
//
// After /clear, context compaction, or a fresh session start, detect the newest
// session handover under <cwd>/.anti-hall/handovers/ and inject a GUIDED RESUME
// PROTOCOL so the next context continues from the handover instead of the lossy
// compact summary. This is a POINTER injection -- it never inlines handover file
// content, only the path + a numbered resume procedure (kept well under the
// ~10,000-char per-hook injection cap; see verify-first-full.js header for the
// cap mechanics).
//
// Contract:
//   stdin  : JSON { session_id, transcript_path, cwd, source, hook_event_name }
//   stdout : JSON { hookSpecificOutput: { hookEventName, additionalContext } }
//   exit 0 : ALWAYS -- fail-open on any error (missing dir, bad JSON, unreadable
//            fs, anything). Never blocks session start.
//
// Discovery:
//   Scan <cwd>/.anti-hall/handovers/<date>/<session-id>/ for HANDOVER*.md files.
//   Pick the highest-mtime file, but PREFER a dir whose session-id matches the
//   incoming payload.session_id (same-session continuation across clear/compact)
//   over a purely newer file from a different session.
//
// Freshness facts: the pointer line is followed by git facts measured at
// injection time -- HEAD, commits since the handover's mtime, dirty-file
// count (each git call capped at 1.5 s; omitted outside a git repo).
// Platform-aware: a Codex payload (hooks/lib/auto-handover-text.js
// detectPlatform) is told to re-read AGENTS.md instead of CLAUDE.md.
//
// PreCompact snapshot awareness: hooks/precompact-snapshot.js writes a
// mechanical PRECOMPACT-<n>.md into THIS session's dir right before every
// compaction. When one exists (same session, <= 7 days), the injection names
// it -- flagged as NEWER than the handover when work happened after the
// handover -- and when no usable handover exists at all it points at the
// snapshot instead of the negative report.
//
// Session-id sanitize: reuse tasklist-guard.js's sanitizeSessionId EXACTLY (same
// regex) so directory names line up with what the handover skill itself writes.
//
// Source gating:
//   source === 'clear' | 'compact'            -> inject if newest <= 7 days old.
//   source === 'startup' | 'resume' | missing  -> inject if newest <= 7 days old
//                                                  (different prefix wording).
//   otherwise (older than 7 days)              -> silent, no injection.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { detectPlatform } = require('./lib/auto-handover-text.js');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// Discovery + session-id sanitize live in hooks/lib/handover-find.js (shared
// with hooks/precompact-snapshot.js).
const {
  sanitizeSessionId,
  findNewestHandover,
  findNewestPrecompact,
} = require('./lib/handover-find.js');

// readIndexOutcome(handoversRoot, date, sessionId, seq) -> one-line outcome
// string parsed from INDEX.md's row for this handover, or '' if unparseable or
// missing. Row format (handover skill contract): "- YYYY-MM-DD · <session-id> ·
// seq N · <one-line outcome> · [subsystems] · [main](<date>/<session-id>/HANDOVER.md)"
// A row whose "seq N" matches the candidate wins; otherwise fall back to the
// LAST matching date+session row (rows are appended newest-last), so a
// multi-handover session never surfaces its seq-1 outcome for a later seq.
function readIndexOutcome(handoversRoot, date, sessionId, seq) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(handoversRoot, 'INDEX.md'), 'utf8');
  } catch (_) {
    return '';
  }
  const lines = raw.split('\n');
  let fallback = '';
  for (const line of lines) {
    if (line.indexOf(date) === -1 || line.indexOf(sessionId) === -1) continue;
    const parts = line.split('·').map((s) => s.trim());
    // parts[0] = "- YYYY-MM-DD", parts[1] = session-id, parts[2] = "seq N",
    // parts[3] = outcome (when present).
    if (parts.length >= 4 && parts[3]) {
      if (parts[2] === 'seq ' + seq) return parts[3];
      fallback = parts[3];
    }
  }
  return fallback;
}

// freshnessLine(cwd, sinceMs) -> one line of git facts measured NOW against
// the handover's mtime, or '' when cwd is not a git repo / git fails. Each git
// call is capped at GIT_TIMEOUT_MS so SessionStart never stalls on it.
const GIT_TIMEOUT_MS = 1500;
function freshnessLine(cwd, sinceMs) {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (_) {
      return null;
    }
  };
  const head = git(['rev-parse', '--short', 'HEAD']);
  if (head === null) return '';
  const since = git(['rev-list', '--count', '--since=@' + Math.floor(sinceMs / 1000), 'HEAD']);
  const status = git(['status', '--porcelain']);
  const commits = since === null ? '?' : String(parseInt(since, 10) || 0);
  const dirty = status === null ? '?' : String(status.split('\n').filter(Boolean).length);
  return 'FRESHNESS (measured now): HEAD ' + head.trim() + '; ' + commits + ' commit(s) since this handover was ' +
    'written (committer date after its mtime); ' + dirty + ' dirty file(s) in the working tree. Any non-zero ' +
    'count means the handover\'s git/state claims may be stale -- re-verify them before trusting them.';
}

function buildContext(candidate, outcome, prefix, freshness, platform) {
  const seqLabel = candidate.seq > 1 ? 'HANDOVER-' + candidate.seq + '.md' : 'HANDOVER.md';
  const predecessor = candidate.seq > 1
    ? (candidate.seq === 2 ? 'HANDOVER.md' : 'HANDOVER-' + (candidate.seq - 1) + '.md')
    : null;

  const lines = [];
  lines.push(
    prefix + ': ' + candidate.filePath +
    ' (' + seqLabel + (predecessor ? ', predecessor ' + predecessor : '') +
    ' | date ' + candidate.date + ' | session ' + candidate.sessionId + ')' +
    (outcome ? ' -- INDEX.md outcome: ' + outcome : '')
  );
  if (freshness) lines.push(freshness);
  lines.push('');
  lines.push('GUIDED RESUME PATH:');
  lines.push('1. Read ' + candidate.filePath + ' FULLY -- front matter (first ~15 lines) carries Situation + Next Action.');
  lines.push('2. Run its section-10 resume-verification checklist (git status, pwd, ' + (platform === 'codex' ? 'AGENTS.md' : 'CLAUDE.md') + ' re-read, smoke command) BEFORE trusting any written state, THEN append a line to ' + candidate.filePath + ': `resume-verified: <ISO timestamp> -- <one-line git-status/pwd/smoke summary>`.');
  lines.push('3. Load detail files ONLY as needed via the pointer table (state.md / decisions.md / trials.md / knowledge.md).');
  lines.push('4. Check trials.md do-not-repeat list before re-attempting anything.');
  lines.push('5. READ-BACK: before any new work, tell the user in your own words (not a paste) the goal, the single Next Action and every active rule from its "Session rules (verbatim)" section, and invite corrections.');
  lines.push('6. Continue from the single Next Action.');
  lines.push("7. Recreate/reconcile your task list from state.md's Task list snapshot BEFORE working.");
  lines.push('');
  lines.push(
    'This handover SUPERSEDES the auto-compact summary and any legacy CONTINUE-HERE-style ' +
    'file for continuation state: where they conflict, trust the handover -- it is the ' +
    'evidence-backed record; the compact summary is lossy.'
  );
  return lines.join('\n');
}

// buildSnapshotLine(snap, candidate) -- one paragraph appended to the normal
// resume pointer when this session also has a PreCompact snapshot. A snapshot
// NEWER than the handover means work happened after the handover was written.
function buildSnapshotLine(snap, candidate) {
  if (snap.mtimeMs > candidate.mtimeMs) {
    return 'PRE-COMPACTION SNAPSHOT (newer than the handover): ' + snap.filePath +
      ' -- anti-hall\'s PreCompact hook saved it mechanically right before compaction ' +
      '(git state, task-list snapshot, the last user messages verbatim). Work happened AFTER ' +
      'the handover was written: read this snapshot right after the handover to catch up, and ' +
      'carry any session rules quoted in its user messages forward.';
  }
  return 'Pre-compaction snapshot (older than the handover, which already covers it): ' +
    snap.filePath + ' -- open it only if the handover is missing something.';
}

// buildSnapshotOnlyContext(snap) -- no usable HANDOVER*.md, but a PreCompact
// snapshot exists for this session.
function buildSnapshotOnlyContext(snap) {
  return 'No HANDOVER*.md was written for this session, but anti-hall\'s PreCompact hook saved a ' +
    'mechanical PRE-COMPACTION SNAPSHOT: ' + snap.filePath + ' (written ' +
    new Date(snap.mtimeMs).toISOString() + '). Read it FULLY before trusting the compact summary: ' +
    'it holds git state, a task-list snapshot and the last user messages VERBATIM, which may carry ' +
    'session rules the summary dropped. It is a crash dump, not a handover (no judgment went into ' +
    'it) -- once you have re-established state, write a real handover with the anti-hall handover skill.';
}

// resumeStatePath(sessionId) -- v0.75.0 resume-verification rail. Lives under
// ~/.anti-hall/ (never the project tree -- mirrors tasklist-guard.js's own
// state convention), keyed by the SAME sanitizeSessionId as tasklist-guard so
// the two hooks agree on session identity without sharing a session-id source
// of truth. Marks "a resume injection happened THIS session, pointing at
// <handoverFile>" so a later Stop hook (tasklist-guard.js) can require a
// resume-verified marker be recorded before the session ends.
function resumeStatePath(sessionId) {
  return path.join(os.homedir(), '.anti-hall', 'handover-resume-state-' + sessionId + '.json');
}

// writeResumeState(sessionId, handoverFile) -- best-effort, fail-open. Never
// lets a write failure affect the SessionStart injection above it.
function writeResumeState(sessionId, handoverFile) {
  try {
    const p = resumeStatePath(sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ handoverFile, ts: Date.now() }), 'utf8');
  } catch (_) { /* fail-open: verification rail just stays inactive this session */ }
}

// emitNegativeReport(payload) -- THREAD 4 (owner amendment 2026-08-07). On a
// clear/compact source ONLY (never startup/resume -- that would be noise on
// every fresh session that simply hasn't written a handover yet), when the
// scan finds NO handover at all for this repo, inject a single short pointer
// line naming the likely cause (wrong-location write, now redirected by
// edit-guard's thread-3 amendment) instead of staying silent. Kept to one
// line, well under the ~10k injection cap.
function emitNegativeReport(payload) {
  const hookEventName = typeof payload.hook_event_name === 'string' && payload.hook_event_name
    ? payload.hook_event_name
    : 'SessionStart';
  const out = {
    hookSpecificOutput: {
      hookEventName,
      additionalContext:
        'No session handover found under .anti-hall/handovers/ -- if one was written ' +
        'this session, it may be in the wrong location; the handover skill writes there.',
    },
  };
  try {
    fs.writeSync(1, JSON.stringify(out) + '\n');
  } catch (_) {
    // fail-open: never let injection failure affect session start.
  }
}

function main() {
  // Settings switch context.handoverResume (0.108.4): off -> no-op. Fail-open: any error runs the hook.
  try { if (!require('./lib/settings.js').enabled('context', 'handoverResume')) return; } catch (_) { /* run */ }
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    raw = '';
  }

  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    payload = null;
  }
  if (!payload || typeof payload !== 'object') return;

  const cwd = payload.cwd;
  if (!cwd || typeof cwd !== 'string') return;

  const source = typeof payload.source === 'string' ? payload.source : '';
  const isCompactOrClear = source === 'clear' || source === 'compact';

  const handoversRoot = path.join(cwd, '.anti-hall', 'handovers');
  let rootIsDir = false;
  try {
    rootIsDir = fs.statSync(handoversRoot).isDirectory();
  } catch (_) {
    rootIsDir = false;
  }
  if (!rootIsDir) {
    if (isCompactOrClear) emitNegativeReport(payload);
    return;
  }

  const rawSessionId = payload.session_id != null ? String(payload.session_id) : '';
  const wantSessionId = rawSessionId ? sanitizeSessionId(rawSessionId) : '';

  const hookEventName = typeof payload.hook_event_name === 'string' && payload.hook_event_name
    ? payload.hook_event_name
    : 'SessionStart';

  // PreCompact safety net (hooks/precompact-snapshot.js): THIS session's
  // newest mechanical PRECOMPACT-<n>.md, if fresh. Same-session only.
  let snap = wantSessionId ? findNewestPrecompact(handoversRoot, wantSessionId) : null;
  if (snap && (Date.now() - snap.mtimeMs) > SEVEN_DAYS_MS) snap = null;

  const candidate = findNewestHandover(handoversRoot, wantSessionId);
  if (!candidate || (Date.now() - candidate.mtimeMs) > SEVEN_DAYS_MS) {
    if (snap) {
      // No usable handover, but the PreCompact hook left a crash dump for
      // this session -- point at it instead of the negative report.
      fs.writeSync(1, JSON.stringify({
        hookSpecificOutput: { hookEventName, additionalContext: buildSnapshotOnlyContext(snap) },
      }) + '\n');
      return;
    }
    if (!candidate && isCompactOrClear) emitNegativeReport(payload);
    return; // (a stale candidate stays silent, per spec -- unchanged)
  }

  const prefix = isCompactOrClear
    ? 'A session handover was found for this continuation'
    : 'A previous session left a handover';

  const outcome = readIndexOutcome(handoversRoot, candidate.date, candidate.sessionId, candidate.seq);
  let additionalContext = buildContext(candidate, outcome, prefix, freshnessLine(cwd, candidate.mtimeMs), detectPlatform(payload));
  if (snap) additionalContext += '\n\n' + buildSnapshotLine(snap, candidate);

  // Record that a resume injection happened THIS session, pointing at the
  // referenced handover file -- tasklist-guard.js reads this to require a
  // resume-verified marker before the session ends. sanitizeSessionId keyed
  // to the RAW incoming session_id (not candidate.sessionId, which is the
  // PRIOR session that wrote the handover) -- the state file belongs to the
  // session resuming, not the one that left the handover.
  if (rawSessionId) {
    writeResumeState(sanitizeSessionId(rawSessionId), candidate.filePath);
  }

  const out = {
    hookSpecificOutput: {
      hookEventName,
      additionalContext,
    },
  };

  // Synchronous write to fd 1 -- see verify-first-full.js header for why
  // process.stdout.write is unsafe here (async pipe-flush truncation race on
  // macOS node 18/20 when the process.exit(0) below tears down before flush).
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

try {
  main();
} catch (_) {
  // Fail-open: never block session start.
}
process.exit(0);
