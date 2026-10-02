// anti-hall :: work-detect — the ONE definition of "a counted file-changing
// action" in a transcript. Shared by hooks/tasklist-guard.js (work counting +
// the thread-7b handover staleness rail) and hooks/lib/handover-freshness.js
// (auto-handover decisive prompt), so the two can never disagree about
// whether work happened after a handover was written.
//
// Pure Node built-ins; nothing here throws on well-formed input.

'use strict';

const path = require('path');
const os = require('os');

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
// downstream-project Primary sessions, 70-90% of the Bash "work" counted between two
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

// ANTIHALL_STATE_DIR_RE (defect 4b, peer sweep 0.116 candidate): tasklist-guard
// itself DIRECTS agents to append to .anti-hall/progress/*.md and
// .anti-hall/history/*.md as required bookkeeping (see tasklist-guard.js's own
// progressRelPath/historyRelPath). Counting the guard's own mandated
// bookkeeping as "file-changing work" is circular — it must never count,
// the same way scratchpad message-passing traffic doesn't.
// handovers/ is the same class (crash-recovery bookkeeping the handover flow
// itself directs); the leading `/` is optional (start, whitespace or `/`) so a cwd-relative
// `.anti-hall/...` path (e.g. `echo >> .anti-hall/handovers/…`) is exempt too.
const ANTIHALL_STATE_DIR_RE = /(?:^|[\s/])\.anti-hall\/(?:progress|history|handovers)\//;

// isUnderTmpRoot(p) -> bool (defect 4b): true when p resolves under the live
// per-process/per-user OS temp dir (os.tmpdir(), e.g. macOS's
// /var/folders/.../T — NOT the literal '/tmp' or '/private/tmp' strings).
// Broader than SCRATCHPAD_PATH_RE's literal "/scratchpad/" segment match:
// covers ANY scratch copy outside the repo living under the OS temp root
// (e.g. a Ghidra copy under /tmp), not only the session's own named
// scratchpad directory. Deliberately narrower than hooks/lib/scratchpad.js's
// tmpRoots() (which also enumerates the literal '/tmp'/'/private/tmp' paths
// for a DIFFERENT purpose — resolving the session's own scratchpad dir under
// every possible tmp-root spelling): this repo's own test fixtures and real
// project checkouts can legitimately live under a literal /private/tmp/...
// path that is NOT the live os.tmpdir() value, so only the live os.tmpdir()
// is treated as "definitely outside any repo".
function isUnderTmpRoot(p) {
  if (typeof p !== 'string' || !p) return false;
  let resolved;
  try { resolved = path.resolve(p); } catch (_) { return false; }
  let root;
  try { root = os.tmpdir(); } catch (_) { return false; }
  if (typeof root !== 'string' || !root) return false;
  return resolved === root || resolved.startsWith(root + path.sep);
}

// isExcludedWritePath(fp) -> bool: fp is the session scratchpad, a repo
// .anti-hall/progress|history state dir, or a scratch copy under any tmp
// root — none of these count as project work.
function isExcludedWritePath(fp) {
  if (typeof fp !== 'string' || !fp) return false;
  return SCRATCHPAD_PATH_RE.test(fp) || ANTIHALL_STATE_DIR_RE.test(fp) || isUnderTmpRoot(fp);
}

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

// allPathsExcluded(neutralized) -> bool (defect 4b): same shape as
// allPathsUnderScratchpad above, but the per-token test is the broader
// isExcludedWritePath (scratchpad OR repo .anti-hall state dir OR any tmp
// root), so a command whose every path-looking token is one of those three
// is excluded, not only literal-scratchpad-only commands.
function allPathsExcluded(neutralized) {
  const tokens = neutralized.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    if (tok.indexOf('/') === -1) continue;
    if (!isExcludedWritePath(tok)) return false;
  }
  return true;
}

// hasExcludedPathHint(cmd) -> bool: cheap gate (mirrors the original
// SCRATCHPAD_PATH_RE.test(cmd) precheck) so a command with NO path tokens at
// all (e.g. `git commit -am "x"`) is never misclassified as "scratch-only" —
// allPathsExcluded returns true vacuously on zero path tokens, so this hint
// must find at least one real signal before that branch is trusted.
function hasExcludedPathHint(cmd) {
  if (typeof cmd !== 'string' || !cmd) return false;
  if (SCRATCHPAD_PATH_RE.test(cmd) || ANTIHALL_STATE_DIR_RE.test(cmd)) return true;
  let root;
  try { root = os.tmpdir(); } catch (_) { return false; }
  return typeof root === 'string' && !!root && cmd.indexOf(root) !== -1;
}

