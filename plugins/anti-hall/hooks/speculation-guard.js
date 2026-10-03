#!/usr/bin/env node
// anti-hall :: speculation-guard (Stop hook, loop-safe)
//
// Fires on Stop. Takes the reply being stopped (payload `last_assistant_message`;
// the transcript's LAST assistant message only when that field is absent/blank),
// scans it for speculation markers (hedge words that assert without evidence),
// and blocks ONCE if speculation markers are present and the message contains
// no evidence/uncertainty acknowledgment that would make the hedging honest.
//
// DECISION LOGIC:
//   speculation markers present AND no acknowledgment -> BLOCK (once per hash)
//   speculation markers present AND acknowledgment present -> ALLOW
//   no speculation markers -> ALLOW
//   any parse/read error -> ALLOW (fail-open)
//
// LOOP-SAFE: hashes the last-message text. Stores the blocked hash in
//   ~/.anti-hall/speculation-guard-state-<session>.json
//   If the same hash was already blocked (nothing changed), allow exit 0 so the
//   nudge fires ONCE per distinct speculative message, never wedges.
//
// FAIL-OPEN: any error -> exit 0, no block, no stderr noise.
//
// JEV (OPT-IN, default OFF): when lib/jev-client.js reports enabled
//   (~/.anti-hall/jev.json {"enabled":true} or ANTIHALL_JEV=1; ANTIHALL_JEV=0
//   always wins), TypeSafe's Jev classifier is asked FIRST with JEV_QUESTION.
//   ASYMMETRIC TRUST: only a confident "speculative" answer (confidence >=
//   confidenceThreshold) short-circuits to a BLOCK. A confident "grounded"
//   answer, a low-confidence answer, or any Jev failure (no key, timeout, HTTP
//   error, bad response) falls through to the regex logic below, unchanged —
//   Jev can add blocks the regex misses, never remove one. Both paths share the
//   same loop-safety (one block per message hash, MAX_BLOCKS per session).
//   While Jev is enabled every decision appends one line to
//   ~/.anti-hall/logs/jev-judge.ndjson (no message text, no key). With Jev
//   disabled (the default) behavior is identical to the regex-only hook and
//   nothing is logged. (With Jev enabled, a framed-hedge hit also appends one
//   {event:'trigger', id:'speculationFramed', outcome:'seen'} line there.)
//
// FRAMED EXPECTATIONS (jevIntegrations.speculationFramed, default SHADOW):
//   a deterministic regex hit whose hedge sits under a heading/line prefix
//   framing it as an expectation/plan ("Expected", "Plan", "Should be
//   blocked:", "Should still", "Unverified", "(unverified)", "not yet
//   measured" — see isFramedHit) is additionally asked FRAMED_JEV_QUESTION
//   via jev-assist's relax-block trust: Jev may only turn THAT hit's block
//   into a non-block (never add one). shadow logs the verdict and keeps the
//   deterministic block; on relaxes only at confidence >= the shared
//   confidenceThreshold (default 0.85) and a "genuine expectation" answer. An
//   UNFRAMED hedge never reaches this question — it stays deterministic and
//   blocking in every mode. Logged via jev-assist's own ask() (id
//   'speculationFramed', ~/.anti-hall/logs/jev-assist.ndjson + daily
//   rollups) — a SEPARATE log/id from the JEV_QUESTION path above.
//
// Contract (Claude Code Stop hook):
//   stdin  : JSON { transcript_path, session_id?, ... }
//   stdout : JSON {"decision":"block","reason":"..."} to block, or nothing
//   exit 0 : always

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// --------------------------------------------------------------------------
// Speculation markers — case-insensitive, must appear at a word boundary.
// These are hedge words that assert something as probably-true without evidence.
// --------------------------------------------------------------------------
const SPECULATION_PATTERNS = [
  /\bvery plausibly\b/i,
  /\bplausibly\b/i,
  /\bpresumably\b/i,
  /\bi suspect\b/i,
  /\bmy guess\b/i,
  /\bi'?d guess\b/i,
  /\bi bet\b/i,
  /\blikely\b/i,
  /\bprobably\b/i,
  /\bmust be\b/i,
  // "should be" (a guess about state). "should I" is a question and already does
  // not match this phrase. The prior negative-lookahead `(?!\s+\w)` wrongly
  // skipped "should be fine"/"should be X" — exactly the speculative cases we
  // want to catch — so it is removed.
  /\bshould be\b/i,
  /\bseems to be\b/i,
  /\bappears to be\b/i,
  /\bi think it'?s\b/i,
  /\bmy hunch\b/i,
];

