// check = "burn-breaker" (PreToolUse on every tool; engine-only, no Node twin). GH #270: tokens spent versus outcome. The agent tracker
// (ah-engine, src/agents/signals.rs) keeps the hard burn flag of an agent that spent burn.hard_tokens_no_outcome tokens since its last
// commit, finished step, passing check or new file, and mirrors it in <state>/agent-tracker/breaker/<agent key>.json. While that marker
// is fresh this check blocks the SUBAGENT's tool calls except commit, push, status commands and SendMessage (its report); the main
// session is never blocked (no agent_id in its payload). The marker is removed by the tracker when the agent produces an outcome.
// Every name, number, pattern and text is in burn.toml. A failure of this script allows (script.failure_mode_by_check).
'use strict';

// Reduces plain quoted strings to "" so a commit message may hold `;` or `&`, splits the command on `&&` and `;`, and judges each segment:
// a harmless tail (2>&1, | tail -N) is dropped, then the segment must be an allowed git command or a cd, with nothing hidden in it.
function bbAllowedBash(cmd) {
  var plain = cmd.replace(new RegExp(ah.cfg('burn.quoted_re'), 'g'), '""');
  var parts = plain.split(new RegExp(ah.cfg('burn.separator_re'))), seen = 0;
  for (var i = 0; i < parts.length; i++) {
    var seg = parts[i].replace(new RegExp(ah.cfg('burn.allowed_suffix_re')), '');
    if (seg.replace(/\s+/g, '') === '') continue;
    if (ah.re.test(ah.cfg('burn.forbidden_bash_re'), 'r', seg)) return false;
    if (!ah.re.test(ah.cfg('burn.allowed_bash_re'), 'r', seg) && !ah.re.test(ah.cfg('burn.allowed_cd_re'), 'r', seg)) return false;
    seen++;
  }
  return seen > 0;
}

function decide(p) {
  if (p === null || typeof p !== 'object') return 'allow';
  var id = p[ah.cfg('burn.agent_field')];
  if (typeof id !== 'string' || id === '') return 'allow';
  if (!ah.settings.bool('burn.sw') || ah.settings.skipped(ah.cfg('burn.guard_name'))) return 'allow';
  var home = ah.env.get(ah.cfg('env.home'));
  if (home === null) home = ah.env.get(ah.cfg('env.home_alt'));
  if (!home) return 'allow';
  var paths = ah.cfg('agent_tracker.paths'), key = '', max = ah.cfg('agent_reminders.key_max');
  for (var i = 0; i < id.length && i < max; i++) key += /[A-Za-z0-9._-]/.test(id.charAt(i)) ? id.charAt(i) : '_';
  var marker = ah.path.join(home, ah.cfg('paths.base_dir') + '/' + paths.dir + '/' + ah.cfg('burn.marker_dir') + '/' + key + ah.cfg('burn.marker_ext'));
  if (ah.fs.size(marker) === null) return 'allow';
  var raw = ah.fs.readText(marker), m;
  if (raw === null) return 'allow';
  try { m = JSON.parse(raw); } catch (e) { return 'allow'; }
  if (m === null || typeof m !== 'object' || typeof m.ts !== 'number' || ah.clock.now() - m.ts > ah.cfgNum('burn.marker_ttl_ms')) return 'allow';
  var tool = typeof p.tool_name === 'string' ? p.tool_name : '';
  if (ah.cfg('burn.allowed_tools').indexOf(tool) >= 0) return 'allow';
  if (ah.cfg('burn.bash_tools').indexOf(tool) >= 0) {
    var cmd = p.tool_input && typeof p.tool_input.command === 'string' ? p.tool_input.command : '';
    if (cmd !== '' && bbAllowedBash(cmd)) return 'allow';
  }
  var reason = text.message('block', ah.cfg('burn.guard_name'), {
    what: text.render(ah.cfg('burn.msg_what'), { tokens: String(m.tokens) }),
    why: ah.cfg('burn.msg_why'),
    instead: ah.cfg('burn.msg_instead'),
    override: ah.cfg('burn.msg_override'),
  });
  // exit 2 with the reason on stdout as a decision and on stderr: Claude reads the decision, Codex honors exit 2 only with the reason on stderr
  return { exact: { code: 2, out: text.blockJson(reason), err: reason + '\n' } };
}
