#!/usr/bin/env node
// anti-hall :: scan-throttle (PreToolUse Bash) — additive background-throttle
// prefix for heavy repo-wide scan commands.
//
// WHAT IT DOES
//   Rewrites a matched command to run background-throttled (macOS:
//   `taskpolicy -c utility nice -n 19 <cmd>`; Linux: `nice -n 19 <cmd>`,
//   optionally preceded by `ionice -c 3 ` when available) via
//   `hookSpecificOutput.updatedInput`. ADDITIVE ONLY: the prefix never
//   changes what the command does, only its OS scheduling priority.
//
// SCOPE (narrow, explicit allowlist — nothing else is touched)
//   - `graphify update ...` / `/graphify update ...`
//   - `graphify <path>` / `/graphify <path>` (a bare target path, no `query`
//     subcommand) — mirrors graphify-guard.js's write-shape classification
//     (classifyGraphifyArgs), NOT the exact same code (kept standalone per
//     repo convention that hooks are self-contained scripts), but the same
//     semantics: `graphify query ...` is a READ and is never matched here.
//   - Any command segment matching a user-supplied regex in the
//     ANTI_HALL_THROTTLE_PATTERNS env var (comma-separated regex sources;
//     an individual pattern that fails to compile is silently skipped,
//     fail-open).
//
// SAFETY RULES
//   1. Platform probe: the throttle tool must actually exist on PATH (a pure
//      Node PATH scan, no subprocess spawn), computed once per process
//      (module-level cache). No known tool for the platform (or the probe
//      finds nothing) -> do nothing, silently — no rewrite, no note.
//   2. Idempotent: if the command already starts (after trimming leading
//      whitespace) with one of this hook's own exact generated prefixes, it
//      is left unchanged — never double-prefixed.
//   3. Position safety: the match must be in the command's FIRST simple
//      command (segment 0 of the quote/heredoc-aware split below). A match
//      anywhere else in a compound command (`cd x && graphify update .`) is
//      NOT rewritten — fail-open — and only a short advisory
//      `additionalContext` note is emitted instead. This hook does not
//      attempt to rewrite an arbitrary mid-command segment in place: if it
//      cannot position the prefix with total confidence, it does not guess.
//   4. Heredoc bodies and quoted strings are never scanned as commands (the
//      segment splitter below skips heredoc bodies as opaque data and is
//      quote-aware), so a scan-looking command that only appears as literal
//      text/data is never matched.
//   5. Kill switch: ANTI_HALL_SCAN_THROTTLE=0 disables this hook entirely.
//
// COMPOSITION WITH OTHER PreToolUse:Bash HOOKS — what was actually verified,
// and where. docs/KB-claude-code-hooks.md does NOT document how multiple
// hooks for the same event+matcher compose (confirmed by re-reading it — no
// such row exists there), so the following is sourced separately, directly
// from the live docs, NOT from the KB:
//   A WebFetch of https://code.claude.com/docs/en/hooks on 2026-09-05 (tool
//   fetches the page, converts to markdown, and has a small model summarize
//   it against a prompt — this is a SUMMARY of that page, not a byte-exact
//   HTML quote independently re-verified by this author) returned, under an
//   "Execution Model" heading: "All matching hooks run in parallel. If you
//   define the same handler in more than one settings file, it runs once."
//   The same fetch's summary additionally stated, in its own words rather
//   than as a further page quote: "if any hook blocks with exit code 2, the
//   tool call is prevented regardless of what other hooks return."
//   How multiple `updatedInput` outputs from parallel hooks are MERGED is
//   explicitly UNDOCUMENTED — the same fetch's response states: "The
//   documentation does not specify how multiple `updatedInput` outputs are
//   combined. This is a gap in the reference documentation provided."
//   Practical consequence for THIS hook, stated as best-effort reasoning
//   from the above (not as a separately-verified fact): this hook is
//   registered in hooks.json AFTER git-guard/command-guard/graphify-guard/
//   merge-gate for human readability only (deny-guards read first in the
//   file); JSON-array order is not known to control actual precedence. If a
//   block from another Bash PreToolUse hook and this hook's rewrite fire on
//   the same call, this hook's own summarized understanding of the block
//   behavior above says the block should still take effect — but the
//   updatedInput-merge gap means this is not fully verified end-to-end for
//   a case where BOTH a block and an updatedInput are returned in the same
//   parallel batch. Re-verify directly against the live docs (not this
//   comment, not the KB) before relying on this for anything safety-critical.
//
// Contract (Claude Code PreToolUse hook):
//   stdin  : JSON { tool_name, tool_input: { command }, ... }
//   stdout : JSON { hookSpecificOutput: { hookEventName: "PreToolUse",
//              updatedInput: { command: "<rewritten>" } } }   (rewrite)
//          | JSON { hookSpecificOutput: { hookEventName: "PreToolUse",
//              additionalContext: "..." } }                    (advisory only)
//          | nothing                                            (no match /
//              unavailable / killed / already prefixed)
//   exit 0 always — this hook never blocks a tool call.
//   Fail-open on ANY error (exit 0, no output).

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Segment splitter — quote-aware, heredoc-aware. Mirrors graphify-guard.js's
// splitSegments byte-for-byte (kept standalone per repo convention that hooks
// are self-contained scripts, not a shared module).
// ---------------------------------------------------------------------------
const HEREDOC_RE = /^<<(-)?\s*("([^"]*)"|'([^']*)'|([A-Za-z_][A-Za-z0-9_]*))/;

