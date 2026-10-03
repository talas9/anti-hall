// anti-hall :: shell-scan (shared shell-text primitives)
//
// command-guard.js and git-guard.js each independently parse shell command
// text. Their heredoc-body-walking loop in particular has been patched
// repeatedly across releases (command-guard: 0.10/0.12/0.17/0.83/0.89/0.104;
// this file's own introduction closes that recurring defect class). This
// module extracts the pieces that ARE byte-identical (or safely unifiable)
// between the two guards into ONE implementation, so the next heredoc/quote
// fix lands once instead of twice.
//
// SCOPE DISCIPLINE (deliberate, see plugins/anti-hall/hooks/git-guard.js's
// own extractHeredocBodies header): git-guard once folded heredoc-body
// consumption INTO its segment splitter and that changed how a heredoc
// opener line's trailing `&&`/`;`/`|`/`|&` control operators were parsed,
// silently swallowing a chained `git push --force` into the heredoc-opener's
// own segment — a live guard bypass (fixed by making heredoc extraction a
// SEPARATE side-channel scan over the raw command, not part of
// segmentation). Because of that proven regression, this module does NOT
// force git-guard's splitSegments (which needs a CMDSUBST_SENTINEL and
// redirect-aware `&`/`&>`/`>&` handling for its force-push-arg-smuggling
// detection) and command-guard's splitSegments (which needs to SKIP heredoc
// bodies inline as part of segmentation, per its own P2 fp history) onto one
// shared splitSegments implementation. Each guard keeps its own segment
// splitter and its own effectiveVerb/WRAPPERS (git-guard's quotedOnly-aware
// verb/assignment detection is load-bearing for its self-credit/force-push
// hardening and is not safe to swap for a different algorithm under a
// "never get weaker" bar). What IS shared here is genuinely duplicated,
// low-level, guard-agnostic shell-text parsing: heredoc-construct parsing,
// the heredoc opener regex, cross-platform basename, the shell-interpreter
// verb set, and command-guard's quote-aware tokenizer / substitution
// extractor (used internally by command-guard only; exported here so a
// future guard can reuse them instead of re-implementing).
//
// Every exported function is PURE (no fs/process access) and fail-soft: on
// malformed input it degrades to "no match" rather than throwing.

'use strict';

// Heredoc opener regex: <<[-]WORD, <<'WORD', <<"WORD", <<WORD. Captures the
// dash (tab-stripping mode) and the terminator word (quoted or bare).
const HEREDOC_RE = /^<<(-)?\s*("([^"]*)"|'([^']*)'|([A-Za-z_][A-Za-z0-9_]*))/;

// Cross-platform basename: handle both / and \ path separators so
// /usr/bin/npm and \npm resolve to npm.
function basename(p) {
  if (!p) return p;
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1];
}

// Shell interpreters whose `-c "<payload>"` argument is itself a shell
// command. Both command-guard's prior set and git-guard's prior set already
// covered bash/sh/zsh/dash/ksh/ash; this shared set preserves that coverage
// for both guards without narrowing either.
const SHELL_VERBS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);

// parseHeredocAt(cmd, i) -> null | {
//   end,          // index just past the whole heredoc construct (opener+body,
//                  // or EOF if unterminated)
//   openerText,    // cmd.slice(i, <newline that starts the body>) — the opener
//                  // line verbatim (e.g. "<<'EOF'" or "<<-EOF >>file"), or the
//                  // whole rest of the string when the opener has no trailing
//                  // newline at all
//   word, quoted, dashStrip,
//   body,          // heredoc body text, lines joined with '\n' ('' if none)
//   terminated,    // whether the WORD terminator line was found before EOF
// }
// Requires cmd[i] === '<' && cmd[i+1] === '<'; returns null if that is not a
// real heredoc opener (e.g. `$((1<<2))` — a plain arithmetic left-shift, not
// `<<` at token position — never matches HEREDOC_RE because a digit/`(`/space
// does not follow the `<<(-)?` prefix the way a WORD/quote does).
// A letter-led shift operand (`$((1<<y))`, `(( x = 1<<y ))`, `$[1<<y]`) DOES
// match HEREDOC_RE, so `<<` inside an open arithmetic context is rejected
// separately (inArithmeticAt below) — otherwise its "body" swallowed every
// following line, including real commands bash runs.
// Per real shell behavior, an UNTERMINATED heredoc's body is the REST of the
// command (bash keeps reading looking for the terminator until EOF) — this
// only ever makes a caller see MORE text, never less.
function parseHeredocAt(cmd, i) {
  if (inArithmeticAt(cmd, i)) return null;
  return parseHeredocRaw(cmd, i);
}

