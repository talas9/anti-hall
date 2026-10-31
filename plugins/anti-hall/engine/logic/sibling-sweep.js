// check = "sibling-sweep" (Stop and SubagentStop; engine-only, no Node twin). When a reply states the cause of a bug in a fix
// context and the turn shows no search for other occurrences of the same pattern, remind the agent once to look for the
// siblings. The reminder IS a Stop block ({"decision":"block","reason":...}): a Stop event has no context channel, so the only
// way to put text in front of the agent is the block that continues the turn once. It is bounded: once per cause per turn,
// sibling_sweep.max_per_scope per scope, never on a Stop that already continues a Stop block, and it fails open.
// Every phrase, pattern, text and limit is a setting (sibling_sweep.toml, overridable by the owner's settings.json section
// `sibling_sweep` or config.toml), read through ah.cfgLive on every call, so an edit applies on the next call.
// Telemetry (logs/sibling-sweep.ndjson, hashes and counts only): one row per detected cause statement and one per resolved
// follow-through.
'use strict';

var sws = null; // the state of the call in progress: { memo: {key: value} }

// The owner's layers hold an invalid pattern: the shipped one is used and the problem is reported (the engine rate-limits the log).
function swBad(key) { ah.log('sibling-sweep', text.render(ah.cfg('sibling_sweep.msg_bad_setting'), { setting: key })); }

function swCfg(key) {
  if (!Object.prototype.hasOwnProperty.call(sws.memo, key)) sws.memo[key] = ah.cfgLive(key);
  return sws.memo[key];
}
function swNum(key) { return swCfg(key); }

// A pattern source of the owner's layers that does not compile is replaced by the shipped one (and reported once).
function swSpec(key, flags) {
  var id = key + '|' + flags;
  if (Object.prototype.hasOwnProperty.call(sws.memo, id)) return sws.memo[id];
  var src = swCfg(key), spec;
  try { ah.re.test(src, flags, ''); spec = { src: src, flags: flags }; } catch (e) { swBad(key); spec = { src: ah.cfg(key), flags: flags }; }
  sws.memo[id] = spec;
  return spec;
}
function swSpecs(key) {
  var id = key + '|list';
  if (Object.prototype.hasOwnProperty.call(sws.memo, id)) return sws.memo[id];
  var list = swCfg(key), out = [];
  try { list.forEach(function (s) { ah.re.test(s, 'i', ''); out.push({ src: s, flags: 'i' }); }); } catch (e) {
    swBad(key);
    out = ah.cfg(key).map(function (s) { return { src: s, flags: 'i' }; });
  }
  sws.memo[id] = out;
  return out;
}
// The prefilter spec (one regex every cue needs), or null when it is off: empty, or a cue list the owner edited (the prefilter
// words are those of the shipped cues, so it cannot judge a replaced list).
function swPre() {
  var id = 'prefilter';
  if (Object.prototype.hasOwnProperty.call(sws.memo, id)) return sws.memo[id];
  var pre = null;
  if (swCfg('sibling_sweep.prefilter_re') !== '' &&
      ['sibling_sweep.cause_cues', 'sibling_sweep.self_correction_cues'].every(function (k) { return JSON.stringify(swCfg(k)) === JSON.stringify(ah.cfg(k)); })) {
    pre = swSpec('sibling_sweep.prefilter_re', 'i');
  }
  sws.memo[id] = pre;
  return pre;
}
function swTest(spec, t) { return ah.re.test(spec.src, spec.flags, t); }

// Unicode White_Space (Rust's char::is_whitespace), which the sentence splitter uses.
function swIsSpace(c) {
  return c === 0x20 || (c >= 9 && c <= 13) || c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}
function swBlank(s) { for (var i = 0; i < s.length; i++) if (!swIsSpace(s.charCodeAt(i))) return false; return true; }
function swChars(s) { return Array.from(s); }
function swHead(s, n) { var a = swChars(s); return a.length <= n ? s : a.slice(0, n).join(''); }
function swTail(s, n) { var a = swChars(s); return a.length <= n ? s : a.slice(a.length - n).join(''); }
function swCollapse(s) { return s.replace(/\s+/g, ' '); }
// `s` cut to at most `max` UTF-8 bytes, at a character boundary.
function swCutBytes(s, max) {
  if (s.length * 3 <= max) return s;
  // all-ASCII text (one native scan): a byte is a unit, so the cut is a slice, not a loop over the text
  if (!ah.re.test('[^\\x00-\\x7f]', '', s)) return s.length <= max ? s : s.slice(0, max);
  var bytes = 0, out = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i), n, step = 1;
    if (c < 0x80) n = 1; else if (c < 0x800) n = 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) < 0xe000) { n = 4; step = 2; }
    else n = 3;
    if (bytes + n > max) break;
    bytes += n; out = i + step; i += step - 1;
  }
  return s.slice(0, out);
}

