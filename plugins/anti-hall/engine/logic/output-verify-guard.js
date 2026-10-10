// check = "output-verify-guard" (PostToolUse on Bash; advisory only). After a Bash call that ran a test runner, the output is
// scanned for a passing signal AND a failing signal (or a non-zero exit code) in the same run, and a reminder to read the real
// counts is added, at most once per turn per distinct signal set. For every test-runner output the Jev shadow question is asked
// without waiting (the answer only reaches the Jev decision log). The payload reaches a script with its object keys sorted, so
// where the order of a tool output's keys could change the answer, they are put back in the host's own order
// (output_verify_v1.key_order; keys it does not list follow, sorted) before the scanned text is built (unlisted keys are logged). A cut
// through a surrogate pair keeps the lone half, as Node's slice does. Mirrors hooks/output-verify-guard.js. Keys, patterns and
// texts: response_guards.toml (output_verify.*) and guards_v1.toml (output_verify_v1.*).
'use strict';

function ovIsObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function ovSignals(key) {
  return ah.cfg(key).map(function (e) {
    var flags = e.ci ? 'i' : '';
    return {
      re: new RegExp(e.src, flags + (e.multiline ? 'm' : '')), src: e.src, flags: flags, lineStart: !!e.multiline,
      count: e.src.indexOf(ah.cfg('output_verify.count_marker')) >= 0,
    };
  });
}

// The text of the first genuine hit of one signal, or null. A count pattern only counts a non-zero count (every occurrence is
// looked at); a pattern anchored to the start of a line is scanned by the interpreter (it is cheap), the others by the host's
// linear-time engine so a large output cannot spend the time limit.
function ovHit(s, text) {
  if (s.lineStart) { var h = text.match(s.re); return h ? h[0] : null; }
  if (!s.count) { var r = ah.re.find(s.src, s.flags, hookProc.usv(text)); return r ? text.slice(r[0], r[1]) : null; }
  var all = ah.re.findAll(s.src, s.flags, hookProc.usv(text));
  for (var i = 0; i < all.length; i++) {
    var t = text.slice(all[i][0], all[i][1]), g = new RegExp(s.src, s.flags).exec(t);
    if (g && parseInt(g[1], 10) !== 0) return t;
  }
  return null;
}

function ovFirstMatch(list, text) {
  for (var i = 0; i < list.length; i++) {
    var t = ovHit(list[i], text);
    if (t !== null) return t;
  }
  return null;
}

// The exit codes (null for a non-finite one) the exit-code text scan sees, in order.
function ovExitCodes(text, firstOnly) {
  var src = ah.cfg('output_verify.exit_code_re'), out = [];
  var safe = hookProc.usv(text);
  var all = firstOnly ? (function () { var r = ah.re.find(src, 'i', safe); return r ? [r] : []; })() : ah.re.findAll(src, 'i', safe);
  for (var i = 0; i < all.length; i++) {
    var g = new RegExp(src, 'i').exec(text.slice(all[i][0], all[i][1])), n = g ? parseInt(g[1], 10) : NaN;
    out.push(isFinite(n) ? n : null);
  }
  return out;
}

function ovIsTestRunner(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return false;
  var segs = cmd.split(gk.re('output_verify.segment_split_re')), verbs = ah.cfg('output_verify.runner_verbs'), subs = ah.cfg('output_verify.runner_subcommands');
  for (var k = 0; k < segs.length; k++) {
    var words = segs[k].trim().split(gk.re('output_verify.ws_split_re')).filter(Boolean);
    if (!words.length) continue;
    var i = 0;
    while (i < words.length && gk.re('output_verify.env_assign_re').test(words[i])) i++;
    if (i >= words.length) continue;
    var verb = words[i].split(gk.re('output_verify.path_sep_re')).pop(), rest = words.slice(i + 1);
    if (verbs.indexOf(verb) >= 0) return true;
    if (Object.prototype.hasOwnProperty.call(subs, verb)) {
      var want = subs[verb], run = ah.cfg('output_verify.run_word');
      if (rest[0] === want) return true;
      if (rest[0] === run && rest[1] === want) return true;
    }
  }
  return false;
}

