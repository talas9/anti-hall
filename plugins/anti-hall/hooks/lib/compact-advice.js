// anti-hall :: compact-advice — shared transcript reading for the two
// "don't recommend /compact wrongly" guards:
//   hooks/compact-advice-guard.js       (Stop)       — low context / recent compact
//   hooks/compact-declaration-guard.js  (PreToolUse) — no new work after SAFE
//
// WHAT IT READS (Claude transcript AND Codex rollout):
//   - assistant TEXT of the current turn, in order. The current turn starts
//     after the last REAL user message: a typed prompt or a slash command.
//     Tool results, meta/caveat entries, <task-notification>/<system-reminder>
//     injections, <local-command-*> output, the compact summary itself
//     (isCompactSummary) and the `/compact` command line do NOT start a turn —
//     a background agent's notification arriving after "SAFE TO COMPACT" must
//     not silently re-open work.
//   - the FINAL message of the turn: assistant text after the last tool call
//     or tool result (what the user reads when the turn ends).
//   - the COMPACT BOUNDARY. Claude writes
//       {"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"manual"|"auto",...}}
//     followed by a user entry with "isCompactSummary":true. Codex writes a
//     {"type":"compacted",...} rollout item and/or an
//     {"type":"event_msg","payload":{"type":"context_compacted"}} event.
//     turnsSinceCompact = number of responses started after the newest
//     boundary — real user messages AND <task-notification>s (autonomous
//     sessions run many turns on notifications alone); 0 = the compact
//     happened inside this very response.
//
// Pure Node built-ins; never throws on well-formed or malformed input.

'use strict';

// Injected (not typed) user content — never starts a turn.
const NOT_TYPED_RE = /^\s*<(task-notification|local-command-|system-reminder|bash-std(out|err))/;
// A background task's notification starts a new assistant response (it counts
// toward turnsSinceCompact) but NOT a new user turn.
const NOTIFY_RE = /^\s*<task-notification>/;
const COMPACT_CMD_RE = /^\s*<command-name>\s*\/compact\s*<\/command-name>/;

