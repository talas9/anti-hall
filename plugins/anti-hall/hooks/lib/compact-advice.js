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
const LEADING_REMINDERS_RE = /^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>)+/;
const NOTIFY_RE = /^\s*<task-notification>/;
const COMPACT_CMD_RE = /^\s*<command-name>\s*\/compact\s*<\/command-name>/;

// ---------------------------------------------------------------- phrasing
// Negation just before a match ("NOT SAFE to compact", "no need to /compact",
// "RETRACT SAFE TO COMPACT", "far from safe to compact", "nowhere near a good
// point to /compact", "once this lands it will be safe to compact") means it
// is not a recommendation — it is either negated outright or made
// conditional on something not yet done.
const NEGATION_BEFORE_RE = /(?:\bnot\s+yet\b|\bnot\b|n['’]t\b|\bnever\b|\bno\s+need\b|\bno\s+reason\b|\bfar\s+from\b|\bnowhere\s+near\b|\bonce\b[\s\S]{0,60}\bit\s+will\s+be\b|\bretract(?:ed|ing)?\b)[^.!?\n]{0,20}$/i;

// Negation just AFTER a match ("safe to compact, but first I need to write
// the progress file", "safe to compact; first ...", "SAFE TO COMPACT after
// the handover file is written") — a future/conditional declaration gated
// on something not yet done, not a present-tense recommendation.
const NEGATION_AFTER_RE = /^[^.!?\n]{0,30}[,;]\s*(?:but\s+|and\s+)?first\b|^\s*(?:after|once|when|if)\b/i;

// Conditional/meta LEAD-INS just BEFORE a match:
//   "When CI is green: safe to compact." (if|when|once|after|until ... :)
//   "I will only say SAFE TO COMPACT ..." / "The guard fires when I write
//   SAFE TO COMPACT ..." — describing the RULE for declaring, not declaring.
// Neither is a present-tense recommendation.
const CONDITIONAL_BEFORE_RE = /\b(?:if|when|once|after|until)\b[^:\n]{0,60}:\s*$/i;
const META_BEFORE_RE = /\bwill\s+(?:only\s+)?(?:say|write|declare)\s*$|\bwhen\s+I\s+(?:say|write|declare)\s*$/i;

// A1-CA-1: explicit declaration forms only. Free text that merely mentions
// /compact or "clear" in passing ("safe to clear the cache", a bullet
// explaining what /compact does) must NOT match — only an actual
// recommendation/instruction to compact does:
//   "SAFE TO COMPACT" (bare word ok), "safe to /compact" (slash required for
//   "clear" — bare "clear" is too common a word), "good point to /compact",
//   Codex "safe for a context reset/compaction", "run /compact" / "/compact
//   now" / "then /compact" etc., and a standalone /compact invocation line
//   (optionally bulleted/backticked) whose trailing content is only "now" or
//   a "focus: …" argument — not prose that happens to start with /compact.
const ADVICE_RES = [
  // "✅ SAFE TO COMPACT NOW", "safe to /compact", "safe to /clear"
  /\bsafe\s+to\s+(?:\/compact|compact|\/clear)\b/gi,
  // "GOOD POINT TO /compact NOW", "good time to compact", Codex "GOOD POINT FOR /compact OR /new NOW"
  /\bgood\s+(?:point|time|moment)\s+(?:to|for)\s+(?:\/?compact|\/?clear|\/new)\b/gi,
  // Codex skill wording: "safe for a context reset", "safe for compaction"
  /\bsafe\s+for\s+(?:a\s+)?(?:context\s+)?(?:reset|compaction|\/?compact|\/new)\b/gi,
  // "/compact" offered as an instruction: "run `/compact focus: …`", "then /compact"
  /\b(?:run|type|use|do|then|now|recommend(?:ed)?|suggest(?:ed)?)\s*:?\s*`*\/compact\b/gi,
  // a standalone /compact invocation line ("`/compact focus: …`", "- /compact now",
  // bare "/compact") — the WHOLE line (after an optional bullet/backticks),
  // not a sentence that merely starts with /compact ("- /compact clears the
  // context automatically" does not match: trailing content isn't "now"/"focus:…").
  /^[ \t]*(?:[-*+]|\d+[.)])?[ \t]*`*\/compact\b(?:[ \t]+(?:now|focus:\s*\S[^\n]*))?[ \t]*`*[ \t]*$/gim,
];

const RETRACT_RE = /\bretract(?:ed|ing)?\b[\s:,\-—–*_`"'“”]*(?:the\s+)?(?:[*_`✅🟢]\s*)*(?:safe[\s-]+(?:to|for)[\s-]+(?:compact|clear|reset|a\s+(?:context\s+)?reset)|good\s+point\s+(?:to|for)\s+\/?compact|\/compact)/gi;

// stripQuoted(text) -> text with fenced code blocks, blockquote lines, and
// “…” / “…” / '…' / `…` quoted spans blanked to spaces (same length, so
// indices stay comparable). A /compact line the assistant merely QUOTES from
// the user, or shows inside a ```fenced``` example block (illustrating
// syntax, not recommending it now), is not its own recommendation — the same
// is true of a phrase like `SAFE TO COMPACT` or 'SAFE TO COMPACT' quoted
// while describing what some OTHER guard/skill does (R3A1/#29). A
// single-quoted or backtick-quoted span that itself names an actual
// /compact|/clear|/new invocation is left intact — “`run /compact`”-style
// instructions still match; it is only a quoted MENTION of the declaration
// phrase (no slash command inside the quotes) that gets blanked.
function stripQuoted(text) {
  let t = String(text || '');
  t = t.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '));
  t = t.replace(/^[ \t]*>.*$/gm, (m) => ' '.repeat(m.length));
  t = t.replace(/”[^”\n]{0,400}”|“[^”\n]{0,400}”|"[^"\n]{0,400}"/g, (m) => ' '.repeat(m.length));
  // An inline-code span naming /compact|/clear|/new stays intact ONLY as an
  // instruction: right after an instruction verb ("run `/compact`") or opening
  // its own line (optionally bulleted). Anywhere else ("the `/compact focus:`
  // line no longer counts") it is a mention and is blanked like any other span.
  t = t.replace(/`[^`\n]{0,400}`/g, (m, off) => {
    if (!/\/(?:compact|clear|new)\b/i.test(m)) return ' '.repeat(m.length);
    const before = t.slice(Math.max(0, off - 40), off);
    const instruction = /(?:^|\n)[ \t]*(?:[-*+]|\d+[.)])?[ \t]*$/.test(before) ||
      /\b(?:run|type|use|do|then|now|recommend(?:ed)?|suggest(?:ed)?)\s*:?\s*$/i.test(before);
    return instruction ? m : ' '.repeat(m.length);
  });
  // Boundary-aware so a contraction's apostrophe (“don't”, “it's”) is never
  // mistaken for an opening quote: the opening quote must be preceded by
  // start-of-string/whitespace/an opening bracket, and the closing quote
  // must be followed by whitespace/punctuation/end-of-string.
  t = t.replace(/(^|[\s([{])'([^'\n]{0,400})'(?=[\s.,;:!?)\]}]|$)/g, (m, pre, inner) =>
    /\/(?:compact|clear|new)\b/i.test(inner) ? m : pre + ' '.repeat(inner.length + 2)
  );
  return t;
}

// A short leading interjection/adverb that can genuinely open a sentence
// before a comma-prefixed declaration ("Yes, safe to compact now.",
// "Overall, safe to compact now."). Deliberately small and mundane — this is
// NOT a general "any word + comma" allowance (that would swallow "Safe to
// compact, but first I need to write the progress file", which must stay
// negated by NEGATION_AFTER_RE, not re-opened here as positioned-but-safe).
const LEAD_INTERJECTION_RE = /^(?:yes|yeah|yep|no|nope|ok|okay|sure|right|correct|agreed|indeed|actually|honestly|overall|great|good|alright|well|so|also|anyway|regardless)$/i;

// isAtSentenceOrLineStart(t, index) -> bool. Walks back over whitespace and
// decorative markdown/emoji/bullet characters; true when what remains before
// the match is the start of the string, a newline crossed during the walk
// (the match is at the start of its own line, even if that line did not end
// in sentence-terminal punctuation), or a sentence-terminal punctuation mark
// (. ! ? :). A single short leading interjection/adverb immediately followed
// by a comma (itself at a real sentence/line start) also counts (R2-2) —
// "Yes, safe to compact now." is a genuine declaration, not conditional or
// mid-sentence prose.
function isAtSentenceOrLineStart(t, index) {
  let i = index;
  let crossedNewline = false;
  while (i > 0 && /[\s*_`"'“”✅🟢⏳❌⚠️\-•>]/.test(t[i - 1])) {
    if (t[i - 1] === '\n') crossedNewline = true;
    i--;
  }
  if (i === 0 || crossedNewline) return true;
  if (/[.!?:]/.test(t[i - 1])) return true;
  if (t[i - 1] === ',') {
    let j = i - 1;
    while (j > 0 && /\s/.test(t[j - 1])) j--;
    let k = j;
    while (k > 0 && /[A-Za-z]/.test(t[k - 1])) k--;
    if (k < j && LEAD_INTERJECTION_RE.test(t.slice(k, j))) {
      let s = k;
      let crossed2 = false;
      while (s > 0 && /\s/.test(t[s - 1])) {
        if (t[s - 1] === '\n') crossed2 = true;
        s--;
      }
      if (s === 0 || crossed2 || /[.!?:]/.test(t[s - 1])) return true;
    }
  }
  return false;
}

// isQuestionSentence(t, index) -> bool. True when the sentence containing
// this match ENDS in "?" — "Is it safe to compact now?" is asking, not
// declaring ("R3A1/#29").
function isQuestionSentence(t, index) {
  const m = /[.!?]/.exec(t.slice(index));
  return !!m && m[0] === '?';
}

// findAdvice(text) -> [{ index, phrase }] sorted by index — the assistant's
// own compact recommendations, negated/quoted/questioned ones excluded. The
// bare "safe to compact/clear" wording (ADVICE_RES[0]) and the
// run/type/use/do/then/now/recommend/suggest /compact form (ADVICE_RES[3])
// only count at a line or sentence start, or (ADVICE_RES[0] only) when it is
// the unambiguous ALL-CAPS "SAFE TO COMPACT" form wherever it sits — the
// more specific forms in between (good point to/for, safe for a context
// reset) and the standalone /compact line after it are already anchored
// enough on their own and need no extra position gate (R3A1/#29).
//
// opts.declarationsOnly (PreToolUse compact-declaration-guard): count ONLY the
// explicit SAFE declaration forms (ADVICE_RES[0] "safe to compact", [2] "safe
// for a context reset"). The pause nag MANDATES a closing "GOOD POINT TO
// /compact NOW" line and a pasteable `/compact focus: …` command
// (hooks/lib/auto-handover-text.js); those must never block the agent's next
// tool call, so the "good point" / "run|then /compact" / standalone /compact
// forms are advice for the Stop guard only.
const DECLARATION_RE_INDEXES = new Set([0, 2]);
function findAdvice(text, opts) {
  const declarationsOnly = !!(opts && opts.declarationsOnly);
  const t = stripQuoted(text);
  const out = [];
  ADVICE_RES.forEach((re, reIndex) => {
    if (declarationsOnly && !DECLARATION_RE_INDEXES.has(reIndex)) return;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t)) !== null) {
      const before = t.slice(Math.max(0, m.index - 60), m.index);
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40);
      const negated = NEGATION_BEFORE_RE.test(before) || NEGATION_AFTER_RE.test(after) ||
        CONDITIONAL_BEFORE_RE.test(before) || META_BEFORE_RE.test(before);
      const questioned = isQuestionSentence(t, m.index);
      const isBareSafePhrase = reIndex === 0;
      const isCommandForm = reIndex === 3;
      const isAllCapsSafeToCompact = isBareSafePhrase && /^SAFE\s+TO\s+(?:\/?COMPACT|\/CLEAR)$/.test(m[0].trim());
      const positioned = (!isBareSafePhrase && !isCommandForm) || isAllCapsSafeToCompact || isAtSentenceOrLineStart(t, m.index);
      if (!negated && !questioned && positioned) out.push({ index: m.index, phrase: m[0].trim() });
      if (m[0].length === 0) re.lastIndex++;
    }
  });
  return out.sort((a, b) => a.index - b.index);
}