// Objects with two or more keys anywhere in a value: their key order is the host's, not the sorted one the script sees.
function ovHasOrdered(v) {
  if (Array.isArray(v)) return v.some(ovHasOrdered);
  if (ovIsObj(v)) { var ks = Object.keys(v); return ks.length >= 2 || ks.some(function (k) { return ovHasOrdered(v[k]); }); }
  return false;
}

// v with every object's keys in the host's order: the listed keys first, in list order, then the others (sorted, as they came).
function ovReorder(v, order) {
  if (Array.isArray(v)) return v.map(function (x) { return ovReorder(x, order); });
  if (!ovIsObj(v)) return v;
  var ks = Object.keys(v), out = {};
  order.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = ovReorder(v[k], order); });
  ks.forEach(function (k) { if (order.indexOf(k) < 0) out[k] = ovReorder(v[k], order); });
  return out;
}

// Objects anywhere in a value with two or more keys the host order does not list: their order is not known here.
function ovHasUnlisted(v, order) {
  if (Array.isArray(v)) return v.some(function (x) { return ovHasUnlisted(x, order); });
  if (!ovIsObj(v)) return false;
  var ks = Object.keys(v);
  return ks.filter(function (k) { return order.indexOf(k) < 0; }).length >= 2 || ks.some(function (k) { return ovHasUnlisted(v[k], order); });
}

// The escaped text of every key and string value (what each contributes to JSON.stringify(v)).
function ovLeaves(v, out) {
  if (typeof v === 'string') out.push(JSON.stringify(v));
  else if (Array.isArray(v)) v.forEach(function (x) { ovLeaves(x, out); });
  else if (ovIsObj(v)) Object.keys(v).forEach(function (k) { out.push(JSON.stringify(k)); ovLeaves(v[k], out); });
}

// True when the order of keys inside v could change what the scan finds: a pattern has genuine hits with different text in
// different leaves, or the exit-code text scan sees two different codes.
function ovOrderMatters(v, structuredExit, fail, pass) {
  var ls = [];
  ovLeaves(v, ls);
  var lists = [fail, pass];
  for (var a = 0; a < lists.length; a++) {
    for (var b = 0; b < lists[a].length; b++) {
      var seen = [];
      for (var i = 0; i < ls.length; i++) {
        var t = ovFirstMatch([lists[a][b]], ls[i]);
        if (t !== null && seen.indexOf(t) < 0) seen.push(t);
      }
      if (seen.length > 1) return true;
    }
  }
  if (!structuredExit) {
    var codes = [], found = ovExitCodes(JSON.stringify(v), false);
    for (var q = 0; q < found.length; q++) if (codes.indexOf(found[q]) < 0) codes.push(found[q]);
    if (codes.length > 1) return true;
  }
  return false;
}

