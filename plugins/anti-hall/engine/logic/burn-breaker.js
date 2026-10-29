// check = "burn-breaker" (PreToolUse on every tool; engine-only, no Node twin). GH #270: tokens spent versus outcome. The agent tracker
// (ah-engine, src/agents/signals.rs) keeps the hard burn flag of an agent that spent burn.hard_tokens_no_outcome tokens since its last
// commit, finished step, passing check or new file, and mirrors it in <state>/agent-tracker/breaker/<agent key>.json. While that marker
// is fresh this check blocks the SUBAGENT's tool calls except commit (`git commit -m '<plain text>'` or `-F <file>`), push, status and read-only inspection commands (grep, rg, ls, cat, head, tail, wc, git log/diff/show) and SendMessage (its report); the main
// session is never blocked (no agent_id in its payload). The marker is removed by the tracker when the agent produces an outcome, and at once by this check when the agent runs an allowed git commit.
// Every name, number, pattern and text is in burn.toml. A Bash decision fails CLOSED (any error in it means not allowed); a crash of the script itself allows (script.failure_mode_by_check).
'use strict';

// Every Bash decision here fails CLOSED: a command is allowed only when every check below passes, and any error inside them means "not allowed".
// The command is screened as a whole first (length bound, printable ASCII only, no backslash, backtick, `$` or heredoc: burn.max_cmd_chars,
// burn.charset_re, burn.reject_re) and burn.deny_res runs on the RAW text, before any quote handling. What is left has no escape, no
// expansion and no second line, so a quoted string is inert and can be blanked to split the command on `&&` and `;`.
function bbScreen(cmd) {
  if (cmd === '' || cmd.length > ah.cfg('burn.max_cmd_chars')) return false;
  if (!ah.re.test(ah.cfg('burn.charset_re'), 'r', cmd)) return false;
  if (ah.re.test(ah.cfg('burn.reject_re'), 'r', cmd)) return false;
  var deny = ah.cfg('burn.deny_res');
  for (var i = 0; i < deny.length; i++) if (ah.re.test(deny[i], 'r', cmd)) return false;
  return true;
}

// The command with each quoted string (quotes included) blanked to `x`, same length, or null when a stray quote is left (an unbalanced quote is not judged).
function bbBlank(cmd) {
  var spans = ah.re.findAll(ah.cfg('burn.quoted_re'), 'r', cmd), out = '', at = 0;
  for (var i = 0; i < spans.length; i++) {
    out += cmd.slice(at, spans[i][0]) + new Array(spans[i][1] - spans[i][0] + 1).join('x');
    at = spans[i][1];
  }
  out += cmd.slice(at);
  return ah.re.test(ah.cfg('burn.quote_char_re'), 'r', out) ? null : out;
}

// Splits on `&&` and `;` outside quotes. Returns [{raw, plain}] (the segment and its blanked twin, tails already cut) or null.
function bbSegments(cmd) {
  var blank = bbBlank(cmd);
  if (blank === null) return null;
  var seps = ah.re.findAll(ah.cfg('burn.separator_re'), 'r', blank), out = [], at = 0;
  for (var i = 0; i <= seps.length; i++) {
    var end = i < seps.length ? seps[i][0] : cmd.length;
    var raw = cmd.slice(at, end), plain = blank.slice(at, end);
    var tail = ah.re.find(ah.cfg('burn.allowed_suffix_re'), 'r', plain);
    if (tail !== null) { raw = raw.slice(0, tail[0]); plain = plain.slice(0, tail[0]); }
    if (plain.replace(/\s+/g, '') !== '') out.push({ raw: raw, plain: plain });
    at = i < seps.length ? seps[i][1] : at;
  }
  return out.length > 0 ? out : null;
}

function bbSegmentAllowed(seg) {
  if (ah.re.test(ah.cfg('burn.forbidden_bash_re'), 'r', seg.plain)) return false;
  if (ah.re.test(ah.cfg('burn.commit_re'), 'r', seg.raw) || ah.re.test(ah.cfg('burn.rm_target_re'), 'r', seg.raw)) return true;
  return ah.re.test(ah.cfg('burn.allowed_bash_re'), 'r', seg.plain) || ah.re.test(ah.cfg('burn.allowed_readonly_re'), 'r', seg.plain) || ah.re.test(ah.cfg('burn.allowed_cd_re'), 'r', seg.plain);
}

// Returns {commits} when every segment is allowed (commits: some segment is a git commit/push, burn.lift_bash_re), else null.
function bbAllowedBash(cmd) {
  if (!bbScreen(cmd)) return null;
  var segs = bbSegments(cmd), commits = false;
  if (segs === null) return null;
  for (var i = 0; i < segs.length; i++) {
    if (!bbSegmentAllowed(segs[i])) return null;
    if (ah.re.test(ah.cfg('burn.lift_bash_re'), 'r', segs[i].plain)) commits = true;
  }
  return { commits: commits };
}

