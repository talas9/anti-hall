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

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const UNKNOWN_SESSION = 'unknown-session';
const HANDOVER_FILE_RE = /^HANDOVER(?:-(\d+))?\.md$/;

// sanitizeSessionId -- reused EXACTLY from tasklist-guard.js so this hook's
// session-id comparisons line up with the directory names the handover skill
// (and tasklist-guard's own progress/history dirs) already produce.
function sanitizeSessionId(raw) {
  const safe = String(raw || '').replace(/[^A-Za-z0-9_-]/g, '');
  return safe || UNKNOWN_SESSION;
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

// findNewestHandover(handoversRoot, wantSessionId) -> candidate object or null.
// candidate: { filePath, mtimeMs, date, sessionId, seq }
function findNewestHandover(handoversRoot, wantSessionId) {
  const candidates = [];

  const dateDirs = listDirs(handoversRoot);
  for (const date of dateDirs) {
    const datePath = path.join(handoversRoot, date);
    const sessionDirs = listDirs(datePath);
    for (const sessionId of sessionDirs) {
      const sessionPath = path.join(datePath, sessionId);
      let files;
      try {
        files = fs.readdirSync(sessionPath);
      } catch (_) {
        continue;
      }
      for (const fname of files) {
        const m = HANDOVER_FILE_RE.exec(fname);
        if (!m) continue;
        const filePath = path.join(sessionPath, fname);
        let st;
        try {
          st = fs.statSync(filePath);
        } catch (_) {
          continue;
        }
        if (!st.isFile()) continue;
        const seq = m[1] ? parseInt(m[1], 10) : 1;
        candidates.push({
          filePath,
          mtimeMs: st.mtimeMs,
          date,
          sessionId,
          seq,
        });
      }
    }
  }

  if (candidates.length === 0) return null;

  // PREFER same-session candidates (continuation after clear/compact) over pure
  // mtime -- pick the highest-mtime candidate within the matching set if any
  // exist, else fall back to the highest-mtime candidate overall.
  let pool = candidates;
  if (wantSessionId) {
    const sameSession = candidates.filter((c) => c.sessionId === wantSessionId);
    if (sameSession.length > 0) pool = sameSession;
  }

  pool.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return pool[0];
}

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

function buildContext(candidate, outcome, prefix) {
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
  lines.push('');
  lines.push('GUIDED RESUME PATH:');
  lines.push('1. Read ' + candidate.filePath + ' FULLY -- front matter (first ~15 lines) carries Situation + Next Action.');
  lines.push('2. Run its section-10 resume-verification checklist (git status, pwd, CLAUDE.md re-read, smoke command) BEFORE trusting any written state.');
  lines.push('3. Load detail files ONLY as needed via the pointer table (state.md / decisions.md / trials.md / knowledge.md).');
  lines.push('4. Check trials.md do-not-repeat list before re-attempting anything.');
  lines.push('5. Continue from the single Next Action.');
  lines.push('');
  lines.push(
    'This handover SUPERSEDES the auto-compact summary and any legacy CONTINUE-HERE-style ' +
    'file for continuation state: where they conflict, trust the handover -- it is the ' +
    'evidence-backed record; the compact summary is lossy.'
  );
  return lines.join('\n');
}

function main() {
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

  const handoversRoot = path.join(cwd, '.anti-hall', 'handovers');
  let rootIsDir = false;
  try {
    rootIsDir = fs.statSync(handoversRoot).isDirectory();
  } catch (_) {
    rootIsDir = false;
  }
  if (!rootIsDir) return;

  const rawSessionId = payload.session_id != null ? String(payload.session_id) : '';
  const wantSessionId = rawSessionId ? sanitizeSessionId(rawSessionId) : '';

  const candidate = findNewestHandover(handoversRoot, wantSessionId);
  if (!candidate) return;

  const ageMs = Date.now() - candidate.mtimeMs;
  if (ageMs > SEVEN_DAYS_MS) return; // stale -- silent, per spec.

  const source = typeof payload.source === 'string' ? payload.source : '';
  const prefix = (source === 'clear' || source === 'compact')
    ? 'A session handover was found for this continuation'
    : 'A previous session left a handover';

  const outcome = readIndexOutcome(handoversRoot, candidate.date, candidate.sessionId, candidate.seq);
  const additionalContext = buildContext(candidate, outcome, prefix);

  const hookEventName = typeof payload.hook_event_name === 'string' && payload.hook_event_name
    ? payload.hook_event_name
    : 'SessionStart';

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