// defect T4(b) fix (7-workspace sweep, 2026-09-27): a Bash command that is
// ONLY anti-hall's own DevSwarm mesh housekeeping — the stable launcher's
// inbox/heartbeat/send/roster verbs, or a `crontab` read/install for the
// mailbox-wake cron job (devswarm-child-role.js's wake-directive; a real
// `crontab -l > tmp; ...; crontab tmp`-shaped install DOES match this file's
// own `>`-redirect work signal (3), which is correct for a GENUINE file
// write but wrong here — a crontab entry is not project work) — is not
// PROJECT work. It must never count toward "you did real work", the same way
// the scratchpad exclusion above keeps inter-agent message-passing traffic
// from counting. Segment-scoped (mirrors command-guard.js's own segment
// splitting): a command chaining a housekeeping verb with GENUINE other work
// (e.g. `node devswarm.js inbox ack x && npm test`) still counts as work —
// only a command whose EVERY segment is housekeeping is excluded.
const DEVSWARM_LAUNCHER_PREFIX_SRC = '(?:node\\s+)?(?:\\S*[\\\\/])?devswarm\\.js';
const DEVSWARM_FLAG_SKIP_SRC = '(?:-\\S+(?:\\s+[^-\\s]\\S*)?\\s+)*';
const DEVSWARM_VERB_SRC =
  '(?:inbox\\s+' + DEVSWARM_FLAG_SKIP_SRC
    + '(?:pull|ack|ack-primary|read|read-primary|tick|count|peek-primary|messages)\\b'
  + '|heartbeat\\b|send\\b|relay\\b|notice\\b|nudge\\b|roster\\b|wake-directive\\b)';