function swRemove(spec, t) {
  var ms = ah.re.findAll(spec.src, spec.flags, t), out = '', at = 0;
  for (var i = 0; i < ms.length; i++) { out += t.slice(at, ms[i][0]); at = ms[i][1]; }
  return out + t.slice(at);
}

// The text a statement is looked for in: fenced code and quoted lines gone, emphasis markers gone, cut to text_max_bytes.
function swPrepare(t) {
  var cut = swCutBytes(t, swNum('sibling_sweep.text_max_bytes'));
  var s = swRemove(swSpec('sibling_sweep.quote_line_re', 'm'), swRemove(swSpec('sibling_sweep.fence_re', ''), cut));
  // every strip character removed (native split/join: a character loop in the interpreter costs about 0.3 us per character)
  swChars(swCfg('sibling_sweep.strip_chars')).forEach(function (c) { s = s.split(c).join(''); });
  return s;
}

// [sentence, terminator|null]: a hard break always ends one, a terminator ends one when white space or the end follows.
// (The scan is one native regular expression built from the settings, so its cost does not grow with an interpreter loop.)
var SW_SPACE_CLASS = '\\t-\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'; // swIsSpace's set
function swClass(chars) { return chars.map(function (c) { return /[\\\]\[^-]/.test(c) ? '\\' + c : c; }).join(''); }
// [start, end, terminator|null] of each sentence of `t` (UTF-16 offsets).
function swSentences(t) {
  var id = 'sentence-re';
  if (!Object.prototype.hasOwnProperty.call(sws.memo, id)) {
    var terms = swChars(swCfg('sibling_sweep.terminators')), hard = swChars(swCfg('sibling_sweep.hard_breaks'));
    sws.memo[id] = new RegExp('[' + swClass(hard) + ']|[' + swClass(terms) + '](?=[' + SW_SPACE_CLASS + ']|$)', 'gu');
  }
  var re = sws.memo[id], out = [], start = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(t)) !== null) { out.push([start, m.index, m[0]]); start = m.index + m[0].length; }
  if (start < t.length) out.push([start, t.length, null]);
  return out;
}

// `t` with the [start, end) ranges blanked to spaces (one per UTF-16 unit, so offsets into the result index `t` too); ranges
// may overlap or nest. Built in one pass (pieces joined once), so the cost is linear in the text however many ranges it holds.
function swBlankRanges(t, rs) {
  if (rs.length === 0) return t;
  rs.sort(function (x, y) { return x[0] - y[0]; });
  var parts = [], at = 0;
  for (var i = 0; i < rs.length; i++) {
    var a = Math.max(rs[i][0], at), b = rs[i][1];
    if (b <= a) continue;
    parts.push(t.slice(at, a), ' '.repeat(b - a));
    at = b;
  }
  parts.push(t.slice(at));
  return parts.join('');
}

