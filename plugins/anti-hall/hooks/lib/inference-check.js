'use strict';
// anti-hall :: inference-check — deterministic "unsupported causal claim" detector.
//
// speculation-guard's markers are hedge words, so a confident inference with no
// hedge ("The crash is caused by the cache race.") passes it. This module finds
// causal or attributive sentences in the reply ("caused by", "the root cause
// is", "Root cause: X", "because", "is due to", "stems from", "comes down to",
// "this means", "the culprit is", "that's why", "X is what crashes Y", "the
// <symptom> is the ...") and asks one question: does any
// tool evidence in the transcript window mention what the sentence names as the
// cause? If nothing does, the sentence is an unsupported inference.
//
// Evidence = tool results (Claude tool_result, Codex *_call_output), the inputs
// of observation tools (a Bash command, a Read path, a grep pattern), fenced
// blocks the user pasted, and task notifications. The assistant's own prose and
// anything it authored (Write/Edit/apply_patch inputs, messages it sent) never
// count: an earlier unsupported claim must not support a later one.
//
// "Mentions" = the cause clause's distinctive tokens co-occur in ONE evidence
// chunk: one code-like identifier (dotted, snake_case, camelCase, a path), or
// at least two content words (one if the clause has only one). The window is
// the transcript tail, not only the current turn, so evidence gathered a turn
// earlier still counts (precision first).
//
// Skipped sentences (not claims about the project's current state): questions,
// conditionals/hypotheticals, modal hedges (speculation-guard's job),
// first-person design rationale or plans ("I used X because ..."), sentences
// inside quotes/code (the caller passes quote-masked text), and replies that
// say the claim is unverified.
//
// Known limits: lexical. A confident claim with no causal wording ("The cache
// race crashes the worker.") is not seen, "since" is skipped (too often
// temporal), and a tool call that merely echoes the claim's words counts as
// evidence. Opt-in semantic coverage for those is
// speculation-judge (jev.semanticJudge).
//
// Pure Node built-ins. Every entry point is total: bad input -> null / [].

