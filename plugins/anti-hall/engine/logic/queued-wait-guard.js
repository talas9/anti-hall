// check = "queued-wait-guard" (PreToolUse on Bash, subagents only; engine-only, no Node twin; GH #270). Blocks the two ways a lane agent
// pays to wait: a build or test command started with run_in_background (it then polls or re-reads while the build lock is held;
// run in the foreground under the lock, waiting costs nothing) and a sleep above a configured number of seconds, standing alone or
// inside a while/until/for poll loop. A wait under an explicit `timeout N` (N within queued_wait.bounded_max_s) is allowed: a subagent
// must keep a path to its result, and an idle subagent is not woken by a notification. Over the limit, or with no bound, it is blocked. The main session and a workspace child are never judged. Every list, pattern, number and
// text is in lane_waste.toml. A failure of this script allows (script.failure_mode_by_check): the guard never blocks by breaking.
'use strict';

// The seconds a `sleep` argument list spells (each argument a number with an optional s/m/h/d suffix, or an infinity word), or null
// when one is not. A caller that judges a sleep treats null as an UNBOUNDED wait (fail closed), never as "not a wait".
function qwSleepSeconds(args) {
  var units = ah.cfg('queued_wait.duration_unit_s'), inf = ah.cfg('queued_wait.duration_infinity_words'), total = 0, seen = false;
  var start = args.length > 0 && args[0] === '--' ? 1 : 0; // `--` ends the options: the operands follow
  for (var i = start; i < args.length; i++) {
    if (inf.indexOf(String(args[i]).toLowerCase()) >= 0) { total = Infinity; seen = true; continue; }
    // a decimal (5, 5., .5, 0.5), optionally with an exponent (1e1), then an optional unit suffix
    var m = /^(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)([a-z]?)$/.exec(args[i]);
    if (m === null) return null;
    var mult = m[2] === '' ? 1 : (Object.prototype.hasOwnProperty.call(units, m[2]) ? units[m[2]] : null);
    if (mult === null) return null;
    total += parseFloat(m[1]) * mult; seen = true;
  }
  return seen ? total : null;
}

// The words of `args` without shell redirections (`>/dev/null`, `2>&1`, `&>f`, a bare `>` with the file after it, and a redirection
// attached to a word: `60>/dev/null`, `60&>x`, `60<x` keep the `60`).
function qwStripRedirects(args) {
  var out = [];
  for (var i = 0; i < args.length; i++) {
    var a = String(args[i]), at = a.search(/[<>]/);
    if (at < 0) { out.push(a); continue; }
    var head = a.slice(0, at).replace(/&$/, '');
    // a lone 0/1/2 before the operator is the shell's fd number (`2>&1`), not a duration; any other attached word is kept
    if (/^[012]$/.test(head)) head = '';
    if (head !== '') out.push(head);
    if (/^[^<>]*[<>]+&?$/.test(a)) i++;
  }
  return out;
}

// True when the `timeout -s` value names a signal that does not terminate (queued_wait.timeout_silent_signals; SIG prefix and case ignored).
function qwSilentSignal(v) {
  var t = String(v).toUpperCase().replace(/^SIG/, ''), list = ah.cfg('queued_wait.timeout_silent_signals');
  return list.indexOf(t) >= 0;
}

// The seconds of the tightest `timeout [flags] N` (N above 0) among the wrapper words `pre` that bound a command, or null when none does.
function qwTimeoutSeconds(pre) {
  var names = ah.cfg('queued_wait.timeout_commands'), valued = ah.cfg('lane_waste.wrappers'), best = null;
  for (var i = 0; i < pre.length; i++) {
    var b = shellScan.basename(pre[i]);
    if (names.indexOf(b) < 0) continue;
    var vals = Object.prototype.hasOwnProperty.call(valued, b) ? valued[b] : [], j = i + 1, silent = false, killSecs = 0;
    var sigFlags = ah.cfg('queued_wait.timeout_signal_flags'), killFlags = ah.cfg('queued_wait.timeout_kill_flags');
    while (j < pre.length && pre[j].charAt(0) === '-' && pre[j].length > 1) {
      var fl = pre[j], val = null, eq = fl.indexOf('=');
      var name = fl.charAt(1) === '-' ? (eq > 0 ? fl.slice(0, eq) : fl) : fl.slice(0, 2);
      if (fl.charAt(1) === '-' && eq > 0) val = fl.slice(eq + 1);
      else if (fl.charAt(1) !== '-' && fl.length > 2) val = fl.slice(2);
      else if (vals.indexOf(fl) >= 0) { val = j + 1 < pre.length ? pre[j + 1] : null; j++; }
      j++;
      if (sigFlags.indexOf(name) >= 0 && val !== null && qwSilentSignal(val)) silent = true;
      // a kill-after of 0 (GNU: no follow-up kill) or one that does not parse adds no escalation
      if (killFlags.indexOf(name) >= 0 && val !== null) { var ks = qwSleepSeconds([val]); killSecs = ks !== null && ks > 0 ? ks : 0; }
    }
    // a signal that does not terminate (0, CONT, STOP, ...) never ends the command; only a positive --kill-after still bounds it, and
    // then the command lives for the duration plus the kill-after (a kill-after within the grace margin counts as part of the duration)
    if (silent && killSecs <= 0) continue;
    var secs = j < pre.length ? qwSleepSeconds([pre[j]]) : null;
    // the duration itself must be positive (0 disables the timer, whatever the kill-after says)
    if (secs === null || secs <= 0) continue;
    if (secs !== null && silent) secs += Math.max(0, killSecs - ah.cfgNum('queued_wait.kill_after_grace_s'));
    // timeout 0 (or a negative number) disables the limit (GNU), so it bounds nothing
    if (secs !== null && secs > 0 && (best === null || secs < best)) best = secs;
  }
  return best;
}