// ---- the tokenizer: one left-to-right pass that splits the reply into plain text, code spans and quotations ----------
// Code spans first: a run of sibling_sweep.code_span characters is closed by the next run of the same length on the same line
// (an unclosed run is plain text). The code spans are blanked, so a quote character inside one is inert, and then each quote
// character (sibling_sweep.quote_chars_re) is classified by its neighbours:
//  - one of sibling_sweep.apostrophes between two word characters is part of the word (don't, I've, Alice's), never a delimiter;
//  - an apostrophe character opens a quotation only after the start, white space or one of sibling_sweep.quote_open_after, and
//    closes one only before the end, white space or one of sibling_sweep.quote_close_before (so users' or files' can close a
//    quotation that is open, but never open one);
//  - any other quote character opens when no word character precedes it and closes when no word character follows it.
// An opener pairs with the NEAREST closer of its pair (sibling_sweep.quote_pairs) on its line; quote characters of other pairs
// inside it are part of it. A second opener of the same pair first, or the end of the line, leaves the opener unbalanced:
// plain text, nothing masked (fail open). Every helper reads white space by character code (swSpaceAt).
function swTok() {
  var id = 'quote-tok';
  if (Object.prototype.hasOwnProperty.call(sws.memo, id)) return sws.memo[id];
  var open = {}, close = {}, apos = {}, openAfter = {}, closeBefore = {}, word;
  swCfg('sibling_sweep.quote_pairs').forEach(function (p, k) {
    var cs = swChars(p);
    if (cs.length !== 2) return;
    (open[cs[0]] = open[cs[0]] || []).push(k);
    (close[cs[1]] = close[cs[1]] || []).push(k);
  });
  swCfg('sibling_sweep.apostrophes').forEach(function (c) { apos[c] = true; });
  swChars(swCfg('sibling_sweep.quote_open_after')).forEach(function (c) { openAfter[c] = true; });
  swChars(swCfg('sibling_sweep.quote_close_before')).forEach(function (c) { closeBefore[c] = true; });
  try { word = new RegExp('^' + swCfg('sibling_sweep.word_char_class') + '$', 'u'); } catch (e) {
    swBad('sibling_sweep.word_char_class');
    word = new RegExp('^' + ah.cfg('sibling_sweep.word_char_class') + '$', 'u');
  }
  var tick = swCfg('sibling_sweep.code_span').replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
  var tok = { open: open, close: close, apos: apos, openAfter: openAfter, closeBefore: closeBefore, word: word,
    ticks: new RegExp('\\n|(?:' + tick + ')+', 'g'), chars: swSpec('sibling_sweep.quote_chars_re', '') };
  sws.memo[id] = tok;
  return tok;
}
function swIsWord(tok, c) { return c !== '' && tok.word.test(c); }
// White space at UTF-16 offset i of `t` (false outside it): the one bridge from text to swIsSpace's character codes.
function swSpaceAt(t, i) { return i >= 0 && i < t.length && swIsSpace(t.charCodeAt(i)); }
// The character before / after UTF-16 offset i (a whole code point), or '' at the text's edge.
function swCharBefore(t, i) {
  if (i <= 0) return '';
  var lo = t.charCodeAt(i - 1);
  return lo >= 0xdc00 && lo <= 0xdfff && i >= 2 ? t.slice(i - 2, i) : t.charAt(i - 1);
}
function swCharAfter(t, i) { return i >= t.length ? '' : String.fromCodePoint(t.codePointAt(i)); }
// An apostrophe inside a word: one of sibling_sweep.apostrophes between two word characters.
function swInWord(tok, t, i) { return tok.apos[t.charAt(i)] === true && swIsWord(tok, swCharBefore(t, i)) && swIsWord(tok, swCharAfter(t, i + 1)); }

// [start, end) of each inline code span of `t`. One native scan finds the runs and the line breaks; the pairing walks the
// runs once from the right (the next run of each length on the line) and once from the left.
function swCodeSpans(tok, t) {
  var re = tok.ticks, runs = [], line = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(t)) !== null) { if (m[0] === '\n') line++; else runs.push([m.index, m.index + m[0].length, line]); }
  var next = [], seen = {}, cur = -1;
  for (var k = runs.length - 1; k >= 0; k--) {
    if (runs[k][2] !== cur) { seen = {}; cur = runs[k][2]; }
    var n = runs[k][1] - runs[k][0];
    next[k] = seen[n] === undefined ? -1 : seen[n];
    seen[n] = k;
  }
  var out = [];
  for (var j = 0; j < runs.length; j++) if (next[j] >= 0) { out.push([runs[j][0], runs[next[j]][1]]); j = next[j]; }
  return out;
}

// [start, end) of the inside and the closer of each inline quotation of the code-blanked `t` (the opener is kept, so a speech
// verb right before a quotation still reads as one: "Bob wrote 'x'"). One forward pass over the quote characters.
function swQuoteSpans(tok, t) {
  var ms = ah.re.findAll(tok.chars.src, tok.chars.flags, t), out = [], cur = null, lineEnd = -1;
  for (var j = 0; j < ms.length; j++) {
    var i = ms[j][0], e = ms[j][1], c = t.slice(i, e);
    if (cur !== null && i > cur.lineEnd) cur = null;
    var prev = swCharBefore(t, i), next = swCharAfter(t, e), wl = swIsWord(tok, prev), wr = swIsWord(tok, next), canOpen, canClose;
    if (tok.apos[c] === true) {
      if (wl && wr) continue;
      canOpen = (prev === '' || swSpaceAt(t, i - 1) || tok.openAfter[prev] === true) && next !== '' && !swSpaceAt(t, e);
      canClose = prev !== '' && !swSpaceAt(t, i - 1) && (next === '' || swSpaceAt(t, e) || tok.closeBefore[next] === true);
    } else {
      canOpen = !wl && next !== '' && !swSpaceAt(t, e);
      canClose = !wr && prev !== '' && !swSpaceAt(t, i - 1);
    }
    canOpen = canOpen && tok.open[c] !== undefined;
    if (cur !== null) {
      if (canClose && tok.close[c] !== undefined && tok.close[c].indexOf(cur.kind) >= 0) { out.push([cur.inner, e]); cur = null; continue; }
      if (!canOpen || tok.open[c][0] !== cur.kind) continue;
      cur = null; // a second opener of the same pair before any closer: the first is unbalanced
    }
    if (canOpen) {
      if (i > lineEnd) { lineEnd = t.indexOf('\n', i); if (lineEnd < 0) lineEnd = t.length; }
      cur = { inner: e, kind: tok.open[c][0], lineEnd: lineEnd };
    }
  }
  return out;
}

