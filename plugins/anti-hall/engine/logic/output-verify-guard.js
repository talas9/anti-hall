// check = "output-verify-guard" (PostToolUse on Bash; advisory only). After a Bash call that ran a test runner, the output is
// scanned for a passing signal AND a failing signal (or a non-zero exit code) in the same run, and a reminder to read the real
// counts is added, at most once per turn per distinct signal set. For every test-runner output the Jev shadow question is asked
// without waiting (the answer only reaches the Jev decision log). The payload reaches a script with its object keys sorted, so a
// tool output whose answer could depend on the order of its keys, or a truncation that would depend on it, defers to Node.
// A request without HOME defers. Mirrors hooks/output-verify-guard.js. Keys, patterns and texts: response_guards.toml (output_verify.*).
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
  if (!s.count) { var r = ah.re.find(s.src, s.flags, text); return r ? text.slice(r[0], r[1]) : null; }
  var all = ah.re.findAll(s.src, s.flags, text);
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
  var all = firstOnly ? (function () { var r = ah.re.find(src, 'i', text); return r ? [r] : []; })() : ah.re.findAll(src, 'i', text);
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

// Objects with two or more keys anywhere in a value: their key order is Node's, not ours.
function ovHasOrdered(v) {
  if (Array.isArray(v)) return v.some(ovHasOrdered);
  if (ovIsObj(v)) { var ks = Object.keys(v); return ks.length >= 2 || ks.some(function (k) { return ovHasOrdered(v[k]); }); }
  return false;
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
  var home = ah.env.get(ah.cfg('env.home'));
  if (home === null || home === '') return 'defer';
  if (!ah.settings.bool('output_verify.setting') || ah.settings.skipped(ah.cfg('output_verify.guard_name'))) return 'allow';
  if (!p || p.tool_name !== ah.cfg('output_verify.tool')) return 'allow';
  var ti = p.tool_input, cmd = ti && typeof ti.command === 'string' ? ti.command : '';
  if (!ovIsTestRunner(cmd)) return 'allow';
  // the blob: the stringified output values, in field order
  var parts = [], ordered = [], fields = ah.cfg('output_verify.blob_fields');
  for (var i = 0; i < fields.length; i++) {
    var v = p[fields[i]];
    if (v === undefined || v === null) continue;
    parts.push(typeof v === 'string' ? v : JSON.stringify(v));
    if (ovHasOrdered(v)) ordered.push(v);
  }
  var blob = parts.join('\n'), cap = ah.cfgNum('output_verify.scan_cap');
  if (blob.length > cap) {
    if (ordered.length) return 'defer';
    var half = Math.floor(cap / 2), hi = blob.charCodeAt(half - 1), lo = blob.charCodeAt(blob.length - half);
    if ((hi >= 0xd800 && hi <= 0xdbff) || (lo >= 0xdc00 && lo <= 0xdfff)) return 'defer'; // a cut through a surrogate pair stays on Node
    blob = blob.slice(0, half) + ah.cfg('output_verify.truncation_marker') + blob.slice(-half);
  }
  if (!blob) return 'allow';
  var fail = ovSignals('output_verify.fail_patterns'), pass = ovSignals('output_verify.pass_patterns');
  var tr = p.tool_response, structured = null;
  if (ovIsObj(tr)) {
    var ef = ah.cfg('output_verify.exit_fields');
    for (var e = 0; e < ef.length; e++) { var c = tr[ef[e]]; if (typeof c === 'number' && isFinite(c)) { structured = c; break; } }
  }
  for (var o = 0; o < ordered.length; o++) if (ovOrderMatters(ordered[o], structured !== null, fail, pass)) return 'defer';
  var exitCode = structured;
  if (exitCode === null) {
    var xs = ovExitCodes(blob, true);
    if (xs.length && xs[0] !== null) exitCode = xs[0];
  }
  var failHit = ovFirstMatch(fail, blob), passHit = ovFirstMatch(pass, blob);
  var nonZero = typeof exitCode === 'number' && exitCode !== 0;
  var mismatch = Boolean(passHit) && (Boolean(failHit) || nonZero);
  // the Jev shadow question: a window that would cut a surrogate pair is Node's lone surrogate, which stays on Node
  var win = ah.cfgNum('output_verify.jev_state_chars');
  if (blob.length > win && blob.charCodeAt(win - 1) >= 0xd800 && blob.charCodeAt(win - 1) <= 0xdbff && blob.charCodeAt(win) >= 0xdc00 && blob.charCodeAt(win) <= 0xdfff) return 'defer';
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
  if (v !== 'defer' && pend.ask !== null) ah.jev.ask(pend.ask);
  return v;
}
