// check = "merge-gate" (PreToolUse on Bash). Opt-in false-done backstop (guards.mergeGate, default off): with it on, a Bash command that is
// an auto-merge intent (`gh pr merge`, `gh pr review --approve`, a fast-forward or no-fast-forward `git merge` onto a protected branch,
// `hivecontrol workspace merge-into-source|merge-from-source`) is blocked when the recent assistant transcript tail still carries an
// unresolved self-hedge ("first-pass", "pending review", "do not merge", ...). The hedge is resolved only by a later real typed user prompt
// that holds a resolution phrase. The records of the tail (assistant text and real typed prompts, both quote-masked), the hedge and its
// resolution, the block and the Jev shadow ask that goes with a hedge (asked on the shared Jev lane without waiting, so the gate's answer
// never depends on Jev) are all decided here; only a relative transcript path and a text window that would cut a surrogate pair defer.
// Mirrors hooks/merge-gate.js. Keys, texts and patterns: small_guards.toml (merge_gate.*).
'use strict';

function mgT(k) { return ah.cfg('merge_gate.' + k); }

// True when one rule of `merge_gate.merge_rules` matches the words after the verb.
function mgRule(rule, rest) {
  var prefix = rule.prefix || [];
  if (rest.length < prefix.length) return false;
  for (var i = 0; i < prefix.length; i++) if (rest[i] !== prefix[i]) return false;
  var tail = rest.slice(prefix.length), target = new RegExp(mgT('protected_target'), 'i');
  if (rule.includes_any && !tail.some(function (w) { return rule.includes_any.indexOf(w) >= 0; })) return false;
  if (rule.needs_target && !tail.some(function (w) { return target.test(w); })) return false;
  return true;
}

// True when any segment of `cmd` is an auto-merge intent.
function mgIsAutoMerge(cmd) {
  var segs = cmd.split(new RegExp(mgT('segment_split'))), assign = new RegExp(mgT('env_assign')), rules = mgT('merge_rules');
  for (var s = 0; s < segs.length; s++) {
    var words = segs[s].trim().split(/\s+/).filter(function (w) { return w !== ''; });
    if (words.length < 2) continue;
    var i = 0;
    while (i < words.length && assign.test(words[i])) i++;
    if (i >= words.length) continue;
    var verb = words[i], rest = words.slice(i + 1);
    if (rules.some(function (r) { return r.verb === verb && mgRule(r, rest); })) return true;
  }
  return false;
}

function mgHedges() { return mgT('hedge_patterns').map(function (s) { return new RegExp(s, 'i'); }); }

function mgHasHedge(t) {
  var lower = t.toLowerCase();
  return mgT('hedge_phrases').some(function (h) { return lower.indexOf(h) >= 0; }) || mgHedges().some(function (re) { return re.test(t); });
}

// The last (rightmost) hedge phrase of `text`: plain phrases by their last occurrence in the lower-cased text, patterns by their last match
// in the text itself; the later start wins, and the earlier hedge on a tie.
function mgLastHedge(t) {
  var lower = t.toLowerCase(), best = null, at = -1;
  mgT('hedge_phrases').forEach(function (h) { var i = lower.lastIndexOf(h); if (i > at) { at = i; best = h; } });
  mgT('hedge_patterns').forEach(function (src) {
    var re = new RegExp(src, 'ig'), m, idx = -1, phrase = null;
    while ((m = re.exec(t)) !== null) { idx = m.index; phrase = m[0]; if (m[0] === '') re.lastIndex++; }
    if (idx > at) { at = idx; best = phrase; }
  });
  return best;
}

function mgMaskedMaybe(t) {
  var m = ah.text.maskQuoted(t);
  return m.trim() === '' && t.trim() !== '' ? t : m;
}