// The whole word token that holds UTF-16 offset i (word characters joined by in-word apostrophes): [start, end).
function swTokenAt(tok, t, i) {
  var a = i, b = i;
  while (a > 0 && (swIsWord(tok, t.charAt(a - 1)) || swInWord(tok, t, a - 1))) a--;
  while (b < t.length && (swIsWord(tok, t.charAt(b)) || swInWord(tok, t, b))) b++;
  return [a, b];
}
// The base of a token: the part before its first apostrophe, lower-cased (I've -> i).
function swBase(tok, w) {
  for (var i = 0; i < w.length; i++) if (tok.apos[w.charAt(i)] === true) return w.slice(0, i).toLowerCase();
  return w.toLowerCase();
}

// Reported speech in `s` (the unquoted text of a sentence before its claim): a match of sibling_sweep.reported_speech_re whose
// speaker (the whole token before the speech verb, a contraction being one token, sibling_sweep.speech_aux_words skipped
// leftwards) is not one of sibling_sweep.self_speakers. "Alice said: ..." is reported; "I said, ...", "As I've said, ..." and
// "I have said, ..." are not.
function swReported(spec, s) {
  var tok = swTok(), aux = swCfg('sibling_sweep.speech_aux_words'), self = swCfg('sibling_sweep.self_speakers');
  var ms = ah.re.findAll(spec.src, spec.flags, s);
  for (var j = 0; j < ms.length; j++) {
    var r = swTokenAt(tok, s, ms[j][0]), base = swBase(tok, s.slice(r[0], r[1]));
    while (aux.indexOf(base) >= 0) {
      var e = r[0];
      while (swSpaceAt(s, e - 1)) e--;
      if (e === r[0] || !swIsWord(tok, swCharBefore(s, e))) { base = ''; break; }
      r = swTokenAt(tok, s, e - 1);
      base = swBase(tok, s.slice(r[0], r[1]));
    }
    if (base !== '' && self.indexOf(base) < 0) return true;
  }
  return false;
}

// The views of the whole prepared reply, made BEFORE it is split into sentences, so a span or a quotation that holds a
// terminator is masked as one piece: `code` has the code spans blanked, `quote` is `code` with the quotations blanked too.
function swMasks(prepared) {
  var tok = swTok(), code = swBlankRanges(prepared, swCodeSpans(tok, prepared));
  return { code: code, quote: swBlankRanges(code, swQuoteSpans(tok, code)) };
}

function swNamePattern(sentence, cueStart) {
  var tick = swCfg('sibling_sweep.code_span'), max = swNum('sibling_sweep.snippet_chars'), minSpan = swNum('sibling_sweep.min_span_chars');
  var after = sentence.slice(cueStart), a = after.indexOf(tick);
  if (a >= 0) {
    var rest = after.slice(a + tick.length), len = rest.indexOf(tick);
    if (len >= 0) {
      var span = rest.slice(0, len).trim();
      if (swChars(span).length >= minSpan) return swHead(swCollapse(span), max);
    }
  }
  return swHead(swCollapse(after.trim()), max);
}

