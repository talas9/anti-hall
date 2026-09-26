'use strict';
// Per-project command allowlist helpers, shared by command-guard.js (the
// enforcement point) and doctor.js (the report). One validator so the guard
// and the doctor can never disagree about which patterns count.

// validatePattern(p) -> { ok: true } | { ok: false, reason }.
//
// A pattern must:
//   - be a string that starts with `^` and ends with an unescaped `$`;
//   - continue after `^` with a LITERAL command word (letters, digits,
//     `_`, `/`, `-`, or an escaped `\.`) followed by a literal space or the
//     closing `$` — so the allowed program is fixed text, never a regex;
//   - contain no unbounded wildcard: `.` quantified by `*`, `+` or `{n,}`
//     (`.*`, `.+`, `(.*)`, `.*?`), nor a negated / whitespace-spanning
//     character class quantified the same way (`[^x]*`, `[\s\S]+`);
//   - contain no top-level alternation (`^a$|^.*$` escapes the anchors);
//   - compile as a JavaScript RegExp.
function validatePattern(p) {
  if (typeof p !== 'string') return { ok: false, reason: 'not a string' };
  if (!p.startsWith('^')) return { ok: false, reason: 'must start with ^' };
  if (!p.endsWith('$') || p.endsWith('\\$')) return { ok: false, reason: 'must end with $' };
  if (!/^\^(?:[A-Za-z0-9_\/-]|\\\.)+(?: |\$$)/.test(p)) {
    return { ok: false, reason: 'must begin with a literal command word after ^' };
  }
  const scan = scanPattern(p);
  if (scan.topLevelAlternation) return { ok: false, reason: 'top-level | alternation' };
  if (scan.unboundedWildcard) return { ok: false, reason: 'unbounded wildcard (' + scan.unboundedWildcard + ')' };
  try { new RegExp(p); } catch (_) { return { ok: false, reason: 'invalid regex' }; }
  return { ok: true };
}

// scanPattern(src) -> { topLevelAlternation, unboundedWildcard } — a small
// structural walk (escape / class / group depth) over a regex source.
function scanPattern(src) {
  let depth = 0;
  let topLevelAlternation = false;
  let unboundedWildcard = null;
  const groupStarts = [];
  const isUnboundedQuant = (i) => {
    const q = src[i];
    if (q === '*' || q === '+') return true;
    if (q === '{') return /^\{\d*,\}/.test(src.slice(i));
    return false;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '[') {
      let j = i + 1;
      if (src[j] === '^') j++;
      if (src[j] === ']') j++;
      while (j < src.length && src[j] !== ']') { if (src[j] === '\\') j++; j++; }
      const body = src.slice(i + 1, j);
      const spansSpace = body.startsWith('^') || /\\s|\\S|\\W|\\D| /.test(body);
      if (spansSpace && isUnboundedQuant(j + 1) && !unboundedWildcard) {
        unboundedWildcard = src.slice(i, j + 2);
      }
      i = j;
      continue;
    }
    if (c === '(') { depth++; groupStarts.push(i); continue; }
    if (c === ')') {
      depth = Math.max(0, depth - 1);
      const start = groupStarts.length ? groupStarts.pop() : 0;
      // A quantified group is as wide as its widest member: `(.|x)*`,
      // `(?:\S|\s)+`, `( [^ ]*)*` all span arbitrary text.
      const body = src.slice(start + 1, i);
      if (isUnboundedQuant(i + 1) && /(^|[^\\])\.|\\[sWD]|\[\^| /.test(body) && !unboundedWildcard) {
        unboundedWildcard = src.slice(start, i + 2);
      }
      continue;
    }
    if (c === '|' && depth === 0) topLevelAlternation = true;
    if (c === '.' && isUnboundedQuant(i + 1) && !unboundedWildcard) unboundedWildcard = src.slice(i, i + 2);
  }
  return { topLevelAlternation, unboundedWildcard };
}

module.exports = { validatePattern };
