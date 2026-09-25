// anti-hall :: work-detect — the ONE definition of "a counted file-changing
// action" in a transcript. Shared by hooks/tasklist-guard.js (work counting +
// the thread-7b handover staleness rail) and hooks/lib/handover-freshness.js
// (auto-handover decisive prompt), so the two can never disagree about
// whether work happened after a handover was written.
//
// Pure Node built-ins; nothing here throws on well-formed input.

'use strict';

// File-mutating tool names (each tool_use = +1 to WORK_COUNT).
const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// A Bash command counts as work when it commits or writes. This is a FAIL-OPEN
// nudge heuristic only — Edit/Write/MultiEdit/NotebookEdit remain the primary +1
// work signals; this just improves Bash coverage. All branches are ReDoS-safe (no
// nested quantifiers; only simple \s*/\s+; linear). Built via concatenated strings
// + new RegExp with the `m` flag so `^` matches at the start of EACH line.
//
// Tested against a QUOTE-NEUTRALIZED copy of the command (neutralizeQuotedContents
// below, mirrors command-guard.js's helper of the same name): quoted string
// CONTENTS are blanked to spaces before matching, so text that only appears
// inside a quoted argument (a commit message, a --format string, a sentence —
// e.g. `git log --format="%an <%ae>"`, `echo "do not touch this"`) can never be
// mistaken for a real write. Real unquoted commands are untouched and still match.
//
//   (1) ALWAYS-work tokens, matched anywhere (compound/multi-word, low
//       false-positive risk once quoted text is neutralized):
//         git commit/rebase/merge/cherry-pick/stash/reset/apply/am
//         git checkout/switch/restore/clean
//         sed -i · npm install|i|ci · (pnpm|yarn) add|install · pip install
//   (2) COMMAND-POSITION-ONLY bare verbs (rm / cp / mv / tee / mkdir / touch /
//       make / chmod): short, common-word verbs over-match mid-command, inside
//       quoted strings, or in URL-ish paths like "/cp/" if matched anywhere, so
//       we anchor them to command position — start-of-line (m-flag), or
//       immediately after one of:  ; & |  ( ` $(  or a newline — each optionally
//       followed by whitespace. This catches command-substitution / subshell
//       contexts:  (rm f)   echo $(rm f)   echo `rm f`   "...\nrm f"
//   (3) SHELL REDIRECT > / >> TO A FILE: matches anywhere (unambiguous shell
//       syntax once quoted text is neutralized) EXCEPT fd-only redirects
//       `2>`, `>&`, `2>&1` — a negative lookbehind rejects a preceding digit/`&`
//       and a negative lookahead rejects a following `&`, so stderr-to-terminal
//       and fd-duplication forms (`2>/dev/null`, `2>&1`, `>&2`) are excluded —
//       they redirect a descriptor, not a file write.
const CMD_BOUNDARY = '(?:^|[;&|`(]|\\$\\(|\\n)\\s*';
// ALWAYS_WORK_SRC — the high-confidence, unambiguous mutation verbs (real git
// history/dependency mutations). Factored out from BASH_WORK_RE so it can also
// be tested ALONE by the scratchpad-noise filter below (FIX 7): these always
// count as work even when a scratchpad/tmp path also appears in the same
// command line, whereas the generic bare-verb/redirect matches (2)/(3) do not
// when the ONLY path touched is the session's own scratchpad.
const ALWAYS_WORK_SRC =
  '\\bgit\\s+(?:commit|rebase|merge|cherry-pick|stash|reset|apply|am)\\b' +
  '|\\bgit\\s+(?:checkout|switch|restore|clean)\\b' +
  '|\\bsed\\s+-i' +
  '|\\bnpm\\s+(?:install|i|ci)\\b' +
  '|\\b(?:pnpm|yarn)\\s+(?:add|install)\\b' +
  '|\\bpip\\s+install\\b' +
  // `patch` (unlike `git apply`, already listed above) mutates whatever files
  // its diff headers name — never discoverable from the command line's own
  // arguments (the patch FILE itself may sit anywhere, including scratchpad,
  // via `patch < …/scratchpad/x.patch`) — so it must always count as work
  // regardless of what path also appears on the line.
  '|\\bpatch\\b';