// A line that BEGINS with the word RETRACT/RETRACTED/RETRACTING is a retraction
// whatever follows it ("RETRACT — not a good point to compact", "RETRACT: the
// compact recommendation, still working"). RETRACT_RE above only knew the
// canonical "RETRACT SAFE TO COMPACT" shape, so a free-form retraction line left
// the earlier declaration active and the guard kept blocking for the whole turn.
// Line-start anchored so prose that merely mentions the word mid-sentence is not one.
const LINE_RETRACT_RE = /^[ \t]*[*_`>\-•]*[ \t]*retract(?:ed|ing)?\b/gim;

// lastRetraction(text) -> index of the last retraction line, or -1.
function lastRetraction(text) {
  const t = String(text || '');
  let last = -1;
  let m;
  RETRACT_RE.lastIndex = 0;
  while ((m = RETRACT_RE.exec(t)) !== null) last = Math.max(last, m.index);
  LINE_RETRACT_RE.lastIndex = 0;
  while ((m = LINE_RETRACT_RE.exec(t)) !== null) last = Math.max(last, m.index);
  return last;
}

// activeDeclaration(text) -> the last advice match NOT followed by a
// retraction, or null.
function activeDeclaration(text, opts) {
  const adv = findAdvice(text, opts);
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
    // Hook-injected <system-reminder> blocks may precede (or be bundled with)
    // the real prompt; judge the prompt by what is left after them.
    const typed = txt.replace(LEADING_REMINDERS_RE, '');
    if (!typed.trim() || NOT_TYPED_RE.test(typed) || COMPACT_CMD_RE.test(typed)) return null;
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