// --------------------------------------------------------------------------
// Acknowledgment patterns — if any of these appear in the same message,
// the hedging is honest (the model is being transparent about uncertainty).
// Suppress the block when present.
// --------------------------------------------------------------------------
const ACKNOWLEDGMENT_PATTERNS = [
  /\bverified\b/i,
  /i don'?t know\b/i,
  /haven'?t checked\b/i,
  /\bnot verified\b/i,
  /\bunverified\b/i,
  /\blet me verify\b/i,
  /i'?ll check\b/i,
  /\bi will check\b/i,
  /\bneed to confirm\b/i,
  /\bto confirm\b/i,
  // file:line citation pattern  e.g. main.js:42 or foo_bar.py:123
  /\b\w+\.\w+:\d+\b/,
  /\brunning\b/i,
  /\bper the data\b/i,
  /\bthe data shows\b/i,
];

// --------------------------------------------------------------------------
// Jev question (Noul): true == speculative (block), false == grounded.
// Wording chosen from a labelled probe (docs/KB-jev-classifier.md §4): the
// previous Tier-3 rubric required "NO hedge word" for true, so hedged guesses
// ("probably ... should work now, I think the tests pass") were confidently
// answered false. Speculation here explicitly INCLUDES hedged guesses.
// --------------------------------------------------------------------------
const JEV_QUESTION = {
  type: 'noul',
  instructions:
    'Is this assistant message speculative, i.e. does it assert a cause or an ' +
    'outcome about the project without cited evidence?',
  criteria: {
    true:
      'Speculative: it asserts a cause, a fix, or a done/works/passes/resolved ' +
      'outcome about the project with no cited command output, test result, or ' +
      'file:line reference. Hedged guesses ("probably", "should work", "I think", ' +
      '"it seems") and confident but unsupported statements ("Fixed.", "All done") ' +
      'are both speculative.',
    false:
      'Not speculative: it reports what a tool actually showed (command output such ' +
      'as "12 pass, 0 fail", a commit hash, grep results, a file:line reference like ' +
      'src/app.js:42); or it honestly says something is not yet verified and names ' +
      'the check to run; or it makes no claim about the project at all (a question, ' +
      'a plan, code the user asked for, general technical knowledge, an explicit ' +
      'hypothetical, or small talk).',
  },
};

// FRAMED_JEV_QUESTION (speculationFramed integration, relax-block trust): only
// asked about a hit the DETERMINISTIC frame detector (isFramedHit) already
// flagged as sitting under a heading/line-prefix like "Expected", "Plan",
// "Should be <verb>:", "Should still", "Unverified", "(unverified)", "not yet
// measured". true keeps the deterministic block (relax-block's baseline);
// false, at confidence >= the shared jev.confidenceThreshold (default 0.85),
// relaxes it. An unframed hedge never reaches this question at all.
const FRAMED_JEV_QUESTION = {
  type: 'noul',
  instructions:
    'This hedge sits under a heading or line labelled as a plan/expectation (e.g. ' +
    '"Expected", "Plan", "Should be blocked:", "Unverified", "not yet measured"). Is ' +
    'it still an unverified claim about the project\'s CURRENT/actual state presented ' +
    'as fact, or is it a stated expectation/plan/acceptance-criterion for work not yet ' +
    'done or measured?',
  criteria: {
    true:
      'Unverified claim presented as fact: despite the label, it asserts what IS true ' +
      'right now about the project (a cause, a fix, a done/works/passes outcome) with ' +
      'no cited evidence — the framing is decorative, not honest.',
    false:
      'Genuine expectation/plan: a test-plan entry, acceptance criterion, or hypothesis ' +
      'about future or hypothetical work ("Should be blocked: X", "Expected: Y", "not ' +
      'yet measured") — not a claim about the project\'s actual current state.',
  },
};

