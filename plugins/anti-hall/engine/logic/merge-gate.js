// check = "merge-gate" (PreToolUse on Bash; opt-in). Blocks an auto-merge when the recent assistant output holds a self-hedge
// ("pending review", "do not merge", ...) that no real user prompt has resolved since, and asks Jev (detached) about every
// hedge it finds. Mirrors hooks/merge-gate.js. Every phrase, pattern, text and limit is in engine/defaults/small_guards.toml
// (merge_gate.*).
'use strict';

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function truthy(v) { return !(v === undefined || v === null || v === false || v === 0 || v === '' || (typeof v === 'number' && v !== v)); }

// The text between the matches of a regex (a split).
function splitOn(src, flags, s) {
  var out = [], at = 0;
  ah.re.findAll(src, flags, s).forEach(function (h) { out.push(s.slice(at, h[0])); at = h[1]; });
  out.push(s.slice(at));
  return out;
}

function ruleMatches(rule, rest) {
  var prefix = rule.prefix || [];
  if (rest.length < prefix.length) return false;
  for (var i = 0; i < prefix.length; i++) if (rest[i] !== prefix[i]) return false;
  var tail = rest.slice(prefix.length);
  if (rule.includes_any && !tail.some(function (w) { return rule.includes_any.indexOf(w) >= 0; })) return false;
  if (rule.needs_target === true && !tail.some(function (w) { return ah.re.test(ah.cfg('merge_gate.protected_target'), 'i', w); })) return false;
  return true;
}

function isAutoMerge(cmd) {
  var rules = ah.cfg('merge_gate.merge_rules'), segs = splitOn(ah.cfg('merge_gate.segment_split'), '', cmd);
  for (var s = 0; s < segs.length; s++) {
    var words = segs[s].trim().split(/\s+/).filter(function (w) { return w !== ''; });
    if (words.length < 2) continue;
    var i = 0;
    while (i < words.length && ah.re.test(ah.cfg('merge_gate.env_assign'), '', words[i])) i++;
    if (i >= words.length) continue;
    var verb = words[i], rest = words.slice(i + 1);
    if (rules.some(function (r) { return r.verb === verb && ruleMatches(r, rest); })) return true;
  }
  return false;
}

function hasHedge(t) {
  var lower = t.toLowerCase();
  return ah.cfg('merge_gate.hedge_phrases').some(function (h) { return lower.indexOf(h) >= 0; }) ||
    ah.cfg('merge_gate.hedge_patterns').some(function (src) { return ah.re.test(src, 'i', t); });
}

function hasResolution(t) {
  var lower = t.toLowerCase();
  return ah.cfg('merge_gate.resolutions').some(function (p) { return lower.indexOf(p) >= 0; });
}

// The text blocks of an entry (a lone surrogate, which the host's masking cannot take, read as U+FFFD: no hedge or quote rule
// matches either).
function textOf(entry) {
  var m = entry.message, content = isObj(m) ? m.content : undefined;
  if (Array.isArray(content)) {
    var parts = [], result = false;
    content.forEach(function (b) {
      if (!isObj(b)) return;
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      if (b.type === 'tool_result') result = true;
    });
    return { text: hookProc.usv(parts.join('\n')), result: result };
  }
  return { text: typeof content === 'string' ? hookProc.usv(content) : '', result: false };
}

function maskedMaybe(t) {
  var m = ah.text.maskQuoted(t);
  return m.trim() === '' && t.trim() !== '' ? t : m;
}

function nonHuman(entry) {
  var origin = entry.origin;
  if (!truthy(origin)) return false;
  var kind = isObj(origin) ? origin.kind : undefined;
  return !(typeof kind === 'string' && ah.cfg('merge_gate.non_human_origins').indexOf(kind) >= 0);
}

// The records of the tail; a line that is not JSON is skipped, as Node skips it.
function readRecords(tail) {
  var out = [], lines = tail.split('\n');
  for (var n = 0; n < lines.length; n++) {
    var line = lines[n].trim();
    if (line === '') continue;
    var entry;
    try { entry = JSON.parse(line); } catch (e) { if (e instanceof SyntaxError) continue; throw e; }
    var type = isObj(entry) ? entry.type : undefined;
    if (type === 'assistant') out.push({ k: 'a', t: maskedMaybe(textOf(entry).text) });
    else if (type === 'user') {
      if (truthy(entry.isMeta) || truthy(entry.isSidechain) || truthy(entry.isCompactSummary) || nonHuman(entry)) { out.push({ k: 'o' }); continue; }
      var tx = textOf(entry);
      if (Object.prototype.hasOwnProperty.call(entry, 'toolUseResult') || tx.result) { out.push({ k: 'o' }); continue; }
      var raw = '', at = 0;
      ah.re.findAll(ah.cfg('merge_gate.system_reminder'), 'i', tx.text).forEach(function (h) { raw += tx.text.slice(at, h[0]); at = h[1]; });
      raw += tx.text.slice(at);
      if (raw.trim() === '' || ah.re.test(ah.cfg('merge_gate.injected_user'), 'i', raw)) { out.push({ k: 'o' }); continue; }
      out.push({ k: 'u', t: maskedMaybe(raw) });
    }
  }
  return out;
}

