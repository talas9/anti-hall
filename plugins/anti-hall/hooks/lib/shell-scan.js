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
// Per real shell behavior, an UNTERMINATED heredoc's body is the REST of the
// command (bash keeps reading looking for the terminator until EOF) — this
// only ever makes a caller see MORE text, never less.
function parseHeredocAt(cmd, i) {
  const n = cmd.length;
  if (cmd[i] !== '<' || cmd[i + 1] !== '<') return null;
  const m = HEREDOC_RE.exec(cmd.slice(i));
  if (!m) return null;
  const word = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5]);
  if (!word) return null;
  const dashStrip = !!m[1];
  const quoted = m[3] !== undefined || m[4] !== undefined;
  const openerEnd = i + m[0].length;
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
