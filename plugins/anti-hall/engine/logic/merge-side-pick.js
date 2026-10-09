// check = "merge-side-pick" (PreToolUse and PostToolUse on Bash; advisory only, never blocks). PostToolUse records a conflict
// resolved by taking one side wholesale and the test runs that follow, per session; a push while a side-pick has no test run
// after it adds one advisory line. Mirrors hooks/merge-side-pick.js and hooks/lib/merge-side-pick.js. The state is the very
// file the Node guard keeps (~/.anti-hall/merge-side-pick-<session>.json). Every pattern, limit and text is in
// engine/defaults/small_guards.toml (merge_side_pick.*).
'use strict';

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// Blank quoted spans (same length) so a quoted message or echo argument cannot be mistaken for a command.
function maskQuotes(cmd) {
  var s = cmd;
  ah.cfg('merge_side_pick.quote_masks').forEach(function (src) {
    var hits = ah.re.findAll(src, '', s), out = '', at = 0;
    hits.forEach(function (h) { out += s.slice(at, h[0]) + ' '.repeat(h[1] - h[0]); at = h[1]; });
    s = out + s.slice(at);
  });
  return s;
}

// Command segments split on `;`, `&`, `|` and newlines, quotes already masked.
function segments(cmd) {
  var s = maskQuotes(cmd), out = [], at = 0;
  var cut = function (a, b) { var t = s.slice(a, b).trim(); if (t) out.push(t); };
  ah.re.findAll(ah.cfg('merge_side_pick.segment_split'), '', s).forEach(function (h) { cut(at, h[0]); at = h[1]; });
  cut(at, s.length);
  return out;
}

function gitRe(tail) { return ah.cfg('merge_side_pick.git_prefix') + tail; }
function segPick(s) { return ah.cfg('merge_side_pick.pick_tails').some(function (t) { return ah.re.test(gitRe(t), '', s); }); }
function segTest(s) { return ah.cfg('merge_side_pick.test_patterns').some(function (src) { return ah.re.test(src, '', s); }); }
function segPush(s) { return ah.re.test(gitRe(ah.cfg('merge_side_pick.push_tail')), '', s) && !ah.re.test(ah.cfg('merge_side_pick.dry_run'), '', s); }

// A side-pick segment as stored and shown: white space collapsed, cut to the configured length. null when the cut would
// split a surrogate pair (the text then cannot be handled exactly: Node decides).
function keep(s) {
  var t = s.replace(/\s+/g, ' ').trim === undefined ? s : s.replace(/[\s᠎]+/g, ' ');
  var n = ah.cfgNum('merge_side_pick.cmd_keep');
  if (t.length <= n) return t;
  var hi = t.charCodeAt(n - 1), lo = t.charCodeAt(n);
  if (hi >= 0xD800 && hi <= 0xDBFF && lo >= 0xDC00 && lo <= 0xDFFF) return null;
  return t.slice(0, n);
}

// One session's record, coerced as the Node guard coerces whatever the file holds.
function load(raw) {
  var o = null;
  if (raw !== null) { try { o = JSON.parse(raw); } catch (e) { o = null; } }
  if (!isObj(o)) return { seq: 0, pickSeq: 0, testSeq: 0, cmd: '' };
  return { seq: o.seq | 0, pickSeq: o.pickSeq | 0, testSeq: o.testSeq | 0, cmd: String(o.cmd || '') };
}

function record(ns, key, cmd) {
  if (key === '') return true;
  var segs = segments(cmd);
  if (!segs.some(function (s) { return segPick(s) || segTest(s); })) return true;
  var failed = false;
  ah.sessionState.update(ns, key, function (cur) {
    var st = load(cur);
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (segPick(s)) {
        st.seq += 1; st.pickSeq = st.seq;
        var k = keep(s);
        if (k === null) { failed = true; return null; }
        st.cmd = k;
      } else if (segTest(s)) { st.seq += 1; st.testSeq = st.seq; }
    }
    return JSON.stringify({ seq: st.seq, pickSeq: st.pickSeq, testSeq: st.testSeq, cmd: st.cmd });
  });
  return !failed;
}

function pending(ns, key) {
  if (key === '') return '';
  var st = load(ah.sessionState.get(ns, key));
  if (st.pickSeq > 0 && st.pickSeq > st.testSeq) return st.cmd === '' ? ah.cfg('merge_side_pick.fallback_cmd') : st.cmd;
  return '';
}

// The side-pick command to warn about when `cmd` pushes with an untested side-pick; '' for none; null to defer.
function pushCheck(ns, key, cmd) {
  var pend = pending(ns, key), segs = segments(cmd);
  for (var i = 0; i < segs.length; i++) {
    var s = segs[i];
    if (segPick(s)) { pend = keep(s); if (pend === null) return null; }
    else if (segTest(s)) pend = '';
    else if (segPush(s) && pend !== '') return pend;
  }
  return '';
}

function decide(p, opts, event) {
  var bash = isObj(p) && p.tool_name === 'Bash';
  if (!ah.sessionState.homeOk()) return bash ? 'defer' : null;
  var ns = ah.cfg('merge_side_pick.state_ns');
  var ti = bash ? p.tool_input : null;
  var cmd = isObj(ti) && typeof ti.command === 'string' ? ti.command : '';
  var sid = isObj(p) && typeof p.session_id === 'string' ? p.session_id.trim() : '';
  var key = ah.sessionState.key(sid);
  if (sid !== '' && !ah.sessionState.probe(ns, key)) return 'defer';
  if (!bash || cmd === '' || sid === '') return 'allow';
  if (!ah.settings.bool('merge_side_pick.setting') || ah.settings.skipped(ah.cfg('merge_side_pick.guard_name'))) return 'allow';
  if (event === 'PostToolUse' || p.hook_event_name === 'PostToolUse') return record(ns, key, cmd) ? 'allow' : 'defer';
  var pick = pushCheck(ns, key, cmd);
  if (pick === null) return 'defer';
  if (pick === '') return 'allow';
  var what = text.render(ah.cfg('merge_side_pick.msg_what'), { pick: pick });
  var t = text.message('warn', ah.cfg('merge_side_pick.guard_name'), { what: what, why: ah.cfg('merge_side_pick.msg_why'), instead: ah.cfg('merge_side_pick.msg_instead') });
  return { advisory: text.advisoryJson('PreToolUse', t) };
}