// inArithmeticAt(cmd, pos) -> true when `pos` lies inside an open `$((`, `((`
// or `$[` whose innermost enclosing context is arithmetic (a `$( … )` opened
// inside the arithmetic is a real command context again). A left-to-right
// scan of cmd[0, pos) tracking quotes, backslashes, ANSI-C `$'…'`, the
// `$((`/`((`/`$[`/`$(`/`(`/`[` stack and earlier heredoc bodies. It is an
// approximation that can only err toward "arithmetic" (the caller then skips
// no heredoc body — stricter) or toward the pre-existing answer; it never
// makes a caller skip more text than before.
//
// PERF (R2C1-3): both git-guard.js's and command-guard.js's splitSegments
// call this (directly, and via parseHeredocAt below) once per `<<` found
// during a SINGLE left-to-right scan of the SAME command string — i.e. at
// strictly non-decreasing `pos` for a given `cmd`. Rescanning cmd[0, pos)
// from scratch on every call turned that O(n) single pass into O(n^2): a
// ~96 KB adversarial input with many `<<` inside an open arithmetic context
// took ~30s (over git-guard's 10s hook timeout), so a trailing force push
// could go unjudged. `_scanState` caches the scan position/stack/quote-state
// between calls and resumes from where the LAST call for this exact `cmd`
// string left off, instead of restarting at 0 — making the common
// monotonically-increasing-pos pattern O(1) amortised per call while leaving
// the function's behavior (and its correctness for an arbitrary/out-of-order
// `pos`, which falls back to a full rescan) unchanged for every caller.
let _scanState = null; // { cmd, j, stack, inSingle, inDouble, skipFrom, skipTo }

function inArithmeticAt(cmd, pos) {
  const n = cmd.length;
  let st = _scanState;
  if (!st || st.cmd !== cmd || st.j > pos) {
    st = _scanState = { cmd, j: 0, stack: [], inSingle: false, inDouble: false, skipFrom: -1, skipTo: -1 };
  }
  while (st.j < pos) {
    if (st.skipFrom !== -1 && st.j >= st.skipFrom) {
      // Target `pos` falls inside a heredoc body being skipped over — answer
      // without consuming the skip (a LATER, larger `pos` must still resume
      // the skip from here), so leave st.j/skipFrom/skipTo untouched.
      if (st.skipTo > pos) return false;
      st.j = st.skipTo; st.skipFrom = -1; continue;
    }
    const j = st.j;
    const c = cmd[j];
    const c2 = cmd[j + 1];
    const stack = st.stack;
    const top = stack[stack.length - 1];
    if (st.inSingle) { if (c === "'") st.inSingle = false; st.j = j + 1; continue; }
    if (c === '\\') { st.j = j + 2; continue; }
    if (!st.inDouble && c === '$' && c2 === "'") {
      // Resolve the WHOLE ANSI-C span in one shot (bounded by the string
      // length, not by `pos`): the stack is never touched while inside it,
      // so a single call's answer is identical either way, but a persistent
      // resumption MUST land exactly on the real closer (or EOF) — stopping
      // early at `pos` would leave st.j pointing at literal quoted DATA that
      // a LATER, larger `pos` call would then misparse as real shell syntax
      // (R2C1-3 follow-up: bounding this by `pos` broke resumable caching).
      let k = j + 2;
      while (k < n && cmd[k] !== "'") k += cmd[k] === '\\' ? 2 : 1;
      st.j = k + 1; continue;
    }
    if (!st.inDouble && c === "'") { st.inSingle = true; st.j = j + 1; continue; }
    if (c === '"') { st.inDouble = !st.inDouble; st.j = j + 1; continue; }
    if (c === '$' && c2 === '(' && cmd[j + 2] === '(') { stack.push('A'); st.j = j + 3; continue; }
    if (c === '$' && c2 === '[') { stack.push('B'); st.j = j + 2; continue; }
    if (c === '$' && c2 === '(') { stack.push('C'); st.j = j + 2; continue; }
    if (c === '(' && c2 === '(' && top !== 'A' && top !== 'B') { stack.push('A'); st.j = j + 2; continue; }
    if (c === '(') { stack.push('P'); st.j = j + 1; continue; }
    if (c === ')') {
      if (top === 'A' && c2 === ')') { stack.pop(); st.j = j + 2; continue; }
      if (top === 'C' || top === 'P') stack.pop();
      st.j = j + 1; continue;
    }
    if (c === '[' && (top === 'B' || top === 'Q')) { stack.push('Q'); st.j = j + 1; continue; }
    if (c === ']') { if (top === 'B' || top === 'Q') stack.pop(); st.j = j + 1; continue; }
    if (!st.inDouble && c === '<' && c2 === '<' && top !== 'A' && top !== 'B') {
      // An earlier real heredoc: keep scanning its opener line (it is code),
      // then jump over its body (data — its parens/quotes must not count).
      const h = parseHeredocRaw(cmd, j);
      if (h) {
        const bodyStart = j + h.openerText.length;
        if (bodyStart < h.end && (st.skipFrom === -1 || bodyStart < st.skipFrom)) {
          st.skipFrom = bodyStart; st.skipTo = h.end;
        }
      }
      st.j = j + 2; continue;
    }
    st.j = j + 1;
  }
  const top = st.stack[st.stack.length - 1];
  return top === 'A' || top === 'B';
}