// appendJevLog(entry) — bounded, best-effort append to
// ~/.anti-hall/logs/jev-judge.ndjson (truncated once it exceeds ~1MB). Never
// throws; a logging failure must never affect the decision.
const JEV_LOG_MAX_BYTES = 1024 * 1024;
function appendJevLog(entry) {
  try {
    const logDir = path.join(os.homedir(), '.anti-hall', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'jev-judge.ndjson');
    try {
      if (fs.statSync(logPath).size > JEV_LOG_MAX_BYTES) fs.writeFileSync(logPath, '', 'utf8');
    } catch (_) {
      // file doesn't exist yet
    }
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {
    // best-effort only
  }
}

// --------------------------------------------------------------------------
// Bounded tail read: load only the last `windowBytes` of a (possibly multi-GB)
// transcript instead of the whole file, so a huge transcript can never OOM or
// stall this hook. The last assistant message lives at the end of the JSONL, so
// the trailing window is sufficient. If the file is smaller than the window we
// read it all. The first line of a mid-file window is almost certainly a partial
// (truncated) JSON line; we drop it so the JSONL parser never trips on it (it
// would be skipped anyway, but dropping it is explicit and avoids ambiguity).
// Any error -> null (caller fails open).
// --------------------------------------------------------------------------
function readTranscriptTail(transcriptPath, windowBytes) {
  const WINDOW = windowBytes || 512 * 1024; // 512 KB default
  let fd = null;
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size <= WINDOW) {
      return { data: fs.readFileSync(transcriptPath, 'utf8'), truncated: false };
    }
    const start = size - WINDOW;
    const buf = Buffer.alloc(WINDOW);
    fd = fs.openSync(transcriptPath, 'r');
    const bytesRead = fs.readSync(fd, buf, 0, WINDOW, start);
    return { data: buf.toString('utf8', 0, bytesRead), truncated: true };
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

// --------------------------------------------------------------------------
// Extract the last assistant message text from a transcript JSONL file.
// Returns null if nothing is found or any error occurs.
//
// Two extraction variants share the same scan/parse plumbing but differ in
// collectTextFromEntry:
//   - legacy (collectTextFromEntryLegacy): the pre-3e72bf3 behavior, restored
//     BYTE-IDENTICAL. It can duplicate text when `content` was read from
//     node.message (the real transcript shape) and the recursion into
//     node.message re-collects the same block. This is INTENTIONALLY kept for
//     the regex path and the loop-safety hash so both stay identical to the
//     pre-3e72bf3 hook — the duplication can shift where a regex matches (or
//     doesn't) at the boundary, and changing it would silently change verdicts
//     and the stored hash for already-deployed state files.
//   - deduplicated (collectTextFromEntryDedup): skips the duplicate re-collection.
//     Used ONLY as the Jev input (lastText.slice(0, 8000) below), since Jev is
//     a new code path with no pre-existing byte-identical contract to preserve.
// --------------------------------------------------------------------------
function extractLastAssistantTextWith(transcriptPath, collectFn) {
  const tail = readTranscriptTail(transcriptPath);
  if (!tail) {
    return null;
  }

  const lines = tail.data.split(/\r?\n/);
  // When the window starts mid-file, the first line is a possibly-truncated
  // partial JSON line; drop it so we never parse a fragment.
  if (tail.truncated && lines.length > 0) {
    lines.shift();
  }
  let lastText = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (_) {
      continue;
    }

    // Look for assistant role messages
    const role = entry && (entry.role || (entry.message && entry.message.role));
    if (role !== 'assistant') continue;

    // Collect all text content blocks from this message
    const text = collectFn(entry);
    if (text) {
      lastText = text;
    }
  }

  return lastText;
}

function extractLastAssistantTextLegacy(transcriptPath) {
  return extractLastAssistantTextWith(transcriptPath, collectTextFromEntryLegacy);
}

// Same text and offsets as the legacy extraction, with each text block's
// quoted material blanked (maskQuotedText). Input for findSpeculationMarker.
function extractLastAssistantMarkerText(transcriptPath) {
  return extractLastAssistantTextWith(transcriptPath, (n) => collectTextFromEntryLegacy(n, maskQuotedText));
}

function extractLastAssistantTextDedup(transcriptPath) {
  return extractLastAssistantTextWith(transcriptPath, collectTextFromEntryDedup);
}

// Recursively collect concatenated text from content blocks in an entry.
// LEGACY (pre-3e72bf3, restored as-is): always recurses into node.message
// when present, which can duplicate text already picked up via node.content.
// `mapText` (optional) transforms each collected string; omitted, the output
// is byte-identical to the legacy collector.
function collectTextFromEntryLegacy(node, mapText) {
  if (!node || typeof node !== 'object') return '';
  const parts = [];
  const f = typeof mapText === 'function' ? mapText : (s) => s;

  // Direct text field
  if (typeof node.text === 'string') {
    parts.push(f(node.text));
  }

  // content array (Claude message format)
  const content = node.content || (node.message && node.message.content);
  if (typeof content === 'string') {
    parts.push(f(content));
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(f(block.text));
      } else if (typeof block.text === 'string') {
        parts.push(f(block.text));
      }
    }
  }

  // Recurse into message field if not already handled above
  if (node.message && typeof node.message === 'object' && node.message !== node) {
    const sub = collectTextFromEntryLegacy(node.message, mapText);
    if (sub) parts.push(sub);
  }

  return parts.join(' ');
}

