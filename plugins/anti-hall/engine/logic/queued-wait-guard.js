// check = "queued-wait-guard" (PreToolUse on Bash, subagents only; engine-only, no Node twin; GH #270). Blocks the two ways a lane agent
// pays to wait: a build or test command started with run_in_background (it then polls or re-reads while the build lock is held;
// run in the foreground under the lock, waiting costs nothing) and a sleep above a configured number of seconds, standing alone or
// inside a while/until/for poll loop. The main session and a workspace child are never judged. Every list, pattern, number and
// text is in lane_waste.toml. A failure of this script allows (script.failure_mode_by_check): the guard never blocks by breaking.
'use strict';

// The seconds a `sleep` argument list spells (each argument a number with an optional s/m/h/d suffix), or null when one is not.
function qwSleepSeconds(args) {
  var units = ah.cfg('queued_wait.duration_unit_s'), total = 0, seen = false;
  for (var i = 0; i < args.length; i++) {
    var m = /^(\d+(?:\.\d+)?)([a-z]?)$/.exec(args[i]);
    if (m === null) return null;
    var mult = m[2] === '' ? 1 : (Object.prototype.hasOwnProperty.call(units, m[2]) ? units[m[2]] : null);
    if (mult === null) return null;
    total += parseFloat(m[1]) * mult; seen = true;
  }
  return seen ? total : null;
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
  var plainMax = ah.cfgNum('queued_wait.sleep_max_s'), loopMax = ah.cfgNum('queued_wait.loop_sleep_max_s');
  for (var c = 0; c < cmds.length; c++) {
    var words = cmds[c].words, joined = words.join(' ');
    if (sleepers.indexOf(shellScan.basename(words[0])) >= 0) {
      var secs = qwSleepSeconds(words.slice(1));
      var max = cmds[c].inLoop ? loopMax : plainMax;
      if (secs !== null && secs > max) {
        return qwBlock(text.render(ah.cfg(cmds[c].inLoop ? 'queued_wait.msg_what_loop' : 'queued_wait.msg_what_sleep'),
          { cmd: laneWaste.shown(words), secs: secs, max: max }), ah.cfg('queued_wait.msg_instead_sleep'));
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