function ovDecide(p, pend) {
  if (!ah.settings.bool('output_verify.setting') || ah.settings.skipped(ah.cfg('output_verify.guard_name'))) return 'allow';
  if (!p || p.tool_name !== ah.cfg('output_verify.tool')) return 'allow';
  var ti = p.tool_input, cmd = ti && typeof ti.command === 'string' ? ti.command : '';
  if (!ovIsTestRunner(cmd)) return 'allow';
  // the blob: the stringified output values, in field order. The payload arrives with sorted keys; where the order of an object's
  // keys could change what the scan finds (or what a cut keeps), the host's own order is restored first.
  var vals = [], fields = ah.cfg('output_verify.blob_fields'), order = ah.cfg('output_verify_v1.key_order');
  for (var i = 0; i < fields.length; i++) { var v = p[fields[i]]; if (v !== undefined && v !== null) vals.push(v); }
  var build = function (host) {
    return vals.map(function (x) { return typeof x === 'string' ? x : JSON.stringify(host ? ovReorder(x, order) : x); }).join('\n');
  };
  var fail = ovSignals('output_verify.fail_patterns'), pass = ovSignals('output_verify.pass_patterns');
  var tr = p.tool_response, structured = null;
  if (ovIsObj(tr)) {
    var ef = ah.cfg('output_verify.exit_fields');
    for (var e = 0; e < ef.length; e++) { var c = tr[ef[e]]; if (typeof c === 'number' && isFinite(c)) { structured = c; break; } }
  }
  var blob = build(false), cap = ah.cfgNum('output_verify.scan_cap'), multi = vals.filter(ovHasOrdered);
  if (multi.length && (blob.length > cap || multi.some(function (x) { return ovOrderMatters(x, structured !== null, fail, pass); }))) {
    blob = build(true);
    if (multi.some(function (x) { return ovHasUnlisted(x, order); })) ah.log('output_verify_unlisted_keys', '');
  }
  if (blob.length > cap) {
    var half = Math.floor(cap / 2);
    blob = blob.slice(0, half) + ah.cfg('output_verify.truncation_marker') + blob.slice(-half);
  }
  if (!blob) return 'allow';
  var exitCode = structured;
  if (exitCode === null) {
    var xs = ovExitCodes(blob, true);
    if (xs.length && xs[0] !== null) exitCode = xs[0];
  }
  var failHit = ovFirstMatch(fail, blob), passHit = ovFirstMatch(pass, blob);
  var nonZero = typeof exitCode === 'number' && exitCode !== 0;
  var mismatch = Boolean(passHit) && (Boolean(failHit) || nonZero);
  // the Jev shadow question (never the decision): a window that would end in a lone high surrogate ends one unit earlier
  var win = ah.cfgNum('output_verify.jev_state_chars');
  if (blob.length > win && blob.charCodeAt(win - 1) >= 0xd800 && blob.charCodeAt(win - 1) <= 0xdbff && blob.charCodeAt(win) >= 0xdc00 && blob.charCodeAt(win) <= 0xdfff) win--;
  pend.ask = {
    id: ah.cfg('output_verify.jev_id'),
    question: { type: 'noul', instructions: ah.cfg('output_verify.jev_instructions'), criteria: [['true', ah.cfg('output_verify.jev_true')], ['false', ah.cfg('output_verify.jev_false')]] },
    state: blob.slice(0, win), trust: 'advisory', baseline: mismatch,
  };
  if (p.session_id) pend.ask.sessionId = String(p.session_id);
  if (typeof p.cwd === 'string') pend.ask.projectFrom = p.cwd;
  if (!mismatch) return 'allow';
  var bits = [text.render(ah.cfg('output_verify.bit_pass'), { hit: JSON.stringify(passHit) })];
  if (failHit) bits.push(text.render(ah.cfg('output_verify.bit_fail'), { hit: JSON.stringify(failHit) }));
  if (nonZero) bits.push(text.render(ah.cfg('output_verify.bit_exit'), { code: exitCode }));
  if (ah.settings.bool('output_verify.once_setting')) {
    if (!turnGate.firstThisTurn({
      sessionId: p.session_id, agentId: typeof p.agent_id === 'string' ? p.agent_id : '', transcriptPath: p.transcript_path,
      key: ah.cfg('output_verify.guard_name'), sig: bits.join(ah.cfg('output_verify.sig_sep')),
    })) return 'allow';
  }
  var reason = text.message('warn', ah.cfg('output_verify.guard_name'), {
    what: text.render(ah.cfg('output_verify.msg_what'), { bits: bits.join(ah.cfg('output_verify.bits_sep')) }),
    why: ah.cfg('output_verify.msg_why'), instead: ah.cfg('output_verify.msg_instead'),
  });
  return { exact: { code: 0, out: text.advisoryJson(ah.cfg('output_verify.event'), reason) + '\n', err: '' } };
}

function decide(p) {
  var pend = { ask: null };
  var v = ovDecide(p, pend);
  if (pend.ask !== null) ah.jev.ask(pend.ask);
  return v;
}