// The first assertive cause statement in `text`: {hash, pattern}, or null.
function swFindCause(t) { return swFindCauseIn(swPrepare(t)); }
// The first sentence of `view` (split where `view` has a terminator) that holds one of `list`: the guards and the cues read
// `view`'s text of the sentence, the hash and the named pattern the prepared text. Sentences
// that start at or after `limit` are not looked at. {at, hash, pattern, family} or null.
function swFirst(prepared, view, list, family, limit, pre, reported) {
  var windowChars = swNum('sibling_sweep.window_chars'), question = swCfg('sibling_sweep.question_terminator');
  var meta = swSpec('sibling_sweep.meta_re', 'i'), hedgeAny = swSpec('sibling_sweep.hedge_any_re', 'i');
  var hedgeBefore = swSpec('sibling_sweep.hedge_before_re', 'i');
  var operational = swSpec('sibling_sweep.operational_re', 'i'), attributed = swSpec('sibling_sweep.attributed_re', 'i');
  var ss = swSentences(view);
  for (var i = 0; i < ss.length && ss[i][0] < limit; i++) {
    var a = ss[i][0], b = ss[i][1], term = ss[i][2], subject = view.slice(a, b);
    // a sentence with none of the prefilter words holds no cue: one regex call instead of the guards and every cue
    if (pre !== null && !swTest(pre, subject)) continue;
    var masked = view.slice(a, b);
    if ((term !== null && question.indexOf(term) >= 0) || swTest(meta, masked) || swTest(hedgeAny, masked)) continue;
    // an environment fact (lock file, load, disk) or a cause quoted from an agent's report is not the assistant's own code-bug finding
    if (swTest(operational, masked) || swTest(attributed, masked)) continue;
    for (var k = 0; k < list.length; k++) {
      var m = ah.re.find(list[k].src, list[k].flags, subject);
      if (m === null || m === undefined) continue;
      if (swTest(hedgeBefore, swTail(subject.slice(0, m[0]), windowChars))) continue;
      // a correction another party reports ("Alice said: I fixed a typo") is theirs: a speaker and a speech verb in the
      // unquoted text of the sentence before the claim (never inside a quotation) skip the sentence
      if (reported !== null && swReported(reported, subject.slice(0, m[0]))) break;
      var sentence = prepared.slice(a, b), norm = swCollapse(sentence.trim()).toLowerCase();
      return { at: a, hash: ah.sha1(swHead(norm, swNum('sibling_sweep.hash_chars'))), pattern: swNamePattern(sentence, m[0]), family: family };
    }
  }
  return null;
}

function swFindCauseIn(prepared) {
  // one regex pass: text with none of the words every cue needs holds no statement
  var pre = swPre();
  if (pre !== null && !swTest(pre, prepared)) return null;
  // mask the whole reply first (code spans, then quotations), then split: a span or quotation never straddles a sentence
  var mk = swMasks(prepared);
  // the cause cues read the code-masked text (a quoted cause is still the reply's statement); the self-correction cues (the
  // agent reports fixing its own typo or mistake) read only the unquoted text (someone else's words are not the agent's), for
  // the cues, the guards and the reported-speech prefix alike: same guards, same hash. The earlier sentence wins, the cause
  // family on a tie.
  var cause = swFirst(prepared, mk.code, swSpecs('sibling_sweep.cause_cues'), '', prepared.length + 1, pre, null);
  var self = swFirst(prepared, mk.quote, swSpecs('sibling_sweep.self_correction_cues'), swCfg('sibling_sweep.self_correction_family'),
    cause === null ? prepared.length + 1 : cause.at, pre, swSpec('sibling_sweep.reported_speech_re', 'i'));
  return self !== null ? self : cause;
}
function swHasFix(t) { return swHasFixIn(swPrepare(t)); }
function swHasFixIn(p) { return swTest(swSpec('sibling_sweep.fix_context_re', 'i'), p); }
function swStatesSweep(t) { return swStatesSweepIn(swPrepare(t)); }
function swStatesSweepIn(p) { return swSpecs('sibling_sweep.sweep_statement_re').some(function (s) { return swTest(s, p); }); }
function swShort(h) { return swHead(h, swNum('sibling_sweep.hash_short')); }

// ---- the turn of a transcript ----

function swToolKind(block) {
  var name = typeof block[swCfg('sibling_sweep.f_tool_name')] === 'string' ? block[swCfg('sibling_sweep.f_tool_name')] : '';
  var input = block[swCfg('sibling_sweep.f_tool_input')];
  var field = function (k) { return input !== null && typeof input === 'object' && typeof input[k] === 'string' ? input[k] : ''; };
  if (swCfg('sibling_sweep.search_tools').indexOf(name) >= 0 || swTest(swSpec('sibling_sweep.search_tool_re', ''), name)) return 'search';
  if (swCfg('sibling_sweep.edit_tools').indexOf(name) >= 0) return 'edit';
  if (name === swCfg('sibling_sweep.bash_tool') && swTest(swSpec('sibling_sweep.bash_search_re', ''), field(swCfg('sibling_sweep.f_command')))) return 'search';
  if (swCfg('sibling_sweep.agent_tools').indexOf(name) >= 0 && swCfg('sibling_sweep.search_agent_types').indexOf(field(swCfg('sibling_sweep.f_subagent_type'))) >= 0) return 'search';
  return 'other';
}

function swIsObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function swIsPrompt(entry) {
  if (entry.isMeta === true) return false;
  var content = swIsObj(entry.message) ? entry.message.content : undefined;
  var injected = swSpec('sibling_sweep.injected_re', 'i');
  var human = function (x) { return !swBlank(x) && !swTest(injected, x); };
  if (typeof content === 'string') return human(content);
  if (Array.isArray(content)) {
    return content.some(function (b) { return swIsObj(b) && b.type === swCfg('sibling_sweep.b_text') && typeof b.text === 'string' && human(b.text); });
  }
  return false;
}

// The parts of a transcript line the turn reader looks at: the engine parses each line of the window and hands over only
// these (a tool result or a tool's file content never reaches the script).
function swKeep() {
  var c = ['message', 'content'], b = c.concat(['*']), input = b.concat([swCfg('sibling_sweep.f_tool_input')]);
  return [['type'], ['isMeta'], c, b.concat(['type']), b.concat(['text']), b.concat([swCfg('sibling_sweep.f_tool_name')]),
    input.concat([swCfg('sibling_sweep.f_command')]), input.concat([swCfg('sibling_sweep.f_subagent_type')])];
}

// {events, id, lastText, skipped}: events since the last human prompt, oldest first (the newest max_events kept). The turn is
// read from the end: the walk stops at the last human prompt, and only the newest max_events events are analysed, so the work
// is bounded by the turn, max_lines, max_events and max_turn_text_chars, not by the length of the transcript or of the window.
function swReadTurn(path) {
  var r = ah.transcript.tailEntries(path, swNum('sibling_sweep.window_bytes'), swNum('sibling_sweep.line_max_bytes'), swKeep(),
    swNum('sibling_sweep.max_lines'));
  if (r === null) return null;
  var tUser = swCfg('sibling_sweep.t_user'), tAsst = swCfg('sibling_sweep.t_assistant'), bText = swCfg('sibling_sweep.b_text'), bTool = swCfg('sibling_sweep.b_tool_use');
  var entries = [], skipped = r.droppedUnread, id = '0', start = 0;
  r.lines.forEach(function (ln) {
    var at = ln[0], e = ln[1];
    if (e === null) { skipped++; return; }
    // a line the engine's parser refused comes back as its text: JavaScript reads it as it always did
    if (typeof e === 'string') { try { e = JSON.parse(e); } catch (x) { skipped++; return; } }
    if (!swIsObj(e)) return;
    entries.push({ at: at, e: e });
  });
  for (var p = entries.length - 1; p >= 0; p--) {
    if (entries[p].e.type === tUser && swIsPrompt(entries[p].e)) { id = String(entries[p].at); start = p + 1; break; }
  }
  var rev = [], lastText = null, maxEvents = swNum('sibling_sweep.max_events'), textMax = swNum('sibling_sweep.text_max_bytes');
  var textBudget = swNum('sibling_sweep.max_turn_text_chars'), textChars = 0;
  var full = function () { return rev.length >= maxEvents || textChars >= textBudget; };
  for (var i = entries.length - 1; i >= start && (!full() || lastText === null); i--) {
    var e = entries[i].e;
    if (e.type !== tAsst) continue;
    var blocks = swIsObj(e.message) && Array.isArray(e.message.content) ? e.message.content : [];
    for (var j = blocks.length - 1; j >= 0; j--) {
      var b = blocks[j], bt = swIsObj(b) && typeof b.type === 'string' ? b.type : '';
      if (bt === bText) {
        if (typeof b.text !== 'string' || swBlank(b.text)) continue;
        if (lastText === null) lastText = swCutBytes(b.text, textMax);
        if (full()) break;
        textChars += b.text.length;
        var prepared = swPrepare(b.text), c = swFindCauseIn(prepared);
        rev.push({ k: 'text', cause: c === null ? null : c.hash, sweep: swStatesSweepIn(prepared), fix: swHasFixIn(prepared) });
      } else if (bt === bTool && !full()) {
        rev.push({ k: 'tool', kind: swToolKind(b) });
      }
    }
  }
  return { events: rev.reverse(), id: id, lastText: lastText, skipped: skipped };
}

// ---- state, telemetry, the reminder ----

function swSafe(s, max) {
  var out = '';
  for (var i = 0; i < s.length && i < max; i++) out += /[A-Za-z0-9._-]/.test(s.charAt(i)) ? s.charAt(i) : '_';
  return out;
}

function swStateRel(session, agent) {
  var max = swNum('sibling_sweep.state_session_max');
  var name = swCfg('sibling_sweep.state_prefix') + '-' + swSafe(session, max);
  if (agent !== '') name += '-' + swSafe(agent, max);
  return ah.cfg('replykit.state_dir') + '/' + name + ah.cfg('replykit.json_ext');
}

