// check = "cache-ttl-wait-guard" (PreToolUse on Bash, Monitor and TaskOutput, every agent; engine-only, no Node twin; GH #884).
// A single tool call that waits longer than the prompt-cache window (cache_wait.limit_s) makes the next turn rebuild the whole context
// at full price: a sleep over the limit, a poll loop or watch whose timeout (the `timeout N` wrapper or the Bash tool's own timeout) is
// over it, a Monitor or TaskOutput deadline over it. The answer is an ORDER to split the wait into parts of cache_wait.split_s or less,
// as an advisory: this guard never blocks, so read-only work is never stopped. Repeats climb the nudge ladder (nudges.toml, kind
// cache_wait), which acts only at a Stop. Every list, number and text is in lane_waste.toml (cache_wait.*, queued_wait.*). A failure of
// this script allows (script.failure_mode_by_check): the guard never breaks a call.
'use strict';

// The seconds of the tool deadline field of `input` (milliseconds in the tool, seconds here), or null when absent or not a positive number.
function cwDeadlineS(input, field) {
  var v = input && input[field];
  return typeof v === 'number' && isFinite(v) && v > 0 ? v / ah.cfgNum('cache_wait.ms_per_s') : null;
}

function cwMin(a, b) { return a === null ? b : (b === null ? a : Math.min(a, b)); }

// The longest wait of a Bash command as { secs (Infinity = unbounded), cmd, kind }, or null when it holds none over the limit.
function cwBash(input) {
  var cmd = typeof input.command === 'string' ? input.command : '';
  if (cmd === '' || input[ah.cfg('cache_wait.bg_field')] === true) return null; // a background command returns at once: no wait in this call
  var limit = ah.cfgNum('cache_wait.limit_s'), toolBound = cwDeadlineS(input, ah.cfg('cache_wait.bash_timeout_field'));
  var sleepers = ah.cfg('queued_wait.sleep_commands'), watches = ah.cfg('queued_wait.watch_res'), kinds = ah.cfg('cache_wait.metric_kinds');
  var cmds = laneWaste.commands(cmd, 0), worst = null;
  for (var c = 0; c < cmds.length; c++) {
    var words = cmds[c].words, joined = words.join(' ');
    var isSleep = sleepers.indexOf(shellScan.basename(words[0])) >= 0, isWatch = false;
    for (var w = 0; !isSleep && !isWatch && w < watches.length; w++) isWatch = ah.re.test(watches[w], 'r', joined);
    if (!isSleep && !isWatch) continue;
    // a wrapper `timeout N` bounds the command unless something detaches inside it (then nothing bounds it)
    var wrapper = cmds[c].det ? null : laneWaste.timeoutSeconds(cmds[c].bound || []);
    var secs, kind = isSleep && !cmds[c].inLoop ? kinds.sleep : kinds.loop;
    if (isSleep && !cmds[c].inLoop) {
      var args = laneWaste.stripRedirects(words.slice(1));
      if (args.length === 0) continue; // `sleep` with no operand waits nothing
      var s = laneWaste.sleepSeconds(args);
      secs = cwMin(s === null ? Infinity : s, wrapper); // an unreadable length is an endless wait
    } else {
      // a poll loop or a watch lasts as long as its bound: the timeout wrapper or the Bash call's own timeout; with neither, no wait is known
      secs = cwMin(wrapper, toolBound);
      if (secs === null) continue;
    }
    if (secs > limit && (worst === null || secs > worst.secs)) worst = { secs: secs, cmd: laneWaste.shown(words), kind: kind };
  }
  return worst;
}

function decide(p) {
  if (!ah.settings.bool('cache_wait.sw') || ah.settings.skipped(ah.cfg('cache_wait.guard_name'))) return 'allow';
  var input = p && p.tool_input;
  if (!input || typeof input !== 'object') return 'allow';
  var tool = typeof p.tool_name === 'string' ? p.tool_name : '', limit = ah.cfgNum('cache_wait.limit_s'), tools = ah.cfg('cache_wait.tool_timeouts');
  var what = null, kind = '';
  if (Object.prototype.hasOwnProperty.call(tools, tool)) {
    if (input[ah.cfg('cache_wait.persistent_field')] === true) return 'allow';
    var secs = cwDeadlineS(input, tools[tool]);
    if (secs === null || secs <= limit) return 'allow';
    kind = ah.cfg('cache_wait.metric_kinds').tool;
    what = text.render(ah.cfg('cache_wait.msg_what_tool'), { tool: tool, secs: text.render(ah.cfg('cache_wait.msg_secs'), { n: Math.round(secs) }), limit: limit });
  } else {
    var hit = cwBash(input);
    if (hit === null) return 'allow';
    kind = hit.kind;
    var shownSecs = hit.secs === Infinity ? ah.cfg('cache_wait.msg_unbounded') : text.render(ah.cfg('cache_wait.msg_secs'), { n: Math.round(hit.secs) });
    what = text.render(ah.cfg('cache_wait.msg_what_bash'), { secs: shownSecs, limit: limit, cmd: hit.cmd });
  }
  ah.metric('cache_wait_orders_total', ['tool', tool, 'kind', kind]);
  var note = text.message('order', ah.cfg('cache_wait.guard_name'), { what: what, instead: text.render(ah.cfg('cache_wait.msg_instead'), { max: ah.cfgNum('cache_wait.split_s') }) });
  return { advisory: text.advisoryJson(typeof p.hook_event_name === 'string' ? p.hook_event_name : ah.cfg('cache_wait.event'), note) };
}