function parseHeredocRaw(cmd, i) {
  const n = cmd.length;
  if (cmd[i] !== '<' || cmd[i + 1] !== '<') return null;
  // `<<<` is a here-STRING (no body): neither its first nor its second `<`
  // opens a heredoc. Without this, `<<< "#"` parsed as a heredoc on word `#`
  // and swallowed every following line as "body".
  if (cmd[i + 2] === '<' || (i > 0 && cmd[i - 1] === '<')) return null;
  const m = HEREDOC_RE.exec(cmd.slice(i));
  if (!m) return null;
  const dashStrip = !!m[1];
  // HEREDOC_RE only gates WHERE a delimiter may start (a letter/_ or a quote —
  // keeps `$((1<<2))` out). The delimiter itself is the FULL shell word with
  // quote removal, as bash reads it: `<<EOF#x` terminates on `EOF#x`, not
  // `EOF` (the old regex stopped at `#` and the unmatched body swallowed the
  // rest of the command). A word we cannot model exactly (unquoted `$` or
  // backtick, unterminated quote, `\`-newline) returns null — no body is
  // skipped, the strict fallback.
  let j = i + m[0].length - m[2].length;
  let word = '';
  let quoted = false;
  while (j < n && !/[ \t\r\n;&|<>()]/.test(cmd[j])) {
    const ch = cmd[j];
    if (ch === '$' || ch === '`') return null;
    if (ch === "'") {
      const close = cmd.indexOf("'", j + 1);
      if (close === -1) return null;
      word += cmd.slice(j + 1, close); quoted = true; j = close + 1; continue;
    }
    if (ch === '"') {
      let k = j + 1;
      while (k < n && cmd[k] !== '"') {
        if (cmd[k] === '$' || cmd[k] === '`') return null;
        if (cmd[k] === '\\' && k + 1 < n && '\\"'.includes(cmd[k + 1])) { word += cmd[k + 1]; k += 2; continue; }
        word += cmd[k]; k++;
      }
      if (k >= n) return null;
      quoted = true; j = k + 1; continue;
    }
    if (ch === '\\') {
      if (j + 1 >= n || cmd[j + 1] === '\n' || cmd[j + 1] === '\r') return null;
      word += cmd[j + 1]; quoted = true; j += 2; continue;
    }
    word += ch; j++;
  }
  if (!word) return null;
  const openerEnd = j;
  const lineEnd = cmd.indexOf('\n', openerEnd);
  if (lineEnd === -1) {
    // Opener runs to EOF: no body at all.
    return { end: n, openerText: cmd.slice(i, n), word, quoted, dashStrip, body: '', terminated: false };
  }
  const openerText = cmd.slice(i, lineEnd);
  let idx = lineEnd + 1;
  const bodyLines = [];
  let terminated = false;
  while (idx <= n) {
    const nextNl = cmd.indexOf('\n', idx);
    const lineRaw = nextNl === -1 ? cmd.slice(idx) : cmd.slice(idx, nextNl);
    const line = dashStrip ? lineRaw.replace(/^\t+/, '') : lineRaw;
    if (line === word) {
      terminated = true;
      idx = nextNl === -1 ? n : nextNl + 1;
      break;
    }
    bodyLines.push(line);
    if (nextNl === -1) { idx = n; break; }
    idx = nextNl + 1;
  }
  return { end: idx, openerText, word, quoted, dashStrip, body: bodyLines.join('\n'), terminated };
}

