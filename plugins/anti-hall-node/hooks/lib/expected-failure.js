// anti-hall :: expected-failure — "did this Bash call fail on purpose?"
//
// ROOT CAUSE this addresses (failure-root-cause-nudge): PostToolUseFailure fires
// for EVERY non-zero exit, but several commands use the exit status as their
// ANSWER, not as an error: `grep` with no match, `test -f x`, `diff a b`,
// `git diff --quiet`, `command -v tool`. Telling the model to "trace WHY it
// failed" after `grep -q foo file` exits 1 is a false positive. A field scan of
// 30 days of transcripts found these are a large share of the nudges (see the
// CHANGELOG entry for the measured numbers).
//
// SCOPE DISCIPLINE: precision over recall. `isExpectedNonzero` returns true ONLY
// when the whole exit status provably comes from a predicate command:
//   - the exit code is exactly 1 (grep/diff use 2+ for real errors),
//   - the FINAL statement of the command decides the status (`;`/newline lists),
//   - and that statement's deciding command is a predicate: the last stage of a
//     pipeline, or every link of an `&&` chain.
// Anything it cannot parse with certainty (heredocs, subshells, `||`, loops,
// `set -e`, `pipefail`, `eval`, command substitution in the decider, ...)
// returns false, so the nudge keeps firing. A wrong "false" costs one short
// reminder; a wrong "true" would hide a real failure.
//
// Pure functions, no fs/process access, never throw.

'use strict';

// Verbs whose exit status 1 means "no / different / false", not "broke".
const PREDICATE_VERBS = new Set([
  'grep', 'egrep', 'fgrep', 'ugrep', 'rg', 'ag', 'ack',
  'test', '[', '[[', 'diff', 'cmp', 'pgrep', 'which', 'type',
]);
// Statements that cannot fail on their own and may sit in an `&&` chain.
const TRIVIAL_VERBS = new Set(['echo', 'printf', 'true', ':']);
// Wrappers that pass the inner command's exit status through unchanged.
const PASS_THROUGH = new Set(['command', 'builtin', 'env', 'time', 'nice', 'nohup']);

// Constructs that make "the last statement decides the status" unsafe or
// unparseable here -> never classify as expected.
const BAIL_RE = /<<|\bset\s+-[A-Za-z]*e|\bset\s+-o\b|\bpipefail\b|\berrexit\b|\btrap\b|\bexec\b|\beval\b|\bbash\s+-[A-Za-z]*e\b|\bsh\s+-[A-Za-z]*e\b/;

// splitTop(cmd, seps) -> string[]. Splits on top-level separators only: outside
// quotes, backticks, $(...) and ${...}. `seps` is an array of tokens tried
// longest-first. Returns null when quoting/nesting is unbalanced.
function splitTop(cmd, seps) {
  const out = [];
  let cur = '';
  let i = 0;
  let depth = 0;       // $( ) / ( ) / { } nesting
  let quote = '';      // '"' or "'" or '`'
  const n = cmd.length;
  while (i < n) {
    const c = cmd[i];
    if (quote === "'") { cur += c; if (c === "'") quote = ''; i++; continue; }
    if (c === '\\') { cur += c + (cmd[i + 1] || ''); i += 2; continue; }
    if (quote === '"') {
      cur += c;
      if (c === '"') quote = '';
      else if (c === '$' && cmd[i + 1] === '(') { depth++; cur += '('; i++; }
      i++; continue;
    }
    if (quote === '`') { cur += c; if (c === '`') quote = ''; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; i++; continue; }
    if (c === '(' || c === '{') { depth++; cur += c; i++; continue; }
    if (c === ')' || c === '}') { if (depth > 0) depth--; cur += c; i++; continue; }
    if (depth === 0) {
      let hit = null;
      for (const s of seps) { if (cmd.startsWith(s, i)) { hit = s; break; } }
      if (hit) { out.push(cur); cur = ''; i += hit.length; continue; }
    }
    cur += c; i++;
  }
  if (quote) return null;
  out.push(cur);
  return out;
}