function splitSegments(cmd) {
  const segments = [];
  let cur = '';
  let i = 0;
  const n = cmd.length;
  let inSingle = false;
  let inDouble = false;
  function flush() { if (cur.trim().length) segments.push(cur); cur = ''; }
  while (i < n) {
    const c = cmd[i];
    const c2 = i + 1 < n ? cmd[i + 1] : '';
    if (inSingle) { cur += c; if (c === "'") inSingle = false; i++; continue; }
    if (inDouble) {
      if (c === '\\' && c2) { cur += c + c2; i += 2; continue; }
      cur += c; if (c === '"') inDouble = false; i++; continue;
    }
    if (c === "'") { inSingle = true; cur += c; i++; continue; }
    if (c === '"') { inDouble = true; cur += c; i++; continue; }
    if (c === '<' && c2 === '<') {
      const m = HEREDOC_RE.exec(cmd.slice(i));
      const word = m ? (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5])) : '';
      if (m && word) {
        const dashStrip = !!m[1];
        cur += m[0];
        i += m[0].length;
        let lineEnd = cmd.indexOf('\n', i);
        if (lineEnd === -1) lineEnd = n;
        cur += cmd.slice(i, lineEnd);
        i = lineEnd;
        if (i < n && cmd[i] === '\n') i++;
        while (i < n) {
          const nextNl = cmd.indexOf('\n', i);
          const lineRaw = nextNl === -1 ? cmd.slice(i) : cmd.slice(i, nextNl);
          const line = dashStrip ? lineRaw.replace(/^\t+/, '') : lineRaw;
          i += (nextNl === -1 ? (cmd.length - i) : (nextNl - i + 1));
          if (line === word) break;
          if (nextNl === -1) break; // unterminated heredoc: consumed to EOF
        }
        flush();
        continue;
      }
    }
    if (c === '&' && c2 === '&') { flush(); i += 2; continue; }
    if (c === '|' && c2 === '|') { flush(); i += 2; continue; }
    if (c === '|') { flush(); i++; continue; }
    if (c === ';') { flush(); i++; continue; }
    if (c === '&') { flush(); i++; continue; }
    if (c === '\n') { flush(); i++; continue; }
    if (c === ')' || c === '(' || c === '{' || c === '}') { flush(); i++; continue; }
    if (c === '$' && c2 === '(') { flush(); i += 2; continue; }
    if (c === '`') { flush(); i++; continue; }
    cur += c; i++;
  }
  flush();
  return segments;
}

