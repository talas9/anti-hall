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
function swSentences(t) {
  var id = 'sentence-re';
  if (!Object.prototype.hasOwnProperty.call(sws.memo, id)) {
    var terms = swChars(swCfg('sibling_sweep.terminators')), hard = swChars(swCfg('sibling_sweep.hard_breaks'));
    sws.memo[id] = new RegExp('[' + swClass(hard) + ']|[' + swClass(terms) + '](?=[' + SW_SPACE_CLASS + ']|$)', 'gu');
  }
  var re = sws.memo[id], out = [], start = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(t)) !== null) { out.push([t.slice(start, m.index), m[0]]); start = m.index + m[0].length; }
  if (start < t.length) out.push([t.slice(start), null]);
  return out;
}

// The sentence with every inline code span blanked out to spaces (one per UTF-16 unit, so offsets index the original).
function swMask(sentence) {
  var tick = swChars(swCfg('sibling_sweep.code_span'))[0];
  if (tick === undefined) return sentence;
  // the parts between ticks alternate outside / inside a span; inside parts and the ticks themselves become spaces
  return sentence.split(tick).map(function (part, i) { return i % 2 === 1 ? ' '.repeat(part.length) : part; }).join(' '.repeat(tick.length));
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
function swFindCauseIn(prepared) {
  var windowChars = swNum('sibling_sweep.window_chars'), question = swCfg('sibling_sweep.question_terminator');
  var meta = swSpec('sibling_sweep.meta_re', 'i'), hedgeAny = swSpec('sibling_sweep.hedge_any_re', 'i');
  var hedgeBefore = swSpec('sibling_sweep.hedge_before_re', 'i'), cues = swSpecs('sibling_sweep.cause_cues');
  var operational = swSpec('sibling_sweep.operational_re', 'i'), attributed = swSpec('sibling_sweep.attributed_re', 'i');
  var ss = swSentences(prepared);
  for (var i = 0; i < ss.length; i++) {
    var sentence = ss[i][0], term = ss[i][1], masked = swMask(sentence);
    if ((term !== null && question.indexOf(term) >= 0) || swTest(meta, masked) || swTest(hedgeAny, masked)) continue;
    // an environment fact (lock file, load, disk) or a cause quoted from an agent's report is not the assistant's own code-bug finding
    if (swTest(operational, masked) || swTest(attributed, masked)) continue;
    for (var k = 0; k < cues.length; k++) {
      var m = ah.re.find(cues[k].src, cues[k].flags, masked);
      if (m === null || m === undefined) continue;
      if (swTest(hedgeBefore, swTail(masked.slice(0, m[0]), windowChars))) continue;
      var norm = swCollapse(sentence.trim()).toLowerCase();
      return { hash: ah.sha1(swHead(norm, swNum('sibling_sweep.hash_chars'))), pattern: swNamePattern(sentence, m[0]) };
    }
  }
  return null;
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
  if (swIsObj(v.pending) && typeof v.pending.cause === 'string' && typeof v.pending.turn === 'string') st.pending = { cause: v.pending.cause, turn: v.pending.turn };
  return st;
}

// Keys in alphabetical order, as the engine's JSON writer has always ordered them.
function swSave(rel, st) {
  var pending = st.pending === null ? null : { cause: st.pending.cause, turn: st.pending.turn };
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
    state.pending = null;
    dirty = true;
  }
  var finish = function (v) { if (dirty && !swSave(rel, state)) swWarn(swCfg('sibling_sweep.what_state')); return v; };
  var latest = reply !== null ? reply : turn.lastText;
  var cause = replyCause !== null ? replyCause : (reply !== null ? null : (latest !== null ? swFindCause(latest) : null));
  if (latest === null || cause === null) return finish('allow');
  var row = function (result) {
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
  state.pending = { cause: cause.hash, turn: turn.id };
  // an unrecorded reminder would repeat on every Stop
  if (!swSave(rel, state)) { swWarn(swCfg('sibling_sweep.what_state')); return 'allow'; }
  ah.state.prune(swCfg('sibling_sweep.state_prefix'), rel.slice(rel.lastIndexOf('/') + 1));
  swLog(row('reminded'));
  return { advisory: swReminder(cause.pattern) };
}

// `!s.trim().is_empty()` in the engine's sense of white space.
function swBlankJs(s) { return swBlank(s); }