// Deduplicated variant (Jev input only — see comment above).
function collectTextFromEntryDedup(node) {
  if (!node || typeof node !== 'object') return '';
  const parts = [];

  // Direct text field
  if (typeof node.text === 'string') {
    parts.push(node.text);
  }

  // content array (Claude message format)
  const content = node.content || (node.message && node.message.content);
  if (typeof content === 'string') {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }

  // Recurse into message field if not already handled above. When `content`
  // was taken from node.message (the real transcript shape), recursing would
  // append the same text a second time — skip it.
  if (node.message && typeof node.message === 'object' && node.message !== node && node.content) {
    const sub = collectTextFromEntryDedup(node.message);
    if (sub) parts.push(sub);
  }

  return parts.join(' ');
}

// --------------------------------------------------------------------------
// REQUIREMENT PHRASING EXEMPTION — "must be"/"should be" used as a
// REQUIREMENT ("X must be measured on the P3 build") is not a speculative
// CLAIM about the project's state; it's a statement of what the plan/spec
// obligates. Two independent signals exempt a "must be"/"should be" match
// (checked ONLY for those two patterns — every other marker is unaffected):
//   1) the modal is immediately followed by a past participle naming a real
//      OBLIGATION ("must be measured/verified/tested/..."). STATE words
//      ("done", "deployed", "built", "fixed", "running", "fine") are NOT in
//      this list: "should be done by now" is a claim about state, not a duty.
//   2) the LINE STARTS with an explicit requirement label (optional list
//      bullet, then "Requirement:", "Acceptance:", "AC:" or "Spec:"). A label
//      appearing mid-line ("per the spec: this should be fine") does not count.
// Every must-be/should-be occurrence is judged independently, so one exempt
// requirement cannot hide a later speculative claim in the same text.
// Neither signal changes how any OTHER speculation marker is judged.
// --------------------------------------------------------------------------
const OBLIGATION_PARTICIPLE_RE =
  /^\s+(measured|verified|tested|checked|reviewed|documented|validated|approved|confirmed|updated|run)\b/i;
const REQUIREMENT_LINE_RE =
  /^\s*(?:(?:[-*+\u2022]|\d+[.)])\s+)?(?:requirement|acceptance(?:\s+criteria)?|ac|spec)\s*:/i;

function isObligationPhrasing(text, matchText, matchIndex) {
  const after = text.slice(matchIndex + matchText.length, matchIndex + matchText.length + 40);
  if (OBLIGATION_PARTICIPLE_RE.test(after)) return true;
  const lineStart = text.lastIndexOf('\n', matchIndex) + 1;
  const lineEndIdx = text.indexOf('\n', matchIndex);
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
  return REQUIREMENT_LINE_RE.test(text.slice(lineStart, lineEnd));
}

const MODAL_OBLIGATION_MARKERS = new Set(['must be', 'should be']);

// --------------------------------------------------------------------------
// QUOTED-TEXT MASK — a hedge inside quoted material (a "…must be…" quoted from
// another agent, a `> …` blockquote, inline code, a fenced code block) is not
// the session's own speculation. Blank those spans (same length, newlines
// kept, so every offset is unchanged) before matching. Applied per text block
// at extraction (extractLastAssistantMarkerText), never to the joined legacy
// text, whose ' '-joined duplicate copy would pull a leading `> ` mid-line
// and pair quotes across blocks. Only CLOSED spans are
// masked: an unclosed `"`, backtick or fence masks nothing. A straight single
// quote is never a quote delimiter (apostrophes: don't, it's).
//
// A `>` line is masked only up to a clear separator (em dash, ` -- `, `; so`,
// `, so`) marking the transition from quoted material to the session's own
// words -- the rest of the line (the hedge) stays visible. A `>` line with no
// such separator is still blanked whole (as before), but ONLY when some other
// non-quoted, non-fenced content exists elsewhere in the reply; a reply that
// is 100% quoted or fenced is never masked at all, so a hedge with nowhere
// else to hide still fires.
// --------------------------------------------------------------------------
function blank(s) {
  return s.replace(/[^\n]/g, ' ');
}

const QUOTE_LINE_RE = /^[ \t]{0,3}>/;
const FENCE_LINE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;
// Earliest quote/hedge separator on a line: em dash, ' -- ', '; so', ', so'.
const QUOTE_SEPARATORS = [/\u2014/, /\s--\s/, /;\s*so\b/i, /,\s*so\b/i];

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
    .replace(/\u201C[^\u201C\u201D\n]*\u201D/g, blank)
    .replace(/\u2018[^\u2018\u2019\n]*\u2019/g, blank);
}