const DEVSWARM_HOUSEKEEPING_SEGMENT_RE = new RegExp(
  '^\\s*' + DEVSWARM_LAUNCHER_PREFIX_SRC + '\\s+' + DEVSWARM_FLAG_SKIP_SRC + DEVSWARM_VERB_SRC,
  'i'
);
// Anchored to command position (optionally inside a leading subshell paren):
// a segment that merely MENTIONS crontab (`git commit -m "add crontab entry"`,
// `sed -i … deploy/crontab.txt`, `npm install crontab-parser`) is real work.
const CRONTAB_SEGMENT_RE = /^[({\s]*crontab(?![\w.-])/i;

// R3A1-WD-1 fix: a segment can match DEVSWARM_HOUSEKEEPING_SEGMENT_RE or
// CRONTAB_SEGMENT_RE at ITS START and still do real project work — a trailing
// `>`/`>>` redirect into a project file (`crontab -l > src/app.js`), or a
// nested command substitution / backtick that hides arbitrary work
// (`crontab -l $(sed -i s/a/b/ src/x.js)`). The start-anchored verb check
// alone can't see that, so each housekeeping-looking segment is additionally
// checked for an escaping write. TMP_HOUSEKEEPING_TARGET_RE allows the
// legitimate mailbox-wake crontab install shape, whose redirect targets the
// session scratchpad or a generic OS tmp path (`crontab -l > /tmp/cron.txt`),
// to stay housekeeping-only — only a redirect into something else (a
// project-looking path) disqualifies the segment.
const TMP_HOUSEKEEPING_TARGET_RE = /\/scratchpad\/|(?:^|\/)tmp\//i;
// Same fd-only exclusion as BASH_WORK_RE's redirect check (3): a negative
// lookbehind rejects a preceding digit/`&` and a negative lookahead rejects a
// following `&`, so `2>&1` / `>&2` (descriptor dup, not a file write) never
// counts as an escaping redirect.
const REAL_REDIRECT_RE = /(?<![0-9&])>{1,2}(?!&)\s*(\S+)/;

function segmentEscapesHousekeeping(seg) {
  const neutralized = neutralizeQuotedContents(seg);
  // A command substitution or backtick can hide arbitrary real work (e.g. a
  // nested `sed -i`) inside an otherwise housekeeping-looking segment.
  if (/\$\(|`/.test(neutralized)) return true;
  const m = REAL_REDIRECT_RE.exec(neutralized);
  if (m) {
    const target = m[1];
    if (!/\/dev\/null/.test(target) && !TMP_HOUSEKEEPING_TARGET_RE.test(target)) return true;
  }
  return false;
}

// stripHeredocBodies(cmd) -> string | null. A heredoc body (`send x <<EOF ...
// EOF`, the natural way to hand a multi-line mesh message to the launcher) is
// DATA for the command it feeds, never a command line — but the segment split
// below would read each body line as one, and prose like `a -> b` would then
// look like a `>` redirect. Drop body lines up to the terminator. Returns null
// (caller fails closed = "not housekeeping") when a body holds `$(` or a
// backtick: an unquoted-delimiter heredoc expands those, so they can hide work.
function stripHeredocBodies(cmd) {
  const lines = cmd.split('\n');
  const out = [];
  let delim = null;
  for (const line of lines) {
    if (delim !== null) {
      if (/\$\(|`/.test(line)) return null;
      if (line.trim() === delim) delim = null; // terminator line dropped too
      continue;
    }
    out.push(line);
    // `<<` inside a quoted string is not a heredoc: detect on the neutralized line.
    // Nor is a `<<` after an unquoted `#` (a comment runs to end of line, so the
    // "body" that follows is real command lines): cut the line at the comment.
    const neutral = neutralizeQuotedContents(line);
    const hash = neutral.search(/(?:^|\s)#/);
    const code = hash >= 0 ? line.slice(0, hash) : line;
    // An operator `<<` is not backslash-escaped (an odd run of `\` before it
    // escapes it: `\<<EOF` is a literal word, not a heredoc).
    const scan = hash >= 0 ? neutral.slice(0, hash) : neutral;
    let at = -1;
    for (const hit of scan.matchAll(/(?<!<)<<(?!<)/g)) {
      let bs = 0;
      while (hit.index - 1 - bs >= 0 && scan[hit.index - 1 - bs] === '\\') bs++;
      if (bs % 2 === 0) { at = hit.index; break; }
    }
    if (at < 0) continue;
    // The delimiter word may be partly quoted/escaped (`E"OF"`, `\EOF`): the
    // terminator line is the word with quoting removed.
    const m = /^<<-?\s*((?:[^\s;&|()<>'"\\]|'[^'\n]*'|"[^"\n]*"|\\[^\n])+)/.exec(code.slice(at));
    if (m) delim = m[1].replace(/\\(.)|['"]/g, (_, c) => c || '');
  }
  return out.join('\n');
}

// isDevswarmHousekeepingOnly(rawCmd) -> bool. True only when EVERY segment
// (split on &&, ||, ;, |, newline and a lone background `&` — not the `&` of
// `2>&1` / `&>`) of the RAW (not quote-neutralized — crontab/
// devswarm-verb detection needs no quote awareness, matching command-guard's
// own convention for this same command shape) command line is either a
// stable-launcher devswarm verb invocation or a crontab manipulation, AND
// does not also escape into real work via a redirect or command substitution
// (segmentEscapesHousekeeping — R3A1-WD-1).
function isDevswarmHousekeepingOnly(rawCmd) {
  if (!rawCmd) return false;
  if (rawCmd.indexOf('<<') !== -1) {
    rawCmd = stripHeredocBodies(rawCmd);
    if (rawCmd === null) return false;
  }
  const segments = rawCmd.split(/&&|\|\||;|\||\n|(?<![<>])&(?!>)/);
  if (!segments.length) return false;
  let sawAny = false;
  for (const seg of segments) {
    const s = seg.trim();
    if (!s) continue; // empty segment (trailing separator) never disqualifies
    sawAny = true;
    if (!DEVSWARM_HOUSEKEEPING_SEGMENT_RE.test(s) && !CRONTAB_SEGMENT_RE.test(s)) return false;
    if (segmentEscapesHousekeeping(s)) return false;
  }
  return sawAny;
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
// NEVER_WORK_TOOLS — defect T4(b) fix: a spawn/scheduling action, not a
// file-changing one. Agent/Task START a background worker (that worker's own
// later Edit/Write/Bash calls are what may count, not the spawn call itself);
// CronCreate/CronDelete schedule/unschedule a cron job, never touching a
// project file. None of these carry a `command`/`file_path` input anyway, so
// this was already a de-facto no-op via the checks below — made explicit so
// it is never accidentally picked up by a future MUTATING_TOOLS/Bash-shape
// change, and to document the T4(b) requirement directly.
const NEVER_WORK_TOOLS = new Set(['Agent', 'Task', 'CronCreate', 'CronDelete']);

function isCountedWork(tu) {
  if (!tu || typeof tu !== 'object') return false;
  const name = tu.name || '';
  if (NEVER_WORK_TOOLS.has(name)) return false;
  if (MUTATING_TOOLS.has(name)) {
    const fp = tu.input && typeof tu.input.file_path === 'string' ? tu.input.file_path : '';
    return !isExcludedWritePath(fp);
  }
  if (name === 'Bash') {
    const cmd = tu.input && typeof tu.input.command === 'string' ? tu.input.command : '';
    if (!cmd) return false;
    if (isDevswarmHousekeepingOnly(cmd)) return false;
    const neutralized = neutralizeQuotedContents(cmd);
    if (!BASH_WORK_RE.test(neutralized)) return false;
    const isScratchOnly = hasExcludedPathHint(cmd) && !ALWAYS_WORK_RE.test(neutralized)
      && allPathsExcluded(neutralized);
    return !isScratchOnly;
  }
  return false;
}

module.exports = {
  MUTATING_TOOLS,
  NEVER_WORK_TOOLS,
  ALWAYS_WORK_RE,
  BASH_WORK_RE,
  SCRATCHPAD_PATH_RE,
  ANTIHALL_STATE_DIR_RE,
  isUnderTmpRoot,
  isExcludedWritePath,
  allPathsUnderScratchpad,
  allPathsExcluded,
  hasExcludedPathHint,
  isDevswarmHousekeepingOnly,
  neutralizeQuotedContents,
  collectToolUses,
  isCountedWork,
};