function swLoad(home, rel) {
  var st = { fired: 0, turn: '', causes: [], pending: null };
  var raw = ah.fs.readText(ah.path.join(home, rel));
  if (raw === null) return st;
  var v;
  try { v = JSON.parse(raw); } catch (e) { return st; }
  if (!swIsObj(v)) return st;
  if (typeof v.fired === 'number' && v.fired >= 0 && Math.floor(v.fired) === v.fired) st.fired = v.fired;
  if (typeof v.turn === 'string') st.turn = v.turn;
  if (Array.isArray(v.causes)) st.causes = v.causes.filter(function (x) { return typeof x === 'string'; });
  if (swIsObj(v.pending) && typeof v.pending.cause === 'string' && typeof v.pending.turn === 'string') st.pending = { cause: v.pending.cause, turn: v.pending.turn, family: typeof v.pending.family === 'string' ? v.pending.family : '' };
  return st;
}

// Keys in alphabetical order, as the engine's JSON writer has always ordered them.
function swSave(rel, st) {
  // the family is written only for a non-default one, so a state of the cause family keeps the bytes it always had
  var pending = st.pending === null ? null : { cause: st.pending.cause, turn: st.pending.turn };
  if (pending !== null && st.pending.family) pending = { cause: pending.cause, family: st.pending.family, turn: pending.turn };
  return ah.state.writeAtomic(rel, JSON.stringify({ causes: st.causes, fired: st.fired, pending: pending, turn: st.turn }));
}

function swLog(row) {
  var rel = ah.cfg('paths.base_dir') + '/' + swCfg('sibling_sweep.log'), size = ah.fs.size(ah.path.join(swHome, rel));
  if (size !== null && size > swNum('sibling_sweep.log_max_bytes')) ah.state.writeAtomic(rel, '');
  if (!ah.state.appendFile(rel, JSON.stringify(row) + '\n')) swWarn(swCfg('sibling_sweep.what_log'));
}
var swHome = '';
function swWarn(what) {
  ah.log('sibling-sweep', text.render(swCfg('sibling_sweep.msg_log_failed'), { what: what, error: 'write failed' }));
}

// Self-correction counters (registered metrics; a lost count never changes a decision).
function swCount(name, labels) { try { ah.metric(name, labels); } catch (e) { /* counting never fails a hook */ } }
function swSelf(cause) { return cause.family !== undefined && cause.family !== ''; }

function swResolve(turn, pending) {
  if (turn.id !== pending.turn) return ['unknown', 0];
  var at = -1;
  for (var i = turn.events.length - 1; i >= 0; i--) if (turn.events[i].k === 'text' && turn.events[i].cause === pending.cause) { at = i; break; }
  if (at < 0) return ['unknown', 0];
  var calls = turn.events.slice(at + 1).filter(function (e) { return e.k === 'tool'; }).slice(0, swNum('sibling_sweep.follow_window')).map(function (e) { return e.kind; });
  return [calls.indexOf('search') >= 0 ? 'followed' : 'ignored', calls.length];
}

function swReminder(pattern) {
  var named = pattern === '' ? '' : text.render(swCfg('sibling_sweep.msg_pattern'), { pattern: pattern });
  var reason = text.message('tip', swCfg('sibling_sweep.guard_name'), {
    what: text.render(swCfg('sibling_sweep.msg_what'), { pattern: named }), why: swCfg('sibling_sweep.msg_why'),
    instead: swCfg('sibling_sweep.msg_instead'), allowed: swCfg('sibling_sweep.msg_allowed'), override: swCfg('sibling_sweep.msg_override'),
  });
  return JSON.stringify({ decision: 'block', reason: reason });
}

function swStr(p, key) { var v = p[swCfg(key)]; return typeof v === 'string' ? v : ''; }