// --------------------------------------------------------------------------
// FRAMED-EXPECTATION detection (speculationFramed, shadow default) — owner
// decision "let Jev judge it" (2026-09-27): a hedge that sits under a heading
// or line prefix stating it is an EXPECTATION/PLAN, not a claim about the
// project's current state (a test plan headed "Should be blocked:" /
// "Should still work:", a "## Expected" section, "(unverified)", "not yet
// measured"), is FRAMED. An unframed hedge is judged exactly as before
// (deterministic, always blocking). A framed hit additionally gets consulted
// via jevIntegrations.speculationFramed (relax-block trust: Jev may only turn
// the framed hit's block into a non-block, never add one) — see main()'s use
// of it below. This is a SEPARATE, additional relaxation from the
// must-be/should-be obligation-phrasing exemption above, which fully exempts
// independent of framing.
// --------------------------------------------------------------------------
const FRAME_LABEL_CORE = '(?:expected|plan|should\\s+be\\s+\\w+|should\\s+still(?:\\s+\\w+)?|unverified|not\\s+yet\\s+measured)';
const FRAME_LINE_PREFIX_RE = new RegExp(
  '^\\s*(?:(?:[-*+\\u2022]|\\d+[.)])\\s+)?' + FRAME_LABEL_CORE + '\\s*[:)]', 'i');
const FRAME_HEADING_RE = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/;
const FRAME_HEADING_LABEL_RE = new RegExp('^' + FRAME_LABEL_CORE + '\\b', 'i');
const FRAME_INLINE_RE = /\(unverified\)|\bnot yet measured\b/i;