// ---------------------------------------------------------------- phrasing
// Negation just before a match ("NOT SAFE to compact", "no need to /compact",
// "RETRACT SAFE TO COMPACT") means it is not a recommendation.
const NEGATION_BEFORE_RE = /(?:\bnot\b|n['’]t\b|\bnever\b|\bno need\b|\bno reason\b|\bretract(?:ed|ing)?\b)[^.!?\n]{0,20}$/i;

const ADVICE_RES = [
  // "✅ SAFE TO COMPACT NOW", "safe to /compact or /clear"
  /\bsafe\s+to\s+\/?(?:compact|clear)\b/gi,
  // "GOOD POINT TO /compact NOW", "good time to compact"
  /\bgood\s+(?:point|time|moment)\s+to\s+\/?(?:compact|clear)\b/gi,
  // "/compact" offered as an instruction: "run `/compact focus: …`", "then /compact"
  /\b(?:run|type|use|do|then|now|recommend(?:ed)?|suggest(?:ed)?)\s*:?\s*`*\/compact\b/gi,
  // a line that IS a /compact command ("`/compact focus: …`", "- /compact")
  /^[ \t]*(?:[-*+]|\d+[.)])?[ \t]*`*\/compact\b/gim,
];

const RETRACT_RE = /\bretract(?:ed|ing)?\b[\s:,\-—–*_`"'“”]*(?:the\s+)?(?:[*_`✅🟢]\s*)*(?:safe[\s-]+to[\s-]+(?:compact|clear)|good\s+point\s+to\s+\/?compact|\/compact)/gi;

// stripQuoted(text) -> text with blockquote lines and "…" / “…” quoted spans
// blanked to spaces (same length, so indices stay comparable). A /compact line
// the assistant merely QUOTES from the user is not its own recommendation.
function stripQuoted(text) {
  let t = String(text || '');
  t = t.replace(/^[ \t]*>.*$/gm, (m) => ' '.repeat(m.length));
  t = t.replace(/"[^"\n]{0,400}"|“[^”\n]{0,400}”/g, (m) => ' '.repeat(m.length));
  return t;
}

// findAdvice(text) -> [{ index, phrase }] sorted by index — the assistant's
// own compact recommendations, negated/quoted ones excluded.
function findAdvice(text) {
  const t = stripQuoted(text);
  const out = [];
  for (const re of ADVICE_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t)) !== null) {
      const before = t.slice(Math.max(0, m.index - 40), m.index);
      if (!NEGATION_BEFORE_RE.test(before)) out.push({ index: m.index, phrase: m[0].trim() });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

// lastRetraction(text) -> index of the last "RETRACT SAFE TO COMPACT"-style line, or -1.
function lastRetraction(text) {
  const t = String(text || '');
  RETRACT_RE.lastIndex = 0;
  let last = -1;
  let m;
  while ((m = RETRACT_RE.exec(t)) !== null) last = m.index;
  return last;
}

// activeDeclaration(text) -> the last advice match NOT followed by a
// retraction, or null.
function activeDeclaration(text) {
  const adv = findAdvice(text);
  if (!adv.length) return null;
  const last = adv[adv.length - 1];
  return lastRetraction(text) > last.index ? null : last;
}

// ---------------------------------------------------------------- transcript
function textOfBlocks(content, textTypes) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && textTypes.includes(b.type) && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

// classify(line) -> one normalized event or null:
//   { kind: 'user' }            a real user message (starts a turn)
//   { kind: 'notify' }          a <task-notification> (new response, same turn)
//   { kind: 'text', text }      assistant text
//   { kind: 'tool' }            assistant tool call or a tool result
//   { kind: 'compact', at }     a compact boundary (at = ms timestamp or null)
function tsOf(e) {
  const ms = e && typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function classify(line) {
  if (!line) return null;
  let e;
  try { e = JSON.parse(line); } catch (_) { return null; }
  if (!e || typeof e !== 'object') return null;

  // ---- Claude transcript
  if (e.type === 'system' && e.subtype === 'compact_boundary') return { kind: 'compact', at: tsOf(e) };
  if (e.isSidechain === true) return null;
  if (e.type === 'user' && e.message) {
    if (e.isMeta || e.isCompactSummary) return null;
    const c = e.message.content;
    if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) return { kind: 'tool' };
    const txt = textOfBlocks(c, ['text']);
    if (NOTIFY_RE.test(txt)) return { kind: 'notify' };
    if (!txt.trim() || NOT_TYPED_RE.test(txt) || COMPACT_CMD_RE.test(txt)) return null;
    return { kind: 'user' };
  }
  if (e.type === 'assistant' && e.message) {
    const c = e.message.content;
    const events = [];
    if (Array.isArray(c)) {
      for (const b of c) {
        if (!b) continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) events.push({ kind: 'text', text: b.text });
        else if (b.type === 'tool_use') events.push({ kind: 'tool' });
      }
    } else if (typeof c === 'string' && c.trim()) {
      events.push({ kind: 'text', text: c });
    }
    return events.length === 1 ? events[0] : (events.length ? { kind: 'multi', events } : null);
  }

  // ---- Codex rollout
  if (e.type === 'compacted') return { kind: 'compact', at: tsOf(e) };
  const p = e.payload;
  if (!p || typeof p !== 'object') return null;
  if (e.type === 'event_msg') {
    if (p.type === 'context_compacted') return { kind: 'compact', at: tsOf(e) };
    if (p.type === 'user_message' && typeof p.message === 'string' && p.message.trim() && !NOT_TYPED_RE.test(p.message)) {
      return { kind: 'user' };
    }
    return null;
  }
  if (e.type === 'response_item') {
    if (p.type === 'message' && p.role === 'assistant') {
      const txt = textOfBlocks(p.content, ['output_text', 'text']);
      return txt.trim() ? { kind: 'text', text: txt } : null;
    }
    if (/(?:function_call|tool_call|shell_call)/.test(String(p.type || ''))) return { kind: 'tool' };
  }
  return null;
}

// readTurn(lines) -> { turnText, finalText, turnsSinceCompact, compactAt }
//   turnText          : all assistant text since the last real user message
//   finalText         : assistant text after the last tool call/result of that turn
//   turnsSinceCompact : null when no compact boundary is visible in `lines`
//   compactAt         : ms timestamp of the newest boundary (null if unknown)
function readTurn(lines) {
  let turnParts = [];
  let finalParts = [];
  let turnsSinceCompact = null;
  let compactAt = null;
  const apply = (ev) => {
    if (ev.kind === 'user') {
      turnParts = []; finalParts = [];
      if (turnsSinceCompact !== null) turnsSinceCompact++;
    } else if (ev.kind === 'notify') {
      finalParts = [];
      if (turnsSinceCompact !== null) turnsSinceCompact++;
    } else if (ev.kind === 'compact') {
      turnsSinceCompact = 0;
      compactAt = ev.at;
    } else if (ev.kind === 'tool') {
      finalParts = [];
    } else if (ev.kind === 'text') {
      turnParts.push(ev.text); finalParts.push(ev.text);
    }
  };
  for (const line of lines || []) {
    const ev = classify(line);
    if (!ev) continue;
    if (ev.kind === 'multi') ev.events.forEach(apply); else apply(ev);
  }
  return { turnText: turnParts.join('\n'), finalText: finalParts.join('\n'), turnsSinceCompact, compactAt };
}

module.exports = { findAdvice, lastRetraction, activeDeclaration, stripQuoted, classify, readTurn };
