// check = "queued-wait-guard" (PreToolUse on Bash, subagents only; engine-only, no Node twin; GH #270). Blocks the two ways a lane agent
// pays to wait: a build or test command started with run_in_background (it then polls or re-reads while the build lock is held;
// run in the foreground under the lock, waiting costs nothing) and a sleep above a configured number of seconds, standing alone or
// inside a while/until/for poll loop. A wait under an explicit `timeout N` (N within queued_wait.bounded_max_s) is allowed: a subagent
// must keep a path to its result, and an idle subagent is not woken by a notification. Over the limit, or with no bound, it is blocked. The main session and a workspace child are never judged. Every list, pattern, number and
// text is in lane_waste.toml. A failure of this script allows (script.failure_mode_by_check): the guard never blocks by breaking.
'use strict';

// The wait-duration readers live in lib/52-lane-waste.js (shared with cache-ttl-wait-guard).
var qwSleepSeconds = laneWaste.sleepSeconds, qwStripRedirects = laneWaste.stripRedirects, qwTimeoutSeconds = laneWaste.timeoutSeconds;

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
  var splitMax = ah.cfgNum('cache_wait.split_s'), plainMax = ah.cfgNum('queued_wait.sleep_max_s'), loopMax = ah.cfgNum('queued_wait.loop_sleep_max_s');
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
            text.render(ah.cfg('queued_wait.msg_instead_detach'), { max: splitMax }));
        }
      }
      if (bound !== null) {
        if (bound <= boundedMax) continue;
        return qwBlock(text.render(ah.cfg('queued_wait.msg_what_over'), { cmd: laneWaste.shown(words), secs: bound, max: boundedMax }),
          text.render(ah.cfg('queued_wait.msg_instead_over'), { max: splitMax }));
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
          text.render(ah.cfg('queued_wait.msg_instead_sleep'), { max: splitMax }));
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