// ---------------------------------------------------------------------------
// graphify scan-shape classifier (read vs write, simplified from
// graphify-guard.js's classifyGraphifyArgs — same semantics, standalone code).
// ---------------------------------------------------------------------------
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'sudo', 'env', 'nice',
  'nohup', 'time', 'timeout', 'then', 'do', 'else']);

function segmentVerbInfo(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  while (i < tokens.length) {
    const word = tokens[i].replace(/^.*[\\/]/, '').toLowerCase();
    if (!WRAPPERS.has(word)) break;
    i++;
    while (i < tokens.length &&
           (tokens[i].startsWith('-') ||
            (word === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])))) i++;
    if (word === 'timeout' && i < tokens.length && !tokens[i].startsWith('/')) i++;
  }
  return { rawVerb: tokens[i] || '', argsStart: i + 1, tokens };
}

function isGraphifyScanSegment(segment) {
  const { rawVerb, argsStart, tokens } = segmentVerbInfo(segment);
  if (!rawVerb) return false;
  // Same normalization as graphify-guard.js: strip a leading slash (the
  // /graphify slash-command form) THEN strip any path directory components
  // (a real filesystem path to a `graphify` binary), so both `/graphify` and
  // `/usr/local/bin/graphify` resolve to the bare verb `graphify`.
  const baseVerb = rawVerb.replace(/^\//, '').replace(/^.*[\\/]/, '').toLowerCase();
  if (baseVerb !== 'graphify') return false;
  const args = tokens.slice(argsStart);
  const firstNonFlag = args.find((a) => !a.startsWith('-'));
  if (!firstNonFlag) return false; // bare `graphify` / flags only -> uncertain, no match
  if (firstNonFlag === 'query') return false; // explicit read -> never throttled
  return true; // `update` subcommand OR a bare target path -> scan/write shape
}

function parseUserPatterns(envVal) {
  if (!envVal || typeof envVal !== 'string') return [];
  const out = [];
  for (const src of envVal.split(',').map((s) => s.trim()).filter(Boolean)) {
    try { out.push(new RegExp(src)); } catch (_) { /* skip invalid pattern */ }
  }
  return out;
}

function segmentMatchesAllowlist(segment, userPatterns) {
  if (isGraphifyScanSegment(segment)) return true;
  for (const pat of userPatterns) {
    try { if (pat.test(segment)) return true; } catch (_) { /* fail-open */ }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Platform probe — pure Node PATH scan, no subprocess spawn. Cached per
// process (module-level Map) so repeated lookups within one hook invocation
// never re-scan PATH.
// ---------------------------------------------------------------------------
const probeCache = new Map();

function probeOnPath(tool) {
  if (probeCache.has(tool)) return probeCache.get(tool);
  let found = false;
  try {
    const PATH = process.env.PATH || '';
    for (const dir of PATH.split(path.delimiter)) {
      if (!dir) continue;
      try {
        const st = fs.statSync(path.join(dir, tool));
        if (st.isFile()) { found = true; break; }
      } catch (_) { /* not in this dir */ }
    }
  } catch (_) { found = false; }
  probeCache.set(tool, found);
  return found;
}

// computeThrottlePrefix() -> the exact prefix string to prepend, or null if
// no throttle tool is available on this platform. NEVER probes when the kill
// switch is set (caller checks that first).
function computeThrottlePrefix() {
  const plat = process.platform;
  if (plat === 'darwin') {
    if (probeOnPath('taskpolicy')) return 'taskpolicy -c utility nice -n 19 ';
    return null;
  }
  if (plat === 'linux') {
    if (!probeOnPath('nice')) return null;
    const ionicePrefix = probeOnPath('ionice') ? 'ionice -c 3 ' : '';
    return ionicePrefix + 'nice -n 19 ';
  }
  return null; // unsupported platform: no known throttle tool
}

// Exact prefixes this hook itself ever generates (see computeThrottlePrefix).
// Idempotency is checked as an ANCHORED startsWith against the trimmed
// command — never a substring/`includes` check anywhere in the command —
// so a command that merely CONTAINS this text later (not at the very start)
// is correctly treated as unprefixed and still eligible for a fresh rewrite.
const KNOWN_PREFIXES = [
  'taskpolicy -c utility nice -n 19 ',
  'ionice -c 3 nice -n 19 ',
  'nice -n 19 ',
];

function alreadyPrefixed(command) {
  const trimmed = command.replace(/^\s+/, '');
  return KNOWN_PREFIXES.some((p) => trimmed.startsWith(p));
}

// ---------------------------------------------------------------------------
// Leading env-assignment handling (P1 fix).
//
// A naive `prefix + command` rewrite breaks `GRAPHIFY_X=1 graphify update .`:
// the assignment ends up positioned as an ARGUMENT to `nice`/`taskpolicy`
// (`taskpolicy -c utility nice -n 19 GRAPHIFY_X=1 graphify update .`), and
// `nice` tries to exec the literal string `GRAPHIFY_X=1` as a command ->
// `No such file or directory`, exit 127 — the real command never runs. Shell
// assignment-prefix semantics only apply when NAME=value tokens are the
// FIRST thing in a simple command; once something else (a wrapper program)
// is inserted before them, they are just plain argv words to that program.
//
// Fix: detect one or more leading `NAME=value` assignments (POSIX name,
// quoted or unquoted value) and RE-ATTACH them before the prefix instead of
// after it: `GRAPHIFY_X=1 taskpolicy -c utility nice -n 19 graphify update .`
// — valid, because a leading assignment on a simple command applies to
// (exports into) that whole simple command's exec chain, including a
// wrapper program that then execs a further program.
// ---------------------------------------------------------------------------
const ASSIGN_ONE_RE = /^[A-Za-z_][A-Za-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]*)/;

// stripLeadingAssignments(command) -> the index in `command` where the
// "rest" (the actual command, past any leading whitespace and leading
// NAME=value assignment tokens) begins. `command.slice(0, idx)` is the
// leading whitespace + assignments + their separating whitespace, verbatim;
// `command.slice(idx)` is the rest. Only consumes an assignment token when
// it is followed by whitespace (i.e. clearly its own token) — an ambiguous
// trailing token (`FOO=1` at the very end of the string with nothing after
// it, or glued to non-whitespace) is left alone rather than guessed at.
function stripLeadingAssignments(command) {
  let i = /^\s*/.exec(command)[0].length;
  while (true) {
    const slice = command.slice(i);
    const m = ASSIGN_ONE_RE.exec(slice);
    if (!m) break;
    const afterAssign = i + m[0].length;
    const wsMatch = /^\s+/.exec(command.slice(afterAssign));
    if (!wsMatch) break; // not clearly a standalone assignment token -> stop
    i = afterAssign + wsMatch[0].length;
  }
  return i;
}

// looksLikeUnsafeInsertionPoint(rest) — true when `rest` (the command text
// starting at the point where the prefix would be inserted, i.e. right after
// any leading assignments) begins with a shell token that is NOT itself the
// start of a plain simple command: `(` (subshell), `{` (brace group), `;`,
// `|`, `&`, a backtick, or `$(` (command substitution). splitSegments()
// treats each of these as an immediate flush point BEFORE any text is
// accumulated, which means the classifier's matched "first segment" can
// silently refer to text that does NOT actually start at this insertion
// point (P1 fix #2: `( graphify update . )` was misclassified as a safe
// segment-0 match and rewritten to `taskpolicy ... ( graphify update . )`,
// a bash syntax error, because `(` had already triggered an empty flush).
// Inserting a prefix directly before any of these characters would corrupt
// or misparse the command, so treat it as unsafe and refuse to rewrite.
function looksLikeUnsafeInsertionPoint(rest) {
  if (!rest) return true; // nothing left to prefix
  if (/^[)(;{}|&`]/.test(rest)) return true;
  if (rest.startsWith('$(')) return true;
  return false;
}

function emit(hookSpecificOutputExtra) {
  const out = {
    hookSpecificOutput: Object.assign({ hookEventName: 'PreToolUse' }, hookSpecificOutputExtra),
  };
  try {
    // fs.writeSync(1, ...) not process.stdout.write — CLAUDE.md: on macOS
    // node 18/20 a synchronous exit right after process.stdout.write can
    // race the async pipe flush and truncate the JSON; writeSync is atomic.
    fs.writeSync(1, JSON.stringify(out) + '\n');
  } catch (_) { /* fail-open: nothing we can do about a write failure */ }
}

function main() {
  if (process.env.ANTI_HALL_SCAN_THROTTLE === '0') return;

  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    return;
  }

  const toolName = (payload && typeof payload.tool_name === 'string') ? payload.tool_name : '';
  if (toolName !== 'Bash') return;

  const toolInput = (payload && payload.tool_input) || {};
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  if (!command.trim()) return;

  const prefix = computeThrottlePrefix();
  if (!prefix) return; // no throttle tool on this platform -> do nothing, silently

  if (alreadyPrefixed(command)) return; // idempotent: never double-prefix

  const segments = splitSegments(command);
  if (!segments.length) return;

  const userPatterns = parseUserPatterns(process.env.ANTI_HALL_THROTTLE_PATTERNS);

  let matchIndex = -1;
  for (let idx = 0; idx < segments.length; idx++) {
    if (segmentMatchesAllowlist(segments[idx], userPatterns)) { matchIndex = idx; break; }
  }
  if (matchIndex === -1) return; // no scan command anywhere -> untouched, silently

  // Position safety: the match must be (1) the command's first simple
  // command (matchIndex === 0 over the FULL command's segments), AND (2) the
  // literal insertion point for the prefix — right after any leading
  // NAME=value assignments — must not be a subshell/group/other shell
  // boundary token (see looksLikeUnsafeInsertionPoint). Both are required:
  // matchIndex alone is fooled by a leading `(`/`{` (splitSegments flushes
  // an empty segment there, so the "first segment" it reports does not
  // actually start at offset 0 of the raw string); the insertion-point check
  // alone is fooled by `FOO=1 cd app && graphify update .` (insertion point
  // right after `FOO=1 ` looks like plain text, but the real match is a
  // LATER segment, not this one).
  const restStart = stripLeadingAssignments(command);
  const leadingText = command.slice(0, restStart);
  const rest = command.slice(restStart);
  const positionSafe = matchIndex === 0 && !looksLikeUnsafeInsertionPoint(rest);

  if (!positionSafe) {
    // A scan command exists, but this hook cannot position the prefix with
    // total confidence (mid-compound match, or wrapped in a subshell/brace
    // group) — fail-open: leave it unmodified and only surface a short
    // advisory note.
    emit({
      additionalContext:
        'SCAN-THROTTLE: a repo-wide scan command was detected but this hook ' +
        'could not confidently position a throttle prefix for it (not the ' +
        'first simple command, or wrapped in a subshell/brace group), so it ' +
        'was left unmodified (fail-open — this hook never guesses a rewrite ' +
        'position). Consider running it background-throttled manually, e.g. ' +
        '`' + prefix.trim() + ' <that command>`.',
    });
    return;
  }

  // Safe case: the match is the command's first simple command, and the
  // insertion point (right after any leading assignments) is plain command
  // text, not a shell boundary token. RE-ATTACH any leading `NAME=value`
  // assignments BEFORE the prefix (not after it) — a leading assignment on a
  // simple command applies to that command's whole exec chain, including a
  // wrapper program inserted before the real one, so
  // `GRAPHIFY_X=1 graphify update .` becomes
  // `GRAPHIFY_X=1 taskpolicy -c utility nice -n 19 graphify update .`
  // (valid), never `taskpolicy ... GRAPHIFY_X=1 graphify update .`
  // (invalid — `nice` would try to exec the literal string `GRAPHIFY_X=1`).
  const rewritten = leadingText + prefix + rest;
  emit({ updatedInput: { command: rewritten } });
}

try {
  main();
} catch (_) {
  // Fail-open: never surface a hook bug to the model, never block.
}
process.exit(0);