function hedgeUnresolved(records) {
  var at = -1;
  for (var i = records.length - 1; i >= 0; i--) if (records[i].k === 'a' && hasHedge(records[i].t)) { at = i; break; }
  if (at < 0) return false;
  for (var j = at + 1; j < records.length; j++) if (records[j].k === 'u' && hasResolution(records[j].t)) return false;
  return true;
}

// The hedge that occurs last in the text (a phrase found earlier wins a tie).
function lastHedgePhrase(t) {
  var lower = t.toLowerCase(), best = null;
  var consider = function (idx, phrase) { if (best === null || idx > best.idx) best = { idx: idx, phrase: phrase }; };
  ah.cfg('merge_gate.hedge_phrases').forEach(function (h) { var at = lower.lastIndexOf(h); if (at >= 0) consider(at, h); });
  ah.cfg('merge_gate.hedge_patterns').forEach(function (src) {
    var hits = ah.re.findAll(src, 'i', t);
    if (hits.length) { var h = hits[hits.length - 1]; consider(h[0], t.slice(h[0], h[1])); }
  });
  return best === null ? '' : best.phrase;
}

function decide(p) {
  if (ah.settings.skipped(ah.cfg('merge_gate.guard_name')) || !ah.settings.bool('merge_gate.setting')) return 'allow';
  var ti = isObj(p) ? p.tool_input : undefined;
  var cmd = isObj(ti) && typeof ti.command === 'string' ? ti.command : '';
  if (cmd === '' || !isAutoMerge(cmd)) return 'allow';
  var tp = p.transcript_path;
  if (typeof tp !== 'string' || tp === '') return 'allow';
  tp = hookProc.open(p, tp); // a relative path is read from the hook process's directory, as Node reads it
  var tail = ah.fs.readTail(tp, ah.cfgNum('merge_gate.window_bytes'));
  if (tail === null) return 'allow';
  var records = readRecords(tail);
  var said = records.filter(function (r) { return r.k === 'a'; }).map(function (r) { return r.t; }).join('\n');
  if (said === '' || !hasHedge(said)) return 'allow';
  var unresolved = hedgeUnresolved(records);
  var n = ah.cfgNum('merge_gate.jev_state_chars'), window = said;
  if (n < said.length) {
    var hi = said.charCodeAt(said.length - n - 1), lo = said.charCodeAt(said.length - n);
    // Node's window would start with a lone low surrogate; the Jev shadow question (never the decision) starts one unit later
    window = said.slice(said.length - n + (hi >= 0xD800 && hi <= 0xDBFF && lo >= 0xDC00 && lo <= 0xDFFF ? 1 : 0));
  }
  var sid = null;
  if (truthy(p.session_id)) sid = String(p.session_id);
  ah.jev.ask({
    id: ah.cfg('merge_gate.jev_id'),
    question: { type: 'noul', instructions: ah.cfg('merge_gate.jev_instructions'), criteria: [['true', ah.cfg('merge_gate.jev_true')], ['false', ah.cfg('merge_gate.jev_false')]] },
    state: window, trust: 'relax_block', baseline: unresolved, sessionId: sid, turnRefFrom: tp,
    projectFrom: typeof p.cwd === 'string' ? p.cwd : null,
  });
  if (!unresolved) return 'allow';
  var reason = text_message(lastHedgePhrase(said));
  return { exact: { code: 2, out: '', err: reason + '\n' } };
}

function text_message(hedge) {
  return text.message('block', ah.cfg('merge_gate.guard_name'), {
    what: text.render(ah.cfg('merge_gate.msg_what'), { hedge: hedge }), why: ah.cfg('merge_gate.msg_why'),
    instead: ah.cfg('merge_gate.msg_instead'), override: ah.cfg('merge_gate.msg_override'),
  });
}
