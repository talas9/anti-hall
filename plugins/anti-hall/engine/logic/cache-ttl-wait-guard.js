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
    // a sleep in a `for` loop is judged by its own length: the list bounds the loop, so the tool timeout says nothing about the wait
    if (isSleep && !(cmds[c].inLoop && cmds[c].poll)) {
      var args = laneWaste.stripRedirects(words.slice(1));
      if (args.length === 0) continue; // `sleep` with no operand waits nothing
      var s = laneWaste.sleepSeconds(args);
      secs = cwMin(s === null ? Infinity : s, wrapper); // an unreadable length is an endless wait
    } else {
      // a poll loop (while, until) or a watch lasts as long as its bound: the timeout wrapper or the Bash call's own timeout; with neither, no wait is known
      secs = cwMin(wrapper, toolBound);
      if (secs === null) continue;
    }
    if (secs > limit && (worst === null || secs > worst.secs)) worst = { secs: secs, cmd: laneWaste.shown(words), kind: kind };
  }
  return worst;
}

// Whether a Monitor's whole command is plainly the engine's own wake watcher (cache_wait.watcher_argv): ONE simple command, no
// chain, pipe, background, subshell or command substitution, whose first word (after at most ONE of the listed cache_wait.watcher_prefixes,
// e.g. the `exec` of agent_tracker.wake_command) is the watcher program, followed by one listed verb and then only options; the only
// redirections allowed are the listed cache_wait.watcher_redirects (the `2>&1` of agent_tracker.wake_command_agents). Any assignment,
// other wrapper (flock, timeout, env, nice, ...) or other redirection means no exemption: such a Monitor is judged as any other.
// That Monitor streams wake rows and idles by event for its whole timeout (agent_tracker.wake_timeout_ms), so it is no single wait.
// The words of a simple command as the shell expands the home directory in them (review round 3 P1-B): a home form of
// cache_wait.home_forms that starts with `~` expands only unquoted at the start of a word; one that starts with `$` expands unquoted or
// inside double quotes, never inside single quotes. Quotes are removed; nothing else is expanded.
function cwShellWords(cmd) {
  var forms = ah.cfg('cache_wait.home_forms'), home = ah.home(), out = [], cur = '', has = false, q = null, n = cmd.length;
  home = typeof home === 'string' ? home.replace(/\/+$/, '') : '';
  var form = function (i, dollar) {
    if (home === '') return null;
    for (var f = 0; f < forms.length; f++) {
      if ((forms[f].charAt(0) === '$') === dollar && cmd.substr(i, forms[f].length) === forms[f]) return forms[f];
    }
    return null;
  };
  for (var i = 0; i < n; i++) {
    var c = cmd.charAt(i), m;
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') {
      if (c === '"') { q = null; continue; }
      if (c === '\\' && i + 1 < n) { cur += cmd.charAt(++i); continue; }
      if ((m = form(i, true)) !== null) { cur += home + '/'; i += m.length - 1; continue; }
      cur += c; continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') { if (has) out.push(cur); cur = ''; has = false; continue; }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === '\\' && i + 1 < n) { cur += cmd.charAt(++i); has = true; continue; }
    if (!has && (m = form(i, false)) !== null) { cur += home + '/'; i += m.length - 1; has = true; continue; }
    if ((m = form(i, true)) !== null) { cur += home + '/'; i += m.length - 1; has = true; continue; }
    cur += c; has = true;
  }
  if (has) out.push(cur);
  return out;
}

// The program word of a simple command (after at most one cache_wait.watcher_prefixes word), home expanded as the shell would.
function cwProgram(cmd) {
  var w = cwShellWords(cmd), prefixes = ah.cfg('cache_wait.watcher_prefixes'), at = w.length > 0 && prefixes.indexOf(w[0]) >= 0 ? 1 : 0;
  return at < w.length ? w[at] : null;
}

// The watcher program paths the engine itself names in its re-arm commands (cache_wait.watcher_command_keys), home expanded.
function cwPrograms() {
  var keys = ah.cfg('cache_wait.watcher_command_keys'), out = [];
  for (var i = 0; i < keys.length; i++) {
    var p = cwProgram(String(ah.cfg(keys[i])));
    if (p !== null) out.push(p);
  }
  return out;
}

function cwWatcher(input) {
  var cmd = typeof input.command === 'string' ? input.command : '';
  // review round 4 P1-2: be conservative: an escape or ANSI-C quoting (cache_wait.watcher_unsafe) anywhere means no exemption
  var unsafe = ah.cfg('cache_wait.watcher_unsafe');
  for (var u = 0; u < unsafe.length; u++) if (cmd.indexOf(unsafe[u]) >= 0) return false;
  var segs = laneWaste.split(cmd);
  if (segs.length !== 1 || segs[0].amp || segs[0].proc || segs[0].inLoop) return false;
  var words = segs[0].words, prefixes = ah.cfg('cache_wait.watcher_prefixes'), redirects = ah.cfg('cache_wait.watcher_redirects');
  var at = 0;
  if (at < words.length && prefixes.indexOf(words[at]) >= 0) at++; // at most one prefix: `exec exec ...` is not the plain command
  var rest = [];
  for (var w = at; w < words.length; w++) {
    var x = words[w];
    if (x.indexOf('$(') >= 0) return false;
    if (/[<>]/.test(x)) { if (redirects.indexOf(x) < 0) return false; continue; }
    rest.push(x);
  }
  if (rest.length === 0 || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) return false;
  // review round 2 P1-3: the program must be the very path the engine's own re-arm commands name, not any file called ah-engine
  var prog = cwProgram(cmd);
  if (prog === null || !ah.re.test(ah.cfg('cache_wait.watcher_path_re'), 'r', prog) || cwPrograms().indexOf(prog) < 0) return false;
  var argvs = ah.cfg('cache_wait.watcher_argv');
  for (var i = 0; i < argvs.length; i++) {
    var argv = argvs[i], ok = argv.length > 0 && rest.length >= argv.length && shellScan.basename(rest[0]) === argv[0];
    for (var k = 1; ok && k < argv.length; k++) ok = rest[k] === argv[k];
    for (var r = argv.length; ok && r < rest.length; r++) ok = rest[r].charAt(0) === '-';
    if (ok) return true;
  }
  return false;
}

function decide(p) {
  if (!ah.settings.bool('cache_wait.sw') || ah.settings.skipped(ah.cfg('cache_wait.guard_name'))) return 'allow';
  var input = p && p.tool_input;
  if (!input || typeof input !== 'object') return 'allow';
  var tool = typeof p.tool_name === 'string' ? p.tool_name : '', limit = ah.cfgNum('cache_wait.limit_s'), tools = ah.cfg('cache_wait.tool_timeouts');
  var what = null, kind = '';
  if (Object.prototype.hasOwnProperty.call(tools, tool)) {
    if (input[ah.cfg('cache_wait.persistent_field')] === true) return 'allow';
    if (ah.cfg('cache_wait.watcher_tools').indexOf(tool) >= 0 && cwWatcher(input)) {
      ah.metric('cache_wait_watcher_exempt_total', ['tool', tool]);
      return 'allow';
    }
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
