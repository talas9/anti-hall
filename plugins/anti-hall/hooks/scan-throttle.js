#!/usr/bin/env node
// anti-hall :: scan-throttle (PreToolUse Bash) — additive background-throttle
// prefix for heavy repo-wide scan commands.
//
// WHAT IT DOES
//   ADVISORY ONLY. When a command matches a user-configured heavy-scan
//   pattern, emits `hookSpecificOutput.additionalContext` recommending the
//   background-throttled form (macOS: `taskpolicy -c utility nice -n 19 <cmd>`;
//   Linux: `nice -n 19 <cmd>`, optionally preceded by `ionice -c 3 ` when
//   available). It NEVER rewrites the command and never
//   returns a permission decision: the model decides
//   whether to re-run the command throttled.
//
// SCOPE (generic — NO built-in patterns; entirely user-configured)
//   - This hook ships with zero built-in allowlist entries. It matches
//     NOTHING unless the operator sets ANTI_HALL_THROTTLE_PATTERNS: a
//     comma-separated list of regex sources, tested against each command
//     segment (an individual pattern that fails to compile is silently
//     skipped, fail-open). Configure it for whatever heavy repo-wide scan
//     command your own workflow uses.
//
// SAFETY RULES
//   1. Platform probe: the throttle tool must actually exist on PATH (a pure
//      Node PATH scan, no subprocess spawn), computed once per process
//      (module-level cache). No known tool for the platform (or the probe
//      finds nothing) -> do nothing, silently — no note.
//   2. Idempotent: if the command already starts (after trimming leading
//      whitespace) with one of this hook's own exact generated prefixes, it
//      is left unchanged — never double-prefixed.
//   3. Position safety: when the match is in the command's FIRST simple
//      command (segment 0 of the quote/heredoc-aware split below) the advisory
//      quotes the exact throttled form. A match anywhere else in a compound
//      command (`cd x && reindex-repo --full`) gets a generic advisory
//      instead: this hook does not guess where a prefix would go.
//   4. Heredoc bodies and quoted strings are never scanned as commands (the
//      segment splitter below skips heredoc bodies as opaque data and is
//      quote-aware), so a scan-looking command that only appears as literal
//      text/data is never matched.
//   5. Kill switch: ANTIHALL_SCAN_THROTTLE=0 (deprecated alias ANTI_HALL_SCAN_THROTTLE), or setting guards.scanThrottle=false,
//      disables this hook entirely.
//
// COMPOSITION WITH OTHER PreToolUse:Bash HOOKS: because this hook emits only
// `additionalContext` (it never rewrites the command or returns a permission decision), it
// cannot conflict with, override or mask a block from git-guard/command-guard/
// merge-gate, however parallel hook outputs are merged.
//
// Contract (Claude Code PreToolUse hook):
//   stdin  : JSON { tool_name, tool_input: { command }, ... }
//   stdout : JSON { hookSpecificOutput: { hookEventName: "PreToolUse",
//              additionalContext: "..." } }                    (advisory only)
//          | nothing                                            (no match /
//              unavailable / killed / already prefixed)
//   exit 0 always — this hook never blocks a tool call.
//   Fail-open on ANY error (exit 0, no output).

'use strict';

const fs = require('fs');
const io = require('./lib/guard-io.js');
const path = require('path');
const { parseHeredocAt } = require('./lib/shell-scan.js');