// isFramedHit(text, matchIndex) -> bool. Checked at the marker occurrence's
// own line first (handles "Should be blocked: X probably fails" on ONE
// line), then walks upward through the current section (stopping at a blank
// line run >= 2, i.e. a paragraph break) looking for the nearest heading or
// frame-label line that establishes the frame.
function isFramedHit(text, matchIndex) {
  const lineStart = text.lastIndexOf('\n', matchIndex) + 1;
  const lineEndIdx = text.indexOf('\n', matchIndex);
  const line = text.slice(lineStart, lineEndIdx === -1 ? text.length : lineEndIdx);
  if (FRAME_LINE_PREFIX_RE.test(line) || FRAME_INLINE_RE.test(line)) return true;

  const priorLines = text.slice(0, lineStart).split('\n');
  let blankRun = 0;
  for (let i = priorLines.length - 1; i >= 0; i--) {
    const l = priorLines[i];
    if (l.trim() === '') {
      blankRun += 1;
      if (blankRun >= 2) return false;
      continue;
    }
    blankRun = 0;
    const h = FRAME_HEADING_RE.exec(l);
    if (h) return FRAME_HEADING_LABEL_RE.test(h[1].trim());
    if (FRAME_LINE_PREFIX_RE.test(l)) return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// Find the first matching (non-exempt) speculation hit -> { marker, index } or
// null. `index` feeds isFramedHit(); findSpeculationMarker() below is a thin
// string-only wrapper kept for every pre-existing caller.
// --------------------------------------------------------------------------
function findSpeculationHit(text) {
  for (const pat of SPECULATION_PATTERNS) {
    const m = text.match(pat);
    if (!m) continue;
    if (!MODAL_OBLIGATION_MARKERS.has(m[0].toLowerCase())) return { marker: m[0], index: m.index };
    // must-be/should-be: judge EVERY occurrence; the first non-exempt one flags.
    const g = new RegExp(pat.source, pat.flags.includes('g') ? pat.flags : pat.flags + 'g');
    let mm;
    while ((mm = g.exec(text)) !== null) {
      if (!isObligationPhrasing(text, mm[0], mm.index)) return { marker: mm[0], index: mm.index };
    }
  }
  return null;
}

function findSpeculationMarker(text) {
  const hit = findSpeculationHit(text);
  return hit ? hit.marker : null;
}

function hasAcknowledgment(text) {
  for (const pat of ACKNOWLEDGMENT_PATTERNS) {
    if (pat.test(text)) return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------
async function main() {
  // Settings switch guards.speculationGuard (0.108.4): off -> no-op. Fail-open: any error runs the hook.
  try { if (!require('./lib/settings.js').enabled('guards', 'speculationGuard')) return; } catch (_) { /* run */ }
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    process.exit(0);
  }

  const { isSkipped } = require('./skip-guard.js');

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    process.exit(0);
  }

  const transcriptPath = payload && payload.transcript_path;
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    process.exit(0);
  }

  // Derive a stable session key (same approach as task-guard.js).
  const sessionId = (payload && payload.session_id && String(payload.session_id)) ||
    crypto.createHash('sha1').update(transcriptPath).digest('hex').slice(0, 16);
  const safeSession = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_');

  // State file under ~/.anti-hall/ (not os.tmpdir) so it survives across
  // processes in the same session even when tmpdir varies.
  const stateDir = path.join(os.homedir(), '.anti-hall');
  const stateFile = path.join(stateDir, 'speculation-guard-state-' + safeSession + '.json');

  // Extract the last assistant message text. The LEGACY (pre-3e72bf3, possibly
  // duplicated) text drives the regex path and the loop-safety hash so both
  // stay byte-identical to the pre-Jev hook. The deduplicated text is computed
  // lazily below and used ONLY as Jev's input.
  // The Stop payload's `last_assistant_message` (the reply being stopped) wins;
  // the transcript tail can still end at the PREVIOUS turn at Stop time, so it
  // is only the fallback (lib/reply-text.js). Everything below judges this one text.
  // If the helper cannot load or throws, fall back to the transcript reader
  // (the pre-helper behaviour) rather than exiting 0 and allowing silently.
  let payloadText = null;
  let lastText = null;
  try {
    const { payloadReplyText, selectReplyText } = require('./lib/reply-text.js');
    payloadText = payloadReplyText(payload);
    lastText = selectReplyText(payload, () => extractLastAssistantTextLegacy(transcriptPath));
  } catch (_) {
    payloadText = null;
    lastText = extractLastAssistantTextLegacy(transcriptPath);
  }
  if (!lastText) {
    process.exit(0);
  }
  // Marker matching ignores quoted material (see maskQuotedText). But if
  // masking blanked EVERY non-blank character (a reply that is a single
  // straight-quoted or inline-code hedge with nowhere else to hide), fall
  // back to the unmasked text for marker matching -- the same rationale as
  // the allQuotedOrFenced short-circuit for `>`/fenced replies: a hedge
  // that has nowhere else to state itself still fires.
  let markerText = (payloadText !== null
    ? maskQuotedText(payloadText)
    : extractLastAssistantMarkerText(transcriptPath)) || '';
  if (markerText.trim() === '') {
    markerText = lastText;
  }

  // Compute a hash of the last message text for loop-safety.
  const msgHash = crypto.createHash('sha1').update(lastText).digest('hex');

  // Load prior state: { hash, blocks, pending }. Tolerate a legacy bare-hash string.
  // `pending` ({h, source}), when present, is the outcome-capture record left
  // by the PREVIOUS Stop's block (see below) — set only when this hook itself
  // blocked, never by an external writer.
  let lastBlockedHash = '';
  let blocks = 0;
  let pending = null;
  try {
    const stateRaw = fs.readFileSync(stateFile, 'utf8').trim();
    if (stateRaw) {
      const parsed = JSON.parse(stateRaw);
      if (parsed && typeof parsed === 'object') {
        lastBlockedHash = typeof parsed.hash === 'string' ? parsed.hash : '';
        blocks = Number.isFinite(parsed.blocks) ? parsed.blocks : 0;
        pending = (parsed.pending && typeof parsed.pending === 'object' &&
          typeof parsed.pending.h === 'string' && typeof parsed.pending.source === 'string')
          ? parsed.pending : null;
      } else {
        lastBlockedHash = stateRaw; // legacy bare-hash file
      }
    }
  } catch (_) {
    // No prior state — first time.
  }

  // ---------------------------------------------------------------------
  // OUTCOME CAPTURE: if the PREVIOUS Stop in this session produced a block
  // (Jev-added or regex), classify THIS reply against it and record the
  // outcome via jev-assist's shared metrics log — so `jev report` can compare
  // Jev-sourced vs regex-sourced block outcomes. Runs BEFORE the skip-hatch
  // short-circuit below (a skip itself is one of the three outcomes) and
  // independently of whatever this turn's own verdict ends up being.
  // Evidence detection reuses the SAME acknowledgment/marker regexes the
  // block decision itself uses — this does not attempt to detect "a tool
  // call happened in between" from the transcript; the acknowledgment
  // patterns (file:line refs, "running", "per the data", etc.) already cover
  // the common real case of a tool having run since the block.
  // ---------------------------------------------------------------------
  if (pending) {
    try {
      let outcome = null;
      if (isSkipped('speculation-guard')) {
        outcome = 'user-override';
      } else if (hasAcknowledgment(lastText)) {
        outcome = 'evidence-added';
      } else if (findSpeculationMarker(markerText)) {
        outcome = 'repeat-speculation';
      }
      if (outcome) {
        const { recordOutcome } = require('./lib/jev-assist.js');
        recordOutcome({ id: 'speculation', h: pending.h, outcome, source: pending.source });
      }
    } catch (_) {
      // Outcome capture is best-effort only — must never affect the decision.
    }
    // Clear the pending record now so it is evaluated exactly once. A fresh
    // block later in THIS turn (see the write near the bottom) overwrites
    // this with its own {hash, blocks, pending}.
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ hash: lastBlockedHash, blocks, pending: null }), 'utf8');
    } catch (_) {
      // Can't persist the clear -> harmless; worst case this pending record
      // is re-evaluated once more on the next Stop.
    }
  }

  // Escape hatch: honor an explicit, user-consented skip (~/.anti-hall/skip.json).
  if (isSkipped('speculation-guard')) process.exit(0);

  // Loop-safe: if we already blocked on this exact message, allow (nudged once).
  // Loop-safety 2: hard cap on total blocks this session. The message text
  // legitimately changes as the model reworks its reply, which defeats the
  // byte-identical hash dedupe; without a cap we could re-block on every Stop.
  // After MAX_BLOCKS nudges we stay quiet regardless of churn.
  const MAX_BLOCKS = 3;
  const loopSafe = msgHash === lastBlockedHash || blocks >= MAX_BLOCKS;

  // Regex verdict, computed up front (independent of Jev) purely so it can be
  // logged alongside Jev's own decision below — it does NOT change the
  // asymmetric-trust contract: Jev only ever ADDS a block via jev-assist's
  // 'add-block' trust (baseline false), the regex/acknowledgment check below
  // still runs on its own and is what actually blocks when Jev doesn't.
  const regexMarkerPreview = findSpeculationMarker(markerText);
  const regexWouldBlock = !!regexMarkerPreview &&
    !(regexMarkerPreview && hasAcknowledgment(lastText));

  // Jev first (opt-in, via lib/jev-assist.js's shared trust/mode layer).
  // logEntry stays null when Jev is disabled, so nothing is logged and the
  // regex path below behaves exactly as without Jev.
  let logEntry = null;
  let jevBlock = false;
  let jevResultHash = null;
  try {
    const { loadJevConfig } = require('./lib/jev-client.js');
    const jevCfg = loadJevConfig();
    if (jevCfg.enabled && loopSafe) {
      // Outcome is already "allow" — don't spend a Jev call on it.
      logEntry = { backend: 'none', reason: 'loop-safe', ms: null, confidence: null, regexVerdict: regexWouldBlock };
    } else if (jevCfg.enabled) {
      const { ask } = require('./lib/jev-assist.js');
      // Dedup text only for Jev's input — see extractLastAssistantTextWith comment.
      const jevText = payloadText !== null ? payloadText : (extractLastAssistantTextDedup(transcriptPath) || lastText);
      const result = await ask({
        id: 'speculation',
        question: JEV_QUESTION,
        state: jevText.slice(0, 8000),
        trust: 'add-block',
        baseline: false,
        // `compare` is the REAL independent heuristic verdict (the regex/
        // acknowledgment check, computed above), passed through PURELY for
        // jev-report's agreement metric. It is NOT trust math -- `baseline`
        // above stays the hardcoded `false` the add-block trust rule needs
        // (see jev-assist.js computeFinal) and this field never influences
        // the decision. Without it, jev-report's "agreement" column was
        // silently computing jev===baseline, i.e. jev===false always --
        // "rate Jev said not-speculative", not real agreement with the
        // regex heuristic.
        compare: regexWouldBlock,
        // sessionId/turnRef: this is the live speculation add-block path (Jev
        // 'on' can add a block here), so every logged row must be joinable
        // back to the transcript it decided on -- see jev-assist.js header.
        sessionId,
        // Omitted when the judged text came from the Stop payload: the
        // transcript's last line may then be the PREVIOUS turn, and a wrong
        // pointer is worse than none.
        turnRef: payloadText !== null ? undefined : require('./lib/jev-assist.js').turnRefFromTranscript(transcriptPath),
      });
      if (result.jev === null) {
        // Either the 'speculation' integration is switched off via jev.json's
        // integrations map (Jev overall enabled, this one specifically not),
        // or the ask() call itself never ran — nothing new to log unless a
        // real jevDecide failure produced a reason.
        if (result.reason) {
          logEntry = {
            backend: 'jev→regex', reason: result.reason,
            ms: result.ms != null ? result.ms : null, confidence: null,
            regexVerdict: regexWouldBlock,
          };
        }
      } else if (result.final === true) {
        jevBlock = true;
        jevResultHash = result.h;
        logEntry = { backend: 'jev', reason: 'confident', ms: result.ms, confidence: result.confidence, regexVerdict: regexWouldBlock };
      } else {
        logEntry = {
          backend: 'jev→regex',
          reason: result.confident ? 'confident-allow-untrusted' : 'low-confidence',
          ms: result.ms != null ? result.ms : null,
          confidence: result.confidence,
          regexVerdict: regexWouldBlock,
        };
      }
    }
  } catch (_) {
    // Jev path unavailable for any reason — regex decides.
  }

  const finish = (verdict) => {
    if (logEntry) appendJevLog({ ts: new Date().toISOString(), ...logEntry, verdict });
    process.exit(0);
  };

  let marker = null;
  let hitIndex = null;
  if (!jevBlock) {
    // Check for speculation markers.
    const hit = findSpeculationHit(markerText);
    if (!hit) finish('allow');
    marker = hit.marker;
    hitIndex = hit.index;

    // Check for acknowledgment — if present, hedging is honest; allow.
    if (hasAcknowledgment(lastText)) finish('allow');
  }

  if (loopSafe) finish('allow');

  // FRAMED-EXPECTATION relaxation (jevIntegrations.speculationFramed, default
  // shadow): only for a genuine deterministic regex hit (never a jevBlock
  // verdict — that path is judged by the 'speculation' integration itself)
  // whose hit sits under a heading/line-prefix framing it as a plan/
  // expectation (isFramedHit). relax-block trust: Jev may only turn this
  // block into a non-block. shadow logs the verdict but ALWAYS keeps the
  // block (jev-assist's finalize() only applies the trust math when
  // mode==='on'); any Jev failure/timeout/low-confidence also keeps the
  // block (fail-safe to baseline=true). An unframed hedge never reaches here.
  if (!jevBlock && marker !== null && isFramedHit(markerText, hitIndex)) {
    try {
      const { loadJevConfig } = require('./lib/jev-client.js');
      const jevCfg = loadJevConfig();
      if (jevCfg.enabled) {
        // Measure-everything: the framed-hit TRIGGER occurred. The 'speculationFramed'
        // call row only exists once ask() runs, so a never-fired trigger and a
        // fired-but-gated one are otherwise indistinguishable (jev report: "triggers seen").
        appendJevLog({ ts: new Date().toISOString(), event: 'trigger', id: 'speculationFramed', outcome: 'seen' });
        const { ask, turnRefFromTranscript } = require('./lib/jev-assist.js');
        const jevText = payloadText !== null ? payloadText : (extractLastAssistantTextDedup(transcriptPath) || lastText);
        const framedResult = await ask({
          id: 'speculationFramed',
          question: FRAMED_JEV_QUESTION,
          state: jevText.slice(0, 8000),
          trust: 'relax-block',
          baseline: true,
          sessionId,
          turnRef: payloadText !== null ? undefined : turnRefFromTranscript(transcriptPath),
        });
        if (framedResult.final === false) finish('allow');
      }
    } catch (_) {
      // Jev path unavailable for any reason — the deterministic block stands
      // (fail-safe to baseline).
    }
  }

  // Persist the blocked hash + incremented count + a pending outcome-capture
  // record (source + a hash to join back to later) before outputting the
  // decision. Regex-sourced blocks never call ask(), so they have no
  // jev-assist decision hash to join to — msgHash still uniquely identifies
  // the outcome row for `jev report`'s per-source comparison.
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const pendingRecord = jevBlock
      ? { h: jevResultHash || msgHash, source: 'jev' }
      : { h: msgHash, source: 'regex' };
    fs.writeFileSync(stateFile, JSON.stringify({ hash: msgHash, blocks: blocks + 1, pending: pendingRecord }), 'utf8');
  } catch (_) {
    // Can't persist -> fail-open to avoid loops.
    finish('allow');
  }
  // Opportunistic bounded self-prune of OTHER stale speculation-guard-state-*
  // files (one per session, never cleaned otherwise — see lib/state-prune.js).
  try {
    require('./lib/state-prune.js').pruneStale({
      stateDir, prefix: 'speculation-guard-state', keepFile: stateFile,
    });
  } catch (_) {}

  const reason = jevBlock
    ? 'anti-hall speculation-guard: your reply asserts a cause or outcome without ' +
      'citing evidence (command output, a test result, or a file:line reference). ' +
      'Verify it with a tool, or explicitly say what\'s unverified / \'I don\'t know - ' +
      'here\'s what I\'d check\', then continue.'
    : 'anti-hall speculation-guard: your reply states something speculative (\'' +
      marker +
      '\') without verifying it or flagging it as unverified. ' +
      'Verify it with a tool, or explicitly say what\'s unverified / \'I don\'t know - ' +
      'here\'s what I\'d check\', then continue.';

  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
  finish('block');
}

main().catch(() => {
  // Fail-open: never wedge a Stop.
  process.exit(0);
});
