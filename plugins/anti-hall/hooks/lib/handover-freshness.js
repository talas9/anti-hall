// anti-hall :: handover-freshness — for the auto-handover DECISIVE PROMPT
// (autoHandover.decisivePrompt, hooks/auto-handover-pause-nag.js): is the
// session's saved handover file still fresh, and does its content look like
// the current task is done (so /clear, not /compact, is the right nudge)?
//
// STALENESS uses hooks/tasklist-guard.js's own work detection, shared via
// hooks/lib/work-detect.js (isCountedWork): a counted file-changing action
// (Edit/Write/MultiEdit/NotebookEdit, or a Bash write — rm/cp/mv/tee/mkdir/
// touch/make/chmod/`>` redirects/git commit/...), INCLUDING sidechain/subagent
// entries, whose transcript timestamp lands AFTER the handover's mtime ->
// stale. Same MTIME_GRACE_MS as tasklist-guard's thread-7b rail.
//
// UNKNOWN is a first-class answer: a missing transcript, or one with no
// parseable Claude-shape entry (e.g. a Codex rollout, whose tool calls this
// detector does not understand), yields null — callers must NOT show the
// green "good point" line then.
//
// FAIL-OPEN: every function returns a safe default (null / false) on any
// error; nothing here throws. Pure Node built-ins only.

'use strict';

const fs = require('fs');
const { collectToolUses, isCountedWork } = require('./work-detect.js');

// Matches tasklist-guard.js's own MTIME_GRACE_MS (thread 7b): absorbs
// whole-second mtime rounding on some filesystems without masking real
// staleness.
const MTIME_GRACE_MS = 1000;

// isClaudeEntry(entry) -> true for a Claude Code transcript entry (carries a
// `message` object). Codex rollout lines ({type:'event_msg'|'response_item',
// payload}) do not, so a Codex transcript reads as "unknown", not "fresh".
function isClaudeEntry(entry) {
  return !!(entry && typeof entry === 'object' && entry.message && typeof entry.message === 'object');
}

// scanWork(lines) -> { recognized, last }. recognized: at least one
// Claude-shape entry parsed. last: ms epoch of the newest counted work (0 =
// none seen).
function scanWork(lines) {
  const out = { recognized: false, last: 0 };
  if (!Array.isArray(lines)) return out;
  for (const line of lines) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (!isClaudeEntry(entry)) continue;
    out.recognized = true;
    const entryTs = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(entryTs)) continue;
    for (const tu of collectToolUses(entry)) {
      if (isCountedWork(tu) && entryTs > out.last) out.last = entryTs;
    }
  }
  return out;
}

// lastWorkTs(lines) -> ms epoch of the newest counted file-changing action in
// the transcript tail (an array of raw JSONL strings, e.g. from
// transcript-tail.js's readTail()), or 0 if none/unknown.
function lastWorkTs(lines) {
  return scanWork(lines).last;
}

// isFresh(lines, handoverMtimeMs) -> true | false | null.
//   true  : the transcript was readable and no counted work landed after the
//           handover's mtime (fresh).
//   false : counted work happened after the handover was written (stale).
//   null  : UNKNOWN — no transcript, or no parseable Claude-shape entry (e.g.
//           Codex). Callers show a neutral line, never the green one.
function isFresh(lines, handoverMtimeMs) {
  if (!Number.isFinite(handoverMtimeMs)) return null;
  const scan = scanWork(lines);
  if (!scan.recognized) return null;
  return scan.last <= handoverMtimeMs + MTIME_GRACE_MS;
}

// extractSection(text, heading) -> the trimmed body of a `## <heading>`
// section up to the next `## ` heading (or end of file), or null when the
// heading is absent. Case-insensitive, matches the HANDOVER.md skeleton in
// skills/handover/SKILL.md.
function extractSection(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^##\\s+' + escaped + '\\s*$', 'im');
  const m = re.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^##\s+/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

const OPEN_ITEMS_EMPTY_RE = /^(none|n\/a|-|—|\(none\))\.?$/i;
// Strict whole-section match: the Next action body must be exactly one of
// none/done/complete/nothing (optional trailing period). "mark T3 done after
// CI" is an open action, not completion.
const NEXT_ACTION_DONE_RE = /^(none|done|complete|nothing)\.?$/i;

// isTaskComplete(handoverText) -> true when the handover's own "Open items"
// section reads as empty, or its "Next action" section reads as already
// done. Cheap, best-effort text sniffing of the skeleton in
// skills/handover/SKILL.md -- false (never claim completion) on anything
// ambiguous, absent, or unparsable.
function isTaskComplete(handoverText) {
  if (typeof handoverText !== 'string' || !handoverText) return false;
  const openItems = extractSection(handoverText, 'Open items');
  if (openItems !== null && OPEN_ITEMS_EMPTY_RE.test(openItems)) return true;
  const nextAction = extractSection(handoverText, 'Next action');
  if (nextAction !== null && NEXT_ACTION_DONE_RE.test(nextAction)) return true;
  return false;
}

// isTaskCompleteFromFile(filePath) -> isTaskComplete() over the file's
// content, false on any read error.
function isTaskCompleteFromFile(filePath) {
  try {
    return isTaskComplete(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return false;
  }
}

module.exports = {
  MTIME_GRACE_MS,
  lastWorkTs,
  isFresh,
  extractSection,
  isTaskComplete,
  isTaskCompleteFromFile,
};