// Verb of one simple command: skips leading VAR=val assignments and pass-through
// wrappers, returns { verb, args } (basename of the verb) or null.
function simpleVerb(seg) {
  let s = seg.trim();
  if (!s || s[0] === '(' || s[0] === '{' || s[0] === '!') return null;
  const toks = s.split(/\s+/);
  let i = 0;
  for (;;) {
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
    if (i < toks.length && PASS_THROUGH.has(toks[i])) { i++; continue; }
    if (i < toks.length && toks[i] === '-v' && i > 0 && toks[i - 1] === 'command') return { verb: 'command -v', args: toks.slice(i + 1) };
    break;
  }
  if (i >= toks.length) return null;
  const verb = toks[i].replace(/^.*\//, '');
  return { verb, args: toks.slice(i + 1) };
}

// `command -v x` / `type x` / `which x`: handled via simpleVerb after the
// PASS_THROUGH skip would eat `command`, so recognise `command -v` first.
function isPredicate(seg) {
  const t = seg.trim();
  if (/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*command\s+-[vV]\b/.test(t)) return true;
  const sv = simpleVerb(t);
  if (!sv) return false;
  if (PREDICATE_VERBS.has(sv.verb)) return true;
  if (sv.verb === 'git') {
    // git <read-only predicate>: exit 1 is the answer.
    const rest = sv.args.join(' ');
    if (/^(?:-C\s+\S+\s+)?diff\b.*(?:--quiet|--exit-code)\b/.test(rest)) return true;
    if (/^(?:-C\s+\S+\s+)?merge-base\b.*--is-ancestor\b/.test(rest)) return true;
    if (/^(?:-C\s+\S+\s+)?grep\b/.test(rest)) return true;
    if (/^(?:-C\s+\S+\s+)?cat-file\b.*\s-e\b/.test(rest)) return true;
    if (/^(?:-C\s+\S+\s+)?ls-files\b.*--error-unmatch\b/.test(rest)) return true;
    if (/^(?:-C\s+\S+\s+)?show-ref\b.*(?:--verify|--quiet|-q)\b/.test(rest)) return true;
  }
  return false;
}

function isTrivial(seg) {
  const sv = simpleVerb(seg);
  return !!sv && TRIVIAL_VERBS.has(sv.verb);
}

// Exit code from the PostToolUseFailure `error` text ("Exit code N\n...").
// null when not stated.
function exitCodeOf(errorText) {
  if (typeof errorText !== 'string') return null;
  const m = /^\s*Exit code (\d+)\b/.exec(errorText);
  return m ? parseInt(m[1], 10) : null;
}

// Harness/guard refusals: the command never ran, so "this command failed" is
// wrong and the refusal text already carries its own instruction.
function isHarnessRefusal(errorText) {
  return typeof errorText === 'string' &&
    /^\s*This (?:agent|session) is isolated in the worktree\b/.test(errorText);
}

// isExpectedNonzero(command, errorText) -> boolean (see header).
function isExpectedNonzero(command, errorText) {
  try {
    if (typeof command !== 'string' || !command.trim()) return false;
    if (exitCodeOf(errorText) !== 1) return false;
    if (BAIL_RE.test(command)) return false;
    // Line continuations join physical lines into one logical line.
    const flat = command.replace(/\\\n/g, ' ');
    const stmts = splitTop(flat, [';', '\n']);
    if (!stmts) return false;
    // A trailing `&` / `|` (background / dangling pipe) or empty tail -> bail.
    let last = null;
    for (let k = stmts.length - 1; k >= 0; k--) { if (stmts[k].trim()) { last = stmts[k].trim(); break; } }
    if (!last) return false;
    if (/&\s*$/.test(last) && !/&&\s*$/.test(last)) return false;
    if (/^\s*(?:#|$)/.test(last)) return false;
    if (/^(?:if|for|while|until|case|select|function|do|then|else|fi|done|esac)\b/.test(last)) return false;
    if (splitTop(last, ['||']).length > 1) return false;
    const links = splitTop(last, ['&&']);
    if (!links) return false;
    let sawPredicate = false;
    for (const link of links) {
      const stages = splitTop(link, ['|&', '|']);
      if (!stages) return false;
      const decider = stages[stages.length - 1];
      // The decider must be a plain command: no command substitution deciding
      // the status, no redirection-only tricks that hide the verb.
      if (/\$\(|`/.test(decider.split(/\s(?:2?>|&>|<)/)[0])) return false;
      if (isPredicate(decider)) { sawPredicate = true; continue; }
      if (links.length > 1 && isTrivial(decider) && stages.length === 1) continue;
      return false;
    }
    return sawPredicate;
  } catch (_) {
    return false;
  }
}

module.exports = { isExpectedNonzero, isHarnessRefusal, exitCodeOf, splitTop };