const CONNECTIVES = [
  // cause AFTER the connective
  { re: /\b(?:is|are|was|were|being|been)\s+(?:caused|triggered|driven)\s+by\b/i },
  { re: /\bcaused\s+by\b/i },
  // "the cause is fixed/proven/unknown" reports status, not a cause.
  { re: /\b(?:the\s+)?(?:root\s+)?cause\s+(?:is|was)\b(?!\s+(?:not|now|still|fixed|proven|known|unknown|unclear|confirmed|resolved|addressed|un\w+)\b)/i },
  { re: /\b(?:is|are|was|were)\s+due\s+to\b/i },
  { re: /\bdue\s+to\b/i },
  { re: /\bbecause(?:\s+of)?\b/i },
  // "results from" / "resulted from" only: "the result from X" is a noun phrase.
  { re: /\b(?:stems?|stemmed|comes?|came|results|resulted|originates?|originated)\s+from\b/i },
  { re: /\b(?:this|that|which|it)\s+means\b/i },
  { re: /\bthe\s+culprit\s+(?:is|was)\b/i },
  // Label forms: "Root cause: X", "Cause: X" (not "cause: unknown/unclear/...").
  { re: /\b(?:root\s+)?cause\s*:(?!\s*(?:not|still|fixed|proven|known|unknown|unclear|confirmed|resolved|tbd|n\/a|un\w+)\b)/i },
  { re: /\b(?:comes?|came|boils?|boiled)\s+down\s+to\b/i },
  { re: /\bthat'?s\s+why\b/i },
  { re: /\bthe\s+(?:issue|problem|bug|reason)\s+(?:is|was)\b/i },
  // "the one failure is the known X test" reports a test result, not a cause.
  { re: /\b(?:crash|crashes|failure|failures|error|errors|leak|lag|slowdown|spike|jump|mismatch|flake|hang|regression|outage|offset|drop|drops|delay|rollback|duplicates)\s+(?:is|are|was|were)\s+(?:the|a|an)\b(?!\s+(?:known|expected|same|only|one)\b)/i },
  // cause BEFORE the connective
  { re: /\b(?:is|was)\s+the\s+(?:culprit|root\s+cause|cause)\b/i, before: true },
  { re: /\b(?:is|was)\s+(?:responsible|to\s+blame)\s+for\b/i, before: true },
  { re: /\b(?:is|was)\s+what\s+(?:causes|caused|breaks|broke|triggers|triggered|crashes|crashed|slows|slowed|blocks|blocked)\b/i, before: true },
];

// Cheap pre-filter so a reply with no causal wording costs one regex test.
const ANY_CONNECTIVE_RE = new RegExp(CONNECTIVES.map((c) => c.re.source).join('|'), 'i');

// Not a claim about the project's current state.
// Negated forms (can't, couldn't, won't) state a fact, not a possibility.
const HYPOTHETICAL_RE = /\b(?:if|whether|suppose|supposing|assuming|unless|would|could|might|may|can)\b(?!['\u2019]t)/i;
const FIRST_PERSON_RE = /(?:^|[^\w'])(?:I|we|We|I'(?:ll|d|ve|m))(?=[\s,])/;
const PLAN_PREFIX_RE = /^\s*(?:[-*+•]\s+|\d+[.)]\s+)?(?:(?:the\s+)?plan|next(?:\s+step)?|todo|proposal|option\s+\w+|step\s+\d+)\s*[:\-—]/i;
const UNVERIFIED_RE = /\b(?:unverified|not\s+(?:yet\s+)?(?:verified|confirmed|checked)|ha(?:ve|s)n'?t\s+(?:yet\s+)?(?:verified|confirmed|checked)|ha(?:ve|s)\s+not\s+(?:yet\s+)?(?:verified|confirmed|checked)|i\s+don'?t\s+know|let\s+me\s+(?:verify|check|confirm)|need\s+to\s+(?:verify|confirm|check))\b/i;

// Function words + words too generic to identify a cause.
const STOP = new Set((
  'a an the and or but nor so yet for of to in on at by with from into onto over under about after before ' +
  'between through during without within across against along around than then that this these those there ' +
  'here it its it\'s they them their he she his her we our you your i me my is are was were be been being ' +
  'am do does did done has have had having not no nor only also just still even very too more most less ' +
  'least much many some any all each every both either neither one two three first second last new old ' +
  'same other another such what which who whom whose when where why how because since due cause caused ' +
  'causes causing root reason means mean meaning culprit issue issues problem problems bug bugs thing things ' +
  'way ways case cases part parts kind lot lots time times now today yesterday again ever never always ' +
  'will would should could might may can must shall get gets got getting make makes made making use uses ' +
  'used using run runs ran running set sets setting go goes went going come comes came coming take takes ' +
  'took see sees saw seen show shows showed shown look looks looked keep keeps kept stay stays stayed ' +
  'instead actually really already anymore longer like as if else while until unless though although ' +
  'whether every per via etc file files code line lines value values data thing step steps result results ' +
  'resulted stems stem stemmed comes originates originated triggered driven responsible blame why that\'s ' +
  'happens happened happen work works worked working fail fails failed failing break breaks broke broken ' +
  'error errors wrong right correct incorrect still slower faster slow fast large small huge big'
).split(/\s+/));

// IDENT_RE: code-like identifiers (a.b, snake_case, camelCase, paths, flags, numbers with units).
const IDENT_RE = /^(?:[\w-]+\.[\w.-]+|[a-z0-9]+_[\w]+|[a-z]+[A-Z]\w*|[A-Z]{2,}\w*|\/[\w./-]+|--?[\w-]+|[\w:.-]*\d[\w:.-]*)$/;

function stem(w) {
  return w.replace(/(?:ing|ed|es|s)$/i, '').slice(0, 7);
}

// tokensOf(clause) -> { idents: [lowercased], words: [stems] }
function tokensOf(clause) {
  const idents = new Set();
  const words = new Set();
  const raw = String(clause).match(/[\w./:'-]+/g) || [];
  for (let t of raw) {
    t = t.replace(/^['.:-]+|['.:-]+$/g, '');
    if (!t) continue;
    const lower = t.toLowerCase();
    if (STOP.has(lower)) continue;
    if (IDENT_RE.test(t) && (/[a-z]/i.test(t) ? t.length >= 3 : t.length >= 4)) { idents.add(lower); continue; }
    if (lower.length < 4 || !/^[a-z]+$/.test(lower)) continue;
    words.add(stem(lower));
  }
  return { idents: [...idents], words: [...words] };
}

// splitSentences(text) -> [{ text, start }] with offsets into `text`. Splits on
// newlines and on sentence punctuation followed by whitespace and a capital,
// digit, quote or bracket, so dotted identifiers (fx.ts, Math.trunc) stay whole.
function splitSentences(text) {
  const out = [];
  const src = String(text);
  const lineRe = /[^\n]+/g;
  let lm;
  while ((lm = lineRe.exec(src)) !== null) {
    const line = lm[0];
    const cuts = [0];
    const sepRe = /(?<=[.!?])\s+(?=[A-Z0-9"'(`*])/g;
    let sm;
    while ((sm = sepRe.exec(line)) !== null) cuts.push(sm.index + sm[0].length);
    cuts.push(line.length + 1);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const seg = line.slice(cuts[i], Math.min(cuts[i + 1], line.length));
      const lead = seg.length - seg.trimStart().length;
      const body = seg.trim();
      if (body) out.push({ text: body, start: lm.index + cuts[i] + lead });
    }
  }
  return out;
}

// findCausalClaims(masked, raw?) -> [{ sentence, cause }]. `masked` is the reply
// after maskQuotedText (quoted/code spans blanked, offsets unchanged), so a
// connective inside a quote or code span is not a claim. When `raw` (the same
// reply, unmasked) is given, the sentence and its cause are read from it at the
// same offsets: an identifier the reply wrote in `code` stays part of the cause.
function findCausalClaims(masked, raw) {
  if (typeof masked !== 'string' || !ANY_CONNECTIVE_RE.test(masked)) return [];
  const src = (typeof raw === 'string' && raw.length === masked.length) ? raw : masked;
  const claims = [];
  for (const { text: s, start } of splitSentences(masked)) {
    if (/\?\s*$/.test(s)) continue;
    if (PLAN_PREFIX_RE.test(s)) continue;
    let best = null;
    for (const c of CONNECTIVES) {
      const m = c.re.exec(s);
      if (m && (best === null || m.index < best.m.index)) best = { c, m };
    }
    if (!best) continue;
    const head = s.slice(0, best.m.index);
    const tail = s.slice(best.m.index + best.m[0].length);
    // A modal in the head, or in the cause clause itself (up to the first
    // comma/colon/semicolon/dash), makes it a possibility, not a claim; a
    // trailing clause ("..., which I could fix next") does not.
    if (HYPOTHETICAL_RE.test(head) || HYPOTHETICAL_RE.test(tail.split(/[,:;\u2014]/)[0])) continue;
    if (FIRST_PERSON_RE.test(head)) continue;
    const rs = src.slice(start, start + s.length);
    const cause = best.c.before ? rs.slice(0, best.m.index) : rs.slice(best.m.index + best.m[0].length);
    claims.push({ sentence: rs, cause });
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Evidence collection from transcript JSONL lines (Claude and Codex shapes).
// ---------------------------------------------------------------------------
const OBSERVE_INPUT_TOOLS = /^(?:bash|read|grep|glob|ls|notebookread|webfetch|websearch|exec_command|shell|local_shell|container\.exec|exec|bashoutput|taskoutput|monitor|mcp__.*)$/i;
const MAX_CHUNK = 20000;

function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((b) => (b && typeof b === 'object') ? textOf(b.text != null ? b.text : b.content) : textOf(b)).join('\n');
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text;
    if (v.content != null) return textOf(v.content);
    if (typeof v.output === 'string') return v.output;
    try { return JSON.stringify(v); } catch (_) { return ''; }
  }
  return String(v);
}

function fencedBlocks(s) {
  const out = [];
  const re = /(```|~~~)[^\n]*\n([\s\S]*?)\1/g;
  let m;
  while ((m = re.exec(String(s))) !== null) out.push(m[2]);
  return out;
}

// collectEvidence(lines, { raw }) -> [string] evidence chunks, oldest first;
// lowercased unless raw (the semantic judge reads them as written).
function collectEvidence(lines, opts) {
  const raw = !!(opts && opts.raw);
  const chunks = [];
  const push = (s) => {
    const t = String(s || '');
    if (t.trim()) chunks.push(raw ? t.slice(0, MAX_CHUNK) : t.slice(0, MAX_CHUNK).toLowerCase());
  };
  for (const line of lines || []) {
    const trimmed = typeof line === 'string' ? line.trim() : '';
    if (!trimmed || trimmed[0] !== '{') continue;
    let e;
    try { e = JSON.parse(trimmed); } catch (_) { continue; }
    if (!e || typeof e !== 'object') continue;

    // Codex rollout
    if (e.type === 'response_item' && e.payload && typeof e.payload === 'object') {
      const p = e.payload;
      if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
        if (OBSERVE_INPUT_TOOLS.test(String(p.name || 'shell'))) push(textOf(p.arguments != null ? p.arguments : (p.input != null ? p.input : p.action)));
      } else if (/_output$/.test(String(p.type || ''))) {
        push(textOf(p.output));
      }
      continue;
    }
    if (e.type === 'event_msg' && e.payload && e.payload.type === 'user_message') {
      for (const b of fencedBlocks(e.payload.message)) push(b);
      continue;
    }

    // Claude transcript
    const msg = e.message && typeof e.message === 'object' ? e.message : e;
    const role = e.role || msg.role || e.type;
    const content = msg.content;
    if (role === 'assistant') {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === 'tool_use' && OBSERVE_INPUT_TOOLS.test(String(b.name || ''))) push(textOf(b.input));
        }
      }
    } else if (role === 'user') {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'tool_result') push(textOf(b.content));
          else if (b.type === 'text') {
            if (/<task-notification>/.test(b.text || '')) push(b.text);
            else for (const f of fencedBlocks(b.text)) push(f);
          }
        }
      } else if (typeof content === 'string') {
        if (/<task-notification>/.test(content)) push(content);
        else for (const f of fencedBlocks(content)) push(f);
      }
    }
  }
  return chunks;
}

// lastUserPrompt(lines) -> the newest typed user prompt (Claude or Codex shape), or ''.
// Tool results, task notifications and command/system wrappers are not prompts.
function lastUserPrompt(lines) {
  let last = '';
  for (const line of lines || []) {
    const trimmed = typeof line === 'string' ? line.trim() : '';
    if (!trimmed || trimmed[0] !== '{') continue;
    let e;
    try { e = JSON.parse(trimmed); } catch (_) { continue; }
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'event_msg' && e.payload && e.payload.type === 'user_message' && typeof e.payload.message === 'string') {
      last = e.payload.message;
      continue;
    }
    if (e.isMeta) continue;
    const msg = e.message && typeof e.message === 'object' ? e.message : e;
    if ((e.role || msg.role || e.type) !== 'user') continue;
    const c = msg.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c) && !c.some((b) => b && b.type === 'tool_result')) {
      text = c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
    }
    if (text.trim() && !/^\s*<(?:task-notification|command-|local-command|system-reminder)/.test(text)) last = text;
  }
  return last;
}

function supportedBy(cause, chunks) {
  const { idents, words } = tokensOf(cause);
  if (idents.length === 0 && words.length === 0) return true; // nothing assessable -> do not flag
  const need = Math.min(2, words.length);
  for (const ch of chunks) {
    if (idents.some((t) => ch.includes(t))) return true;
    let hits = 0;
    for (const w of words) if (ch.includes(w)) hits++;
    if (need > 0 && hits >= need) return true;
  }
  return false;
}

// findUnsupportedClaim(maskedReply, transcriptLines, rawReply?) -> { sentence, cause } | null
function findUnsupportedClaim(maskedReply, transcriptLines, rawReply) {
  try {
    if (typeof maskedReply !== 'string' || UNVERIFIED_RE.test(maskedReply)) return null;
    const claims = findCausalClaims(maskedReply, rawReply);
    if (claims.length === 0) return null;
    const chunks = collectEvidence(transcriptLines);
    for (const c of claims) if (!supportedBy(c.cause, chunks)) return c;
    return null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  findCausalClaims, collectEvidence, lastUserPrompt, supportedBy, findUnsupportedClaim, tokensOf, ANY_CONNECTIVE_RE,
};
