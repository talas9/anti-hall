// anti-hall :: handover-freshness — for the auto-handover DECISIVE PROMPT
// (autoHandover.decisivePrompt, hooks/auto-handover-pause-nag.js): is the
// session's saved handover file still fresh, and does its content look like
// the current task is done (so /clear, not /compact, is the right nudge)?
//
// STALENESS mirrors hooks/tasklist-guard.js's own "thread 7b" staleness rail
// (a counted file-changing action's transcript timestamp landing AFTER the
// newest HANDOVER*.md's mtime -> stale) — same MTIME_GRACE_MS, same "no
// counted work seen at all -> unprovable, never claim stale" rule. It cannot
// be `require()`d directly: tasklist-guard.js is a standalone Stop-hook
// script that runs main() at load time (see its own header) and reads stdin
// synchronously, so hooks/auto-handover-pause-nag.js already mirrors its
// hasOpenTasks() logic for the same reason — this file follows that existing
// precedent rather than inventing a new one.
//
// FAIL-OPEN: every function returns a safe default (null / false) on any
// error; nothing here throws. Pure Node built-ins only.

'use strict';

const fs = require('fs');

// Matches tasklist-guard.js's own MUTATING_TOOLS set.
const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// A deliberately narrower mirror of tasklist-guard.js's BASH_WORK_RE — this
// file only needs "did a real mutation happen after the handover was
// written", not the full work-counting/scratchpad-exclusion machinery that
// feeds tasklist-guard's own block threshold.
const BASH_WORK_RE = /\b(git\s+(commit|rebase|merge|cherry-pick|revert)|npm\s+(install|ci)|pip\s+install|sed\s+-i)\b/i;
// Matches tasklist-guard.js's own MTIME_GRACE_MS (thread 7b): absorbs
// whole-second mtime rounding on some filesystems without masking real
// staleness.
const MTIME_GRACE_MS = 1000;

function collectToolUses(node) {
  if (!node || typeof node !== 'object') return [];
  const results = [];
  if (node.type === 'tool_use' && node.name) results.push(node);
  for (const key of ['content', 'message', 'messages', 'tool_uses', 'parts']) {
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) results.push(...collectToolUses(item));
    } else if (val && typeof val === 'object') {
      results.push(...collectToolUses(val));
    }
  }
  return results;
}

// lastWorkTs(lines) -> ms epoch of the newest counted file-changing action in
// the transcript tail (an array of raw JSONL strings, e.g. from
// transcript-tail.js's readTail()), or 0 if none/unknown.
function lastWorkTs(lines) {
  if (!Array.isArray(lines)) return 0;
  let last = 0;
  for (const line of lines) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (!entry || entry.isSidechain === true) continue;
    const entryTs = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(entryTs)) continue;
    for (const tu of collectToolUses(entry)) {
      const name = tu.name || '';
      if (MUTATING_TOOLS.has(name)) {
        if (entryTs > last) last = entryTs;
        continue;
      }
      if (name === 'Bash') {
        const cmd = tu.input && typeof tu.input.command === 'string' ? tu.input.command : '';
        if (cmd && BASH_WORK_RE.test(cmd) && entryTs > last) last = entryTs;
      }
    }
  }
  return last;
}

// isFresh(lines, handoverMtimeMs) -> true | false | null.
//   true  : the handover's mtime is at/after the newest counted work (fresh).
//   false : counted work happened after the handover was written (stale).
//   null  : no counted work seen at all in the visible tail -- unprovable,
//           same "never claim unprovable staleness" rule tasklist-guard.js
//           follows; callers treat null as fresh (safe default).
function isFresh(lines, handoverMtimeMs) {
  if (!Number.isFinite(handoverMtimeMs)) return null;
  const work = lastWorkTs(lines);
  if (work <= 0) return null;
  return work <= handoverMtimeMs + MTIME_GRACE_MS;
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
const NEXT_ACTION_DONE_RE = /\b(done|complete(d)?|nothing (further|left|remaining)|no (further|open) (action|items?)|task is finished)\b/i;

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
