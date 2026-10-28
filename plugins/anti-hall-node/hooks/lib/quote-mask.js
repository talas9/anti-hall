'use strict';
// quote-mask.js — shared quoted-text mask (moved verbatim out of
// speculation-guard.js so speculation-guard and merge-gate cannot diverge).
//
// QUOTED-TEXT MASK — a hedge inside quoted material (a "…must be…" quoted from
// another agent, a `> …` blockquote, inline code, a fenced code block) is not
// the session's own speculation. Blank those spans (same length, newlines
// kept, so every offset is unchanged) before matching. Applied per text block
// at extraction, never to joined text, whose ' '-joined duplicate copy would
// pull a leading `> ` mid-line and pair quotes across blocks. Only CLOSED spans
// are masked: an unclosed `"`, backtick or fence masks nothing. A straight
// single quote is never a quote delimiter (apostrophes: don't, it's).
//
// A `>` line is masked only up to a clear separator (em dash, ` -- `, `; so`,
// `, so`) marking the transition from quoted material to the session's own
// words -- the rest of the line (the hedge) stays visible. A `>` line with no
// such separator is still blanked whole (as before), but ONLY when some other
// non-quoted, non-fenced content exists elsewhere in the reply; a reply that
// is 100% quoted or fenced is never masked at all, so a hedge with nowhere
// else to hide still fires.

function blank(s) {
  return s.replace(/[^\n]/g, ' ');
}

const QUOTE_LINE_RE = /^[ \t]{0,3}>/;
const FENCE_LINE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;
// Earliest quote/hedge separator on a line: em dash, ' -- ', '; so', ', so'.
const QUOTE_SEPARATORS = [/—/, /\s--\s/, /;\s*so\b/i, /,\s*so\b/i];

// separatorEnd(line) -- end offset (index just past the match) of the
// EARLIEST separator on the line, or -1 if none present.
function separatorEnd(line) {
  let bestStart = -1;
  let bestEnd = -1;
  for (const re of QUOTE_SEPARATORS) {
    const m = re.exec(line);
    if (m && (bestStart === -1 || m.index < bestStart)) {
      bestStart = m.index;
      bestEnd = m.index + m[0].length;
    }
  }
  return bestEnd;
}

// Membership: which lines belong to a fenced span (open marker through its
// close, or through EOF if never closed) -- used only for the "is this reply
// 100% quote/fence" check, not for whether the fence content gets masked.
function fenceMembership(lines) {
  const member = new Array(lines.length).fill(false);
  let fenceStart = -1;
  let fenceChar = '';
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE_LINE_RE.exec(lines[i]);
    if (fenceStart === -1) {
      if (f) { fenceStart = i; fenceChar = f[1][0]; member[i] = true; }
    } else {
      member[i] = true;
      if (f && f[1][0] === fenceChar) fenceStart = -1;
    }
  }
  return member;
}

// True when every non-empty line is either part of a fence span or a `>`
// blockquote line -- i.e. the whole reply is quoted/fenced material with
// nowhere else the session could have stated its own hedge. Masking such a
// reply would let it escape entirely, so it is never masked.
function allQuotedOrFenced(lines, fenceMember) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (fenceMember[i]) continue;
    if (QUOTE_LINE_RE.test(lines[i])) continue;
    return false;
  }
  return true;
}

// maskStraightQuotesLine(line) -- pair straight `"` quotes within this single
// line only. An odd count on the line means the pairing is ambiguous (a
// stray/unclosed quote), so nothing on that line is masked.
function maskStraightQuotesLine(line) {
  const count = (line.match(/"/g) || []).length;
  if (count === 0 || count % 2 !== 0) return line;
  return line.replace(/"[^"\n]*"/g, blank);
}

function maskQuotedText(text) {
  const lines = text.split('\n');
  const fenceMember = fenceMembership(lines);
  if (allQuotedOrFenced(lines, fenceMember)) return text;

  let fenceStart = -1;
  let fenceChar = '';
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE_LINE_RE.exec(lines[i]);
    if (fenceStart === -1) {
      if (f) { fenceStart = i; fenceChar = f[1][0]; }
    } else if (f && f[1][0] === fenceChar) {
      for (let k = fenceStart; k <= i; k++) lines[k] = blank(lines[k]);
      fenceStart = -1;
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (!QUOTE_LINE_RE.test(lines[i])) continue;
    const end = separatorEnd(lines[i]);
    lines[i] = end === -1 ? blank(lines[i]) : blank(lines[i].slice(0, end)) + lines[i].slice(end);
  }
  return lines.map(maskStraightQuotesLine).join('\n')
    .replace(/`[^`\n]+`/g, blank)
    .replace(/“[^“”\n]*”/g, blank)
    .replace(/‘[^‘’\n]*’/g, blank);
}

module.exports = { maskQuotedText };