// True when `path` is a report location (burn.report_path_res: a scratchpad, a reports directory, the handover/history/progress notes) with no `..`.
function bbReportPath(path) {
  if (typeof path !== 'string' || path === '' || path.indexOf('..') >= 0) return false;
  var res = ah.cfg('burn.report_path_res');
  for (var i = 0; i < res.length; i++) if (ah.re.test(res[i], 'r', path)) return true;
  return false;
}

// One screened line that only writes a report file: burn.report_bash_re, the target after the last `>` in burn.report_path_res, no `#` or chain
// outside quotes (burn.forbidden_bash_re on the blanked line, minus the one redirect).
function bbReportWrite(cmd) {
  if (!bbScreen(cmd) || !ah.re.test(ah.cfg('burn.report_bash_re'), 'r', cmd)) return false;
  var blank = bbBlank(cmd), at = cmd.lastIndexOf('>');
  if (blank === null || at < 0 || blank.charAt(at) !== '>') return false;
  var chars = blank.split('');
  chars[at] = ' ';
  if (at > 0 && chars[at - 1] === '>') chars[at - 1] = ' ';
  if (ah.re.test(ah.cfg('burn.forbidden_bash_re'), 'r', chars.join(''))) return false;
  return bbReportPath(cmd.slice(at + 1).trim());
}

// One screened line that is a mesh/agents `send` (the escalation to the parent and the other mesh sends): burn.send_bash_re, nothing chained.
function bbSend(cmd) {
  if (!bbScreen(cmd) || !ah.re.test(ah.cfg('burn.send_bash_re'), 'r', cmd)) return false;
  var blank = bbBlank(cmd);
  return blank !== null && !ah.re.test(ah.cfg('burn.forbidden_bash_re'), 'r', blank) && !ah.re.test(ah.cfg('burn.separator_re'), 'r', blank);
}

// Runs a Bash judge and fails closed: an error means not allowed.
function bbSafely(fn, cmd) {
  try { return fn(cmd); } catch (e) { return null; }
}

function decide(p) {
  if (p === null || typeof p !== 'object') return 'allow';
  var held = bbMarker(p);
  if (held === null) return 'allow';
  var m = held.marker, rel = held.rel;
  var tool = typeof p.tool_name === 'string' ? p.tool_name : '';
  if (ah.cfg('burn.allowed_tools').indexOf(tool) >= 0) return 'allow';
  // writing the report IS the outcome the block asks for: a Write/Edit of a report path, or a Bash redirect into one, passes and lifts the
  // block at once (the tracker counts the new file on its next tick and raises the flag again only if the condition still holds)
  var ti = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  if (ah.cfg('burn.report_tools').indexOf(tool) >= 0 && bbReportPath(ti[ah.cfg('burn.report_path_field')])) {
    ah.state.remove(rel);
    return 'allow';
  }
  if (ah.cfg('burn.bash_tools').indexOf(tool) >= 0 && typeof ti.command === 'string') {
    var cmd = ti.command;
    if (bbSafely(bbSend, cmd) === true) return 'allow'; // escalation and mesh sends always get through
    if (bbSafely(bbReportWrite, cmd) === true) {
      ah.state.remove(rel);
      return 'allow';
    }
    var ok = bbSafely(bbAllowedBash, cmd);
    if (ok !== null && ok !== undefined) {
      // a commit is the outcome the block asks for: lift it now; the tracker counts the commit on its next tick and raises it again only if the hard condition still holds
      if (ok.commits) ah.state.remove(rel);
      return 'allow';
    }
  }
  // the heading names the condition that really holds: the token line (tokens_text) or the waste sensor's hard mark (score, never a token count)
  var what = m.source === 'waste'
    ? text.render(ah.cfg('burn.msg_what_waste'), { score: String(m.score), hard: String(m.hard), tokens: String(m.tokens_text), reason: String(m.reason) })
    : text.render(ah.cfg('burn.msg_what'), { tokens: String(m.tokens_text !== undefined ? m.tokens_text : m.tokens) });
  var reason = text.detailsMessage('block', ah.cfg('burn.guard_name'), {
    what: what,
    why: ah.cfg('burn.msg_why'),
    instead: ah.cfg('burn.msg_instead'),
    allowed: ah.cfg('burn.msg_allowed'),
    override: ah.cfg('burn.msg_override'),
  }, p.session_id);
  // exit 2 with the reason on stdout as a decision and on stderr: Claude reads the decision, Codex honors exit 2 only with the reason on stderr
  return { exact: { code: 2, out: text.blockJson(reason), err: reason + '\n' } };
}