const ALWAYS_WORK_RE = new RegExp('(' + ALWAYS_WORK_SRC + ')', 'im');
const BASH_WORK_RE = new RegExp(
  '(' +
    // (1) always-work, anywhere
    ALWAYS_WORK_SRC +
    // (2) command-position-only bare verbs
    '|' + CMD_BOUNDARY + '(?:rm|cp|mv|tee|mkdir|touch|make|chmod)\\b' +
    // (3) file redirect, excluding fd-only `2>` / `>&` / `2>&1`
    '|(?<![0-9&])>{1,2}(?!&)' +
  ')',
  'im'
);
// SCRATCHPAD_PATH_RE (FIX 7, root cause of #17 per real-transcript evidence):
// the harness's own per-session scratchpad — literally named "scratchpad" in
// its own path segment (see this file's own guidance to agents: "always use
// [the scratchpad] ... instead of /tmp") — holds inter-agent message-passing
// and scratch artifacts, never PROJECT work. In two independently-reproduced
// SkyCrew Primary sessions, 70-90% of the Bash "work" counted between two
// consecutive progress-staleness blocks was `cat >`/`mkdir`/`touch` traffic
// into this exact scratchpad directory (message relaying to child agents),
// not project edits. That churn shifts workBucket (floor(workCount/threshold))
// on every Stop, defeating the hash-based dedup and re-firing the SAME
// already-complied-with "update your progress file" cause every time the
// freshness window lapses — even though the file was written to the exact
// expected path within seconds of each prior nag (confirmed against the real
// transcripts; ruled out: path mismatch, date rollover, session-id mismatch,
// mtime race — the mtime read was always correct and fresh immediately after
// the write).
const SCRATCHPAD_PATH_RE = /\/scratchpad\//;

// allPathsUnderScratchpad(neutralized) -> bool. Conservative companion to
// SCRATCHPAD_PATH_RE above (Codex review fix): the original check only asked
// "does /scratchpad/ appear ANYWHERE on the line", which wrongly excluded a
// command whose SOURCE happens to sit in scratchpad but whose real write
// target does not — e.g. `cp /…/scratchpad/x.py /real/repo/dest.py` or
// `python3 /…/scratchpad/x.py > /real/repo/out.txt` genuinely mutate the repo.
// Requires that EVERY path-looking token (anything containing "/") on the
// (quote-neutralized) line sits under scratchpad; a single non-scratch path
// token means this command is NOT scratch-only (counted as work — the safe,
// loss-free direction: over-count real work rather than hide it).
function allPathsUnderScratchpad(neutralized) {
  const tokens = neutralized.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    if (tok.indexOf('/') === -1) continue;
    if (!SCRATCHPAD_PATH_RE.test(tok)) return false;
  }
  return true;
}

// neutralizeQuotedContents — blank out the CONTENTS of single- and double-quoted
// string literals (delimiters included) so BASH_WORK_RE cannot match text that is
// merely quoted DATA rather than a real shell command. Same name/semantics as
// command-guard.js's helper; duplicated here rather than imported since
// command-guard.js is a standalone script with no exports.
function neutralizeQuotedContents(segment) {
  let out = '';
  let i = 0;
  const n = segment.length;
  let inSingle = false;
  let inDouble = false;
  while (i < n) {
    const c = segment[i];
    const c2 = i + 1 < n ? segment[i + 1] : '';
    if (inSingle) { out += ' '; if (c === "'") inSingle = false; i++; continue; }
    if (inDouble) {
      if (c === '\\' && c2) { out += '  '; i += 2; continue; }
      out += ' '; if (c === '"') inDouble = false; i++; continue;
    }
    if (c === "'") { inSingle = true; out += ' '; i++; continue; }
    if (c === '"') { inDouble = true; out += ' '; i++; continue; }
    out += c; i++;
  }
  return out;
}

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

// isCountedWork(toolUse) -> bool. A tool_use counts as work when it is a
// file-mutating tool (Edit/Write/MultiEdit/NotebookEdit) outside the session
// scratchpad, or a Bash command matching BASH_WORK_RE (quote-neutralized)
// that is not scratchpad-only traffic. Sidechain (subagent) entries are NOT
// excluded — a subagent's edit is real work too.
function isCountedWork(tu) {
  if (!tu || typeof tu !== 'object') return false;
  const name = tu.name || '';
  if (MUTATING_TOOLS.has(name)) {
    const fp = tu.input && typeof tu.input.file_path === 'string' ? tu.input.file_path : '';
    return !SCRATCHPAD_PATH_RE.test(fp);
  }
  if (name === 'Bash') {
    const cmd = tu.input && typeof tu.input.command === 'string' ? tu.input.command : '';
    if (!cmd) return false;
    const neutralized = neutralizeQuotedContents(cmd);
    if (!BASH_WORK_RE.test(neutralized)) return false;
    const isScratchOnly = SCRATCHPAD_PATH_RE.test(cmd) && !ALWAYS_WORK_RE.test(neutralized)
      && allPathsUnderScratchpad(neutralized);
    return !isScratchOnly;
  }
  return false;
}

module.exports = {
  MUTATING_TOOLS,
  ALWAYS_WORK_RE,
  BASH_WORK_RE,
  SCRATCHPAD_PATH_RE,
  allPathsUnderScratchpad,
  neutralizeQuotedContents,
  collectToolUses,
  isCountedWork,
};