// The records of the tail, as Node's `readRecords` builds them: [{kind, text}].
function mgRecords(tail) {
  var out = [], injected = new RegExp(mgT('injected_user'), 'i'), reminder = new RegExp(mgT('system_reminder'), 'gi'), lines = tail.split('\n');
  for (var li = 0; li < lines.length; li++) {
    var t = lines[li].trim();
    if (t === '') continue;
    var e;
    try { e = JSON.parse(t); } catch (x) { continue; }
    if (!e) continue;
    var content = e.message && e.message.content;
    var blocks = Array.isArray(content) ? content : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);
    var textOf = function () { return blocks.filter(function (b) { return b && b.type === 'text' && typeof b.text === 'string'; }).map(function (b) { return b.text; }).join('\n'); };
    if (e.type === 'assistant') {
      out.push({ kind: 'assistant', text: mgMaskedMaybe(textOf()) });
    } else if (e.type === 'user') {
      var nonHuman = e.origin && mgT('non_human_origins').indexOf(String(e.origin.kind)) < 0;
      if (e.isMeta || e.isSidechain || e.isCompactSummary || nonHuman) { out.push({ kind: 'other', text: '' }); continue; }
      if (e.toolUseResult !== undefined || blocks.some(function (b) { return b && b.type === 'tool_result'; })) { out.push({ kind: 'toolresult', text: '' }); continue; }
      var raw = textOf().replace(reminder, '');
      if (raw.trim() === '' || injected.test(raw)) { out.push({ kind: 'other', text: '' }); continue; }
      out.push({ kind: 'user', text: mgMaskedMaybe(raw) });
    }
  }
  return out;
}

// True when the last hedged assistant record has no later real user prompt that resolves it.
function mgUnresolved(records) {
  var at = -1;
  for (var i = 0; i < records.length; i++) if (records[i].kind === 'assistant' && mgHasHedge(records[i].text)) at = i;
  if (at < 0) return false;
  var res = mgT('resolutions');
  for (var j = at + 1; j < records.length; j++) {
    if (records[j].kind === 'user') { var lower = records[j].text.toLowerCase(); if (res.some(function (r) { return lower.indexOf(r) >= 0; })) return false; }
  }
  return true;
}

function decide(p) {
  if (ah.settings.skipped(mgT('guard_name')) || !ah.settings.bool('merge_gate.setting')) return 'allow';
  var cmd = jx.isObj(p) && jx.isObj(p.tool_input) && typeof p.tool_input.command === 'string' ? p.tool_input.command : '';
  if (cmd === '' || !mgIsAutoMerge(cmd)) return 'allow';
  var tp = p.transcript_path;
  if (typeof tp !== 'string' || tp === '') return 'allow';
  if (!ah.path.isAbsolute(tp)) return 'defer';
  var tail = ah.fs.readTail(tp, ah.cfgNum('merge_gate.window_bytes'));
  if (tail === null) return 'allow';
  var records = mgRecords(tail);
  var t = records.filter(function (r) { return r.kind === 'assistant'; }).map(function (r) { return r.text; }).join('\n');
  if (t === '' || !mgHasHedge(t)) return 'allow';
  var unresolved = mgUnresolved(records);
  var n = ah.cfgNum('merge_gate.jev_state_chars'), window = t.length > n ? t.slice(-n) : t;
  if (t.length > n) { var first = window.charCodeAt(0); if (first >= 0xdc00 && first <= 0xdfff) return 'defer'; }
  if (p.session_id && typeof p.session_id === 'object') return 'defer'; // String(session_id) of an object is Node's to write
  var spec = {
    id: mgT('jev_id'), question: { type: 'noul', instructions: mgT('jev_instructions'), criteria: [['true', mgT('jev_true')], ['false', mgT('jev_false')]] },
    state: window, trust: 'relax_block', baseline: unresolved, turnRefFrom: tp,
  };
  if (p.session_id) spec.sessionId = String(p.session_id);
  if (typeof p.cwd === 'string') spec.projectFrom = p.cwd;
  try { ah.jev.ask(spec); } catch (e) { /* best effort, as Node's try/catch */ }
  if (!unresolved) return 'allow';
  var reason = text.message('block', mgT('guard_name'), { what: text.render(mgT('msg_what'), { hedge: mgLastHedge(t) || '' }), why: mgT('msg_why'), instead: mgT('msg_instead'), override: mgT('msg_override') });
  return { exact: { code: 2, out: '', err: reason + '\n' } };
}