// ---------------------------------------------------------------------------
// Segment splitter — quote-aware, heredoc-aware. Heredoc CONSTRUCT parsing
// (the opener + body + terminator) is delegated to lib/shell-scan.js's
// parseHeredocAt — shared with command-guard.js/git-guard.js — instead of
// this file's own previously-standalone HEREDOC_RE copy, which lacked the
// `<<<` here-string, full-delimiter-word (`<<EOF#x` terminates on `EOF#x`,
// not `EOF`), and `$((1<<y))` arithmetic-context fixes shell-scan.js picked
// up from repeated command-guard/git-guard patches. This hook only drives
// background-throttle rewriting (not a security gate), but there is still
// exactly one heredoc parser in the repo, not three.
// ---------------------------------------------------------------------------
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
      const parsed = parseHeredocAt(cmd, i);
      if (parsed) {
        // Keep only the opener line on the current segment (the body is
        // opaque data, never scanned as a command) — same convention as
        // command-guard.js's own parseHeredocAt call site.
        cur += parsed.openerText;
        i = parsed.end;
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
// User-configured pattern matching. This hook has NO built-in scan patterns
// of its own — see the header comment. Everything it matches comes from
// ANTI_HALL_THROTTLE_PATTERNS.
// ---------------------------------------------------------------------------
function parseUserPatterns(envVal) {
  if (!envVal || typeof envVal !== 'string') return [];
  const out = [];
  for (const src of envVal.split(',').map((s) => s.trim()).filter(Boolean)) {
    try { out.push(new RegExp(src)); } catch (_) { /* skip invalid pattern */ }
  }
  return out;
}

function segmentMatchesAllowlist(segment, userPatterns) {
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
let probeEnv = process.env; // the env of the current evaluate() call

function probeOnPath(tool) {
  if (probeCache.has(tool)) return probeCache.get(tool);
  let found = false;
  try {
    const PATH = probeEnv.PATH || '';
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
// A naive `prefix + command` rewrite breaks `SCANENV=1 reindex-repo --full`:
// the assignment ends up positioned as an ARGUMENT to `nice`/`taskpolicy`
// (`taskpolicy -c utility nice -n 19 SCANENV=1 reindex-repo --full`), and
// `nice` tries to exec the literal string `SCANENV=1` as a command ->
// `No such file or directory`, exit 127 — the real command never runs. Shell
// assignment-prefix semantics only apply when NAME=value tokens are the
// FIRST thing in a simple command; once something else (a wrapper program)
// is inserted before them, they are just plain argv words to that program.
//
// Fix: detect one or more leading `NAME=value` assignments (POSIX name,
// quoted or unquoted value) and RE-ATTACH them before the prefix instead of
// after it: `SCANENV=1 taskpolicy -c utility nice -n 19 reindex-repo --full`
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
// point (P1 fix #2: `( reindex-repo --full )` was misclassified as a safe
// segment-0 match and rewritten to `taskpolicy ... ( reindex-repo --full )`,
// a bash syntax error, because `(` had already triggered an empty flush).
// Inserting a prefix directly before any of these characters would corrupt
// or misparse the command, so treat it as unsafe and refuse to rewrite.
function looksLikeUnsafeInsertionPoint(rest) {
  if (!rest) return true; // nothing left to prefix
  if (/^[)(;{}|&`]/.test(rest)) return true;
  if (rest.startsWith('$(')) return true;
  return false;
}

function emit(out, hookSpecificOutputExtra) {
  out.json({
    hookSpecificOutput: Object.assign({ hookEventName: 'PreToolUse' }, hookSpecificOutputExtra),
  });
}

function main(payload, env, out) {
  // Setting guards.scanThrottle (env ANTIHALL_SCAN_THROTTLE=0 (deprecated alias ANTI_HALL_SCAN_THROTTLE) still wins).
  // Fail-open: any error runs the hook.
  try { if (!require('./lib/settings.js').enabled('guards', 'scanThrottle')) return; } catch (_) { /* run */ }

  if (payload === undefined) return; // unreadable / unparseable stdin

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

  const userPatterns = parseUserPatterns(env.ANTI_HALL_THROTTLE_PATTERNS);

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
  // alone is fooled by `FOO=1 cd app && reindex-repo --full` (insertion point
  // right after `FOO=1 ` looks like plain text, but the real match is a
  // LATER segment, not this one).
  const restStart = stripLeadingAssignments(command);
  const leadingText = command.slice(0, restStart);
  const rest = command.slice(restStart);
  const positionSafe = matchIndex === 0 && !looksLikeUnsafeInsertionPoint(rest);

  if (!positionSafe) {
    // A scan command exists, but the prefix position is not unambiguous
    // (mid-compound match, or wrapped in a subshell/brace group): generic note.
    emit(out, {
      additionalContext: require('./lib/block-message.js').message({
        kind: 'tip',
        guard: 'scan-throttle',
        what: 'a repo-wide scan command was detected in a compound or grouped command (not the first simple command); it was NOT modified.',
        instead: 'consider running the scan background-throttled, e.g. `' + prefix.trim() + ' <that command>`.',
      }),
    });
    return;
  }

  // Safe case: first simple command. Quote the throttled form (leading
  // `NAME=value` assignments stay BEFORE the prefix — `nice` would otherwise
  // try to exec the literal `NAME=value`). Advisory only; input is untouched.
  const throttled = leadingText + prefix + rest;
  emit(out, {
    additionalContext: require('./lib/block-message.js').message({
      kind: 'tip',
      guard: 'scan-throttle',
      what: 'this is a heavy repo-wide scan; the command was NOT modified.',
      why: 'To keep the machine responsive.',
      instead: 're-run it background-throttled: `' + throttled + '`.',
    }),
  });
}

function evaluate(payload, env) {
  const out = io.recorder();
  probeCache.clear();
  probeEnv = env || process.env;
  try { main(payload, probeEnv, out); } catch (_) { /* fail-open: never surface a hook bug to the model, never block */ }
  return out.done(0);
}

module.exports = { evaluate };

if (require.main === module) io.runCli(evaluate);