function decide(p) {
  var home = ah.env.get(ah.cfg('env.home'));
  if (home === null) home = ah.env.get(ah.cfg('env.home_alt'));
  if (!home) return 'allow';
  swHome = home;
  sws = { memo: {} };
  if (!swIsObj(p)) return 'allow';
  var event = swStr(p, 'sibling_sweep.f_event');
  if (swCfg('sibling_sweep.events').indexOf(event) < 0 || !ah.settings.bool('sibling_sweep.setting') ||
      ah.settings.skipped(swCfg('sibling_sweep.guard_name')) ||
      ah.env.get(swCfg('sibling_sweep.child_env')) === swCfg('sibling_sweep.child_value')) return 'allow';
  var session = swStr(p, 'sibling_sweep.f_session'), agent = swStr(p, 'sibling_sweep.f_agent');
  var tcands = [swStr(p, 'sibling_sweep.f_agent_transcript'), swStr(p, 'sibling_sweep.f_transcript')];
  var transcript = null;
  for (var i = 0; i < tcands.length; i++) if (tcands[i].charAt(0) === '/') { transcript = tcands[i]; break; }
  if (session === '') return 'allow';
  var rel = swStateRel(session, agent), state = swLoad(home, rel);
  var scope = event === swCfg('sibling_sweep.subagent_event') ? 'subagent' : 'session';
  var replyRaw = p[swCfg('sibling_sweep.f_reply')];
  var reply = typeof replyRaw === 'string' && !swBlankJs(replyRaw) ? replyRaw : null;
  var replyCause = reply === null ? null : swFindCause(reply);
  // a reply with no cause statement and no open follow-through needs nothing from the transcript
  if (reply !== null && replyCause === null && state.pending === null) return 'allow';
  if (transcript === null) return 'allow';
  var turn = swReadTurn(transcript);
  if (turn === null) { swWarn(swCfg('sibling_sweep.what_transcript')); return 'allow'; }
  var dirty = false;
  if (state.pending !== null) {
    var res = swResolve(turn, state.pending);
    swLog({ cause: swShort(state.pending.cause), event: 'followthrough', outcome: res[0], scope: scope, tool_calls: res[1], ts: Date.now() });
    if (state.pending.family && res[0] === 'followed') swCount('sibling_sweep_self_correction_followed_through', []);
    state.pending = null;
    dirty = true;
  }
  var finish = function (v) { if (dirty && !swSave(rel, state)) swWarn(swCfg('sibling_sweep.what_state')); return v; };
  var latest = reply !== null ? reply : turn.lastText;
  var cause = replyCause !== null ? replyCause : (reply !== null ? null : (latest !== null ? swFindCause(latest) : null));
  if (latest === null || cause === null) return finish('allow');
  var row = function (result) {
    // the self-correction family is counted by outcome: fired when it reminds, suppressed (by reason) when it stays quiet
    if (swSelf(cause)) swCount(result === 'reminded' ? 'sibling_sweep_self_correction_fired' : 'sibling_sweep_self_correction_suppressed', result === 'reminded' ? [] : ['reason', result]);
    return { cause: swShort(cause.hash), event: 'cause', result: result, scope: scope, skipped_lines: turn.skipped, ts: Date.now() };
  };
  var fix = swHasFix(latest) || turn.events.some(function (e) { return (e.k === 'text' && e.fix) || (e.k === 'tool' && e.kind === 'edit'); });
  if (!fix) { swLog(row('no_fix_context')); return finish('allow'); }
  // evidence: a search call, or an explicit statement, after the first cause statement of the turn
  var first = turn.events.length;
  for (var j = 0; j < turn.events.length; j++) if (turn.events[j].k === 'text' && turn.events[j].cause !== null) { first = j; break; }
  var swept = swStatesSweep(latest) || turn.events.slice(first).some(function (e) { return (e.k === 'tool' && e.kind === 'search') || (e.k === 'text' && e.sweep); });
  if (swept) { swLog(row('swept')); return finish('allow'); }
  if (p[swCfg('sibling_sweep.f_active')] === true) { swLog(row('continuation')); return finish('allow'); }
  if (state.turn !== turn.id) { state.turn = turn.id; state.causes = []; dirty = true; }
  if (state.causes.indexOf(cause.hash) >= 0) { swLog(row('duplicate')); return finish('allow'); }
  if (state.fired >= swNum('sibling_sweep.max_per_scope')) { swLog(row('capped')); return finish('allow'); }
  state.fired += 1;
  state.causes.push(cause.hash);
  if (state.causes.length > swNum('sibling_sweep.max_causes')) state.causes.shift();
  state.pending = { cause: cause.hash, turn: turn.id, family: swSelf(cause) ? cause.family : '' };
  // an unrecorded reminder would repeat on every Stop
  if (!swSave(rel, state)) { swWarn(swCfg('sibling_sweep.what_state')); return 'allow'; }
  ah.state.prune(swCfg('sibling_sweep.state_prefix'), rel.slice(rel.lastIndexOf('/') + 1));
  swLog(row('reminded'));
  return { advisory: swReminder(cause.pattern) };
}

// `!s.trim().is_empty()` in the engine's sense of white space.
function swBlankJs(s) { return swBlank(s); }