function qwBlock(what, instead) {
  var reason = text.message('block', ah.cfg('queued_wait.guard_name'), {
    what: what, why: ah.cfg('queued_wait.msg_why'), instead: instead, override: ah.cfg('queued_wait.msg_override'),
  });
  // exit 2 with the reason on stdout as a decision and on stderr: Claude reads the decision, Codex honors exit 2 only with the reason on stderr
  return { exact: { code: 2, out: text.blockJson(reason), err: reason + '\n' } };
}

function decide(p, opts) {
  if (!ah.settings.bool('queued_wait.sw') || ah.settings.skipped(ah.cfg('queued_wait.guard_name'))) return 'allow';
  var input = p && p.tool_input;
  var cmd = input && typeof input.command === 'string' ? input.command : '';
  if (cmd === '' || !coordinator.subagentByPayload(p)) return 'allow';
  var cmds = laneWaste.commands(cmd, 0);
  var background = input[ah.cfg('queued_wait.bg_field')] === true, heavy = ah.cfg('queued_wait.heavy_res');
  var sleepers = ah.cfg('queued_wait.sleep_commands');
  var watches = ah.cfg('queued_wait.watch_res'), boundedMax = ah.cfgNum('queued_wait.bounded_max_s');
  var plainMax = ah.cfgNum('queued_wait.sleep_max_s'), loopMax = ah.cfgNum('queued_wait.loop_sleep_max_s');
  for (var c = 0; c < cmds.length; c++) {
    var words = cmds[c].words, joined = words.join(' ');
    var isSleep = sleepers.indexOf(shellScan.basename(words[0])) >= 0, isWatch = false;
    for (var w = 0; !isSleep && !isWatch && w < watches.length; w++) isWatch = ah.re.test(watches[w], 'r', joined);
    if (isSleep || isWatch) {
      // an explicit `timeout N` bounds the wait: within the limit it is allowed (the agent keeps the result in hand), above it blocked
      // a detach token inside the timeout-wrapped segment (cmds[c].det) means no timeout bounds it: fail closed, whatever the duration parses to
      var timed = qwTimeoutSeconds(cmds[c].bound || []);
      var bound = cmds[c].det ? null : timed;
      if (cmds[c].det && timed !== null && isSleep) {
        var dargs = qwStripRedirects(words.slice(1)), dsecs = qwSleepSeconds(dargs);
        if (dargs.length > 0 && (dsecs === null || dsecs > plainMax)) {
          return qwBlock(text.render(ah.cfg('queued_wait.msg_what_detach'), { cmd: laneWaste.shown(words) }),
            text.render(ah.cfg('queued_wait.msg_instead_detach'), { max: boundedMax }));
        }
      }
      if (bound !== null) {
        if (bound <= boundedMax) continue;
        return qwBlock(text.render(ah.cfg('queued_wait.msg_what_over'), { cmd: laneWaste.shown(words), secs: bound, max: boundedMax }),
          text.render(ah.cfg('queued_wait.msg_instead_over'), { max: boundedMax }));
      }
    }
    if (isSleep) {
      var secs = qwSleepSeconds(qwStripRedirects(words.slice(1)));
      var max = cmds[c].inLoop ? loopMax : plainMax;
      var sargs = qwStripRedirects(words.slice(1));
      // an operand that does not parse (a variable, a typo, `infinity`) is an unbounded wait: fail closed; no operand at all is no wait
      if (sargs.length > 0 && (secs === null || secs > max)) {
        return qwBlock(text.render(ah.cfg(cmds[c].inLoop ? 'queued_wait.msg_what_loop' : 'queued_wait.msg_what_sleep'),
          { cmd: laneWaste.shown(words), secs: secs === null || secs === Infinity ? ah.cfg('queued_wait.unbounded_label') : secs, max: max }),
          text.render(ah.cfg('queued_wait.msg_instead_sleep'), { max: boundedMax }));
      }
      continue;
    }
    if (!background) continue;
    for (var h = 0; h < heavy.length; h++) {
      if (ah.re.test(heavy[h], 'r', joined)) {
        return qwBlock(text.render(ah.cfg('queued_wait.msg_what_bg'), { cmd: laneWaste.shown(words) }), ah.cfg('queued_wait.msg_instead_bg'));
      }
    }
  }
  return 'allow';
}