// Tokenize a segment respecting single/double quotes, STRIPPING the quote
// delimiters but PRESERVING their contents (unlike a "blank quoted content"
// neutralizer). Recovers the real text of a quoted argument — `cat
// "…/inbox/x"` yields the token `…/inbox/x`, identical to the unquoted form.
// Best-effort tokenization; no backslash-escape support.
function tokenizeQuoted(segment) {
  const tokens = [];
  let cur = ''; let q = ''; let any = false;
  const str = segment.trim();
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q) { if (c === q) { q = ''; } else cur += c; any = true; continue; }
    if (c === "'" || c === '"') { q = c; any = true; continue; }
    if (/\s/.test(c)) { if (any) { tokens.push(cur); cur = ''; any = false; } continue; }
    cur += c; any = true;
  }
  if (any) tokens.push(cur);
  return tokens;
}

// dequoteSegment(segment) -> the SHELL-EFFECTIVE argv text: quote delimiters
// stripped, tokens rejoined with single spaces. Models what the shell
// actually passes as argv — quoting a bareword does NOT change argv.
function dequoteSegment(segment) {
  return tokenizeQuoted(segment).join(' ');
}

// extractSubstitutions(s) -> array of inner command strings found in $(...)
// and `...` command-substitution spans anywhere in s (quote-aware; a
// QUOTED heredoc delimiter's body is INERT DATA in a real shell — no
// $(...)/backtick expansion inside it — so it is skipped from this scan
// entirely; an UNQUOTED delimiter's body DOES expand, so it is scanned
// normally).
function extractSubstitutions(s) {
  const found = [];
  let i = 0;
  const n = s.length;
  let inSingle = false;
  let inDouble = false;
  while (i < n) {
    const c = s[i];
    const c2 = i + 1 < n ? s[i + 1] : '';
    if (!inSingle && !inDouble && c === '<' && c2 === '<') {
      const parsed = parseHeredocAt(s, i);
      if (parsed) {
        if (parsed.quoted) {
          // Quoted delimiter: body is inert DATA in a real shell (no
          // $(...)/backtick expansion inside it) — skip the whole construct.
          i = parsed.end;
        } else {
          // Unquoted delimiter: only skip the OPENER LINE itself; its body
          // DOES expand $(...)/backticks in a real shell, so fall through and
          // keep scanning normally starting right after the opener's newline.
          i = i + parsed.openerText.length;
          if (i < n && s[i] === '\n') i++;
        }
        continue;
      }
    }
    if (inSingle) { if (c === "'") inSingle = false; i++; continue; }
    // ANSI-C `$'…'`: `\'` inside it is an escaped quote, not the closer.
    if (!inDouble && c === '$' && c2 === "'") {
      i += 2;
      while (i < n && s[i] !== "'") i += s[i] === '\\' ? 2 : 1;
      i++; continue;
    }
    if (!inDouble && c === "'") { inSingle = true; i++; continue; }
    if (c === '"') { inDouble = !inDouble; i++; continue; }
    if (c === '$' && c2 === '(') {
      let depth = 1; let j = i + 2; let inner = '';
      while (j < n && depth > 0) {
        const cj = s[j];
        if (cj === '(') depth++;
        else if (cj === ')') { depth--; if (depth === 0) break; }
        inner += cj; j++;
      }
      if (inner.trim()) found.push(inner);
      i = j + 1; continue;
    }
    if (c === '`') {
      let j = i + 1; let inner = '';
      while (j < n && s[j] !== '`') { inner += s[j]; j++; }
      if (inner.trim()) found.push(inner);
      i = j + 1; continue;
    }
    i++;
  }
  return found;
}

module.exports = {
  HEREDOC_RE,
  basename,
  SHELL_VERBS,
  parseHeredocAt,
  tokenizeQuoted,
  dequoteSegment,
  extractSubstitutions,
};
